// Calendar, moved out of index.html across Phase 5 of the architecture
// roadmap in deliberately narrow, separately-verified slices:
//   Phase 5a — recurrence-expansion / event-visibility logic (this
//     file's original content): pure, no DOM dependency, easy to test
//     directly.
//   Phase 5b — the calendar-event modal (openAddCalendarEvent and
//     friends): same pattern as Board's card modal (Phase 4d), new
//     dedicated tests alongside this move.
//   Phase 5c — view navigation + the render dispatcher (setCalendarView/
//     calendarPrev/calendarNext/calendarToday/calendarExitDayView/
//     renderCalendar itself). renderMonthCalendar()/renderWeekCalendar()/
//     renderDayCalendarView() (the actual DOM-building) stayed in
//     index.html at the time, for a later, separately-scoped follow-up —
//     renderCalendar() just dispatches to them by name, so moving the
//     dispatcher didn't require moving what it dispatches to yet.
//   Phase 5d — the render engine itself: buildCalBarHtml()/
//     renderMonthCalendar()/renderWeekCalendar()/renderWeekHourGrid()/
//     calendarOpenJob()/getScheduledItemsForDate()/openDayView()/
//     renderDayCalendarView(). The swipe/wheel/mouse-drag gesture cluster
//     (initCalendarDragHandlers and everything it wires up — calSwipe*/
//     handleCalBar*/animateCalendarWheelChange/handleCalWheel) is
//     deliberately NOT part of this move: it's untested, timing-sensitive
//     touch/mouse code in the same category as Gantt's own drag mechanics
//     (deliberately last of the three views for the same reason), and
//     stays in index.html until it has dedicated test coverage of its
//     own, same discipline as everything else in this file.
//
// buildCalendarJobRows()/isCalendarJobSpanTaskId() are deliberately NOT
// part of this file either, despite living right next to functions that
// did move — they depend on getHiddenTaskOrders()/
// forEachVisibleSubUnit()/buildSubUnitClusters(), which are really
// Gantt's own task-clustering logic reused here, not Calendar-specific.
// Moving them now would mean either dragging Gantt's clustering code
// along for the ride or leaving a half-moved shared dependency — cleaner
// to revisit once Gantt itself is being extracted. Declared as ambient
// globals below since Phase 5d's render functions call them directly.
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
import type { CalendarEvent, CalendarEventOccurrence } from '../core/types';
import { addMonths, toIsoDate, formatTimeLabel, timeToMinutes } from '../utils/date';
import { genId } from '../utils/id';
import { escapeHtml } from '../utils/html';
import { darkenColor, softenColor } from '../utils/color';

declare global {
  // eslint-disable-next-line no-var
  var calendarEvents: CalendarEvent[];
  // eslint-disable-next-line no-var
  var viewAsUsername: string | null;
  // eslint-disable-next-line no-var
  var editingCalendarEventId: string | null;
  // eslint-disable-next-line no-var
  var calendarEventTargetDate: string | null;
  // eslint-disable-next-line no-var
  var cachedUserRoster: { username: string; displayName: string }[] | null;
  // eslint-disable-next-line no-var
  var COLOR_PRESETS: string[];
  // eslint-disable-next-line no-var
  var activeProjectId: string | null;
  // eslint-disable-next-line no-var
  var calendarViewDate: Date;
  // eslint-disable-next-line no-var
  var calendarViewMode: string;
  // eslint-disable-next-line no-var
  var CAL_BAR_H: number;
  // eslint-disable-next-line no-var
  var CAL_BAR_GAP: number;
  // eslint-disable-next-line no-var
  var CAL_DAYNUM_H: number;
  function getEffectiveRole(): string;
  function getStoredUsername(): string;
  function openModal(id: string): void;
  function closeModal(id: string, onClosed?: () => void): void;
  function ensureUserRosterLoaded(): Promise<void>;
  function saveCalendarEvents(): void;
  function showToast(text: string, kind?: string): void;
  function logActivity(text: string): void;
  function hasMinTier(tier: string): boolean;
  function deleteCalendarEventFromShared(projectId: string | null, eventId: string): void;
  function msDropdownLabelText(count: number, emptyText?: string): string;
  function getVisibleJobs(): CalJob[];
  function flattenJobs(jobsArr: CalJob[]): CalRow[];
  function buildCalendarJobRows(jobsArr: CalJob[]): CalRow[];
  function isTaskFinished(job: CalJob, task: CalTask): boolean;
  function isDarkColor(hex: string): boolean;
  function editJob(jobId: string, phaseId?: string | null): void;
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
};
