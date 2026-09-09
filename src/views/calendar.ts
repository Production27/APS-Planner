// Calendar, moved out of index.html across Phase 5 of the architecture
// roadmap, starting with the same "safest slice first" judgment applied
// to Board (Phase 3's model layer, Phase 4a's already-tested drag code):
// this file's initial content is the recurrence-expansion / event-
// visibility logic — pure, no DOM dependency, easy to test directly —
// NOT renderCalendar()/renderMonthCalendar()/renderWeekCalendar() (the
// actual DOM-building, and the swipe/animation drag handlers), which
// are at least as dense and entangled as Board's renderBoard() was and
// stay in index.html for a later, separately-scoped follow-up once they
// have their own test coverage.
//
// buildCalendarJobRows()/isCalendarJobSpanTaskId() are deliberately NOT
// part of this slice either, despite living right next to the functions
// below in index.html — they depend on getHiddenTaskOrders()/
// forEachVisibleSubUnit()/buildSubUnitClusters(), which are really
// Gantt's own task-clustering logic reused here, not Calendar-specific.
// Moving them now would mean either dragging Gantt's clustering code
// along for the ride or leaving a half-moved shared dependency — cleaner
// to revisit once Gantt itself is being extracted.
//
// getEffectiveRole()/getStoredUsername() stay in index.html on purpose
// (session/role plumbing shared across the whole app, not Calendar-
// specific) and are referenced below as ambient globals — an ordinary
// top-level `function` declaration already attaches to `window` on its
// own (unlike `let`/`const`), so nothing about those needed to change.
import type { CalendarEvent, CalendarEventOccurrence } from '../core/types';
import { addMonths, toIsoDate } from '../utils/date';
import { genId } from '../utils/id';

declare global {
  // eslint-disable-next-line no-var
  var calendarEvents: CalendarEvent[];
  // eslint-disable-next-line no-var
  var viewAsUsername: string | null;
  function getEffectiveRole(): string;
  function getStoredUsername(): string;
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

export {
  isCalendarEventTaskId,
  parseCalendarEventTaskId,
  defaultRepeatUntil,
  getCalendarEventOccurrences,
  isCalendarEventVisibleToMe,
  flattenCalendarEventsForRange,
  ensureCalendarEventIds,
};
