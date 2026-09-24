import { render } from 'preact';
import { useState } from 'preact/hooks';
import { formatDate } from '../utils/date';
import type { BoardCard, Job } from '../core/types';
import { getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from '../core/models';
import { getVisibleJobs, syncCardColumns } from '../core/jobs';
import { buildHomeOverdueRows, buildHomeStalledRows } from './home';
import { displayNameForUsername } from '../app/user-roster';
import { realTasks, validDate } from '../app/export';

// Reports tab (#panel-reports). Everything is derived live from the same
// data every other view reads — nothing is stored. Overdue and stalled
// reuse Home's own builders so the two can never disagree.
//
// One filter row scopes the whole page: a date range (with the same-length
// period before it for comparisons) plus PM / foreman / customer / job
// type. History comes from the schedule itself, archived jobs included:
//   - a job STARTS on its first task's start date;
//   - it's COMPLETED on its last task's finish date once that has
//     passed, or on the day its card was moved to a finished stage if
//     that came first (a card's stage date alone isn't trusted for
//     history: automatic stage moves stamp it whenever they happen);
//   - "finished by due date" compares that completion day to the card's
//     due date. Because bars get dragged to match reality, this reflects
//     the final schedule, not a separate record of when work ended.

const DAY = 86400000;
const WORKLOAD_WEEKS = 12;
const FILTER_KEY = 'teamsync_reports_filters_v1';

function today0(): Date { return new Date(new Date().toDateString()); }
function monday(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function parseDay(s: string): Date { return new Date(s + 'T00:00:00'); }
function addDays(d: Date, n: number): Date { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function shortDate(d: Date): string { return formatDate(d, { month: 'short', day: 'numeric' }, undefined); }
function monthLabel(d: Date, withYear: boolean): string { return formatDate(d, withYear ? { month: 'short', year: '2-digit' } : { month: 'short' }, undefined); }
function plural(n: number, one: string, many?: string): string { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

function openJob(jobId: string) {
  return (e: Event) => { e.preventDefault(); editJob(jobId); };
}

// ===== Filters =====

type RangeKey = '30d' | '90d' | 'ytd' | '12m' | 'all';
type DimKey = 'pm' | 'foreman' | 'customer' | 'jobType';
interface Filters { range: RangeKey; pm: string; foreman: string; customer: string; jobType: string; groupBy: DimKey; sortKey: string; sortDesc: boolean; }

const RANGES: { key: RangeKey; label: string; long: string }[] = [
  { key: '30d', label: '30 days', long: 'the last 30 days' },
  { key: '90d', label: '90 days', long: 'the last 90 days' },
  { key: 'ytd', label: 'Year to date', long: 'this year so far' },
  { key: '12m', label: '12 months', long: 'the last 12 months' },
  { key: 'all', label: 'All time', long: 'all time' },
];
const DIMS: { key: DimKey; label: string; person: boolean }[] = [
  { key: 'pm', label: 'Project manager', person: true },
  { key: 'foreman', label: 'Foreman', person: true },
  { key: 'customer', label: 'Customer', person: false },
  { key: 'jobType', label: 'Job type', person: false },
];
const NOT_SET = 'Not set';

let filters: Filters = loadFilters();
function loadFilters(): Filters {
  const base: Filters = { range: '90d', pm: '', foreman: '', customer: '', jobType: '', groupBy: 'pm', sortKey: 'open', sortDesc: true };
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
    if (saved && typeof saved === 'object') return Object.assign(base, saved);
  } catch (e) { /* private window or bad JSON — defaults */ }
  return base;
}
function setFilters(patch: Partial<Filters>): void {
  filters = Object.assign({}, filters, patch);
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch (e) { /* not worth surfacing */ }
  renderReports();
}

// ===== Per-job facts =====

interface StageSpan { columnId: string; days: number; }
interface JobFacts {
  job: Job;
  card: BoardCard | undefined;
  start: Date | null;
  lastFinish: Date | null;
  completedOn: Date | null;   // null while still open
  days: number | null;        // first start to completion, inclusive
  due: Date | null;
  dims: Record<DimKey, string>;
  stages: StageSpan[];
}

function fieldValue(card: BoardCard | undefined, key: string, person: boolean): string {
  const raw = card && card.customFields ? card.customFields[key] : '';
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return NOT_SET;
  return person ? displayNameForUsername(v) : v;
}

function jobFacts(job: Job, t0: Date): JobFacts {
  let start: Date | null = null, lastFinish: Date | null = null;
  const stageDays = new Map<string, number>();
  getJobPhases(job).forEach((phase) => getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
    const s = validDate(t.start), f = validDate(t.finish) || s;
    if (!s) return;
    const sd = parseDay(s), fd = parseDay(f);
    if (!start || sd < start) start = sd;
    if (!lastFinish || fd > lastFinish) lastFinish = fd;
    if (t.columnId) stageDays.set(t.columnId, (stageDays.get(t.columnId) || 0) + Math.max(1, Math.round((fd.getTime() - sd.getTime()) / DAY) + 1));
  })));
  const card = getPrimaryPhaseCard(job);
  let completedOn: Date | null = null;
  if (lastFinish && (lastFinish as Date) < t0) {
    completedOn = lastFinish;
  } else if (card && card.column && isFinishedColumnId(card.column) && card.columnEnteredAt) {
    // Marked done ahead of its schedule.
    completedOn = new Date(new Date(card.columnEnteredAt as number).toDateString());
  }
  const s0 = start as Date | null;
  const days = completedOn && s0 ? Math.max(1, Math.round((completedOn.getTime() - s0.getTime()) / DAY) + 1) : null;
  const dueStr = card ? validDate(card.due) : '';
  const dims = {} as Record<DimKey, string>;
  DIMS.forEach((d) => { dims[d.key] = fieldValue(card, d.key, d.person); });
  return {
    job, card, start: s0, lastFinish, completedOn, days, due: dueStr ? parseDay(dueStr) : null, dims,
    stages: Array.from(stageDays, ([columnId, d]) => ({ columnId, days: d })),
  };
}

function matchesFilters(f: JobFacts, except?: DimKey): boolean {
  return DIMS.every((d) => d.key === except || !filters[d.key] || f.dims[d.key] === filters[d.key]);
}

// ===== Periods =====

interface Period { start: Date; end: Date; }  // end exclusive
interface Bucket extends Period { label: string; }

function currentPeriod(all: JobFacts[], t0: Date): Period {
  const end = addDays(t0, 1);
  switch (filters.range) {
    case '30d': return { start: addDays(end, -30), end };
    case '90d': return { start: addDays(end, -90), end };
    case 'ytd': return { start: new Date(t0.getFullYear(), 0, 1), end };
    case '12m': return { start: new Date(t0.getFullYear(), t0.getMonth() - 11, 1), end };
    default: {
      const first = all.reduce<Date | null>((m, f) => (f.start && (!m || f.start < m) ? f.start : m), null);
      const floor = new Date(t0.getFullYear(), t0.getMonth() - 35, 1);  // at most 36 monthly buckets
      const s = first && first > floor ? new Date(first.getFullYear(), first.getMonth(), 1) : floor;
      return { start: s, end };
    }
  }
}
function previousPeriod(p: Period): Period | null {
  if (filters.range === 'all') return null;
  if (filters.range === 'ytd') return { start: new Date(p.start.getFullYear() - 1, 0, 1), end: new Date(p.end.getFullYear() - 1, p.end.getMonth(), p.end.getDate()) };
  if (filters.range === '12m') return { start: new Date(p.start.getFullYear() - 1, p.start.getMonth(), 1), end: p.start };
  return { start: new Date(p.start.getTime() - (p.end.getTime() - p.start.getTime())), end: p.start };
}
function buckets(p: Period): Bucket[] {
  const out: Bucket[] = [];
  if (p.end.getTime() - p.start.getTime() <= 120 * DAY) {
    for (let s = monday(p.start); s < p.end; s = addDays(s, 7)) out.push({ start: s, end: addDays(s, 7), label: shortDate(s) });
    return out;
  }
  const multiYear = p.start.getFullYear() !== addDays(p.end, -1).getFullYear();
  for (let s = new Date(p.start.getFullYear(), p.start.getMonth(), 1); s < p.end; s = new Date(s.getFullYear(), s.getMonth() + 1, 1)) {
    out.push({ start: s, end: new Date(s.getFullYear(), s.getMonth() + 1, 1), label: monthLabel(s, multiYear) });
  }
  return out;
}
const inP = (d: Date | null, p: Period) => !!d && d >= p.start && d < p.end;

interface PeriodStats { completed: JobFacts[]; started: JobFacts[]; avgDays: number | null; onTimePct: number | null; onTimeOf: number; onTimeHit: number; }
function stats(facts: JobFacts[], p: Period, t0: Date): PeriodStats {
  const completed = facts.filter((f) => inP(f.completedOn, p));
  const started = facts.filter((f) => inP(f.start, p) && (f.start as Date) <= t0);
  const lengths = completed.map((f) => f.days).filter((d): d is number => d !== null);
  const withDue = completed.filter((f) => f.due);
  const hit = withDue.filter((f) => (f.completedOn as Date) <= (f.due as Date)).length;
  return {
    completed, started,
    avgDays: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null,
    onTimePct: withDue.length ? hit / withDue.length * 100 : null, onTimeOf: withDue.length, onTimeHit: hit,
  };
}

// ===== Colors =====

// A stage's own board color when it has one; otherwise a slot from the
// validated categorical palette (--rep-c1..8 in index.html), chosen by the
// stage's position so a stage keeps the same color everywhere.
function stageColor(colId: string): string {
  const i = BOARD_COLUMNS.findIndex((c) => c.id === colId);
  if (i === -1) return 'var(--rep-other)';
  return BOARD_COLUMNS[i].color || 'var(--rep-c' + ((i % 8) + 1) + ')';
}
function stageLabel(colId: string): string {
  const c = BOARD_COLUMNS.find((x) => x.id === colId);
  return c ? c.label : 'Other';
}

// ===== Shared chart pieces =====

// A clean axis maximum with 2–4 ticks (1/2/5 steps).
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) as number;
  const stepInt = Math.max(1, Math.round(step));
  const top = Math.ceil(max / stepInt) * stepInt;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += stepInt) ticks.push(v);
  return { top, ticks };
}

interface Series { id: string; label: string; color: string; }
interface ColumnDatum { label: string; title: string; values: Record<string, number>; muted?: boolean; }

// Grouped or stacked columns, one hover/focus tooltip per column listing
// every series. Built from HTML (not a scaled SVG) so text never stretches.
function ColumnChart(p: { series: Series[]; data: ColumnDatum[]; mode: 'group' | 'stack'; unit: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = p.data.map((d) => p.series.reduce((n, s) => n + (d.values[s.id] || 0), 0));
  const peak = p.mode === 'stack' ? Math.max(0, ...totals) : Math.max(0, ...p.data.flatMap((d) => p.series.map((s) => d.values[s.id] || 0)));
  const { top, ticks } = niceScale(peak);
  const n = p.data.length;
  // Every column keeps its label in the DOM; CSS hides the in-between
  // ones (fewer on phones) so they never collide.
  const labelEvery = n > 18 ? 3 : n > 12 ? 2 : 1;
  const labelEveryPhone = n > 12 ? 3 : n > 6 ? 2 : 1;
  return (
    <div class="rep-cols" style={{ '--rep-n': String(n), '--rep-h': (p.height || 200) + 'px' } as Record<string, string>} onMouseLeave={() => setHover(null)}>
      <div class="rep-cols-grid" aria-hidden="true">
        {ticks.map((t) => <span key={t} style={{ bottom: (t / top * 100) + '%' }}><em>{t}</em></span>)}
      </div>
      {p.data.map((d, i) => {
        const aria = d.title + ': ' + p.series.map((s) => s.label + ' ' + (d.values[s.id] || 0)).join(', ');
        return (
          <div key={i} class={'rep-col' + (hover === i ? ' hover' : '') + (d.muted ? ' muted' : '')} tabIndex={0} role="img" aria-label={aria}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            <div class={'rep-col-plot ' + p.mode}>
              {p.mode === 'stack'
                ? p.series.filter((s) => d.values[s.id]).map((s) => <span key={s.id} class="rep-vbar-seg" style={{ height: (d.values[s.id] / top * 100) + '%', background: s.color }} />)
                : p.series.map((s) => <span key={s.id} class="rep-bar" style={{ height: ((d.values[s.id] || 0) / top * 100) + '%', background: s.color }} />)}
            </div>
            <div class={'rep-col-label' + (i % labelEvery ? ' hide-d' : '') + (i % labelEveryPhone ? ' hide-m' : '')} aria-hidden="true">{d.label}</div>
            {hover === i ? (
              <div class={'rep-tip' + (i < n / 4 ? ' left' : i >= n * 3 / 4 ? ' right' : '')} role="presentation">
                <div class="rep-tip-title">{d.title}</div>
                {p.series.map((s) => (
                  <div class="rep-tip-row" key={s.id}><i style={{ background: s.color }} /><b>{d.values[s.id] || 0}</b><span>{s.label}</span></div>
                ))}
                {p.mode === 'stack' && p.series.length > 1 ? <div class="rep-tip-row total"><i /><b>{totals[i]}</b><span>{p.unit}</span></div> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  return <div class="rep-legend">{series.map((s) => <span key={s.id}><i class="rep-swatch" style={{ background: s.color }} />{s.label}</span>)}</div>;
}

function TableToggle(p: { series: Series[]; data: ColumnDatum[]; first: string; total?: boolean }) {
  return (
    <details class="rep-table-toggle">
      <summary>Show as table</summary>
      <div class="rep-table-scroll">
        <table class="rep-table">
          <thead><tr><th>{p.first}</th>{p.series.map((s) => <th key={s.id} class="num">{s.label}</th>)}{p.total ? <th class="num">Total</th> : null}</tr></thead>
          <tbody>
            {p.data.map((d, i) => (
              <tr key={i}><td class="nowrap">{d.title}</td>
                {p.series.map((s) => <td key={s.id} class="num">{d.values[s.id] || 0}</td>)}
                {p.total ? <td class="num"><b>{p.series.reduce((n, s) => n + (d.values[s.id] || 0), 0)}</b></td> : null}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => (i / (values.length - 1) * 100).toFixed(1) + ',' + (22 - v / max * 20).toFixed(1));
  const last = pts[pts.length - 1].split(',');
  return (
    <svg class="rep-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} vector-effect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.2" />
    </svg>
  );
}

interface HBar { id: string; label: string; value: number; color: string; note?: string; }
function HBars(p: { bars: HBar[]; unit: (n: number) => string }) {
  const max = Math.max(1, ...p.bars.map((b) => b.value));
  return (
    <div class="rep-hbars" role="list">
      {p.bars.map((b) => (
        <div class="rep-hbar-row" role="listitem" key={b.id} title={b.label + ': ' + p.unit(b.value) + (b.note ? ' · ' + b.note : '')}>
          <span class="rep-hbar-label"><i class="rep-swatch" style={{ background: b.color }} />{b.label}</span>
          <span class="rep-hbar-track"><span class="rep-hbar-fill" style={{ width: (b.value / max * 100) + '%', background: b.color }} /></span>
          <span class="rep-hbar-value">{p.unit(b.value)}{b.note ? <small>{b.note}</small> : null}</span>
        </div>
      ))}
    </div>
  );
}

// ===== Tiles =====

interface Delta { text: string; good: boolean | null; }
function delta(cur: number | null, prev: number | null, opts: { lowerIsBetter?: boolean; neutral?: boolean; pts?: boolean; fmt?: (n: number) => string }): Delta | null {
  if (cur === null || prev === null) return null;
  const diff = cur - prev;
  const fmt = opts.fmt || ((n: number) => String(Math.round(n)));
  if (Math.round(diff * 10) === 0) return { text: 'Same as the period before', good: null };
  const up = diff > 0;
  const good = opts.neutral ? null : (up !== !!opts.lowerIsBetter);
  return { text: (up ? '▲ ' : '▼ ') + fmt(Math.abs(diff)) + (opts.pts ? ' pts' : '') + ' vs the period before', good };
}

function Tile(p: { label: string; value: string; note?: string; delta?: Delta | null; spark?: number[]; tone?: 'critical' | 'warning'; alert?: boolean }) {
  const alert = p.tone && p.alert;
  return (
    <div class={'rep-tile' + (alert ? ' ' + p.tone : '')}>
      <div class="rep-tile-label">
        {alert ? <span class="rep-status-icon" aria-hidden="true">{p.tone === 'critical' ? '!' : '◷'}</span> : null}
        {p.label}
      </div>
      <div class="rep-tile-main">
        <div class="rep-tile-value">{p.value}</div>
        {p.spark ? <Sparkline values={p.spark} /> : null}
      </div>
      {p.delta ? <div class={'rep-delta' + (p.delta.good === true ? ' good' : p.delta.good === false ? ' bad' : '')}>{p.delta.text}</div> : null}
      {p.note ? <div class="rep-tile-note">{p.note}</div> : null}
    </div>
  );
}

function Panel(p: { title: string; sub?: string; children: any; wide?: boolean; aside?: any }) {
  return (
    <section class={'rep-panel' + (p.wide ? ' wide' : '')}>
      <header><h3>{p.title}</h3>{p.sub ? <span>{p.sub}</span> : null}{p.aside ? <div class="rep-panel-aside">{p.aside}</div> : null}</header>
      {p.children}
    </section>
  );
}

// ===== Sections =====

function FilterBar({ all }: { all: JobFacts[] }) {
  const anyDim = DIMS.some((d) => filters[d.key]);
  return (
    <div class="rep-filters">
      <div class="rep-seg" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button type="button" key={r.key} class={filters.range === r.key ? 'active' : ''} aria-pressed={filters.range === r.key} onClick={() => setFilters({ range: r.key })}>{r.label}</button>
        ))}
      </div>
      {DIMS.map((d) => {
        // Options come from jobs matching the OTHER filters, so every
        // choice leads somewhere; the current pick always stays listed.
        const values = Array.from(new Set(all.filter((f) => matchesFilters(f, d.key)).map((f) => f.dims[d.key])));
        if (filters[d.key] && values.indexOf(filters[d.key]) === -1) values.push(filters[d.key]);
        values.sort((a, b) => (a === NOT_SET ? 1 : b === NOT_SET ? -1 : a.localeCompare(b)));
        if (values.length < 2 && !filters[d.key]) return null;
        return (
          <label class={'rep-select' + (filters[d.key] ? ' set' : '')} key={d.key}>
            <span>{d.label}</span>
            <select value={filters[d.key]} onChange={(e) => setFilters({ [d.key]: (e.target as HTMLSelectElement).value } as Partial<Filters>)}>
              <option value="">All</option>
              {values.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        );
      })}
      {anyDim ? <button type="button" class="rep-clear" onClick={() => setFilters({ pm: '', foreman: '', customer: '', jobType: '' })}>Clear filters</button> : null}
    </div>
  );
}

interface BreakdownRow { name: string; open: number; completed: number; avgDays: number | null; onTime: number | null; overdue: number; }
const BREAKDOWN_COLS: { key: keyof BreakdownRow; label: string; num: boolean }[] = [
  { key: 'name', label: '', num: false },
  { key: 'open', label: 'Open jobs', num: true },
  { key: 'completed', label: 'Completed', num: true },
  { key: 'avgDays', label: 'Avg length', num: true },
  { key: 'onTime', label: 'By due date', num: true },
  { key: 'overdue', label: 'Overdue', num: true },
];

function Breakdown(p: { facts: JobFacts[]; period: Period; t0: Date; overdueIds: Set<string> }) {
  const dim = DIMS.find((d) => d.key === filters.groupBy) as typeof DIMS[number];
  const groups = new Map<string, JobFacts[]>();
  p.facts.forEach((f) => { const k = f.dims[dim.key]; groups.set(k, (groups.get(k) || []).concat(f)); });
  const rows: BreakdownRow[] = Array.from(groups, ([name, list]) => {
    const s = stats(list, p.period, p.t0);
    return {
      name,
      open: list.filter((f) => !f.job.archived && !f.completedOn).length,
      completed: s.completed.length, avgDays: s.avgDays, onTime: s.onTimePct,
      overdue: list.filter((f) => p.overdueIds.has(f.job.id)).length,
    };
  }).filter((r) => r.open || r.completed || r.overdue);
  const key = filters.sortKey as keyof BreakdownRow;
  const dir = filters.sortDesc ? -1 : 1;
  rows.sort((a, b) => {
    if (a.name === NOT_SET !== (b.name === NOT_SET)) return a.name === NOT_SET ? 1 : -1;
    const av = a[key], bv = b[key];
    if (av === bv) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)) * dir;
  });
  const maxOpen = Math.max(1, ...rows.map((r) => r.open));
  const canFilter = !filters[dim.key];
  const sortBy = (k: string) => setFilters(filters.sortKey === k ? { sortDesc: !filters.sortDesc } : { sortKey: k, sortDesc: k !== 'name' });
  return (
    <Panel title="Breakdown" sub={'Completed, length and due-date figures cover ' + (RANGES.find((r) => r.key === filters.range) as typeof RANGES[number]).long} wide
      aside={
        <div class="rep-seg small" role="group" aria-label="Group by">
          {DIMS.map((d) => <button type="button" key={d.key} class={filters.groupBy === d.key ? 'active' : ''} aria-pressed={filters.groupBy === d.key} onClick={() => setFilters({ groupBy: d.key })}>{d.label}</button>)}
        </div>
      }>
      {rows.length ? (
        <div class="rep-table-scroll">
          <table class="rep-table rep-breakdown">
            <thead><tr>
              {BREAKDOWN_COLS.map((c) => {
                const active = filters.sortKey === c.key;
                return (
                  <th key={c.key} class={c.num ? 'num' : ''} aria-sort={active ? (filters.sortDesc ? 'descending' : 'ascending') : undefined}>
                    <button type="button" class="rep-sort" onClick={() => sortBy(c.key)}>{c.key === 'name' ? dim.label : c.label}{active ? (filters.sortDesc ? ' ↓' : ' ↑') : ''}</button>
                  </th>
                );
              })}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td class={r.name === NOT_SET ? 'muted' : ''}>
                    {canFilter && r.name !== NOT_SET
                      ? <a href="#" title={'Show only ' + r.name} onClick={(e) => { e.preventDefault(); setFilters({ [dim.key]: r.name } as Partial<Filters>); }}>{r.name}</a>
                      : r.name}
                  </td>
                  <td class="num"><span class="rep-share"><i style={{ width: (r.open / maxOpen * 100) + '%' }} /></span>{r.open}</td>
                  <td class="num">{r.completed}</td>
                  <td class="num">{r.avgDays === null ? '—' : Math.round(r.avgDays) + 'd'}</td>
                  <td class="num">{r.onTime === null ? '—' : Math.round(r.onTime) + '%'}</td>
                  <td class={'num' + (r.overdue ? ' rep-bad-text' : '')}>{r.overdue || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p class="rep-empty">No jobs match these filters.</p>}
    </Panel>
  );
}

function ReportsView() {
  syncCardColumns();
  const t0 = today0();
  const all = getVisibleJobs().filter((j) => !j.isLinkedReference).map((j) => jobFacts(j, t0));
  const facts = all.filter((f) => matchesFilters(f));
  const ids = new Set(facts.map((f) => f.job.id));
  const open = facts.filter((f) => !f.job.archived && !f.completedOn);

  const period = currentPeriod(all, t0);
  const prev = previousPeriod(period);
  const cur = stats(facts, period, t0);
  const before = prev ? stats(facts, prev, t0) : null;
  const bks = buckets(period);
  const rangeInfo = RANGES.find((r) => r.key === filters.range) as typeof RANGES[number];

  const overdueRows = buildHomeOverdueRows().filter((r) => ids.has(r.job.id));
  const overdue = overdueRows.filter((r) => r.isOverdue);
  const dueSoon = overdueRows.filter((r) => !r.isOverdue);
  const stalled = buildHomeStalledRows().filter((r) => ids.has(r.job.id));
  const inProgress = open.filter((f) => f.start && f.start <= t0).length;
  const next30 = open.filter((f) => f.start && f.start > t0 && f.start < addDays(t0, 31)).length;

  // Started vs completed, per bucket.
  const flowSeries: Series[] = [
    { id: 'started', label: 'Started', color: 'var(--rep-c1)' },
    { id: 'completed', label: 'Completed', color: 'var(--rep-c3)' },
  ];
  const weekly = bks.length && bks[0].end.getTime() - bks[0].start.getTime() === 7 * DAY;
  const flow: ColumnDatum[] = bks.map((b) => ({
    label: b.label,
    title: weekly ? 'Week of ' + shortDate(b.start) : formatDate(b.start, { month: 'long', year: 'numeric' }, undefined),
    values: {
      started: facts.filter((f) => inP(f.start, b) && (f.start as Date) <= t0).length,
      completed: facts.filter((f) => inP(f.completedOn, b)).length,
    },
    muted: b.end > addDays(t0, 1),
  }));

  // Workload ahead: per week, how many jobs have work of each stage scheduled.
  const wStart = monday(t0);
  const wCounts: Record<string, number>[] = Array.from({ length: WORKLOAD_WEEKS }, () => ({}));
  open.forEach((f) => {
    const seen: Set<string>[] = Array.from({ length: WORKLOAD_WEEKS }, () => new Set<string>());
    getJobPhases(f.job).forEach((phase) => getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
      const s = validDate(t.start), e = validDate(t.finish) || s;
      if (!s) return;
      const key = t.columnId && BOARD_COLUMNS.some((c) => c.id === t.columnId) ? t.columnId : '__other';
      const a = Math.floor((parseDay(s).getTime() - wStart.getTime()) / DAY / 7);
      const z = Math.floor((parseDay(e).getTime() - wStart.getTime()) / DAY / 7);
      for (let w = Math.max(0, a); w <= Math.min(WORKLOAD_WEEKS - 1, z); w++) seen[w].add(key);
    })));
    seen.forEach((keys, w) => keys.forEach((k) => { wCounts[w][k] = (wCounts[w][k] || 0) + 1; }));
  });
  const wSeries: Series[] = BOARD_COLUMNS.map((c) => ({ id: c.id, label: c.label, color: stageColor(c.id) }))
    .concat({ id: '__other', label: 'Other', color: 'var(--rep-other)' })
    .filter((s) => wCounts.some((c) => c[s.id]));
  const wData: ColumnDatum[] = wCounts.map((c, w) => {
    const s = addDays(wStart, w * 7);
    return { label: shortDate(s), title: 'Week of ' + shortDate(s), values: c };
  });
  const wPeak = Math.max(0, ...wData.map((d) => wSeries.reduce((n, s) => n + (d.values[s.id] || 0), 0)));
  const wBusiest = wData.findIndex((d) => wSeries.reduce((n, s) => n + (d.values[s.id] || 0), 0) === wPeak);

  // Pipeline: open cards per stage, with how long they've sat there.
  const pipe = new Map<string, { n: number; days: number[] }>();
  boardCards.forEach((card) => {
    if (!card.column || !ids.has(card.jobId as string)) return;
    const f = facts.find((x) => x.job.id === card.jobId);
    if (!f || f.job.archived) return;
    const e = pipe.get(card.column) || { n: 0, days: [] };
    e.n++;
    if (card.columnEnteredAt) e.days.push((Date.now() - (card.columnEnteredAt as number)) / DAY);
    pipe.set(card.column, e);
  });
  const pipeBars: HBar[] = BOARD_COLUMNS.map((c) => {
    const e = pipe.get(c.id);
    const avg = e && e.days.length ? Math.round(e.days.reduce((a, b) => a + b, 0) / e.days.length) : null;
    return { id: c.id, label: c.label, value: e ? e.n : 0, color: stageColor(c.id), note: e && avg ? 'avg ' + avg + 'd here' : undefined };
  });

  // Typical stage length across jobs completed in the range (median).
  const byStage = new Map<string, number[]>();
  cur.completed.forEach((f) => f.stages.forEach((s) => byStage.set(s.columnId, (byStage.get(s.columnId) || []).concat(s.days))));
  const stageLen: HBar[] = BOARD_COLUMNS.filter((c) => byStage.has(c.id)).map((c) => {
    const list = (byStage.get(c.id) as number[]).slice().sort((a, b) => a - b);
    const mid = Math.floor(list.length / 2);
    const median = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
    return { id: c.id, label: c.label, value: Math.round(median), color: stageColor(c.id), note: plural(list.length, 'job') };
  });

  // Coming up: task finishes and due dates in the next 14 days.
  const upcoming: { date: Date; jobId: string; job: string; what: string }[] = [];
  const end14 = addDays(t0, 14);
  open.forEach((f) => {
    const phases = getJobPhases(f.job);
    phases.forEach((phase) => {
      const label = f.job.name + (phases.length > 1 && !phase.isDefault ? ' — ' + phase.name : '');
      getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
        const fin = validDate(t.finish);
        if (!fin) return;
        const d = parseDay(fin);
        if (d >= t0 && d < end14) upcoming.push({ date: d, jobId: f.job.id, job: label, what: (t.name || 'Task') + ' finishes' });
      }));
      const card = getPhaseCard(f.job, phase.id);
      const due = card ? validDate(card.due) : '';
      if (due) { const d = parseDay(due); if (d >= t0 && d < end14) upcoming.push({ date: d, jobId: f.job.id, job: label, what: 'Due date' }); }
    });
  });
  upcoming.sort((a, b) => a.date.getTime() - b.date.getTime() || a.job.localeCompare(b.job));

  const attention = [
    ...overdue.map((r) => ({ key: 'o' + r.card.id, jobId: r.job.id, label: r.label, why: 'Overdue · was due ' + shortDate(r.dueDate), tone: 'critical' })),
    ...stalled.map((r) => ({ key: 's' + r.card.id, jobId: r.job.id, label: r.label, why: r.daysInStage + ' days in ' + r.columnLabel, tone: 'warning' })),
  ];

  const flowTotal = { s: cur.started.length, c: cur.completed.length };
  const dayFmt = (n: number) => Math.round(n) + (Math.round(n) === 1 ? ' day' : ' days');
  const overdueIds = new Set(overdue.map((r) => r.job.id));

  return (
    <div class="rep-wrap">
      <div class="rep-head">
        <h2>Reports</h2>
        <span>{plural(facts.length, 'job')} · updated {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <FilterBar all={all} />

      <div class="rep-tiles">
        <Tile label="Open jobs" value={String(open.length)} note={inProgress + ' in progress · ' + next30 + ' starting in the next 30 days'} />
        <Tile label="Overdue" value={String(overdue.length)} tone="critical" alert={overdue.length > 0} note={plural(dueSoon.length, 'job') + ' due in the next 7 days'} />
        <Tile label="Stalled" value={String(stalled.length)} tone="warning" alert={stalled.length > 0} note="Sitting in one stage longer than usual" />
        <Tile label="Completed" value={String(cur.completed.length)} spark={flow.map((d) => d.values.completed)}
          delta={before ? delta(cur.completed.length, before.completed.length, {}) : null} note={'In ' + rangeInfo.long} />
        <Tile label="Avg job length" value={cur.avgDays === null ? '—' : dayFmt(cur.avgDays)}
          delta={before ? delta(cur.avgDays, before.avgDays, { lowerIsBetter: true, fmt: dayFmt }) : null} note="First start to completion" />
        <Tile label="Finished by due date" value={cur.onTimePct === null ? '—' : Math.round(cur.onTimePct) + '%'}
          delta={before ? delta(cur.onTimePct, before.onTimePct, { pts: true }) : null}
          note={cur.onTimeOf ? cur.onTimeHit + ' of ' + plural(cur.onTimeOf, 'completed job') + ' with a due date' : 'No completed jobs with a due date'} />
      </div>

      <div class="rep-grid">
        <Panel title="Jobs started and completed" sub={flowTotal.s + ' started · ' + flowTotal.c + ' completed in ' + rangeInfo.long} wide>
          {flowTotal.s || flowTotal.c ? (
            <>
              <Legend series={flowSeries} />
              <ColumnChart series={flowSeries} data={flow} mode="group" unit="jobs" height={220} />
              <TableToggle series={flowSeries} data={flow} first={weekly ? 'Week of' : 'Month'} />
            </>
          ) : <p class="rep-empty">No jobs started or completed in {rangeInfo.long}.</p>}
        </Panel>

        <Panel title={'Workload ahead · next ' + WORKLOAD_WEEKS + ' weeks'} wide
          sub={wPeak ? 'Jobs with work scheduled each week, by stage · busiest: week of ' + wData[wBusiest].label + ' (' + plural(wPeak, 'job') + ')' : undefined}>
          {wSeries.length ? (
            <>
              <Legend series={wSeries} />
              <ColumnChart series={wSeries} data={wData} mode="stack" unit="jobs in total" />
              <TableToggle series={wSeries} data={wData} first="Week of" total />
            </>
          ) : <p class="rep-empty">Nothing is scheduled in the next {WORKLOAD_WEEKS} weeks.</p>}
        </Panel>

        <Panel title="Pipeline" sub="Open jobs in each stage right now">
          <HBars bars={pipeBars} unit={(n) => String(n)} />
        </Panel>

        <Panel title="Needs attention" sub={attention.length ? plural(attention.length, 'item') : 'All clear'}>
          {attention.length ? (
            <ul class="rep-list">
              {attention.map((a) => (
                <li key={a.key} class={a.tone}>
                  <span class="rep-status-icon" aria-hidden="true">{a.tone === 'critical' ? '!' : '◷'}</span>
                  <a href="#" onClick={openJob(a.jobId)}>{a.label}</a>
                  <span class="rep-why">{a.why}</span>
                </li>
              ))}
            </ul>
          ) : <p class="rep-empty">Nothing overdue or stalled.</p>}
        </Panel>

        <Panel title="Typical stage length" sub={'Median scheduled days per stage, jobs completed in ' + rangeInfo.long}>
          {stageLen.length ? <HBars bars={stageLen} unit={(n) => n + 'd'} /> : <p class="rep-empty">No jobs completed in {rangeInfo.long}.</p>}
        </Panel>

        <Panel title="Coming up" sub="Next 14 days">
          {upcoming.length ? (
            <div class="rep-table-scroll rep-scroll-y">
              <table class="rep-table">
                <thead><tr><th>Date</th><th>Job</th><th>What</th></tr></thead>
                <tbody>
                  {upcoming.map((u, i) => (
                    <tr key={i}>
                      <td class="nowrap">{formatDate(u.date, { weekday: 'short', month: 'short', day: 'numeric' }, undefined)}</td>
                      <td><a href="#" onClick={openJob(u.jobId)}>{u.job}</a></td>
                      <td>{u.what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p class="rep-empty">Nothing finishes or is due in the next 14 days.</p>}
        </Panel>

        <Breakdown facts={facts} period={period} t0={t0} overdueIds={overdueIds} />
      </div>
    </div>
  );
}

export function renderReports(): void {
  const el = document.getElementById('reportsBody');
  if (el) render(<ReportsView />, el);
}

// Called from renderAll() so an open Reports tab stays live as data
// changes (sync, edits); skipped entirely when the tab isn't showing.
export function renderReportsIfActive(): void {
  const panel = document.getElementById('panel-reports');
  if (panel && panel.classList.contains('active')) renderReports();
}
