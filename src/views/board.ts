// Board, moved out of index.html across Phase 4 of the architecture
// roadmap in deliberately narrow, separately-verified slices rather than
// one giant move — renderBoard() itself, buildCardEl(), the card modal,
// checklists, and workflow items are all still in index.html, left for
// later follow-up phases once each has its own test coverage the way the
// pieces below did before being moved:
//   Phase 4a — drag-and-drop (this file's original content): covered by
//     the existing board drag-and-drop test plus the isBusyEditing()
//     regression test, which reads draggedCardId/draggedColId directly.
//   Phase 4b — column CRUD + card visibility (addBoardColumn/
//     deleteBoardColumn/renameBoardColumn/isCardFromArchivedJob/
//     isCardVisibleToMe): new dedicated tests added alongside this move
//     (tests/teamsync.spec.js).
//   Phase 4c — workflow items (openWorkflowItemsModal and friends): same
//     pattern, new dedicated tests alongside this move.
//
// Several functions this file calls but does NOT define — setCardColumn(),
// confirmChecklistBeforeMove(), slugifyColumnId(), isJobVisibleToMe(),
// renderGantt(), renderJobList(), openModal()/closeModal(),
// saveWorkflowItems() — stay in index.html on purpose (checklist business
// rules, modal-chrome plumbing shared by every modal in the app, or
// genuinely separate concerns like the Gantt/Job List re-renders a rename
// triggers). Referenced below as ambient globals: an ordinary top-level
// `function` declaration already attaches to `window` on its own (unlike
// `let`/`const`), so none of those needed any change to stay visible here
// — only genuinely mutated DATA globals do.
import type { BoardCard, BoardColumn, WorkflowItem, Job } from '../core/types';
import { findJob } from '../core/models';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';

declare global {
  // eslint-disable-next-line no-var
  var BOARD_COLUMNS: BoardColumn[];
  // eslint-disable-next-line no-var
  var boardCards: BoardCard[];
  // eslint-disable-next-line no-var
  var draggedCardId: string | null;
  // eslint-disable-next-line no-var
  var draggedColId: string | null;
  // eslint-disable-next-line no-var
  var homeExpandedWidgetId: string | null;
  // eslint-disable-next-line no-var
  var WORKFLOW_ITEMS: WorkflowItem[];
  // eslint-disable-next-line no-var
  var COLOR_PRESETS: string[];
  function setCardColumn(card: BoardCard, newColumnId: string): void;
  function confirmChecklistBeforeMove(card: BoardCard): boolean;
  function saveBoardColumns(): void;
  function saveBoardCards(): void;
  function saveWorkflowItems(): void;
  function logActivity(text: string): void;
  function showToast(text: string, kind?: string): void;
  function renderBoard(): void;
  function renderGantt(): void;
  function renderJobList(): void;
  function renderHomeWorkflowExpandedBoard(): void;
  function slugifyColumnId(label: string): string;
  function isJobVisibleToMe(job: Job): boolean;
  function openModal(id: string): void;
  function closeModal(id: string): void;
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

// ===== BOARD: COLUMN CRUD =====

function addBoardColumn(label: string): void {
  BOARD_COLUMNS.push({ id: slugifyColumnId(label), label: label });
  saveBoardColumns();
  logActivity('added board "' + label + '"');
  renderBoard();
  showToast('Board "' + label + '" added', 'success');
  setTimeout(() => {
    const wrapper = document.getElementById('boardWrapper')!;
    wrapper.scrollLeft = wrapper.scrollWidth;
  }, 60);
}

function deleteBoardColumn(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  if (BOARD_COLUMNS.length <= 1) {
    showToast('You need at least one board', 'error');
    return;
  }
  // 'complete'/'invoiced' stay non-deletable on purpose, independent of
  // isFinishedColumn()/the Finished Trigger toggle above: they're every
  // project's starter "done" boards, and deleting one out from under a
  // team mid-use (even with cards moved elsewhere) is more likely an
  // accident than an intent a confirm dialog alone should be trusted to
  // catch. A team that wants a different column as the/an ADDITIONAL
  // finished trigger can just toggle that on directly — deleting these
  // two isn't the way to do that.
  if (colId === 'complete' || colId === 'invoiced') {
    showToast('The Complete and Invoiced boards can\'t be deleted', 'error');
    return;
  }
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  const remaining = BOARD_COLUMNS.filter((c) => c.id !== colId);
  const cardCount = boardCards.filter((c) => c.column === colId).length;
  let msg = 'Delete the "' + col.label + '" board?';
  if (cardCount > 0) {
    msg += ' ' + cardCount + ' card' + (cardCount === 1 ? '' : 's') + ' will be moved to "' + remaining[0].label + '".';
  }
  if (!confirm(msg)) return;
  if (cardCount > 0) {
    boardCards.forEach((c) => { if (c.column === colId) setCardColumn(c, remaining[0].id); });
    saveBoardCards();
  }
  BOARD_COLUMNS = remaining;
  saveBoardColumns();
  logActivity('deleted board "' + col.label + '"');
  renderBoard();
  showToast('Board deleted', 'info');
}

function renameBoardColumn(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  const name = prompt('Rename board:', col.label);
  if (!name || !name.trim()) return;
  col.label = name.trim();
  saveBoardColumns();
  logActivity('renamed board to "' + col.label + '"');
  renderBoard();
  renderGantt();
  renderJobList();
  showToast('Board renamed', 'success');
}

// A job's card follows it into the archive — same as it's already hidden
// from the Gantt/Calendar/Job Manager once archived, it shouldn't keep
// occupying a spot on the board. Restoring the job brings it back.
function isCardFromArchivedJob(card: BoardCard): boolean {
  if (!card.jobId) return false;
  const found = findJob(card.jobId);
  return !!(found && found.job.archived);
}

// See isJobVisibleToMe() — same job-membership filter, resolved from a
// board card back to its owning job. A card with no jobId, or one that
// doesn't resolve to a real job, fails OPEN (stays visible) rather than
// silently vanishing from the board — same reasoning as
// isCardFromArchivedJob()'s own early return for that case.
function isCardVisibleToMe(card: BoardCard): boolean {
  if (!card.jobId) return true;
  const found = findJob(card.jobId);
  if (!found) return true;
  return isJobVisibleToMe(found.job);
}

// ===== WORKFLOW ITEMS =====
// Named groups a board can be assigned to (col.workflowItemId), shown as
// a strip above Board — independent of any column's own label, so the
// same item can span several adjacently-ordered boards. Managed from
// this modal rather than per-column like most other board settings, but
// still stored per-project (same as BOARD_COLUMNS).

function openWorkflowItemsModal(): void {
  renderWorkflowItemsBody();
  openModal('workflowItemsModal');
}

function closeWorkflowItemsModal(): void {
  closeModal('workflowItemsModal');
}

function renderWorkflowItemsBody(): void {
  const container = document.getElementById('workflowItemsBody')!;
  // Row layout (not the chip pattern Default Checklist/Custom Fields use
  // elsewhere) since each item needs room for an expandable color picker
  // underneath — reuses the board column ⋮ menu's own color-toggle/
  // panel/grid CSS classes verbatim (same swatch palette, COLOR_PRESETS,
  // same click-to-expand interaction), just scoped to #workflowItemsBody
  // instead of a column dropdown.
  const rows = WORKFLOW_ITEMS.map((item) => {
    const swatches = COLOR_PRESETS.map((c) => {
      return '<div class="board-col-color-option' + (item.color === c ? ' selected' : '') + '" style="background:' + c + ';" role="radio" aria-checked="' + (item.color === c) + '" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="changeWorkflowItemColor(\'' + item.id + '\', \'' + c + '\', event)"></div>';
    }).join('');
    return '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:6px;overflow:hidden;">' +
      '<div class="board-col-color-toggle" onclick="toggleWorkflowItemColorPanel(\'' + item.id + '\', event)">' +
        '<span style="display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          '<span class="col-color-swatch" id="wfi-swatch-' + item.id + '" style="background:' + item.color + ';flex-shrink:0;"></span>' +
          escapeHtml(item.label) +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' +
          '<span class="col-color-arrow" id="wfi-arrow-' + item.id + '">▾</span>' +
          '<button onclick="event.stopPropagation(); removeWorkflowItem(\'' + item.id + '\');" style="border:none;background:none;color:var(--text-light);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;">×</button>' +
        '</span>' +
      '</div>' +
      '<div class="board-col-color-panel" id="wfi-panel-' + item.id + '">' +
        '<div class="board-col-color-grid" role="radiogroup" aria-label="' + escapeHtml(item.label) + ' color">' + swatches + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  container.innerHTML = '<div class="manage-field-group">' +
    (rows || '<span style="font-size:11px;color:#999;">No workflow items yet</span>') +
    '<div class="manage-field-add-row">' +
    '<input type="text" id="wfi_new_item" placeholder="Add workflow item..." onkeydown="if(event.key===\'Enter\'){event.preventDefault();addWorkflowItem();}">' +
    '<button class="btn btn-secondary" onclick="addWorkflowItem()">Add</button>' +
    '</div></div>';
}

// Mirrors toggleColColorPanel() (board column ⋮ menu) exactly, scoped to
// this modal instead of a column dropdown so opening one item's picker
// closes any other item's still-open one, not a board's.
function toggleWorkflowItemColorPanel(itemId: string, event: Event): void {
  event.stopPropagation();
  const panel = document.getElementById('wfi-panel-' + itemId)!;
  const toggle = event.currentTarget as HTMLElement;
  const open = !panel.classList.contains('open');
  document.querySelectorAll('#workflowItemsBody .board-col-color-panel').forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('#workflowItemsBody .board-col-color-toggle').forEach((t) => t.classList.remove('open'));
  if (open) {
    panel.classList.add('open');
    toggle.classList.add('open');
  }
}

function changeWorkflowItemColor(itemId: string, color: string, event: Event): void {
  event.stopPropagation();
  const item = WORKFLOW_ITEMS.find((i) => i.id === itemId);
  if (!item) return;
  item.color = color;
  saveWorkflowItems();
  logActivity('changed workflow item "' + item.label + '" color');
  renderWorkflowItemsBody();
  renderBoard();
  showToast('Color updated', 'success');
}

function addWorkflowItem(): void {
  const input = document.getElementById('wfi_new_item') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  // Cycles through the same swatch palette job/board colors already draw
  // from, rather than a separate color picker — one less decision for
  // something that'll usually be picked a handful of times total.
  const color = COLOR_PRESETS[WORKFLOW_ITEMS.length % COLOR_PRESETS.length];
  WORKFLOW_ITEMS.push({ id: genId(), label: text, color: color });
  input.value = '';
  saveWorkflowItems();
  renderWorkflowItemsBody();
  renderBoard();
}

function removeWorkflowItem(itemId: string): void {
  WORKFLOW_ITEMS = WORKFLOW_ITEMS.filter((i) => i.id !== itemId);
  // Boards that were grouped under the deleted item fall back to showing
  // their own name again — same as any board that was never assigned one.
  BOARD_COLUMNS.forEach((col) => { if (col.workflowItemId === itemId) col.workflowItemId = null; });
  saveWorkflowItems();
  saveBoardColumns();
  renderWorkflowItemsBody();
  renderBoard();
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
  addBoardColumn,
  deleteBoardColumn,
  renameBoardColumn,
  isCardFromArchivedJob,
  isCardVisibleToMe,
  openWorkflowItemsModal,
  closeWorkflowItemsModal,
  renderWorkflowItemsBody,
  toggleWorkflowItemColorPanel,
  changeWorkflowItemColor,
  addWorkflowItem,
  removeWorkflowItem,
};
