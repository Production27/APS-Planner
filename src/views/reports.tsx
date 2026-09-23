import { render } from 'preact';
import { formatDate } from '../utils/date';
import type { Job, Task } from '../core/types';
import { getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from '../core/models';
import { getVisibleJobs, isJobFinished, syncCardColumns } from '../core/jobs';
import { buildHomeOverdueRows, buildHomeStalledRows, buildHomeStageSummary } from './home';
import { displayNameForUsername } from '../app/user-roster';
import { realTasks, validDate } from '../app/export';

// Reports tab (#panel-reports; roadmap item A3, part 4). Everything is
// derived live from the same data every other view reads — nothing is
// stored — and reuses Home's own builders for overdue/stalled/stage
// counts so the two can never disagree. Scope: jobs this user can see,
// archived and linked-reference jobs excluded.
//
// Deliberately NOT here: "on-time %" / "late tasks". A job's stage moves
// automatically with its scheduled dates (syncCardColumns()), and nothing
// records when work actually finished, so any on-time figure would just
// restate the schedule. It becomes measurable once crews mark tasks done
// (roadmap J3).

const DAY = 86400000;
const WEEKS = 8;

function today0(): Date { return new Date(new Date().toDateString()); }
function monday(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function parseDay(s: string): Date { return new Date(s + 'T00:00:00'); }
function shortDate(d: Date): string { return formatDate(d, { month: 'short', day: 'numeric' }, undefined); }

function reportJobs(): Job[] {
  return getVisibleJobs().filter((j) => !j.archived && !j.isLinkedReference);
}

function openJob(jobId: string) {
  return (e: Event) => { e.preventDefault(); editJob(jobId); };
}

// ===== Data =====

interface StageBar { id: string; label: string; count: number; color: string; }
interface WeekSeg { id: string; label: string; color: string; count: number; }
interface WeekCol { label: string; total: number; segs: WeekSeg[]; }
interface Upcoming { date: Date; jobId: string; job: string; what: string; }
interface CountRow { name: string; count: number; }

// A stage's own board color when it has one; otherwise a slot from the
// validated categorical palette (--rep-c1..8 in index.html, stepped
// separately for dark mode), chosen by the stage's position so a stage
// keeps the same color in every chart and on every visit.
function stageColor(colId: string): string {
  const i = BOARD_COLUMNS.findIndex((c) => c.id === colId);
  if (i === -1) return 'var(--rep-other)';
  return BOARD_COLUMNS[i].color || 'var(--rep-c' + ((i % 8) + 1) + ')';
}

function stageBars(): StageBar[] {
  return buildHomeStageSummary().map((s) => ({ id: s.id, label: s.label, count: s.count, color: stageColor(s.id) }));
}

// Per week: how many job rows (a job, or one phase of a phased job) have
// at least one task of each stage scheduled that week. A row is counted
// once per stage per week, however many days it spans.
function workload(): { weeks: WeekCol[]; series: WeekSeg[] } {
  const start = monday(today0());
  const seriesOrder: WeekSeg[] = BOARD_COLUMNS.map((c) => ({ id: c.id, label: c.label, color: stageColor(c.id), count: 0 }));
  const other: WeekSeg = { id: '__other', label: 'Other', color: 'var(--rep-other)', count: 0 };
  const counts: Record<string, number>[] = Array.from({ length: WEEKS }, () => ({}));
  reportJobs().forEach((job) => {
    getJobPhases(job).forEach((phase) => {
      const seen: Set<string>[] = Array.from({ length: WEEKS }, () => new Set<string>());
      getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t: Task) => {
        const s = validDate(t.start), f = validDate(t.finish) || s;
        if (!s) return;
        const key = t.columnId && BOARD_COLUMNS.some((c) => c.id === t.columnId) ? t.columnId : '__other';
        const a = Math.floor((parseDay(s).getTime() - start.getTime()) / DAY / 7);
        const b = Math.floor((parseDay(f).getTime() - start.getTime()) / DAY / 7);
        for (let w = Math.max(0, a); w <= Math.min(WEEKS - 1, b); w++) seen[w].add(key);
      }));
      seen.forEach((keys, w) => keys.forEach((k) => { counts[w][k] = (counts[w][k] || 0) + 1; }));
    });
  });
  const all = seriesOrder.concat(other);
  const used = all.filter((s) => counts.some((c) => c[s.id]));
  const weeks: WeekCol[] = counts.map((c, w) => {
    const segs = used.map((s) => ({ ...s, count: c[s.id] || 0 })).filter((s) => s.count > 0);
    return { label: shortDate(new Date(start.getTime() + w * 7 * DAY)), total: segs.reduce((n, s) => n + s.count, 0), segs };
  });
  return { weeks, series: used };
}

function upcoming(days: number): Upcoming[] {
  const t0 = today0();
  const end = new Date(t0.getTime() + days * DAY);
  const out: Upcoming[] = [];
  reportJobs().forEach((job) => {
    const phases = getJobPhases(job);
    phases.forEach((phase) => {
      const label = job.name + (phases.length > 1 && !phase.isDefault ? ' — ' + phase.name : '');
      getPhaseSubUnits(phase).forEach((sub) => realTasks(sub.tasks).forEach((t) => {
        const f = validDate(t.finish);
        if (!f) return;
        const d = parseDay(f);
        if (d >= t0 && d < end) out.push({ date: d, jobId: job.id, job: label, what: (t.name || 'Task') + ' finishes' });
      }));
      const card = getPhaseCard(job, phase.id);
      const due = card ? validDate(card.due) : '';
      if (due) {
        const d = parseDay(due);
        if (d >= t0 && d < end) out.push({ date: d, jobId: job.id, job: label, what: 'Due date' });
      }
    });
  });
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.job.localeCompare(b.job));
}

function countBy(fieldKey: string, isPerson: boolean): CountRow[] {
  const counts = new Map<string, number>();
  reportJobs().filter((j) => !isJobFinished(j)).forEach((job) => {
    const card = getPrimaryPhaseCard(job);
    const raw = card && card.customFields ? card.customFields[fieldKey] : '';
    let name = typeof raw === 'string' ? raw.trim() : '';
    if (name && isPerson) name = displayNameForUsername(name);
    name = name || 'Not set';
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name === 'Not set' ? 1 : b.name === 'Not set' ? -1 : b.count - a.count || a.name.localeCompare(b.name)));
}

// ===== Components =====

function Tile(p: { label: string; value: number; note: string; tone?: 'critical' | 'warning' }) {
  const alert = p.tone && p.value > 0;
  return (
    <div class={'rep-tile' + (alert ? ' ' + p.tone : '')}>
      <div class="rep-tile-label">
        {alert ? <span class="rep-status-icon" aria-hidden="true">{p.tone === 'critical' ? '!' : '◷'}</span> : null}
        {p.label}
      </div>
      <div class="rep-tile-value">{p.value}</div>
      <div class="rep-tile-note">{p.note}</div>
    </div>
  );
}

function StageChart({ bars }: { bars: StageBar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div class="rep-hbars" role="list">
      {bars.map((b) => (
        <div class="rep-hbar-row" role="listitem" key={b.id} title={b.label + ': ' + b.count + (b.count === 1 ? ' job' : ' jobs')}>
          <span class="rep-hbar-label"><i class="rep-swatch" style={{ background: b.color }} />{b.label}</span>
          <span class="rep-hbar-track"><span class="rep-hbar-fill" style={{ width: (b.count / max * 100) + '%', background: b.color }} /></span>
          <span class="rep-hbar-value">{b.count}</span>
        </div>
      ))}
    </div>
  );
}

function WorkloadChart({ data }: { data: ReturnType<typeof workload> }) {
  const max = Math.max(1, ...data.weeks.map((w) => w.total));
  const top = max <= 4 ? max : Math.ceil(max / 2) * 2;
  if (!data.series.length) return <p class="rep-empty">Nothing is scheduled in the next {WEEKS} weeks.</p>;
  return (
    <>
      <div class="rep-legend">
        {data.series.map((s) => <span key={s.id}><i class="rep-swatch" style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <div class="rep-vbars" style={{ '--rep-weeks': String(WEEKS) } as Record<string, string>}>
        <div class="rep-vbars-grid" aria-hidden="true">
          <span style={{ bottom: '100%' }}>{top}</span>
          <span style={{ bottom: '50%' }}>{Math.round(top / 2)}</span>
          <span style={{ bottom: '0%' }}>0</span>
        </div>
        {data.weeks.map((w, i) => (
          <div class="rep-vbar-col" key={i}>
            <div class="rep-vbar-stack" title={'Week of ' + w.label + ': ' + w.total + ' scheduled'}>
              {w.segs.map((s) => (
                <span key={s.id} class="rep-vbar-seg" style={{ height: (s.count / top * 100) + '%', background: s.color }}
                  title={'Week of ' + w.label + ' · ' + s.label + ': ' + s.count} />
              ))}
            </div>
            <div class="rep-vbar-total">{w.total || ''}</div>
            <div class="rep-vbar-label">{w.label}</div>
          </div>
        ))}
      </div>
      <details class="rep-table-toggle">
        <summary>Show as table</summary>
        <div class="rep-table-scroll">
          <table class="rep-table">
            <thead><tr><th>Week of</th>{data.series.map((s) => <th key={s.id} class="num">{s.label}</th>)}<th class="num">Total</th></tr></thead>
            <tbody>
              {data.weeks.map((w, i) => (
                <tr key={i}><td>{w.label}</td>
                  {data.series.map((s) => <td key={s.id} class="num">{(w.segs.find((x) => x.id === s.id) || { count: 0 }).count}</td>)}
                  <td class="num"><b>{w.total}</b></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function Panel(p: { title: string; sub?: string; children: any; wide?: boolean }) {
  return (
    <section class={'rep-panel' + (p.wide ? ' wide' : '')}>
      <header><h3>{p.title}</h3>{p.sub ? <span>{p.sub}</span> : null}</header>
      {p.children}
    </section>
  );
}

function ReportsView() {
  syncCardColumns();
  const overdueRows = buildHomeOverdueRows();
  const overdue = overdueRows.filter((r) => r.isOverdue);
  const dueSoon = overdueRows.filter((r) => !r.isOverdue);
  const stalled = buildHomeStalledRows();
  const active = reportJobs().filter((j) => !isJobFinished(j)).length;
  const next = upcoming(14);
  const byCustomer = countBy('customer', false);
  const byPm = countBy('pm', true);
  const attention = [
    ...overdue.map((r) => ({ key: 'o' + r.card.id, jobId: r.job.id, label: r.label, why: 'Overdue — was due ' + shortDate(r.dueDate), tone: 'critical' })),
    ...stalled.map((r) => ({ key: 's' + r.card.id, jobId: r.job.id, label: r.label, why: r.daysInStage + ' days in ' + r.columnLabel, tone: 'warning' })),
  ];

  return (
    <div class="rep-wrap">
      <div class="rep-head">
        <h2>Reports</h2>
        <span>Live from this project · as of {new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <div class="rep-tiles">
        <Tile label="Active jobs" value={active} note="Scheduled work not yet finished" />
        <Tile label="Overdue" value={overdue.length} note="Past their due date" tone="critical" />
        <Tile label="Due in 7 days" value={dueSoon.length} note="Due dates coming up" />
        <Tile label="Stalled" value={stalled.length} note="Sitting in one stage too long" tone="warning" />
      </div>
      <div class="rep-grid">
        <Panel title="Jobs by stage" sub="Board cards in each stage">
          <StageChart bars={stageBars()} />
        </Panel>
        <Panel title="Needs attention" sub={attention.length ? attention.length + ' item' + (attention.length === 1 ? '' : 's') : 'All clear'}>
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
        <Panel title={'Workload — next ' + WEEKS + ' weeks'} sub="Jobs with work scheduled each week, by task" wide>
          <WorkloadChart data={workload()} />
        </Panel>
        <Panel title="Coming up" sub="Next 14 days">
          {next.length ? (
            <div class="rep-table-scroll">
              <table class="rep-table">
                <thead><tr><th>Date</th><th>Job</th><th>What</th></tr></thead>
                <tbody>
                  {next.map((u, i) => (
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
        <Panel title="Active jobs by customer and project manager">
          <div class="rep-two">
            <table class="rep-table">
              <thead><tr><th>Customer</th><th class="num">Jobs</th></tr></thead>
              <tbody>{byCustomer.map((r) => <tr key={r.name}><td class={r.name === 'Not set' ? 'muted' : ''}>{r.name}</td><td class="num">{r.count}</td></tr>)}</tbody>
            </table>
            <table class="rep-table">
              <thead><tr><th>Project manager</th><th class="num">Jobs</th></tr></thead>
              <tbody>{byPm.map((r) => <tr key={r.name}><td class={r.name === 'Not set' ? 'muted' : ''}>{r.name}</td><td class="num">{r.count}</td></tr>)}</tbody>
            </table>
          </div>
        </Panel>
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

