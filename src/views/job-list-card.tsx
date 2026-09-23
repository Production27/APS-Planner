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
  // Same job-colored title as the Board's cards (see BoardCardProps.
  // titleColorLight/Dark in board-card.tsx) — set as custom properties so
  // a dark-mode toggle doesn't need a re-render.
  titleColorLight: string;
  titleColorDark: string;
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
      <div class="job-card-title" style={{ '--jct-light': p.titleColorLight, '--jct-dark': p.titleColorDark } as Record<string, string>}>{p.name}{p.archived ? <span style={{ fontSize: 'var(--t-2xs)', color: '#888' }}> (archived)</span> : null}</div>
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
      <button
        class="job-card-menu-btn"
        title="More actions"
        aria-label={'More actions for ' + p.name}
        aria-haspopup="menu"
        aria-expanded="false"
        onClick={(e) => { e.stopPropagation(); openJobCardMenu(e.currentTarget as HTMLElement, p); }}
        onKeyDown={(e) => e.stopPropagation()}
      >⋯</button>
    </div>
  );
}

// ===== Job card "⋯" menu =====
// Duplicate and Delete used to be two always-visible icon buttons side by
// side on every card, which made Delete easy to hit by accident. They now
// live behind one ⋯ button. The menu is a plain element appended to
// <body> rather than rendered inside the card: .job-card clips its
// overflow and lifts on hover with a transform, either of which would clip
// or mis-position a dropdown nested inside it. Only one is ever open.
let openCardMenu: { el: HTMLElement; anchor: HTMLElement; cleanup: () => void } | null = null;

function closeJobCardMenu(restoreFocus?: boolean): void {
  if (!openCardMenu) return;
  const { el, anchor, cleanup } = openCardMenu;
  openCardMenu = null;
  cleanup();
  el.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) anchor.focus();
}

function openJobCardMenu(anchor: HTMLElement, p: JobCardProps): void {
  const wasThisOne = openCardMenu && openCardMenu.anchor === anchor;
  closeJobCardMenu();
  if (wasThisOne) return;

  const menu = document.createElement('div');
  menu.className = 'job-card-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions for ' + p.name);
  const addItem = (label: string, cls: string, run: (e: Event) => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'job-card-menu-item' + (cls ? ' ' + cls : '');
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); closeJobCardMenu(); run(e); };
    menu.appendChild(b);
    return b;
  };
  addItem('Duplicate job', '', p.onDuplicate);
  const sep = document.createElement('div');
  sep.className = 'job-card-menu-sep';
  sep.setAttribute('role', 'separator');
  menu.appendChild(sep);
  addItem('Delete job…', 'danger', p.onDelete);
  document.body.appendChild(menu);

  // Right-aligned under the button, flipped above it if it would run off
  // the bottom of the window. Re-run when the job list scrolls so the menu
  // follows its button (clicking a half-visible card's button scrolls the
  // list a little to bring it into view); closes once the button itself
  // scrolls out of the list's visible area.
  const listEl = anchor.closest('.job-list') as HTMLElement | null;
  const position = (): boolean => {
    const r = anchor.getBoundingClientRect();
    if (listEl) {
      const lr = listEl.getBoundingClientRect();
      if (r.bottom < lr.top || r.top > lr.bottom) return false;
    }
    const mh = menu.offsetHeight;
    const top = r.bottom + 4 + mh > window.innerHeight ? r.top - 4 - mh : r.bottom + 4;
    menu.style.top = Math.max(4, top) + 'px';
    menu.style.left = Math.max(4, r.right - menu.offsetWidth) + 'px';
    return true;
  };
  position();
  anchor.setAttribute('aria-expanded', 'true');

  const items = Array.from(menu.querySelectorAll('.job-card-menu-item')) as HTMLElement[];
  const onDocDown = (e: Event) => { if (!menu.contains(e.target as Node) && e.target !== anchor) closeJobCardMenu(); };
  const scroller: HTMLElement | Window = listEl || window;
  const onScroll = () => { if (!position()) closeJobCardMenu(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); closeJobCardMenu(true); return; }
    if (e.key === 'Tab') { closeJobCardMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('touchstart', onDocDown, true);
  scroller.addEventListener('scroll', onScroll);
  window.addEventListener('resize', onScroll);
  document.addEventListener('keydown', onKey, true);
  openCardMenu = {
    el: menu, anchor,
    cleanup: () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('touchstart', onDocDown, true);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey, true);
    },
  };
  items[0].focus();
}

interface JobListViewProps {
  cards: JobCardProps[];
  onAddJob: () => void;
  archivedCount: number;
  onOpenArchived: () => void;
}

function JobListView({ cards, onAddJob, archivedCount, onOpenArchived }: JobListViewProps) {
  return (
    <>
      {cards.map((c) => <JobCard key={c.jobKey} {...c} />)}
      <button class="job-list-add-btn" onClick={onAddJob}>+ Add Job</button>
      {archivedCount > 0 ? (
        <button class="job-list-archived-link" onClick={onOpenArchived}>
          Archived jobs ({archivedCount})
        </button>
      ) : null}
    </>
  );
}

export function renderJobListInto(container: HTMLElement, cards: JobCardProps[], onAddJob: () => void, archivedCount: number, onOpenArchived: () => void): void {
  render(<JobListView cards={cards} onAddJob={onAddJob} archivedCount={archivedCount} onOpenArchived={onOpenArchived} />, container);
}
