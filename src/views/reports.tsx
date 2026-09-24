import { render } from 'preact';
import { useState } from 'preact/hooks';
import { formatDate } from '../utils/date';
import type { BoardCard, Job } from '../core/types';
import { getJobPhases, getPhaseSubUnits, getPrimaryPhaseCard } from '../core/models';
import { getVisibleJobs, syncCardColumns } from '../core/jobs';
import { buildHomeOverdueRows, buildHomeStalledRows } from './home';
import { displayNameForUsername } from '../app/user-roster';
import { realTasks, validDate } from '../app/export';

// Reports tab (#panel-reports). Laid out the way the easiest-to-read
// finance and analytics apps are: pick a period (month / quarter / year,
// stepped with ‹ ›), and everything answers "how did that period go?" in
// plain sentences first, then a clickable chart, then lists you can open.
// Nothing is stored; it's all derived live from the schedule, archived
// jobs included. Overdue and stalled reuse Home's own builders so the two
// can never disagree.
//
//   - a job STARTS on its first task's start date;
//   - it FINISHES on its last task's finish date once that has passed, or
//     on the day its card was moved to a finished stage if that came
//     first (a card's stage date alone isn't trusted for history:
//     automatic stage moves stamp it whenever they happen);
//   - "on time" compares that finish day to the card's due date. Because
//     bars get dragged to match reality, this reflects the final schedule.

const DAY = 86400000;
const LOOKAHEAD_WEEKS = 12;
const STATE_KEY = 'teamsync_reports_v2';

function today0(): Date { return new Date(new Date().toDateString()); }
function monday(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function parseDay(s: string): Date { return new Date(s + 'T00:00:00'); }
function addDays(d: Date, n: number): Date { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function shortDate(d: Date): string { return formatDate(d, { month: 'short', day: 'numeric' }, undefined); }
function plural(n: number, one: string, many?: string): string { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function pct(n: number): string { return Math.round(n) + '%'; }

function openJob(jobId: string) {
  return (e: Event) => { e.preventDefault(); e.stopPropagation(); editJob(jobId); };
}

// ===== State =====

type Gran = 'month' | 'quarter' | 'year';
type DimKey = 'pm' | 'foreman' | 'customer' | 'jobType';
type Metric = 'finished' | 'started';
interface ViewState {
  gran: Gran; offset: number; metric: Metric;
  pm: string; foreman: string; customer: string; jobType: string;
  groupBy: DimKey; groupMetric: 'open' | 'finished';
}

const DIMS: { key: DimKey; label: string; plural: string; person: boolean }[] = [
  { key: 'customer', label: 'Customer', plural: 'customers', person: false },
  { key: 'pm', label: 'Project manager', plural: 'project managers', person: true },
  { key: 'foreman', label: 'Foreman', plural: 'foremen', person: true },
  { key: 'jobType', label: 'Job type', plural: 'job types', person: false },
];
const NOT_SET = 'Not set';

let state: ViewState = loadState();
// Not saved: which week, stage and list are opened are per-visit.
let lookWeek = 0;
let openStage: string | null = null;
let filterMenuOpen = false;
let showAllFinished = false;

function loadState(): ViewState {
  const base: ViewState = { gran: 'month', offset: 0, metric: 'finished', pm: '', foreman: '', customer: '', jobType: '', groupBy: 'customer', groupMetric: 'open' };
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    // The period always opens on the current one.
    if (saved && typeof saved === 'object') return Object.assign(base, saved, { offset: 0 });
  } catch (e) { /* private window or bad JSON — defaults */ }
  return base;
}
function setState(patch: Partial<ViewState>): void {
  state = Object.assign({}, state, patch);
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* not worth surfacing */ }
  renderReports();
}
function rerender(fn: () => void): void { fn(); renderReports(); }

// ===== Per-job facts =====

interface JobFacts {
  job: Job;
  card: BoardCard | undefined;
  start: Date | null;
  lastFinish: Date | null;
  finishedOn: Date | null;   // null while still open
  days: number | null;       // first start to finish, inclusive
  due: Date | null;
  dims: Record<DimKey, string>;
  open: boolean;
}

function fieldValue(card: BoardCard | undefined, key: string, person: boolean): string {
  const raw = card && card.customFields ? card.customFields[key] : '';
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return NOT_SET;
  return person ? displayNameForUsername(v) : v;
}

function jobFacts(job: Job, t0: Date): JobFacts {
  let start: Date | null = null, lastFinish: Date | null = null;
  getJobPhases(job).forEach((phase) => getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
    const s = validDate(t.start), f = validDate(t.finish) || s;
    if (!s) return;
    const sd = parseDay(s), fd = parseDay(f);
    if (!start || sd < start) start = sd;
    if (!lastFinish || fd > lastFinish) lastFinish = fd;
  })));
  const card = getPrimaryPhaseCard(job);
  let finishedOn: Date | null = null;
  if (lastFinish && (lastFinish as Date) < t0) {
    finishedOn = lastFinish;
  } else if (card && card.column && isFinishedColumnId(card.column) && card.columnEnteredAt) {
    finishedOn = new Date(new Date(card.columnEnteredAt as number).toDateString());
  }
  const s0 = start as Date | null;
  const dueStr = card ? validDate(card.due) : '';
  const dims = {} as Record<DimKey, string>;
  DIMS.forEach((d) => { dims[d.key] = fieldValue(card, d.key, d.person); });
  return {
    job, card, start: s0, lastFinish, finishedOn, due: dueStr ? parseDay(dueStr) : null, dims,
    days: finishedOn && s0 ? Math.max(1, Math.round((finishedOn.getTime() - s0.getTime()) / DAY) + 1) : null,
    open: !job.archived && !finishedOn,
  };
}

function matchesFilters(f: JobFacts, except?: DimKey): boolean {
  return DIMS.every((d) => d.key === except || !state[d.key] || f.dims[d.key] === state[d.key]);
}

// Days late (positive) or early (negative); null without a due date.
function lateBy(f: JobFacts): number | null {
  if (!f.due || !f.finishedOn) return null;
  return Math.round((f.finishedOn.getTime() - f.due.getTime()) / DAY);
}

// ===== Periods =====

interface Period { start: Date; end: Date; }  // end exclusive
const inP = (d: Date | null, p: Period) => !!d && d >= p.start && d < p.end;

function periodAt(gran: Gran, offset: number, t0: Date): Period {
  const y = t0.getFullYear(), m = t0.getMonth();
  if (gran === 'year') return { start: new Date(y + offset, 0, 1), end: new Date(y + offset + 1, 0, 1) };
  if (gran === 'quarter') { const q = Math.floor(m / 3) * 3 + offset * 3; return { start: new Date(y, q, 1), end: new Date(y, q + 3, 1) }; }
  return { start: new Date(y, m + offset, 1), end: new Date(y, m + offset + 1, 1) };
}
function periodName(gran: Gran, p: Period): string {
  if (gran === 'year') return String(p.start.getFullYear());
  if (gran === 'quarter') return 'Q' + (Math.floor(p.start.getMonth() / 3) + 1) + ' ' + p.start.getFullYear();
  return formatDate(p.start, { month: 'long', year: 'numeric' }, undefined);
}
function periodShort(gran: Gran, p: Period, t0: Date): string {
  if (gran === 'year') return String(p.start.getFullYear());
  if (gran === 'quarter') return 'Q' + (Math.floor(p.start.getMonth() / 3) + 1) + (p.start.getFullYear() !== t0.getFullYear() ? " '" + String(p.start.getFullYear()).slice(2) : '');
  return formatDate(p.start, { month: 'short' }, undefined) + (p.start.getMonth() === 0 ? " '" + String(p.start.getFullYear()).slice(2) : '');
}
// "August" / "Q2" / "2025" — how a period reads mid-sentence.
function periodWord(gran: Gran, p: Period): string {
  if (gran === 'year') return String(p.start.getFullYear());
  if (gran === 'quarter') return 'Q' + (Math.floor(p.start.getMonth() / 3) + 1);
  return formatDate(p.start, { month: 'long' }, undefined);
}
const WINDOW: Record<Gran, number> = { month: 12, quarter: 8, year: 5 };

// ===== Colors =====

// A stage's own board color when it has one; otherwise a slot from the
// validated categorical palette (--rep-c1..8 in index.html), chosen by the
// stage's position so a stage keeps the same color everywhere.
function stageColor(colId: string): string {
  const i = BOARD_COLUMNS.findIndex((c) => c.id === colId);
  if (i === -1) return 'var(--rep-other)';
  return BOARD_COLUMNS[i].color || 'var(--rep-c' + ((i % 8) + 1) + ')';
}
const METRIC_COLOR: Record<Metric, string> = { finished: 'var(--rep-c3)', started: 'var(--rep-c1)' };

// ===== Small pieces =====

function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 4, ticks: [0, 2, 4] };
  const raw = max / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, Math.round([1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) as number));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

function Change(p: { now: number | null; before: number | null; unit?: string; lowerIsBetter?: boolean; vs: string }) {
  const what = p.vs.replace(/^vs /, '');
  if (p.now === null || p.before === null) return <span class="rep-chg">Nothing to compare {what.startsWith('this point') ? 'at ' : 'in '}{what}</span>;
  const diff = Math.round(p.now) - Math.round(p.before);
  if (diff === 0) return <span class="rep-chg">Same as {what}</span>;
  const up = diff > 0;
  const good = up !== !!p.lowerIsBetter;
  return (
    <span class={'rep-chg ' + (good ? 'good' : 'bad')}>
      <b aria-hidden="true">{up ? '↑' : '↓'}</b>{Math.abs(diff)}{p.unit || ''} {p.vs}
    </span>
  );
}

interface BarDatum { key: number; label: string; title: string; value: number; rows: { label: string; value: string; color?: string }[]; partial?: boolean; }

// Single-series columns. The selected one is in color, the rest greyed
// out; clicking (or Enter on) a column selects it. Hover/focus shows a
// tooltip. An optional average line gives "normal" a place to read from.
function Bars(p: { data: BarDatum[]; selected: number; onSelect: (k: number) => void; color: string; avg?: number; avgLabel?: string; height: number; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = niceScale(Math.max(p.avg || 0, ...p.data.map((d) => d.value)));
  const n = p.data.length;
  return (
    <div class="rep-bars" style={{ '--rep-n': String(n), '--rep-h': p.height + 'px' } as Record<string, string>} role="group" aria-label={p.ariaLabel} onMouseLeave={() => setHover(null)}>
      <div class="rep-bars-grid" aria-hidden="true">
        {ticks.map((t) => <span key={t} style={{ bottom: (t / top * 100) + '%' }}><em>{t}</em></span>)}
        {p.avg ? <span class="rep-avg" style={{ bottom: (p.avg / top * 100) + '%' }}><em class="rep-avg-label">{p.avgLabel}</em></span> : null}
      </div>
      {p.data.map((d, i) => {
        const sel = d.key === p.selected;
        return (
          <button type="button" key={d.key} class={'rep-bar-col' + (sel ? ' selected' : '') + (hover === i ? ' hover' : '')}
            aria-pressed={sel} aria-label={d.title + ': ' + d.rows.map((r) => r.value + ' ' + r.label).join(', ')}
            onClick={() => p.onSelect(d.key)} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            <span class="rep-bar-plot">
              <span class={'rep-bar' + (d.partial ? ' partial' : '')} style={{ height: (d.value / top * 100) + '%', background: sel ? p.color : undefined }}>
                {d.value > 0 && sel ? <span class="rep-bar-val">{d.value}</span> : null}
              </span>
            </span>
            <span class="rep-bar-label">{d.label}</span>
            {hover === i ? (
              <span class={'rep-tip' + (i < n / 4 ? ' left' : i >= n * 3 / 4 ? ' right' : '')} aria-hidden="true">
                <span class="rep-tip-title">{d.title}</span>
                {d.rows.map((r, k) => <span class="rep-tip-row" key={k}>{r.color ? <i style={{ background: r.color }} /> : null}<b>{r.value}</b>{r.label}</span>)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Card(p: { title: string; sub?: any; children: any; class?: string; aside?: any }) {
  return (
    <section class={'rep-card ' + (p.class || '')}>
      <header>
        <div><h3>{p.title}</h3>{p.sub ? <p>{p.sub}</p> : null}</div>
        {p.aside ? <div class="rep-card-aside">{p.aside}</div> : null}
      </header>
      {p.children}
    </section>
  );
}

function Seg<T extends string>(p: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div class={'rep-seg' + (p.small ? ' small' : '')} role="group" aria-label={p.label}>
      {p.options.map((o) => <button type="button" key={o.key} class={p.value === o.key ? 'active' : ''} aria-pressed={p.value === o.key} onClick={() => p.onChange(o.key)}>{o.label}</button>)}
    </div>
  );
}

// ===== Sections =====

function Toolbar(p: { all: JobFacts[]; t0: Date; earliest: Date | null }) {
  const cur = periodAt(state.gran, state.offset, p.t0);
  const canBack = !p.earliest || cur.start > p.earliest;
  const active = DIMS.filter((d) => state[d.key]);
  return (
    <div class="rep-toolbar">
      <div class="rep-period">
        <button type="button" class="rep-step" aria-label="Previous period" disabled={!canBack} onClick={() => setState({ offset: state.offset - 1 })}>‹</button>
        <span class="rep-period-name" aria-live="polite">{periodName(state.gran, cur)}</span>
        <button type="button" class="rep-step" aria-label="Next period" disabled={state.offset >= 0} onClick={() => setState({ offset: state.offset + 1 })}>›</button>
      </div>
      {state.offset < 0 ? <button type="button" class="rep-link" onClick={() => setState({ offset: 0 })}>Back to now</button> : null}
      <Seg label="Period length" value={state.gran} onChange={(gr) => setState({ gran: gr, offset: 0 })}
        options={[{ key: 'month', label: 'Month' }, { key: 'quarter', label: 'Quarter' }, { key: 'year', label: 'Year' }]} />
      <div class="rep-filter-wrap">
        <button type="button" class={'rep-filter-btn' + (active.length ? ' set' : '')} aria-expanded={filterMenuOpen} onClick={() => rerender(() => { filterMenuOpen = !filterMenuOpen; })}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
          Filter{active.length ? ' · ' + active.length : ''}
        </button>
        {filterMenuOpen ? (
          <div class="rep-filter-menu">
            {DIMS.map((d) => {
              const values = Array.from(new Set(p.all.filter((f) => matchesFilters(f, d.key)).map((f) => f.dims[d.key])));
              if (state[d.key] && values.indexOf(state[d.key]) === -1) values.push(state[d.key]);
              values.sort((a, b) => (a === NOT_SET ? 1 : b === NOT_SET ? -1 : a.localeCompare(b)));
              return (
                <label key={d.key}>
                  <span>{d.label}</span>
                  <select value={state[d.key]} onChange={(e) => setState({ [d.key]: (e.target as HTMLSelectElement).value } as Partial<ViewState>)}>
                    <option value="">All {d.plural}</option>
                    {values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              );
            })}
            <button type="button" class="rep-link" onClick={() => rerender(() => { filterMenuOpen = false; })}>Done</button>
          </div>
        ) : null}
      </div>
      {active.map((d) => (
        <span class="rep-chip" key={d.key}>
          <span class="rep-chip-k">{d.label}:</span> {state[d.key]}
          <button type="button" aria-label={'Remove ' + d.label + ' filter'} onClick={() => setState({ [d.key]: '' } as Partial<ViewState>)}>×</button>
        </span>
      ))}
    </div>
  );
}

interface Insight { key: string; tone: 'critical' | 'warning' | 'good' | 'info'; title: string; body: any; }
const TONE_ICON: Record<Insight['tone'], string> = { critical: '!', warning: '◷', good: '✓', info: 'i' };

function Insights({ items }: { items: Insight[] }) {
  return (
    <div class="rep-insights">
      {items.map((it) => (
        <div class={'rep-insight ' + it.tone} key={it.key}>
          <span class="rep-insight-icon" aria-hidden="true">{TONE_ICON[it.tone]}</span>
          <div><b>{it.title}</b><p>{it.body}</p></div>
        </div>
      ))}
    </div>
  );
}

function JobRow(p: { f: JobFacts; right: any }) {
  const meta = [p.f.dims.customer, p.f.dims.pm].filter((v) => v !== NOT_SET).join(' · ');
  return (
    <li class="rep-job">
      <span class="rep-job-main">
        <a href="#" onClick={openJob(p.f.job.id)}>{p.f.job.name}</a>
        {meta ? <span class="rep-job-meta">{meta}</span> : null}
      </span>
      <span class="rep-job-right">{p.right}</span>
    </li>
  );
}

function DueBadge({ f }: { f: JobFacts }) {
  const late = lateBy(f);
  if (late === null) return <span class="rep-badge muted">No due date</span>;
  if (late <= 0) return <span class="rep-badge good"><b aria-hidden="true">✓</b> On time</span>;
  return <span class="rep-badge bad"><b aria-hidden="true">!</b> {plural(late, 'day')} late</span>;
}

function ReportsView() {
  syncCardColumns();
  const t0 = today0();
  const all = getVisibleJobs().filter((j) => !j.isLinkedReference).map((j) => jobFacts(j, t0));
  const facts = all.filter((f) => matchesFilters(f));
  const ids = new Set(facts.map((f) => f.job.id));
  const open = facts.filter((f) => f.open);
  const earliest = all.reduce<Date | null>((m, f) => (f.start && (!m || f.start < m) ? f.start : m), null);

  // Selected period, and the one before it. A period still in progress is
  // compared with the same number of days into the one before, so "so far"
  // is never measured against a whole period.
  const g = state.gran;
  const cur = periodAt(g, state.offset, t0);
  const inProgress = cur.end > t0;
  const prevFull = periodAt(g, state.offset - 1, t0);
  const prev: Period = inProgress
    ? { start: prevFull.start, end: new Date(Math.min(prevFull.end.getTime(), prevFull.start.getTime() + (addDays(t0, 1).getTime() - cur.start.getTime()))) }
    : prevFull;
  const prevWord = periodWord(g, prevFull);
  const vs = inProgress ? 'vs this point in ' + prevWord : 'vs ' + prevWord;
  const curEnd: Period = { start: cur.start, end: inProgress ? addDays(t0, 1) : cur.end };
  const name = periodWord(g, cur);
  const during = (inProgress ? 'so far in ' : 'in ') + name;

  const finishedIn = (p: Period) => facts.filter((f) => inP(f.finishedOn, p));
  const startedIn = (p: Period) => facts.filter((f) => inP(f.start, p) && (f.start as Date) <= t0);
  const avgLen = (list: JobFacts[]) => { const d = list.map((f) => f.days).filter((x): x is number => x !== null); return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null; };
  const onTime = (list: JobFacts[]) => { const w = list.filter((f) => f.due); return w.length ? w.filter((f) => (lateBy(f) as number) <= 0).length / w.length * 100 : null; };

  const fin = finishedIn(curEnd), finBefore = finishedIn(prev);
  const st = startedIn(curEnd), stBefore = startedIn(prev);
  const lenNow = avgLen(fin), lenBefore = avgLen(finBefore);
  const otNow = onTime(fin), otBefore = onTime(finBefore);

  // Headline chart: the periods around the selected one.
  const N = WINDOW[g];
  // Ends at now; once the selection is older than the window, it slides
  // so the selection sits near the right edge.
  const windowEnd = state.offset > -(N - 1) ? 0 : Math.min(0, state.offset + 2);
  const bars: BarDatum[] = [];
  for (let o = windowEnd - N + 1; o <= windowEnd; o++) {
    const p = periodAt(g, o, t0);
    const pp: Period = { start: p.start, end: p.end > t0 ? addDays(t0, 1) : p.end };
    const nf = finishedIn(pp).length, ns = startedIn(pp).length;
    bars.push({
      key: o, label: periodShort(g, p, t0), title: periodName(g, p) + (p.end > t0 ? ' (so far)' : ''), partial: p.end > t0,
      value: state.metric === 'finished' ? nf : ns,
      rows: [{ label: 'finished', value: String(nf), color: METRIC_COLOR.finished }, { label: 'started', value: String(ns), color: METRIC_COLOR.started }],
    });
  }
  const complete = bars.filter((b) => !b.partial && (!earliest || periodAt(g, b.key, t0).end > earliest));
  const typical = complete.length ? complete.reduce((a, b) => a + b.value, 0) / complete.length : 0;

  const headline = (() => {
    const n = state.metric === 'finished' ? fin.length : st.length;
    const b = state.metric === 'finished' ? finBefore.length : stBefore.length;
    const verb = state.metric;
    const lead = inProgress
      ? 'So far in ' + name + ', ' + plural(n, 'job') + ' ' + (n === 1 ? 'has' : 'have') + ' ' + verb
      : plural(n, 'job') + ' ' + verb + ' in ' + name;
    const diff = n - b;
    const than = (inProgress ? 'this point in ' : '') + prevWord;
    return lead + (diff === 0 ? ', the same as ' + than : ', ' + Math.abs(diff) + (diff > 0 ? ' more' : ' fewer') + ' than ' + than) + '.';
  })();

  // Coming up: jobs with work scheduled each week.
  const wStart = monday(t0);
  const weekJobs: { f: JobFacts; stages: string[] }[][] = Array.from({ length: LOOKAHEAD_WEEKS }, () => []);
  open.forEach((f) => {
    const perWeek: Set<string>[] = Array.from({ length: LOOKAHEAD_WEEKS }, () => new Set<string>());
    getJobPhases(f.job).forEach((phase) => getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
      const s = validDate(t.start), e = validDate(t.finish) || s;
      if (!s) return;
      const a = Math.floor((parseDay(s).getTime() - wStart.getTime()) / DAY / 7);
      const z = Math.floor((parseDay(e).getTime() - wStart.getTime()) / DAY / 7);
      for (let w = Math.max(0, a); w <= Math.min(LOOKAHEAD_WEEKS - 1, z); w++) perWeek[w].add(t.columnId || '');
    })));
    perWeek.forEach((set, w) => {
      if (!set.size) return;
      const order = BOARD_COLUMNS.map((c) => c.id).filter((id) => set.has(id));
      weekJobs[w].push({ f, stages: order });
    });
  });
  weekJobs.forEach((list) => list.sort((a, b) => a.f.job.name.localeCompare(b.f.job.name)));
  const weekBars: BarDatum[] = weekJobs.map((list, w) => {
    const s = addDays(wStart, w * 7);
    return { key: w, label: shortDate(s), title: w === 0 ? 'This week' : 'Week of ' + shortDate(s), value: list.length,
      rows: [{ label: list.length === 1 ? 'job scheduled' : 'jobs scheduled', value: String(list.length), color: 'var(--rep-c1)' }] };
  });
  const weekAvg = weekBars.reduce((a, b) => a + b.value, 0) / LOOKAHEAD_WEEKS;
  const busiest = weekBars.reduce((m, b) => (b.value > m.value ? b : m), weekBars[0]);
  const selWeek = Math.min(lookWeek, LOOKAHEAD_WEEKS - 1);

  // Where open jobs are: the current stage of each open job's card.
  const stageMap = new Map<string, { list: JobFacts[]; days: number[] }>();
  open.forEach((f) => {
    const col = f.card && f.card.column;
    if (!col) return;
    const e = stageMap.get(col) || { list: [], days: [] };
    e.list.push(f);
    if (f.card && f.card.columnEnteredAt) e.days.push((Date.now() - (f.card.columnEnteredAt as number)) / DAY);
    stageMap.set(col, e);
  });
  const stages = BOARD_COLUMNS.filter((c) => stageMap.has(c.id)).map((c) => {
    const e = stageMap.get(c.id) as { list: JobFacts[]; days: number[] };
    return { id: c.id, label: c.label, color: stageColor(c.id), list: e.list, avg: e.days.length ? Math.round(e.days.reduce((a, b) => a + b, 0) / e.days.length) : null };
  });
  const stagedTotal = stages.reduce((n, s) => n + s.list.length, 0);

  // Overdue / stalled from Home's builders, scoped to the filters and to
  // OPEN jobs: Home only skips cards in a finished stage, so a job whose
  // work has all finished would otherwise show as past due here while the
  // Finished list calls it done.
  const openIds = new Set(open.map((f) => f.job.id));
  const overdue = buildHomeOverdueRows().filter((r) => r.isOverdue && openIds.has(r.job.id));
  const stalled = buildHomeStalledRows().filter((r) => openIds.has(r.job.id));

  // Insights: the few plain sentences worth reading first, most urgent first.
  const insights: Insight[] = [];
  if (overdue.length) {
    const worst = overdue.slice().sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0];
    const ago = Math.round((t0.getTime() - worst.dueDate.getTime()) / DAY);
    insights.push({ key: 'overdue', tone: 'critical', title: plural(overdue.length, 'job') + ' past due',
      body: <>{overdue.length > 1 ? 'Oldest is ' : ''}<a href="#" onClick={openJob(worst.job.id)}>{worst.label}</a>, due {shortDate(worst.dueDate)} ({plural(ago, 'day')} ago).</> });
  }
  if (stalled.length) {
    insights.push({ key: 'stalled', tone: 'warning', title: plural(stalled.length, 'job') + ' stuck longer than usual',
      body: <><a href="#" onClick={openJob(stalled[0].job.id)}>{stalled[0].label}</a> has been in {stalled[0].columnLabel} for {plural(stalled[0].daysInStage, 'day')}.</> });
  }
  if (busiest && busiest.value && weekAvg > 0 && busiest.value >= weekAvg * 1.3) {
    insights.push({ key: 'busy', tone: 'info', title: (busiest.key === 0 ? 'This week' : busiest.title) + ' is the busiest ahead',
      body: plural(busiest.value, 'job') + ' scheduled, about ' + pct((busiest.value / weekAvg - 1) * 100) + ' more than a typical week.' });
  }
  if (otNow !== null) {
    const w = fin.filter((f) => f.due);
    const hit = w.filter((f) => (lateBy(f) as number) <= 0).length;
    insights.push({ key: 'ontime', tone: otNow >= 80 ? 'good' : otNow >= 50 ? 'info' : 'warning',
      title: hit + ' of ' + w.length + ' finished on time',
      body: pct(otNow) + ' of jobs with a due date ' + during + (otBefore !== null ? ', compared with ' + pct(otBefore) + (inProgress ? ' at this point in ' : ' in ') + prevWord + '.' : '.') });
  }
  if (lenNow !== null && lenBefore !== null && Math.abs(lenNow - lenBefore) >= 2) {
    const faster = lenNow < lenBefore;
    insights.push({ key: 'len', tone: faster ? 'good' : 'info', title: 'Jobs are finishing ' + (faster ? 'faster' : 'slower'),
      body: 'Start to finish took ' + plural(Math.round(lenNow), 'day') + ' on average ' + during + ', ' + plural(Math.abs(Math.round(lenNow - lenBefore)), 'day') + (faster ? ' quicker' : ' longer') + ' than ' + prevWord + '.' });
  }
  if (!insights.length) insights.push({ key: 'calm', tone: 'good', title: 'Nothing needs attention', body: 'No overdue or stuck jobs, and the weeks ahead look even.' });

  // Breakdown by customer / PM / foreman / job type.
  const dim = DIMS.find((d) => d.key === state.groupBy) as typeof DIMS[number];
  const groups = new Map<string, JobFacts[]>();
  (state.groupMetric === 'open' ? open : fin).forEach((f) => { const k = f.dims[dim.key]; groups.set(k, (groups.get(k) || []).concat(f)); });
  const groupRows = Array.from(groups, ([gname, list]) => ({ name: gname, n: list.length }))
    .sort((a, b) => (a.name === NOT_SET ? 1 : b.name === NOT_SET ? -1 : b.n - a.n || a.name.localeCompare(b.name)));
  const groupTotal = groupRows.reduce((n, r) => n + r.n, 0);
  const groupMax = Math.max(1, ...groupRows.map((r) => r.n));

  const finSorted = fin.slice().sort((a, b) => (b.finishedOn as Date).getTime() - (a.finishedOn as Date).getTime());
  const finShown = showAllFinished ? finSorted : finSorted.slice(0, 6);

  return (
    <div class="rep-wrap">
      <div class="rep-top">
        <h2>Reports</h2>
        <Toolbar all={all} t0={t0} earliest={earliest} />
      </div>

      <section class="rep-hero">
        <p class="rep-headline">{headline}</p>
        <div class="rep-stats">
          <div class="rep-stat">
            <span class="rep-stat-label"><i style={{ background: METRIC_COLOR.finished }} />Finished</span>
            <span class="rep-stat-value">{fin.length}</span>
            <Change now={fin.length} before={finBefore.length} vs={vs} />
          </div>
          <div class="rep-stat">
            <span class="rep-stat-label"><i style={{ background: METRIC_COLOR.started }} />Started</span>
            <span class="rep-stat-value">{st.length}</span>
            <Change now={st.length} before={stBefore.length} vs={vs} />
          </div>
          <div class="rep-stat">
            <span class="rep-stat-label">On time</span>
            <span class="rep-stat-value">{otNow === null ? '—' : pct(otNow)}</span>
            {otNow === null ? <span class="rep-chg">No finished jobs with a due date</span> : <Change now={otNow} before={otBefore} unit=" pts" vs={vs} />}
          </div>
          <div class="rep-stat">
            <span class="rep-stat-label">Avg job length</span>
            <span class="rep-stat-value">{lenNow === null ? '—' : plural(Math.round(lenNow), 'day')}</span>
            {lenNow === null ? <span class="rep-chg">No finished jobs yet</span> : <Change now={lenNow} before={lenBefore} unit="d" lowerIsBetter vs={vs} />}
          </div>
        </div>
        <div class="rep-hero-chart">
          <div class="rep-chart-head">
            <Seg small label="Chart shows" value={state.metric} onChange={(m) => setState({ metric: m })}
              options={[{ key: 'finished', label: 'Jobs finished' }, { key: 'started', label: 'Jobs started' }]} />
            <span class="rep-hint">Click a bar to jump to that {g}</span>
          </div>
          <Bars data={bars} selected={state.offset} onSelect={(k) => setState({ offset: k })} color={METRIC_COLOR[state.metric]} height={190}
            avg={typical || undefined} avgLabel={'avg ' + (Math.round(typical * 10) / 10)} ariaLabel={'Jobs ' + state.metric + ' per ' + g} />
        </div>
      </section>

      <Insights items={insights.slice(0, 4)} />

      <div class="rep-cols2">
        <Card title={'Finished ' + during} sub={fin.length ? plural(fin.length, 'job') + (otNow !== null ? ' · ' + pct(otNow) + ' on time' : '') : undefined}>
          {finSorted.length ? (
            <>
              <ul class="rep-jobs">
                {finShown.map((f) => <JobRow key={f.job.id} f={f} right={<><span class="rep-date">{shortDate(f.finishedOn as Date)}</span><DueBadge f={f} /></>} />)}
              </ul>
              {finSorted.length > 6 ? <button type="button" class="rep-link rep-more" onClick={() => rerender(() => { showAllFinished = !showAllFinished; })}>{showAllFinished ? 'Show fewer' : 'Show all ' + finSorted.length}</button> : null}
            </>
          ) : <p class="rep-empty">No jobs finished {inProgress ? 'yet ' : ''}in {name}.</p>}
        </Card>

        <Card title="Where open jobs are" sub={plural(open.length, 'open job') + ' right now · click a stage to see them'}>
          {stagedTotal ? (
            <>
              <div class="rep-stack" aria-hidden="true">
                {stages.map((s) => <span key={s.id} style={{ flexGrow: s.list.length, background: s.color }} />)}
              </div>
              <ul class="rep-stage-list">
                {stages.map((s) => {
                  const isOpen = openStage === s.id;
                  return (
                    <li key={s.id}>
                      <button type="button" class="rep-stage-row" aria-expanded={isOpen} onClick={() => rerender(() => { openStage = isOpen ? null : s.id; })}>
                        <i style={{ background: s.color }} />
                        <span class="rep-stage-name">{s.label}<small>{s.avg ? 'avg ' + plural(s.avg, 'day') + ' here' : ''}</small></span>
                        <span class="rep-stage-n">{s.list.length}</span>
                        <span class="rep-stage-pct">{pct(s.list.length / stagedTotal * 100)}</span>
                        <span class="rep-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      </button>
                      {isOpen ? (
                        <ul class="rep-jobs nested">
                          {s.list.map((f) => <JobRow key={f.job.id} f={f} right={f.lastFinish ? <span class="rep-date">ends {shortDate(f.lastFinish)}</span> : null} />)}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : <p class="rep-empty">No open jobs.</p>}
        </Card>
      </div>

      <Card title="Coming up" class="wide"
        sub={weekAvg ? 'Jobs with work scheduled each week · click a week to see who’s on it' : 'Nothing scheduled in the next ' + LOOKAHEAD_WEEKS + ' weeks'}>
        {weekAvg ? (
          <div class="rep-lookahead">
            <Bars data={weekBars} selected={selWeek} onSelect={(k) => rerender(() => { lookWeek = k; })} color="var(--rep-c1)" height={150}
              avg={weekAvg} avgLabel="typical" ariaLabel="Jobs scheduled per week" />
            <div class="rep-week-detail">
              <h4>{weekBars[selWeek].title}<span>{plural(weekJobs[selWeek].length, 'job')}</span></h4>
              {weekJobs[selWeek].length ? (
                <ul class="rep-jobs">
                  {weekJobs[selWeek].map(({ f, stages: st2 }) => (
                    <JobRow key={f.job.id} f={f} right={
                      <span class="rep-stage-chips">
                        {st2.map((c) => <span class="rep-stage-chip" key={c}><i style={{ background: stageColor(c) }} />{(BOARD_COLUMNS.find((x) => x.id === c) || { label: 'Other' }).label}</span>)}
                      </span>} />
                  ))}
                </ul>
              ) : <p class="rep-empty">Nothing scheduled that week.</p>}
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="Breakdown" class="wide"
        sub={state.groupMetric === 'open' ? 'Open jobs right now · click a name to filter the page' : 'Jobs finished ' + during + ' · click a name to filter the page'}
        aside={<>
          <Seg small label="Group by" value={state.groupBy} onChange={(k) => setState({ groupBy: k })} options={DIMS.map((d) => ({ key: d.key, label: d.label }))} />
          <Seg small label="Count" value={state.groupMetric} onChange={(k) => setState({ groupMetric: k })} options={[{ key: 'open', label: 'Open' }, { key: 'finished', label: 'Finished' }]} />
        </>}>
        {groupRows.length ? (
          <ul class="rep-rank">
            {groupRows.map((r) => (
              <li key={r.name}>
                <span class={'rep-rank-name' + (r.name === NOT_SET ? ' muted' : '')}>
                  {r.name !== NOT_SET && !state[dim.key]
                    ? <a href="#" title={'Show only ' + r.name} onClick={(e) => { e.preventDefault(); setState({ [dim.key]: r.name } as Partial<ViewState>); }}>{r.name}</a>
                    : r.name}
                </span>
                <span class="rep-rank-track" aria-hidden="true"><span style={{ width: (r.n / groupMax * 100) + '%' }} /></span>
                <span class="rep-rank-n">{r.n}</span>
                <span class="rep-rank-pct">{pct(r.n / groupTotal * 100)}</span>
              </li>
            ))}
          </ul>
        ) : <p class="rep-empty">{state.groupMetric === 'open' ? 'No open jobs.' : 'No jobs finished ' + during + '.'}</p>}
      </Card>
    </div>
  );
}

// The filter menu closes on any click outside it.
document.addEventListener('click', (e) => {
  if (!filterMenuOpen) return;
  const t = e.target as HTMLElement;
  if (t.closest && !t.closest('.rep-filter-wrap')) { filterMenuOpen = false; renderReports(); }
});

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
