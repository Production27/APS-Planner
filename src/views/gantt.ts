// Gantt view: the bar/tick drag-and-resize mechanics
// (cascadeShiftLaterTasks/startBarResizeRight/startBarResizeLeft/
// onBarResizeMove/applyBarResizeMove/onBarResizeEnd/startTickResize/
// onTickResizeMove/applyTickResizeMove/onTickResizeEnd/startBarMove/
// onBarMoveMove/applyBarMoveMove/onBarMoveEnd), the view-state toggles
// (collapse/expand, job focus, the date popover, and the task tooltip —
// togglePhaseCollapse/getSubUnitKey/toggleTasksPhaseExpanded/
// toggleTasksSubPhaseExpanded/expandAllGantt/collapseAllGantt/
// toggleGanttJobFocus/clearGanttJobFocus/syncGanttJobFocusBanner/
// buildPhaseSubTags/computeDateRange/showDatePopover/hideDatePopover/
// showTooltip), the visible-row builder (byStartDate/getPhaseSegments/
// buildSegment/buildPhaseCollapsedRow/buildSubPhaseRow/
// buildVisibleTaskRows — a pure data transformation, jobs/phases/tasks in
// and a flat row list out, with no DOM reads or writes), renderGantt()
// itself (by far the densest function in the app, ~800 lines), and the
// touch/pinch-zoom gesture cluster (scrollToToday/ganttTouchDist/
// setGanttDayWidthAnchored/requestGanttZoom/handleGanttTouchStart/Move/
// End/handleGanttWheelZoom/zoomGanttCentered/zoomIn/zoomOut/resetZoom/
// fitToView — never mutates task data, so the worst case of a bug here is
// a glitchy zoom or scroll position, not a corrupted date).
//
// renderGantt() is a thin, linear pipeline built from module-level
// functions (defined just above it, same pattern as
// buildVisibleTaskRows() above and scheduleOrphanRecovery() in
// src/sync/inbound.ts): setupDateRangeAndGrid/buildDateHeader/
// buildRowModel/renderLeftPanelRows/drawTodayLine/renderTimelineBars/
// drawConnectorLines/restoreScrollPosition, each taking explicit named
// parameters and returning a typed result. renderGantt() calls each
// once in a fixed order, threading each phase's return value into the
// next call's arguments — see each function's own signature for exactly
// what it depends on and produces, rather than reading a shared closure.
import type { Job, Phase, SubPhase, Task, BoardColumn } from '../core/types';
import { toIsoDate, getDaysDiff } from '../utils/date';
import { escapeHtml } from '../utils/html';
import { darkenColor, softenColor } from '../utils/color';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard } from '../core/models';
import { showToast, moveTooltip, hideTooltip } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS, saveJobs(), showToast(), etc.) are declared once in
// src/shared-globals.d.ts, not repeated here. DUE_MARKER_TASK_ID/
// getJobDueMarkerTask() are real exports of THIS file now (see near the
// bottom) — src/shared-globals.d.ts still ambiently declares them too,
// for src/views/calendar.ts's own bare references to keep resolving;
// that central declaration is intentionally left alone rather than
// converted, since calendar.ts and this file would otherwise need to
// agree on one exact shared type for a value each already types its own
// way (GanttTask vs CalTask).
declare global {
  // eslint-disable-next-line no-var
  var dayWidth: number;
  // eslint-disable-next-line no-var
  var barResizeState: BarResizeState | null;
  // eslint-disable-next-line no-var
  var tickResizeState: TickResizeState | null;
  // eslint-disable-next-line no-var
  var barMoveState: BarMoveState | null;
  // getVisibleJobs/getLinkedReferenceJobs/editJob/jumpToLinkedJobReference/
  // isTaskFinished are declared here (rather than in shared-globals.d.ts)
  // because this file types them with its own Job/GanttTask shapes —
  // src/views/calendar.ts declares the same index.html functions with
  // its own, differently named/shaped types. TypeScript allows an
  // ambient `function` (unlike `var`) to be re-declared with a different
  // signature per file — each file gets its own narrower view of the
  // same real function.
  function getVisibleJobs(): Job[];
  function getLinkedReferenceJobs(): Job[];
  // A phase's own id can be null (an unphased job's synthetic default
  // phase — see getJobPhases()), so this has to accept null keys too.
  // eslint-disable-next-line no-var
  var tasksExpandedPhaseIds: Set<string | null>;
  // eslint-disable-next-line no-var
  var tasksExpandedSubPhaseIds: Set<string>;
  // eslint-disable-next-line no-var
  var ganttFocusedJobId: string | null;
  // eslint-disable-next-line no-var
  var startDate: Date;
  // eslint-disable-next-line no-var
  var endDate: Date;
  // Same null-key reasoning as tasksExpandedPhaseIds above.
  // eslint-disable-next-line no-var
  var collapsedPhaseIds: Set<string | null>;
  // eslint-disable-next-line no-var
  var ganttViewMode: string;
  // eslint-disable-next-line no-var
  var ganttFirstRender: boolean;
  // eslint-disable-next-line no-var
  var GANTT_ROW_H: number;
  // eslint-disable-next-line no-var
  var GANTT_BAR_H: number;
  // eslint-disable-next-line no-var
  var GANTT_BAR_PAD: number;
  // Shared with autoArchiveJobs() (src/app/project.ts) — how far back a
  // job/task can be and still show up before being treated as archived.
  const ARCHIVE_CUTOFF_DAYS: number;
  function editJob(jobId: string, phaseId?: string | null, subPhaseId?: string | null): void;
  function jumpToLinkedJobReference(job: Job): void;
  function isTaskFinished(job: Job, task: GanttTask): boolean;
}

// Deliberately loose local type (mirrors src/views/calendar.ts's own
// CalTask): `task` here can be a REAL task from a sub-unit's own
// tasks[], a due-date marker synthesized by getJobDueMarkerTask(), or a
// throwaway synthetic {name, start, finish} pseudo-task spanning a
// collapsed phase/sub-phase's whole date range (buildPhaseCollapsedRow/
// buildSubPhaseRow below) or — for a job-span drag — a whole sub-unit
// (startBarMove() above).
interface GanttTask {
  id?: string;
  name: string;
  start?: string;
  finish?: string;
  order?: number;
  [key: string]: unknown;
}

interface BarResizeState {
  side: 'left' | 'right';
  jobId: string;
  taskId: string;
  task: GanttTask;
  bar: HTMLElement;
  startX: number;
  startDateObj?: Date;
  finishDateObj?: Date;
  initialDuration: number;
  currentDuration: number;
  origLeftPx?: number;
}

interface TickResizeState {
  jobId: string;
  taskId: string;
  task: GanttTask;
  tick: HTMLElement;
  startX: number;
  startDateObj: Date;
  origLeftPx: number;
  initialDuration: number;
  currentDuration: number;
}

interface BarMoveState {
  jobId: string;
  taskId: string;
  task: GanttTask;
  bar: HTMLElement;
  startX: number;
  startDateObj: Date;
  duration: number;
  deltaDays: number;
  moved: boolean;
  phaseId: string | null;
  subPhaseId: string | null;
  origLeftPx: number;
  isJobSpan: boolean;
  jobSpanOverlayEls: { el: HTMLElement; origLeft: number }[] | null;
}

// Cascades a task-date shift onto every LATER task in the same sub-unit
// (by `order`), keeping the rest of the job's schedule connected instead
// of only the dragged task moving and leaving a gap or overlap behind.
function cascadeShiftLaterTasks(jobId: string, taskId: string, deltaDays: number): void {
  if (!deltaDays) return;
  const found = findJob(jobId);
  if (!found) return;
  let unit: { tasks?: GanttTask[] } | null = null;
  const phases = getJobPhases(found.job);
  outer: for (let p = 0; p < phases.length; p++) {
    const units = getPhaseSubUnits(phases[p]);
    for (let u = 0; u < units.length; u++) {
      if ((units[u].tasks || []).some((t) => t.id === taskId)) { unit = units[u]; break outer; }
    }
  }
  if (!unit) return;
  const sorted = (unit.tasks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = sorted.findIndex((t) => t.id === taskId);
  if (idx === -1) return;
  for (let i = idx + 1; i < sorted.length; i++) {
    const t = sorted[i];
    // Not every later task necessarily has dates set yet (e.g. an
    // "Invoiced" column task nobody's scheduled) — nothing to shift there.
    if (!t.start || !t.finish) continue;
    const newStart = new Date(t.start + 'T00:00:00');
    const newFinish = new Date(t.finish + 'T00:00:00');
    if (isNaN(newStart.getTime()) || isNaN(newFinish.getTime())) continue;
    newStart.setDate(newStart.getDate() + deltaDays);
    newFinish.setDate(newFinish.getDate() + deltaDays);
    t.start = toIsoDate(newStart);
    t.finish = toIsoDate(newFinish);
  }
}

function startBarResizeRight(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  barResizeState = {
    side: 'right', jobId, taskId, task, bar, startX: e.clientX,
    startDateObj: s, initialDuration, currentDuration: initialDuration,
  };

  bar.classList.remove('milestone');
  bar.classList.add('resizing');
  document.addEventListener('mousemove', onBarResizeMove);
  document.addEventListener('mouseup', onBarResizeEnd);
}

// --- Left edge: drag to change start date ---
function startBarResizeLeft(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  barResizeState = {
    side: 'left', jobId, taskId, task, bar, startX: e.clientX,
    finishDateObj: f, initialDuration, currentDuration: initialDuration,
    origLeftPx: parseFloat(bar.style.left),
  };

  bar.classList.remove('milestone');
  bar.classList.add('resizing');
  document.addEventListener('mousemove', onBarResizeMove);
  document.addEventListener('mouseup', onBarResizeEnd);
}

// rAF-coalesced for the same reason as onBarMoveMove()/applyBarMoveMove()
// just below — one tooltip innerHTML-write-then-offsetWidth-read forced
// layout flush per animation frame instead of per raw mousemove event.
let barResizeRafPending = false;
let barResizeLatestEvent: MouseEvent | null = null;
function onBarResizeMove(e: MouseEvent): void {
  if (!barResizeState) return;
  barResizeLatestEvent = e;
  if (barResizeRafPending) return;
  barResizeRafPending = true;
  requestAnimationFrame(function () {
    barResizeRafPending = false;
    if (barResizeState && barResizeLatestEvent) applyBarResizeMove(barResizeLatestEvent);
  });
}

function applyBarResizeMove(e: MouseEvent): void {
  if (!barResizeState) return;
  const deltaX = e.clientX - barResizeState.startX;
  const rawDeltaDays = Math.round(deltaX / dayWidth);
  const tt = document.getElementById('tooltip')!;
  const task = barResizeState.task;

  if (barResizeState.side === 'right') {
    const newDuration = Math.max(1, barResizeState.initialDuration + rawDeltaDays);
    barResizeState.currentDuration = newDuration;
    barResizeState.bar.style.width = (newDuration * dayWidth) + 'px';

    const newFinish = new Date(barResizeState.startDateObj!);
    newFinish.setDate(newFinish.getDate() + newDuration - 1);

    tt.innerHTML = '<div class="tt-title">' + escapeHtml(task.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
      newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
      newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  } else {
    const newDuration = Math.max(1, barResizeState.initialDuration - rawDeltaDays);
    const clampedDeltaDays = barResizeState.initialDuration - newDuration;
    barResizeState.currentDuration = newDuration;
    barResizeState.bar.style.left = (barResizeState.origLeftPx! + clampedDeltaDays * dayWidth) + 'px';
    barResizeState.bar.style.width = (newDuration * dayWidth) + 'px';

    const newStart = new Date(barResizeState.finishDateObj!);
    newStart.setDate(newStart.getDate() - (newDuration - 1));

    tt.innerHTML = '<div class="tt-title">' + escapeHtml(task.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' +
      newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
      newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  }

  tt.classList.add('show');
  moveTooltip(e);
}

function onBarResizeEnd(e: MouseEvent): void {
  if (!barResizeState) return;
  const { side, jobId, taskId, task, currentDuration, initialDuration, bar } = barResizeState;
  document.removeEventListener('mousemove', onBarResizeMove);
  document.removeEventListener('mouseup', onBarResizeEnd);
  bar.classList.remove('resizing');
  hideTooltip();

  if (currentDuration !== initialDuration) {
    if (side === 'right') {
      const newFinish = new Date(barResizeState.startDateObj!);
      newFinish.setDate(newFinish.getDate() + currentDuration - 1);
      task.finish = toIsoDate(newFinish);
      cascadeShiftLaterTasks(jobId, taskId, currentDuration - initialDuration);
    } else {
      const newStart = new Date(barResizeState.finishDateObj!);
      newStart.setDate(newStart.getDate() - (currentDuration - 1));
      task.start = toIsoDate(newStart);
    }
    saveJobs();
    logActivity('rescheduled task "' + task.name + '"');
    renderJobList();
    refreshJobFormIfOpen(jobId);
    showToast(side === 'right' ? 'Finish date updated' : 'Start date updated', 'success');
  }

  barResizeState = null;
  renderGantt();
}

// --- Condensed Jobs/Leads bar: drag a phase-boundary tick to resize the
// task ending there (see the isJobSpan day-sweep in renderGantt(), which
// wires this up on each tick's mousedown). The tick equivalent of
// startBarResizeRight() above — same "drag right to extend, left to
// shorten" semantics and the same cascadeShiftLaterTasks() call to keep
// later tasks in the job at their own duration/gaps — just moving the
// tick element itself for live feedback instead of a bar's width, since
// there's no single bar representing one task in this condensed view.
function startTickResize(e: MouseEvent, jobId: string, taskId: string, tick: HTMLElement): void {
  e.preventDefault();
  e.stopPropagation();
  if (!hasMinTier('editor')) return;
  const found = findTask(jobId, taskId);
  if (!found) return;
  const task = found.task;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const initialDuration = getDaysDiff(s, f) + 1;

  tickResizeState = {
    jobId, taskId, task, tick, startX: e.clientX,
    startDateObj: s, origLeftPx: parseFloat(tick.style.left),
    initialDuration, currentDuration: initialDuration,
  };

  tick.classList.add('resizing');
  document.addEventListener('mousemove', onTickResizeMove);
  document.addEventListener('mouseup', onTickResizeEnd);
}

// Same rAF-coalescing as onBarResizeMove()/onBarMoveMove() above — this
// wasn't named in the original review pass, but it's the identical
// tooltip write-then-forced-layout-read pattern on every raw mousemove,
// just for the condensed Jobs/Leads view's tick-resize drag instead of a
// normal task bar's.
let tickResizeRafPending = false;
let tickResizeLatestEvent: MouseEvent | null = null;
function onTickResizeMove(e: MouseEvent): void {
  if (!tickResizeState) return;
  tickResizeLatestEvent = e;
  if (tickResizeRafPending) return;
  tickResizeRafPending = true;
  requestAnimationFrame(function () {
    tickResizeRafPending = false;
    if (tickResizeState && tickResizeLatestEvent) applyTickResizeMove(tickResizeLatestEvent);
  });
}

function applyTickResizeMove(e: MouseEvent): void {
  if (!tickResizeState) return;
  const deltaX = e.clientX - tickResizeState.startX;
  const rawDeltaDays = Math.round(deltaX / dayWidth);
  const newDuration = Math.max(1, tickResizeState.initialDuration + rawDeltaDays);
  tickResizeState.currentDuration = newDuration;
  tickResizeState.tick.style.left =
    (tickResizeState.origLeftPx + (newDuration - tickResizeState.initialDuration) * dayWidth) + 'px';

  const newFinish = new Date(tickResizeState.startDateObj);
  newFinish.setDate(newFinish.getDate() + newDuration - 1);

  const tt = document.getElementById('tooltip')!;
  tt.innerHTML = '<div class="tt-title">' + escapeHtml(tickResizeState.task.name) + '</div>' +
    '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
    newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
    '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' +
    newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
  tt.classList.add('show');
  moveTooltip(e);
}

function onTickResizeEnd(e: MouseEvent): void {
  if (!tickResizeState) return;
  const { jobId, taskId, task, currentDuration, initialDuration } = tickResizeState;
  document.removeEventListener('mousemove', onTickResizeMove);
  document.removeEventListener('mouseup', onTickResizeEnd);
  hideTooltip();

  if (currentDuration !== initialDuration) {
    const newFinish = new Date(tickResizeState.startDateObj);
    newFinish.setDate(newFinish.getDate() + currentDuration - 1);
    task.finish = toIsoDate(newFinish);
    cascadeShiftLaterTasks(jobId, taskId, currentDuration - initialDuration);
    saveJobs();
    logActivity('rescheduled task "' + task.name + '"');
    renderJobList();
    refreshJobFormIfOpen(jobId);
    showToast('Finish date updated', 'success');
  }

  tickResizeState = null;
  renderGantt();
}

// --- Bar body: drag to move the whole task (both dates shift together) ---
// isJobSpan: dragging a condensed phase/sub-phase bar moves every dated
// task in it together (see onBarMoveEnd) rather than one real task, so
// `task` here is a synthetic start/finish spanning all of them, recomputed
// fresh from the job's current tasks (same rule as buildPhaseCollapsedRow()/
// buildSubPhaseRow()).
function startBarMove(e: MouseEvent, jobId: string, taskId: string, bar: HTMLElement, isJobSpan?: boolean, phaseId?: string | null, subPhaseId?: string | null): void {
  let task: GanttTask | undefined;
  if (isJobSpan) {
    const jf = findJob(jobId);
    if (!jf) return;
    const phase = getJobPhases(jf.job).find((p) => (p.id || null) === (phaseId || null));
    if (!phase) return;
    const subUnit = getPhaseSubUnits(phase).find((s) => (s.id || null) === (subPhaseId || null));
    if (!subUnit) return;
    const hiddenOrders = new Set(
      BOARD_COLUMNS.map((c, i) => (c.hideFromSchedule ? i : null)).filter((i) => i !== null)
    );
    let minStart: Date | null = null;
    let maxFinish: Date | null = null;
    (subUnit.tasks || []).forEach((t) => {
      if (hiddenOrders.has(t.order as number)) return;
      if (!t.start || !t.finish) return;
      const s = new Date(t.start + 'T00:00:00');
      const f = new Date(t.finish + 'T00:00:00');
      if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
      if (!minStart || s < minStart) minStart = s;
      if (!maxFinish || f > maxFinish) maxFinish = f;
    });
    if (!minStart || !maxFinish) return;
    task = { name: jf.job.name, start: toIsoDate(minStart), finish: toIsoDate(maxFinish) };
  } else if (taskId === DUE_MARKER_TASK_ID) {
    const jf = findJob(jobId);
    if (!jf) return;
    const dueTask = getJobDueMarkerTask(jf.job, phaseId ?? null);
    if (!dueTask) return;
    task = dueTask;
  } else {
    const found = findTask(jobId, taskId);
    if (!found) return;
    task = found.task;
    phaseId = found.phaseId;
    subPhaseId = found.subPhaseId;
  }
  if (!task) return;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const duration = getDaysDiff(s, f) + 1;

  barMoveState = {
    jobId, taskId, task, bar, startX: e.clientX,
    startDateObj: s, duration, deltaDays: 0, moved: false, phaseId: phaseId || null, subPhaseId: subPhaseId || null,
    origLeftPx: parseFloat(bar.style.left),
    isJobSpan: !!isJobSpan,
    // Queried + filtered ONCE here at drag start instead of on every
    // mousemove tick (see applyBarMoveMove()) — this used to be a
    // whole-document 6-class querySelectorAll + per-element dataset
    // filter running dozens of times a second for the whole duration of
    // a drag. The matching set can't change mid-drag (nothing else
    // touches these overlay elements while a drag is in progress), so
    // there's nothing to invalidate by caching it up front.
    jobSpanOverlayEls: isJobSpan ? Array.from(document.querySelectorAll<HTMLElement>(
      '.job-span-task-tick, .job-span-gap-hash, .job-span-task-hatch, .job-span-task-solid, .job-span-name-wrap, .job-span-border'
    )).filter((tk) => {
      return tk.dataset.jobId === jobId &&
        (tk.dataset.phaseId || '') === (phaseId || '') &&
        (tk.dataset.subPhaseId || '') === (subPhaseId || '');
    }).map((tk) => ({ el: tk, origLeft: parseFloat(tk.dataset.origLeft || '0') })) : null,
  };

  document.addEventListener('mousemove', onBarMoveMove);
  document.addEventListener('mouseup', onBarMoveEnd);
}

// rAF-coalesced the same way requestGanttZoom() below is — a raw
// mousemove can fire far more often than this can usefully repaint, and
// every tick was doing a
// tooltip innerHTML write immediately followed by an offsetWidth/
// offsetHeight read (see moveTooltip()), which forces a synchronous layout
// flush of whatever DOM writes are still pending (the bar's own style.left/
// width, here) on every single event instead of once per frame.
let barMoveRafPending = false;
let barMoveLatestEvent: MouseEvent | null = null;
function onBarMoveMove(e: MouseEvent): void {
  if (!barMoveState) return;
  barMoveLatestEvent = e;
  if (barMoveRafPending) return;
  barMoveRafPending = true;
  requestAnimationFrame(function () {
    barMoveRafPending = false;
    if (barMoveState && barMoveLatestEvent) applyBarMoveMove(barMoveLatestEvent);
  });
}

function applyBarMoveMove(e: MouseEvent): void {
  if (!barMoveState) return;
  // Below Editor: never let the drag actually move anything (and never set
  // .moved, so a click-drag attempt just resolves as a plain click on
  // mouseup and opens the job read-only, same as any other click) — mirrors
  // handleCalBarMouseMove()'s same reasoning for the calendar's bars.
  if (!hasMinTier('editor')) return;
  const deltaX = e.clientX - barMoveState.startX;

  if (Math.abs(deltaX) > 3) {
    barMoveState.moved = true;
    barMoveState.bar.classList.add('moving');
  }
  if (!barMoveState.moved) return;

  const deltaDays = Math.round(deltaX / dayWidth);
  barMoveState.deltaDays = deltaDays;
  barMoveState.bar.style.left = (barMoveState.origLeftPx + deltaDays * dayWidth) + 'px';

  // Drag the job-span bar's phase-boundary ticks, gap hashing, solid task
  // segments, overlap hatching, name label, and outline along with it so
  // they don't visually detach from the bar mid-drag (they otherwise only
  // catch up once renderGantt() redraws everything on drop). Set (see
  // startBarMove()) once at drag start instead of re-queried here.
  if (barMoveState.isJobSpan && barMoveState.jobSpanOverlayEls) {
    barMoveState.jobSpanOverlayEls.forEach((entry) => {
      entry.el.style.left = (entry.origLeft + deltaDays * dayWidth) + 'px';
    });
  }

  const newStart = new Date(barMoveState.startDateObj);
  newStart.setDate(newStart.getDate() + deltaDays);
  const newFinish = new Date(newStart);
  newFinish.setDate(newFinish.getDate() + barMoveState.duration - 1);

  const tt = document.getElementById('tooltip')!;
  tt.innerHTML = '<div class="tt-title">' + escapeHtml(barMoveState.task.name) + '</div>' +
    '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' +
    newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
    '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' +
    newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>';
  tt.classList.add('show');
  moveTooltip(e);
}

function onBarMoveEnd(e: MouseEvent): void {
  if (!barMoveState) return;
  const { task, taskId, deltaDays, moved, duration, startDateObj, bar, jobId, isJobSpan, phaseId, subPhaseId } = barMoveState;
  document.removeEventListener('mousemove', onBarMoveMove);
  document.removeEventListener('mouseup', onBarMoveEnd);
  bar.classList.remove('moving');
  hideTooltip();

  if (isJobSpan) {
    if (moved && deltaDays !== 0) {
      const jf = findJob(jobId);
      const phase = jf && getJobPhases(jf.job).find((p) => (p.id || null) === (phaseId || null));
      const subUnit = phase && getPhaseSubUnits(phase).find((s) => (s.id || null) === (subPhaseId || null));
      if (jf && phase && subUnit) {
        (subUnit.tasks || []).forEach((t) => {
          if (!t.start || !t.finish) return;
          const ns = new Date(t.start + 'T00:00:00');
          ns.setDate(ns.getDate() + deltaDays);
          const nf = new Date(t.finish + 'T00:00:00');
          nf.setDate(nf.getDate() + deltaDays);
          t.start = toIsoDate(ns);
          t.finish = toIsoDate(nf);
        });
        saveJobs();
        logActivity('moved job "' + jf.job.name + '"' + (phase.isDefault ? '' : ' phase "' + phase.name + '"') + (subUnit.isDefault ? '' : ' sub-phase "' + subUnit.name + '"'));
        renderJobList();
        refreshJobFormIfOpen(jobId);
        showToast('Job dates updated', 'success');
      }
      bar.dataset.dragged = 'true';
    } else {
      bar.dataset.dragged = 'false';
    }
    barMoveState = null;
    renderGantt();
    return;
  }

  if (moved && deltaDays !== 0 && taskId === DUE_MARKER_TASK_ID) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const dueJf = findJob(jobId);
    const card = dueJf ? getPhaseCard(dueJf.job as Job, phaseId) : null;
    if (card) {
      card.due = toIsoDate(newStart);
      saveJobs();
      const jf = findJob(jobId);
      logActivity('rescheduled due date for job "' + (jf ? jf.job.name : '') + '"');
      renderJobList();
      // Was missing here — the identical Calendar-side due-marker drag
      // already calls this; card.due drives the Board's own "overdue"
      // badge (see the isOverdue check), so without it a Gantt-side
      // due-date drag left that badge stale.
      renderBoard();
      refreshJobFormIfOpen(jobId);
      showToast('Due date updated', 'success');
    }
    bar.dataset.dragged = 'true';
  } else if (moved && deltaDays !== 0) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const newFinish = new Date(newStart);
    newFinish.setDate(newFinish.getDate() + duration - 1);
    task.start = toIsoDate(newStart);
    task.finish = toIsoDate(newFinish);
    // Keep the rest of the job's schedule connected — later tasks slide
    // along by the same delta instead of only the dragged one moving.
    cascadeShiftLaterTasks(jobId, taskId, deltaDays);
    saveJobs();
    logActivity('moved task "' + task.name + '"');
    renderJobList();
    refreshJobFormIfOpen(jobId);
    showToast('Task dates updated', 'success');
    bar.dataset.dragged = 'true';
  } else {
    bar.dataset.dragged = 'false';
  }

  barMoveState = null;
  renderGantt();
}

// ===== GANTT: VIEW-STATE TOGGLES (collapse/expand, job focus) =====
// A phase split into sub-phases normally gets one bar per sub-phase.
// Collapsing that phase folds its sub-phase bars back into one phase-wide
// bar with one solid segment per sub-phase, all in the job's own color.
// Purely a local view preference — not synced to other users.
function togglePhaseCollapse(phaseId: string | null): void {
  if (collapsedPhaseIds.has(phaseId)) collapsedPhaseIds.delete(phaseId); else collapsedPhaseIds.add(phaseId);
  localStorage.setItem('gantt_collapsed_phases_v1', JSON.stringify(Array.from(collapsedPhaseIds)));
  renderGantt();
}

// Sub-phases are keyed by a job+phase+sub-unit composite rather than just
// the sub-unit's own id, because both an unphased job's synthetic default
// phase AND an unsplit phase's synthetic default sub-unit share id:null
// (see getJobPhases()/getPhaseSubUnits()) — without the job/phase prefix,
// expanding one flat job's default bar would collide with every other
// flat job's.
function getSubUnitKey(job: Job, phaseId: string | null, subPhaseId: string | null): string {
  return job.id + '::' + (phaseId || 'p0') + '::' + (subPhaseId || 's0');
}
// Every phase/sub-phase in Tasks view starts CONDENSED (one bar) instead
// of showing individual tasks — these two track which ones a given user
// has explicitly EXPANDED back open, so that choice survives a reload.
function toggleTasksPhaseExpanded(phaseId: string | null): void {
  if (tasksExpandedPhaseIds.has(phaseId)) tasksExpandedPhaseIds.delete(phaseId); else tasksExpandedPhaseIds.add(phaseId);
  localStorage.setItem('gantt_tasks_expanded_phases_v1', JSON.stringify(Array.from(tasksExpandedPhaseIds)));
  renderGantt();
}
function toggleTasksSubPhaseExpanded(key: string): void {
  if (tasksExpandedSubPhaseIds.has(key)) tasksExpandedSubPhaseIds.delete(key); else tasksExpandedSubPhaseIds.add(key);
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', JSON.stringify(Array.from(tasksExpandedSubPhaseIds)));
  renderGantt();
}
// Gantt toolbar's Expand All/Collapse All — bulk versions of the two
// toggles above, over every phase/sub-phase of every job currently in
// view (same job set buildVisibleTaskRows() renders).
function expandAllGantt(): void {
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach(function(job) {
    getJobPhases(job).forEach(function(phase) {
      const phaseId = phase.id || null;
      tasksExpandedPhaseIds.add(phaseId);
      getPhaseSubUnits(phase).forEach(function(sub) {
        tasksExpandedSubPhaseIds.add(getSubUnitKey(job, phaseId, sub.id || null));
      });
    });
  });
  localStorage.setItem('gantt_tasks_expanded_phases_v1', JSON.stringify(Array.from(tasksExpandedPhaseIds)));
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', JSON.stringify(Array.from(tasksExpandedSubPhaseIds)));
  renderGantt();
}
function collapseAllGantt(): void {
  tasksExpandedPhaseIds.clear();
  tasksExpandedSubPhaseIds.clear();
  localStorage.setItem('gantt_tasks_expanded_phases_v1', '[]');
  localStorage.setItem('gantt_tasks_expanded_subphases_v1', '[]');
  renderGantt();
}

// Clicking a job's name pill isolates the Gantt to just that job. NOT
// persisted to localStorage — a short-lived "let me focus on this one
// job" tool, reset on every page load and whenever the active project
// changes (see switchProject() in src/app/project.ts).
function toggleGanttJobFocus(jobId: string): void {
  ganttFocusedJobId = (ganttFocusedJobId === jobId) ? null : jobId;
  renderGantt();
}
function clearGanttJobFocus(): void {
  if (!ganttFocusedJobId) return;
  ganttFocusedJobId = null;
  renderGantt();
}
// Shown in the Gantt toolbar (Tasks view only): a quiet hint when nothing's
// focused, swapping to the active "Showing only X — Show all" banner once
// a job is.
function syncGanttJobFocusBanner(): void {
  const el = document.getElementById('ganttJobFocusBanner');
  if (!el) return;
  if (ganttViewMode !== 'tasks') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  // The focused job could vanish out from under the filter (deleted, no
  // longer a Member, a project switch already cleared ganttFocusedJobId,
  // or it's not in the member currently being previewed).
  const job = ganttFocusedJobId ? getVisibleJobs().find(function(j) { return j.id === ganttFocusedJobId; }) : null;
  el.style.display = 'flex';
  el.innerHTML = job
    ? 'Showing only <b>' + escapeHtml(job.name) + '</b> <button type="button" onclick="clearGanttJobFocus()">Show all</button>'
    : '<span class="gantt-job-focus-hint">Click a job name to isolate it</span>';
}
// Builds the phase-fold and/or sub-phase-fold tag(s) shown on a Tasks-view
// Gantt bar. Returns an array of ready-to-append elements (0-2 of them).
// `excludeSubTag` is set for a row that already represents a WHOLE folded
// phase (no single sub-unit context to toggle).
function buildPhaseSubTags(job: Job, phaseId: string | null, phaseName: string | null, subPhaseId: string | null, subPhaseName: string | null, phaseFoldable: boolean, excludeSubTag: boolean): HTMLElement[] {
  const tags: HTMLElement[] = [];
  const bg = job.color || '#999';
  function makeTag(folded: boolean, label: string, foldedTitle: string, unfoldedTitle: string, onClick: () => void): HTMLElement {
    const t = document.createElement('span');
    t.className = 'task-bar-job-tag collapsible';
    t.style.background = bg;
    t.textContent = (folded ? '▸' : '▾') + (label ? ' ' + label : '');
    t.title = (folded ? foldedTitle : unfoldedTitle) + (label ? ' — ' + label : '');
    t.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    t.addEventListener('click', function(e) { e.stopPropagation(); onClick(); });
    return t;
  }
  if (phaseFoldable && phaseName !== null) {
    tags.push(makeTag(!tasksExpandedPhaseIds.has(phaseId as string), phaseName,
      'Click to expand sub-phases', 'Click to collapse sub-phases into one bar',
      function() { toggleTasksPhaseExpanded(phaseId); }));
  }
  if (!excludeSubTag) {
    const subKey = getSubUnitKey(job, phaseId, subPhaseId);
    tags.push(makeTag(!tasksExpandedSubPhaseIds.has(subKey), subPhaseName || phaseName || '',
      'Click to expand into individual tasks', 'Click to collapse into a single bar',
      function() { toggleTasksSubPhaseExpanded(subKey); }));
  }
  return tags;
}

// ===== GANTT: DATE RANGE, DATE POPOVER, TASK TOOLTIP =====
function computeDateRange(): void {
  const hiddenOrders = new Set(
    BOARD_COLUMNS.map(function(c, i) { return c.hideFromSchedule ? i : null; }).filter(function(i) { return i !== null; })
  ) as Set<number>;
  let datedTasks: GanttTask[] = [];
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach(function(job) {
    getJobPhases(job).forEach(function(phase) {
      getPhaseSubUnits(phase).forEach(function(subUnit, subIdx) {
        (subUnit.tasks || []).forEach(function(task: GanttTask) {
          if (hiddenOrders.has(task.order as number)) return;
          if (!task.start || !task.finish) return;
          const s = new Date(task.start + 'T00:00:00');
          const f = new Date(task.finish + 'T00:00:00');
          if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
          datedTasks.push(task);
        });
        // A due date can sit outside every task's date range — without this
        // the marker could fall off the edge of the chart entirely, with no
        // grid to scroll into. Only the FIRST sub-unit's row carries it.
        if (!job.isLinkedReference && subIdx === 0) {
          const dueTask = getJobDueMarkerTask(job, phase.id);
          if (dueTask) datedTasks.push(dueTask as GanttTask);
        }
      });
    });
  });
  // However the task dates work out, always leave room to scroll back at
  // least ARCHIVE_CUTOFF_DAYS — otherwise a job that just auto-archived (or
  // doesn't have anything scheduled that far back) leaves no grid to
  // scroll into, even though the data's still there with "Show archived" on.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minPastDate = new Date(today);
  minPastDate.setDate(minPastDate.getDate() - ARCHIVE_CUTOFF_DAYS);

  if (datedTasks.length === 0) {
    // No dated tasks anywhere — give the chart a window around today.
    // Matches the +30 days buffer the dated-tasks branch below gets, so
    // every project behaves the same regardless of whether it has dates
    // set yet.
    startDate = new Date(minPastDate);
    endDate = new Date(today); endDate.setDate(today.getDate() + 30);
    return;
  }
  const starts = datedTasks.map(t => new Date(t.start + 'T00:00:00'));
  const finishes = datedTasks.map(t => new Date(t.finish + 'T00:00:00'));
  startDate = new Date(Math.min.apply(null, starts.map(d => d.getTime())));
  endDate = new Date(Math.max.apply(null, finishes.map(d => d.getTime())));
  startDate.setDate(startDate.getDate() - 3);
  endDate.setDate(endDate.getDate() + 30);
  if (startDate > minPastDate) startDate = minPastDate;
}

function showDatePopover(e: MouseEvent, date: Date): void {
  const popover = document.getElementById('datePopover')!;
  const dayJobs: { job: Job; task: GanttTask }[] = [];
  getVisibleJobs().forEach(job => {
    if (job.archived) return;
    (job.tasks || []).forEach((task: GanttTask) => {
      const s = new Date(task.start + 'T00:00:00');
      const f = new Date(task.finish + 'T00:00:00');
      if (date >= s && date <= f) dayJobs.push({ job: job, task: task });
    });
  });

  let html = '<h5>' + date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '</h5>';
  if (dayJobs.length === 0) {
    html += '<div class="dp-row"><span class="dp-label">No jobs</span></div>';
  } else {
    html += '<div class="dp-row"><span class="dp-label">Jobs:</span><span class="dp-value">' + dayJobs.length + '</span></div>';
    dayJobs.slice(0, 5).forEach(jt => {
      html += '<div class="dp-row" style="margin-top: var(--s-1);"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + jt.job.color + ';margin-right: var(--s-1-5);"></span>' + escapeHtml(jt.job.name) + '</div>';
    });
    if (dayJobs.length > 5) html += '<div class="dp-row" style="color:#888;font-size: var(--t-2xs);">+' + (dayJobs.length - 5) + ' more...</div>';
  }
  popover.innerHTML = html;
  popover.classList.add('show');

  const rect = (e.target as HTMLElement).getBoundingClientRect();
  const timelineBody = document.getElementById('timelineBody')!;
  const parentRect = timelineBody.getBoundingClientRect();
  let left = rect.left - parentRect.left + timelineBody.scrollLeft;
  let top = rect.bottom - parentRect.top + timelineBody.scrollTop + 4;
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

function hideDatePopover(): void {
  document.getElementById('datePopover')!.classList.remove('show');
}

function showTooltip(e: MouseEvent, job: Job, task: GanttTask): void {
  const tt = document.getElementById('tooltip')!;
  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const dur = getDaysDiff(s, f) + 1;
  let html = '<div class="tt-title">' + escapeHtml(job.name) + '</div>';
  // A job-span bar IS the job/phase, condensed — task.name is just that
  // name again there, so a "Task:" row repeating the title would be
  // redundant.
  if (!task.isJobSpan) {
    html += '<div class="tt-row"><span class="tt-label">Task:</span><span class="tt-value">' + escapeHtml(task.name) + '</span></div>';
  }
  html += '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' + s.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</span></div>';
  html += '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' + f.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</span></div>';
  html += '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' + dur + ' day' + (dur>1?'s':'') + '</span></div>';
  if (task.notes) html += '<div class="tt-notes">' + escapeHtml(task.notes as string) + '</div>';
  tt.innerHTML = html;
  tt.classList.add('show');
  moveTooltip(e);
}

// ===== GANTT: VISIBLE-ROW BUILDER =====
// Pure data transformation — jobs/phases/tasks in, a flat list of rows to
// draw out. Was a cluster of nested closures inside renderGantt() itself
// with exactly one external call site (`visibleRows =
// buildVisibleTaskRows();`), confirmed by grepping renderGantt()'s whole
// body before moving anything.

interface GanttSegment {
  subPhaseId: string | null;
  subPhaseName: string | null;
  start: Date;
  finish: Date;
}

interface GanttRow {
  job: Job;
  task: GanttTask;
  phaseId: string | null;
  phaseName: string | null;
  subPhaseId: string | null;
  subPhaseName: string | null;
  collapsible: boolean;
  collapsedSegments?: GanttSegment[];
}

// Row order across the WHOLE board: earliest start date first, regardless
// of which job a task belongs to. Ties broken by job order then task's
// stored order so identical start dates stay stable/predictable.
function byStartDate(a: GanttTask, b: GanttTask): number {
  const aValid = !!(a.start && a.finish && !isNaN(new Date(a.start + 'T00:00:00').getTime()));
  const bValid = !!(b.start && b.finish && !isNaN(new Date(b.start + 'T00:00:00').getTime()));
  if (aValid && bValid) {
    const diff = new Date(a.start!).getTime() - new Date(b.start!).getTime();
    if (diff !== 0) return diff;
  } else if (aValid !== bValid) {
    // Dated tasks sort above undated ones, which fall to the bottom.
    return aValid ? -1 : 1;
  }
  return (a.order || 0) - (b.order || 0);
}

// Gathers one segment per dated sub-unit of a phase — the sub-unit's own
// min-start/max-finish across its tasks. Shared by both row builders
// below and by a single sub-phase's own condensed row.
function getPhaseSegments(phase: Phase, hiddenOrders: Set<number>): GanttSegment[] {
  const segments: GanttSegment[] = [];
  getPhaseSubUnits(phase).forEach((subUnit) => {
    const seg = buildSegment(subUnit, hiddenOrders);
    if (seg) segments.push(seg);
  });
  return segments;
}

function buildSegment(subUnit: SubPhase, hiddenOrders: Set<number>): GanttSegment | null {
  let minStart: Date | null = null;
  let maxFinish: Date | null = null;
  (subUnit.tasks || []).forEach((task) => {
    if (hiddenOrders.has(task.order)) return;
    if (!task.start || !task.finish) return;
    const s = new Date(task.start + 'T00:00:00');
    const f = new Date(task.finish + 'T00:00:00');
    if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
    if (!minStart || s < minStart) minStart = s;
    if (!maxFinish || f > maxFinish) maxFinish = f;
  });
  if (!minStart || !maxFinish) return null;
  return { subPhaseId: subUnit.id, subPhaseName: subUnit.isDefault ? null : subUnit.name, start: minStart!, finish: maxFinish! };
}

// One row for a WHOLE phase — every one of its sub-units' tasks folded
// into a single span, with one solid segment per sub-unit drawn inside it
// (see the isJobSpan collapsed branch in renderGantt() itself). Only
// offered when the phase is actually split into 2+ real sub-phases.
function buildPhaseCollapsedRow(job: Job, phase: Phase, segments: GanttSegment[]): GanttRow {
  let overallStart: Date | null = null;
  let overallFinish: Date | null = null;
  segments.forEach((seg) => {
    if (!overallStart || seg.start < overallStart) overallStart = seg.start;
    if (!overallFinish || seg.finish > overallFinish) overallFinish = seg.finish;
  });
  const namePart = phase.isDefault ? '' : ' — ' + phase.name;
  const pseudoTask: GanttTask = {
    id: 'jobspan-collapsed|' + job.id + '|' + (phase.id || ''),
    name: job.name + namePart,
    start: toIsoDate(overallStart!),
    finish: toIsoDate(overallFinish!),
    notes: '',
    color: job.color,
    order: 0,
    isJobSpan: true,
  };
  return { job, task: pseudoTask, phaseId: phase.id, phaseName: phase.isDefault ? null : phase.name, subPhaseId: null, subPhaseName: null, collapsible: true, collapsedSegments: segments };
}

// One row for a SINGLE sub-unit — its own tasks folded into a single
// span. Used both for every sub-unit of an un-folded phase in Jobs/Leads
// view, and for a still-collapsed (i.e. not yet individually expanded)
// sub-phase in Tasks view (see tasksExpandedSubPhaseIds).
function buildSubPhaseRow(job: Job, phase: Phase, seg: GanttSegment): GanttRow {
  const namePart = (phase.isDefault ? '' : ' — ' + phase.name) + (seg.subPhaseName ? ' — ' + seg.subPhaseName : '');
  const pseudoTask: GanttTask = {
    id: 'jobspan|' + job.id + '|' + (phase.id || '') + '|' + (seg.subPhaseId || ''),
    name: job.name + namePart,
    start: toIsoDate(seg.start),
    finish: toIsoDate(seg.finish),
    notes: '',
    color: job.color,
    order: 0,
    isJobSpan: true,
  };
  const collapsible = !!(phase.subPhases && phase.subPhases.length > 1);
  return { job, task: pseudoTask, phaseId: phase.id, phaseName: phase.isDefault ? null : phase.name, subPhaseId: seg.subPhaseId, subPhaseName: seg.subPhaseName, collapsible };
}

// Tasks view: every phase/sub-phase starts CONDENSED by default —
// explicitly expanding one (see tasksExpandedPhaseIds/
// tasksExpandedSubPhaseIds above, toggleTasksPhaseExpanded()/
// toggleTasksSubPhaseExpanded() below) peels it open independently of
// every other phase/sub-phase.
function buildVisibleTaskRows(): GanttRow[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: GanttRow[] = [];
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach((job) => {
    if (job.archived) return;
    // See ganttFocusedJobId/toggleGanttJobFocus() above — isolates the
    // chart to one job's rows when set, Tasks
    // view only. Whichever side of a linked pair is isolated, the other
    // side stays visible too — a job's .link.jobId only ever points at
    // its actual linked counterpart (linkJobs() always pairs across the
    // two fixed projects), so this can't accidentally match an unrelated
    // job.
    if (ganttFocusedJobId && job.id !== ganttFocusedJobId) {
      const isLinkedCounterpart = !!(job.link && job.link.jobId === ganttFocusedJobId);
      if (!isLinkedCounterpart) return;
    }
    getJobPhases(job).forEach((phase) => {
      const phaseName = phase.isDefault ? null : phase.name;
      const collapsible = !!(phase.subPhases && phase.subPhases.length > 1);
      if (collapsible && !tasksExpandedPhaseIds.has(phase.id || '')) {
        const segments = getPhaseSegments(phase, hiddenOrders);
        if (segments.length) rows.push(buildPhaseCollapsedRow(job, phase, segments));
        return;
      }
      getPhaseSubUnits(phase).forEach((subUnit, subIdx) => {
        const subPhaseName = subUnit.isDefault ? null : subUnit.name;
        const subKey = getSubUnitKey(job, phase.id, subUnit.id);
        const subCollapsed = !tasksExpandedSubPhaseIds.has(subKey);
        if (subCollapsed) {
          const seg = buildSegment(subUnit, hiddenOrders);
          if (seg) rows.push(buildSubPhaseRow(job, phase, seg));
        } else {
          (subUnit.tasks || []).forEach((task) => {
            if (hiddenOrders.has(task.order)) return;
            // Unscheduled tasks (no start/finish yet) don't get a Gantt row
            // at all — they still exist on the job and in the Job Manager
            // grid, they just don't clutter the schedule until a date is set.
            if (!task.start || !task.finish) return;
            if (isNaN(new Date(task.start + 'T00:00:00').getTime()) || isNaN(new Date(task.finish + 'T00:00:00').getTime())) return;
            rows.push({ job, task, phaseId: phase.id, phaseName, subPhaseId: subUnit.id, subPhaseName, collapsible });
          });
        }
        // A linked reference job's due marker lives on a card in ITS OWN
        // project, not this one's boardCards — nothing to fetch here.
        // Sub-phases never have their own card either, so the due marker
        // only ever shows on the FIRST sub-unit's row — real or synthetic
        // default — never duplicated across every sub-phase. A COLLAPSED
        // first sub-unit already carries its own due marker inline (see
        // the isJobSpan branch in renderGantt()'s own draw loop, which
        // attaches the flag straight to the end of that sub-unit's own
        // condensed bar) — pushing a second, separate due-marker row here
        // on top of that would just duplicate it as an extra dropped-down
        // line.
        if (!job.isLinkedReference && subIdx === 0 && !subCollapsed) {
          const dueTask = getJobDueMarkerTask(job, phase.id);
          if (dueTask) rows.push({ job, task: dueTask, phaseId: phase.id, phaseName, subPhaseId: subUnit.id, subPhaseName, collapsible });
        }
      });
    });
  });
  rows.sort((a, b) => byStartDate(a.task, b.task) || (((a.job.order as number | undefined) || 0) - ((b.job.order as number | undefined) || 0)));
  return rows;
}

// ===== GANTT: MAIN RENDER =====
// The 8 phases below are module-level functions (not closures nested
// inside renderGantt()) — each takes exactly what it needs as named
// parameters and returns exactly what it produces, instead of ~12 values
// shared implicitly through closure. renderGantt() itself is a thin
// pipeline that calls each once, in a fixed order, threading each
// phase's return value into the next call's arguments.

interface JobBarMapEntry {
  left: number;
  width: number;
  top: number;
  bar: HTMLElement;
  jobColor?: string;
}

interface SetupDateRangeAndGridResult {
  grid: HTMLElement;
  header: HTMLElement;
  leftBody: HTMLElement;
  totalDays: number;
  containerH: number;
  gridWidth: number;
  savedScrollLeft: number;
  savedScrollTop: number;
}

function setupDateRangeAndGrid(): SetupDateRangeAndGridResult {
  computeDateRange();
  const totalDays = getDaysDiff(startDate, endDate) + 1;
  const containerW = document.getElementById('timelineBody')!.clientWidth;
  const containerH = document.getElementById('timelineBody')!.clientHeight;
  const gridWidth = Math.max(totalDays * dayWidth, containerW);
  const grid = document.getElementById('timelineGrid')!;
  const header = document.getElementById('timelineHeader')!;
  const leftBody = document.getElementById('leftBody')!;

  // timelineBody's own scrollLeft is the source of truth for horizontal
  // position now — the header is positioned via transform, driven from
  // it (see setHeaderScroll()), not independently scrolled itself.
  const savedScrollTb = document.getElementById('timelineBody');
  const savedScrollLeft = savedScrollTb ? savedScrollTb.scrollLeft : 0;
  const savedScrollTop = savedScrollTb ? savedScrollTb.scrollTop : 0;

  grid.style.width = gridWidth + 'px';
  header.style.width = gridWidth + 'px';
  grid.innerHTML = '';
  header.innerHTML = '';
  leftBody.innerHTML = '';

  return { grid, header, leftBody, totalDays, containerH, gridWidth, savedScrollLeft, savedScrollTop };
}

function buildDateHeader(totalDays: number, grid: HTMLElement, header: HTMLElement): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let current = new Date(startDate);
  let weekStart = new Date(current);

  for (let i = 0; i < totalDays; i++) {
    const dayLeft = i * dayWidth;
    const isWknd = current.getDay() === 0 || current.getDay() === 6;
    const isToday = current.getTime() === today.getTime();

    const dayDiv = document.createElement('div');
    dayDiv.className = 'day-header' + (isWknd ? ' weekend' : '') + (isToday ? ' today-header' : '');
    dayDiv.style.left = dayLeft + 'px';
    dayDiv.style.width = dayWidth + 'px';
    dayDiv.innerHTML = '<span class="day-num">' + current.getDate() + '</span><span class="day-name">' + dayNames[current.getDay()] + '</span>';
    dayDiv.dataset.date = toIsoDate(current);
    // A per-iteration snapshot, not `current` itself — `current` is one
    // Date object mutated in place for the rest of this loop
    // (current.setDate(...) below), so every day's closure would
    // otherwise share that same object and see whatever date it holds
    // by the time a user actually hovers/clicks, not the date this
    // specific header was built for. Real bug — fixed on Karl's
    // go-ahead.
    const dayDate = new Date(current);
    dayDiv.addEventListener('click', (e) => showDatePopover(e, dayDate));
    dayDiv.addEventListener('mouseenter', (e) => showDatePopover(e, dayDate));
    dayDiv.addEventListener('mouseleave', hideDatePopover);
    header.appendChild(dayDiv);

    const line = document.createElement('div');
    line.className = 'grid-line' + (isWknd ? ' weekend-line' : '');
    line.style.left = dayLeft + 'px';
    grid.appendChild(line);

    if (isToday) {
      const todayBg = document.createElement('div');
      todayBg.className = 'grid-line today-line-bg';
      todayBg.style.left = dayLeft + 'px';
      // No width set here — .today-line-bg's own CSS spans it from `left`
      // to the grid's real right edge via right:0 (see that rule's
      // comment).
      grid.appendChild(todayBg);
    }

    if (current.getDay() === 6 || i === totalDays - 1) {
      const wDays = getDaysDiff(weekStart, current) + 1;
      const wLeft = getDaysDiff(startDate, weekStart) * dayWidth;
      const wDiv = document.createElement('div');
      wDiv.className = 'week-header';
      wDiv.style.left = wLeft + 'px';
      wDiv.style.width = (wDays * dayWidth) + 'px';
      wDiv.textContent = 'Week of ' + weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      wDiv.dataset.weekStart = toIsoDate(weekStart);
      wDiv.addEventListener('click', () => {
        document.getElementById('timelineBody')!.scrollTo({ left: wLeft - 20, behavior: 'smooth' });
      });
      header.appendChild(wDiv);
      weekStart = new Date(current);
      weekStart.setDate(weekStart.getDate() + 1);
    }

    current.setDate(current.getDate() + 1);
  }

  return today;
}

interface BuildRowModelResult {
  jobBarMap: Record<string, JobBarMapEntry[]>;
  visibleRows: GanttRow[];
  gridHeightPx: number;
}

function buildRowModel(containerH: number, grid: HTMLElement): BuildRowModelResult {
  const jobBarMap: Record<string, JobBarMapEntry[]> = {};
  const visibleRows = buildVisibleTaskRows();

  // .timeline-grid's own CSS only guarantees min-height:100% of its
  // scroll container — every child in here (row backgrounds aside) is
  // position:absolute, so they never grow that box themselves. Elements
  // anchored with top:0/bottom:0 to fill it (.grid-line day separators,
  // .today-line) were stopping at the viewport edge instead of reaching
  // the actual last task row when there were more rows than fit on
  // screen. Explicitly size the box to cover every row plus a few extra
  // rows of breathing room below the last task, falling back to at least
  // the viewport height so a short list still fills the visible area.
  const GANTT_EXTRA_ROWS_BELOW = 4;
  const gridHeightPx = Math.max(containerH, (visibleRows.length + GANTT_EXTRA_ROWS_BELOW) * GANTT_ROW_H);
  grid.style.height = gridHeightPx + 'px';

  return { jobBarMap, visibleRows, gridHeightPx };
}

// See this function's own visibleRowIdx — barVisibleIdx in
// renderTimelineBars() below MUST stay in lockstep with it for the same
// reason: both loops walk the identical visibleRows array,
// unconditionally, once — that's the only reason a left-panel row's
// Y-position and its timeline bar's Y-position (computed from two
// separately-incrementing counters) stay aligned. If either loop ever
// gains a mid-loop skip/continue, the other must get the same one.
function renderLeftPanelRows(visibleRows: GanttRow[], grid: HTMLElement, gridWidth: number, leftBody: HTMLElement, gridHeightPx: number): void {
  let visibleRowIdx = 0;
  visibleRows.forEach(function (entry) {
    const job = entry.job, task = entry.task, phaseId = entry.phaseId, phaseName = entry.phaseName, subPhaseId = entry.subPhaseId, subPhaseName = entry.subPhaseName;
    // "Sub-Phase (Phase)" when both exist, otherwise whichever one does —
    // same truncation-survives-because-it's-first treatment as phaseName
    // alone got, just one level deeper.
    const phaseLabel = subPhaseName ? (subPhaseName + (phaseName ? ' (' + phaseName + ')' : '')) : phaseName;
    const rowKey = ganttRowKey(job.id, task.id, phaseId, subPhaseId);
    {
      const bg = document.createElement('div');
      bg.className = 'row-bg';
      // '::flat' — this row's OWN plain `rowKey` (shared with the timeline
      // bar/border/etc. in renderTimelineBars()) sits GANTT_BAR_PAD lower
      // than this element's flat, unpadded top (the bar is a shorter pill
      // vertically centered within the row; this spans the row's full
      // height) — a REAL, always-present ~7px difference, not something
      // this reorder animation caused. animateReorderedBars() stores one
      // old-position number per key, so two elements sharing a row but
      // sitting at genuinely different heights need genuinely different
      // keys, or whichever gets captured second silently clobbers the
      // first's stored position — corrupting THAT element's delta (this
      // is exactly what broke the very first version of this suffix
      // scheme: the padded bar's own animation started from the flat
      // row's position instead of its own).
      bg.dataset.rowKey = rowKey + '::flat';
      bg.style.top = (visibleRowIdx * GANTT_ROW_H) + 'px';
      bg.style.width = gridWidth + 'px';
      grid.appendChild(bg);

      const hasDates = !!(task.start && task.finish && !isNaN(new Date(task.start + 'T00:00:00').getTime()) && !isNaN(new Date(task.finish + 'T00:00:00').getTime()));
      const startStr = hasDates ? new Date(task.start! + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const finishStr = hasDates ? new Date(task.finish! + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
      const noteDot = task.notes ? '<span class="note-dot" title="Has notes"></span>' : '';

      const row = document.createElement('div');
      row.className = 'task-row' + (task.isDueMarker ? ' due-marker-row' : '') + (job.archived ? ' archived' : '') + (isTaskFinished(job, task) ? ' finished' : '') + (job.isLinkedReference ? ' linked-ref' : '');
      row.dataset.jobId = job.id;
      row.dataset.taskId = task.id;
      // Same flat (unpadded) alignment as `bg` just above — see its own
      // comment on why this needs its own suffixed key rather than the
      // plain `rowKey` the timeline side uses.
      row.dataset.rowKey = rowKey + '::flat';
      // Jobs view: the job-name pill already says everything there is to
      // say for a condensed row, so it's the only label — no redundant
      // plain-text repeat of the same name next to it. Leads view swaps
      // that plain-text slot for the lead's name instead, with the job
      // pill still alongside it so which job it belongs to stays visible.
      // A phased job is the exception: this column truncates with an
      // ellipsis (see .task-row .col CSS), and the phase name used to be
      // appended to the END of the pill — exactly the part that gets cut
      // off first, leaving every one of a job's phase rows showing the
      // identical truncated text with no way to tell them apart. Showing
      // the phase label as the plain-text mainLabel instead puts it FIRST,
      // so it survives truncation even when the job name pill after it
      // doesn't; the row's title attribute carries the untruncated
      // "Job — Phase — SubPhase" text as a hover fallback either way.
      const linkGlyph = job.isLinkedReference ? '🔗 ' : '';
      const isTasksMode = ganttViewMode === 'tasks';
      // Tasks view shows the phase/sub-phase breakdown as its own separate,
      // independently-clickable pills (see phasePillHtml/subPillHtml below)
      // instead of this plain-text label, to avoid saying the same thing
      // twice.
      const mainLabel = task.isJobSpan
        ? (linkGlyph ? linkGlyph.trim() : '')
        : linkGlyph + (task.isDueMarker ? '🚩 ' : '') + escapeHtml(task.name);
      let jobPill = '', phasePillHtml = '', subPillHtml = '';
      if (isTasksMode) {
        const jobColor = job.color || '#999';
        // Clicking the job pill isolates the Gantt to just this job (see
        // ganttFocusedJobId/toggleGanttJobFocus() above) — independent of
        // the phase/sub-phase collapse pills below, which fold THIS job's
        // own rows rather than hiding every other job.
        const isFocusedJob = ganttFocusedJobId === job.id;
        const jobPillTitle = isFocusedJob ? 'Click to show every job again' : 'Click to show only this job';
        jobPill = '<span class="task-row-jobname collapsible' + (isFocusedJob ? ' focused' : '') + '" title="' + jobPillTitle + '" style="background:' + jobColor + ';">' + escapeHtml(job.name) + (job.isLinkedReference ? ' <span style="opacity:0.75;">(' + escapeHtml(job.linkedFromProjectName || '') + ')</span>' : '') + '</span>';
        // Only offered when the phase actually has 2+ real sub-phases —
        // folds/unfolds just THIS phase (tasksExpandedPhaseIds), same
        // condensed-bar mechanism Jobs/Leads view uses, just with its own
        // independent (default-collapsed) state. phaseName !== null (rather
        // than just truthy) so an unnamed-but-real phase (see
        // splitJobIntoPhases()/renameJobPhaseUI() — a phase's name can be
        // blank) still gets this pill; null specifically means "no real
        // phase here at all" (the synthetic default from getJobPhases()).
        if (entry.collapsible && phaseName !== null) {
          const phaseFolded = !tasksExpandedPhaseIds.has(phaseId || '');
          phasePillHtml = ' <span class="task-row-phasename collapsible" title="' + (phaseFolded ? 'Click to expand sub-phases' : 'Click to collapse sub-phases into one bar') + '" style="background:' + jobColor + ';">' + (phaseFolded ? '▸ ' : '▾ ') + (phaseName ? escapeHtml(phaseName) : 'Unnamed phase') + '</span>';
        }
        // Not shown on a whole-phase-collapsed row (task.isJobSpan with
        // collapsedSegments) — that row already stands for every
        // sub-phase at once, so there's no single sub-phase context
        // left to fold.
        if (!(task.isJobSpan && entry.collapsedSegments)) {
          const subKey = getSubUnitKey(job, phaseId, subPhaseId);
          const subFolded = !tasksExpandedSubPhaseIds.has(subKey);
          const subLabel = subPhaseName || (entry.collapsible ? '' : phaseName) || '';
          subPillHtml = ' <span class="task-row-subphasename collapsible" title="' + (subFolded ? 'Click to expand into individual tasks' : 'Click to collapse into a single bar') + (subLabel ? ' — ' + escapeHtml(subLabel) : '') + '" style="background:' + jobColor + ';">' + (subFolded ? '▸' : '▾') + (subLabel ? ' ' + escapeHtml(subLabel) : '') + '</span>';
        }
      } else {
        // Jobs/Leads view: unchanged from before this feature — the job
        // pill itself is the per-phase fold toggle when the phase has 2+
        // sub-phases (every job is already condensed here, so there's no
        // separate "expand to individual tasks" state to reach).
        const collapseGlyph = entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? '▸ ' : '▾ ') : '';
        const collapseTitle = entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? 'Click to expand sub-phases' : 'Click to collapse sub-phases into one bar') : '';
        jobPill = '<span class="task-row-jobname' + (entry.collapsible ? ' collapsible' : '') + '"' + (collapseTitle ? ' title="' + collapseTitle + '"' : '') + ' style="background:' + (job.color || '#999') + ';">' + collapseGlyph + escapeHtml(job.name) + (job.isLinkedReference ? ' <span style="opacity:0.75;">(' + escapeHtml(job.linkedFromProjectName || '') + ')</span>' : '') + '</span>';
      }
      row.title = (job.isLinkedReference ? 'Linked from ' + job.linkedFromProjectName + ' — read-only, click to open there — ' : '') + job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
      // Bolded so the task/phase name itself reads as the row's primary
      // content — the job/phase pills next to it are already full-
      // saturation color, which otherwise out-competes plain-weight text
      // for attention despite being the smaller of the two.
      const mainLabelHtml = mainLabel ? '<span class="task-row-name">' + mainLabel + '</span> ' : '';
      row.innerHTML = '<div class="col col-start">' + startStr + '</div><div class="col col-finish">' + finishStr + '</div><div class="col col-jobs">' + mainLabelHtml + jobPill + phasePillHtml + subPillHtml + noteDot + '</div>';
      const openRow = () => { if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId); };
      row.addEventListener('click', openRow);
      // Opening a row is the primary keyboard-reachable action here — the
      // nested pills' own click-to-toggle handlers below stay mouse-only,
      // same scoping as the timeline bars further down (dragging/resizing
      // a bar also stays mouse/touch-only).
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); }
      });
      if (isTasksMode) {
        const jobPillEl = row.querySelector('.task-row-jobname');
        if (jobPillEl) jobPillEl.addEventListener('click', function (e) { e.stopPropagation(); toggleGanttJobFocus(job.id); });
        if (phasePillHtml) {
          const phaseEl = row.querySelector('.task-row-phasename');
          if (phaseEl) phaseEl.addEventListener('click', function (e) { e.stopPropagation(); toggleTasksPhaseExpanded(phaseId); });
        }
        if (subPillHtml) {
          const subEl = row.querySelector('.task-row-subphasename');
          if (subEl) subEl.addEventListener('click', function (e) { e.stopPropagation(); toggleTasksSubPhaseExpanded(getSubUnitKey(job, phaseId, subPhaseId)); });
        }
      } else if (entry.collapsible) {
        const pillEl = row.querySelector('.task-row-jobname');
        if (pillEl) pillEl.addEventListener('click', function (e) { e.stopPropagation(); togglePhaseCollapse(phaseId); });
      }
      leftBody.appendChild(row);
      visibleRowIdx++;
    }
  });

  // leftBody's own scrollable height is just its stacked .task-row
  // children (visibleRows.length * GANTT_ROW_H) — shorter than
  // .timeline-grid's height (gridHeightPx, above), which pads in
  // GANTT_EXTRA_ROWS_BELOW of empty space below the last row. Without
  // matching that here, leftBody hits its own scroll limit first while
  // timelineBody (synced 1:1 by scrollTop, see setupScrollSync()) can
  // keep going those extra rows further — the two panels desync and
  // job rows stop lining up with their Gantt bars. A trailing spacer
  // the same size as that padding keeps both panels' max scrollTop
  // identical.
  const leftSpacer = document.createElement('div');
  leftSpacer.style.height = Math.max(0, gridHeightPx - visibleRows.length * GANTT_ROW_H) + 'px';
  leftBody.appendChild(leftSpacer);
}

function drawTodayLine(grid: HTMLElement, today: Date, totalDays: number): void {
  const todayIdx = getDaysDiff(startDate, today);
  if (todayIdx >= 0 && todayIdx < totalDays) {
    const tl = document.createElement('div');
    tl.className = 'today-line';
    tl.style.left = (todayIdx * dayWidth + dayWidth / 2) + 'px';
    grid.appendChild(tl);
    const tlbl = document.createElement('div');
    tlbl.className = 'today-label';
    tlbl.style.left = (todayIdx * dayWidth + dayWidth / 2 + 6) + 'px';
    tlbl.textContent = 'Today — ' + today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    grid.appendChild(tlbl);
  }
}

// See renderLeftPanelRows()'s comment on visibleRowIdx — barVisibleIdx
// here must stay in exact lockstep with it for the same reason.
//
// Mutates the jobBarMap parameter in place (pushes an entry per job) —
// this is the one phase whose real output isn't a return value.
// buildRowModel() creates it, this function fills it, and
// drawConnectorLines() below reads the same object afterward.
//
// Shared with renderLeftPanelRows() below — both build their own separate
// DOM for the exact same logical row (one in #timelineGrid, one in
// #leftBody), so animateReorderedBars() needs the identical key from both
// sides to recognize them as the same row and move them together.
function ganttRowKey(jobId: string, taskId: string | undefined, phaseId: string | null | undefined, subPhaseId: string | null | undefined): string {
  return jobId + '::' + (taskId || '') + '::' + (phaseId || '') + '::' + (subPhaseId || '');
}

function renderTimelineBars(visibleRows: GanttRow[], grid: HTMLElement, jobBarMap: Record<string, JobBarMapEntry[]>): void {
  let barVisibleIdx = 0;
  visibleRows.forEach(function (entry) {
    const job = entry.job, task = entry.task, phaseId = entry.phaseId, phaseName = entry.phaseName, subPhaseId = entry.subPhaseId, subPhaseName = entry.subPhaseName;
    const phaseLabel = subPhaseName ? (subPhaseName + (phaseName ? ' (' + phaseName + ')' : '')) : phaseName;
    const hasDates = !!(task.start && task.finish);
    const s = hasDates ? new Date(task.start + 'T00:00:00') : null;
    const f = hasDates ? new Date(task.finish + 'T00:00:00') : null;
    const validDates = hasDates && s && f && !isNaN(s.getTime()) && !isNaN(f.getTime());

    // Tasks without dates still occupy a row (drawn above in the left
    // panel) but get no bar in the timeline grid — nothing to position.
    if (validDates && s && f) {
      const startIdx = getDaysDiff(startDate, s);
      const duration = getDaysDiff(s, f) + 1;
      // Stable identity across a full rebuild (every render tears down and
      // recreates every element here — see setupDateRangeAndGrid()'s
      // grid.innerHTML reset) so animateReorderedBars() can tell "this is
      // the same row, just moved" from "this is a different row that
      // happens to land at the same top" — see its own comment for why
      // that distinction matters. Applied to EVERY element this row draws,
      // not just `bar` itself — a job-span row's actual VISIBLE content
      // (the border outline, the job-name label, the due marker, the
      // day-by-day segments below) are all separate elements layered over
      // `bar`, which is left transparent and only exists as a fallback
      // drag/click target (see its own comment) — AND renderLeftPanelRows()
      // builds its own separate .task-row for this exact same row in the
      // sidebar, which needs the identical key (see ganttRowKey()) so it
      // animates in step too, instead of snapping while the timeline side
      // glides (Karl's own report: "phases moving independently of the
      // individual job bars").
      const rowKey = ganttRowKey(job.id, task.id, phaseId, subPhaseId);
      const bar = document.createElement('div');
      bar.className = 'task-bar' + (isTaskFinished(job, task) ? ' finished' : '') + (task.isDueMarker ? ' due-marker-bar' : '');
      bar.dataset.dragged = 'false';
      bar.dataset.rowKey = rowKey;
      if (duration === 1) bar.classList.add('milestone');
      bar.style.left = (startIdx * dayWidth) + 'px';
      bar.style.width = (duration * dayWidth) + 'px';
      bar.style.top = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';
      if (task.isJobSpan) {
        // Condensed 'jobs'/'leads' bar: left transparent — a solid fill
        // here would otherwise show through in gap stretches, which are
        // meant to look empty. `bar` itself stays in the DOM purely so a
        // grab anywhere that isn't one of the individually-colored task
        // segments (i.e. a gap, or an overlap hatch) still moves the whole
        // job — all the color now comes from the outline and the
        // individual day-segments built below.
        bar.classList.add('job-span-bar');
        const labelWrap = document.createElement('div');
        labelWrap.className = 'job-span-name-wrap' + (job.isLinkedReference ? ' linked-ref' : '');
        labelWrap.dataset.jobId = job.id;
        labelWrap.dataset.phaseId = phaseId || '';
        labelWrap.dataset.subPhaseId = subPhaseId || '';
        labelWrap.dataset.rowKey = rowKey;
        labelWrap.dataset.origLeft = String(startIdx * dayWidth);
        labelWrap.style.left = (startIdx * dayWidth) + 'px';
        labelWrap.style.width = (duration * dayWidth) + 'px';
        labelWrap.style.top = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';
        // Tasks view shows the phase/sub-phase fold toggles as their own
        // separate tags (see buildPhaseSubTags() below) instead of folding
        // them into this job tag, so the job tag itself is a pure label
        // there — matches the left-panel pill split (see renderGantt()'s
        // sidebar loop above).
        const isTasksMode = ganttViewMode === 'tasks';
        const isFocusedJob = isTasksMode && ganttFocusedJobId === job.id;
        const jobTag = document.createElement('span');
        jobTag.className = 'task-bar-job-tag' + (isTasksMode || entry.collapsible ? ' collapsible' : '') + (isFocusedJob ? ' focused' : '');
        // Not softened — see the comment on the other task-bar-job-tag
        // background assignment above for why (hardcoded white text).
        jobTag.style.background = job.color || '#999';
        const barCollapseGlyph = !isTasksMode && entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? '▸ ' : '▾ ') : '';
        jobTag.textContent = (job.isLinkedReference ? '🔗 ' : '') + barCollapseGlyph + job.name + (!isTasksMode && phaseLabel ? ' — ' + phaseLabel : '');
        jobTag.title = (isTasksMode ? (isFocusedJob ? 'Click to show every job again — ' : 'Click to show only this job — ') : (entry.collapsible ? (collapsedPhaseIds.has(phaseId || '') ? 'Click to expand sub-phases — ' : 'Click to collapse sub-phases into one bar — ') : '')) +
          job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
        // The on-bar name tag gets the same click-to-focus (Tasks view) or
        // collapse toggle (Jobs/Leads view) as the left-panel pill (see the
        // .collapsible CSS above for the pointer-events opt-in) —
        // stopPropagation so it toggles instead of also starting a
        // whole-bar drag or falling through to editJob.
        if (isTasksMode) {
          jobTag.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          jobTag.addEventListener('click', function (e) { e.stopPropagation(); toggleGanttJobFocus(job.id); });
        } else if (entry.collapsible) {
          jobTag.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          jobTag.addEventListener('click', function (e) { e.stopPropagation(); togglePhaseCollapse(phaseId); });
        }
        labelWrap.appendChild(jobTag);
        if (isTasksMode) {
          buildPhaseSubTags(job, phaseId, phaseName, subPhaseId, subPhaseName, entry.collapsible, !!entry.collapsedSegments).forEach(function (t) { labelWrap.appendChild(t); });
        }
        grid.appendChild(labelWrap);

        // Outline the whole span in the job's own color — drawn as a
        // separate overlay (rather than a border on `bar` itself) so it
        // stays visible on top of the day-segments instead of being
        // painted over by them.
        const borderOverlay = document.createElement('div');
        borderOverlay.className = 'job-span-border' + (job.isLinkedReference ? ' linked-ref' : '');
        borderOverlay.dataset.jobId = job.id;
        borderOverlay.dataset.phaseId = phaseId || '';
        borderOverlay.dataset.subPhaseId = subPhaseId || '';
        borderOverlay.dataset.rowKey = rowKey;
        borderOverlay.dataset.origLeft = String(startIdx * dayWidth);
        borderOverlay.style.left = (startIdx * dayWidth) + 'px';
        borderOverlay.style.width = (duration * dayWidth) + 'px';
        borderOverlay.style.top = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';
        borderOverlay.style.borderColor = job.color || '#3949ab';
        grid.appendChild(borderOverlay);

        // Due date marker: its own little flagged circle (same look as a
        // Tasks-view due-marker bar), connected back to the condensed span
        // by a line in the bar's own color — unless the span's own finish
        // already reaches the due date, in which case there's nothing to
        // bridge and the circle just sits on top of the bar instead (see
        // the z-index on .job-span-due-marker). Deliberately left out of
        // the whole-job-move drag-along list below (unlike the ticks/
        // segments) — moving the scheduled tasks doesn't move the deadline
        // itself, only re-render() catching up on drop should change how
        // far apart they are. It's independently draggable on its own via
        // startBarMove()'s existing DUE_MARKER_TASK_ID handling, same as
        // the Tasks-view due marker. Only drawn on the FIRST sub-unit's bar
        // (there's no per-sub-phase card to carry a second due date) — same
        // gating as flattenJobs()/buildVisibleTaskRows().
        // phaseId is always the row's real phase — even when collapsed, the
        // collapsed row still belongs to one specific phase (unlike the
        // sub-phases it folds together). A collapsed row's own subPhaseId
        // is null (it stands for all of them at once), which the due
        // marker treats the same as "the first sub-unit" since the card —
        // and its due date — is per-phase either way.
        const parentPhaseForDue = getJobPhases(job).find(function (p) { return (p.id || null) === (phaseId || null); });
        const isFirstSubUnit = entry.collapsedSegments ? true : (!parentPhaseForDue || (getPhaseSubUnits(parentPhaseForDue)[0].id || null) === (subPhaseId || null));
        const dueTask = isFirstSubUnit ? getJobDueMarkerTask(job, phaseId) : null;
        if (dueTask && dueTask.start) {
          const dueDate = new Date(dueTask.start + 'T00:00:00');
          const dueIdx = getDaysDiff(startDate, dueDate);
          const barEndIdx = startIdx + duration - 1;
          const dueLeft = dueIdx * dayWidth;
          const markerColor = (task.color as string | undefined) || '#e53935';

          const dueEl = document.createElement('div');
          dueEl.className = 'job-span-due-marker';
          dueEl.dataset.jobId = job.id;
          dueEl.dataset.dragged = 'false';
          dueEl.dataset.rowKey = rowKey;
          dueEl.style.left = dueLeft + 'px';
          dueEl.style.top = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';
          dueEl.style.background = markerColor;
          dueEl.textContent = '🚩';
          dueEl.title = dueTask.name + ': ' + dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          dueEl.addEventListener('mouseenter', function (e) { showTooltip(e, job, dueTask); });
          dueEl.addEventListener('mouseleave', hideTooltip);
          dueEl.addEventListener('mousemove', moveTooltip);
          // Read-only, same as the span's own bar/border just above — a
          // linked reference job's real data lives in its home project, so
          // this must jump there (like the bar) instead of calling editJob()
          // straight against job.id, which belongs to the OTHER project's
          // jobs array and would just silently no-op here. No mousedown/
          // startBarMove wiring either — dragging isn't offered for a
          // linked reference's bar, so its due marker shouldn't be
          // draggable on its own either.
          let openDueEl: () => void;
          if (job.isLinkedReference) {
            dueEl.classList.add('linked-ref');
            openDueEl = () => jumpToLinkedJobReference(job);
            dueEl.addEventListener('click', openDueEl);
          } else {
            dueEl.addEventListener('mousedown', function (e) { startBarMove(e, job.id, DUE_MARKER_TASK_ID, dueEl, false, phaseId); });
            openDueEl = () => {
              if (dueEl.dataset.dragged === 'true') { dueEl.dataset.dragged = 'false'; return; }
              editJob(job.id, phaseId);
            };
            dueEl.addEventListener('click', openDueEl);
          }
          dueEl.tabIndex = 0;
          dueEl.setAttribute('role', 'button');
          dueEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDueEl(); }
          });
          grid.appendChild(dueEl);

          let lineLeft: number | null = null, lineWidth = 0;
          if (dueIdx > barEndIdx) {
            lineLeft = (barEndIdx + 1) * dayWidth;
            lineWidth = dueLeft - lineLeft;
          } else if (dueIdx < startIdx) {
            lineLeft = dueLeft + 18;
            lineWidth = (startIdx * dayWidth) - lineLeft;
          }
          if (lineLeft !== null && lineWidth > 0) {
            const dueLine = document.createElement('div');
            dueLine.className = 'job-span-due-line';
            dueLine.dataset.jobId = job.id;
            // Its own vertically-CENTERED offset (row-half, not
            // GANTT_BAR_PAD) — needs its own suffixed key for the same
            // reason `bg`/`row` do (see their own comment).
            dueLine.dataset.rowKey = rowKey + '::centerline';
            dueLine.style.left = lineLeft + 'px';
            dueLine.style.width = lineWidth + 'px';
            dueLine.style.top = (barVisibleIdx * GANTT_ROW_H + Math.round(GANTT_ROW_H / 2) - 1) + 'px';
            dueLine.style.background = markerColor;
            grid.appendChild(dueLine);
          }
        }
      } else {
        bar.style.background = softenColor((task.color as string | undefined) || job.color);
        // Same job-color outline as a condensed Jobs/Leads bar, so which
        // job a task belongs to is visible at a glance without needing the
        // job-name tag below. Due markers keep their own white/red ring
        // instead — that's a distinct "this is a due date" signal, not a
        // job identity one. Left at full saturation (unsoftened) so it
        // still reads as a crisp edge against the softened fill.
        if (!task.isDueMarker) bar.style.border = '2px solid ' + (job.color || '#3949ab');
        bar.textContent = task.isDueMarker ? '🚩' : '';
        if (duration !== 1) {
          const jobTag = document.createElement('span');
          const isTasksMode = ganttViewMode === 'tasks';
          const isFocusedJob = isTasksMode && ganttFocusedJobId === job.id;
          // Tasks view: clicking it isolates the Gantt to just this job
          // (see ganttFocusedJobId/toggleGanttJobFocus()) — Jobs/Leads
          // view's phase/sub-phase fold toggles are separate tags appended
          // below instead, matching the left-panel pill split.
          jobTag.className = 'task-bar-job-tag' + (isTasksMode ? ' collapsible' : '') + (isFocusedJob ? ' focused' : '');
          // Not softened — see the comment on the other task-bar-job-tag
          // background assignments above for why (hardcoded white text).
          jobTag.style.background = job.color;
          jobTag.textContent = (job.isLinkedReference ? '🔗 ' : '') + job.name + (!isTasksMode && phaseLabel ? ' — ' + phaseLabel : '');
          jobTag.title = (isTasksMode ? (isFocusedJob ? 'Click to show every job again — ' : 'Click to show only this job — ') : '') + job.name + (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
          if (isTasksMode) {
            jobTag.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            jobTag.addEventListener('click', function (e) { e.stopPropagation(); toggleGanttJobFocus(job.id); });
          }
          bar.appendChild(jobTag);
          if (isTasksMode) {
            buildPhaseSubTags(job, phaseId, phaseName, subPhaseId, subPhaseName, entry.collapsible, false).forEach(function (t) { bar.appendChild(t); });
          }
        }
      }
      if (job.isLinkedReference) bar.classList.add('linked-ref');
      bar.addEventListener('mouseenter', e => showTooltip(e, job, task));
      bar.addEventListener('mouseleave', hideTooltip);
      bar.addEventListener('mousemove', moveTooltip);
      const openBar = () => {
        if (bar.dataset.dragged === 'true') { bar.dataset.dragged = 'false'; return; }
        if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId);
      };
      bar.addEventListener('click', openBar);
      // Same open-via-keyboard treatment as the sidebar row above — the
      // drag-to-reschedule/resize handles (mousedown-based, below) stay
      // mouse/touch-only.
      bar.tabIndex = 0;
      bar.setAttribute('role', 'button');
      bar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBar(); }
      });

      // Read-only: a linked reference job's bar is never draggable/
      // resizable — its real data lives in, and can only be edited from,
      // its home project (see the "Interactivity" decision in the plan).
      if (!job.isLinkedReference) {
        if (task.isJobSpan) {
          // Condensed 'jobs'/'leads' bar: dragging it moves every one of the
          // sub-unit's real tasks by the same number of days (see the
          // isJobSpan branch in onBarMoveEnd), keeping the whole schedule
          // connected. No resize handles — there's no single task to stretch.
          bar.addEventListener('mousedown', e => startBarMove(e, job.id, task.id!, bar, true, phaseId, subPhaseId));
        } else {
          bar.addEventListener('mousedown', e => startBarMove(e, job.id, task.id!, bar));

          // A due date is a single point in time, not a range — only "move"
          // makes sense, so it gets no resize handles.
          if (!task.isDueMarker) {
            const handleLeft = document.createElement('div');
            handleLeft.className = 'task-bar-resize-handle task-bar-resize-handle-left';
            handleLeft.title = 'Drag to change start date';
            handleLeft.addEventListener('mousedown', e => startBarResizeLeft(e, job.id, task.id!, bar));
            handleLeft.addEventListener('click', e => e.stopPropagation());
            bar.appendChild(handleLeft);

            const handleRight = document.createElement('div');
            handleRight.className = 'task-bar-resize-handle task-bar-resize-handle-right';
            handleRight.title = 'Drag to change finish date';
            handleRight.addEventListener('mousedown', e => startBarResizeRight(e, job.id, task.id!, bar));
            handleRight.addEventListener('click', e => e.stopPropagation());
            bar.appendChild(handleRight);
          }
        }
      }

      grid.appendChild(bar);

      // Jobs/Leads view: the condensed bar is one solid span, but the real
      // tasks inside it usually run back-to-back rather than as a single
      // block. Walk it day by day and group consecutive days that have the
      // exact same set of covering tasks into one segment: a day covered
      // by one task is drawn solid in that task's own color and is
      // individually grabbable to move just that task (leaving the rest of
      // the job alone), a day covered by two or more overlapping tasks
      // gets a hard hatch alternating between their colors (click-through
      // to the whole-job drag, since there's no single task to target), and
      // a day covered by none is left blank. Ticks still mark each task's
      // finish date (except the last, which already coincides with the
      // bar's own right edge) so phase boundaries stay visible even
      // between two same-colored/adjacent tasks.
      // Skipped entirely for a linked reference — there's no single task
      // to individually grab/resize on a read-only bar, so the day-by-day
      // breakdown below (only useful for picking out one draggable task
      // segment from another) has nothing to offer; the plain outline+
      // label from the isJobSpan branch above is enough.
      if (task.isJobSpan && !job.isLinkedReference) {
        // A collapsed row (see collapsedPhaseIds/buildPhaseCollapsedRow)
        // still belongs to one specific phase — phaseId stays the row's
        // real phase either way — it just has no single sub-unit to read
        // tasks from (it spans every sub-phase of that phase). Build one
        // synthetic "task" per sub-phase segment instead, each covering
        // that sub-phase's own date range in the job's own color
        // (per-task coloring doesn't generalize once the same task types
        // repeat across sub-phases). Everything below (ticks, solid/hash/
        // hatch grouping) is identical either way; only which list feeds
        // it, and how a solid segment's drag/click is wired, differs.
        const isCollapsedRow = !!entry.collapsedSegments;
        const jobEndIdx = startIdx + duration - 1;
        let datedTasks: { t: GanttTask; sIdx: number; eIdx: number }[];
        if (isCollapsedRow && entry.collapsedSegments) {
          datedTasks = entry.collapsedSegments.map(function (seg) {
            return {
              t: {
                id: 'subphaseseg|' + (seg.subPhaseId || ''),
                name: seg.subPhaseName || '', color: job.color, notes: '',
                start: toIsoDate(seg.start), finish: toIsoDate(seg.finish),
                subPhaseId: seg.subPhaseId,
              },
              sIdx: getDaysDiff(startDate, seg.start), eIdx: getDaysDiff(startDate, seg.finish),
            };
          });
        } else {
          const spanPhase = getJobPhases(job).find(function (p) { return (p.id || null) === (phaseId || null); });
          const spanUnit = spanPhase && getPhaseSubUnits(spanPhase).find(function (s) { return (s.id || null) === (subPhaseId || null); });
          datedTasks = ((spanUnit && spanUnit.tasks) || []).map(function (t) {
            if (!t.start || !t.finish) return null;
            const ts = new Date(t.start + 'T00:00:00'), tf = new Date(t.finish + 'T00:00:00');
            if (isNaN(ts.getTime()) || isNaN(tf.getTime())) return null;
            return { t: t, sIdx: getDaysDiff(startDate, ts), eIdx: getDaysDiff(startDate, tf) };
          }).filter((x): x is { t: Task; sIdx: number; eIdx: number } => x !== null);
        }

        const seenIdx: Record<number, boolean> = {};
        datedTasks.forEach(function (dt) {
          if (dt.eIdx >= jobEndIdx || seenIdx[dt.eIdx]) return;
          seenIdx[dt.eIdx] = true;
          const tickLeft = (dt.eIdx + 1) * dayWidth;
          const tick = document.createElement('div');
          tick.className = 'job-span-task-tick';
          tick.dataset.jobId = job.id;
          tick.dataset.phaseId = phaseId || '';
          tick.dataset.subPhaseId = isCollapsedRow ? ((dt.t.subPhaseId as string | undefined) || '') : (subPhaseId || '');
          tick.dataset.taskId = dt.t.id;
          tick.dataset.rowKey = rowKey;
          tick.dataset.origLeft = String(tickLeft);
          tick.style.left = tickLeft + 'px';
          tick.style.top = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';
          // A sub-phase boundary (collapsed row) has no single task to
          // resize — moving it would mean shifting every task in that
          // sub-phase, which is what dragging the solid segment itself
          // already does. Static divider only; a real task's tick still
          // resizes as before.
          if (isCollapsedRow) {
            tick.title = dt.t.name + ' ends';
            tick.style.cursor = 'default';
          } else {
            tick.title = dt.t.name + ' — drag to change finish date';
            tick.addEventListener('mousedown', function (e) { startTickResize(e, job.id, dt.t.id!, tick); });
          }
          tick.addEventListener('click', function (e) { e.stopPropagation(); });
          grid.appendChild(tick);
        });

        // Keyed by task id (not color) so two different same-colored tasks
        // never get merged into one segment — each solid segment needs to
        // map to exactly one real task to be individually draggable.
        const dayTasks: { t: GanttTask; sIdx: number; eIdx: number }[][] = [];
        for (let i = 0; i < duration; i++) dayTasks.push([]);
        datedTasks.forEach(function (dt) {
          for (let d = Math.max(dt.sIdx, startIdx); d <= Math.min(dt.eIdx, jobEndIdx); d++) {
            dayTasks[d - startIdx].push(dt);
          }
        });

        let di = 0;
        while (di < duration) {
          const covering = dayTasks[di];
          const key = covering.map(function (dt) { return dt.t.id; }).sort().join('|');
          let dj = di;
          while (dj + 1 < duration && dayTasks[dj + 1].map(function (dt) { return dt.t.id; }).sort().join('|') === key) dj++;
          const segLeft = (startIdx + di) * dayWidth;
          const segWidth = (dj - di + 1) * dayWidth;
          const segTop = (barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD) + 'px';

          if (covering.length === 0) {
            const hash = document.createElement('div');
            hash.className = 'job-span-gap-hash';
            hash.dataset.jobId = job.id;
            hash.dataset.phaseId = phaseId || '';
            hash.dataset.subPhaseId = isCollapsedRow ? '' : (subPhaseId || '');
            hash.dataset.rowKey = rowKey;
            hash.dataset.origLeft = String(segLeft);
            hash.style.left = segLeft + 'px';
            hash.style.width = segWidth + 'px';
            hash.style.top = segTop;
            hash.title = 'No task scheduled here';
            grid.appendChild(hash);
          } else if (covering.length === 1) {
            // Unambiguously one task's (or, collapsed, one sub-phase's) own
            // stretch — grabbable to move just that task/sub-phase, same as
            // an individual bar in Tasks view. Overlap (below) stays
            // click-through since there's no single one to target there;
            // it falls through to the whole-job drag on `bar`.
            const dt = covering[0];
            const solid = document.createElement('div');
            solid.className = 'job-span-task-solid';
            solid.dataset.jobId = job.id;
            solid.dataset.phaseId = phaseId || '';
            solid.dataset.subPhaseId = isCollapsedRow ? ((dt.t.subPhaseId as string | undefined) || '') : (subPhaseId || '');
            solid.dataset.dragged = 'false';
            solid.dataset.rowKey = rowKey;
            solid.dataset.origLeft = String(segLeft);
            solid.style.left = segLeft + 'px';
            solid.style.width = segWidth + 'px';
            solid.style.top = segTop;
            solid.style.background = softenColor((dt.t.color as string | undefined) || job.color || '#3949ab');
            solid.title = dt.t.name;
            solid.addEventListener('mouseenter', function (e) { showTooltip(e, job, dt.t); });
            solid.addEventListener('mouseleave', hideTooltip);
            solid.addEventListener('mousemove', moveTooltip);
            let openSolid: () => void;
            if (isCollapsedRow) {
              solid.addEventListener('mousedown', function (e) { startBarMove(e, job.id, dt.t.id!, solid, true, phaseId, dt.t.subPhaseId as string | null); });
              openSolid = function () {
                if (solid.dataset.dragged === 'true') { solid.dataset.dragged = 'false'; return; }
                editJob(job.id, phaseId, dt.t.subPhaseId as string | null);
              };
            } else {
              solid.addEventListener('mousedown', function (e) { startBarMove(e, job.id, dt.t.id!, solid); });
              openSolid = function () {
                if (solid.dataset.dragged === 'true') { solid.dataset.dragged = 'false'; return; }
                editJob(job.id, phaseId, subPhaseId);
              };
            }
            solid.addEventListener('click', openSolid);
            solid.tabIndex = 0;
            solid.setAttribute('role', 'button');
            solid.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSolid(); }
            });
            grid.appendChild(solid);
          } else {
            const hatch = document.createElement('div');
            hatch.className = 'job-span-task-hatch';
            hatch.dataset.jobId = job.id;
            hatch.dataset.phaseId = phaseId || '';
            hatch.dataset.subPhaseId = isCollapsedRow ? '' : (subPhaseId || '');
            hatch.dataset.rowKey = rowKey;
            hatch.dataset.origLeft = String(segLeft);
            hatch.style.left = segLeft + 'px';
            hatch.style.width = segWidth + 'px';
            hatch.style.top = segTop;
            if (isCollapsedRow) {
              // Every sub-phase segment already shares the same job color,
              // so a normal same-color-dedup hatch would render as a flat
              // fill indistinguishable from a solid segment. Alternate the
              // job color with a darker shade of itself instead, so an
              // overlap still reads as a hatch.
              const base = softenColor(job.color || '#3949ab');
              const dark = darkenColor(base, 0.28);
              hatch.style.background = 'repeating-linear-gradient(45deg, ' + base + ' 0px, ' + base + ' 6px, ' + dark + ' 6px, ' + dark + ' 12px)';
              hatch.title = 'Overlapping sub-phases: ' + covering.map(function (dt) { return dt.t.name; }).join(', ');
            } else {
              const uniqColors = Array.from(new Set(covering.map(function (dt) { return softenColor((dt.t.color as string | undefined) || job.color || '#3949ab'); })));
              const stripe = 6;
              const stops: string[] = [];
              uniqColors.forEach(function (c, idx) {
                stops.push(c + ' ' + (idx * stripe) + 'px');
                stops.push(c + ' ' + ((idx + 1) * stripe) + 'px');
              });
              hatch.style.background = 'repeating-linear-gradient(45deg, ' + stops.join(', ') + ')';
              hatch.title = 'Overlapping tasks';
            }
            grid.appendChild(hatch);
          }
          di = dj + 1;
        }
      }

      if (!jobBarMap[job.id]) jobBarMap[job.id] = [];
      jobBarMap[job.id].push({
        left: startIdx * dayWidth,
        width: duration * dayWidth,
        top: barVisibleIdx * GANTT_ROW_H + GANTT_BAR_PAD,
        bar: bar,
        jobColor: job.color,
      });
    }

    barVisibleIdx++;
  });
}

// Given a stable id and removed-then-recreated on every call (rather than
// just appended) so redrawConnectorLinesLive() below can call this
// repeatedly on a rAF loop while bars are still animating, without
// stacking a fresh SVG on top of the last one every frame. The normal
// (non-animating) render path already gets this for free from
// setupDateRangeAndGrid()'s own grid.innerHTML wipe — this only matters
// for redraws that happen BETWEEN full renders.
const GANTT_CONNECTOR_SVG_ID = 'ganttConnectorSvg';
function drawConnectorLines(gridWidth: number, jobBarMap: Record<string, JobBarMapEntry[]>, grid: HTMLElement): void {
  const existing = document.getElementById(GANTT_CONNECTOR_SVG_ID);
  if (existing) existing.remove();
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('id', GANTT_CONNECTOR_SVG_ID);
  svg.setAttribute('style', 'position:absolute;top:0;left:0;width:' + gridWidth + 'px;height:100%;pointer-events:none;z-index:30;overflow:visible;');
  Object.values(jobBarMap).forEach(function (bars) {
    if (bars.length < 2) return;
    for (let i = 0; i < bars.length - 1; i++) {
      const a = bars[i], b = bars[i + 1];
      const x1 = a.left + a.width;
      const y1 = a.top + GANTT_BAR_H / 2;
      const x2 = b.left;
      const y2 = b.top + GANTT_BAR_H / 2;
      const path = document.createElementNS(svgNs, 'path');
      let d;
      if (x2 >= x1) {
        // Normal case: successor starts at/after predecessor ends — the
        // gap between the bars is empty, so a simple mid-point elbow is fine.
        const midX = (x1 + x2) / 2;
        d = 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
      } else {
        // Overlap case: successor starts before predecessor ends, so a
        // straight-through elbow would cut across one or both bars. Route
        // it out to the right of the predecessor, through the empty gap
        // between the rows, then down/up into the left of the successor.
        const laneY = Math.min(a.top, b.top) + GANTT_BAR_H + GANTT_BAR_PAD + 3;
        const rightX = x1 + 10;
        const leftX = x2 - 10;
        d = 'M ' + x1 + ' ' + y1 + ' L ' + rightX + ' ' + y1 + ' L ' + rightX + ' ' + laneY + ' L ' + leftX + ' ' + laneY + ' L ' + leftX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
      }
      path.setAttribute('d', d);
      path.setAttribute('stroke', a.jobColor || '#3949ab');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
    }
  });
  grid.appendChild(svg);
}

// The line(s) connecting a multi-phase job's separate bars into one
// visible "whole project" run (Karl's own description) are drawn ONCE per
// render, from each bar's FINAL rest position — reasonable when nothing's
// moving, but when a reorder animation is playing, those bars slide
// smoothly while this connector just sat at its post-render position the
// entire time, reading as the job's own bars fully snapping ahead of it/
// behind it rather than the connector tracking them. jobBarMap's `top` is
// a static number computed once at render time, but its `bar` field is a
// live DOM reference — reading each bar's REAL current on-screen position
// every frame (instead of the stale stored number) and redrawing through
// the same drawConnectorLines() lets the connector track the actual
// motion. Only top needs live-tracking: left/width are date-driven, never
// touched by a row-reorder.
function redrawConnectorLinesLive(jobBarMap: Record<string, JobBarMapEntry[]>, gridWidth: number, grid: HTMLElement): void {
  const gridTop = grid.getBoundingClientRect().top;
  const liveMap: Record<string, JobBarMapEntry[]> = {};
  Object.keys(jobBarMap).forEach(function (jobId) {
    liveMap[jobId] = jobBarMap[jobId].map(function (entry) {
      return { left: entry.left, width: entry.width, top: entry.bar.getBoundingClientRect().top - gridTop, bar: entry.bar, jobColor: entry.jobColor };
    });
  });
  drawConnectorLines(gridWidth, liveMap, grid);
}

function restoreScrollPosition(savedScrollTop: number, savedScrollLeft: number): void {
  requestAnimationFrame(() => {
    const tb = document.getElementById('timelineBody');
    // renderAll() calls renderGantt() unconditionally on load/refresh even
    // when Home (or any other tab) is what's actually showing — Gantt's
    // own panel is display:none then, so tb.clientWidth is 0 and
    // scrollToToday() below would silently compute against zero width and
    // effectively no-op. Only consume ganttFirstRender once the panel is
    // genuinely visible, so the real first scroll-to-today happens the
    // first time a user actually switches to the Gantt tab, not whenever
    // it happens to render invisibly first.
    if (ganttFirstRender && tb && tb.clientWidth > 0) {
      ganttFirstRender = false;
      tb.scrollTop = savedScrollTop;
      scrollToToday();
      setHeaderScroll(tb.scrollLeft);
    } else {
      if (tb) tb.scrollLeft = savedScrollLeft;
      setHeaderScroll(savedScrollLeft);
      if (tb) tb.scrollTop = savedScrollTop;
    }
    setupScrollSync();
  });
}

// Captures every row-tagged element's current position, keyed by the same
// stable dataset.rowKey renderTimelineBars() writes on `bar` AND every
// other element sharing its row (labelWrap/borderOverlay/dueEl/dueLine/
// tick/hash/solid/hatch — see rowKey's own comment for why all of them
// need this, not just `bar`), BEFORE setupDateRangeAndGrid()'s
// grid.innerHTML reset wipes them — there's no "old" DOM element to read a
// position back off of once that's run, since every one of them is a
// brand-new document.createElement() on every render, not an existing one
// being moved. Not scoped to any one class — any element carrying
// data-row-key gets the same treatment uniformly.
//
// Deliberately getBoundingClientRect().top, NOT el.style.top: a bar mid-
// reorder-animation already has its FINAL row's `top` set (only its
// `transform` is what's still animating away from it — see
// animateReorderedBars()), so el.style.top reads as the destination, not
// where it visually is right now. That distinction is exactly what broke
// this the first time it shipped: this app's own sync layer broadcasts a
// confirmation snapshot back to the very client that made a change (see
// room-do.ts's broadcastSnapshot() — it doesn't exclude the sender), which
// often lands well inside this animation's ~1s window and forces a second
// render on top of the first. Reading el.style.top there would see
// oldTop === newTop (both already the destination) and conclude nothing
// moved, so the freshly rebuilt bar would just appear at rest with no
// transform at all — silently truncating the animation after a fraction
// of a second, which read as "it barely animated"/"nothing happened"
// (Karl's own report). getBoundingClientRect() reflects the bar's TRUE
// current on-screen position, transform included, so a render that
// interrupts an in-flight one still computes a real, correct delta and
// continues the motion smoothly instead of snapping.
// #timelineGrid (the bars) and #leftBody (renderLeftPanelRows()'s own
// separate .task-row/.row-bg for the exact same rows, in a completely
// different container) both need every row-keyed element gathered
// together — otherwise the sidebar just snaps while the timeline glides,
// which is exactly what read as "phases moving independently of the
// individual job bars" (Karl's own report).
function allRowKeyedElements(): HTMLElement[] {
  const grid = document.getElementById('timelineGrid');
  const leftBody = document.getElementById('leftBody');
  const out: HTMLElement[] = [];
  if (grid) grid.querySelectorAll<HTMLElement>('[data-row-key]').forEach(function (el) { out.push(el); });
  if (leftBody) leftBody.querySelectorAll<HTMLElement>('[data-row-key]').forEach(function (el) { out.push(el); });
  return out;
}

function captureBarTopsByRowKey(): Record<string, number> {
  const tops: Record<string, number> = {};
  allRowKeyedElements().forEach(function (el) {
    const key = el.dataset.rowKey as string;
    tops[key] = el.getBoundingClientRect().top;
  });
  return tops;
}

// Called once the rebuild above has finished — every bar now sits at its
// FINAL row position. For any bar whose row key existed before AND whose
// top actually changed (a job/task reordering past another, per date
// changes, an expand/collapse, etc.), fake a "before" frame by offsetting
// it back to its old position via transform (cheap, GPU-only, doesn't
// re-trigger layout the way animating `top` itself would), then let it
// transition to transform:none — i.e. its real new position. A bar with
// no prior entry (brand new, or the very first render of this session,
// when oldTops is empty) just appears at its final spot, unanimated, same
// as before this existed.
// Single source of truth for how long a reorder move takes — read by both
// the transition set on each element below AND redrawConnectorLinesLive()'s
// own tracking loop, so the connector lines linking a multi-phase job's
// separate bars ("the full project bar", per Karl's own description) keep
// pace with the bars for exactly as long as they're actually moving,
// instead of one hardcoded number living in CSS and a second one here that
// could quietly drift apart. Slowed twice now on direct feedback that
// shorter durations still read as too quick even once every piece was
// moving in sync.
const GANTT_REORDER_MS = 1800;

function animateReorderedBars(oldTops: Record<string, number>, jobBarMap: Record<string, JobBarMapEntry[]>, gridWidth: number): void {
  if (!Object.keys(oldTops).length) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Pass 1 — READ ONLY. A row can draw many elements sharing one row key
  // (every day-segment/tick in a job-span row, easily a dozen-plus for a
  // month-long sub-unit — see rowKey's own comment), and a cascaded drag
  // (cascadeShiftLaterTasks()) can reorder several DIFFERENT rows in the
  // same render on top of that. Collect every element that actually needs
  // to animate here (across both #timelineGrid and #leftBody — see
  // allRowKeyedElements()'s own comment), without writing anything yet.
  const toAnimate: { el: HTMLElement; delta: number }[] = [];
  allRowKeyedElements().forEach(function (el) {
    const key = el.dataset.rowKey as string;
    const oldTop = oldTops[key];
    if (oldTop === undefined) return;
    // Freshly (re)created by the rebuild above, no transform applied yet
    // — this is its real resting position, directly comparable to
    // captureBarTopsByRowKey()'s own getBoundingClientRect()-based
    // measurement (same coordinate space, viewport-relative).
    const newTop = el.getBoundingClientRect().top;
    const delta = oldTop - newTop;
    if (Math.abs(delta) < 1) return;
    toAnimate.push({ el: el, delta: delta });
  });
  if (!toAnimate.length) return;

  // Pass 2 — WRITE ONLY (the "before" frame). Interleaving each element's
  // own read/write/read/write (as this first did) forces a separate
  // synchronous layout recalc PER ELEMENT — real, visible jank on any row
  // with more than a couple of pieces, and worse, it let different
  // elements' own requestAnimationFrame callbacks land on different actual
  // frames, which is exactly what read as "the job bar and task bars move
  // separately" (Karl's own report) — pieces of what should be one
  // reorder drifting out of sync with each other. Writing every element's
  // starting offset first, with no reads in between, then forcing exactly
  // ONE reflow for the whole batch below, keeps this to a single recalc
  // and guarantees every element commits its "before" frame at the same
  // instant.
  toAnimate.forEach(function (a) {
    a.el.style.transition = 'none';
    a.el.style.transform = 'translateY(' + a.delta + 'px)';
  });
  // ONE forced reflow for the whole batch — same reasoning as the
  // single-element version's own comment (an inline `transition: none`
  // has to be explicitly cleared afterward too, not just overridden by a
  // class, since an inline style always wins over a class's CSS rule
  // regardless of specificity), just amortized across every element here
  // instead of paid once per element. Reading it off body rather than a
  // specific container — the elements being animated now span two
  // separate containers (#timelineGrid and #leftBody, see
  // allRowKeyedElements()) — flushes layout for the whole page either way.
  void document.body.offsetHeight;

  // Pass 3 — WRITE ONLY. Sets the real transition (duration sourced from
  // GANTT_REORDER_MS above, not the .gantt-bar-reorder class — see its own
  // comment) and marks each element animating.
  toAnimate.forEach(function (a) {
    a.el.style.transition = 'transform ' + GANTT_REORDER_MS + 'ms ease-in-out, box-shadow 150ms ease, filter 150ms ease';
    a.el.classList.add('gantt-bar-reorder');
  });

  // ONE shared rAF for the whole batch, not one per element — everything
  // that needs to move starts moving on the exact same frame.
  requestAnimationFrame(function () {
    toAnimate.forEach(function (a) { a.el.style.transform = 'translateY(0)'; });
  });

  toAnimate.forEach(function (a) {
    const el = a.el;
    el.addEventListener('transitionend', function handler(e) {
      if (e.propertyName !== 'transform') return;
      el.removeEventListener('transitionend', handler);
      el.classList.remove('gantt-bar-reorder');
      el.style.transition = '';
      el.style.transform = '';
    });
  });

  // The line(s) connecting a multi-phase job's bars into one visible run
  // are otherwise drawn once, from the bars' FINAL positions, and then
  // just sit there for the whole GANTT_REORDER_MS while the bars they
  // connect glide past underneath — read as the connector not moving in
  // sync with its own job's phases (Karl's own report). Re-drawing it from
  // each bar's REAL current position on every frame for exactly as long as
  // the bars are actually moving keeps it visually attached to them
  // throughout, not just before and after.
  const grid = document.getElementById('timelineGrid');
  if (grid) {
    const start = performance.now();
    (function trackConnectors() {
      redrawConnectorLinesLive(jobBarMap, gridWidth, grid);
      if (performance.now() - start < GANTT_REORDER_MS) {
        requestAnimationFrame(trackConnectors);
      } else {
        // One final pass from the real, static (not live-measured) final
        // positions — removes any last-frame sub-pixel drift from reading
        // getBoundingClientRect() instead of the exact authored numbers.
        drawConnectorLines(gridWidth, jobBarMap, grid);
      }
    })();
  }
}

function renderGantt(): void {
  syncGanttJobFocusBanner();

  const oldBarTops = captureBarTopsByRowKey();

  const { grid, header, leftBody, totalDays, containerH, gridWidth, savedScrollLeft, savedScrollTop } = setupDateRangeAndGrid();
  const today = buildDateHeader(totalDays, grid, header);
  const { jobBarMap, visibleRows, gridHeightPx } = buildRowModel(containerH, grid);
  renderLeftPanelRows(visibleRows, grid, gridWidth, leftBody, gridHeightPx);
  drawTodayLine(grid, today, totalDays);
  renderTimelineBars(visibleRows, grid, jobBarMap);
  drawConnectorLines(gridWidth, jobBarMap, grid);
  restoreScrollPosition(savedScrollTop, savedScrollLeft);

  animateReorderedBars(oldBarTops, jobBarMap, gridWidth);
}

function scrollToToday(): void {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  computeDateRange();
  const todayIdx = getDaysDiff(startDate, today);
  const timelineBody = document.getElementById('timelineBody')!;

  if (todayIdx < 0 || todayIdx >= getDaysDiff(startDate, endDate) + 1) {
    showToast('Today is outside the project date range', 'info');
    return;
  }

  const targetLeft = Math.max(0, todayIdx * dayWidth - timelineBody.clientWidth / 2 + dayWidth / 2);
  timelineBody.scrollLeft = targetLeft;
}

// ===== GANTT PINCH-TO-ZOOM =====
// Mobile-only (see .gantt-zoom-btn's mobile hide rule, which removes the
// +/-/reset buttons there in favor of this) — desktop keeps the buttons
// since there's no pinch gesture available to a mouse. Two input paths
// land here: real multi-touch (phones/tablets —
// handleGanttTouchStart/Move/End below) and the wheel event a trackpad's
// pinch gesture synthesizes with ctrlKey set on both macOS and Windows
// precision touchpads (handleGanttWheelZoom), so a laptop trackpad pinch
// works the same way without an actual touchscreen — this one desktop
// input path stays even though the buttons came back, since a trackpad
// pinch is a strictly nicer way to zoom than clicking + repeatedly.
//
// The touch path deliberately does NOT call renderGantt() on every
// touchmove the way the first version of this did. A touch's move/end
// events are dispatched to whatever element was actually under the
// finger at touchstart (commonly a specific bar/cell inside
// #timelineGrid, not the container the listener is bound to) — the FIRST
// renderGantt() rebuilds that element's innerHTML and detaches the
// original node the browser is tracking the gesture against, and most
// mobile browsers simply stop delivering further touchmove/touchend for
// a touch once its original target is gone. In testing that showed up as
// "pinch does nothing": the very first frame silently broke the rest of
// the gesture. Fixed by keeping touchmove purely visual — a CSS
// scaleX() preview on #timelineGrid, which repaints without touching the
// DOM tree at all — and only running the real renderGantt() once, at
// touchend, after the gesture (and its original touch targets) is done
// mattering.
const GANTT_ZOOM_MIN = 14, GANTT_ZOOM_MAX = 80;
let ganttPinchStartDist: number | null = null;
let ganttPinchStartDayWidth: number | null = null;
let ganttPinchAnchorX: number | null = null;
let ganttPinchScale = 1;
let ganttZoomRafPending = false;
let ganttZoomPendingWidth: number | null = null;
let ganttZoomAnchorX: number | null = null;

function ganttTouchDist(touches: { clientX: number; clientY: number }[] | TouchList): number {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

// Shared commit path for both input methods: clamp, bail if it's a no-op,
// otherwise re-render at the new width and correct scrollLeft so whatever
// day was under the anchor point lands back under that same screen point
// instead of the zoom recentering on the timeline's left edge.
function setGanttDayWidthAnchored(newDayWidth: number, anchorClientX: number): void {
  const clamped = Math.max(GANTT_ZOOM_MIN, Math.min(GANTT_ZOOM_MAX, Math.round(newDayWidth)));
  if (clamped === dayWidth) return;
  const timelineBody = document.getElementById('timelineBody')!;
  const anchorOffset = anchorClientX - timelineBody.getBoundingClientRect().left;
  const dayPos = (timelineBody.scrollLeft + anchorOffset) / dayWidth;
  dayWidth = clamped;
  renderGantt();
  // renderGantt() ends by calling restoreScrollPosition(), which restores
  // the PRE-zoom scrollLeft but only on the next animation frame (see its
  // own comment) — asserting the anchored scrollLeft synchronously here
  // would just get clobbered a frame later, snapping back to the old
  // position (visibly "zooming toward the left edge" on a single click,
  // since there's no follow-up frame to mask it the way a continuous
  // wheel/pinch gesture's rapid re-zooms do). Scheduling this in its own
  // rAF — registered after renderGantt()'s already-pending one — runs it
  // afterward instead, so this is the value that actually sticks.
  requestAnimationFrame(function () {
    const newScrollLeft = dayPos * dayWidth - anchorOffset;
    timelineBody.scrollLeft = newScrollLeft;
    setHeaderScroll(newScrollLeft);
  });
}

// Wheel/trackpad path only — a wheel event has no persistent "original
// target" the way a touch sequence does (each tick just hits whatever's
// currently under the cursor), so re-rendering mid-gesture here doesn't
// have the touch path's problem. Still coalesced to at most one
// renderGantt() per animation frame purely for perf, since a trackpad
// can fire wheel ticks much faster than this chart can usefully re-render.
function requestGanttZoom(newDayWidth: number, anchorClientX: number): void {
  ganttZoomPendingWidth = newDayWidth;
  ganttZoomAnchorX = anchorClientX;
  if (ganttZoomRafPending) return;
  ganttZoomRafPending = true;
  requestAnimationFrame(function () {
    ganttZoomRafPending = false;
    setGanttDayWidthAnchored(ganttZoomPendingWidth!, ganttZoomAnchorX!);
  });
}

function handleGanttTouchStart(e: TouchEvent): void {
  if (e.touches.length === 2) {
    ganttPinchStartDist = ganttTouchDist(e.touches);
    ganttPinchStartDayWidth = dayWidth;
    ganttPinchAnchorX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    ganttPinchScale = 1;
    const grid = document.getElementById('timelineGrid');
    if (grid) {
      grid.style.transformOrigin = (ganttPinchAnchorX - grid.getBoundingClientRect().left) + 'px 0';
    }
  }
}
function handleGanttTouchMove(e: TouchEvent): void {
  if (e.touches.length !== 2 || ganttPinchStartDist == null || ganttPinchStartDayWidth == null) return;
  e.preventDefault();
  const rawScale = ganttTouchDist(e.touches) / ganttPinchStartDist;
  // Clamp the SCALE (not dayWidth, which doesn't change until touchend)
  // so the live preview can't stretch past what touchend would actually
  // commit to.
  ganttPinchScale = Math.max(GANTT_ZOOM_MIN / ganttPinchStartDayWidth, Math.min(GANTT_ZOOM_MAX / ganttPinchStartDayWidth, rawScale));
  const grid = document.getElementById('timelineGrid');
  if (grid) grid.style.transform = 'scaleX(' + ganttPinchScale + ')';
}
function handleGanttTouchEnd(e: TouchEvent): void {
  if (e.touches.length >= 2 || ganttPinchStartDist == null || ganttPinchStartDayWidth == null) return;
  const grid = document.getElementById('timelineGrid');
  if (grid) { grid.style.transform = ''; grid.style.transformOrigin = ''; }
  setGanttDayWidthAnchored(ganttPinchStartDayWidth * ganttPinchScale, ganttPinchAnchorX!);
  ganttPinchStartDist = null;
  ganttPinchStartDayWidth = null;
}
// ctrlKey is how both macOS and Windows report a trackpad pinch as a
// wheel event — a plain scroll wheel/two-finger-pan never sets it, so
// this leaves ordinary wheel scrolling of the timeline completely alone.
function handleGanttWheelZoom(e: WheelEvent): void {
  if (!e.ctrlKey) return;
  e.preventDefault();
  requestGanttZoom(dayWidth * Math.exp(-e.deltaY * 0.01), e.clientX);
}

// Desktop-only zoom buttons (see .gantt-zoom-btn) — anchored on the
// visible timeline viewport's own horizontal center (there's no cursor
// position to anchor on the way the wheel/pinch paths have one), reusing
// the same setGanttDayWidthAnchored() commit path so the day currently in
// the middle of the screen stays there instead of the zoom appearing to
// pull everything toward the left edge.
function zoomGanttCentered(newDayWidth: number): void {
  const timelineBody = document.getElementById('timelineBody')!;
  const rect = timelineBody.getBoundingClientRect();
  setGanttDayWidthAnchored(newDayWidth, rect.left + rect.width / 2);
}
function zoomIn(): void { zoomGanttCentered(dayWidth + 6); }
function zoomOut(): void { zoomGanttCentered(dayWidth - 6); }
function resetZoom(): void { zoomGanttCentered(34); }

function fitToView(): void {
  const containerWidth = document.getElementById('timelineBody')!.clientWidth - 20;
  computeDateRange();
  const totalDays = getDaysDiff(startDate, endDate) + 1;
  const fitted = Math.max(Math.floor(containerWidth / totalDays), 14);
  zoomGanttCentered(fitted);
}

// ===== GANTT: HEADER/BODY SCROLL SYNC =====
let isSyncingScroll = false;

// The single place that positions the date header horizontally — always
// via transform, never timelineHeaderWrap.scrollLeft (see the comment on
// .timeline-header). #timelineBody's own scrollLeft is the one source of
// truth for "how far scrolled right now."
function setHeaderScroll(px: number): void {
  const header = document.getElementById('timelineHeader');
  if (header) header.style.transform = 'translateX(-' + px + 'px)';
}

// Called from home.ts (whenever the Home dashboard's expanded Gantt
// widget switches to this tab) and from src/app/boot.ts's init(), in
// addition to this file's own renderGantt()/scrollToToday() — re-wiring
// on every call is deliberate (see below), so any of those callers is
// safe even if scroll sync is already set up.
function setupScrollSync(): void {
  const timelineBody = document.getElementById('timelineBody');
  const leftBody = document.getElementById('leftBody');

  if (!timelineBody || !leftBody) return;

  timelineBody.onscroll = function() {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    setHeaderScroll(timelineBody.scrollLeft);
    leftBody.scrollTop = timelineBody.scrollTop;
    isSyncingScroll = false;
  };

  leftBody.onscroll = function() {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    timelineBody.scrollTop = leftBody.scrollTop;
    isSyncingScroll = false;
  };

  // Pinch-to-zoom — bound on .gantt-panels-row (the date header row is a
  // SIBLING of timelineBody, not a descendant of it — see the
  // "right-panel" markup — so a pinch starting with either finger over
  // the header would never reach a listener scoped to timelineBody alone)
  // rather than just timelineBody itself, even though the zoom math
  // inside still targets timelineBody specifically (its own
  // getBoundingClientRect()/scrollLeft — touch clientX/Y are
  // viewport-relative regardless of which element the listener sits on,
  // so this doesn't need to change). Re-wired here since renderGantt()
  // rebuilds timelineBody's contents (though not the panels-row itself)
  // on every call; property assignment rather than addEventListener so
  // re-running this never stacks up duplicate listeners the way repeated
  // addEventListener calls would.
  const panelsRow = document.querySelector('.gantt-panels-row') as HTMLElement | null;
  if (panelsRow) {
    panelsRow.ontouchstart = handleGanttTouchStart;
    panelsRow.ontouchmove = handleGanttTouchMove;
    panelsRow.ontouchend = handleGanttTouchEnd;
  }
  timelineBody.onwheel = handleGanttWheelZoom;
}

// ===== Row builders shared with Calendar (src/views/calendar.ts consumes
// flattenJobs()/buildCalendarJobRows()/isCalendarJobSpanTaskId() as
// ambient globals — its own comment explains why: they're really this
// file's own task-clustering logic reused there, not Calendar-specific,
// so this is their real home despite Calendar being the only render
// surface for some of them) =====

// A job's due date (card.due) isn't a task — it doesn't live in job.tasks
// and Job Manager never shows it as one — but it still needs to appear on
// the Gantt/Calendar and be draggable like a task bar. This synthesizes a
// single-day pseudo-task at render time (start === finish naturally gets
// the app's existing "milestone" single-day styling) that the Gantt/
// Calendar drag handlers special-case by id instead of writing through
// findTask()/job.tasks.
const DUE_MARKER_TASK_ID = '__due__';
function getJobDueMarkerTask(job: Job, phaseId: string | null): GanttTask | null {
  const card = getPhaseCard(job, phaseId);
  if (!card || !card.due) return null;
  if (isNaN(new Date(card.due + 'T00:00:00').getTime())) return null;
  return { id: DUE_MARKER_TASK_ID, name: 'Due Date', start: card.due, finish: card.due, notes: '', color: job.color, order: -1, isDueMarker: true };
}

// Shared job -> phase -> sub-unit walk behind flattenJobs() (Gantt Tasks
// view) and buildCalendarJobRows() (Calendar) — the genuinely-matching
// pair. Skips archived jobs, folds in linked reference jobs the same way
// both callers already did, visits every phase then every sub-unit within
// it (including the synthetic single-entry wrap an unphased job/phase
// gets from getJobPhases()/getPhaseSubUnits()), and appends that phase's
// one due-marker row on the FIRST sub-unit only — there's no per-sub-phase
// card to carry a second one, so it must never be duplicated across every
// sub-phase.
// subUnitCallback(job, jobIdx, phase, phaseName, subUnit, subIdx,
// subPhaseName) does each caller's own per-sub-unit row shaping;
// dueRowBuilder(...) builds that caller's own due-marker row shape (only
// called when a due task actually exists).
//
// buildVisibleTaskRows() (this file's own collapse-aware nested helper,
// inside renderGantt()) is deliberately NOT built on this — it's tightly
// coupled to Gantt-only collapse state (collapsedPhaseIds/
// tasksExpandedPhaseIds/tasksExpandedSubPhaseIds/ganttFocusedJobId) and
// produces a genuinely different row shape (collapse-aware synthetic
// phase/sub-phase rows). Forcing it through this walker would mean
// threading Gantt-specific collapse logic into code the other two
// callers don't need — worse for long-term readability than the current
// split, not better.
function forEachVisibleSubUnit(
  jobsArr: Job[],
  subUnitCallback: (job: any, jobIdx: number, phase: Phase, phaseName: string | null, subUnit: SubPhase, subIdx: number, subPhaseName: string | null) => void,
  dueRowBuilder: (job: any, jobIdx: number, phase: Phase, phaseName: string | null, subUnit: SubPhase, subPhaseName: string | null, dueTask: GanttTask) => void
): void {
  const combined = (jobsArr || []).concat(getLinkedReferenceJobs() as Job[]);
  combined.forEach(function (job: any, jobIdx: number) {
    if (job.archived) return;
    getJobPhases(job).forEach(function (phase) {
      const phaseName = phase.isDefault ? null : phase.name;
      getPhaseSubUnits(phase).forEach(function (subUnit, subIdx) {
        const subPhaseName = subUnit.isDefault ? null : subUnit.name;
        subUnitCallback(job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName);
        if (!job.isLinkedReference && subIdx === 0) {
          const dueTask = getJobDueMarkerTask(job, phase.id);
          if (dueTask) dueRowBuilder(job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask);
        }
      });
    });
  });
}

function flattenJobs(jobsArr: Job[]): any[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: any[] = [];
  forEachVisibleSubUnit(jobsArr, function (job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName) {
    (subUnit.tasks || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    (subUnit.tasks || []).forEach(function (task, taskIdx) {
      if (hiddenOrders.has(task.order as number)) return;
      rows.push({ job: job, jobIdx: jobIdx, task: task, taskIdx: taskIdx, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
    });
  }, function (job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask) {
    rows.push({ job: job, jobIdx: jobIdx, task: dueTask, taskIdx: -1, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
  });
  return rows;
}

// ===== CALENDAR: COLLAPSED JOB ROWS =====
// Calendar's own version of flattenJobs() — a job's sub-units start
// CONDENSED into one bar each (spanning that sub-unit's own min-start/
// max-finish) instead of one bar per task, using the exact same
// tasksExpandedSubPhaseIds Set the Gantt's Tasks view already maintains
// (see toggleTasksSubPhaseExpanded()) — expanding a sub-phase in either
// view shows it expanded in both, since it's the same shared state, not
// a separate Calendar-only copy.
//
// Deliberately simpler than the Gantt's two-level collapse (a whole
// phase folds into one bar across all its sub-phases, and each
// sub-phase separately folds into one bar across its own tasks): here,
// a real sub-phase always gets its own bar rather than also being
// foldable together with its siblings into one bar — a calendar shows
// literal dates on a grid, and merging unrelated sub-phases' date
// ranges into a single bar read as more confusing than useful for that,
// unlike the Gantt's zoomable timeline where it's a genuine space-saver.
// A phase-less/sub-phase-less job (the common case) still gets exactly
// one collapsible bar per phase, via getPhaseSubUnits()'s synthetic
// single-entry wrap — same as flattenJobs().
function getHiddenTaskOrders(): Set<number> {
  const hidden = new Set<number>();
  BOARD_COLUMNS.forEach(function (c, i) { if (c.hideFromSchedule) hidden.add(i); });
  return hidden;
}
// Groups a collapsed sub-phase's tasks into "clusters" — a cluster is a
// maximal run of days with no missing day anywhere inside it (tasks
// touching or overlapping stay one cluster; an actual scheduling gap
// starts a new one). Within a cluster, day-bucketed sub-segments still
// track exactly which task(s) cover each stretch (mirroring the Gantt
// Tasks view's own collapsed-sub-phase day-sweep, renderGantt()'s
// job-span drawing pass) so an overlap still reads as a hatch and a
// hand-off between two tasks still reads as two different colors — but
// that's rendered as ONE bordered bar per cluster (buildCalBarHtml's
// nested inner blocks), not a separate bar for the overlap itself. A
// real gap gets no bar at all over those days. Per the user: don't
// connect a bar across an unscheduled day, but don't fragment a
// genuinely-connected (touching/overlapping) run into multiple bars
// either.
function buildSubUnitClusters(job: any, subUnit: SubPhase, hiddenOrders: Set<number>): any[] {
  const dated = (subUnit.tasks || []).filter(function (task) {
    if (hiddenOrders.has(task.order as number)) return false;
    if (!task.start || !task.finish) return false;
    const s = new Date(task.start + 'T00:00:00'), f = new Date(task.finish + 'T00:00:00');
    return !isNaN(s.getTime()) && !isNaN(f.getTime());
  }).map(function (task) {
    return { task: task, start: new Date(task.start + 'T00:00:00'), finish: new Date(task.finish + 'T00:00:00') };
  });
  if (!dated.length) return [];
  let minStart = dated[0].start, maxFinish = dated[0].finish;
  dated.forEach(function (dt) {
    if (dt.start < minStart) minStart = dt.start;
    if (dt.finish > maxFinish) maxFinish = dt.finish;
  });
  const totalDays = getDaysDiff(minStart, maxFinish) + 1;
  const dayTasks: GanttTask[][] = [];
  for (let i = 0; i < totalDays; i++) dayTasks.push([]);
  dated.forEach(function (dt) {
    const sIdx = getDaysDiff(minStart, dt.start), eIdx = getDaysDiff(minStart, dt.finish);
    for (let d = Math.max(0, sIdx); d <= Math.min(totalDays - 1, eIdx); d++) dayTasks[d].push(dt.task);
  });
  const fineSegments: any[] = [];
  let di = 0;
  while (di < totalDays) {
    const covering = dayTasks[di];
    const key = covering.map(function (t) { return t.id; }).sort().join('|');
    let dj = di;
    while (dj + 1 < totalDays && dayTasks[dj + 1].map(function (t) { return t.id; }).sort().join('|') === key) dj++;
    if (covering.length > 0) {
      fineSegments.push({
        startOffset: di, endOffset: dj,
        // taskCount is the real "is this an overlap" signal — colors is
        // deduped, so two overlapping tasks that both happen to be
        // job-colored (the common case — see normalizeTasksToColumns())
        // would otherwise collapse to a single color and look identical
        // to a plain one-task segment, silently losing the overlap.
        taskCount: covering.length,
        colors: Array.from(new Set(covering.map(function (t) { return t.color || job.color || '#3949ab'; }))),
      });
    }
    di = dj + 1;
  }
  // Merge fine segments into clusters wherever there's no day-gap between
  // them (adjacent fine segments always represent a hand-off between
  // different covering-task-sets, but that alone isn't a gap — only a
  // missing offset between them is).
  const clusters: any[] = [];
  fineSegments.forEach(function (seg) {
    const last = clusters[clusters.length - 1];
    if (last && seg.startOffset === last.endOffset + 1) {
      last.endOffset = seg.endOffset;
      last.segs.push(seg);
    } else {
      clusters.push({ startOffset: seg.startOffset, endOffset: seg.endOffset, segs: [seg] });
    }
  });
  return clusters.map(function (c) {
    const start = new Date(minStart); start.setDate(start.getDate() + c.startOffset);
    const finish = new Date(minStart); finish.setDate(finish.getDate() + c.endOffset);
    return {
      start: start, finish: finish,
      // Re-based to the CLUSTER's own start (not the whole sub-phase's) —
      // buildCalBarHtml positions these relative to the bar it's building,
      // which is now exactly this cluster.
      segments: c.segs.map(function (s: any) {
        return { startOffset: s.startOffset - c.startOffset, endOffset: s.endOffset - c.startOffset, taskCount: s.taskCount, colors: s.colors };
      }),
    };
  });
}
const CALENDAR_JOB_SPAN_TASK_PREFIX = 'calspan|';
function isCalendarJobSpanTaskId(taskId: unknown): boolean {
  return typeof taskId === 'string' && taskId.indexOf(CALENDAR_JOB_SPAN_TASK_PREFIX) === 0;
}
// Condenses a sub-phase's tasks into one bar per cluster
// (buildSubUnitClusters) — unlike the Gantt's own Tasks view, the
// Calendar never offers expanding back out to individual task bars
// (deliberately no chevron/toggle here), and unlike the Gantt's own
// collapsed-row look, a real scheduling gap between two of a sub-phase's
// tasks gets no bar at all instead of one continuous bar painted
// straight through it.
function buildCalendarJobRows(jobsArr: Job[]): any[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: any[] = [];
  forEachVisibleSubUnit(jobsArr, function (job, jobIdx, phase, phaseName, subUnit, subIdx, subPhaseName) {
    const clusters = buildSubUnitClusters(job, subUnit, hiddenOrders);
    const namePart = (phaseName ? ' — ' + phaseName : '') + (subPhaseName ? ' — ' + subPhaseName : '');
    clusters.forEach(function (cluster, clusterIdx) {
      const single = cluster.segments.length === 1 ? cluster.segments[0] : null;
      const pseudoTask = {
        id: CALENDAR_JOB_SPAN_TASK_PREFIX + job.id + '|' + (phase.id || '') + '|' + (subUnit.id || '') + '|' + clusterIdx,
        name: job.name + namePart,
        start: toIsoDate(cluster.start), finish: toIsoDate(cluster.finish),
        notes: '', color: (single && single.taskCount === 1) ? single.colors[0] : job.color, order: 0, isJobSpan: true,
        clusterSegments: cluster.segments,
      };
      rows.push({ job: job, task: pseudoTask, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
    });
  }, function (job, jobIdx, phase, phaseName, subUnit, subPhaseName, dueTask) {
    rows.push({ job: job, task: dueTask, phaseId: phase.id, phaseName: phaseName, subPhaseId: subUnit.id, subPhaseName: subPhaseName });
  });
  return rows;
}

export {
  cascadeShiftLaterTasks,
  startBarResizeRight,
  startBarResizeLeft,
  onBarResizeMove,
  applyBarResizeMove,
  onBarResizeEnd,
  startTickResize,
  onTickResizeMove,
  applyTickResizeMove,
  onTickResizeEnd,
  startBarMove,
  onBarMoveMove,
  applyBarMoveMove,
  onBarMoveEnd,
  buildVisibleTaskRows,
  renderGantt,
  scrollToToday,
  ganttTouchDist,
  setGanttDayWidthAnchored,
  requestGanttZoom,
  handleGanttTouchStart,
  handleGanttTouchMove,
  handleGanttTouchEnd,
  handleGanttWheelZoom,
  zoomGanttCentered,
  zoomIn,
  zoomOut,
  resetZoom,
  fitToView,
  setHeaderScroll,
  setupScrollSync,
  togglePhaseCollapse,
  getSubUnitKey,
  toggleTasksPhaseExpanded,
  toggleTasksSubPhaseExpanded,
  expandAllGantt,
  collapseAllGantt,
  toggleGanttJobFocus,
  clearGanttJobFocus,
  syncGanttJobFocusBanner,
  buildPhaseSubTags,
  computeDateRange,
  showDatePopover,
  hideDatePopover,
  showTooltip,
  DUE_MARKER_TASK_ID,
  getJobDueMarkerTask,
  forEachVisibleSubUnit,
  flattenJobs,
  getHiddenTaskOrders,
  buildSubUnitClusters,
  isCalendarJobSpanTaskId,
  buildCalendarJobRows,
};
