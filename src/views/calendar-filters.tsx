import { render } from 'preact';
import type { Job } from '../core/types';
import { getPrimaryPhaseCard } from '../core/models';
import { displayNameForUsername } from '../app/user-roster';

// Calendar tab's view options (#calFilterBar in the toolbar): "Stages" vs
// "Jobs" (one plain bar per job instead of a bar per stage run), and one
// Filter menu for job, person (the job's project manager or foreman, the
// same card fields Reports uses) and stage. Active filters show as
// removable chips, same look as Reports' own toolbar (the .rep-* classes).
// Remembered per browser.

export interface CalendarViewOptions {
  perJob: boolean;
  jobId: string;
  person: string;   // username
  stage: string;    // BOARD_COLUMNS id
}

const STORE_KEY = 'teamsync_calendar_view_v1';
const EMPTY: CalendarViewOptions = { perJob: false, jobId: '', person: '', stage: '' };

function load(): CalendarViewOptions {
  try { return Object.assign({}, EMPTY, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) { return Object.assign({}, EMPTY); }
}

let view: CalendarViewOptions = load();
let menuOpen = false;

export function getCalendarViewOptions(): CalendarViewOptions { return view; }

function jobPeople(job: Job): string[] {
  const card = getPrimaryPhaseCard(job);
  const f = (card && card.customFields) || {};
  return ['pm', 'foreman'].map((k) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '')).filter(Boolean);
}

// Job and person filters; the stage filter is applied while building rows
// (buildCalendarJobRows()'s onlyColumnId), since it narrows tasks, not jobs.
export function filterCalendarJobs<T extends { id: string }>(list: T[]): T[] {
  return list.filter((j) => {
    if (view.jobId && j.id !== view.jobId) return false;
    if (view.person && jobPeople(j as unknown as Job).indexOf(view.person) === -1) return false;
    return true;
  });
}

export function renderCalendarFilterBar(container: HTMLElement, p: { jobs: Job[]; mode: string; onChange: () => void }): void {
  const set = (patch: Partial<CalendarViewOptions>) => {
    view = Object.assign({}, view, patch);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(view)); } catch (e) { /* private mode: keep in memory */ }
    p.onChange();
  };
  const rerender = (fn: () => void) => { fn(); renderCalendarFilterBar(container, p); };

  const jobs = p.jobs.slice().sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name));
  const people = Array.from(new Set(p.jobs.flatMap(jobPeople)));
  if (view.person && people.indexOf(view.person) === -1) people.push(view.person);
  people.sort((a, b) => displayNameForUsername(a).localeCompare(displayNameForUsername(b)));
  const stages = BOARD_COLUMNS.filter((c) => !c.hideFromSchedule || c.id === view.stage);

  const jobName = (id: string) => { const j = p.jobs.find((x) => x.id === id); return j ? j.name : 'Removed job'; };
  const stageName = (id: string) => { const c = BOARD_COLUMNS.find((x) => x.id === id); return c ? c.label : 'Removed stage'; };
  const chips = [
    view.jobId ? { key: 'jobId', label: 'Job', value: jobName(view.jobId) } : null,
    view.person ? { key: 'person', label: 'Person', value: displayNameForUsername(view.person) } : null,
    view.stage ? { key: 'stage', label: 'Stage', value: stageName(view.stage) } : null,
  ].filter(Boolean) as { key: keyof CalendarViewOptions; label: string; value: string }[];

  render(
    <>
      {p.mode !== 'day' ? (
        <div class="rep-seg small" role="group" aria-label="Bars">
          <button type="button" class={!view.perJob ? 'active' : ''} aria-pressed={!view.perJob} title="A bar for each stage" onClick={() => set({ perJob: false })}>Stages</button>
          <button type="button" class={view.perJob ? 'active' : ''} aria-pressed={view.perJob} title="One bar per job, start to finish" onClick={() => set({ perJob: true })}>Jobs</button>
        </div>
      ) : null}
      <div class="rep-filter-wrap">
        <button type="button" class={'rep-filter-btn' + (chips.length ? ' set' : '')} aria-expanded={menuOpen} onClick={() => rerender(() => { menuOpen = !menuOpen; })}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
          Filter{chips.length ? ' · ' + chips.length : ''}
        </button>
        {menuOpen ? (
          <div class="rep-filter-menu cal-filter-menu">
            <label>
              <span>Job</span>
              <select value={view.jobId} onChange={(e) => set({ jobId: (e.target as HTMLSelectElement).value })}>
                <option value="">All jobs</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.name + (j.archived ? ' (archived)' : '')}</option>)}
              </select>
            </label>
            <label>
              <span>Person (project manager or foreman)</span>
              <select value={view.person} onChange={(e) => set({ person: (e.target as HTMLSelectElement).value })}>
                <option value="">Everyone</option>
                {people.map((u) => <option key={u} value={u}>{displayNameForUsername(u)}</option>)}
              </select>
            </label>
            <label>
              <span>Stage</span>
              <select value={view.stage} onChange={(e) => set({ stage: (e.target as HTMLSelectElement).value })}>
                <option value="">All stages</option>
                {stages.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <button type="button" class="rep-link" onClick={() => rerender(() => { menuOpen = false; })}>Done</button>
          </div>
        ) : null}
      </div>
      {chips.map((c) => (
        <span class="rep-chip" key={c.key}>
          <span class="rep-chip-k">{c.label}:</span> {c.value}
          <button type="button" aria-label={'Remove ' + c.label + ' filter'} onClick={() => set({ [c.key]: '' } as Partial<CalendarViewOptions>)}>×</button>
        </span>
      ))}
    </>,
    container,
  );
}
