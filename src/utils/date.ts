// Date/time helpers. toIsoDate() and addMonths() below carry real
// production-bug history — see their own comments — so changes here
// warrant extra care; a regression has bitten real users twice already.

export function getDaysDiff(d1: Date, d2: Date): number {
  return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}

// .toISOString().split('T')[0] always formats in UTC, but every date in
// this app is parsed as LOCAL midnight (new Date(x + 'T00:00:00')) and
// manipulated with local-time methods (setDate/setMonth/etc) — for any
// user in a UTC-ahead timezone (most of Europe/Asia/Australia), local
// midnight falls on the PREVIOUS UTC day, so toISOString() silently wrote
// back a date one day earlier than what a drag/resize's own tooltip had
// just shown. Every date-to-string call site in the app (Gantt/Calendar
// drag-resize, recurring event expansion, day-cell dataset.date, etc.)
// now goes through this instead — formats using the Date's own local
// getters, so what's on screen is what gets saved.
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// Adding N months via a naive date.setMonth(date.getMonth() + N) overflows
// into a LATER month than intended whenever the target month is shorter
// than the current day-of-month — e.g. Aug 31 + 1 month lands on Oct 1,
// not Sep 30, silently skipping September entirely. That bit both the
// Calendar's Prev/Next navigation (skipping a whole month whenever the
// view date fell on the 29th-31st) and monthly-repeating events (an
// event anchored on the 31st permanently drifted to "the 3rd" of every
// following month, since each iteration compounds the same overflow).
// Clamping to the target month's actual last day — the same "recur near
// the end of short months" behavior Google Calendar/Outlook use — fixes
// both call sites with one shared helper instead of patching the
// overflow differently in each place. Returns a new Date; never mutates
// the one passed in.
export function addMonths(date: Date, delta: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1); // land on a date that exists in every month before changing month
  d.setMonth(d.getMonth() + delta);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

// Business-day (Mon-Fri) versions of the above, used only for the Job
// Manager's Days field — the Gantt itself still positions/sizes bars by
// calendar days, since a bar's width needs to represent real elapsed time
// on the timeline regardless of weekends.
export function getBusinessDaysDiff(d1: Date, d2: Date): number {
  const d = new Date(d1); d.setHours(0, 0, 0, 0);
  const end = new Date(d2); end.setHours(0, 0, 0, 0);
  if (d > end) return 0;
  let count = 0;
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

export function addBusinessDays(startDate: Date, days: number): Date {
  const d = new Date(startDate);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  let count = 1;
  while (count < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d;
}

// '14:30' -> '2:30 PM'. Calendar events store time as a plain 24h string
// from <input type="time">; empty/invalid input just renders nothing.
export function formatTimeLabel(hhmm: string | null | undefined): string {
  if (!hhmm) return '';
  const parts = hhmm.split(':');
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + period;
}

// 'HH:MM' -> minutes since midnight, or null if blank/invalid. Used to
// position timed calendar events in the week view's hourly grid.
export function timeToMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const parts = hhmm.split(':');
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
