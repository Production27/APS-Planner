import { render } from 'preact';

// Board card faces, into each column's now-persistent col-body-<id> (see
// board.ts's rebuildBoardColumnChrome()/renderBoard() — this is the piece
// that prerequisite made possible). Card drag-and-drop uses native HTML5
// DnD, not a hand-rolled mousedown/mousemove system like Gantt's bars —
// there's no continuous live style mutation to worry about here, just a
// classList toggle on dragstart/dragend and a live drop-position preview
// (insertBefore/appendChild) in applyColumnDragOver() that matches
// elements by class + dataset.id, never DOM node identity. draggedCardId
// is already one of the state vars isBusyEditing() (src/sync/connection.ts)
// checks, so — same as every other Preact piece so far — no render ever
// runs while a card drag is in progress.
//
// The handful of card-face icons are static SVG markup (no card data ever
// interpolated inside one) lifted verbatim from the old innerHTML-string
// version, rendered via dangerouslySetInnerHTML rather than retyped as
// JSX — avoids any risk of a subtle JSX/SVG-attribute translation bug for
// markup that was already correct. Every genuinely dynamic value (title,
// custom-field values, badge labels) renders as an ordinary JSX text
// child instead, which Preact escapes automatically — the manual
// escapeHtml() calls the old innerHTML-string version needed everywhere
// are gone; there's no HTML string left to escape into.

const OVERRIDE_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" style="vertical-align:-2px" xmlns="http://www.w3.org/2000/svg"><path d="M13 3l-9 10h6l-1 8 9-10h-6l1-8z" fill="#f0ad4e"/></svg>';
const DUE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935"/><rect x="6" y="13" width="3" height="3" fill="#e53935"/><rect x="10.5" y="13" width="3" height="3" fill="#e53935"/><rect x="15" y="13" width="3" height="3" fill="#e53935"/></svg>';
const STALLED_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="13" r="8" fill="#fff" stroke="#e53935" stroke-width="1.5"/><path d="M12 9v4l3 2" stroke="#e53935" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECKLIST_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ATTACHMENT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M8 12.5V7a4 4 0 018 0v9a2.5 2.5 0 01-5 0V8.5" stroke="#78909c" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';

function Icon({ svg }: { svg: string }) {
  return <span dangerouslySetInnerHTML={{ __html: svg }} />;
}

export interface CardMetaLine {
  label: string;
  value: string;
}

export interface CardOverrideBadge {
  title: string;
  onClick: () => void;
}

export interface CardDueBadge {
  overdue: boolean;
  label: string;
}

export interface CardStalledBadge {
  title: string;
  label: string;
}

export interface CardChecklistBadge {
  complete: boolean;
  label: string;
}

export interface BoardCardProps {
  id: string;
  manualOverride: boolean;
  draggable: boolean;
  borderLeftColor: string;
  title?: string;
  overrideBadge: CardOverrideBadge | null;
  cardTitle: string;
  metaLines: CardMetaLine[];
  dueBadge: CardDueBadge | null;
  stalledBadge: CardStalledBadge | null;
  checklistBadge: CardChecklistBadge | null;
  attachmentsLabel: string | null;
  moveSelectOptions: { id: string; label: string }[];
  moveSelectValue: string;
  onMoveChange: (newColumnId: string) => void;
  onOpen: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: (e: DragEvent) => void;
  ariaLabel: string;
}

function BoardCard(p: BoardCardProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(); }
  };
  const onOverrideKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.overrideBadge!.onClick(); }
  };
  const hasMeta = p.metaLines.length > 0;
  const hasBadges = !!(p.dueBadge || p.stalledBadge || p.checklistBadge || p.attachmentsLabel);
  return (
    <div
      class={'board-card' + (p.manualOverride ? ' manual-override' : '')}
      draggable={p.draggable}
      data-id={p.id}
      style={{ borderLeftColor: p.borderLeftColor }}
      title={p.title}
      tabIndex={0}
      role="button"
      aria-label={p.ariaLabel}
      onClick={p.onOpen}
      onKeyDown={onKeyDown}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
    >
      {p.overrideBadge ? (
        <span
          class="board-card-override-badge"
          tabIndex={0}
          role="button"
          title={p.overrideBadge.title}
          onClick={(e: MouseEvent) => { e.stopPropagation(); p.overrideBadge!.onClick(); }}
          onKeyDown={onOverrideKeyDown}
        >
          <Icon svg={OVERRIDE_ICON} /> Manual <span style={{ textDecoration: 'underline', marginLeft: '2px' }}>Reconnect</span>
        </span>
      ) : null}
      <div class="board-card-title">{p.cardTitle}</div>
      {hasMeta ? (
        <div class="board-card-meta">
          {p.metaLines.map((m, i) => <div key={i} class="board-card-meta-line">{m.label}: {m.value}</div>)}
        </div>
      ) : null}
      {hasBadges ? (
        <div class="board-card-badges">
          {p.dueBadge ? (
            <span class={'board-card-due' + (p.dueBadge.overdue ? ' overdue' : '')}><Icon svg={DUE_ICON} /> {p.dueBadge.label}</span>
          ) : null}
          {p.stalledBadge ? (
            <span class="board-card-due overdue" title={p.stalledBadge.title}><Icon svg={STALLED_ICON} /> {p.stalledBadge.label}</span>
          ) : null}
          {p.checklistBadge ? (
            <span class={'mini-badge' + (p.checklistBadge.complete ? ' checklist-complete' : '')}><Icon svg={CHECKLIST_ICON} /> {p.checklistBadge.label}</span>
          ) : null}
          {p.attachmentsLabel ? (
            <span class="mini-badge"><Icon svg={ATTACHMENT_ICON} /> {p.attachmentsLabel}</span>
          ) : null}
        </div>
      ) : null}
      {/* Mobile-only "Move to" fallback — hidden above 480px (see the
          .board-card-move-select rules), where dragging still works. */}
      <select
        class="board-card-move-select"
        title="Move to a different board"
        value={p.moveSelectValue}
        onClick={(e: MouseEvent) => e.stopPropagation()}
        onChange={(e: Event) => p.onMoveChange((e.currentTarget as HTMLSelectElement).value)}
      >
        {p.moveSelectOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

function BoardCardList({ cards }: { cards: BoardCardProps[] }) {
  return <>{cards.map((c) => <BoardCard key={c.id} {...c} />)}</>;
}

export function renderBoardCardsInto(container: HTMLElement, cards: BoardCardProps[]): void {
  render(<BoardCardList cards={cards} />, container);
}
