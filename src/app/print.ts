// Print / Save as PDF (roadmap item A3, part 2). The live Gantt only
// renders the rows and days currently on screen and scrolls sideways, so
// printing it directly gives a clipped, partial chart. Instead this builds
// a self-contained, print-only document (landscape, fixed date window,
// every visible job) in a hidden iframe and opens the browser's print
// dialog on it — which also offers "Save as PDF". Two layouts:
//  - Gantt: one row per job (or per phase for phased jobs), task
//    segments in their own colors, weekends shaded, a today line, and a
//    color key. Rows repeat the date header on every printed page.
//  - Calendar: one month grid listing each day's scheduled work and
//    calendar events.
// Uses the same job set as Export (jobsToExport(): visible to this user,
// no linked references, archived excluded).
import type { Job, Task } from '../core/types';
import { getJobPhases, getPhaseSubUnits } from '../core/models';
import { jobsToExport, realTasks, validDate } from './export';
import { getActiveProject } from './project';
import { getCalendarEventOccurrences, isCalendarEventVisibleToMe } from '../views/calendar';
import { openModal, closeModal, showToast } from '../utils/ui';
import { escapeHtml } from '../utils/html';
import { toIsoDate } from '../utils/date';

interface PrintSegment { name: string; color: string; start: Date; finish: Date; }
interface PrintRow { label: string; sublabel: string; jobColor: string; segments: PrintSegment[]; }

const DAY_MS = 86400000;

function parseDay(s: string): Date { return new Date(s + 'T00:00:00'); }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // Monday
function dayDiff(a: Date, b: Date): number { return Math.round((b.getTime() - a.getTime()) / DAY_MS); }
function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string { return d.toLocaleDateString(undefined, opts); }

// One row per job, or one per phase when a job is split into several —
// the same grouping the Gantt's own Jobs view uses.
function buildRows(): PrintRow[] {
  const rows: PrintRow[] = [];
  jobsToExport(false).forEach((job: Job) => {
    const phases = getJobPhases(job);
    phases.forEach((phase) => {
      const segments: PrintSegment[] = [];
      getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t: Task) => {
        const s = validDate(t.start), f = validDate(t.finish);
        if (!s || !f) return;
        segments.push({ name: t.name || 'Task', color: (t.color as string) || job.color || '#90a4ae', start: parseDay(s), finish: parseDay(f) });
      }));
      if (!segments.length) return;
      segments.sort((a, b) => a.start.getTime() - b.start.getTime());
      rows.push({
        label: job.name,
        sublabel: phases.length > 1 && !phase.isDefault ? phase.name : '',
        jobColor: job.color || '#90a4ae',
        segments,
      });
    });
  });
  return rows;
}

const PRINT_CSS = `
  @page { size: landscape; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 10px/1.35 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1f2937; }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1f2937; padding-bottom: 6px; margin-bottom: 8px; }
  .doc-head h1 { font-size: 16px; margin: 0; }
  .doc-head .sub { font-size: 11px; color: #4b5563; }
  .doc-head .meta { text-align: right; font-size: 9px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .g th, .g td { border-bottom: 1px solid #e5e7eb; padding: 0; }
  table, th, td { font-size: 10px; }
  .g .lbl { width: 190px; padding: 3px 6px; border-left: 4px solid transparent; overflow: hidden; vertical-align: middle; }
  .g th.lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: #4b5563; }
  .g .lbl b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10px; }
  .g .lbl small { display: block; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 8.5px; }
  .g .track { position: relative; height: 26px; }
  .g thead .track { height: 30px; }
  .wk { position: absolute; top: 0; height: 14px; font-size: 9px; font-weight: 700; color: #3949ab; padding-left: 3px; border-left: 1px solid #c7cbe0; white-space: nowrap; overflow: hidden; }
  .dn { position: absolute; top: 15px; height: 15px; font-size: 8px; color: #6b7280; text-align: center; }
  .dn.we { color: #9ca3af; }
  .dn.today { color: #c62828; font-weight: 700; }
  .shade { position: absolute; top: 0; bottom: 0; background: #f3f4f6; }
  .wkline { position: absolute; top: 0; bottom: 0; border-left: 1px solid #e5e7eb; }
  .todayline { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid #e53935; z-index: 3; }
  .seg { position: absolute; top: 5px; height: 16px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.25); z-index: 2; overflow: hidden; white-space: nowrap; font-size: 8.5px; font-weight: 600; line-height: 14px; padding: 0 3px; color: #1f2937; }
  .clip-l { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left-style: dashed; }
  .clip-r { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right-style: dashed; }
  .key { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 9px; color: #374151; }
  .key i { display: inline-block; width: 12px; height: 9px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.25); margin-right: 4px; vertical-align: -1px; }
  .empty { padding: 30px; text-align: center; color: #6b7280; font-size: 12px; }
  .cal th { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: #4b5563; padding: 4px; border: 1px solid #d1d5db; background: #f3f4f6; }
  .cal td { vertical-align: top; border: 1px solid #d1d5db; height: 92px; padding: 3px; }
  .cal td.out { background: #f9fafb; color: #9ca3af; }
  .cal td.today { outline: 2px solid #3949ab; outline-offset: -2px; }
  .cal .dnum { font-weight: 700; font-size: 10px; margin-bottom: 2px; }
  .cal .it { font-size: 8.5px; line-height: 1.25; margin: 1px 0; padding: 1px 3px; border-radius: 2px; border-left: 3px solid #999; background: #f3f4f6; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .cal .it.ev { border-left-color: #7e57c2; background: #f3effc; }
`;

function docHead(title: string, subtitle: string): string {
  const project = getActiveProject();
  const projectName = project && project.name ? String(project.name) : 'TeamSync';
  return '<div class="doc-head"><div><h1>' + escapeHtml(projectName) + ' — ' + escapeHtml(title) + '</h1>' +
    '<div class="sub">' + escapeHtml(subtitle) + '</div></div>' +
    '<div class="meta">Printed ' + escapeHtml(new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })) + '<br>TeamSync</div></div>';
}

export function buildGanttPrintHtml(windowStart: Date, weeks: number): string {
  const start = startOfWeek(windowStart);
  const days = weeks * 7;
  const end = addDays(start, days - 1);
  const pct = (d: number) => (d / days * 100).toFixed(4) + '%';
  const today = new Date(new Date().toDateString());
  const todayIdx = dayDiff(start, today);
  const showDayNums = days <= 56;

  // Background layers shared by header and every row: weekend shading,
  // week separators, today line.
  let grid = '';
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (d.getDay() === 0 || d.getDay() === 6) grid += '<div class="shade" style="left:' + pct(i) + ';width:' + pct(1) + '"></div>';
    if (i % 7 === 0) grid += '<div class="wkline" style="left:' + pct(i) + '"></div>';
  }
  if (todayIdx >= 0 && todayIdx < days) grid += '<div class="todayline" style="left:' + pct(todayIdx + 0.5) + '"></div>';

  let header = grid;
  for (let w = 0; w < weeks; w++) {
    header += '<div class="wk" style="left:' + pct(w * 7) + ';width:' + pct(7) + '">' + escapeHtml(fmt(addDays(start, w * 7), { month: 'short', day: 'numeric' })) + '</div>';
  }
  if (showDayNums) {
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const cls = 'dn' + (d.getDay() === 0 || d.getDay() === 6 ? ' we' : '') + (i === todayIdx ? ' today' : '');
      header += '<div class="' + cls + '" style="left:' + pct(i) + ';width:' + pct(1) + '">' + d.getDate() + '</div>';
    }
  }

  const keyColors = new Map<string, string>();
  const rows = buildRows().filter((r) => r.segments.some((s) => s.finish >= start && s.start <= end));
  let body = '';
  rows.forEach((r) => {
    let segs = '';
    r.segments.forEach((s) => {
      if (s.finish < start || s.start > end) return;
      if (!keyColors.has(s.name)) keyColors.set(s.name, s.color);
      const clipL = s.start < start, clipR = s.finish > end;
      const a = Math.max(0, dayDiff(start, s.start));
      const b = Math.min(days - 1, dayDiff(start, s.finish));
      const label = (b - a + 1) * (100 / days) > 4 ? escapeHtml(s.name) : '';
      segs += '<div class="seg' + (clipL ? ' clip-l' : '') + (clipR ? ' clip-r' : '') + '" style="left:' + pct(a) + ';width:' + pct(b - a + 1) + ';background:' + escapeHtml(s.color) + '" title="' + escapeHtml(s.name) + '">' + label + '</div>';
    });
    const first = r.segments[0].start, last = r.segments.reduce((m, s) => (s.finish > m ? s.finish : m), r.segments[0].finish);
    const range = fmt(first, { month: 'short', day: 'numeric' }) + ' – ' + fmt(last, { month: 'short', day: 'numeric' });
    body += '<tr><td class="lbl" style="border-left-color:' + escapeHtml(r.jobColor) + '"><b>' + escapeHtml(r.label) + '</b><small>' +
      escapeHtml((r.sublabel ? r.sublabel + ' · ' : '') + range) + '</small></td><td><div class="track">' + grid + segs + '</div></td></tr>';
  });

  const subtitle = fmt(start, { month: 'short', day: 'numeric', year: 'numeric' }) + ' – ' + fmt(end, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + rows.length + (rows.length === 1 ? ' row' : ' rows');
  let key = '';
  keyColors.forEach((color, name) => { key += '<span><i style="background:' + escapeHtml(color) + '"></i>' + escapeHtml(name) + '</span>'; });

  return '<!doctype html><html><head><meta charset="utf-8"><title>Gantt chart</title><style>' + PRINT_CSS + '</style></head><body>' +
    docHead('Gantt chart', subtitle) +
    (rows.length
      ? '<table class="g"><thead><tr><th class="lbl" style="text-align:left">Job</th><th><div class="track">' + header + '</div></th></tr></thead><tbody>' + body + '</tbody></table>' +
        (key ? '<div class="key">' + key + '</div>' : '')
      : '<div class="empty">Nothing is scheduled in this date range.</div>') +
    '</body></html>';
}

export function buildCalendarPrintHtml(year: number, month: number): string {
  const first = new Date(year, month, 1);
  const gridStart = addDays(first, -first.getDay()); // Sunday, matching the Calendar view
  const lastOfMonth = new Date(year, month + 1, 0);
  const weeks = Math.ceil((dayDiff(gridStart, lastOfMonth) + 1) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);
  const today = toIsoDate(new Date());

  const byDay = new Map<string, string[]>();
  const push = (d: Date, html: string) => { const k = toIsoDate(d); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k)!.push(html); };

  buildRows().forEach((r) => r.segments.forEach((s) => {
    for (let d = new Date(Math.max(s.start.getTime(), gridStart.getTime())); d <= s.finish && d <= gridEnd; d = addDays(d, 1)) {
      push(d, '<div class="it" style="border-left-color:' + escapeHtml(r.jobColor) + ';background:' + escapeHtml(s.color) + '33">' +
        escapeHtml(r.label + (r.sublabel ? ' (' + r.sublabel + ')' : '') + ' · ' + s.name) + '</div>');
    }
  }));
  (calendarEvents || []).filter(isCalendarEventVisibleToMe).forEach((evt) => {
    getCalendarEventOccurrences(evt, gridStart, gridEnd).forEach((occ) => {
      for (let d = new Date(occ.start); d <= occ.finish && d <= gridEnd; d = addDays(d, 1)) {
        if (d < gridStart) continue;
        push(d, '<div class="it ev">' + escapeHtml((occ.time ? occ.time + ' ' : '') + evt.title) + '</div>');
      }
    });
  });

  let rowsHtml = '';
  for (let w = 0; w < weeks; w++) {
    rowsHtml += '<tr>';
    for (let i = 0; i < 7; i++) {
      const d = addDays(gridStart, w * 7 + i);
      const k = toIsoDate(d);
      const cls = (d.getMonth() !== month ? 'out' : '') + (k === today ? ' today' : '');
      rowsHtml += '<td class="' + cls.trim() + '"><div class="dnum">' + d.getDate() + '</div>' + (byDay.get(k) || []).join('') + '</td>';
    }
    rowsHtml += '</tr>';
  }
  const dows = [0, 1, 2, 3, 4, 5, 6].map((i) => '<th>' + escapeHtml(fmt(addDays(gridStart, i), { weekday: 'short' })) + '</th>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Calendar</title><style>' + PRINT_CSS + '</style></head><body>' +
    docHead('Calendar', fmt(first, { month: 'long', year: 'numeric' })) +
    '<table class="cal"><thead><tr>' + dows + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></body></html>';
}

// Renders `html` into a hidden iframe and opens the print dialog on it.
function printHtml(html: string): void {
  const old = document.getElementById('printFrame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'printFrame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  // Give the frame a tick to lay out before printing.
  setTimeout(() => {
    try { frame.contentWindow!.focus(); frame.contentWindow!.print(); }
    catch (e) { showToast('Could not open the print dialog', 'error'); }
  }, 150);
}

// ===== Print dialog (#printModal in index.html) =====
export function openPrintModal(): void {
  const startInput = document.getElementById('printGanttStart') as HTMLInputElement;
  if (startInput && !startInput.value) startInput.value = toIsoDate(addDays(startOfWeek(new Date()), -7));
  const monthInput = document.getElementById('printCalMonth') as HTMLInputElement;
  if (monthInput && !monthInput.value) monthInput.value = toIsoDate(new Date()).slice(0, 7);
  syncPrintKind();
  openModal('printModal');
}
export function closePrintModal(): void {
  closeModal('printModal');
}
export function syncPrintKind(): void {
  const kind = (document.querySelector('input[name="printKind"]:checked') as HTMLInputElement | null)?.value || 'gantt';
  document.getElementById('printGanttOpts')!.hidden = kind !== 'gantt';
  document.getElementById('printCalOpts')!.hidden = kind !== 'calendar';
}
export function runPrint(): void {
  const kind = (document.querySelector('input[name="printKind"]:checked') as HTMLInputElement | null)?.value || 'gantt';
  let html: string;
  if (kind === 'calendar') {
    const v = (document.getElementById('printCalMonth') as HTMLInputElement).value || toIsoDate(new Date()).slice(0, 7);
    const [y, m] = v.split('-').map(Number);
    html = buildCalendarPrintHtml(y, m - 1);
  } else {
    const s = (document.getElementById('printGanttStart') as HTMLInputElement).value;
    const weeks = parseInt((document.getElementById('printGanttWeeks') as HTMLSelectElement).value, 10) || 6;
    html = buildGanttPrintHtml(s ? parseDay(s) : new Date(), weeks);
  }
  closePrintModal();
  printHtml(html);
}
