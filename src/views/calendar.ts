// Calendar view: recurrence-expansion / event-visibility logic (pure, no
// DOM dependency), the calendar-event modal (openAddCalendarEvent and
// friends), view navigation and the render dispatcher (setCalendarView/
// calendarPrev/calendarNext/calendarToday/calendarExitDayView/
// renderCalendar), the render engine (buildCalBarHtml()/
// renderMonthCalendar()/renderWeekCalendar()/renderWeekHourGrid()/
// calendarOpenJob()/getScheduledItemsForDate()/openDayView()/
// renderDayCalendarView()), the bar-drag-to-reschedule logic
// (handleCalBarMouseDown/Move/Up, applyCalBarMouseMove — the
// data-mutating half of the drag/gesture cluster, since dragging a bar
// actually changes a task's or calendar event's dates), and the
// purely-visual swipe/wheel navigation gesture cluster
// (initCalendarDragHandlers/calSwipeTargets/handleCalSwipeStart/Move/
// End/slideCalendarTargets/animateCalendarWheelChange/handleCalWheel —
// never mutates data, worst case of a bug here is a glitchy animation).
//
// buildCalendarJobRows()/isCalendarJobSpanTaskId() are deliberately NOT
// part of this file despite living right next to functions that are —
// they depend on getHiddenTaskOrders()/forEachVisibleSubUnit()/
// buildSubUnitClusters(), which are really Gantt's own task-clustering
// logic reused here, not Calendar-specific. Declared as ambient globals
// below since this file's render functions call them directly.
//
// getEffectiveRole()/getStoredUsername()/openModal()/closeModal()/
// ensureUserRosterLoaded()/saveCalendarEvents()/showToast()/logActivity()/
// hasMinTier()/deleteCalendarEventFromShared()/msDropdownLabelText()/
// getVisibleJobs()/flattenJobs()/buildCalendarJobRows()/isTaskFinished()/
// isDarkColor()/editJob() stay in index.html on purpose (session/role
// plumbing, modal-chrome plumbing shared by every modal in the app, the
// Gantt-clustering-coupled row builder noted above, or genuinely separate
// concerns like Job Manager's own edit-drawer) and are referenced below
// as ambient globals — an ordinary top-level `function` declaration
// already attaches to `window` on its own (unlike `let`/`const`), so
// nothing about those needed to change.
import type { CalendarEvent, CalendarEventOccurrence, Job } from '../core/types';
import { addMonths, toIsoDate, formatTimeLabel, timeToMinutes, getDaysDiff } from '../utils/date';
import { genId } from '../utils/id';
import { escapeHtml } from '../utils/html';
import { darkenColor, softenColor } from '../utils/color';
import { findJob, findTask, getPhaseCard } from '../core/models';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS-style shared state, saveJobs()-style shared functions,
// etc.) are declared once in src/shared-globals.d.ts, not repeated here.
declare global {
  // eslint-disable-next-line no-var
  var calendarEvents: CalendarEvent[];
  // eslint-disable-next-line no-var
  var editingCalendarEventId: string | null;
  // eslint-disable-next-line no-var
  var calendarEventTargetDate: string | null;
  // eslint-disable-next-line no-var
  var calendarViewDate: Date;
  // eslint-disable-next-line no-var
  var calDragState: CalDragState | null;
  function saveCalendarEvents(): void;
  function deleteCalendarEventFromShared(projectId: string | null, eventId: string): void;
  // getVisibleJobs/buildCalendarJobRows/isTaskFinished/editJob/
  // getLinkedReferenceJobs/jumpToLinkedJobReference are declared here
  // (rather than in shared-globals.d.ts) because this file types them
  // with its own CalJob/CalRow/CalTask shapes — src/views/gantt.ts
  // declares the same index.html functions with its own, differently
  // named types. TypeScript allows an ambient `function` (unlike `var`)
  // to be re-declared with a different signature per file — each file
  // gets its own narrower view of the same real function.
  function getVisibleJobs(): CalJob[];
  function flattenJobs(jobsArr: CalJob[]): CalRow[];
  function buildCalendarJobRows(jobsArr: CalJob[]): CalRow[];
  function isTaskFinished(job: CalJob, task: CalTask): boolean;
  function isDarkColor(hex: string): boolean;
  function editJob(jobId: string, phaseId?: string | null): void;
  function isCalendarJobSpanTaskId(taskId: unknown): boolean;
  function getLinkedReferenceJobs(): CalJob[];
  function jumpToLinkedJobReference(job: CalJob): void;
}

// Everything a bar-drag (handleCalBarMouseDown/Move/Up) needs to carry
// from mousedown through to mouseup. job/task are CalJob/CalTask (not the
// stricter Job/Task from core/types) because a drag can start on a real
// job task, a job's synthesized due-date marker, a calendar-only event, or
// a collapsed job-span bar — four different shapes, only some of which are
// "real" Jobs/Tasks; see CalJob/CalTask's own comment below.
interface CalDragState {
  jobId: string;
  taskId: string;
  job: CalJob;
  task: CalTask;
  bar: HTMLElement;
  dragType: string;
  startX: number;
  origLeft: number;
  origWidth: number;
  startDateObj: Date;
  finishDateObj: Date;
  duration: number;
  phaseId: string | null;
  subPhaseId: string | null;
  isCalendarEvent: boolean;
  calEventId: string | null;
  calEventSourceDate: string | null;
  moved: boolean;
  cellWidth: number;
}

// Deliberately loose local types rather than reusing Job/Task from
// core/types: the rows this render code juggles mix REAL job tasks (which
// have Task's required fields) with the "fake" job/task shapes
// flattenCalendarEventsForRange() manufactures for standalone calendar
// events (no `order`, among other gaps — see its own comment), and both
// flow through the exact same lane-packing/bar-building code below with
// no runtime distinction between the two.
interface CalJob {
  id: string;
  name: string;
  color?: string;
  archived?: boolean;
  isLinkedReference?: boolean;
  linkedFromProjectName?: string;
  [key: string]: unknown;
}

interface CalTask {
  id: string;
  name: string;
  start?: string;
  finish?: string;
  time?: string;
  color?: string;
  isDueMarker?: boolean;
  isJobSpan?: boolean;
  isCalendarEvent?: boolean;
  clusterSegments?: { colors: string[]; taskCount: number; startOffset: number; endOffset: number }[];
  [key: string]: unknown;
}

interface CalRow {
  job: CalJob;
  task: CalTask;
  phaseId?: string | null;
  phaseName?: string;
  subPhaseId?: string | null;
  subPhaseName?: string;
}

// A lane-packed segment for one visible row/week — clamped to that row's
// own date window (see spanWindowOffset's comment at each call site below).
interface CalSeg {
  flatIdx?: string | number;
  job: CalJob;
  task: CalTask;
  phaseId?: string | null;
  phaseName?: string;
  subPhaseId?: string | null;
  subPhaseName?: string;
  colStart: number;
  colEnd: number;
  isTrueStart: boolean;
  isTrueEnd: boolean;
  spanWindowOffset?: number;
  lane: number;
}

type CalDateRow = CalRow & { flatIdx: string | number; start: Date; finish: Date };

// Private to this module — nothing outside the functions below ever
// reads it (see the header comment on why isCalendarJobSpanTaskId()'s
// sibling CALENDAR_JOB_SPAN_TASK_PREFIX constant did NOT move here).
const CALENDAR_EVENT_TASK_PREFIX = 'calevt|';

function isCalendarEventTaskId(taskId: unknown): boolean {
  return typeof taskId === 'string' && taskId.indexOf(CALENDAR_EVENT_TASK_PREFIX) === 0;
}

function parseCalendarEventTaskId(taskId: string): { eventId: string; sourceDate: string } {
  // 'calevt|<eventId>|<sourceDate>' — eventId is a genId() and never
  // contains '|', so a plain split is safe.
  const parts = taskId.split('|');
  return { eventId: parts[1], sourceDate: parts[2] };
}

// Default recurrence horizon when repeatUntil is left blank: 6 months out
// from the anchor date, so a repeating event is usable without typing an
// end date, but doesn't generate occurrences forever.
function defaultRepeatUntil(anchorDate: Date): Date {
  return addMonths(anchorDate, 6);
}

// Expands one calendar event into its concrete occurrences within
// [rangeStart, rangeEnd] (inclusive), applying any per-occurrence
// exceptions. Each occurrence carries `sourceDate` — the theoretical,
// un-overridden date it was generated from — which exceptions are keyed
// by and which identifies it for dragging (see CALENDAR_EVENT_TASK_PREFIX).
function getCalendarEventOccurrences(evt: CalendarEvent, rangeStart: Date | null, rangeEnd: Date | null): CalendarEventOccurrence[] {
  const anchor = new Date(evt.start + 'T00:00:00');
  if (isNaN(anchor.getTime())) return [];

  const theoretical: { sourceDate: string; start: string; time: string; duration: number }[] = [];
  if (!evt.repeat || evt.repeat === 'none') {
    theoretical.push({ sourceDate: evt.start, start: evt.start, time: evt.time || '', duration: evt.duration || 1 });
  } else {
    const until = evt.repeatUntil ? new Date(evt.repeatUntil + 'T00:00:00') : defaultRepeatUntil(anchor);
    let cursor = new Date(anchor);
    let guard = 0;
    while (cursor <= until && guard < 500) {
      const dateStr = toIsoDate(cursor);
      theoretical.push({ sourceDate: dateStr, start: dateStr, time: evt.time || '', duration: evt.duration || 1 });
      if (evt.repeat === 'daily') cursor.setDate(cursor.getDate() + 1);
      else if (evt.repeat === 'weekly') cursor.setDate(cursor.getDate() + 7);
      else if (evt.repeat === 'monthly') cursor = addMonths(cursor, 1);
      else break; // unrecognized repeat value — treat as non-repeating
      guard++;
    }
  }

  const exceptions = evt.exceptions || {};
  const result: CalendarEventOccurrence[] = [];
  theoretical.forEach((occ) => {
    const ex = exceptions[occ.sourceDate];
    if (ex && ex.skip) return;
    const effectiveStart = (ex && ex.start) || occ.start;
    const effectiveTime = (ex && ex.time !== undefined) ? ex.time : occ.time;
    const effectiveDuration = (ex && ex.duration) ? ex.duration : occ.duration;
    const s = new Date(effectiveStart + 'T00:00:00');
    if (isNaN(s.getTime())) return;
    const f = new Date(s);
    f.setDate(f.getDate() + (effectiveDuration as number) - 1);
    if (rangeEnd && s > rangeEnd) return;
    if (rangeStart && f < rangeStart) return;
    result.push({ sourceDate: occ.sourceDate, start: s, finish: f, time: effectiveTime as string, duration: effectiveDuration as number });
  });
  return result;
}

// Project Admin still bypasses (an exact-role check, not hasMinTier(),
// deliberately — Admin does NOT bypass here, unlike isJobVisibleToMe():
// Admin doesn't need visibility into other people's private calendar
// items just by virtue of the role, per explicit request). viewAsUsername
// simulates a specific member's own view when an Admin is previewing, so
// this still correctly bypasses for a simulated Project Admin's own
// preview.
function isCalendarEventVisibleToMe(evt: CalendarEvent | null | undefined): boolean {
  if (!evt) return false;
  const visibility = evt.visibility || 'all';
  if (visibility === 'all') return true;
  const effectiveRole = getEffectiveRole();
  if (effectiveRole === 'projectAdmin') return true;
  const asUsername = viewAsUsername || getStoredUsername();
  if (visibility === 'private') return evt.createdBy === asUsername;
  if (visibility === 'members') return (evt.visibleMembers || []).indexOf(asUsername) !== -1;
  return true;
}

// Shapes calendar-event occurrences to match flattenJobs()'s {job, task,
// start, finish} rows, so the Calendar's existing lane-packing/rendering
// code can treat them identically to job task rows without a rewrite.
function flattenCalendarEventsForRange(rangeStart: Date | null, rangeEnd: Date | null): { job: CalJob; task: CalTask; start: Date; finish: Date }[] {
  const rows: { job: CalJob; task: CalTask; start: Date; finish: Date }[] = [];
  (calendarEvents || []).filter(isCalendarEventVisibleToMe).forEach((evt) => {
    getCalendarEventOccurrences(evt, rangeStart, rangeEnd).forEach((occ) => {
      const fakeJob = { id: 'calevt-job-' + evt.id, name: evt.title, color: evt.color, archived: false };
      const fakeTask = {
        id: CALENDAR_EVENT_TASK_PREFIX + evt.id + '|' + occ.sourceDate,
        name: evt.title,
        notes: '',
        color: evt.color,
        start: toIsoDate(occ.start),
        finish: toIsoDate(occ.finish),
        isCalendarEvent: true,
        time: occ.time,
      };
      rows.push({ job: fakeJob, task: fakeTask, start: occ.start, finish: occ.finish });
    });
  });
  return rows;
}

function ensureCalendarEventIds(arr: CalendarEvent[]): CalendarEvent[] {
  (arr || []).forEach((e) => {
    if (!e.id) e.id = genId();
    if (!e.repeat) e.repeat = 'none';
    if (typeof e.duration !== 'number' || e.duration < 1) e.duration = 1;
    if (!e.exceptions || typeof e.exceptions !== 'object') e.exceptions = {};
    if (!e.color) e.color = '#7e57c2';
  });
  return arr;
}

// ===== CALENDAR EVENT MODAL =====

// timeStr is optional — openDayView() opens the "add" form for an empty
// day without a specific time slot, unlike the week/day hourly grid's own
// click handler (renderWeekHourGrid()), which always has one.
function openAddCalendarEvent(dateStr: string, timeStr?: string): void {
  editingCalendarEventId = null;
  calendarEventTargetDate = dateStr;
  document.getElementById('calendarEventModalTitle')!.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#7e57c2" stroke-width="1.5"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#7e57c2"/><rect x="6" y="13" width="3" height="3" fill="#7e57c2"/><rect x="10.5" y="13" width="3" height="3" fill="#7e57c2"/><rect x="15" y="13" width="3" height="3" fill="#7e57c2"/></svg> New Event';
  (document.getElementById('ceDeleteBtn') as HTMLElement).style.display = 'none';
  (document.getElementById('ce_title') as HTMLInputElement).value = '';
  (document.getElementById('ce_title_hint') as HTMLElement).style.display = 'none';
  (document.getElementById('ce_date') as HTMLInputElement).value = dateStr || '';
  (document.getElementById('ce_time') as HTMLInputElement).value = timeStr || '';
  (document.getElementById('ce_duration') as HTMLInputElement).value = '1';
  (document.getElementById('ce_repeat') as HTMLSelectElement).value = 'none';
  (document.getElementById('ce_repeat_until') as HTMLInputElement).value = '';
  (document.getElementById('ce_color') as HTMLInputElement).value = '#7e57c2';
  updateCalendarEventColorSwatch();
  document.querySelectorAll('#ceColorPresets .color-preset').forEach((p) => p.classList.remove('selected'));
  toggleCalendarEventColorPanel(false);
  toggleRepeatUntilField();
  (document.getElementById('ce_visibility') as HTMLSelectElement).value = 'all';
  toggleCalendarEventVisibilityFields([]);
  openModal('calendarEventModal');
  setTimeout(function () { document.getElementById('ce_title')!.focus(); }, 50);
}

// sourceDate is accepted but unused for now — editing via the modal always
// edits the series definition (evt.start/duration/etc.), not one occurrence.
// Dragging an occurrence on the calendar (not this modal) is how you create
// a per-occurrence exception — see handleCalBarMouseUp.
function openEditCalendarEvent(eventId: string, sourceDate?: string): void {
  const evt = calendarEvents.find((e) => e.id === eventId);
  if (!evt) return;
  // Defense-in-depth matching flattenCalendarEventsForRange()'s own filter
  // — closes the gap for any entry point that resolves straight to an
  // eventId without going through a rendered (and thus already-filtered)
  // calendar bar. See isJobVisibleToMe()/editJob()'s identical guard.
  if (!isCalendarEventVisibleToMe(evt)) return;
  editingCalendarEventId = eventId;
  calendarEventTargetDate = null;
  document.getElementById('calendarEventModalTitle')!.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" fill="#f0ad4e"/><path d="M15.5 5L19 8.5" stroke="#fff" stroke-width="1"/></svg> Edit Event';
  (document.getElementById('ceDeleteBtn') as HTMLElement).style.display = 'inline-flex';
  (document.getElementById('ce_title') as HTMLInputElement).value = evt.title;
  (document.getElementById('ce_title_hint') as HTMLElement).style.display = 'none';
  (document.getElementById('ce_date') as HTMLInputElement).value = evt.start;
  (document.getElementById('ce_time') as HTMLInputElement).value = evt.time || '';
  (document.getElementById('ce_duration') as HTMLInputElement).value = String(evt.duration || 1);
  (document.getElementById('ce_repeat') as HTMLSelectElement).value = evt.repeat || 'none';
  (document.getElementById('ce_repeat_until') as HTMLInputElement).value = evt.repeatUntil || '';
  (document.getElementById('ce_color') as HTMLInputElement).value = evt.color || '#7e57c2';
  updateCalendarEventColorSwatch();
  document.querySelectorAll('#ceColorPresets .color-preset').forEach((p) => {
    (p as HTMLElement).classList.toggle('selected', (p as HTMLElement).dataset.color === evt.color);
  });
  toggleCalendarEventColorPanel(false);
  toggleRepeatUntilField();
  (document.getElementById('ce_visibility') as HTMLSelectElement).value = evt.visibility || 'all';
  toggleCalendarEventVisibilityFields(evt.visibleMembers || []);
  openModal('calendarEventModal');
}

function closeCalendarEventModal(): void {
  closeModal('calendarEventModal', function () {
    editingCalendarEventId = null;
    calendarEventTargetDate = null;
  });
}

function toggleRepeatUntilField(): void {
  const repeat = (document.getElementById('ce_repeat') as HTMLSelectElement).value;
  (document.getElementById('ce_repeat_until_group') as HTMLElement).style.display = (repeat === 'none') ? 'none' : 'block';
}

// Shows/rebuilds the Members checkbox list (see the Members custom field's
// identical cf-multiselect pattern, collapsed the same way behind
// toggleMsDropdown()/msSetAll()) only when Visibility is set to 'members'
// — same lazy-roster-load-then-rerender idiom as renderCustomFieldsGrid().
// `preSelected` carries the event's own evt.visibleMembers forward across
// a re-render (e.g. once the roster finishes loading) so an in-progress
// selection isn't lost.
function toggleCalendarEventVisibilityFields(preSelected: string[] | null): void {
  const visibility = (document.getElementById('ce_visibility') as HTMLSelectElement).value;
  const group = document.getElementById('ce_visibility_members_group') as HTMLElement;
  group.style.display = (visibility === 'members') ? 'block' : 'none';
  if (visibility !== 'members') return;
  const list = document.getElementById('ce_visibility_members_list')!;
  const actions = document.getElementById('ce_visibility_members_actions') as HTMLElement | null;
  const dropdownLabel = document.querySelector('#ceVisibilityMsDropdown .ms-dropdown-toggle span:first-child');
  const selected = preSelected || collectCalendarEventVisibilityMembers();
  if (!cachedUserRoster) {
    list.innerHTML = '<span class="cf-multiselect-loading">Loading team roster…</span>';
    ensureUserRosterLoaded().then(function () { toggleCalendarEventVisibilityFields(selected); });
    return;
  }
  list.innerHTML = cachedUserRoster.length
    ? cachedUserRoster.map((u) => {
        return '<label class="cf-multiselect-option"><input type="checkbox" value="' + escapeHtml(u.username) + '"' + (selected.indexOf(u.username) !== -1 ? ' checked' : '') + '> ' + escapeHtml(u.displayName) + '</label>';
      }).join('')
    : '<span class="cf-multiselect-empty">No team accounts yet</span>';
  if (actions) actions.style.display = cachedUserRoster.length ? 'flex' : 'none';
  if (dropdownLabel) dropdownLabel.textContent = msDropdownLabelText(selected.length);
}

function collectCalendarEventVisibilityMembers(): string[] {
  return Array.from(document.querySelectorAll('#ce_visibility_members_list input:checked')).map((el) => (el as HTMLInputElement).value);
}

function toggleCalendarEventColorPanel(forceOpen: boolean | null): void {
  const panel = document.getElementById('ceColorPickerPanel')!;
  const arrow = document.getElementById('ceColorToggleArrow')!;
  const open = forceOpen != null ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  arrow.classList.toggle('open', open);
}

function updateCalendarEventColorSwatch(): void {
  (document.getElementById('ceColorToggleSwatch') as HTMLElement).style.background = (document.getElementById('ce_color') as HTMLInputElement).value;
}

function buildCalendarEventColorPresets(): void {
  const container = document.getElementById('ceColorPresets')!;
  container.innerHTML = '';
  COLOR_PRESETS.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'color-preset';
    div.style.background = c;
    div.dataset.color = c;
    div.onclick = function () {
      (document.getElementById('ce_color') as HTMLInputElement).value = c;
      container.querySelectorAll('.color-preset').forEach((p) => p.classList.remove('selected'));
      div.classList.add('selected');
      updateCalendarEventColorSwatch();
    };
    container.appendChild(div);
  });
}

function saveCalendarEventFromModal(): void {
  const title = (document.getElementById('ce_title') as HTMLInputElement).value.trim();
  if (!title) {
    (document.getElementById('ce_title_hint') as HTMLElement).style.display = 'block';
    return;
  }
  const date = (document.getElementById('ce_date') as HTMLInputElement).value;
  if (!date) { showToast('Date is required', 'error'); return; }
  const time = (document.getElementById('ce_time') as HTMLInputElement).value;
  const duration = Math.max(1, parseInt((document.getElementById('ce_duration') as HTMLInputElement).value, 10) || 1);
  const repeat = (document.getElementById('ce_repeat') as HTMLSelectElement).value;
  const repeatUntil = (document.getElementById('ce_repeat_until') as HTMLInputElement).value;
  const color = (document.getElementById('ce_color') as HTMLInputElement).value;
  const visibility = (document.getElementById('ce_visibility') as HTMLSelectElement).value;
  const visibleMembers = visibility === 'members' ? collectCalendarEventVisibilityMembers() : [];

  if (editingCalendarEventId) {
    const evt = calendarEvents.find((e) => e.id === editingCalendarEventId);
    if (!evt) return;
    evt.title = title;
    evt.start = date;
    evt.time = time;
    evt.duration = duration;
    evt.repeat = repeat;
    evt.repeatUntil = repeatUntil || null;
    evt.color = color;
    evt.visibility = visibility;
    evt.visibleMembers = visibleMembers;
    // Backfill only — an event created before this feature (or by someone
    // else) keeps whoever actually made it; never overwritten by a later
    // editor just saving other changes.
    if (!evt.createdBy) evt.createdBy = getStoredUsername();
    logActivity('updated calendar event "' + title + '"');
  } else {
    calendarEvents.push({
      id: genId(), title: title, start: date, time: time, duration: duration,
      repeat: repeat, repeatUntil: repeatUntil || null, color: color, exceptions: {},
      visibility: visibility, visibleMembers: visibleMembers, createdBy: getStoredUsername(),
    });
    logActivity('added calendar event "' + title + '"');
  }
  saveCalendarEvents();
  // Re-renders whichever mode is currently active (month/week/day) — if
  // this modal was opened from inside the day view (see openDayView()),
  // that's calendarViewMode 'day', so the just-added/edited event shows
  // up there immediately once this modal closes.
  renderCalendar();
  showToast('Event saved', 'success');
  closeCalendarEventModal();
}

function deleteCalendarEventFromModal(): void {
  // Defense-in-depth, matching deleteCardFromModal()'s same pattern — its
  // trigger button is already data-min-tier gated, but delete is
  // irreversible enough to warrant a second check here.
  if (!hasMinTier('editor')) return;
  if (!editingCalendarEventId) return;
  const evt = calendarEvents.find((e) => e.id === editingCalendarEventId);
  if (evt) logActivity('deleted calendar event "' + evt.title + '"');
  const eventId = editingCalendarEventId;
  calendarEvents = calendarEvents.filter((e) => e.id !== editingCalendarEventId);
  saveCalendarEvents();
  deleteCalendarEventFromShared(activeProjectId, eventId);
  renderCalendar();
  showToast('Event deleted', 'info');
  closeCalendarEventModal();
}

// ===== CALENDAR: VIEW NAVIGATION + RENDER DISPATCH =====

function setCalendarView(mode: string): void {
  calendarViewMode = mode;
  renderCalendar();
}

function calendarPrev(): void {
  if (calendarViewMode === 'month') {
    calendarViewDate = addMonths(calendarViewDate, -1);
  } else if (calendarViewMode === 'day') {
    calendarViewDate.setDate(calendarViewDate.getDate() - 1);
  } else {
    calendarViewDate.setDate(calendarViewDate.getDate() - 7);
  }
  renderCalendar();
}

function calendarNext(): void {
  if (calendarViewMode === 'month') {
    calendarViewDate = addMonths(calendarViewDate, 1);
  } else if (calendarViewMode === 'day') {
    calendarViewDate.setDate(calendarViewDate.getDate() + 1);
  } else {
    calendarViewDate.setDate(calendarViewDate.getDate() + 7);
  }
  renderCalendar();
}

function calendarToday(): void {
  calendarViewDate = new Date();
  renderCalendar();
}

function calendarExitDayView(): void {
  calendarViewMode = 'month';
  renderCalendar();
}

function renderCalendar(): void {
  // Exposed on <body> so mobile CSS can key off it — see the
  // body[data-calendar-mode="week"] #weekHourSection rule, which day mode
  // must NOT be caught by since it reuses that same element. Set BEFORE
  // the render calls below, not after — renderWeekCalendar() measures
  // real cell offsetLeft positions (see its own "left = startCell.
  // offsetLeft" comment) to place the multi-day job bars, and the week-
  // only #calendarDays/#calendarWeekdays padding-left:48px that keeps
  // those columns aligned with the hourly grid (see that rule's own
  // comment) is keyed off this same attribute — measuring before it was
  // set left the bars computed against the un-padded (pre-shift) column
  // positions, so they landed 48px left of where the columns actually
  // ended up once the padding kicked in.
  document.body.dataset.calendarMode = calendarViewMode;
  if (calendarViewMode === 'week') {
    renderWeekCalendar();
  } else if (calendarViewMode === 'day') {
    renderDayCalendarView();
  } else {
    renderMonthCalendar();
  }
  // Update view toggle buttons
  const monthBtn = document.getElementById('calViewMonth');
  const weekBtn = document.getElementById('calViewWeek');
  if (monthBtn && weekBtn) {
    const activeStyle = 'background:var(--primary-light);color:white;border-color:var(--primary-light);';
    const inactiveStyle = 'background:transparent;color:var(--text-light);border-color:transparent;';
    (monthBtn as HTMLElement).style.cssText = calendarViewMode === 'month' ? activeStyle : inactiveStyle;
    (weekBtn as HTMLElement).style.cssText = calendarViewMode === 'week' ? activeStyle : inactiveStyle;
  }
  const backBtn = document.getElementById('calBackBtn');
  if (backBtn) (backBtn as HTMLElement).style.display = calendarViewMode === 'day' ? 'inline-flex' : 'none';
  const addBtn = document.getElementById('calAddEventBtn');
  if (addBtn) (addBtn as HTMLElement).style.display = calendarViewMode === 'day' ? 'inline-flex' : 'none';
}

// ===== CALENDAR: RENDER ENGINE (month/week/day grids) =====

function buildCalBarHtml(seg: CalSeg, left: number, top: number, width: number): string {
  const job = seg.job;
  const task = seg.task;
  const isDue = !!task.isDueMarker;
  const isCalEvt = !!task.isCalendarEvent;
  const isTimedCalEvt = isCalEvt && !!task.time;
  // A condensed sub-unit span from buildCalendarJobRows() — see its own
  // comment for the collapse rationale. Not a real task.tasks[] entry, so
  // it can't be dragged/resized (there's no single task to write a new
  // date onto) — handleCalBarMouseDown/Move special-case it to always
  // resolve as a plain click that opens the job, never a drag.
  const isJobSpan = !!task.isJobSpan;
  const classes = ['cal-event-bar'];
  if (isDue) classes.push('due-marker');
  if (isCalEvt) classes.push('calendar-event-bar');
  if (isTimedCalEvt) classes.push('timed-style');
  if (job.isLinkedReference) classes.push('linked-ref');
  classes.push(seg.isTrueStart ? 'cap-start' : 'cont-start');
  classes.push(seg.isTrueEnd ? 'cap-end' : 'cont-end');
  if (isTaskFinished(job, task)) classes.push('finished');

  const barColor = task.color || job.color || '#3949ab';
  // Same treatment as every Gantt task bar, span or not (see renderGantt(),
  // "Left at full saturation (unsoftened) so it still reads as a crisp
  // edge against the softened fill"): a softened/pastel fill in the
  // task's own color, plus a full-saturation job-color border drawn on
  // top. The border is deliberately NOT softened/darkened — a same-color
  // border would be invisible against a same-color fill, but a raw
  // saturated border against an always-lighter softened fill is
  // guaranteed to contrast, by construction, regardless of which color
  // the task/job happen to be. Applied to both a regular task bar and a
  // collapsed span so both look like the same family of bar. Due markers
  // and standalone calendar-only events keep their own distinct look
  // instead — neither has a "job" identity this border would be showing.
  const showJobBorder = !isDue && !isCalEvt;
  // A collapsed-span bar can cover a cluster of multiple touching/
  // overlapping tasks (task.clusterSegments, from buildSubUnitClusters) —
  // one bordered bar per cluster, never split into a separate bar just
  // for the overlapping stretch. A single-segment cluster fills solid or
  // (if that one segment is itself an overlap, taskCount > 1) hatched,
  // same two-path fallback as Gantt's own collapsed-row overlap segments
  // (renderGantt()'s "job-span-task-hatch" branch): genuinely different
  // task colors stripe as-is; tasks that overlap but happen to share one
  // color (common — see buildSubUnitClusters' taskCount comment) stripe
  // that color against a darkened shade of itself, so the overlap still
  // reads as a hatch instead of a plain single-color fill. A
  // multi-segment cluster paints that same solid/hatch fill as the bar's
  // own base background — the base is what's visible for a scheduled day
  // no individual segment covers... except every day IN a cluster is
  // covered by construction (that's what makes it one cluster), so this
  // is really just here to give buildInnerBlocks below something sane to
  // sit on top of before the per-segment blocks paint over it.
  function segmentFill(colors: string[], taskCount: number): string {
    if (taskCount <= 1) return softenColor(colors[0]);
    if (colors.length > 1) return 'repeating-linear-gradient(45deg, ' + colors.map(function (c: string, idx: number) { const sc = softenColor(c); return sc + ' ' + (idx * 6) + 'px, ' + sc + ' ' + ((idx + 1) * 6) + 'px'; }).join(', ') + ')';
    const base = softenColor(colors[0]);
    const dark = darkenColor(base, 0.28);
    return 'repeating-linear-gradient(45deg, ' + base + ' 0px, ' + base + ' 6px, ' + dark + ' 6px, ' + dark + ' 12px)';
  }
  const clusterSegs = isJobSpan ? task.clusterSegments : null;
  const isMultiSegmentCluster = !!(clusterSegs && clusterSegs.length > 1);
  let fillColor: string;
  if (clusterSegs && clusterSegs.length === 1) {
    fillColor = segmentFill(clusterSegs[0].colors, clusterSegs[0].taskCount);
  } else if (isMultiSegmentCluster && clusterSegs) {
    fillColor = segmentFill(clusterSegs[0].colors, clusterSegs[0].taskCount);
  } else {
    fillColor = showJobBorder ? softenColor(barColor) : barColor;
  }
  // Softening the fill (see showJobBorder above) means it's often light
  // enough that the bar's own hardcoded white text (see .cal-event-bar)
  // reads as barely-there — same isDarkColor()/darkenColor() pairing the
  // board-column header title already uses for the same reason: keep
  // white text on a genuinely dark fill, otherwise fall back to a heavily
  // darkened shade of the fill's own color rather than plain black. Tests
  // against a plain softened color even for a hatch fill (softenColor's
  // own output, ignoring the stripe) — close enough to representative for
  // picking readable text, and isDarkColor() can't evaluate a gradient.
  const contrastColor = clusterSegs && clusterSegs.length ? softenColor(clusterSegs[0].colors[0]) : (showJobBorder ? softenColor(barColor) : barColor);
  const textColor = isDarkColor(contrastColor) ? '#fff' : darkenColor(contrastColor, 0.6);
  const styleExtra = isTimedCalEvt ? ('--dot-color:' + barColor + ';') :
    ('background:' + fillColor + '; color: ' + textColor + ';' +
     (showJobBorder ? ' border: 2px solid ' + (job.color || '#3949ab') + ';' + (job.isLinkedReference ? ' border-style: dashed;' : '') : ''));

  // Read-only: no drag handles for a linked reference (its real data
  // lives in, and can only be edited from, its home project) or a
  // collapsed span (see isJobSpan above). Clicking either still works —
  // handleCalBarMouseDown routes a linked reference to
  // jumpToLinkedJobReference(), and a span to calendarOpenJob() via its
  // own isCalendarJobSpanTaskId() branch.
  const dragHandles = (isDue || job.isLinkedReference || isJobSpan) ? '' :
    '<div class="cal-bar-drag-left" data-drag="left"></div>' +
    '<div class="cal-bar-drag-body" data-drag="move"></div>' +
    '<div class="cal-bar-drag-right" data-drag="right"></div>';

  const phaseLabel = seg.subPhaseName ? (seg.subPhaseName + (seg.phaseName ? ' (' + seg.phaseName + ')' : '')) : seg.phaseName;

  let content: string;
  if (isDue) {
    content = '🚩';
  } else if (isTimedCalEvt) {
    const timeLabel = formatTimeLabel(task.time);
    content = (timeLabel ? '<span class="cal-event-time">' + escapeHtml(timeLabel) + '</span>' : '') + escapeHtml(task.name);
  } else {
    const linkGlyph = job.isLinkedReference ? '🔗 ' : '';
    // A span's task.name is already "Job — Phase — SubPhase" (see
    // buildCalendarJobRows()) — the usual job-name tag alongside it would
    // just repeat that.
    const tagLabel = isCalEvt ? formatTimeLabel(task.time) : (isJobSpan ? '' : linkGlyph + job.name + (phaseLabel ? ' — ' + phaseLabel : ''));
    content = (isJobSpan ? linkGlyph : '') + escapeHtml(task.name) + (tagLabel ? ' <span class="cal-jobname-tag" style="background:' + (job.color || '#3949ab') + ';">' + escapeHtml(tagLabel) + '</span>' : '');
  }

  // A cluster with more than one internal segment (a hand-off between two
  // tasks, or an overlap sitting inside an otherwise-solo run) still
  // renders as ONE bordered bar (see isMultiSegmentCluster above) — but
  // paints each of its own segments as its own colored block inside that
  // one bar, so a hand-off between different-colored tasks still shows
  // both colors instead of flattening to the first segment's fill.
  // Position is in the bar's content-box coordinate space (a
  // position:absolute child's containing block, per spec, is the padding
  // box — padding doesn't shift it, but the 2px border does, hence only
  // subtracting the border below). seg.spanWindowOffset (set by
  // renderMonthCalendar/renderWeekCalendar) accounts for a cluster bar
  // that's only a clamped slice of a multi-week range.
  let innerBlocksHtml = '';
  if (isMultiSegmentCluster && clusterSegs) {
    const windowOffset = seg.spanWindowOffset || 0;
    const windowDays = Math.max(1, (seg.colEnd - seg.colStart) + 1);
    const borderW = 2; // matches the bar's own border: 2px, see showJobBorder above
    const perDayPx = Math.max(0, width - borderW * 2) / windowDays;
    clusterSegs.forEach(function (s) {
      const clipStart = Math.max(0, s.startOffset - windowOffset);
      const clipEnd = Math.min(windowDays - 1, s.endOffset - windowOffset);
      if (clipEnd < clipStart) return;
      const segLeft = clipStart * perDayPx;
      const segWidth = (clipEnd - clipStart + 1) * perDayPx;
      innerBlocksHtml += '<div class="cal-bar-segment" style="left:' + segLeft + 'px; width:' + segWidth + 'px; background:' + segmentFill(s.colors, s.taskCount) + ';"></div>';
    });
  }
  if (innerBlocksHtml) content = '<span class="cal-bar-content">' + content + '</span>';

  return '<div class="' + classes.join(' ') + '" style="left:' + left + 'px; top:' + top + 'px; width:' + width + 'px; height:' + CAL_BAR_H + 'px; ' + styleExtra + '" title="' +
    escapeHtml(task.name) + (isCalEvt || isJobSpan ? '' : ' — ' + escapeHtml(job.name) + (seg.phaseName ? ' — ' + escapeHtml(seg.phaseName) : '') + (seg.subPhaseName ? ' — ' + escapeHtml(seg.subPhaseName) : '')) + (job.isLinkedReference ? ' (linked, read-only — click to open in ' + escapeHtml(job.linkedFromProjectName || 'its project') + ')' : '') + '" data-cal-job-id="' + job.id + '" data-cal-task-id="' + task.id + '" data-cal-phase-id="' + (seg.phaseId || '') + '" data-cal-sub-phase-id="' + (seg.subPhaseId || '') + '" data-cal-linked="' + (job.isLinkedReference ? '1' : '') + '" data-cal-seg-start="' + seg.isTrueStart + '" data-cal-seg-end="' + seg.isTrueEnd + '" data-cal-task-start="' + (task.start || '') + '" data-cal-task-finish="' + (task.finish || '') + '">' +
    dragHandles + innerBlocksHtml + content + '</div>';
}

function renderMonthCalendar(): void {
  const weekdaysEl = document.getElementById('calendarWeekdays');
  const daysEl = document.getElementById('calendarDays');
  const labelEl = document.getElementById('calendarLabel');
  if (!weekdaysEl || !daysEl || !labelEl) return;
  daysEl.style.flex = ''; // clears the day mode override — see renderDayCalendarView()

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  labelEl.textContent = MONTH_NAMES[month] + ' ' + year;

  weekdaysEl.innerHTML = WEEKDAY_NAMES.map(d => '<div class="cal-weekday">' + d + '</div>').join('');
  weekdaysEl.style.display = 'grid';

  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cellDates: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    cellDate.setHours(0, 0, 0, 0);
    cellDates.push(cellDate);
  }

  // Build flat list from jobs→tasks, plus standalone calendar-only events
  // (never part of a job — see flattenCalendarEventsForRange) laid out in
  // the exact same lane-packing pass below. buildCalendarJobRows() (not
  // flattenJobs()) so a job's sub-units always render as one condensed,
  // overlapping bar each instead of one row per task — see its own
  // comment for the full rationale.
  const flatRows = buildCalendarJobRows(getVisibleJobs());
  const allJobs: CalDateRow[] = flatRows.map((row, flatIdx) => {
    const s = new Date(row.task.start! + 'T00:00:00');
    const f = new Date(row.task.finish! + 'T00:00:00');
    return { flatIdx, job: row.job, task: row.task, start: s, finish: f, phaseId: row.phaseId, phaseName: row.phaseName, subPhaseId: row.subPhaseId, subPhaseName: row.subPhaseName };
  });
  flattenCalendarEventsForRange(cellDates[0], cellDates[cellDates.length - 1]).forEach(function (row, i) {
    allJobs.push({ flatIdx: 'ce-' + i, job: row.job, task: row.task, start: row.start, finish: row.finish });
  });

  const numRows = 6;
  const rowLanes: number[] = [];
  const rowSegments: CalSeg[][] = [];

  for (let row = 0; row < numRows; row++) {
    const rowStart = cellDates[row * 7];
    const rowEnd = cellDates[row * 7 + 6];
    const segs: CalSeg[] = allJobs.filter(j => j.finish >= rowStart && j.start <= rowEnd)
      .map(j => {
        const clampedStart = j.start < rowStart ? rowStart : j.start;
        const clampedFinish = j.finish > rowEnd ? rowEnd : j.finish;
        return {
          flatIdx: j.flatIdx, job: j.job, task: j.task, phaseId: j.phaseId, phaseName: j.phaseName, subPhaseId: j.subPhaseId, subPhaseName: j.subPhaseName,
          colStart: Math.round((clampedStart.getTime() - rowStart.getTime()) / 86400000),
          colEnd: Math.round((clampedFinish.getTime() - rowStart.getTime()) / 86400000),
          isTrueStart: j.start.getTime() === clampedStart.getTime(),
          isTrueEnd: j.finish.getTime() === clampedFinish.getTime(),
          // Days from the cluster's own true start to THIS row's clamped
          // display window — buildCalBarHtml needs it to slice
          // task.clusterSegments (offsets relative to the cluster's own
          // start) down to just what's visible in this particular week row.
          spanWindowOffset: Math.round((clampedStart.getTime() - j.start.getTime()) / 86400000),
          lane: 0
        };
      })
      .sort((a, b) => a.colStart - b.colStart || (a.colEnd - a.colStart) - (b.colEnd - b.colStart));

    const laneEndCols: number[] = [];
    segs.forEach(seg => {
      let lane = laneEndCols.findIndex(endCol => endCol < seg.colStart);
      if (lane === -1) { lane = laneEndCols.length; laneEndCols.push(seg.colEnd); }
      else { laneEndCols[lane] = seg.colEnd; }
      seg.lane = lane;
    });

    rowLanes.push(laneEndCols.length);
    rowSegments.push(segs);
  }

  let html = '';
  for (let row = 0; row < numRows; row++) {
    const minH = CAL_DAYNUM_H + Math.max(rowLanes[row], 1) * (CAL_BAR_H + CAL_BAR_GAP) + 10;
    for (let col = 0; col < 7; col++) {
      const cellDate = cellDates[row * 7 + col];
      const isOutside = cellDate.getMonth() !== month;
      const isToday = cellDate.getTime() === today.getTime();
      html += '<div class="cal-day' + (isOutside ? ' cal-outside' : '') + (isToday ? ' cal-today' : '') +
        '" style="min-height:' + minH + 'px;" data-row="' + row + '" data-col="' + col + '" data-date="' + toIsoDate(cellDate) + '">' +
        '<div class="cal-day-num">' + cellDate.getDate() + '</div>' +
      '</div>';
    }
  }
  daysEl.innerHTML = html;
  daysEl.className = 'calendar-grid calendar-days';

  const cellEls = daysEl.querySelectorAll<HTMLElement>('.cal-day');
  const getCell = (row: number, col: number) => cellEls[row * 7 + col];
  cellEls.forEach(function (cell) {
    cell.addEventListener('click', function (e) { if ((e.target as Element).closest('.cal-day') === cell) openDayView(cell.dataset.date || ''); });
  });

  let barsHtml = '';
  for (let row = 0; row < numRows; row++) {
    rowSegments[row].forEach(seg => {
      const startCell = getCell(row, seg.colStart);
      const endCell = getCell(row, seg.colEnd);
      const left = startCell.offsetLeft;
      const width = (endCell.offsetLeft + endCell.offsetWidth) - left;
      const top = startCell.offsetTop + CAL_DAYNUM_H + seg.lane * (CAL_BAR_H + CAL_BAR_GAP);
      barsHtml += buildCalBarHtml(seg, left, top, width);
    });
  }

  document.getElementById('weekHourSection')!.classList.remove('show');
  daysEl.classList.remove('week-all-day-mode');

  let barsLayer = daysEl.querySelector<HTMLElement>('.cal-bars-layer');
  if (!barsLayer) {
    barsLayer = document.createElement('div');
    barsLayer.className = 'cal-bars-layer';
    daysEl.appendChild(barsLayer);
  }
  barsLayer.innerHTML = barsHtml;
}

function renderWeekCalendar(): void {
  const weekdaysEl = document.getElementById('calendarWeekdays');
  const daysEl = document.getElementById('calendarDays');
  const labelEl = document.getElementById('calendarLabel');
  if (!weekdaysEl || !daysEl || !labelEl) return;
  daysEl.style.flex = ''; // clears the day mode override — see renderDayCalendarView()

  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekStart = new Date(calendarViewDate);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  labelEl.textContent = weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) +
    ' – ' + weekEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  weekdaysEl.innerHTML = WEEKDAY_NAMES.map(d => '<div class="cal-weekday">' + d + '</div>').join('');
  weekdaysEl.style.display = 'grid';

  const cellDates: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    cellDates.push(d);
  }

  // Build flat list from jobs→tasks, plus standalone calendar-only events —
  // except calendar events that have a time set, which render in the
  // separate hourly grid below (built further down) instead of up here in
  // the all-day-style row.
  const flatRows = buildCalendarJobRows(getVisibleJobs());
  const allJobs: CalDateRow[] = flatRows.map((row, flatIdx) => {
    const s = new Date(row.task.start! + 'T00:00:00');
    const f = new Date(row.task.finish! + 'T00:00:00');
    return { flatIdx, job: row.job, task: row.task, start: s, finish: f, phaseId: row.phaseId, phaseName: row.phaseName, subPhaseId: row.subPhaseId, subPhaseName: row.subPhaseName };
  });
  const timedCalRows: { job: CalJob; task: CalTask; start: Date; finish: Date }[] = [];
  flattenCalendarEventsForRange(weekStart, weekEnd).forEach(function (row, i) {
    if (row.task.time) { timedCalRows.push(row); return; }
    allJobs.push({ flatIdx: 'ce-' + i, job: row.job, task: row.task, start: row.start, finish: row.finish });
  });

  // Build day cells (single row, 7 columns)
  let html = '';
  for (let col = 0; col < 7; col++) {
    const cellDate = cellDates[col];
    const isToday = cellDate.getTime() === today.getTime();
    html += '<div class="cal-day week-day' + (isToday ? ' cal-today' : '') + '" data-week-col="' + col + '" data-date="' + toIsoDate(cellDate) + '">' +
      '<div class="cal-day-num">' + cellDate.getDate() + '</div>' +
    '</div>';
  }
  daysEl.innerHTML = html;
  daysEl.className = 'calendar-grid calendar-days';

  const cellEls = daysEl.querySelectorAll<HTMLElement>('.cal-day');
  const getCell = (col: number) => cellEls[col];
  cellEls.forEach(function (cell) {
    cell.addEventListener('click', function (e) { if ((e.target as Element).closest('.cal-day') === cell) openDayView(cell.dataset.date || ''); });
  });

  // Build continuous segments across the week (like month view but 1 row)
  const segs: CalSeg[] = allJobs.filter(j => j.finish >= weekStart && j.start <= weekEnd)
    .map(j => {
      const clampedStart = j.start < weekStart ? weekStart : j.start;
      const clampedFinish = j.finish > weekEnd ? weekEnd : j.finish;
      return {
        flatIdx: j.flatIdx, job: j.job, task: j.task, phaseId: j.phaseId, phaseName: j.phaseName, subPhaseId: j.subPhaseId, subPhaseName: j.subPhaseName,
        colStart: Math.round((clampedStart.getTime() - weekStart.getTime()) / 86400000),
        colEnd: Math.round((clampedFinish.getTime() - weekStart.getTime()) / 86400000),
        isTrueStart: j.start.getTime() === clampedStart.getTime(),
        isTrueEnd: j.finish.getTime() === clampedFinish.getTime(),
        // See the identical field in renderMonthCalendar() — how far this
        // week's clamped display window starts into the cluster's own
        // full range, so buildCalBarHtml can slice task.clusterSegments
        // down to just what's visible here.
        spanWindowOffset: Math.round((clampedStart.getTime() - j.start.getTime()) / 86400000),
        lane: 0
      };
    })
    .sort((a, b) => a.colStart - b.colStart || (a.colEnd - a.colStart) - (b.colEnd - b.colStart));

  const laneEndCols: number[] = [];
  segs.forEach(seg => {
    let lane = laneEndCols.findIndex(endCol => endCol < seg.colStart);
    if (lane === -1) { lane = laneEndCols.length; laneEndCols.push(seg.colEnd); }
    else { laneEndCols[lane] = seg.colEnd; }
    seg.lane = lane;
  });

  const maxLanes = laneEndCols.length || 1;
  const rowMinH = CAL_DAYNUM_H + maxLanes * (CAL_BAR_H + CAL_BAR_GAP) + 16;

  // Set all cells to same height
  cellEls.forEach(c => c.style.minHeight = rowMinH + 'px');

  let barsHtml = '';
  segs.forEach(seg => {
    const startCell = getCell(seg.colStart);
    const endCell = getCell(seg.colEnd);
    const left = startCell.offsetLeft;
    const width = (endCell.offsetLeft + endCell.offsetWidth) - left;
    const top = startCell.offsetTop + CAL_DAYNUM_H + seg.lane * (CAL_BAR_H + CAL_BAR_GAP);
    barsHtml += buildCalBarHtml(seg, left, top, width);
  });

  daysEl.classList.add('week-all-day-mode');

  let barsLayer = daysEl.querySelector<HTMLElement>('.cal-bars-layer');
  if (!barsLayer) {
    barsLayer = document.createElement('div');
    barsLayer.className = 'cal-bars-layer';
    daysEl.appendChild(barsLayer);
  }
  barsLayer.innerHTML = barsHtml;

  renderWeekHourGrid(cellDates, timedCalRows, today);
}

// ===== WEEK VIEW HOURLY GRID (Google-Calendar style) =====
const WEEK_HOUR_ROW_H = 48;
// Calendar events only store a start time, not an end time/duration-in-
// minutes — this is the fixed visual block height (and the window used for
// same-day overlap/lane-packing) used to represent one on the hourly grid.
const WEEK_TIMED_EVENT_MIN_HEIGHT_MINUTES = 45;

// sectionId/labelsId/colsId default to the desktop week view's own elements
// — the day view (see renderDayCalendarView()) passes its own IDs to reuse
// this same renderer for a single-day column instead of seven.
function renderWeekHourGrid(cellDates: Date[], timedCalRows: { job: CalJob; task: CalTask; start: Date; finish?: Date }[], today: Date, sectionId?: string, labelsId?: string, colsId?: string): void {
  const section = document.getElementById(sectionId || 'weekHourSection');
  const labelsEl = document.getElementById(labelsId || 'weekHourLabels');
  const colsEl = document.getElementById(colsId || 'weekHourCols');
  if (!section || !labelsEl || !colsEl) return;
  section.classList.add('show');
  colsEl.style.gridTemplateColumns = 'repeat(' + cellDates.length + ', 1fr)';

  // Hour labels down the left side.
  let labelsHtml = '';
  for (let h = 0; h < 24; h++) {
    const label = h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM';
    labelsHtml += '<div class="week-hour-label"><span>' + (h === 0 ? '' : label) + '</span></div>';
  }
  labelsEl.innerHTML = labelsHtml;

  // Bucket each day's timed occurrences by which calendar day they fall on,
  // then lane-pack same-day overlaps by time range (same greedy algorithm
  // used for date-range lane packing elsewhere, just keyed by minutes).
  const dayBuckets: { task: CalTask; job: CalJob; startMin: number; lane?: number }[][] = cellDates.map(function () { return []; });
  timedCalRows.forEach(function (row) {
    const dayIdx = Math.round((row.start.getTime() - cellDates[0].getTime()) / 86400000);
    if (dayIdx < 0 || dayIdx >= cellDates.length) return;
    const startMin = timeToMinutes(row.task.time);
    if (startMin === null) return;
    dayBuckets[dayIdx].push({ task: row.task, job: row.job, startMin: startMin });
  });

  let colsHtml = '';
  for (let col = 0; col < cellDates.length; col++) {
    const isToday = cellDates[col].getTime() === today.getTime();
    let rowLines = '';
    for (let h = 0; h < 24; h++) rowLines += '<div class="week-hour-row-line"></div>';

    const items = dayBuckets[col].sort(function (a, b) { return a.startMin - b.startMin; });
    const laneEnds: number[] = [];
    items.forEach(function (it) {
      const endMin = it.startMin + WEEK_TIMED_EVENT_MIN_HEIGHT_MINUTES;
      let lane = laneEnds.findIndex(function (end) { return end <= it.startMin; });
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(endMin); }
      else { laneEnds[lane] = endMin; }
      it.lane = lane;
    });
    const laneCount = laneEnds.length || 1;

    let eventsHtml = '';
    items.forEach(function (it) {
      const top = (it.startMin / 60) * WEEK_HOUR_ROW_H;
      const height = Math.max(20, (WEEK_TIMED_EVENT_MIN_HEIGHT_MINUTES / 60) * WEEK_HOUR_ROW_H - 2);
      const laneWidthPct = 100 / laneCount;
      const leftPct = (it.lane || 0) * laneWidthPct;
      const timeLabel = formatTimeLabel(it.task.time);
      eventsHtml += '<div class="week-timed-event" style="top:' + top + 'px; height:' + height + 'px; left:calc(' + leftPct + '% + 2px); width:calc(' + laneWidthPct + '% - 4px); background:' + (it.task.color || it.job.color || '#7e57c2') + ';" title="' + escapeHtml(it.task.name) + (timeLabel ? ' — ' + timeLabel : '') + '" data-cal-job-id="' + it.job.id + '" data-cal-task-id="' + it.task.id + '">' +
        (timeLabel ? '<span class="wte-time">' + escapeHtml(timeLabel) + '</span>' : '') +
        escapeHtml(it.task.name) + '</div>';
    });

    let nowLineHtml = '';
    if (isToday) {
      const now = new Date();
      const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * WEEK_HOUR_ROW_H;
      nowLineHtml = '<div class="week-current-time-line" style="top:' + nowTop + 'px;"></div>';
    }

    colsHtml += '<div class="week-hour-col" data-col="' + col + '" data-date="' + toIsoDate(cellDates[col]) + '">' +
      rowLines + eventsHtml + nowLineHtml + '</div>';
  }
  colsEl.innerHTML = colsHtml;

  colsEl.querySelectorAll<HTMLElement>('.week-hour-col').forEach(function (colEl) {
    colEl.addEventListener('click', function (e) {
      if ((e.target as Element).closest('.week-timed-event')) return; // handled by its own listener below
      const rect = colEl.getBoundingClientRect();
      const offsetY = (e as MouseEvent).clientY - rect.top;
      const totalMinutes = Math.max(0, Math.round((offsetY / WEEK_HOUR_ROW_H) * 60 / 30) * 30);
      const h = Math.min(23, Math.floor(totalMinutes / 60));
      const m = totalMinutes % 60;
      const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      openAddCalendarEvent(colEl.dataset.date || '', timeStr);
    });
  });
  colsEl.querySelectorAll<HTMLElement>('.week-timed-event').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      const parsed = parseCalendarEventTaskId(el.dataset.calTaskId || '');
      openEditCalendarEvent(parsed.eventId, parsed.sourceDate);
    });
  });

  // Scroll to a sensible starting point: near the current time if today is
  // in view, otherwise default to business hours (~7 AM) instead of
  // dumping the user at midnight.
  const todayIdx = cellDates.findIndex(function (d) { return d.getTime() === today.getTime(); });
  const scrollHour = todayIdx !== -1 ? Math.max(0, new Date().getHours() - 1) : 7;
  section.scrollTop = scrollHour * WEEK_HOUR_ROW_H;
}

function calendarOpenJob(jobId: string, taskId: string, phaseId?: string | null): void {
  editJob(jobId, phaseId);
}

// ===== DAY VIEW (calendarViewMode = 'day') =====
// Tapping a day in the calendar grid (month or week's all-day row — see
// the .cal-day click handlers in renderMonthCalendar()/renderWeekCalendar())
// switches the whole calendar over to a single-day agenda instead of
// opening a separate view on top of it — same toolbar/label/grid area as
// month & week (see renderCalendar()), just showing one day. Prev/Next/
// swipe move a day at a time in this mode (see calendarPrev()/Next() and
// the calendarViewMode checks in handleCalSwipeStart()); "‹ Month" (only
// shown in this mode — see calBackBtn) exits back to the grid.

// Reuses the exact same data flattenJobs()/flattenCalendarEventsForRange()
// already produce for the month grid's own bars (job tasks + due markers +
// calendar-only events), just filtered down to one specific date instead
// of laid out across a whole visible range.
function getScheduledItemsForDate(dateStr: string): { job: CalJob; task: CalTask; phaseId?: string | null }[] {
  const d = new Date(dateStr + 'T00:00:00');
  const items: { job: CalJob; task: CalTask; phaseId?: string | null }[] = [];
  flattenJobs(getVisibleJobs()).forEach(function (row) {
    if (!row.task.start || !row.task.finish) return;
    const s = new Date(row.task.start + 'T00:00:00');
    const f = new Date(row.task.finish + 'T00:00:00');
    if (isNaN(s.getTime()) || isNaN(f.getTime())) return;
    if (d >= s && d <= f) items.push({ job: row.job, task: row.task, phaseId: row.phaseId });
  });
  flattenCalendarEventsForRange(d, d).forEach(function (row) {
    items.push({ job: row.job, task: row.task });
  });
  // All-day items first, then timed items chronologically — matches how
  // Google Calendar's own day view orders things.
  items.sort(function (a, b) {
    const ta = a.task.time || '', tb = b.task.time || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return items;
}

// Entry point — called by the .cal-day click handlers in
// renderMonthCalendar()/renderWeekCalendar().
function openDayView(dateStr: string): void {
  calendarViewDate = new Date(dateStr + 'T00:00:00');
  calendarViewMode = 'day';
  renderCalendar();
  // Nothing scheduled — go straight into adding something, layered on top
  // of this (now essentially empty-state) day. Only on entry, not on every
  // subsequent Prev/Next/swipe — renderDayCalendarView() itself has no
  // such side effect, so browsing through several empty days in a row
  // doesn't keep popping the Add Event modal back open.
  if (!getScheduledItemsForDate(dateStr).length) openAddCalendarEvent(dateStr);
}

function renderDayCalendarView(): void {
  const weekdaysEl = document.getElementById('calendarWeekdays');
  const daysEl = document.getElementById('calendarDays');
  const labelEl = document.getElementById('calendarLabel');
  if (!weekdaysEl || !daysEl || !labelEl) return;

  const d = new Date(calendarViewDate);
  d.setHours(0, 0, 0, 0);
  const dateStr = toIsoDate(d);

  labelEl.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  weekdaysEl.style.display = 'none';
  weekdaysEl.innerHTML = '';

  const items = getScheduledItemsForDate(dateStr);
  // Timed calendar events render as positioned blocks on the hourly grid
  // below instead of in this list — job tasks/due markers never carry a
  // .time, so they always stay up here.
  const allDayItems = items.filter(function (item) { return !item.task.time; });

  // Sized to content (unlike month/week's flex:1 .calendar-days) so the
  // hourly grid below gets the rest of the space — cleared back to the
  // stylesheet default by renderMonthCalendar()/renderWeekCalendar().
  daysEl.className = 'calendar-days day-agenda-list';
  daysEl.style.flex = '0 1 auto';
  if (!allDayItems.length) {
    daysEl.innerHTML = '<div class="day-view-empty">Nothing all-day.</div>';
  } else {
    daysEl.innerHTML = allDayItems.map(function (item) {
      const idx = items.indexOf(item);
      const color = item.task.color || item.job.color || '#999';
      // A job task's own name is its board column ("Bid", "Scheduled", …),
      // not the job's — worth showing alongside the job name. A calendar
      // event's task.name is just its title again (see
      // flattenCalendarEventsForRange()), so skip the redundant repeat.
      const sub = (item.task.name && item.task.name !== item.job.name)
        ? '<div class="day-view-item-sub">' + escapeHtml(item.task.name) + '</div>' : '';
      return '<div class="day-view-item" data-day-idx="' + idx + '">' +
        '<span class="day-view-item-swatch" style="background:' + color + ';"></span>' +
        '<div class="day-view-item-text"><div class="day-view-item-title">' + escapeHtml(item.job.name) + '</div>' + sub + '</div>' +
      '</div>';
    }).join('');
    daysEl.querySelectorAll<HTMLElement>('.day-view-item').forEach(function (el) {
      el.addEventListener('click', function () {
        const item = items[parseInt(el.dataset.dayIdx || '', 10)];
        if (!item) return;
        if (item.task.isCalendarEvent) {
          const parsed = parseCalendarEventTaskId(item.task.id);
          openEditCalendarEvent(parsed.eventId, parsed.sourceDate);
        } else {
          calendarOpenJob(item.job.id, item.task.id, item.phaseId);
        }
      });
    });
  }

  // Reuses the desktop week view's own hourly-grid renderer, just given a
  // single-date cellDates array instead of a 7-day week.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const timedRows = items.filter(function (item) { return item.task.time; })
    .map(function (item) { return { task: item.task, job: item.job, start: d }; });
  renderWeekHourGrid([d], timedRows, today);
}

// ===== CALENDAR: BAR DRAG-TO-RESCHEDULE =====
// The data-mutating half of the drag/gesture cluster — see this file's
// header comment for why the purely-visual swipe/wheel navigation stayed
// in index.html.

function handleCalBarMouseDown(e: MouseEvent): void {
  const bar = (e.target as Element).closest('.cal-event-bar') as HTMLElement | null;
  if (!bar) return;
  e.preventDefault();
  const jobId = bar.dataset.calJobId!;
  const taskId = bar.dataset.calTaskId!;

  // Read-only: a linked reference job's id only exists in its home
  // project's jobs array, not this one's — findTask()/findJob() below
  // would find nothing and silently no-op the click. Jump straight to its
  // home project instead of trying to set up a drag for it.
  if (bar.dataset.calLinked === '1') {
    const refJob = getLinkedReferenceJobs().find((j) => j.id === jobId);
    if (refJob) jumpToLinkedJobReference(refJob);
    return;
  }

  let task: CalTask | undefined;
  let job: CalJob | undefined;
  let calEventId: string | null = null;
  let calEventSourceDate: string | null = null;
  let phaseId: string | null = bar.dataset.calPhaseId || null;
  let subPhaseId: string | null = bar.dataset.calSubPhaseId || null;
  if (taskId === DUE_MARKER_TASK_ID) {
    const jf = findJob(jobId);
    if (!jf) return;
    job = jf.job;
    const dueTask = getJobDueMarkerTask(job, phaseId);
    if (!dueTask) return;
    task = dueTask;
  } else if (isCalendarEventTaskId(taskId)) {
    const parsed = parseCalendarEventTaskId(taskId);
    const evt = calendarEvents.find((e) => e.id === parsed.eventId);
    if (!evt) return;
    const occ = getCalendarEventOccurrences(evt, null, null).find((o) => o.sourceDate === parsed.sourceDate);
    if (!occ) return;
    calEventId = parsed.eventId;
    calEventSourceDate = parsed.sourceDate;
    job = { id: 'calevt-job-' + evt.id, name: evt.title };
    task = { id: taskId, name: evt.title, start: toIsoDate(occ.start), finish: toIsoDate(occ.finish) };
  } else if (isCalendarJobSpanTaskId(taskId)) {
    const jf = findJob(jobId);
    if (!jf) return;
    job = jf.job;
    task = { id: taskId, name: job.name, start: bar.dataset.calTaskStart, finish: bar.dataset.calTaskFinish, isJobSpan: true };
    if (!task.start || !task.finish) return;
  } else {
    const found = findTask(jobId, taskId);
    if (!found) return;
    task = found.task;
    job = found.job;
    phaseId = found.phaseId || null;
    subPhaseId = found.subPhaseId || null;
  }
  if (!task || !job) return;

  // Due-marker and calendar-event bars render no drag-zone sub-elements
  // (see renderMonthCalendar/renderWeekCalendar) when they're a single-day
  // marker, so e.target IS the bar and has no data-drag — resolves to
  // 'move'. Multi-day calendar events DO get resize handles like a normal
  // task bar, so this still picks up 'left'/'right' for those.
  const dragType = (e.target as HTMLElement).dataset.drag || 'move';
  const startX = e.clientX;
  const origLeft = parseFloat(bar.style.left);
  const origWidth = parseFloat(bar.style.width);

  const s = new Date(task.start + 'T00:00:00');
  const f = new Date(task.finish + 'T00:00:00');
  const duration = getDaysDiff(s, f) + 1;

  calDragState = {
    jobId, taskId, job, task, bar, dragType, startX, origLeft, origWidth,
    startDateObj: s, finishDateObj: f, duration, phaseId, subPhaseId,
    isCalendarEvent: !!calEventId, calEventId, calEventSourceDate,
    moved: false,
    // Read once here instead of on every mousemove tick (see
    // applyCalBarMouseMove()) — a day cell's width can't change mid-drag,
    // there's nothing to invalidate by caching it up front.
    cellWidth: (document.querySelector('.cal-day') as HTMLElement | null)?.offsetWidth || 1,
  };

  if (dragType === 'move') bar.classList.add('cal-dragging');
  else bar.classList.add('cal-resizing');

  document.addEventListener('mousemove', handleCalBarMouseMove);
  document.addEventListener('mouseup', handleCalBarMouseUp);
}

// rAF-coalesced the same way the Gantt drag handlers are (see
// onBarMoveMove()/applyBarMoveMove()) — a raw mousemove can fire far more
// often than this can usefully repaint, and every tick was doing a
// tooltip innerHTML write immediately followed by an offsetWidth/
// offsetHeight read (see moveTooltip()), forcing a synchronous layout
// flush of the bar's own pending style writes on every single event
// instead of once per frame.
let calBarMoveRafPending = false;
let calBarMoveLatestEvent: MouseEvent | null = null;
function handleCalBarMouseMove(e: MouseEvent): void {
  if (!calDragState) return;
  calBarMoveLatestEvent = e;
  if (calBarMoveRafPending) return;
  calBarMoveRafPending = true;
  requestAnimationFrame(function () {
    calBarMoveRafPending = false;
    if (calDragState && calBarMoveLatestEvent) applyCalBarMouseMove(calBarMoveLatestEvent);
  });
}

function applyCalBarMouseMove(e: MouseEvent): void {
  if (!calDragState) return;
  // Below Editor: never let the drag actually move anything (and never set
  // .moved, so a click-drag attempt just resolves as a plain click on
  // mouseup and opens the event read-only, same as any other click).
  // Blocking this in handleCalBarMouseDown instead would also block the
  // click-to-view path that shares the same mousedown handler.
  // A collapsed job-span bar (see buildCalendarJobRows) represents multiple
  // real tasks merged into one — there's no single task to reschedule, so
  // it's read-only the same way, and a click-drag just opens the job.
  if (!hasMinTier('editor') || (calDragState.task && calDragState.task.isJobSpan)) return;
  const { bar, dragType, startX, origLeft, origWidth, duration, startDateObj, finishDateObj, job, task, cellWidth } = calDragState;
  const deltaX = e.clientX - startX;
  const deltaDays = Math.round(deltaX / cellWidth);

  if (Math.abs(deltaX) > 3) calDragState.moved = true;

  const tt = document.getElementById('tooltip')!;

  if (dragType === 'move') {
    bar.style.left = (origLeft + deltaDays * cellWidth) + 'px';
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const newFinish = new Date(newStart);
    newFinish.setDate(newFinish.getDate() + duration - 1);
    tt.innerHTML = '<div class="tt-title">' + escapeHtml(job.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' + newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' + newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>';
    tt.classList.add('show');
    moveTooltip(e);
  } else if (dragType === 'right') {
    const newDuration = Math.max(1, duration + deltaDays);
    bar.style.width = (origWidth + (newDuration - duration) * cellWidth) + 'px';
    const newFinish = new Date(startDateObj);
    newFinish.setDate(newFinish.getDate() + newDuration - 1);
    tt.innerHTML = '<div class="tt-title">' + escapeHtml(job.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Finish:</span><span class="tt-value">' + newFinish.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' + newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
    tt.classList.add('show');
    moveTooltip(e);
  } else if (dragType === 'left') {
    const newDuration = Math.max(1, duration - deltaDays);
    const clampedDelta = duration - newDuration;
    bar.style.left = (origLeft + clampedDelta * cellWidth) + 'px';
    bar.style.width = (origWidth - clampedDelta * cellWidth) + 'px';
    const newStart = new Date(finishDateObj);
    newStart.setDate(newStart.getDate() - (newDuration - 1));
    tt.innerHTML = '<div class="tt-title">' + escapeHtml(job.name) + '</div>' +
      '<div class="tt-row"><span class="tt-label">Start:</span><span class="tt-value">' + newStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Duration:</span><span class="tt-value">' + newDuration + ' day' + (newDuration > 1 ? 's' : '') + '</span></div>';
    tt.classList.add('show');
    moveTooltip(e);
  }
}

function handleCalBarMouseUp(e: MouseEvent): void {
  if (!calDragState) return;
  const { jobId, taskId, job, bar, dragType, moved, duration, startDateObj, finishDateObj, task, isCalendarEvent, calEventId, calEventSourceDate, phaseId } = calDragState;
  document.removeEventListener('mousemove', handleCalBarMouseMove);
  document.removeEventListener('mouseup', handleCalBarMouseUp);
  bar.classList.remove('cal-dragging', 'cal-resizing');
  hideTooltip();

  const isMobile = window.matchMedia('(max-width: 480px), (max-height: 480px)').matches;

  // A real swipe (see handleCalSwipeEnd, still in index.html) already ran
  // on this same gesture's touchend, which always fires before the
  // mousedown/mouseup pair that gets synthesized from a touch — so by the
  // time we're here, it's already decided this was "swipe the month", not
  // "tap this bar", even when the finger started right on top of a bar.
  // Without this, a calendar full of bars would leave nowhere to swipe from.
  if (isMobile && calSwipeConsumedTap) {
    calSwipeConsumedTap = false;
    calDragState = null;
    return;
  }

  // Otherwise, on phones, always treat this as "open", never "reschedule"
  // — regardless of `moved`. A touchscreen tap wobbles more than a mouse
  // click does, and 3px (the threshold that sets `moved`) is well within
  // normal finger imprecision, so without this a slightly-off tap could
  // silently drag a task/event by a day or two instead of opening it.
  // Rescheduling on mobile goes through that same edit modal's date field
  // instead, which is reliable either way.
  if (!moved || isMobile) {
    if (isCalendarEvent) openEditCalendarEvent(calEventId!, calEventSourceDate || undefined);
    else calendarOpenJob(jobId, taskId, phaseId);
    calDragState = null;
    return;
  }

  const cellWidth = (document.querySelector('.cal-day') as HTMLElement | null)?.offsetWidth || 1;
  const deltaX = e.clientX - calDragState.startX;
  const deltaDays = Math.round(deltaX / cellWidth);

  if (isCalendarEvent) {
    if (deltaDays !== 0) {
      let newStart = new Date(startDateObj);
      let newDuration = duration;
      if (dragType === 'move') {
        newStart.setDate(newStart.getDate() + deltaDays);
      } else if (dragType === 'right') {
        newDuration = Math.max(1, duration + deltaDays);
      } else if (dragType === 'left') {
        newDuration = Math.max(1, duration - deltaDays);
        newStart = new Date(finishDateObj);
        newStart.setDate(newStart.getDate() - (newDuration - 1));
      }
      const newStartStr = toIsoDate(newStart);
      const evt = calendarEvents.find((ev) => ev.id === calEventId);
      if (evt) {
        // A one-off (non-repeating) event just updates directly. A
        // repeating series instead records this as a per-occurrence
        // exception, keyed by the theoretical date it was dragged FROM —
        // the rest of the series is untouched (see getCalendarEventOccurrences).
        if (evt.repeat === 'none') {
          evt.start = newStartStr;
          evt.duration = newDuration;
        } else {
          if (!evt.exceptions) evt.exceptions = {};
          evt.exceptions[calEventSourceDate!] = { start: newStartStr, time: evt.time, duration: newDuration };
        }
        saveCalendarEvents();
        logActivity((dragType === 'move' ? 'rescheduled' : 'resized') + ' calendar event "' + evt.title + '"');
        showToast('Event updated', 'success');
      }
    }
    calDragState = null;
    renderCalendar();
    return;
  }

  if (dragType === 'move' && deltaDays !== 0 && taskId === DUE_MARKER_TASK_ID) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const card = getPhaseCard(job as Job, phaseId);
    if (card) {
      card.due = toIsoDate(newStart);
      saveJobs();
      logActivity('rescheduled due date for job "' + job.name + '"');
      renderGantt();
      renderJobList();
      renderBoard();
      refreshJobFormIfOpen(jobId);
      showToast('Due date updated', 'success');
    }
  } else if (dragType === 'move' && deltaDays !== 0) {
    const newStart = new Date(startDateObj);
    newStart.setDate(newStart.getDate() + deltaDays);
    const newFinish = new Date(newStart);
    newFinish.setDate(newFinish.getDate() + duration - 1);
    task.start = toIsoDate(newStart);
    task.finish = toIsoDate(newFinish);
    saveJobs();
    logActivity('rescheduled job "' + task.name + '"');
    renderGantt();
    renderJobList();
    renderBoard();
    refreshJobFormIfOpen(jobId);
    showToast('Job dates updated', 'success');
  } else if (dragType === 'right') {
    const newDuration = Math.max(1, duration + deltaDays);
    const newFinish = new Date(startDateObj);
    newFinish.setDate(newFinish.getDate() + newDuration - 1);
    task.finish = toIsoDate(newFinish);
    saveJobs();
    logActivity('rescheduled job "' + task.name + '"');
    renderGantt();
    renderJobList();
    renderBoard();
    refreshJobFormIfOpen(jobId);
    showToast('Finish date updated', 'success');
  } else if (dragType === 'left') {
    const newDuration = Math.max(1, duration - deltaDays);
    const newStart = new Date(finishDateObj);
    newStart.setDate(newStart.getDate() - (newDuration - 1));
    task.start = toIsoDate(newStart);
    saveJobs();
    logActivity('rescheduled job "' + task.name + '"');
    renderGantt();
    renderJobList();
    renderBoard();
    refreshJobFormIfOpen(jobId);
    showToast('Start date updated', 'success');
  }

  calDragState = null;
  renderCalendar();
}

// ===== CALENDAR: SWIPE/WHEEL NAVIGATION (mobile swipe + desktop trackpad) =====

function initCalendarDragHandlers(): void {
  const daysEl = document.getElementById('calendarDays');
  if (!daysEl) return;
  daysEl.removeEventListener('mousedown', handleCalBarMouseDown);
  daysEl.addEventListener('mousedown', handleCalBarMouseDown);

  // Swipe left/right to go to next/prev month/day, following the finger
  // live — mobile month & day mode only (see @media(max-width:480px);
  // week view isn't reachable there, and desktop never gets touch events
  // in the first place). Attached to both #calendarDays (the grid/agenda
  // list) and #weekHourSection (day mode's hourly grid below it — see
  // calSwipeTargets()) so a swipe starting on either one navigates and
  // slides both together, not just whichever one the finger happened to
  // land on. passive:true throughout since none of these call
  // preventDefault — see the touch-action:pan-y rule on .calendar-days
  // and .week-hour-section, which is what tells the browser to leave
  // native vertical scroll alone while letting JS own horizontal drags,
  // rather than the two fighting.
  const hourEl = document.getElementById('weekHourSection');
  [daysEl, hourEl].forEach(function (el) {
    if (!el) return;
    el.removeEventListener('touchstart', handleCalSwipeStart);
    el.removeEventListener('touchmove', handleCalSwipeMove);
    el.removeEventListener('touchend', handleCalSwipeEnd);
    el.addEventListener('touchstart', handleCalSwipeStart, { passive: true });
    el.addEventListener('touchmove', handleCalSwipeMove, { passive: true });
    el.addEventListener('touchend', handleCalSwipeEnd, { passive: true });
    // Desktop equivalent of the touch swipe above — trackpad two-finger
    // horizontal scroll pages the calendar, same gesture as swiping on a
    // phone. { passive: false } since handleCalWheel calls preventDefault
    // on a horizontal gesture (otherwise a trackpad swipe can also
    // trigger the browser's own back/forward navigation).
    el.removeEventListener('wheel', handleCalWheel);
    el.addEventListener('wheel', handleCalWheel, { passive: false });
  });
}

// The elements a swipe drags/slides together — just #calendarDays in month
// mode, plus #weekHourSection in day mode so the hourly grid moves in
// lockstep with the all-day list above it (same day, one gesture).
function calSwipeTargets(): HTMLElement[] {
  const daysEl = document.getElementById('calendarDays') as HTMLElement | null;
  if (!daysEl) return [];
  if (calendarViewMode !== 'day') return [daysEl];
  const hourEl = document.getElementById('weekHourSection') as HTMLElement | null;
  return hourEl ? [daysEl, hourEl] : [daysEl];
}

const CAL_SWIPE_THRESHOLD = 60;
let calSwipeStartX: number | null = null;
let calSwipeStartY: number | null = null;
let calSwipeTracking = false;
// Set when a real drag (swipe or an aborted one) was recognized, so the
// mousedown/mouseup pair synthesized from the same touch — which fires
// right after touchend — knows not to also open whatever bar the finger
// happened to land on. Read by handleCalBarMouseUp() earlier in this
// file — a plain module-scoped `let` works for that (unlike the
// cross-script `var`s elsewhere in this file) since both the reader and
// the only writer (handleCalSwipeEnd() below) live in this same module.
let calSwipeConsumedTap = false;

function handleCalSwipeStart(e: TouchEvent): void {
  // Month and day mode only — week's own hourly grid isn't reachable on
  // mobile in the first place (see the mobile-only #weekHourSection hide
  // rule), so there's nothing here to swipe through in that mode.
  if ((calendarViewMode !== 'month' && calendarViewMode !== 'day') || e.touches.length !== 1) { calSwipeStartX = null; return; }
  calSwipeStartX = e.touches[0].clientX;
  calSwipeStartY = e.touches[0].clientY;
  calSwipeTracking = false;
}

function handleCalSwipeMove(e: TouchEvent): void {
  if (calSwipeStartX == null || e.touches.length !== 1) return;
  const touch = e.touches[0];
  const deltaX = touch.clientX - calSwipeStartX;
  const deltaY = touch.clientY - (calSwipeStartY as number);
  const targets = calSwipeTargets();
  if (!targets.length) return;

  if (!calSwipeTracking) {
    // Wait for enough movement to tell a horizontal swipe apart from a
    // vertical scroll before committing to either — once decided, a
    // vertical gesture is left alone for native scroll to handle, exactly
    // as if this listener wasn't here at all.
    if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) return;
    if (Math.abs(deltaY) > Math.abs(deltaX)) { calSwipeStartX = null; return; }
    calSwipeTracking = true;
    targets.forEach(function (el) { el.style.transition = 'none'; });
  }
  targets.forEach(function (el) { el.style.transform = 'translateX(' + deltaX + 'px)'; });
}

// Slides the outgoing month/day out and the incoming one in as ONE
// continuous motion, rather than finishing the exit before even starting
// the entrance (the old approach: animate the live element to outX, wait
// for that transition to end, THEN swap its content and animate it back
// in from the opposite edge — two chained transitions back to back read
// as a pause in the middle instead of a single seamless slide).
//
// The live element can't play both halves at once (it only holds one
// month's content at a time), so a throwaway "ghost" — a snapshot clone
// of the CURRENT (outgoing) content, pinned via position:fixed exactly
// over the live element's on-screen rect — plays the exit while the live
// element is immediately repointed to the new month/day and plays the
// entrance. Both transitions are started in the same synchronous block,
// so they run in lockstep and cross paths mid-slide instead of queuing.
//
//   targets        - the live elements (calSwipeTargets()) to swap/slide
//   startTransform - translateX (px) the ghost continues FROM; 0 for a
//                    fresh/at-rest trigger (wheel), or the drag's own
//                    live deltaX to pick up exactly where a finger left it
//   outX           - the far edge (±width) both the ghost's exit and the
//                    live element's entrance are measured against
//   goNext         - true = next month/day, false = previous
//   duration       - CSS transition duration string, e.g. '0.2s'
function slideCalendarTargets(targets: HTMLElement[], startTransform: number, outX: number, goNext: boolean, duration: string): void {
  if (!targets.length) { if (goNext) calendarNext(); else calendarPrev(); return; }

  const ghosts = targets.map(function (el) {
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(function (child) { child.removeAttribute('id'); });
    ghost.style.position = 'fixed';
    ghost.style.top = rect.top + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.margin = '0';
    ghost.style.zIndex = '400';
    ghost.style.pointerEvents = 'none';
    ghost.style.transition = 'none';
    ghost.style.transform = 'translateX(' + startTransform + 'px)';
    document.body.appendChild(ghost);
    return ghost;
  });

  if (goNext) calendarNext(); else calendarPrev();
  // calendarNext()/calendarPrev() re-render the same live element(s)'
  // contents in place — re-query rather than reusing `targets` in case
  // day mode's own element set changed (e.g. #weekHourSection).
  const freshTargets = calSwipeTargets();
  const freshDaysEl = freshTargets[0];
  if (!freshDaysEl) { ghosts.forEach(function (g) { g.remove(); }); return; }

  // Jump the now-new-content live element out to the opposite edge with
  // no transition (invisible — the ghost, opaque and higher z-index,
  // still covers this same spot until the animation below starts), then
  // let it and the ghost animate toward their final positions together.
  freshTargets.forEach(function (el) {
    el.style.transition = 'none';
    el.style.transform = 'translateX(' + (-outX) + 'px)';
  });
  void freshDaysEl.offsetHeight; // force layout so the jump above lands before the transitions below start
  freshTargets.forEach(function (el) {
    el.style.transition = 'transform ' + duration + ' ease';
    el.style.transform = 'translateX(0)';
  });
  ghosts.forEach(function (g) {
    g.style.transition = 'transform ' + duration + ' ease';
    g.style.transform = 'translateX(' + outX + 'px)';
  });

  freshDaysEl.addEventListener('transitionend', function cleanup() {
    freshDaysEl.removeEventListener('transitionend', cleanup);
    ghosts.forEach(function (g) { g.remove(); });
  });
}

function handleCalSwipeEnd(e: TouchEvent): void {
  const wasTracking = calSwipeTracking;
  calSwipeTracking = false;
  if (calSwipeStartX == null) return;
  const touch = e.changedTouches[0];
  const deltaX = touch.clientX - calSwipeStartX;
  calSwipeStartX = null;
  if (!wasTracking) return;

  // Real dragging happened either way (whether or not it clears the
  // threshold below) — not a clean tap, so the bar underneath shouldn't
  // open once the synthesized mouseup for this same touch fires.
  calSwipeConsumedTap = true;

  const targets = calSwipeTargets();
  if (!targets.length) return;
  const daysEl = targets[0];

  if (Math.abs(deltaX) < CAL_SWIPE_THRESHOLD) {
    // Didn't clear the threshold — spring back to where it started, no
    // month/day change.
    targets.forEach(function (el) {
      el.style.transition = 'transform 0.2s ease';
      el.style.transform = 'translateX(0)';
    });
    return;
  }

  // Continue in the SAME direction the drag was already moving (a past
  // bug derived this from a separate "dir" flag that ended up with the
  // opposite sign of deltaX, so the grid — already sitting at a negative
  // transform after following a leftward drag — snapped back positive
  // right as you let go, instead of continuing left).
  const width = daysEl.getBoundingClientRect().width || window.innerWidth;
  const outX = deltaX < 0 ? -width : width;
  const goNext = deltaX < 0; // swiping left continues left — next month/day
  slideCalendarTargets(targets, deltaX, outX, goNext, '0.2s');
}

// Same slide-out/slide-in feel as the touch swipe above, but starting
// fresh from rest instead of continuing a live drag position — this is
// triggered by a discrete trackpad/wheel gesture (handleCalWheel below),
// not a finger the user is actively tracking on screen.
function animateCalendarWheelChange(goNext: boolean): void {
  const targets = calSwipeTargets();
  if (!targets.length) { if (goNext) calendarNext(); else calendarPrev(); return; }
  const daysEl = targets[0];
  const width = daysEl.getBoundingClientRect().width || window.innerWidth;
  const outX = goNext ? -width : width;
  slideCalendarTargets(targets, 0, outX, goNext, '0.18s');
}

// Desktop equivalent of the mobile touch-swipe (handleCalSwipeStart/Move/
// End above) — trackpad two-finger horizontal scroll (or a mouse wheel
// already reporting deltaX, e.g. shift+wheel) pages the calendar
// forward/back. Wheel events fire many times per physical gesture, so
// this accumulates deltaX and only acts once past a threshold, then
// ignores further deltas for a short cooldown so one continued swipe
// doesn't flip through several pages at once.
let calWheelAccum = 0;
let calWheelCooldown = false;
let calWheelIdleTimer: ReturnType<typeof setTimeout> | null = null;
const CAL_WHEEL_THRESHOLD = 50;
function handleCalWheel(e: WheelEvent): void {
  // Only take over a clearly-horizontal gesture — leave a normal
  // vertical scroll/zoom wheel alone entirely (it still needs to reach
  // the hourly grid's own vertical scroll in week/day mode).
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  if (calWheelCooldown) return;
  calWheelAccum += e.deltaX;
  if (calWheelIdleTimer !== null) clearTimeout(calWheelIdleTimer);
  calWheelIdleTimer = setTimeout(function () { calWheelAccum = 0; }, 200);
  if (Math.abs(calWheelAccum) < CAL_WHEEL_THRESHOLD) return;
  const goNext = calWheelAccum > 0;
  calWheelAccum = 0;
  calWheelCooldown = true;
  setTimeout(function () { calWheelCooldown = false; }, 450);
  animateCalendarWheelChange(goNext);
}

export {
  isCalendarEventTaskId,
  parseCalendarEventTaskId,
  defaultRepeatUntil,
  getCalendarEventOccurrences,
  isCalendarEventVisibleToMe,
  flattenCalendarEventsForRange,
  ensureCalendarEventIds,
  openAddCalendarEvent,
  openEditCalendarEvent,
  closeCalendarEventModal,
  toggleRepeatUntilField,
  toggleCalendarEventVisibilityFields,
  collectCalendarEventVisibilityMembers,
  toggleCalendarEventColorPanel,
  updateCalendarEventColorSwatch,
  buildCalendarEventColorPresets,
  saveCalendarEventFromModal,
  deleteCalendarEventFromModal,
  setCalendarView,
  calendarPrev,
  calendarNext,
  calendarToday,
  calendarExitDayView,
  renderCalendar,
  buildCalBarHtml,
  renderMonthCalendar,
  renderWeekCalendar,
  renderWeekHourGrid,
  calendarOpenJob,
  getScheduledItemsForDate,
  openDayView,
  renderDayCalendarView,
  handleCalBarMouseDown,
  handleCalBarMouseMove,
  applyCalBarMouseMove,
  handleCalBarMouseUp,
  initCalendarDragHandlers,
  calSwipeTargets,
  handleCalSwipeStart,
  handleCalSwipeMove,
  slideCalendarTargets,
  handleCalSwipeEnd,
  animateCalendarWheelChange,
  handleCalWheel,
};
