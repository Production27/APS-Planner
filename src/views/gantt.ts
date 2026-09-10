// Gantt, moved out of index.html starting with Phase 6 of the
// architecture roadmap. Gantt was deliberately tackled LAST of the three
// main views (after Board and Calendar) because its drag/resize/zoom
// mechanics are the most timing-sensitive code in the app — the same
// reason its own touch/pinch-zoom gestures are deferred within this
// phase too (see below).
//
//   Phase 6a — the bar/tick drag-and-resize mechanics (initial content):
//     cascadeShiftLaterTasks/startBarResizeRight/startBarResizeLeft/
//     onBarResizeMove/applyBarResizeMove/onBarResizeEnd/startTickResize/
//     onTickResizeMove/applyTickResizeMove/onTickResizeEnd/startBarMove/
//     onBarMoveMove/applyBarMoveMove/onBarMoveEnd. Chosen as the first
//     slice because it already had real test coverage (the "gantt drag"
//     test from Phase 1a covers the plain bar-move path) — same
//     reasoning Board's Phase 4a used to pick its own first slice. Two
//     new dedicated tests (bar resize, job-span move) cover the paths
//     that test didn't, each confirmed via break-then-restore.
//   Phase 6b — the visible-row builder: byStartDate/getPhaseSegments/
//     buildSegment/buildPhaseCollapsedRow/buildSubPhaseRow/
//     buildVisibleTaskRows. This was originally a cluster of nested
//     closures INSIDE renderGantt() itself (see that function's own "10
//     phases... purely for readability" comment) with exactly one
//     external call site (`visibleRows = buildVisibleTaskRows();`) —
//     confirmed by grepping renderGantt()'s entire body before moving
//     anything, the same "survey before cutting" discipline every prior
//     phase used. Pure data transformation (jobs/phases/tasks in, a flat
//     row list out) with zero DOM reads or writes, so — unlike the DOM-
//     drawing code that consumes its output — it's directly unit-
//     testable against the blank fixture, same as Calendar's recurrence
//     logic (Phase 5a).
//
//   Phase 6c — renderGantt() itself: the actual DOM-building "10 phases"
//     (setupDateRangeAndGrid/buildDateHeader/buildRowModel/
//     renderLeftPanelRows/drawTodayLine/renderTimelineBars/
//     drawConnectorLines/restoreScrollPosition) that consume
//     buildVisibleTaskRows()'s output — Gantt's own renderBoard()/
//     renderMonthCalendar() equivalent, and by far the densest single
//     function in the whole app (~800 lines). Moved as ONE atomic unit,
//     nested-closure structure and all, deliberately NOT restructured
//     into individually-exported functions with explicit parameter-
//     passing — the 8 sub-phases share ~11 pieces of mutable state
//     (grid/header/leftBody/totalDays/gridWidth/visibleRows/jobBarMap/
//     etc.) purely through JS closure, by the ORIGINAL author's own
//     deliberate choice (see that comment, preserved below) specifically
//     to avoid threading 11 values through parameters by hand. Splitting
//     it now into separately-testable pieces would mean redesigning that
//     shared-state shape — real, warranted refactoring work, but a
//     different task than "move this view's code into its own file,"
//     and one this move deliberately does NOT take on: every other phase
//     in this whole roadmap has been a verbatim port with types layered
//     on top, not an opportunistic internal redesign, and this is no
//     exception. A future session can revisit splitting renderGantt()
//     itself once there's a concrete reason to (e.g. real per-phase test
//     coverage that needs it) rather than as a side effect of relocation.
//
// The touch/pinch-zoom gesture cluster is deliberately still NOT part of
// this move (see below) — renderGantt() itself never mutates task data,
// it only draws what buildVisibleTaskRows() already decided to show.
//
// The touch/pinch-zoom gesture cluster (ganttTouchDist/
// setGanttDayWidthAnchored/requestGanttZoom/handleGanttTouchStart/Move/
// End/handleGanttWheelZoom/zoomGanttCentered/zoomIn/zoomOut/resetZoom/
// fitToView/scrollToToday) is deliberately NOT part of this move either
// — it never mutates task data (worst case of a bug there is a glitchy
// zoom, not corrupted dates), and is the same category of hard-to-
// meaningfully-unit-test gesture code as Calendar's own swipe/wheel
// navigation cluster (see src/views/calendar.ts's header comment) —
// left to pair with that whenever either gets tackled.
//
// showTooltip()/moveTooltip()/hideTooltip()/showDatePopover()/
// hideDatePopover()/buildColorPresets()/updateJobColorSwatch()/
// toggleJobColorPanel() also stay in index.html for now (small, shared
// popover/tooltip chrome — not drag mechanics) and are referenced below
// as ambient globals, same as calendar.ts already does for
// moveTooltip()/hideTooltip() specifically.
import type { Job, Phase, SubPhase, Task, BoardColumn } from '../core/types';
import { toIsoDate, getDaysDiff } from '../utils/date';
import { escapeHtml } from '../utils/html';
import { darkenColor, softenColor } from '../utils/color';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard } from '../core/models';

declare global {
  // eslint-disable-next-line no-var
  var dayWidth: number;
  // eslint-disable-next-line no-var
  var barResizeState: BarResizeState | null;
  // eslint-disable-next-line no-var
  var tickResizeState: TickResizeState | null;
  // eslint-disable-next-line no-var
  var barMoveState: BarMoveState | null;
  // eslint-disable-next-line no-var
  var BOARD_COLUMNS: BoardColumn[];
  // eslint-disable-next-line no-var
  var DUE_MARKER_TASK_ID: string;
  function hasMinTier(tier: string): boolean;
  function saveJobs(): void;
  function logActivity(text: string): void;
  function showToast(text: string, kind?: string): void;
  function renderJobList(): void;
  function renderBoard(): void;
  function refreshJobFormIfOpen(jobId: string): void;
  // Shared verbatim with src/views/calendar.ts's identical ambient
  // declaration for this same index.html function — TypeScript's global
  // declaration merging requires every re-declaration of one ambient
  // global to be structurally identical, not just compatible, so this
  // anonymous shape (rather than either file's own CalJob/GanttJob
  // pseudo-types) is the deliberate common denominator both call sites
  // satisfy.
  function getJobDueMarkerTask(job: { id: string; name: string; [key: string]: unknown }, phaseId: string | null): { id: string; name: string; start?: string; finish?: string; [key: string]: unknown } | null;
  function moveTooltip(e: MouseEvent): void;
  function hideTooltip(): void;
  function getVisibleJobs(): Job[];
  function getLinkedReferenceJobs(): Job[];
  function getHiddenTaskOrders(): Set<number>;
  function getSubUnitKey(job: Job, phaseId: string | null, subPhaseId: string | null): string;
  // eslint-disable-next-line no-var
  var tasksExpandedPhaseIds: Set<string>;
  // eslint-disable-next-line no-var
  var tasksExpandedSubPhaseIds: Set<string>;
  // eslint-disable-next-line no-var
  var ganttFocusedJobId: string | null;
  // eslint-disable-next-line no-var
  var startDate: Date;
  // eslint-disable-next-line no-var
  var endDate: Date;
  // eslint-disable-next-line no-var
  var collapsedPhaseIds: Set<string>;
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
  function computeDateRange(): void;
  function syncGanttJobFocusBanner(): void;
  function showDatePopover(e: MouseEvent, date: Date): void;
  function hideDatePopover(): void;
  function editJob(jobId: string, phaseId?: string | null, subPhaseId?: string | null): void;
  function jumpToLinkedJobReference(job: Job): void;
  function toggleGanttJobFocus(jobId: string): void;
  function togglePhaseCollapse(phaseId: string | null): void;
  function toggleTasksPhaseExpanded(phaseId: string | null): void;
  function toggleTasksSubPhaseExpanded(key: string): void;
  function buildPhaseSubTags(job: Job, phaseId: string | null, phaseName: string | null, subPhaseId: string | null, subPhaseName: string | null, phaseFoldable: boolean, excludeSubTag: boolean): HTMLElement[];
  function showTooltip(e: MouseEvent, job: Job, task: GanttTask): void;
  function setHeaderScroll(px: number): void;
  function setupScrollSync(): void;
  function scrollToToday(): void;
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

// rAF-coalesced the same way requestGanttZoom() is (see the GANTT
// PINCH-TO-ZOOM block, still in index.html) — a raw mousemove can fire far
// more often than this can usefully repaint, and every tick was doing a
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
// tasksExpandedSubPhaseIds above toggleTasksPhaseExpanded()/
// toggleTasksSubPhaseExpanded(), both still in index.html) peels it open
// independently of every other phase/sub-phase.
function buildVisibleTaskRows(): GanttRow[] {
  const hiddenOrders = getHiddenTaskOrders();
  const rows: GanttRow[] = [];
  getVisibleJobs().concat(getLinkedReferenceJobs()).forEach((job) => {
    if (job.archived) return;
    // See ganttFocusedJobId/toggleGanttJobFocus() (both still in
    // index.html) — isolates the chart to one job's rows when set, Tasks
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
// Ported verbatim (see this file's header comment for why) — same 8
// nested "phases" for the same closures-over-shared-state reasons the
// original author chose, same execution order, same behavior.

interface JobBarMapEntry {
  left: number;
  width: number;
  top: number;
  bar: HTMLElement;
  jobColor?: string;
}

function renderGantt(): void {
  syncGanttJobFocusBanner();

  // The 10 phases below are split into named nested functions purely for
  // readability — same closures, same shared-variable access, same
  // execution order as one long function body, zero behavior change.
  // Everything a later phase needs from an earlier one is declared here
  // (not deeper) so each phase function can just assign into it, instead
  // of ~11 values needing to be threaded through parameters/return
  // values by hand.
  let grid: HTMLElement, header: HTMLElement, leftBody: HTMLElement, totalDays: number, containerH: number,
    gridWidth: number, gridHeightPx: number, savedScrollLeft: number, savedScrollTop: number, today: Date,
    visibleRows: GanttRow[], jobBarMap: Record<string, JobBarMapEntry[]>;

  function setupDateRangeAndGrid(): void {
    computeDateRange();
    totalDays = getDaysDiff(startDate, endDate) + 1;
    const containerW = document.getElementById('timelineBody')!.clientWidth;
    containerH = document.getElementById('timelineBody')!.clientHeight;
    gridWidth = Math.max(totalDays * dayWidth, containerW);
    grid = document.getElementById('timelineGrid')!;
    header = document.getElementById('timelineHeader')!;
    leftBody = document.getElementById('leftBody')!;

    // timelineBody's own scrollLeft is the source of truth for horizontal
    // position now — the header is positioned via transform, driven from
    // it (see setHeaderScroll()), not independently scrolled itself.
    const savedScrollTb = document.getElementById('timelineBody');
    savedScrollLeft = savedScrollTb ? savedScrollTb.scrollLeft : 0;
    savedScrollTop = savedScrollTb ? savedScrollTb.scrollTop : 0;

    grid.style.width = gridWidth + 'px';
    header.style.width = gridWidth + 'px';
    grid.innerHTML = '';
    header.innerHTML = '';
    leftBody.innerHTML = '';
  }

  function buildDateHeader(): void {
    today = new Date();
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
      // specific header was built for. Real bug, caught when this file
      // was first ported here (Phase 6c) — fixed on Karl's go-ahead.
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
  }

  function buildRowModel(): void {
    jobBarMap = {};
    visibleRows = buildVisibleTaskRows();

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
    gridHeightPx = Math.max(containerH, (visibleRows.length + GANTT_EXTRA_ROWS_BELOW) * GANTT_ROW_H);
    grid.style.height = gridHeightPx + 'px';
  }

  // visibleRowIdx here and barVisibleIdx in renderTimelineBars() below
  // MUST stay in lockstep: both loops walk the identical visibleRows
  // array, unconditionally, once — that's the only reason a left-panel
  // row's Y-position and its timeline bar's Y-position (computed from
  // two separately-incrementing counters) stay aligned. If either loop
  // ever gains a mid-loop skip/continue, the other must get the same one.
  function renderLeftPanelRows(): void {
    let visibleRowIdx = 0;
    visibleRows.forEach(function (entry) {
      const job = entry.job, task = entry.task, phaseId = entry.phaseId, phaseName = entry.phaseName, subPhaseId = entry.subPhaseId, subPhaseName = entry.subPhaseName;
      // "Sub-Phase (Phase)" when both exist, otherwise whichever one does —
      // same truncation-survives-because-it's-first treatment as phaseName
      // alone got, just one level deeper.
      const phaseLabel = subPhaseName ? (subPhaseName + (phaseName ? ' (' + phaseName + ')' : '')) : phaseName;
      {
        const bg = document.createElement('div');
        bg.className = 'row-bg';
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
        row.addEventListener('click', () => { if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId); });
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

  function drawTodayLine(): void {
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
  function renderTimelineBars(): void {
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
        const bar = document.createElement('div');
        bar.className = 'task-bar' + (isTaskFinished(job, task) ? ' finished' : '') + (task.isDueMarker ? ' due-marker-bar' : '');
        bar.dataset.dragged = 'false';
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
            if (job.isLinkedReference) {
              dueEl.classList.add('linked-ref');
              dueEl.addEventListener('click', function () { jumpToLinkedJobReference(job); });
            } else {
              dueEl.addEventListener('mousedown', function (e) { startBarMove(e, job.id, DUE_MARKER_TASK_ID, dueEl, false, phaseId); });
              dueEl.addEventListener('click', function () {
                if (dueEl.dataset.dragged === 'true') { dueEl.dataset.dragged = 'false'; return; }
                editJob(job.id, phaseId);
              });
            }
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
        bar.addEventListener('click', () => {
          if (bar.dataset.dragged === 'true') { bar.dataset.dragged = 'false'; return; }
          if (job.isLinkedReference) jumpToLinkedJobReference(job); else editJob(job.id, phaseId, subPhaseId);
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
              solid.dataset.origLeft = String(segLeft);
              solid.style.left = segLeft + 'px';
              solid.style.width = segWidth + 'px';
              solid.style.top = segTop;
              solid.style.background = softenColor((dt.t.color as string | undefined) || job.color || '#3949ab');
              solid.title = dt.t.name;
              solid.addEventListener('mouseenter', function (e) { showTooltip(e, job, dt.t); });
              solid.addEventListener('mouseleave', hideTooltip);
              solid.addEventListener('mousemove', moveTooltip);
              if (isCollapsedRow) {
                solid.addEventListener('mousedown', function (e) { startBarMove(e, job.id, dt.t.id!, solid, true, phaseId, dt.t.subPhaseId as string | null); });
                solid.addEventListener('click', function () {
                  if (solid.dataset.dragged === 'true') { solid.dataset.dragged = 'false'; return; }
                  editJob(job.id, phaseId, dt.t.subPhaseId as string | null);
                });
              } else {
                solid.addEventListener('mousedown', function (e) { startBarMove(e, job.id, dt.t.id!, solid); });
                solid.addEventListener('click', function () {
                  if (solid.dataset.dragged === 'true') { solid.dataset.dragged = 'false'; return; }
                  editJob(job.id, phaseId, subPhaseId);
                });
              }
              grid.appendChild(solid);
            } else {
              const hatch = document.createElement('div');
              hatch.className = 'job-span-task-hatch';
              hatch.dataset.jobId = job.id;
              hatch.dataset.phaseId = phaseId || '';
              hatch.dataset.subPhaseId = isCollapsedRow ? '' : (subPhaseId || '');
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

  function drawConnectorLines(): void {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
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

  function restoreScrollPosition(): void {
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

  setupDateRangeAndGrid();
  buildDateHeader();
  buildRowModel();
  renderLeftPanelRows();
  drawTodayLine();
  renderTimelineBars();
  drawConnectorLines();
  restoreScrollPosition();
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
};
