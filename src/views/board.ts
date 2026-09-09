// Phase 4 of the architecture roadmap — Board's drag-and-drop mechanics,
// moved verbatim. Deliberately narrower than "extract Board": this file
// covers ONLY the two drag-and-drop subsystems (reordering columns,
// moving cards between/within columns) — renderBoard() itself, the card
// modal, checklists, and workflow items all stay in index.html for later,
// separately-scoped follow-up phases. Every function here is already
// covered by real test coverage (tests/teamsync.spec.js's board
// drag-and-drop test, plus the isBusyEditing() regression test that
// depends on draggedCardId/draggedColId), which is exactly the kind of
// evidence that made Board a safer next move than, say, Gantt's more
// timing-sensitive drag code — see the roadmap's own stated ordering.
//
// Two functions this file calls but does NOT define — setCardColumn()
// and confirmChecklistBeforeMove() — stay in index.html on purpose: both
// carry business rules (checklist-completion auto-assignment, the
// "unfinished checklist" confirm gate) that belong with the rest of the
// checklist system, not with drag mechanics. They're referenced below as
// ambient globals, same as every other still-in-index.html function this
// file calls (logActivity, showToast, saveBoardCards, saveBoardColumns,
// renderBoard, renderHomeWorkflowExpandedBoard) — ordinary top-level
// `function` declarations already attach to `window` on their own
// (unlike `let`/`const`), so none of those needed any change to stay
// visible here.
import type { BoardCard, BoardColumn } from '../core/types';

declare global {
  // eslint-disable-next-line no-var
  var BOARD_COLUMNS: BoardColumn[];
  // eslint-disable-next-line no-var
  var draggedCardId: string | null;
  // eslint-disable-next-line no-var
  var draggedColId: string | null;
  // eslint-disable-next-line no-var
  var homeExpandedWidgetId: string | null;
  function setCardColumn(card: BoardCard, newColumnId: string): void;
  function confirmChecklistBeforeMove(card: BoardCard): boolean;
  function saveBoardColumns(): void;
  function saveBoardCards(): void;
  function logActivity(text: string): void;
  function showToast(text: string, kind?: string): void;
  function renderBoard(): void;
  function renderHomeWorkflowExpandedBoard(): void;
}

// ===== BOARD: COLUMN DRAG & DROP =====

function handleColumnDragStart(e: DragEvent): void {
  const target = e.target as HTMLElement;
  // Don't drag if clicking the delete button
  if (target.closest('.board-col-settings-btn') || target.closest('.board-col-settings-dropdown')) {
    e.preventDefault();
    return;
  }
  const header = target.closest('.board-column-header') as HTMLElement | null;
  if (!header) {
    e.preventDefault();
    return;
  }
  const colEl = header.closest('.board-column') as HTMLElement;
  draggedColId = colEl.dataset.column || null;
  e.dataTransfer!.setData('text/col-id', draggedColId || '');
  e.dataTransfer!.effectAllowed = 'move';

  // Use the whole column as the drag ghost image
  const rect = colEl.getBoundingClientRect();
  const clone = colEl.cloneNode(true) as HTMLElement;
  clone.style.position = 'fixed';
  clone.style.top = '-9999px';
  clone.style.left = '-9999px';
  clone.style.width = rect.width + 'px';
  clone.style.opacity = '1';
  clone.classList.remove('dragging-col');
  document.body.appendChild(clone);
  e.dataTransfer!.setDragImage(clone, e.clientX - rect.left, e.clientY - rect.top);
  setTimeout(() => clone.remove(), 0);

  setTimeout(() => colEl.classList.add('dragging-col'), 0);
}

function handleColumnDragEnd(e: DragEvent): void {
  const target = e.target as HTMLElement;
  const header = target.closest('.board-column-header');
  if (header) {
    const colEl = header.closest('.board-column');
    if (colEl) colEl.classList.remove('dragging-col');
  }
  document.querySelectorAll('.board-column').forEach((c) => c.classList.remove('drag-over-col'));
  draggedColId = null;
}

function handleColumnReorderOver(e: DragEvent): void {
  e.preventDefault();
  if (!draggedColId) return;
  const colEl = (e.currentTarget as HTMLElement).closest('.board-column') as HTMLElement | null;
  if (!colEl || colEl.dataset.column === draggedColId) return;
  colEl.classList.add('drag-over-col');
  e.dataTransfer!.dropEffect = 'move';

  const wrapper = document.getElementById('boardWrapper')!;
  const afterCol = getDragAfterColumn(wrapper, e.clientX);
  const draggedEl = document.querySelector('.board-column[data-column="' + draggedColId + '"]');
  if (!draggedEl) return;
  if (afterCol == null) {
    wrapper.insertBefore(draggedEl, document.getElementById('addColumnContainer'));
  } else {
    wrapper.insertBefore(draggedEl, afterCol);
  }
}

function handleColumnReorderLeave(e: DragEvent): void {
  const currentTarget = e.currentTarget as HTMLElement;
  if (currentTarget === e.target || currentTarget.contains(e.relatedTarget as Node)) {
    currentTarget.classList.remove('drag-over-col');
  }
}

function handleColumnReorderDrop(e: DragEvent): void {
  e.preventDefault();
  document.querySelectorAll('.board-column').forEach((c) => c.classList.remove('drag-over-col'));
  syncColumnsFromDOM();
}

function getDragAfterColumn(container: HTMLElement, x: number): Element | null {
  const cols = [...container.querySelectorAll('.board-column:not(.dragging-col)')];
  return cols.reduce(
    (closest: { offset: number; element: Element | null }, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function syncColumnsFromDOM(): void {
  const wrapper = document.getElementById('boardWrapper')!;
  const orderedIds = [...wrapper.querySelectorAll('.board-column')].map((el) => (el as HTMLElement).dataset.column);
  const newColumns: BoardColumn[] = [];
  orderedIds.forEach((id) => {
    const col = BOARD_COLUMNS.find((c) => c.id === id);
    if (col) newColumns.push(col);
  });
  // Append any missing columns (shouldn't happen, but safety)
  BOARD_COLUMNS.forEach((c) => { if (!orderedIds.includes(c.id)) newColumns.push(c); });
  BOARD_COLUMNS = newColumns;
  saveBoardColumns();
  logActivity('reordered boards');
  renderBoard();
  showToast('Board reordered', 'success');
}

// ===== BOARD: DRAG & DROP =====

function handleCardDragStart(e: DragEvent): void {
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement;
  draggedCardId = target.dataset.id || null;
  e.dataTransfer!.setData('text/plain', target.dataset.id || '');
  e.dataTransfer!.effectAllowed = 'move';
  target.classList.add('dragging');
}

function handleCardDragEnd(e: DragEvent): void {
  e.stopPropagation();
  draggedCardId = null;
  (e.currentTarget as HTMLElement).classList.remove('dragging');
  document.querySelectorAll('.board-column-body').forEach((b) => b.classList.remove('drag-over'));
  document.querySelectorAll('.board-column').forEach((c) => c.classList.remove('card-drag-over'));
}

// The reposition-while-dragging work below (getDragAfterElement's
// getBoundingClientRect() over every card in the column, then an
// insertBefore/appendChild) is rAF-coalesced -- native dragover can fire
// far more often than this can usefully repaint, same reason every other
// drag handler in this file is throttled this way. Not cached across
// ticks (unlike the Gantt/Calendar bar-drag fixes) since the cards this
// reads the position of are the SAME ones insertBefore/appendChild just
// reordered — recomputing fresh each rAF tick (instead of on every raw
// event) is what makes this safe: never stale, just not redone dozens of
// times a second for no visual benefit.
//
// Private to this module (unlike BOARD_COLUMNS/draggedCardId/etc. above)
// — nothing outside this exact drag-over pipeline ever reads these, so
// there's no need to expose them as `window` globals the way the
// cross-file state above needs to be.
let dragOverRafPending = false;
let dragOverLatestEvent: { body: HTMLElement; clientY: number } | null = null;

function handleColumnDragOver(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = 'move';
  const body = e.currentTarget as HTMLElement;
  body.classList.add('drag-over');
  const col = body.closest('.board-column');
  if (col) col.classList.add('card-drag-over');

  dragOverLatestEvent = { body: body, clientY: e.clientY };
  if (dragOverRafPending) return;
  dragOverRafPending = true;
  requestAnimationFrame(function () {
    dragOverRafPending = false;
    if (dragOverLatestEvent) applyColumnDragOver(dragOverLatestEvent.body, dragOverLatestEvent.clientY);
  });
}

function applyColumnDragOver(body: HTMLElement, clientY: number): void {
  const dragging = document.querySelector('.board-card.dragging');
  if (!dragging) return;
  // Only move if not already in this body
  if (dragging.parentElement === body) {
    const afterEl = getDragAfterElement(body, clientY);
    if (afterEl == null) {
      if (body.lastElementChild !== dragging) body.appendChild(dragging);
    } else {
      if (afterEl !== dragging) body.insertBefore(dragging, afterEl);
    }
  } else {
    const afterEl = getDragAfterElement(body, clientY);
    if (afterEl == null) body.appendChild(dragging);
    else body.insertBefore(dragging, afterEl);
  }
}

function handleColumnDragLeave(e: DragEvent): void {
  const currentTarget = e.currentTarget as HTMLElement;
  if (currentTarget === e.target) {
    currentTarget.classList.remove('drag-over');
    const col = currentTarget.closest('.board-column');
    if (col) col.classList.remove('card-drag-over');
  }
}

// A drop into a hideFromSchedule board (Bid/Invoiced-style — no
// meaningful dates of its own) doesn't need a temporary 24h override:
// deriveColumnForTasks() already treats sitting in a hideFromSchedule
// board as a freely-chosen, indefinite holding spot on its own (until
// today reaches an actually-scheduled task's date range). Setting one
// anyway would just show a misleading "resumes in 24h" badge for a
// placement that isn't actually time-limited.
function dropNeedsManualOverride(targetColumnId: string): boolean {
  const targetCol = BOARD_COLUMNS.find((c) => c.id === targetColumnId);
  return !(targetCol && targetCol.hideFromSchedule);
}

function handleColumnDrop(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  // Flush any dragover reposition still waiting on its rAF (see
  // handleColumnDragOver()) before syncBoardCardsFromDOM() below reads
  // the DOM's card order -- drop fires as its own event, so without this
  // the last dragover's reorder could still be pending when we read the
  // order, and applying it a moment later (between drop and dragend,
  // when dragend is what actually clears .dragging) would silently
  // reorder the DOM again after boardCards had already been captured.
  if (dragOverLatestEvent) {
    applyColumnDragOver(dragOverLatestEvent.body, dragOverLatestEvent.clientY);
    dragOverLatestEvent = null;
  }
  const body = e.currentTarget as HTMLElement;
  body.classList.remove('drag-over');
  const colEl = body.closest('.board-column');
  if (colEl) colEl.classList.remove('card-drag-over');

  const targetColumnId = body.id.indexOf('col-body-') === 0 ? body.id.slice('col-body-'.length) : null;
  const cardId = draggedCardId;
  draggedCardId = null;
  if (!cardId || !targetColumnId) return;

  const card = boardCards.find((c) => String(c.id) === String(cardId));
  if (!card) return;
  if (!confirmChecklistBeforeMove(card)) return;

  setCardColumn(card, targetColumnId);
  if (card.jobId) {
    // Job-linked cards are normally auto-positioned by date; a manual
    // drop overrides that for 24 hours, or until the job's dates are
    // re-saved (see autoSaveJobForm()), whichever comes first — unless
    // the target is a hideFromSchedule board, which doesn't need one.
    if (dropNeedsManualOverride(targetColumnId)) {
      card.manualColumn = targetColumnId;
      card.manualColumnUntil = Date.now() + 24 * 60 * 60 * 1000;
    } else {
      card.manualColumn = null;
      card.manualColumnUntil = null;
    }
    const targetCol = BOARD_COLUMNS.find((c) => c.id === targetColumnId);
    logActivity('manually moved "' + card.title + '" to "' + (targetCol ? targetCol.label : targetColumnId) + '"');
  }

  syncBoardCardsFromDOM();
  saveBoardCards();
  requestAnimationFrame(() => renderBoard());
}

// Touch-friendly equivalent of dropping a card into a different column via
// handleColumnDrop() above — same logic (manual-override on job-linked
// cards, activity log, save+re-render), just triggered from the mobile
// <select> in buildCardEl() instead of a native HTML5 drag, which doesn't
// fire on touchscreens.
function moveCardToColumn(cardId: string, targetColumnId: string): void {
  const card = boardCards.find((c) => String(c.id) === String(cardId));
  if (!card || card.column === targetColumnId) return;
  if (!confirmChecklistBeforeMove(card)) return;
  const targetCol = BOARD_COLUMNS.find((c) => c.id === targetColumnId);
  setCardColumn(card, targetColumnId);
  if (card.jobId) {
    if (dropNeedsManualOverride(targetColumnId)) {
      card.manualColumn = targetColumnId;
      card.manualColumnUntil = Date.now() + 24 * 60 * 60 * 1000;
    } else {
      card.manualColumn = null;
      card.manualColumnUntil = null;
    }
    logActivity('manually moved "' + card.title + '" to "' + (targetCol ? targetCol.label : targetColumnId) + '"');
  }
  saveBoardCards();
  renderBoard();
  if (homeExpandedWidgetId === 'board') renderHomeWorkflowExpandedBoard();
  showToast('Moved to "' + (targetCol ? targetCol.label : targetColumnId) + '"', 'success');
}

function getDragAfterElement(container: HTMLElement, y: number): Element | null {
  const els = [...container.querySelectorAll('.board-card:not(.dragging)')];
  return els.reduce(
    (closest: { offset: number; element: Element | null }, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function syncBoardCardsFromDOM(): void {
  const ordered: BoardCard[] = [];
  BOARD_COLUMNS.forEach((col) => {
    const body = document.getElementById('col-body-' + col.id);
    if (!body) return;
    body.querySelectorAll('.board-card').forEach((el) => {
      const card = boardCards.find((c) => String(c.id) === (el as HTMLElement).dataset.id);
      if (card) { setCardColumn(card, col.id); ordered.push(card); }
    });
  });
  boardCards = ordered;
}

export {
  handleColumnDragStart,
  handleColumnDragEnd,
  handleColumnReorderOver,
  handleColumnReorderLeave,
  handleColumnReorderDrop,
  getDragAfterColumn,
  syncColumnsFromDOM,
  handleCardDragStart,
  handleCardDragEnd,
  handleColumnDragOver,
  applyColumnDragOver,
  handleColumnDragLeave,
  dropNeedsManualOverride,
  handleColumnDrop,
  moveCardToColumn,
  getDragAfterElement,
  syncBoardCardsFromDOM,
};
