import { render } from 'preact';

// Home dashboard's expanded-in-place Workflow board (#homeBoardExpanded,
// see toggleHomeWidgetExpand()) — its own separate implementation, not a
// reuse of the real Board tab's Preact card component (board-card.tsx).
// An explicit choice Karl made when this came up (same fork as Calendar's
// own duplicate mini-widget, see home-calendar.tsx's own header comment).
//
// Only the column CHROME (header, count, background color) is Preact-
// rendered here. The cards themselves stay imperative, built by board.ts's
// old buildCardEl() (kept around specifically for this reuse — see its
// own comment) — unlike Calendar's bars, which used onclick="..." STRING
// attributes a dangerouslySetInnerHTML rebuild could carry over intact,
// buildCardEl() wires its click/dragstart/dragend/keydown handlers via
// real addEventListener calls straight onto the DOM node it builds and
// returns. Re-serializing that node's outerHTML (the same trick Overdue's
// bars use) would silently drop every one of those listeners — HTML
// serialization has no way to carry a live listener along with it. So
// each column's `.home-board-cards` div is declared here as permanently
// EMPTY (never any Preact-declared children) and filled in imperatively
// by home.ts's own renderHomeWorkflowExpandedBoard() right after this
// renders — same "Preact owns the stable container, something else owns
// what's inside it" shape as Gantt's connector-line SVG.
//
// Still a real improvement over the old fully-imperative version: since
// Preact reuses the SAME column/cards-wrap DOM nodes across renders
// (matching key/type, not a full `container.innerHTML = ''` teardown),
// `.home-board-cards`' own scroll position (it's independently
// scrollable) survives an unrelated dashboard re-render instead of
// resetting to the top every time, even though the cards inside it still
// get rebuilt fresh each time.

export interface HomeBoardColumnProps {
  colId: string;
  label: string;
  count: number;
  colStyle?: Record<string, string>;
  headStyle?: Record<string, string>;
}

function BoardColumn(p: HomeBoardColumnProps) {
  return (
    <div class="home-board-col" style={p.colStyle}>
      <div class="home-board-col-head" style={p.headStyle}>
        <span>{p.label}</span>
        <span class="home-board-col-count">{p.count}</span>
      </div>
      <div class="home-board-cards" data-column={p.colId} />
    </div>
  );
}

function BoardColumnsList({ columns }: { columns: HomeBoardColumnProps[] }) {
  return <>{columns.map((c) => <BoardColumn key={c.colId} {...c} />)}</>;
}

export function renderHomeBoardColumnsInto(container: HTMLElement, columns: HomeBoardColumnProps[]): void {
  render(<BoardColumnsList columns={columns} />, container);
}
