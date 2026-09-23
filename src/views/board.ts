// Board view: drag-and-drop, column CRUD (slugifyColumnId/addBoardColumn/
// deleteBoardColumn/renameBoardColumn), card visibility
// (isCardFromArchivedJob/isCardVisibleToMe), workflow items
// (openWorkflowItemsModal and friends), the card detail modal and its
// autosave (openEditCard and friends), renderBoard()/buildCardEl(), the
// column settings dropdown (⋮ menu: isDarkColor/toggleColSettings/
// toggleColColorPanel/changeColumnColor/closeAllColSettings/
// toggleColumnScheduleVisibility/toggleColumnScheduleSync/
// toggleColumnFinishedTrigger/setColumnWorkflowItem/
// toggleColumnAutoAssignChecklist/setColumnChecklistAssignee/
// setColumnDefaultDuration/setColumnStalledThreshold/reconnectCard), the
// "add a board" form (showAddColumnForm and friends), and the workflow
// strip above the board itself (buildWorkflowStageData/
// renderBoardWorkflowStrip/scrollToBoardColumn — reuses home.ts's
// buildHomeStageSummary()/buildHomeStalledRows() rather than
// recomputing either, hence the real import from './home' below; home.ts
// already imports from this file, so this is a real, deliberate circular
// import between the two — safe here since neither side calls the
// other at module-evaluation time, only from within functions).
//
// The checklist system (ensureCardChecklists/isChecklistStageVisibleToMe/
// getChecklistForStageInProject/toggleMyChecklistItemRequired and the
// whole "My Checklist" tab) is deliberately NOT part of Board — it's
// cross-cutting (also used by Job Manager and its own dedicated tab) —
// see src/views/checklist.ts, which this file imports
// ensureCardChecklists()/isChecklistStageVisibleToMe()/
// confirmChecklistBeforeMove() from.
//
// isDarkColor() is a real function here; src/views/calendar.ts still
// declares it as an ambient global rather than importing it from here.
//
// Custom fields (renderCustomFieldsGrid/renderTeamFieldsGrid/
// collectCustomFieldValues/renderFieldDefHtml) and attachments
// (renderAttachmentPanel and friends) live here because the card modal
// above owns the "real" implementation both surfaces share — Job
// Manager's own mirrored grids/attachment panel (renderJobCustomFieldsGrid/
// renderJobTeamFieldsGrid/collectJobCustomFieldValues/
// JM_ATTACHMENT_PANEL_CONFIG, in src/views/job-form.ts) call these as
// ambient globals rather than importing them.
//
// Several functions this file calls but does NOT define — setCardColumn(),
// isJobVisibleToMe(), renderGantt(), renderJobList(), renderCalendar(),
// saveWorkflowItems(), hasMinTier(), saveFieldOptions(),
// renderJobCustomFieldsGrid(), renderJobTeamFieldsGrid(),
// collectJobCustomFieldValues(), deleteCardFromShared(),
// refreshJobFormIfOpen(), syncCardColumns(), isFinishedColumn(),
// isFinishedColumnId(), applyPermissionGating(),
// saveJobs(), renderHomeDashboard(),
// renderFixedTaskGrid() — stay in index.html on purpose (checklist
// business rules, modal-chrome/permission plumbing shared across many
// modals, Job Manager's own still-inline mirror functions, or genuinely
// separate concerns like the Gantt/Calendar/Job List re-renders a rename
// triggers). Referenced below as ambient globals: an ordinary top-level
// `function` declaration already attaches to `window` on its own (unlike
// `let`/`const`), so none of those needed any change to stay visible here
// — only genuinely mutated DATA globals do.
import type { BoardCard, BoardColumn, WorkflowItem, Job, Task, Phase, CustomFieldDef } from '../core/types';
import { findJob } from '../core/models';
import { ensureJobTasksMatchColumns, setCardColumn, syncCardColumns } from '../core/jobs';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { createAutosaveController } from '../utils/autosave';
import { darkenColor, softenColor, columnLabelTextColor, tintedTextColor } from '../utils/color';
import { COLOR_PRESETS } from '../core/constants';
import { openModal, closeModal, showToast, onPanelResize, toggleMsDropdown, msSetAll, msDropdownLabelText, isPanelActive } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';
import { getStoredSessionToken } from '../auth/session';
import { fetchWithReauth } from '../app/worker-client';
import { ensureCardChecklists, isChecklistStageVisibleToMe, confirmChecklistBeforeMove } from './checklist';
import { buildHomeStageSummary, buildHomeStalledRows, computeColumnStalledFloors } from './home';
import { displayNameForUsername, getLeadRoster, ensureUserRosterLoaded } from '../app/user-roster';
import { renderBoardCardsInto, type BoardCardProps, type CardMetaLine, type CardDueBadge, type CardStalledBadge, type CardChecklistBadge } from './board-card';
import { renderBoardColumnsChromeInto, type BoardColumnChromeProps, type SelectOption, type ColorSwatch, type AddColumnFormProps } from './board-column-chrome';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS, jobs, saveJobs(), hasMinTier(), etc.) are
// declared once in src/shared-globals.d.ts, not repeated here.
declare global {
  // eslint-disable-next-line no-var
  var editingCardId: string | null;
  // eslint-disable-next-line no-var
  var draftAttachments: unknown[];
  // eslint-disable-next-line no-var
  var fieldOptions: Record<string, string[]>;
  function renderFixedTaskGrid(taskList: Task[]): void;
  function saveBoardCards(): void;
  function saveWorkflowItems(): void;
  function saveFieldOptions(): void;
  function renderCalendar(): void;
  function renderHomeWorkflowExpandedBoard(): void;
  function renderJobCustomFieldsGrid(values: Record<string, unknown>): void;
  function renderJobTeamFieldsGrid(values: Record<string, unknown>): void;
  function collectJobCustomFieldValues(): Record<string, unknown>;
  function deleteCardFromShared(projectId: string | null, cardId: string): void;
  function isFinishedColumn(col: BoardColumn): boolean;
  function openManageColumnChecklist(colId: string, event?: Event): void;
}

// A stronger blend than utils/color.ts's own SOFTEN_AMOUNT (used for
// Gantt bars): at 18%, already-light presets (yellow, cyan) barely
// shifted while dark ones (navy, red) shifted a lot, so the palette read
// as an inconsistent mix of "still vivid" and "clearly pastel" rather
// than a uniform pastel set — confirmed by rendering an actual
// side-by-side comparison. 30% reads as consistently pastel across every
// hue. Local to this file — nothing else needs the raw blend amount,
// only the resulting BOARD_COLOR_PRESETS below.
const BOARD_COLOR_SOFTEN_AMOUNT = 0.30;
// Real module-owned export now (moved out of index.html) — every other
// reader is a test asserting against it, not another src/ file, so this
// only needs wiring into window via main.ts, not src/shared-globals.d.ts.
export const BOARD_COLOR_PRESETS = COLOR_PRESETS.map((c) => softenColor(c, BOARD_COLOR_SOFTEN_AMOUNT));

// Fallback only — per-board default lives on col.defaultDuration, set from
// each board's ⋮ settings menu (see setColumnDefaultDuration). Read by
// src/views/job-form.ts too — see its own ambient declaration of this in
// src/shared-globals.d.ts.
export const DEFAULT_TASK_DURATION_DAYS = 5;

// job.customFields is the store; this defines what fields exist, in what
// order, and how each renders. Read by src/views/job-form.ts too — see
// its own ambient declaration of this in src/shared-globals.d.ts.
export const CUSTOM_FIELD_DEFS: CustomFieldDef[] = [
  // Real-account single-select, same source as Members (cachedUserRoster)
  // just one value instead of an array — see renderCustomFieldsGrid()'s
  // 'user-select' branch. Existing free-text values (from before this
  // change) won't match any option here and will just show blank until
  // re-picked from the real list.
  { key: 'pm', label: 'Project Manager', type: 'user-select' },
  { key: 'foreman', label: 'Project Lead/Foreman', type: 'user-select' },
  { key: 'customer', label: 'Customer', type: 'select' },
  { key: 'poNumber', label: 'Job / P.O. Number', type: 'text' },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'jobType', label: 'Job Type', type: 'select' },
  { key: 'timeframe', label: 'Timeframe', type: 'select' },
  { key: 'incentivePeriod', label: 'Incentive Period', type: 'select' },
  // Unlike every field above (one value each), a job can have any number of
  // Members — rendered as a checkbox list instead of a dropdown, and stored
  // as an array (see renderCustomFieldsGrid()/collectCustomFieldValues()).
  // Its option pool (the roster of people who CAN be added) is still
  // managed the same way as a 'select' field's dropdown choices — see
  // renderManageFieldsBody()'s type filter.
  { key: 'members', label: 'Members', type: 'multiselect' },
];
// pm/foreman/members render in their own "Team" section instead of
// Custom Fields (see renderTeamFieldsGrid()/renderJobTeamFieldsGrid()) —
// still defined in CUSTOM_FIELD_DEFS above and stored under the same
// card.customFields keys, just filtered into a different grid at render
// time. Nothing about storage/collection/visibility logic changes. Read
// by src/views/job-form.ts too — see its own ambient declaration of this
// in src/shared-globals.d.ts.
export const TEAM_FIELD_KEYS = ['pm', 'foreman', 'members'];

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

function slugifyColumnId(label: string): string {
  let base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
  if (!base) base = 'board';
  let id = base, n = 2;
  while (BOARD_COLUMNS.some(c => c.id === id)) { id = base + '-' + n; n++; }
  return id;
}

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

function showAddColumnForm(): void {
  (document.getElementById('addColumnBtn') as HTMLElement).style.display = 'none';
  document.getElementById('addColumnForm')!.classList.add('active');
  (document.getElementById('newColumnName') as HTMLElement).focus();
}

function hideAddColumnForm(): void {
  (document.getElementById('addColumnBtn') as HTMLElement).style.display = 'block';
  document.getElementById('addColumnForm')!.classList.remove('active');
  (document.getElementById('newColumnName') as HTMLInputElement).value = '';
}

function handleAddColumnKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); submitAddColumn(); }
  if (e.key === 'Escape') { hideAddColumnForm(); }
}

function submitAddColumn(): void {
  const input = document.getElementById('newColumnName') as HTMLInputElement;
  const trimmed = input.value.trim();
  if (!trimmed) { showToast('Board name cannot be empty', 'error'); return; }
  addBoardColumn(trimmed);
  hideAddColumnForm();
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
  if (isPanelActive('gantt')) renderGantt();
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
  if (isPanelActive('board')) renderBoard();
  // This card's job might already be open in Job Manager — without this its
  // description/due/custom fields/checklist/attachments would keep showing
  // whatever was there when that form was first opened.
  if (savedCard.jobId) refreshJobFormIfOpen(savedCard.jobId);
  // A job/phase rename shows up in more places than just the Board — same
  // refresh set autoSaveJobForm() runs after its own name edits.
  if (renamedJobOrPhase) {
    renderJobList();
    if (isPanelActive('gantt')) renderGantt();
    if (isPanelActive('calendar')) renderCalendar();
  }
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

// ===== BOARD: WORKFLOW STRIP =====
// The stacked-header band above the board itself. Groups BOARD_COLUMNS
// into contiguous runs sharing the same workflowItemId — an unassigned
// column never merges with an adjacent unassigned one (each keeps its
// own board name; only columns actually assigned to the SAME item merge
// into one span, per Karl's spec: "a workflow item with more than one
// board would stretch above both boards if they are next to each
// other"). Reuses home.ts's buildHomeStageSummary()'s counts and
// buildHomeStalledRows() rather than recomputing either. See
// renderBoardWorkflowStrip() for the position-measuring/rendering half.
function buildWorkflowStageData(): { firstColId: string; lastColId: string; label: string; color?: string | null; isItem: boolean; count: number; stalledCount: number }[] {
  const perColumnCounts: Record<string, number> = {};
  buildHomeStageSummary().forEach(function(s) { perColumnCounts[s.id] = s.count; });
  const stalledCountByCol: Record<string, number> = {};
  buildHomeStalledRows().forEach(function(row) {
    stalledCountByCol[row.card.column] = (stalledCountByCol[row.card.column] || 0) + 1;
  });

  const runs: { key: string; workflowItemId: string | null; colIds: string[] }[] = [];
  BOARD_COLUMNS.forEach(function(col) {
    const key = col.workflowItemId || ('__col__' + col.id);
    const prevRun = runs[runs.length - 1];
    if (prevRun && prevRun.key === key) prevRun.colIds.push(col.id);
    else runs.push({ key: key, workflowItemId: col.workflowItemId || null, colIds: [col.id] });
  });

  return runs.map(function(run) {
    const item = run.workflowItemId ? WORKFLOW_ITEMS.find(function(i) { return i.id === run.workflowItemId; }) : null;
    const firstCol = BOARD_COLUMNS.find(function(c) { return c.id === run.colIds[0]; });
    return {
      firstColId: run.colIds[0],
      lastColId: run.colIds[run.colIds.length - 1],
      label: item ? item.label : (firstCol ? firstCol.label : ''),
      color: item ? item.color : null,
      isItem: !!item,
      count: run.colIds.reduce(function(n, id) { return n + (perColumnCounts[id] || 0); }, 0),
      stalledCount: run.colIds.reduce(function(n, id) { return n + (stalledCountByCol[id] || 0); }, 0)
    };
  });
}

// Measures each group's real left/right edge against the actual rendered
// .board-column elements — not computed from fixed widths, so it stays
// correct whether desktop (245px columns) or mobile (calc(100vw-48px))
// — then draws an angled bracket per group and a flow arrow in each real
// gap between adjacent groups. Called from renderBoard() so it always
// reflects the same data/column positions currently on screen.
function renderBoardWorkflowStrip(): void {
  const wrapper = document.getElementById('boardWrapper');
  const track = document.getElementById('wfTrack');
  if (!wrapper || !track) return;
  const wrapperRect = wrapper.getBoundingClientRect();

  const measured = buildWorkflowStageData().map(function(g) {
    const firstEl = wrapper.querySelector('.board-column[data-column="' + g.firstColId + '"]');
    const lastEl = wrapper.querySelector('.board-column[data-column="' + g.lastColId + '"]');
    if (!firstEl || !lastEl) return null;
    const left = firstEl.getBoundingClientRect().left - wrapperRect.left + wrapper.scrollLeft;
    const right = lastEl.getBoundingClientRect().right - wrapperRect.left + wrapper.scrollLeft;
    return Object.assign({}, g, { left: left, right: right });
  }).filter(Boolean) as ({ firstColId: string; lastColId: string; label: string; color?: string | null; isItem: boolean; count: number; stalledCount: number; left: number; right: number })[];

  const segmentsHtml = measured.map(function(g) {
    const width = g.right - g.left;
    const isUnassigned = !g.isItem;
    const style = 'left:' + g.left + 'px; width:' + width + 'px;';
    const stalledHtml = g.stalledCount ? '<span class="wf-stalled">⚠ ' + g.stalledCount + '</span>' : '';
    const labelRow = '<div class="wf-seg-label">' + escapeHtml(g.label) +
      (isUnassigned ? '' : '<span class="wf-count">' + g.count + '</span>') +
      stalledHtml +
    '</div>';
    // Angled ticks (a trapezoid: narrower at the top bar, flaring
    // outward toward the boards) rather than a squared-off corner, per
    // Karl's direction — drawn over every group, single-column or not.
    const bw = Math.max(width - 16, 20);
    const inset = 2.5, flare = 7;
    const path = 'M' + inset + ',10 L' + (inset + flare) + ',2.5 L' + (bw - inset - flare) + ',2.5 L' + (bw - inset) + ',10';
    const bracketStyle = g.color ? ('color:' + g.color + ';') : 'color:var(--text-light);opacity:0.6;';
    const bracket = '<div class="wf-bracket-wrap" style="' + bracketStyle + '"><svg width="' + bw + '" height="10" viewBox="0 0 ' + bw + ' 10">' +
      '<path d="' + path + '" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></div>';
    const title = g.count + ' job' + (g.count === 1 ? '' : 's') + ' in ' + g.label + (g.stalledCount ? ', ' + g.stalledCount + ' stalled' : '');
    return '<div class="wf-seg' + (isUnassigned ? ' unassigned' : '') + '" style="' + style + '" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="scrollToBoardColumn(\'' + g.firstColId + '\')" title="' + escapeHtml(title) + '">' + labelRow + bracket + '</div>';
  }).join('');

  // One arrow per real gap between adjacent groups — flow direction
  // between workflow items, not just within one.
  const arrowsHtml = measured.slice(0, -1).map(function(g, i) {
    const next = measured[i + 1];
    const midX = (g.right + next.left) / 2;
    return '<div class="wf-flow-arrow" style="left:' + midX + 'px;">' +
      '<svg width="32" height="32" viewBox="0 0 24 24"><path d="M4 12h14m0 0l-5.5-5.5m5.5 5.5l-5.5 5.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '</div>';
  }).join('');

  track.innerHTML = segmentsHtml + arrowsHtml;

  // Keeps the band locked to the board's own horizontal scroll — same
  // mechanism the Gantt's date header uses (src/views/gantt.ts's
  // setHeaderScroll()), not a second independent scrollbar that could
  // drift out of alignment. Property assignment, not addEventListener,
  // so re-running this on every renderBoard() doesn't stack up duplicate
  // listeners the way repeated addEventListener calls would.
  (wrapper as HTMLElement).onscroll = function() {
    (track as HTMLElement).style.transform = 'translateX(-' + (wrapper as HTMLElement).scrollLeft + 'px)';
  };
}

function scrollToBoardColumn(colId: string): void {
  const el = document.querySelector('.board-column[data-column="' + colId + '"]');
  if (el && (el as HTMLElement).scrollIntoView) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// Recomputes on resize (e.g. rotating a tablet, resizing the window)
// since the band's segment positions are measured in real pixels, not
// derived from a fixed formula — only while Board is actually the
// visible tab, to avoid needless work on every other view. A top-level
// call, run once when this module loads (see onPanelResize()'s own
// comment in src/utils/ui.ts).
onPanelResize('panel-board', renderBoardWorkflowStrip, 0);

// ===== BOARD: RENDER =====

// renderBoard() used to rebuild the ENTIRE column structure — every
// header, the ⋮ settings dropdown, the color grid, AND each column's own
// card container (col-body-<id>) — via one big wrapper.innerHTML string,
// unconditionally, on every single call. That's harmless for a manual
// full rebuild, but it's called from ~25 places across this file (and
// more elsewhere — calendar.ts, gantt.ts, job-form.ts, job-list.ts,
// app/project.ts) any time ANY card or job data changes, not just when a
// column itself changes. Two real costs: it's wasteful (rebuilding a
// dozen columns' worth of settings-menu markup just because one card
// moved), and it's the same "fresh container every render" trap fixed for
// Gantt's barsLayer (see gantt.ts's getOrCreateGanttGridLayers()) —
// col-body-<id> can't become Preact's to own (see buildCardEl()'s own
// comment) while it's destroyed and recreated on every card move.
//
// The column CHROME (header/dropdown/color-grid) is fully determined by
// BOARD_COLUMNS + WORKFLOW_ITEMS + the roster + the caller's own
// permission tier — never by boardCards (the card data). Stringifying all
// four catches every real change (a column added/removed/reordered/
// renamed/recolored, a workflow item renamed, the roster loading, a
// permission change) without having to hand-track which of the dozen
// individual column-settings mutator functions below might have touched
// something — missing one there would be a silent stale-chrome bug;
// missing a field here isn't possible, since ANY change anywhere in these
// four inputs changes the string.
interface BoardColumnDom {
  columnEl: HTMLElement;
  bodyEl: HTMLElement;
}
let cachedBoardChromeSignature: string | null = null;
let cachedBoardColumnDoms: Record<string, BoardColumnDom> = {};

function computeBoardChromeSignature(): string {
  return JSON.stringify([
    BOARD_COLUMNS,
    WORKFLOW_ITEMS,
    cachedUserRoster,
    hasMinTier('projectAdmin'),
  ]);
}

// Rebuilds the column chrome from scratch (today's old unconditional
// renderBoard() body, unchanged) and repopulates cachedBoardColumnDoms —
// only called when computeBoardChromeSignature() says something the
// chrome actually reads has changed, or on the very first render.
function rebuildBoardColumnChrome(wrapper: HTMLElement): void {
  // Any real chrome rebuild closes every open settings dropdown/color
  // panel, matching what the old innerHTML-wipe always did (nothing here
  // tracks "which one is open" as real data — see board-column-chrome.tsx's
  // own header comment on why that's fine to leave alone the rest of the
  // time: Preact only touches a prop whose declared value actually
  // changed between renders, so an unrelated column's own rebuild — or
  // this column's own rebuild from a change that doesn't explicitly close
  // it first, like changeColumnColor() below — would otherwise leave an
  // open dropdown's externally-added .show/.open class untouched).
  document.querySelectorAll('.board-col-settings-dropdown').forEach((d) => d.classList.remove('show'));
  document.querySelectorAll('.board-col-color-panel').forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('.board-col-color-toggle').forEach((t) => t.classList.remove('open'));

  const columnProps: BoardColumnChromeProps[] = BOARD_COLUMNS.map((col) => {
    const dark = col.color ? isDarkColor(col.color) : false;
    const colorSwatches: ColorSwatch[] = [
      { color: null, selected: !col.color, onClick: (e: MouseEvent) => changeColumnColor(col.id, '', e) },
      ...BOARD_COLOR_PRESETS.map((c) => ({ color: c, selected: col.color === c, onClick: (e: MouseEvent) => changeColumnColor(col.id, c, e) })),
    ];
    const workflowItemOptions: SelectOption[] = WORKFLOW_ITEMS.map((item) => ({ value: item.id, label: item.label, selected: item.id === col.workflowItemId }));
    const assigneeOptions: SelectOption[] = (cachedUserRoster || []).map((u) => ({ value: u.username, label: u.displayName, selected: u.username === col.checklistAssigneeOverride }));
    return {
      id: col.id,
      label: col.label,
      scheduleDisconnectedIcon: !!col.scheduleDisconnected,
      canManage: hasMinTier('projectAdmin'),
      // col.color is stored pre-softened now — the board column picker
      // (BOARD_COLOR_PRESETS) offers its own pastel palette directly,
      // rather than this rendering a runtime-transformed version of
      // whatever the job/task color picker offers. Rendered as-is; no
      // further transform here.
      headerStyle: col.color ? { background: col.color, color: columnLabelTextColor(col.color) } : {},
      // Trello-style: the title reads as a darker shade of the board's
      // own color rather than generic black text, when the background is
      // light enough for that to stay readable — see headerStyle above.
      // The ⋮ button gets its own lighter tint on a dark background so it
      // doesn't disappear.
      settingsBtnColor: col.color ? (dark ? 'rgba(255,255,255,0.7)' : undefined) : undefined,
      hideFromSchedule: !!col.hideFromSchedule,
      scheduleDisconnected: !!col.scheduleDisconnected,
      isFinishedTrigger: isFinishedColumn(col),
      workflowItemOptions,
      autoAssignChecklist: !!col.autoAssignChecklist,
      assigneeOptions,
      defaultDuration: col.defaultDuration || DEFAULT_TASK_DURATION_DAYS,
      stalledAfterDays: col.stalledAfterDays || DEFAULT_STALLED_AFTER_DAYS,
      colorSwatches,
      onToggleSettings: (e) => toggleColSettings(col.id, e),
      onToggleColorPanel: (e) => toggleColColorPanel(col.id, e),
      onToggleScheduleVisibility: (e) => toggleColumnScheduleVisibility(col.id, e),
      onToggleScheduleSync: (e) => toggleColumnScheduleSync(col.id, e),
      onToggleFinishedTrigger: (e) => toggleColumnFinishedTrigger(col.id, e),
      onSetWorkflowItem: (e) => setColumnWorkflowItem(col.id, (e.currentTarget as HTMLSelectElement).value, e),
      onToggleAutoAssignChecklist: (e) => toggleColumnAutoAssignChecklist(col.id, e),
      onSetChecklistAssignee: (e) => setColumnChecklistAssignee(col.id, (e.currentTarget as HTMLSelectElement).value, e),
      onSetDefaultDuration: (e) => setColumnDefaultDuration(col.id, (e.currentTarget as HTMLInputElement).value, e),
      onSetStalledThreshold: (e) => setColumnStalledThreshold(col.id, (e.currentTarget as HTMLInputElement).value, e),
      onManageChecklist: (e) => openManageColumnChecklist(col.id, e),
      onRename: (e) => renameBoardColumn(col.id, e),
      onDelete: (e) => deleteBoardColumn(col.id, e),
      // Stable named function references, matched by class/data-*
      // traversal inside each one (see their own definitions above) —
      // never DOM node identity — so passing them straight through as
      // JSX handlers works exactly like the old addEventListener wiring
      // did.
      onHeaderDragStart: handleColumnDragStart,
      onHeaderDragEnd: handleColumnDragEnd,
      onColumnDragOver: handleColumnReorderOver,
      onColumnDragLeave: handleColumnReorderLeave,
      onColumnDrop: handleColumnReorderDrop,
      onSwatchKeyDown: handleColorSwatchKeydown,
    };
  });

  const addColumnProps: AddColumnFormProps = {
    onShow: showAddColumnForm,
    onKeyDown: handleAddColumnKey,
    onSubmit: submitAddColumn,
    onCancel: hideAddColumnForm,
  };

  renderBoardColumnsChromeInto(wrapper, columnProps, addColumnProps);

  cachedBoardColumnDoms = {};
  BOARD_COLUMNS.forEach((col) => {
    const columnEl = wrapper.querySelector<HTMLElement>('.board-column[data-column="' + col.id + '"]');
    const bodyEl = document.getElementById('col-body-' + col.id);
    if (!columnEl || !bodyEl) return;
    cachedBoardColumnDoms[col.id] = { columnEl, bodyEl };
    // Attached once here, now that bodyEl is the SAME persistent element
    // across future renders (see this function's own header comment) —
    // handleColumnDragOver/Leave/handleColumnDrop are stable named
    // function references, so re-running this on the odd render that
    // DOES rebuild chrome again never double-attaches. This is the CARD
    // drop target (a card landing in this column) — a separate concern
    // from onColumnDragOver/Leave/Drop above, which is the COLUMN itself
    // being reordered.
    bodyEl.addEventListener('dragover', handleColumnDragOver);
    bodyEl.addEventListener('dragleave', handleColumnDragLeave);
    bodyEl.addEventListener('drop', handleColumnDrop);
  });
}

function renderBoard(): void {
  // Column placement is date-derived (or manually overridden) — resolve it
  // before reading card.column anywhere below (badge counts, DOM placement).
  syncCardColumns();
  const wrapper = document.getElementById('boardWrapper')!;

  const chromeSignature = computeBoardChromeSignature();
  // The `wrapper.contains()` half matches getOrCreateGanttGridLayers()'s
  // own defensive check — `boardWrapper` is a static element from
  // index.html, never actually reset out from under this cache today, but
  // the check is cheap and means a stale/detached cache heals itself
  // rather than silently rendering into nothing.
  if (chromeSignature !== cachedBoardChromeSignature ||
      !Object.keys(cachedBoardColumnDoms).length ||
      !wrapper.contains(Object.values(cachedBoardColumnDoms)[0]?.bodyEl)) {
    rebuildBoardColumnChrome(wrapper);
    cachedBoardChromeSignature = chromeSignature;
  }

  // Card population — Preact-rendered (see board-card.tsx), runs on EVERY
  // call independent of whether the chrome above needed rebuilding, since
  // this is what actually changes on the vast majority of renderBoard()
  // calls (a card moved/was edited/synced in). bodyEl is NEVER cleared
  // here (same rule as every other Preact-owned container) — it's now a
  // stable, persistent element across calls (see rebuildBoardColumnChrome()),
  // which is what lets Preact reuse a card's own DOM node across renders
  // instead of tearing down and recreating every card on every call.
  const stalledFloors = computeColumnStalledFloors();
  BOARD_COLUMNS.forEach((col) => {
    const dom = cachedBoardColumnDoms[col.id];
    if (!dom) return;
    const cardProps = boardCards
      .filter((c) => c.column === col.id && !isCardFromArchivedJob(c) && isCardVisibleToMe(c))
      .map((card) => buildCardProps(card, stalledFloors));
    renderBoardCardsInto(dom.bodyEl, cardProps);
  });

  document.getElementById('boardCount')!.textContent = String(boardCards.filter((c) => !isCardFromArchivedJob(c) && isCardVisibleToMe(c)).length);

  // renderBoard() rebuilds the ⋮ settings menu's data-min-tier="projectAdmin"
  // gating (via rebuildBoardColumnChrome(), when the chrome is actually
  // stale) — and is called directly from ~25 places across this file (card
  // drags, column drops, job/phase edits, etc.), not just from renderAll().
  // Relying on renderAll()'s own trailing applyPermissionGating() left
  // every one of those other call sites re-rendering the settings menu
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
  // cachedUserRoster is also part of computeBoardChromeSignature() above,
  // so the roster resolving triggers a real chrome rebuild too (the
  // auto-assign-checklist dropdown's own options read it).
  if (!cachedUserRoster) {
    ensureUserRosterLoaded().then(function () { renderBoard(); });
  }
}

// Still imperative, unchanged — this is home.ts's own
// renderHomeWorkflowExpandedBoard() reusing the pre-Preact card-building
// logic to append real card elements into ITS OWN plain innerHTML-rebuilt
// container (a totally separate concern from the real Board tab's
// col-body-<id>, which is now Preact's — see buildCardProps() below).
// Kept as its own separate function rather than unified with
// buildCardProps() (e.g. via a throwaway Preact root per call) to keep
// this piece scoped to the real Board tab; Home's own mini-board widget
// converting to Preact is its own separate, not-yet-investigated piece.
function buildCardEl(card: BoardCard, stalledFloors?: Record<string, number>): HTMLElement {
  const el = document.createElement('div');
  const hasOverride = !!(card.manualColumn && card.manualColumnUntil && Date.now() < card.manualColumnUntil);
  el.className = 'board-card' + (hasOverride ? ' manual-override' : '');
  el.draggable = hasMinTier('editor');
  el.dataset.id = card.id;
  el.style.borderLeftColor = card.color || 'var(--primary-light)';
  // Same de-chromed, job-colored title treatment as the real Board's
  // Preact card (see buildCardProps()'s own comment on titleColorLight/
  // Dark below) — custom properties inherit, so setting them here reaches
  // the child .board-card-title div's `color: var(--bct-light, ...)` rule
  // without needing to find that div separately.
  const cardTitleColor = card.color || '#3949ab';
  el.style.setProperty('--bct-light', tintedTextColor(cardTitleColor, '#ffffff', 6));
  el.style.setProperty('--bct-dark', tintedTextColor(cardTitleColor, '#242732', 6));
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
  // sitting in Complete isn't "stalled," it's just parked. thresholdDays
  // comes from computeColumnStalledFloors() (see home.ts) when the caller
  // passed it — the admin-configured floor raised to this column's own
  // current median dwell time, so a column where long dwell is simply
  // normal doesn't badge nearly every card in it. Falls back to the
  // plain configured floor if no floors map was passed in.
  if (card.columnEnteredAt && !isFinishedColumnId(card.column)) {
    const col = BOARD_COLUMNS.find((c) => c.id === card.column);
    const configuredThresholdDays = (col && col.stalledAfterDays) || DEFAULT_STALLED_AFTER_DAYS;
    const thresholdDays = (stalledFloors && stalledFloors[card.column]) || configuredThresholdDays;
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
  // Opening the edit modal is the primary interaction and needs a
  // keyboard path independent of the drag gesture (dragging itself stays
  // mouse/touch-only — the mobile "Move to" <select> above is the
  // existing keyboard-reachable way to change a card's column).
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', 'Open ' + (card.title || 'card'));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditCard(card.id); }
  });
  return el;
}

// Preact-rendered replacement for buildCardEl(), used by the real Board
// tab's col-body-<id> (see renderBoard() above) now that it's a stable,
// persistent container Preact can diff against across renders — see
// board-card.tsx's own header comment for why that's safe even with
// native HTML5 drag-and-drop.
function buildCardProps(card: BoardCard, stalledFloors?: Record<string, number>): BoardCardProps {
  const hasOverride = !!(card.manualColumn && card.manualColumnUntil && Date.now() < card.manualColumnUntil);
  const overrideTitle = hasOverride
    ? 'Manually placed — auto-sync resumes at ' + new Date(card.manualColumnUntil!).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

  let dueBadge: CardDueBadge | null = null;
  if (card.due) {
    const isOverdue = !isFinishedColumnId(card.column) && new Date(card.due + 'T00:00:00') < new Date(new Date().toDateString());
    const dueLabel = new Date(card.due + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    dueBadge = { overdue: isOverdue, label: dueLabel };
  }

  // Time-in-stage, not a due date — see buildHomeStalledRows() for the
  // matching Home widget. Skipped on a finished-trigger column for the
  // same reason the overdue badge above is: a job that's already done
  // sitting in Complete isn't "stalled," it's just parked. thresholdDays
  // comes from computeColumnStalledFloors() (see home.ts) when the caller
  // passed it — the admin-configured floor raised to this column's own
  // current median dwell time, so a column where long dwell is simply
  // normal doesn't badge nearly every card in it. Falls back to the
  // plain configured floor if no floors map was passed in.
  let stalledBadge: CardStalledBadge | null = null;
  if (card.columnEnteredAt && !isFinishedColumnId(card.column)) {
    const col = BOARD_COLUMNS.find((c) => c.id === card.column);
    const configuredThresholdDays = (col && col.stalledAfterDays) || DEFAULT_STALLED_AFTER_DAYS;
    const thresholdDays = (stalledFloors && stalledFloors[card.column]) || configuredThresholdDays;
    const daysInStage = Math.floor((Date.now() - card.columnEnteredAt) / 86400000);
    if (daysInStage >= thresholdDays) {
      stalledBadge = { title: daysInStage + ' days in this board', label: daysInStage + 'd stalled' };
    }
  }

  // Plain "Label: value" text rows (Trello-style) instead of icon
  // pills/badges — driven straight off CUSTOM_FIELD_DEFS so a field's
  // label here always matches its label in the Team/Custom Fields forms.
  // 'members' is skipped (would be a long name list, not a fit for a
  // single line on the card face).
  const cf = card.customFields || {};
  const metaLines: CardMetaLine[] = [];
  CUSTOM_FIELD_DEFS.forEach((def) => {
    if (def.key === 'members') return;
    let val = cf[def.key] as string;
    if (!val) return;
    if (def.type === 'user-select') val = displayNameForUsername(val);
    metaLines.push({ label: def.label, value: val });
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
  let checklistBadge: CardChecklistBadge | null = null;
  if (allDoneFlags.length) {
    const doneCount = allDoneFlags.filter(Boolean).length;
    checklistBadge = { complete: doneCount === allDoneFlags.length, label: doneCount + '/' + allDoneFlags.length };
  }

  const attachments = card.attachments || [];

  // Same de-chromed treatment as the Gantt's own job-name labels (see
  // rowLabelColors() in gantt.ts) — plain text in the job's own
  // (contrast-adjusted) color instead of a flat var(--text), so a card
  // reads as "this job" at a glance the same way its Gantt row/bar do.
  // Reference backgrounds are this card's own actual background in each
  // theme (--card light, and the lightened dark-mode .board-card tone —
  // see body.dark-mode .board-card in index.html) rather than a generic
  // approximation, since a board card (unlike the Gantt panel) is a flat,
  // non-translucent fill.
  const titleColor = card.color || '#3949ab';
  const titleColorLight = tintedTextColor(titleColor, '#ffffff', 6);
  const titleColorDark = tintedTextColor(titleColor, '#242732', 6);

  return {
    id: String(card.id),
    manualOverride: hasOverride,
    draggable: hasMinTier('editor'),
    borderLeftColor: card.color || 'var(--primary-light)',
    titleColorLight,
    titleColorDark,
    title: hasOverride ? overrideTitle : undefined,
    overrideBadge: hasOverride ? { title: overrideTitle + '. Click to reconnect now.', onClick: () => reconnectCard(card.id) } : null,
    cardTitle: card.title || '',
    metaLines,
    dueBadge,
    stalledBadge,
    checklistBadge,
    attachmentsLabel: attachments.length ? String(attachments.length) : null,
    moveSelectOptions: BOARD_COLUMNS.map((col) => ({ id: col.id, label: col.label })),
    moveSelectValue: card.column,
    onMoveChange: (newColumnId: string) => moveCardToColumn(card.id, newColumnId),
    onOpen: () => openEditCard(card.id),
    // Opening the edit modal is the primary interaction and has its own
    // keyboard path independent of the drag gesture (dragging itself
    // stays mouse/touch-only — the mobile "Move to" <select> is the
    // existing keyboard-reachable way to change a card's column) — see
    // BoardCard's own onKeyDown in board-card.tsx.
    onDragStart: handleCardDragStart,
    onDragEnd: handleCardDragEnd,
    ariaLabel: 'Open ' + (card.title || 'card'),
  };
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
    if (isPanelActive('gantt')) renderGantt();
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
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
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

// See runColumnEntryActions() (src/core/jobs.ts) for what this actually does
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

// ===== BOARD: CUSTOM FIELDS =====
// One shared per-field renderer for both grids (Team + Custom Fields) and
// both surfaces (card modal here + Job Manager's own renderJobCustomFieldsGrid()/
// renderJobTeamFieldsGrid()/collectJobCustomFieldValues() in
// src/views/job-form.ts, which mirror this file's own three below, reading/
// writing the same card.customFields).
// `onNeedsRoster` is called once the user-select/multiselect branches need
// to lazy-load cachedUserRoster and re-render themselves; each caller
// passes its own "re-render me with my current values" closure.
function renderFieldDefHtml(def: CustomFieldDef, val: unknown, onNeedsRoster: () => void, idPrefix: string): string {
  if (def.type === 'select') {
    const opts = fieldOptions[def.key] || [];
    const optionsHtml = '<option value="">Select...</option>' + opts.map((o) =>
      '<option value="' + escapeHtml(o) + '"' + (o === val ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'
    ).join('');
    return '<div class="cf-field"><label>' + escapeHtml(def.label) + '</label><select data-field="' + def.key + '" data-min-tier="editor">' + optionsHtml + '</select></div>';
  }
  if (def.type === 'user-select') {
    // Real-account single-select (PM/Foreman) — same roster source as
    // Members' multiselect just below, but narrowed to Lead-classified
    // accounts only via getLeadRoster() (see Manage Users' Classification
    // field).
    if (!cachedUserRoster) {
      ensureUserRosterLoaded().then(onNeedsRoster);
      return '<div class="cf-field"><label>' + escapeHtml(def.label) + '</label><select disabled><option>Loading…</option></select></div>';
    }
    const optionsHtml = '<option value="">Select...</option>' + getLeadRoster(val as string).map(function (u) {
      return '<option value="' + escapeHtml(u.username) + '"' + (u.username === val ? ' selected' : '') + '>' + escapeHtml(u.displayName) + '</option>';
    }).join('');
    return '<div class="cf-field"><label>' + escapeHtml(def.label) + '</label><select data-field="' + def.key + '" data-min-tier="editor">' + optionsHtml + '</select></div>';
  }
  if (def.type === 'multiselect') {
    // Backed by the REAL account roster (same one the "Visible to"
    // checklist-stage picker uses — see ensureUserRosterLoaded()), not a
    // free-text fieldOptions pool like a 'select' field — a Member has to
    // be a real, matchable account for isJobVisibleToMe() to work.
    // Checkbox value = username (what gets stored/matched), label =
    // displayName. Lazy-loaded once per session; re-renders this same grid
    // once it resolves. Collapsed behind a toggle button + Select
    // All/Unselect All instead of listing every account inline —
    // dropdownId needs to be unique per grid (card modal's teamFieldsGrid
    // vs Job Manager's jmTeamFieldsGrid can both be in the DOM/rendered
    // independently), hence idPrefix.
    const selected = Array.isArray(val) ? (val as string[]) : [];
    if (!cachedUserRoster) {
      ensureUserRosterLoaded().then(onNeedsRoster);
      return '<div class="cf-field cf-field-wide"><label>' + escapeHtml(def.label) + '</label><div class="cf-multiselect-loading">Loading team roster…</div></div>';
    }
    const dropdownId = (idPrefix || '') + 'MsDropdown_' + def.key;
    const optionsId = dropdownId + '_options';
    const optionsHtml = cachedUserRoster.length
      ? cachedUserRoster.map((u) => '<label class="cf-multiselect-option"><input type="checkbox" data-field="' + def.key + '" value="' + escapeHtml(u.username) + '" data-min-tier="editor"' + (selected.indexOf(u.username) !== -1 ? ' checked' : '') + '> ' + escapeHtml(u.displayName) + '</label>').join('')
      : '<span class="cf-multiselect-empty">No team accounts yet</span>';
    return '<div class="cf-field cf-field-wide"><label>' + escapeHtml(def.label) + '</label>' +
      '<div class="ms-dropdown" id="' + dropdownId + '">' +
        '<button type="button" class="ms-dropdown-toggle" onclick="toggleMsDropdown(\'' + dropdownId + '\')"><span>' + msDropdownLabelText(selected.length) + '</span><span class="ms-dropdown-arrow">▾</span></button>' +
        '<div class="ms-dropdown-panel">' +
          (cachedUserRoster.length ? '<div class="ms-dropdown-actions"><button type="button" data-min-tier="editor" onclick="msSetAll(\'' + optionsId + '\', true)">Select All</button><button type="button" data-min-tier="editor" onclick="msSetAll(\'' + optionsId + '\', false)">Unselect All</button></div>' : '') +
          '<div class="cf-multiselect" id="' + optionsId + '">' + optionsHtml + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  return '<div class="cf-field"><label>' + escapeHtml(def.label) + '</label><input type="text" data-field="' + def.key + '" data-min-tier="editor" value="' + escapeHtml(val as string) + '" placeholder="Add ' + escapeHtml(def.label) + '..."></div>';
}

function renderCustomFieldsGrid(values: Record<string, unknown>): void {
  values = values || {};
  const grid = document.getElementById('customFieldsGrid')!;
  const defs = CUSTOM_FIELD_DEFS.filter((d) => TEAM_FIELD_KEYS.indexOf(d.key) === -1);
  grid.innerHTML = defs.map((def) => renderFieldDefHtml(def, values[def.key] || '', function () { renderCustomFieldsGrid(collectCustomFieldValues()); }, '')).join('');
  applyPermissionGating(); // rebuilt on every card-modal open, outside renderAll()'s own sweep
}

// Project Manager / Project Lead-Foreman / Members — split out of Custom
// Fields into their own "Team" section (still CUSTOM_FIELD_DEFS entries,
// still stored under the same card.customFields keys — see
// TEAM_FIELD_KEYS). collectCustomFieldValues() reads [data-field] from
// BOTH grids, so either one re-rendering after a lazy roster load still
// collects the other grid's current values correctly.
function renderTeamFieldsGrid(values: Record<string, unknown>): void {
  values = values || {};
  const grid = document.getElementById('teamFieldsGrid');
  if (!grid) return;
  const defs = CUSTOM_FIELD_DEFS.filter((d) => TEAM_FIELD_KEYS.indexOf(d.key) !== -1);
  grid.innerHTML = defs.map((def) => renderFieldDefHtml(def, values[def.key] || '', function () { renderTeamFieldsGrid(collectCustomFieldValues()); }, '')).join('');
  applyPermissionGating();
}

function collectCustomFieldValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  document.querySelectorAll('#customFieldsGrid [data-field], #teamFieldsGrid [data-field]').forEach((el) => {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox') {
      if (!values[input.dataset.field!]) values[input.dataset.field!] = [];
      if (input.checked) (values[input.dataset.field!] as string[]).push(input.value);
    } else {
      values[input.dataset.field!] = input.value.trim();
    }
  });
  return values;
}

// ===== BOARD: ATTACHMENTS (R2, via the Worker) =====
// Files upload to R2 (attachments/<uuid>.<ext>) instead of being embedded
// as inline base64 — a single job/card object staying small regardless of
// how many photos/PDFs get attached to it matters a lot now that the whole
// project gets pushed/broadcast as one message on every routine save (see
// pushProjectToShared() in sync/outbound.ts). Existing attachments from
// before this migration still carry `dataUrl` instead of `key` —
// attachmentSrc() below renders either shape so nothing already attached
// silently breaks.
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB — was 3MB when attachments lived inline in localStorage; R2 has no such pressure

interface Attachment {
  id: number;
  name: string;
  size: number;
  isImage?: boolean;
  key?: string;
  dataUrl?: string;
}

// Synchronous, so it can be dropped straight into a rendered href/src
// attribute — reads whatever session token is already cached rather than
// minting/refreshing one (that needs a network round-trip, which a
// synchronous render can't wait on). By the time attachments are being
// rendered at all, a valid token is essentially always already cached from
// login/the room connection; a missing or expired one just makes the
// resulting link 401 when clicked, same failure mode as a stale link would
// show anyway.
function attachmentDownloadUrl(key: string): string {
  const token = getStoredSessionToken();
  return API_BASE_URL + 'attachments/download?token=' + encodeURIComponent(token || '') + '&key=' + encodeURIComponent(key);
}
function attachmentSrc(att: Attachment): string {
  return att.key ? attachmentDownloadUrl(att.key) : (att.dataUrl || '');
}

async function uploadAttachmentFile(file: File): Promise<{ key: string; name: string }> {
  // Token as a header, not a query param — this request's body IS the raw
  // file, so there's no JSON body to put it in the way every other POST
  // endpoint does (matches the Worker's handleAttachmentUpload()).
  const url = API_BASE_URL + 'attachments/upload?name=' + encodeURIComponent(file.name) +
    '&type=' + encodeURIComponent(file.type || 'application/octet-stream');
  const res = await fetchWithReauth(url, function (token) {
    return { method: 'POST', headers: { 'X-Aps-Token': token }, body: file };
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status);
  return res.json(); // { key, name }
}

// Best-effort, fire-and-forget — a failed cleanup leaves an orphaned R2
// object (harmless, just unused storage) rather than blocking the user's
// actual intent (removing the attachment from the job/card). Uses
// whatever token is already cached, same reasoning as attachmentDownloadUrl()
// above — not worth minting a fresh one for a call this disposable.
function deleteAttachmentFile(key: string): void {
  if (!key) return;
  const token = getStoredSessionToken();
  fetch(API_BASE_URL + 'attachments/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, key: key }),
  }).catch(function (err) { console.error('Failed to delete attachment file ' + key, err); });
}

interface AttachmentPanelConfig {
  draftArrayGetter: () => Attachment[];
  draftArraySetter: (arr: Attachment[]) => void;
  containerId: string;
  removeHandlerName: string;
  flushFn: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Shared behind Job Manager's and the card modal's attachment panels
// (previously renderJobAttachments()/renderAttachments(),
// handleJobAttachmentUpload()/handleAttachmentUpload(),
// removeJobAttachment()/removeAttachment() — near-full duplicates of each
// other, confirmed already drifted once). config shape: {draftArrayGetter,
// draftArraySetter, containerId, removeHandlerName, flushFn} — the
// getter/setter pair exists because each caller's draft array is
// reassigned (filtered), not just mutated in place, so a plain reference
// wouldn't see removals. removeHandlerName is the caller's own
// thin-wrapper function name (e.g. "removeJobAttachment"), embedded
// literally in the rendered onclick= so each panel's remove button keeps
// calling its own stable global name rather than this shared one plus a
// config object.
function renderAttachmentPanel(config: AttachmentPanelConfig): void {
  const container = document.getElementById(config.containerId);
  if (!container) return;
  const items = config.draftArrayGetter();
  if (!items.length) {
    container.innerHTML = '<p style="font-size: var(--t-xs);color:#999;">No attachments yet.</p>';
    return;
  }
  container.innerHTML = items.map((att) => {
    const src = attachmentSrc(att);
    const thumb = att.isImage
      ? '<img class="att-thumb" src="' + src + '">'
      : '<div class="att-icon"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" fill="#e8eaf6" stroke="#3949ab" stroke-width="1.5"/><circle cx="8" cy="9" r="1.8" fill="#f0ad4e"/><path d="M4 18l5-6 4 4 3-3 5 5" stroke="#3949ab" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
    return '<div class="attachment-item">' +
      '<a href="' + src + '" download="' + escapeHtml(att.name) + '" target="_blank" style="display:flex;align-items:center;gap: var(--s-2-5);flex:1;min-width:0;text-decoration:none;">' +
      thumb +
      '<div class="att-info"><span class="att-name">' + escapeHtml(att.name) + '</span><span class="att-size">' + formatFileSize(att.size) + '</span></div>' +
      '</a>' +
      '<button class="att-remove" data-min-tier="editor" onclick="' + config.removeHandlerName + '(' + att.id + ')">×</button>' +
      '</div>';
  }).join('');
  applyPermissionGating(); // rebuilt on every attachment change, outside renderAll()'s own sweep
}

function handleAttachmentPanelUpload(e: Event, config: AttachmentPanelConfig): void {
  const files = Array.from((e.target as HTMLInputElement).files || []);
  files.forEach(function (file) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      showToast('"' + file.name + '" is too large (max 25MB)', 'error');
      return;
    }
    const localId = Date.now() + Math.random();
    uploadAttachmentFile(file).then(function (result) {
      config.draftArrayGetter().push({
        id: localId,
        name: file.name,
        size: file.size,
        // Matches the Worker's own isSafeInlineImageType() — svg+xml is
        // excluded because it's now always force-downloaded server-side
        // (can carry embedded scripts), so treating it as isImage here
        // would just render as a broken thumbnail.
        isImage: file.type.startsWith('image/') && file.type !== 'image/svg+xml',
        key: result.key,
      });
      renderAttachmentPanel(config);
      config.flushFn();
    }).catch(function (err) {
      console.error('Attachment upload failed', err);
      showToast('"' + file.name + '" failed to upload — ' + err.message, 'error');
    });
  });
  (e.target as HTMLInputElement).value = '';
}

function removeAttachmentPanelItem(id: number, config: AttachmentPanelConfig): void {
  const items = config.draftArrayGetter();
  const att = items.find(function (a) { return a.id === id; });
  if (att && att.key) deleteAttachmentFile(att.key);
  config.draftArraySetter(items.filter((a) => a.id !== id));
  renderAttachmentPanel(config);
  config.flushFn();
}

const CARD_ATTACHMENT_PANEL_CONFIG: AttachmentPanelConfig = {
  draftArrayGetter: function () { return draftAttachments as Attachment[]; },
  draftArraySetter: function (arr) { draftAttachments = arr; },
  containerId: 'attachmentItems',
  removeHandlerName: 'removeAttachment',
  flushFn: flushCardAutosave,
};
function renderAttachments(): void { renderAttachmentPanel(CARD_ATTACHMENT_PANEL_CONFIG); }
function handleAttachmentUpload(e: Event): void { handleAttachmentPanelUpload(e, CARD_ATTACHMENT_PANEL_CONFIG); }
function removeAttachment(id: number): void { removeAttachmentPanelItem(id, CARD_ATTACHMENT_PANEL_CONFIG); }

// ===== MANAGE CUSTOM FIELD OPTIONS =====
function openManageFields(): void {
  renderManageFieldsBody();
  openModal('manageFieldsModal');
}

function closeManageFields(): void {
  closeModal('manageFieldsModal', function () {
    saveFieldOptions();
    // Both the card modal and Job Manager can have this open behind it —
    // refresh whichever grid(s) actually exist right now, so a newly
    // added/removed option (Job Type, Timeframe, etc.) shows up in an open
    // field's dropdown immediately instead of only after reopening.
    if (document.getElementById('customFieldsGrid')) renderCustomFieldsGrid(collectCustomFieldValues());
    if (document.getElementById('teamFieldsGrid')) renderTeamFieldsGrid(collectCustomFieldValues());
    if (document.getElementById('jmCustomFieldsGrid')) renderJobCustomFieldsGrid(collectJobCustomFieldValues());
    if (document.getElementById('jmTeamFieldsGrid')) renderJobTeamFieldsGrid(collectJobCustomFieldValues());
  });
}

function renderManageFieldsBody(): void {
  const container = document.getElementById('manageFieldsBody')!;
  // 'multiselect' (Members) is deliberately excluded — it's backed by the
  // real account roster (see renderCustomFieldsGrid()), not a free-text
  // fieldOptions pool, so there's nothing here to add/remove; who's
  // addable is managed via Manage Users instead.
  const selectDefs = CUSTOM_FIELD_DEFS.filter((d) => d.type === 'select');
  const groups = selectDefs.map((def) => buildManageFieldGroup(def.key, def.label));
  container.innerHTML = groups.join('');
}

function buildManageFieldGroup(key: string, label: string): string {
  const opts = fieldOptions[key] || [];
  const chips = opts.map((o) => '<span class="manage-field-chip">' + escapeHtml(o) +
    '<button onclick="removeFieldOption(\'' + key + '\', \'' + o.replace(/'/g, "\\'") + '\')">×</button></span>').join('');
  return '<div class="manage-field-group">' +
    '<h5>' + escapeHtml(label) + '</h5>' +
    '<div class="manage-field-chips">' + (chips || '<span style="font-size: var(--t-xs);color:#999;">No options yet</span>') + '</div>' +
    '<div class="manage-field-add-row">' +
    '<input type="text" id="mf_new_' + key + '" placeholder="Add option..." onkeydown="if(event.key===\'Enter\'){event.preventDefault();addFieldOption(\'' + key + '\');}">' +
    '<button class="btn btn-secondary" onclick="addFieldOption(\'' + key + '\')">Add</button>' +
    '</div></div>';
}

function addFieldOption(key: string): void {
  const input = document.getElementById('mf_new_' + key) as HTMLInputElement;
  const val = input.value.trim();
  if (!val) return;
  if (!fieldOptions[key]) fieldOptions[key] = [];
  if (!fieldOptions[key].includes(val)) fieldOptions[key].push(val);
  input.value = '';
  renderManageFieldsBody();
}

function removeFieldOption(key: string, val: string): void {
  fieldOptions[key] = (fieldOptions[key] || []).filter((o) => o !== val);
  renderManageFieldsBody();
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
  slugifyColumnId,
  addBoardColumn,
  showAddColumnForm,
  hideAddColumnForm,
  handleAddColumnKey,
  submitAddColumn,
  deleteBoardColumn,
  renameBoardColumn,
  buildWorkflowStageData,
  renderBoardWorkflowStrip,
  scrollToBoardColumn,
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
  renderFieldDefHtml,
  renderCustomFieldsGrid,
  renderTeamFieldsGrid,
  collectCustomFieldValues,
  MAX_ATTACHMENT_SIZE,
  attachmentDownloadUrl,
  attachmentSrc,
  uploadAttachmentFile,
  deleteAttachmentFile,
  formatFileSize,
  renderAttachmentPanel,
  handleAttachmentPanelUpload,
  removeAttachmentPanelItem,
  renderAttachments,
  handleAttachmentUpload,
  removeAttachment,
  openManageFields,
  closeManageFields,
  renderManageFieldsBody,
  buildManageFieldGroup,
  addFieldOption,
  removeFieldOption,
};
