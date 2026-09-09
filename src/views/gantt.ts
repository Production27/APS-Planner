// Gantt, moved out of index.html starting with Phase 6 of the
// architecture roadmap. Gantt was deliberately tackled LAST of the three
// main views (after Board and Calendar) because its drag/resize/zoom
// mechanics are the most timing-sensitive code in the app — the same
// reason its own touch/pinch-zoom gestures are deferred within this
// phase too (see below).
//
//   Phase 6a — the bar/tick drag-and-resize mechanics (this file's
//     initial content): cascadeShiftLaterTasks/startBarResizeRight/
//     startBarResizeLeft/onBarResizeMove/applyBarResizeMove/
//     onBarResizeEnd/startTickResize/onTickResizeMove/
//     applyTickResizeMove/onTickResizeEnd/startBarMove/onBarMoveMove/
//     applyBarMoveMove/onBarMoveEnd. Chosen as the first slice because
//     it already had real test coverage (the "gantt drag" test from
//     Phase 1a covers the plain bar-move path) — same reasoning Board's
//     Phase 4a used to pick its own first slice. Two new dedicated
//     tests (bar resize, job-span move) cover the paths that test
//     didn't, each confirmed via break-then-restore.
//
// renderGantt() itself (the actual DOM-building — Gantt's own
// renderBoard()/renderMonthCalendar() equivalent, and by far the
// densest single function in the whole app) is NOT part of this move —
// deliberately deferred to its own later, separately-scoped phase, same
// narrowing judgment applied to Board's renderBoard()/buildCardEl() and
// Calendar's render engine before their own turns came up.
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
import type { Job, BoardColumn } from '../core/types';
import { toIsoDate, getDaysDiff } from '../utils/date';
import { escapeHtml } from '../utils/html';
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
  function renderGantt(): void;
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
}

// Deliberately loose local types (mirrors src/views/calendar.ts's own
// CalJob/CalTask): `task` here can be a REAL task from findTask(), a due-
// date marker synthesized by getJobDueMarkerTask(), or — for a job-span
// drag — a throwaway synthetic {name, start, finish} spanning every dated
// task in a sub-unit, recomputed fresh at drag start (see startBarMove()).
interface GanttJob {
  id: string;
  name: string;
  [key: string]: unknown;
}

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
};
