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
//     renderDayCalendarView() (the actual DOM-building) and the swipe/
//     animation drag handlers are at least as dense and entangled as
//     Board's renderBoard() was, and stay in index.html for a later,
//     separately-scoped follow-up once they have their own test coverage
//     — renderCalendar() just dispatches to them by name, so moving the
//     dispatcher doesn't require moving what it dispatches to.
//
// buildCalendarJobRows()/isCalendarJobSpanTaskId() are deliberately NOT
// part of this file either, despite living right next to functions that
// did move — they depend on getHiddenTaskOrders()/
// forEachVisibleSubUnit()/buildSubUnitClusters(), which are really
// Gantt's own task-clustering logic reused here, not Calendar-specific.
// Moving them now would mean either dragging Gantt's clustering code
// along for the ride or leaving a half-moved shared dependency — cleaner
// to revisit once Gantt itself is being extracted.
//
// getEffectiveRole()/getStoredUsername()/openModal()/closeModal()/
// ensureUserRosterLoaded()/saveCalendarEvents()/renderMonthCalendar()/
// renderWeekCalendar()/renderDayCalendarView()/showToast()/logActivity()/
// hasMinTier()/deleteCalendarEventFromShared()/msDropdownLabelText() stay
// in index.html on purpose (session/role plumbing, modal-chrome plumbing
// shared by every modal in the app, or the dense per-mode render
// functions this file's own renderCalendar() dispatches to) and are
// referenced below as ambient globals — an ordinary top-level `function`
// declaration already attaches to `window` on its own (unlike
// `let`/`const`), so nothing about those needed to change.
import type { CalendarEvent, CalendarEventOccurrence } from '../core/types';
import { addMonths, toIsoDate } from '../utils/date';
import { genId } from '../utils/id';
import { escapeHtml } from '../utils/html';

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
  function getEffectiveRole(): string;
  function getStoredUsername(): string;
  function openModal(id: string): void;
  function closeModal(id: string, onClosed?: () => void): void;
  function ensureUserRosterLoaded(): Promise<void>;
  function saveCalendarEvents(): void;
  function renderMonthCalendar(): void;
  function renderWeekCalendar(): void;
  function renderDayCalendarView(): void;
  function showToast(text: string, kind?: string): void;
  function logActivity(text: string): void;
  function hasMinTier(tier: string): boolean;
  function deleteCalendarEventFromShared(projectId: string | null, eventId: string): void;
  function msDropdownLabelText(count: number, emptyText?: string): string;
}

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
function flattenCalendarEventsForRange(rangeStart: Date | null, rangeEnd: Date | null): { job: { id: string; name: string; color?: string; archived: boolean }; task: Record<string, unknown>; start: Date; finish: Date }[] {
  const rows: { job: { id: string; name: string; color?: string; archived: boolean }; task: Record<string, unknown>; start: Date; finish: Date }[] = [];
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

function openAddCalendarEvent(dateStr: string, timeStr: string): void {
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
};
