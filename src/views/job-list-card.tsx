import { render } from 'preact';

// Job Manager's job list sidebar (#jobList) — a static, empty element from
// index.html exclusively written to by renderJobList() (see job-list.ts)
// and nothing else, same "safe to hand over directly, no wrapper needed"
// case as every other converted list in this app.
//
// Was a full innerHTML teardown+rebuild on every call, including every
// debounced search keystroke (see filterJobList()) and every unrelated
// renderAll() sweep — this is the same "fresh container every render"
// cost Board's card faces already fixed, just for the job list instead of
// the kanban board. Converting it means the list's own scroll position
// and the currently-open job's `.active` highlight both now survive a
// background re-render instead of resetting.

export interface JobBoardDotProps {
  dotKey: string;
  color: string;
  title: string;
}

export interface JobCardProps {
  jobKey: string;
  active: boolean;
  archived: boolean;
  finished: boolean;
  color: string;
  name: string;
  dateRangeLabel: string | null;
  // A phased job shows one dot per phase (boardDots); an unphased job
  // shows at most one labeled tag (singleBoardTag) — never both, see
  // renderJobList()'s own comment in job-list.ts for why a single tag
  // can't represent N independently-tracked phase stages.
  boardDots: JobBoardDotProps[] | null;
  singleBoardTag: { color: string; label: string } | null;
  commentCount: number;
  onActivate: () => void;
  onDuplicate: (e: Event) => void;
  onDelete: (e: Event) => void;
}

function onEnterOrSpace(fn: () => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

function JobCard(p: JobCardProps) {
  return (
    <div
      class={'job-card' + (p.active ? ' active' : '') + (p.archived ? ' archived' : '') + (p.finished ? ' finished' : '')}
      tabIndex={0}
      role="button"
      onClick={p.onActivate}
      onKeyDown={onEnterOrSpace(p.onActivate)}
    >
      <div class="color-strip" style={{ background: p.color }} />
      <div class="job-card-title">{p.name}{p.archived ? <span style={{ fontSize: 'var(--t-2xs)', color: '#888' }}> (archived)</span> : null}</div>
      <div class="job-card-meta">
        {p.dateRangeLabel ? (
          <span>
            <svg viewBox="0 0 24 24" width="15" height="15" style={{ verticalAlign: '-3px', marginRight: 'var(--s-0-75)' }} xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5" /><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935" /><rect x="6" y="13" width="3" height="3" fill="#e53935" /><rect x="10.5" y="13" width="3" height="3" fill="#e53935" /><rect x="15" y="13" width="3" height="3" fill="#e53935" /></svg>
            {p.dateRangeLabel}
          </span>
        ) : null}
        {p.boardDots ? (
          <span class="job-card-phase-dots">
            {p.boardDots.map((d) => <span key={d.dotKey} class="job-card-board-dot" style={{ background: d.color }} title={d.title} />)}
          </span>
        ) : null}
        {p.singleBoardTag ? (
          <span class="job-card-board-tag" title="Current board">
            <span class="job-card-board-dot" style={{ background: p.singleBoardTag.color }} />
            {p.singleBoardTag.label}
          </span>
        ) : null}
        {p.commentCount ? (
          <span class="note-icon" title={p.commentCount + ' comment' + (p.commentCount === 1 ? '' : 's')}>
            <svg viewBox="0 0 24 24" width="15" height="15" style={{ verticalAlign: '-3px', marginRight: 'var(--s-0-75)' }} xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16v12H8l-4 4V4z" fill="#3949ab" /></svg>
            {' ' + p.commentCount}
          </span>
        ) : null}
      </div>
      <button class="copy-btn" onClick={p.onDuplicate} title="Duplicate" aria-label="Duplicate job">
        <svg viewBox="0 0 24 24" width="13" height="13" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" /></svg>
      </button>
      <button class="delete-btn" onClick={p.onDelete} title="Delete" aria-label="Delete job">×</button>
    </div>
  );
}

function JobListView({ cards, onAddJob }: { cards: JobCardProps[]; onAddJob: () => void }) {
  return (
    <>
      {cards.map((c) => <JobCard key={c.jobKey} {...c} />)}
      <button class="job-list-add-btn" onClick={onAddJob}>+ Add Job</button>
    </>
  );
}

export function renderJobListInto(container: HTMLElement, cards: JobCardProps[], onAddJob: () => void): void {
  render(<JobListView cards={cards} onAddJob={onAddJob} />, container);
}
