// Board, moved out of index.html across Phase 4 of the architecture
// roadmap in deliberately narrow, separately-verified slices rather than
// one giant move:
//   Phase 4a — drag-and-drop (this file's original content): covered by
//     the existing board drag-and-drop test plus the isBusyEditing()
//     regression test, which reads draggedCardId/draggedColId directly.
//   Phase 4b — column CRUD + card visibility (addBoardColumn/
//     deleteBoardColumn/renameBoardColumn/isCardFromArchivedJob/
//     isCardVisibleToMe): new dedicated tests added alongside this move
//     (tests/teamsync.spec.js).
//   Phase 4c — workflow items (openWorkflowItemsModal and friends): same
//     pattern, new dedicated tests alongside this move.
//   Phase 4d — the card detail modal + its autosave (openEditCard and
//     friends): same pattern, new dedicated tests alongside this move.
//   Phase 4e — renderBoard()/buildCardEl() themselves, the last real
//     piece of Board: same pattern. The checklist system (ensureCard-
//     Checklists/isChecklistStageVisibleToMe/getChecklistForStageInProject/
//     toggleMyChecklistItemRequired and the whole "My Checklist" tab) was
//     deliberately NOT part of "Board" — it's cross-cutting (also used
//     by Job Manager and its own dedicated tab) — see src/views/
//     checklist.ts's own header for its separate, later phasing.
//     ensureCardChecklists()/isChecklistStageVisibleToMe()/
//     confirmChecklistBeforeMove() are all real imports from there now
//     (checklist.ts's Phases CL-a/CL-b).
//   Phase CL-c (this addition, part of the checklist-system extraction's
//     folded-in side-finding, not the checklist system itself) — the
//     "column settings dropdown" (⋮ menu): isDarkColor/toggleColSettings/
//     toggleColColorPanel/changeColumnColor/closeAllColSettings/
//     toggleColumnScheduleVisibility/toggleColumnScheduleSync/
//     toggleColumnFinishedTrigger/setColumnWorkflowItem/
//     toggleColumnAutoAssignChecklist/setColumnChecklistAssignee/
//     setColumnDefaultDuration/setColumnStalledThreshold/reconnectCard.
//     This was simply never done back in Phase 4 — discovered while
//     surveying the checklist system (two of these are checklist toggles),
//     and Karl chose to fold the whole cluster in now rather than
//     context-switch back to a separate future Board pass. isDarkColor()
//     was ambiently duplicated here AND in calendar.ts before this; it's
//     a real function here now, calendar.ts still declares it ambiently.
//
// Several functions this file calls but does NOT define — setCardColumn(),
// slugifyColumnId(), isJobVisibleToMe(),
// renderGantt(), renderJobList(), renderCalendar(), openModal()/
// closeModal(), saveWorkflowItems(), hasMinTier(), renderCustomFieldsGrid(),
// renderTeamFieldsGrid(), renderAttachments(), collectCustomFieldValues(),
// deleteCardFromShared(), refreshJobFormIfOpen(), syncCardColumns(),
// isFinishedColumn(), isFinishedColumnId(), displayNameForUsername(),
// applyPermissionGating(), renderBoardWorkflowStrip(),
// ensureUserRosterLoaded(), saveJobs(), renderHomeDashboard(),
// ensureJobTasksMatchColumns(), renderFixedTaskGrid() — stay in
// index.html on purpose (checklist business rules, modal-chrome/
// permission/custom-field plumbing shared across many modals, or
// genuinely separate concerns like the Gantt/Calendar/Job List
// re-renders a rename triggers, or Home/schedule-derived column
// placement, or Job Manager's own fixed-task-grid rendering). Referenced
// below as ambient globals: an ordinary top-level `function` declaration
// already attaches to `window` on its own (unlike `let`/`const`), so none
// of those needed any change to stay visible here — only genuinely
// mutated DATA globals do.
import type { BoardCard, BoardColumn, WorkflowItem, Job, Task, Phase, CustomFieldDef } from '../core/types';
import { findJob } from '../core/models';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { createAutosaveController } from '../utils/autosave';
import { darkenColor } from '../utils/color';
import { ensureCardChecklists, isChecklistStageVisibleToMe, confirmChecklistBeforeMove } from './checklist';

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
  // eslint-disable-next-line no-var
  var editingCardId: string | null;
  // eslint-disable-next-line no-var
  var draftAttachments: unknown[];
  // eslint-disable-next-line no-var
  var activeProjectId: string | null;
  // eslint-disable-next-line no-var
  var cachedUserRoster: { username: string; displayName: string }[] | null;
  // eslint-disable-next-line no-var
  var BOARD_COLOR_PRESETS: string[];
  // eslint-disable-next-line no-var
  var DEFAULT_TASK_DURATION_DAYS: number;
  // eslint-disable-next-line no-var
  var DEFAULT_STALLED_AFTER_DAYS: number;
  // eslint-disable-next-line no-var
  var CUSTOM_FIELD_DEFS: CustomFieldDef[];
  // Shared verbatim with src/core/models.ts's/src/sync/inbound.ts's
  // identical ambient declarations for these same globals.
  // eslint-disable-next-line no-var
  var jobs: Job[];
  // eslint-disable-next-line no-var
  var editingJobId: string | null;
  function setCardColumn(card: BoardCard, newColumnId: string): void;
  // Shared verbatim with src/views/calendar.ts's/gantt.ts's identical
  // ambient declaration for this same function.
  function saveJobs(): void;
  // Shared verbatim with src/sync/inbound.ts's identical ambient
  // declaration for this same function.
  function renderHomeDashboard(): void;
  function ensureJobTasksMatchColumns(job: Job): void;
  function renderFixedTaskGrid(taskList: Task[]): void;
  function saveBoardColumns(): void;
  function saveBoardCards(): void;
  function saveWorkflowItems(): void;
  function logActivity(text: string): void;
  function showToast(text: string, kind?: string): void;
  function renderGantt(): void;
  function renderJobList(): void;
  function renderCalendar(): void;
  function renderHomeWorkflowExpandedBoard(): void;
  function slugifyColumnId(label: string): string;
  function isJobVisibleToMe(job: Job): boolean;
  function openModal(id: string): void;
  function closeModal(id: string, onClosed?: () => void): void;
  function hasMinTier(tier: string): boolean;
  function renderCustomFieldsGrid(customFields: Record<string, unknown>): void;
  function renderTeamFieldsGrid(customFields: Record<string, unknown>): void;
  function renderAttachments(): void;
  function collectCustomFieldValues(): Record<string, unknown>;
  function deleteCardFromShared(projectId: string | null, cardId: string): void;
  function refreshJobFormIfOpen(jobId: string): void;
  function syncCardColumns(): void;
  function isFinishedColumn(col: BoardColumn): boolean;
  function isFinishedColumnId(colId: string): boolean;
  function displayNameForUsername(username: string): string;
  function applyPermissionGating(): void;
  function renderBoardWorkflowStrip(): void;
  function ensureUserRosterLoaded(): Promise<void>;
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

// Shared by both color-swatch grids in this file (column colors and
// workflow-item colors) — real roving tabindex + arrow-key navigation,
// completing the ARIA radiogroup pattern the static `role="radio"`/
// `aria-checked` markup already started. Only the selected swatch is a
// tab stop (tabindex 0); arrow keys move focus (and the roving tab stop)
// among swatches WITHOUT selecting them — Enter/Space (already handled
// below, unchanged from before this fix) is what actually commits a
// choice. This deliberately does NOT match strict native <input
// type="radio"> semantics (where arrow keys select immediately): both
// changeColumnColor() and changeWorkflowItemColor() close the whole
// settings panel as their last step, so auto-selecting on every single
// arrow press would close the picker after the first key press, making
// it impossible to arrow through more than one swatch.
function swatchKeyboardAttrs(selected: boolean): string {
  return ' tabindex="' + (selected ? '0' : '-1') + '" onkeydown="handleColorSwatchKeydown(event)"';
}

function handleColorSwatchKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    target.click();
    return;
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(event.key) === -1) return;
  event.preventDefault();
  const grid = target.closest('.board-col-color-grid') as HTMLElement | null;
  if (!grid) return;
  const swatches = Array.from(grid.querySelectorAll('.board-col-color-option')) as HTMLElement[];
  const currentIndex = swatches.indexOf(target);
  if (currentIndex === -1) return;
  // A real CSS grid (grid-template-columns: repeat(7, 1fr)) resolves to
  // N space-separated tracks in the computed style — reads the actual
  // column count rather than hardcoding it, so this stays correct if
  // the CSS ever changes.
  const columnCount = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowLeft') nextIndex = currentIndex - 1;
  else if (event.key === 'ArrowRight') nextIndex = currentIndex + 1;
  else if (event.key === 'ArrowUp') nextIndex = currentIndex - columnCount;
  else if (event.key === 'ArrowDown') nextIndex = currentIndex + columnCount;
  if (nextIndex < 0 || nextIndex >= swatches.length) return;

  swatches[currentIndex].setAttribute('tabindex', '-1');
  swatches[nextIndex].setAttribute('tabindex', '0');
  swatches[nextIndex].focus();
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
      return '<div class="board-col-color-option' + (item.color === c ? ' selected' : '') + '" style="background:' + c + ';" role="radio" aria-checked="' + (item.color === c) + '"' + swatchKeyboardAttrs(item.color === c) + ' onclick="changeWorkflowItemColor(\'' + item.id + '\', \'' + c + '\', event)"></div>';
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
        '<div class="board-col-color-grid" id="wfi-colorgrid-' + item.id + '" role="radiogroup" aria-label="' + escapeHtml(item.label) + ' color">' + swatches + '</div>' +
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

// ===== CARD MODAL =====

// A card's title doesn't own its own value — if it's linked to a job or
// phase, the title IS that job/phase's real name, and editing it here
// renames the job/phase directly rather than storing a separate copy
// that could drift out of sync.
function resolveCardNameTarget(card: BoardCard): { type: 'card' } | { type: 'job'; job: Job } | { type: 'phase'; job: Job; phase: Phase } {
  const job = card.jobId ? jobs.find((j) => j.id === card.jobId) : null;
  if (!job) return { type: 'card' };
  if (job.phases && job.phases.length) {
    const phase = job.phases.find((p) => p.id === (card.phaseId || null));
    if (phase) return { type: 'phase', job: job, phase: phase };
  }
  return { type: 'job', job: job };
}

function openEditCard(id: string): void {
  // Flush whatever card this modal was previously open on (defensive —
  // normally you close before opening another).
  if (editingCardId != null && editingCardId !== id) flushCardAutosave();
  const card = boardCards.find((c) => String(c.id) === String(id));
  if (!card) return;
  // Defense-in-depth matching renderBoard()'s own isCardVisibleToMe()
  // filter — this function resolves a card straight by id with no job
  // lookup otherwise, so a stale reference or direct call would bypass
  // the board's render-time hide entirely without this.
  if (!isCardVisibleToMe(card)) return;
  editingCardId = card.id;
  setCardTitleHint(false);
  draftAttachments = JSON.parse(JSON.stringify(card.attachments || []));
  document.getElementById('cardModalTitle')!.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" fill="#f0ad4e"/><path d="M15.5 5L19 8.5" stroke="#fff" stroke-width="1"/></svg> Edit Card';
  (document.getElementById('cardDeleteBtn') as HTMLElement).style.display = 'inline-flex';
  const nameTarget = resolveCardNameTarget(card);
  const titleLabel = document.getElementById('c_title_label')!;
  if (nameTarget.type === 'phase') {
    titleLabel.textContent = 'Phase Name *';
    (document.getElementById('c_title') as HTMLInputElement).value = nameTarget.phase.name;
  } else if (nameTarget.type === 'job') {
    titleLabel.textContent = 'Job Name *';
    (document.getElementById('c_title') as HTMLInputElement).value = nameTarget.job.name;
  } else {
    titleLabel.textContent = 'Title *';
    (document.getElementById('c_title') as HTMLInputElement).value = card.title || '';
  }
  (document.getElementById('c_due') as HTMLInputElement).value = card.due || '';
  renderCustomFieldsGrid(card.customFields || {});
  renderTeamFieldsGrid(card.customFields || {});
  renderAttachments();
  openModal('cardModal');
}

function closeCardModal(): void {
  // Flush while the modal is still marked open and editingCardId is still
  // valid — autoSaveCardForm() bails out once either isn't true.
  flushCardAutosave();
  closeModal('cardModal', function () {
    editingCardId = null;
    setCardTitleHint(false);
    draftAttachments = [];
  });
}

// ===== CARD MODAL AUTOSAVE =====
// Replaces the old explicit "Save Card" button. This modal only ever
// opens via openEditCard() now — the Board's old "+ Add a card"/"+ New
// Job" buttons are both gone, and jobs are only ever created from Job
// Manager's own "+ Add Job" — so there's no standalone-card-creation
// path left; editingCardId is always set while this is open.
const cardAutosave = createAutosaveController(function () { autoSaveCardForm(); }, 500);
function scheduleCardAutosave(): void { cardAutosave.schedule(); }
function flushCardAutosave(): void { cardAutosave.flush(); }
function cancelPendingCardAutosave(): void {
  cardAutosave.cancel();
}
function setCardTitleHint(show: boolean): void {
  const hint = document.getElementById('c_title_hint');
  if (hint) hint.style.display = show ? 'block' : 'none';
}

function autoSaveCardForm(): void {
  if (!document.getElementById('cardModal')!.classList.contains('show')) return;
  if (editingCardId == null) return;
  const idx = boardCards.findIndex((c) => c.id === editingCardId);
  if (idx < 0) return;

  const title = (document.getElementById('c_title') as HTMLInputElement).value.trim();
  setCardTitleHint(!title);

  const cardData: Partial<BoardCard> = {
    due: (document.getElementById('c_due') as HTMLInputElement).value,
    customFields: collectCustomFieldValues(),
    attachments: draftAttachments,
  };
  // The Title field doesn't own its own value — see resolveCardNameTarget()'s
  // own comment. Renaming here writes straight to the job/phase; the next
  // ensureJobHasCards() pass (inside saveBoardCards() below) re-derives
  // card.title from that, so cardData.title is only ever set in the
  // defensive no-job fallback where there's nothing else to rename.
  let renamedJobOrPhase = false;
  if (title) {
    const nameTarget = resolveCardNameTarget(boardCards[idx]);
    if (nameTarget.type === 'phase') {
      if (nameTarget.phase.name !== title) { nameTarget.phase.name = title; renamedJobOrPhase = true; }
    } else if (nameTarget.type === 'job') {
      if (nameTarget.job.name !== title) { nameTarget.job.name = title; renamedJobOrPhase = true; }
    } else {
      cardData.title = title; // never blank out an already-saved title
    }
  }

  boardCards[idx] = Object.assign({}, boardCards[idx], cardData);
  const savedCard = boardCards[idx];

  saveBoardCards();
  logActivity('updated card "' + savedCard.title + '"');
  renderBoard();
  // This card's job might already be open in Job Manager — without this its
  // description/due/custom fields/checklist/attachments would keep showing
  // whatever was there when that form was first opened.
  if (savedCard.jobId) refreshJobFormIfOpen(savedCard.jobId);
  // A job/phase rename shows up in more places than just the Board — same
  // refresh set autoSaveJobForm() runs after its own name edits.
  if (renamedJobOrPhase) { renderJobList(); renderGantt(); renderCalendar(); }
  // renderBoard() only touches the real (possibly hidden) Board tab's own
  // DOM — a card edited via the Home widget's own expanded-in-place Board
  // (see renderHomeWorkflowExpandedBoard()) is a separate render of the
  // same buildCardEl() cards, so without this the expanded view kept
  // showing the pre-edit card until the user left Home and came back
  // (Karl's report: "updated a card in the expanded view... didn't save"
  // — it did save, just wasn't visible there yet).
  if (homeExpandedWidgetId === 'board') renderHomeWorkflowExpandedBoard();
}

// Attached once at init, same reasoning as initJobFormAutosaveListeners:
// addEventListener-based listeners never fire from openEditCard()'s
// programmatic `.value = ...` population, only from real user input.
function initCardFormAutosaveListeners(): void {
  const titleEl = document.getElementById('c_title') as HTMLInputElement;
  titleEl.addEventListener('input', function () {
    setCardTitleHint(!titleEl.value.trim());
    scheduleCardAutosave();
  });
  document.getElementById('c_due')!.addEventListener('change', scheduleCardAutosave);

  const grid = document.getElementById('customFieldsGrid')!;
  grid.addEventListener('input', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleCardAutosave(); });
  grid.addEventListener('change', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleCardAutosave(); });

  const teamGrid = document.getElementById('teamFieldsGrid')!;
  teamGrid.addEventListener('input', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleCardAutosave(); });
  teamGrid.addEventListener('change', function (e) { if ((e.target as HTMLElement).dataset.field) scheduleCardAutosave(); });

  document.getElementById('cardModal')!.addEventListener('focusout', flushCardAutosave);
}

function deleteCardFromModal(): void {
  // Defense-in-depth — its trigger button is already data-min-tier gated,
  // but delete is irreversible enough to warrant a second check here.
  if (!hasMinTier('editor')) return;
  if (editingCardId == null) return;
  // Cancel (not flush) — the card is about to be gone, nothing left to save.
  cancelPendingCardAutosave();
  const card = boardCards.find((c) => c.id === editingCardId);
  if (card) logActivity('deleted card "' + card.title + '"');
  const cardId = editingCardId;
  boardCards = boardCards.filter((c) => c.id !== editingCardId);
  saveBoardCards();
  deleteCardFromShared(activeProjectId, cardId);
  renderBoard();
  if (homeExpandedWidgetId === 'board') renderHomeWorkflowExpandedBoard();
  closeCardModal();
  showToast('Card deleted', 'info');
}

// ===== BOARD: RENDER =====

function renderBoard(): void {
  // Column placement is date-derived (or manually overridden) — resolve it
  // before reading card.column anywhere below (badge counts, DOM placement).
  syncCardColumns();
  const wrapper = document.getElementById('boardWrapper')!;
  wrapper.innerHTML = BOARD_COLUMNS.map((col) => {
    return '<div class="board-column" data-column="' + col.id + '">' +
      '<div class="board-column-header" data-col-header="' + col.id + '" draggable="' + (hasMinTier('projectAdmin') ? 'true' : 'false') + '">' +
        '<div class="board-column-header-title"><span>' + escapeHtml(col.label) + '</span>' +
          (col.scheduleDisconnected ? '<span title="Disconnected from schedule — cards here no longer auto-move" style="display:inline-flex;flex-shrink:0;"><svg viewBox="0 0 24 24" width="13" height="13" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9l3 3 3-3 3 3-6 6 3 3 6-6-3-3 3-3-3-3-3 3-3-3z" fill="#8d6e63"/></svg></span>' : '') +
          '</div>' +
        '<div class="board-col-settings-wrap" data-min-tier="projectAdmin">' +
          '<button class="board-col-settings-btn" draggable="false" onclick="toggleColSettings(\'' + col.id + '\', event)" title="Settings">⋮</button>' +
          '<div class="board-col-settings-dropdown" id="col-settings-' + col.id + '">' +
            '<div class="board-col-color-toggle" onclick="toggleColColorPanel(\'' + col.id + '\', event)">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5c0-1 .8-1.5 2-1.5h2a4 4 0 004-4c0-4.4-4-8-9.5-8z" fill="#dcdfe6"/><circle cx="7.5" cy="10.5" r="1.7" fill="#e53935"/><circle cx="9.5" cy="7" r="1.7" fill="#f0ad4e"/><circle cx="14.5" cy="7" r="1.7" fill="#3949ab"/><circle cx="16.5" cy="11" r="1.7" fill="#28a745"/></svg> Color</span>' +
              '<span style="display:flex;align-items:center;gap:6px;">' +
                '<span class="col-color-swatch" id="col-swatch-' + col.id + '" style="background:' + (col.color || '#eceef4') + ';"></span>' +
                '<span class="col-color-arrow" id="col-arrow-' + col.id + '">▾</span>' +
              '</span>' +
            '</div>' +
            '<div class="board-col-color-panel" id="col-panel-' + col.id + '">' +
              '<div class="board-col-color-grid" id="col-colors-' + col.id + '" role="radiogroup" aria-label="Column color"></div>' +
            '</div>' +
            '<div class="board-col-gantt-toggle" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="toggleColumnScheduleVisibility(\'' + col.id + '\', event)">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="10" height="3.5" rx="1" fill="#3949ab"/><rect x="3" y="10.2" width="16" height="3.5" rx="1" fill="#3949ab" opacity="0.75"/><rect x="3" y="16.5" width="7" height="3.5" rx="1" fill="#3949ab" opacity="0.5"/></svg> Show in Schedule</span>' +
              '<span class="board-col-gantt-switch' + (col.hideFromSchedule ? '' : ' on') + '"><span class="knob"></span></span>' +
            '</div>' +
            '<div class="board-col-gantt-toggle" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="toggleColumnScheduleSync(\'' + col.id + '\', event)" title="When off, cards sitting in this board stay put and stop auto-moving with the schedule, until dragged into a connected board.">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L3 9l3 3 3-3 3 3-6 6 3 3 6-6-3-3 3-3-3-3-3 3-3-3z" fill="#8d6e63"/></svg> Connect to Schedule</span>' +
              '<span class="board-col-gantt-switch' + (col.scheduleDisconnected ? '' : ' on') + '"><span class="knob"></span></span>' +
            '</div>' +
            '<div class="board-col-gantt-toggle" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="toggleColumnFinishedTrigger(\'' + col.id + '\', event)" title="Jobs whose card sits in this board count as finished — they stop showing as overdue/due-soon or counting toward Active Jobs on Home.">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#28a745"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Finished Trigger</span>' +
              '<span class="board-col-gantt-switch' + (isFinishedColumn(col) ? ' on' : '') + '"><span class="knob"></span></span>' +
            '</div>' +
            '<div class="board-col-duration-row" title="Groups this board under a named item in the strip above Board, independent of this board\'s own name — see ⚙ Settings → Workflow Items to add more.">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="9" width="6" height="6" rx="1.5" fill="#3949ab"/><rect x="9.5" y="9" width="6" height="6" rx="1.5" fill="#3949ab" opacity="0.75"/><rect x="17" y="9" width="6" height="6" rx="1.5" fill="#3949ab" opacity="0.5"/></svg> Workflow Item</span>' +
              '<select class="board-col-duration-input" style="width:auto;flex:1;" onclick="event.stopPropagation()" onchange="setColumnWorkflowItem(\'' + col.id + '\', this.value, event)">' +
                '<option value="">None</option>' +
                WORKFLOW_ITEMS.map((item) => {
                  return '<option value="' + item.id + '"' + (item.id === col.workflowItemId ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>';
                }).join('') +
              '</select>' +
            '</div>' +
            '<div class="board-col-gantt-toggle" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="toggleColumnAutoAssignChecklist(\'' + col.id + '\', event)" title="The moment a card lands here, this board\'s Default Checklist is created on it (not just left as a template) and assigned to the picked person below, so it shows up as a real action item in their Checklist right away.">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#f0ad4e"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="6" r="4" fill="#3949ab" stroke="#fff" stroke-width="1"/></svg> Send Checklist Action Item</span>' +
              '<span class="board-col-gantt-switch' + (col.autoAssignChecklist ? ' on' : '') + '"><span class="knob"></span></span>' +
            '</div>' +
            (col.autoAssignChecklist ?
              '<div class="board-col-duration-row" title="Who the checklist items get assigned to on arrival. Left on Auto, it uses the card\'s own Foreman, then Project Manager, whichever is set.">' +
                '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="4" fill="#b0bec5"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke="#b0bec5" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg> Assign To</span>' +
                '<select class="board-col-duration-input" style="width:auto;flex:1;" onclick="event.stopPropagation()" onchange="setColumnChecklistAssignee(\'' + col.id + '\', this.value, event)">' +
                  '<option value="">Auto (card\'s Foreman/PM)</option>' +
                  (cachedUserRoster || []).map((u) => {
                    return '<option value="' + escapeHtml(u.username) + '"' + (u.username === col.checklistAssigneeOverride ? ' selected' : '') + '>' + escapeHtml(u.displayName) + '</option>';
                  }).join('') +
                '</select>' +
              '</div>' : '') +
            '<div class="board-col-duration-row" title="How many days this board\'s task defaults to when only a start date is set in Job Manager">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#b0bec5"/><path d="M12 7v5l3.5 2" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Default Duration</span>' +
              '<input type="number" min="1" class="board-col-duration-input" value="' + (col.defaultDuration || DEFAULT_TASK_DURATION_DAYS) + '" onclick="event.stopPropagation()" onchange="setColumnDefaultDuration(\'' + col.id + '\', this.value, event)">' +
            '</div>' +
            '<div class="board-col-duration-row" title="How many days a card can sit in this board before it shows up as Stalled on Home and gets a badge on the card.">' +
              '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="13" r="8" fill="#b0bec5"/><path d="M12 9v4l3 2" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Stalled After (days)</span>' +
              '<input type="number" min="1" class="board-col-duration-input" value="' + (col.stalledAfterDays || DEFAULT_STALLED_AFTER_DAYS) + '" onclick="event.stopPropagation()" onchange="setColumnStalledThreshold(\'' + col.id + '\', this.value, event)">' +
            '</div>' +
            '<div class="board-col-settings-item" onclick="openManageColumnChecklist(\'' + col.id + '\', event)"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Default Checklist</div>' +
            '<div class="board-col-settings-item" onclick="renameBoardColumn(\'' + col.id + '\', event)"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z" fill="#f0ad4e"/><path d="M15.5 5L19 8.5" stroke="#fff" stroke-width="1"/></svg> Rename</div>' +
            '<div class="board-col-settings-divider"></div>' +
            '<div class="board-col-settings-item danger" onclick="deleteBoardColumn(\'' + col.id + '\', event)"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#dc3545"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg> Delete</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="board-column-body" id="col-body-' + col.id + '"></div>' +
      '</div>';
  }).join('') +
  '<div class="board-add-column" id="addColumnContainer" data-min-tier="projectAdmin">' +
    '<button class="board-add-column-btn" id="addColumnBtn" onclick="showAddColumnForm()">+ Add Board</button>' +
    '<div class="board-add-column-form" id="addColumnForm">' +
      '<input type="text" id="newColumnName" placeholder="Enter board title..." maxlength="30" onkeydown="handleAddColumnKey(event)">' +
      '<div class="form-actions" style="margin-top:0;padding-top:0;border-top:none;">' +
        '<button class="btn btn-primary" onclick="submitAddColumn()" style="padding:6px 14px;font-size:12px;">Add Board</button>' +
        '<button class="btn btn-secondary" onclick="hideAddColumnForm()" style="padding:6px 14px;font-size:12px;">Cancel</button>' +
      '</div>' +
    '</div>' +
  '</div>';

  BOARD_COLUMNS.forEach((col) => {
    const body = document.getElementById('col-body-' + col.id)!;
    boardCards.filter((c) => c.column === col.id && !isCardFromArchivedJob(c) && isCardVisibleToMe(c)).forEach((card) => body.appendChild(buildCardEl(card)));
    body.addEventListener('dragover', handleColumnDragOver);
    body.addEventListener('dragleave', handleColumnDragLeave);
    body.addEventListener('drop', handleColumnDrop);
  });

  // Apply column colors and populate color grids
  BOARD_COLUMNS.forEach((col) => {
    const colEl = wrapper.querySelector('.board-column[data-column="' + col.id + '"]');
    if (colEl && col.color) {
      // col.color is stored pre-softened now — the board column picker
      // (BOARD_COLOR_PRESETS, below) offers its own pastel palette
      // directly, rather than this rendering a runtime-transformed
      // version of whatever the job/task color picker offers. Render it
      // as-is; no further transform here.
      (colEl as HTMLElement).style.background = col.color;
      const dark = isDarkColor(col.color);
      const header = colEl.querySelector('.board-column-header');
      if (header) {
        // Trello-style: the title reads as a darker shade of the board's
        // own color (inherited by the title span below it — see
        // .board-column-header-title in the stylesheet, which sets no
        // color of its own) rather than generic black text, when the
        // background is light enough for that to stay readable. A
        // genuinely dark board color keeps the existing white-text
        // fallback — darkening an already-dark color further would be
        // illegible. Doesn't touch the badge or ⋮ button, which both
        // already carry their own explicit colors regardless.
        (header as HTMLElement).style.color = dark ? '#fff' : darkenColor(col.color, 0.6);
        const badge = header.querySelector('.badge');
        if (badge) (badge as HTMLElement).style.background = dark ? 'rgba(255,255,255,0.25)' : '';
        const settingsBtn = header.querySelector('.board-col-settings-btn');
        if (settingsBtn) (settingsBtn as HTMLElement).style.color = dark ? 'rgba(255,255,255,0.7)' : '';
      }
    }
    const colorGrid = document.getElementById('col-colors-' + col.id);
    if (colorGrid) {
      colorGrid.innerHTML =
        '<div class="board-col-color-option' + (!col.color ? ' selected' : '') + '" style="background:linear-gradient(135deg,#f5f5f5 0%,#e0e0e0 100%);position:relative;" role="radio" aria-checked="' + (!col.color) + '"' + swatchKeyboardAttrs(!col.color) + ' onclick="changeColumnColor(\'' + col.id + '\', \'' + '\', event)" title="Default (no color)">' +
        '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#888;"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#dc3545"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg></span></div>' +
        BOARD_COLOR_PRESETS.map((c) =>
        '<div class="board-col-color-option' + (col.color === c ? ' selected' : '') + '" style="background:' + c + ';" role="radio" aria-checked="' + (col.color === c) + '"' + swatchKeyboardAttrs(col.color === c) + ' onclick="changeColumnColor(\'' + col.id + '\', \'' + c + '\', event)"></div>'
      ).join('');
    }
  });

  // Column reorder drag handlers
  wrapper.querySelectorAll('.board-column-header').forEach((headerEl) => {
    headerEl.addEventListener('dragstart', handleColumnDragStart as EventListener);
    headerEl.addEventListener('dragend', handleColumnDragEnd as EventListener);
  });
  wrapper.querySelectorAll('.board-column').forEach((colEl) => {
    colEl.addEventListener('dragover', handleColumnReorderOver as EventListener);
    colEl.addEventListener('dragleave', handleColumnReorderLeave as EventListener);
    colEl.addEventListener('drop', handleColumnReorderDrop as EventListener);
  });

  document.getElementById('boardCount')!.textContent = String(boardCards.filter((c) => !isCardFromArchivedJob(c) && isCardVisibleToMe(c)).length);

  // renderBoard() rebuilds the column headers (incl. the ⋮ settings menu,
  // data-min-tier="projectAdmin") from scratch via wrapper.innerHTML on
  // every call — and it's called directly from ~25 places across this file
  // (card drags, column drops, job/phase edits, etc.), not just from
  // renderAll(). Relying on renderAll()'s own trailing applyPermissionGating()
  // left every one of those other call sites re-rendering the settings menu
  // back into its default (visible) state with nothing to re-hide it again
  // until the next full renderAll() happened to run — a real gap, not just
  // a first-paint timing issue. Calling it here too is redundant with
  // renderAll()'s call (harmless — this is a cheap, idempotent DOM sweep)
  // but is what actually closes the gap for every other call site.
  applyPermissionGating();
  renderBoardWorkflowStrip();

  // PM/Foreman lines on card faces resolve a username to a display name
  // via displayNameForUsername() — if the roster hasn't loaded yet, that
  // falls back to showing the raw username. Kick off the (cached-after-
  // first-success) load here and re-render once it resolves so those
  // lines correct themselves rather than staying wrong for the session.
  if (!cachedUserRoster) {
    ensureUserRosterLoaded().then(function () { renderBoard(); });
  }
}

function buildCardEl(card: BoardCard): HTMLElement {
  const el = document.createElement('div');
  const hasOverride = !!(card.manualColumn && card.manualColumnUntil && Date.now() < card.manualColumnUntil);
  el.className = 'board-card' + (hasOverride ? ' manual-override' : '');
  el.draggable = hasMinTier('editor');
  el.dataset.id = card.id;
  el.style.borderLeftColor = card.color || 'var(--primary-light)';
  if (hasOverride) {
    el.title = 'Manually placed — auto-sync resumes at ' + new Date(card.manualColumnUntil!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  const badges: string[] = [];
  const overrideBadge = hasOverride
    ? '<span class="board-card-override-badge" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="reconnectCard(\'' + card.id + '\', event)" title="Manually placed — auto-sync resumes at ' + new Date(card.manualColumnUntil!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '. Click to reconnect now."><svg viewBox="0 0 24 24" width="12" height="12" style="vertical-align:-2px" xmlns="http://www.w3.org/2000/svg"><path d="M13 3l-9 10h6l-1 8 9-10h-6l1-8z" fill="#f0ad4e"/></svg> Manual <span style="text-decoration:underline;margin-left:2px;">Reconnect</span></span>'
    : '';

  if (card.due) {
    const isOverdue = !isFinishedColumnId(card.column) && new Date(card.due + 'T00:00:00') < new Date(new Date().toDateString());
    const dueLabel = new Date(card.due + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    badges.push('<span class="board-card-due' + (isOverdue ? ' overdue' : '') + '"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935"/><rect x="6" y="13" width="3" height="3" fill="#e53935"/><rect x="10.5" y="13" width="3" height="3" fill="#e53935"/><rect x="15" y="13" width="3" height="3" fill="#e53935"/></svg> ' + dueLabel + '</span>');
  }

  // Time-in-stage, not a due date — see buildHomeStalledRows() for the
  // matching Home widget. Skipped on a finished-trigger column for the
  // same reason the overdue badge above is: a job that's already done
  // sitting in Complete isn't "stalled," it's just parked.
  if (card.columnEnteredAt && !isFinishedColumnId(card.column)) {
    const col = BOARD_COLUMNS.find((c) => c.id === card.column);
    const thresholdDays = (col && col.stalledAfterDays) || DEFAULT_STALLED_AFTER_DAYS;
    const daysInStage = Math.floor((Date.now() - card.columnEnteredAt) / 86400000);
    if (daysInStage >= thresholdDays) {
      badges.push('<span class="board-card-due overdue" title="' + daysInStage + ' days in this board"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="13" r="8" fill="#fff" stroke="#e53935" stroke-width="1.5"/><path d="M12 9v4l3 2" stroke="#e53935" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + daysInStage + 'd stalled</span>');
    }
  }

  // Plain "Label: value" text rows (Trello-style) instead of icon
  // pills/badges — driven straight off CUSTOM_FIELD_DEFS so a field's
  // label here always matches its label in the Team/Custom Fields forms.
  // 'members' is skipped (would be a long name list, not a fit for a
  // single line on the card face).
  const cf = card.customFields || {};
  const cfLines: string[] = [];
  CUSTOM_FIELD_DEFS.forEach((def) => {
    if (def.key === 'members') return;
    let val = cf[def.key] as string;
    if (!val) return;
    if (def.type === 'user-select') val = displayNameForUsername(val);
    cfLines.push('<div class="board-card-meta-line">' + escapeHtml(def.label) + ': ' + escapeHtml(val) + '</div>');
  });

  // Current stage's checklist only — a pure read (no lazy-seed/write here,
  // this renders on every board paint and could race a remote sync if it
  // wrote to card.checklists). Previews exactly what
  // getChecklistForStageInProject() (the My Checklist tab) would
  // materialize if this stage were opened right now: stored items
  // (minus any soft-deleted ones — see deleteMyChecklistItem()) plus any
  // template item this stage hasn't seen yet (matched by id, so a
  // deliberately-removed template item never gets counted back in just
  // because the template gained an unrelated new item).
  ensureCardChecklists(card);
  const stageCol = BOARD_COLUMNS.find((c) => c.id === card.column);
  const templ = (stageCol && stageCol.defaultChecklist) || [];
  const stored = (card.checklists && card.checklists[card.column]) || [];
  const storedIds = stored.map((i: any) => i.id);
  let checklist: any[] = stored.filter((i: any) => !i.removed).concat(
    (templ as any[]).filter((d: any) => storedIds.indexOf(d.id) === -1).map((d: any) => ({ id: d.id, text: d.text, done: false, assignee: '' }))
  );
  // A stage assigned to someone else (see setMyChecklistStageAssignee()) is
  // private — no badge leaking its progress to viewers who can't open it.
  if (!isChecklistStageVisibleToMe(card.checklistAssignees, card.column)) checklist = [];
  // Sub-items count toward this badge too — see My Checklist's own
  // matching per-item rendering.
  const allDoneFlags: boolean[] = checklist.reduce((acc: boolean[], i: any) => acc.concat([i.done], (i.subItems || []).map((s: any) => s.done)), []);
  if (allDoneFlags.length) {
    const doneCount = allDoneFlags.filter(Boolean).length;
    const allDone = doneCount === allDoneFlags.length;
    badges.push('<span class="mini-badge' + (allDone ? ' checklist-complete' : '') + '"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + doneCount + '/' + allDoneFlags.length + '</span>');
  }

  const attachments = card.attachments || [];
  if (attachments.length) badges.push('<span class="mini-badge"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right:3px" xmlns="http://www.w3.org/2000/svg"><path d="M8 12.5V7a4 4 0 018 0v9a2.5 2.5 0 01-5 0V8.5" stroke="#78909c" stroke-width="2" fill="none" stroke-linecap="round"/></svg> ' + attachments.length + '</span>');

  el.innerHTML = overrideBadge +
    '<div class="board-card-title">' + escapeHtml(card.title || '') + '</div>' +
    (cfLines.length ? '<div class="board-card-meta">' + cfLines.join('') + '</div>' : '') +
    (badges.length ? '<div class="board-card-badges">' + badges.join('') + '</div>' : '');

  // Mobile-only "Move to" fallback — hidden above 480px (see the
  // .board-card-move-select rules), where dragging still works. Built as
  // a real element rather than an innerHTML string so the card id doesn't
  // need escaping into an inline onchange handler.
  const moveSelect = document.createElement('select');
  moveSelect.className = 'board-card-move-select';
  moveSelect.title = 'Move to a different board';
  BOARD_COLUMNS.forEach((col) => {
    const opt = document.createElement('option');
    opt.value = col.id;
    opt.textContent = col.label;
    if (col.id === card.column) opt.selected = true;
    moveSelect.appendChild(opt);
  });
  moveSelect.addEventListener('click', function (e) { e.stopPropagation(); });
  moveSelect.addEventListener('change', function () { moveCardToColumn(card.id, moveSelect.value); });
  el.appendChild(moveSelect);

  el.addEventListener('click', () => openEditCard(card.id));
  el.addEventListener('dragstart', handleCardDragStart);
  el.addEventListener('dragend', handleCardDragEnd);
  return el;
}

// ===== BOARD: COLUMN SETTINGS DROPDOWN (⋮ menu) =====
function isDarkColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Relative luminance formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}

function toggleColSettings(colId: string, event: Event): void {
  event.stopPropagation();
  const dropdown = document.getElementById('col-settings-' + colId)!;
  const isOpen = dropdown.classList.contains('show');
  closeAllColSettings();
  if (!isOpen) dropdown.classList.add('show');
}

function toggleColColorPanel(colId: string, event: Event): void {
  event.stopPropagation();
  const panel = document.getElementById('col-panel-' + colId)!;
  const toggle = event.currentTarget as HTMLElement;
  const open = !panel.classList.contains('open');
  // Close other color panels first
  document.querySelectorAll('.board-col-color-panel').forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('.board-col-color-toggle').forEach((t) => t.classList.remove('open'));
  if (open) {
    panel.classList.add('open');
    toggle.classList.add('open');
  }
}

function changeColumnColor(colId: string, color: string, event: Event): void {
  event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (col) {
    if (color) {
      col.color = color;
      logActivity('changed board "' + col.label + '" color');
      showToast('Board color updated', 'success');
    } else {
      delete col.color;
      logActivity('reset board "' + col.label + '" color');
      showToast('Board color reset to default', 'info');
    }
    // Task colors mirror their column, so a column recolor needs to
    // propagate to every job's matching task (and the Gantt/board bars
    // that read task.color).
    jobs.forEach(function (job) { ensureJobTasksMatchColumns(job); });
    saveJobs();
    saveBoardColumns();
    renderBoard();
    renderGantt();
    if (editingJobId) {
      const found = findJob(editingJobId);
      if (found) renderFixedTaskGrid(found.job.tasks || []);
    }
  }
  closeAllColSettings();
}

function closeAllColSettings(): void {
  document.querySelectorAll('.board-col-settings-dropdown').forEach((d) => d.classList.remove('show'));
}

// A hidden board still exists as a real column — jobs still get a task for
// it and its dates/notes are preserved untouched. This just controls
// whether that column's task shows up: as a row/bar on the Gantt, a row on
// the Calendar, and (since it can't be scheduled from either of those while
// hidden) as an editable row in the Job Manager's fixed grid too. Un-hide
// the board to see and edit it again everywhere.
function toggleColumnScheduleVisibility(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  col.hideFromSchedule = !col.hideFromSchedule;
  saveBoardColumns();
  logActivity((col.hideFromSchedule ? 'hid' : 'showed') + ' board "' + col.label + '" on the Gantt/Calendar/Job Manager');
  renderBoard();
  renderGantt();
  renderCalendar();
  if (editingJobId) {
    const found = findJob(editingJobId);
    if (found) renderFixedTaskGrid(found.job.tasks || []);
  }
  showToast('"' + col.label + '" ' + (col.hideFromSchedule ? 'hidden from' : 'shown on') + ' the Gantt, Calendar & Job Manager', 'success');
  closeAllColSettings();
}

// While a board is disconnected, deriveColumnForTasks() leaves any card that's
// currently sitting in it alone — no expiry, unlike a normal manual drag's
// 24h override. Dragging the card into a different, connected board is the
// only way out (handleColumnDrop just sets card.column like any other move).
function toggleColumnScheduleSync(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  col.scheduleDisconnected = !col.scheduleDisconnected;
  saveBoardColumns();
  logActivity((col.scheduleDisconnected ? 'disconnected' : 'reconnected') + ' board "' + col.label + '" from the schedule');
  renderBoard();
  showToast('"' + col.label + '" ' + (col.scheduleDisconnected ? 'disconnected from' : 'reconnected to') + ' the schedule', 'success');
  closeAllColSettings();
}

// See isFinishedColumn() for the default (Complete/Invoiced count even
// when this has never been touched) — toggling always writes an explicit
// true/false here, on any column, which then wins over that default.
function toggleColumnFinishedTrigger(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  const next = !isFinishedColumn(col);
  col.isFinished = next;
  saveBoardColumns();
  logActivity((next ? 'marked' : 'unmarked') + ' board "' + col.label + '" as a finished trigger');
  renderBoard();
  renderHomeDashboard();
  showToast('"' + col.label + '" ' + (next ? 'now marks jobs finished' : 'no longer marks jobs finished'), 'success');
  closeAllColSettings();
}

// Not itself a toggle, same reasoning as setColumnChecklistAssignee()
// below — fires from the <select>'s own onchange, so no re-render/close
// here (renderBoardWorkflowStrip() below picks up the change on its own
// next natural render, e.g. the next card move/edit; a full renderBoard()
// here would just close the dropdown mid-pick for no benefit).
function setColumnWorkflowItem(colId: string, itemId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  col.workflowItemId = itemId || null;
  saveBoardColumns();
  const item = WORKFLOW_ITEMS.find(function (i) { return i.id === itemId; });
  logActivity('set board "' + col.label + '" workflow item to ' + (item ? item.label : 'None'));
  renderBoardWorkflowStrip();
  showToast('Workflow item updated', 'success');
}

// See runColumnEntryActions() (index.html) for what this actually does
// when a card lands here — materializes the column's Default Checklist
// onto the card immediately (rather than lazily, the first time someone
// happens to open My Checklist or the card) and assigns it, turning it
// into a real action item right away instead of sitting inert.
function toggleColumnAutoAssignChecklist(colId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  col.autoAssignChecklist = !col.autoAssignChecklist;
  saveBoardColumns();
  logActivity((col.autoAssignChecklist ? 'enabled' : 'disabled') + ' checklist action-items for board "' + col.label + '"');
  renderBoard();
  showToast('"' + col.label + '" ' + (col.autoAssignChecklist ? 'now sends' : 'no longer sends') + ' checklist action items', 'success');
  closeAllColSettings();
}

// Not itself a toggle — overwrites col.checklistAssigneeOverride with
// whatever the "Assign To" <select> was set to; '' means "Auto" (falls
// back to the card's own Foreman, then PM, at runColumnEntryActions()
// time). Deliberately doesn't re-render/close the dropdown, unlike the
// toggles above — this fires from the <select>'s own onchange, and a
// disruptive re-render right as someone's picking an option would be
// worse than just leaving it as a quiet save+toast.
function setColumnChecklistAssignee(colId: string, username: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  col.checklistAssigneeOverride = username || '';
  saveBoardColumns();
  const label = username ? displayNameForUsername(username) : 'Auto (card\'s Foreman/PM)';
  logActivity('set board "' + col.label + '" checklist action-item assignee to ' + label);
  showToast('Checklist assignee updated', 'success');
}

// Drives the auto-fill in renderFixedTaskGrid's startInput handler — setting
// only a start date for this board's task defaults its duration to this
// value instead of the app-wide DEFAULT_TASK_DURATION_DAYS fallback. Patches
// the input in place (rather than a full renderBoard()) so the dropdown
// stays open and the field reflects the clamped/normalized value.
function setColumnDefaultDuration(colId: string, value: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  const days = parseInt(value, 10);
  col.defaultDuration = (days && days > 0) ? days : DEFAULT_TASK_DURATION_DAYS;
  saveBoardColumns();
  if (event && event.target) (event.target as HTMLInputElement).value = String(col.defaultDuration);
  logActivity('set board "' + col.label + '" default duration to ' + col.defaultDuration + ' day' + (col.defaultDuration === 1 ? '' : 's'));
  showToast('Default duration updated', 'success');
}

// Feeds buildHomeStalledRows()'s threshold check (DEFAULT_STALLED_AFTER_DAYS
// is the fallback when this has never been set) — patches the input in
// place rather than a full renderBoard(), same reasoning as
// setColumnDefaultDuration() above, so the dropdown stays open.
function setColumnStalledThreshold(colId: string, value: string, event?: Event): void {
  if (event) event.stopPropagation();
  const col = BOARD_COLUMNS.find((c) => c.id === colId);
  if (!col) return;
  const days = parseInt(value, 10);
  col.stalledAfterDays = (days && days > 0) ? days : DEFAULT_STALLED_AFTER_DAYS;
  saveBoardColumns();
  if (event && event.target) (event.target as HTMLInputElement).value = String(col.stalledAfterDays);
  logActivity('set board "' + col.label + '" stalled-after threshold to ' + col.stalledAfterDays + ' day' + (col.stalledAfterDays === 1 ? '' : 's'));
  renderHomeDashboard();
  renderBoardWorkflowStrip();
  showToast('Stalled threshold updated', 'success');
}

// A manual drag pins a card to its dropped column for 24h (see
// handleColumnDrop); this lets the user clear that pin immediately instead
// of waiting it out or re-saving the job in Job Manager just to force a
// re-sync.
function reconnectCard(cardId: string, event?: Event): void {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  const card = boardCards.find(function (c) { return String(c.id) === String(cardId); });
  if (!card) return;
  card.manualColumn = null;
  card.manualColumnUntil = null;
  saveBoardCards();
  logActivity('reconnected "' + card.title + '" to the schedule');
  renderBoard();
  if (homeExpandedWidgetId === 'board') renderHomeWorkflowExpandedBoard();
  showToast('Card reconnected to schedule', 'success');
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
  handleColorSwatchKeydown,
  addWorkflowItem,
  removeWorkflowItem,
  resolveCardNameTarget,
  openEditCard,
  closeCardModal,
  scheduleCardAutosave,
  flushCardAutosave,
  cancelPendingCardAutosave,
  setCardTitleHint,
  autoSaveCardForm,
  initCardFormAutosaveListeners,
  deleteCardFromModal,
  renderBoard,
  buildCardEl,
  isDarkColor,
  toggleColSettings,
  toggleColColorPanel,
  changeColumnColor,
  closeAllColSettings,
  toggleColumnScheduleVisibility,
  toggleColumnScheduleSync,
  toggleColumnFinishedTrigger,
  setColumnWorkflowItem,
  toggleColumnAutoAssignChecklist,
  setColumnChecklistAssignee,
  setColumnDefaultDuration,
  setColumnStalledThreshold,
  reconnectCard,
};
