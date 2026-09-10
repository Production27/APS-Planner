// Checklist system, moved out of index.html starting here. Unlike Board/
// Calendar/Gantt, this was deliberately NOT part of any of those views'
// own extraction phases — it's cross-cutting (Board's card-move gate,
// its own dedicated "Checklist" tab/rail-tab, a per-column "Manage
// Column Checklist" modal, and small Home-dashboard widgets all read/
// write the same per-card checklist data) — see src/views/board.ts's own
// Phase 4e note for the original deferral. Phased the same
// narrowest/lowest-risk-first way as every other multi-phase extraction
// this project has done, surveyed and agreed with Karl before starting:
//
//   Phase CL-a — core primitives: ensureCardChecklists/
//     normalizeChecklistAssignees/isChecklistStageVisibleToMe. Pure
//     data-shape helpers with no rendering and minimal mutation (a
//     one-time legacy-data migration) — the same "smallest/safest
//     first" logic used to open every other multi-phase extraction this
//     session. src/views/board.ts already declared ambient
//     ```declare function``` signatures for all three (written when
//     board.ts itself was extracted, calling into these while they were
//     still untyped index.html functions) — this file's real
//     implementations match those exactly, same "must be structurally
//     identical" discipline as every prior cross-file ambient this
//     project has hit.
//   Phase CL-b (this addition) — Board's card-move gate:
//     getOpenChecklistItemsForCard/confirmChecklistBeforeMove. Reuses
//     board.ts's own already-reserved ambient signature for
//     confirmChecklistBeforeMove() exactly.
import type { BoardCard, BoardColumn, ChecklistItem, ChecklistSubItem } from '../core/types';

declare global {
  // Shared verbatim with src/views/calendar.ts's identical ambient
  // declarations for these same globals.
  // eslint-disable-next-line no-var
  var viewAsUsername: string | null;
  function getEffectiveRole(): string;
  function getStoredUsername(): string;
  // Shared verbatim with src/views/board.ts's identical ambient
  // declaration for this same global.
  // eslint-disable-next-line no-var
  var BOARD_COLUMNS: BoardColumn[];
}

// card.checklists (one array per board-column stage, keyed by column id)
// replaced a single flat card.checklist array — see BOARD_COLUMNS'
// defaultChecklist and getChecklistForStageInProject() (the My Checklist
// tab, a later phase). Whatever legacy items existed land in the card's
// CURRENT column, since that's the best guess for which stage they
// belonged to. Mirrors the job.comments/job.notes migration pattern
// elsewhere in index.html. Idempotent and cheap (one property check) —
// call defensively anywhere card.checklists gets read or written.
function ensureCardChecklists(card: BoardCard): void {
  if (!card || card.checklists) return;
  card.checklists = {};
  const legacy = (card as { checklist?: ChecklistItem[] }).checklist;
  if (Array.isArray(legacy) && legacy.length) {
    card.checklists[card.column] = legacy;
  }
  delete (card as { checklist?: ChecklistItem[] }).checklist;
}

// ===== CHECKLIST STAGE VISIBILITY (whole-checklist-per-stage assignment) =====
// A board-column stage's whole checklist can optionally be restricted to
// one or more real user accounts (see setMyChecklistStageAssignee(), a
// later phase's "My Checklist" tab) — everyone else, except admins,
// doesn't see that stage's checklist at all. This mirrors
// card.checklists' shape: card.checklistAssignees is a plain
// { [columnId]: username[] } map; an absent/empty array means "everyone
// can see it" (unchanged from before this existed — was originally a
// single username string, now an array so a stage can be shared by more
// than one person; normalizeChecklistAssignees() below coerces any
// still-stored legacy single-string values). This is a display-only
// filter, not real access control — the Durable Object still syncs the
// full card to every connected client, same trust model as the rest of
// this app (e.g. currentUserRole is likewise "UI convenience only").
function normalizeChecklistAssignees(assignedTo: unknown): string[] {
  if (Array.isArray(assignedTo)) return assignedTo as string[];
  return assignedTo ? [assignedTo as string] : [];
}
function isChecklistStageVisibleToMe(assigneesMap: Record<string, unknown> | undefined, columnId: string): boolean {
  const assignedTo = normalizeChecklistAssignees((assigneesMap || {})[columnId]);
  if (!assignedTo.length) return true;
  // While previewing (viewAsUsername set), the bypass reflects the
  // SIMULATED account's own role, not the real admin's — see hasMinTier()
  // and index.html's "View as" section for the fuller rationale.
  const effectiveRole = getEffectiveRole();
  if (effectiveRole === 'admin') return true;
  const asUsername = viewAsUsername || getStoredUsername();
  return assignedTo.indexOf(asUsername) !== -1;
}

// Open (not-done) checklist items on a card's CURRENT stage, respecting
// per-stage visibility the same way buildCardEl()'s progress badge does —
// feeds confirmChecklistBeforeMove() below, used by both drag-and-drop
// (handleColumnDrop) and the mobile column <select> (moveCardToColumn) to
// warn before a card leaves a stage with unfinished items still on it. A
// checklist that's easy to ignore on a separate tab doesn't get used;
// tying it to the actual moment the job moves on is what makes it a real
// pause point instead of a suggestion.
function getOpenChecklistItemsForCard(card: BoardCard): string[] {
  ensureCardChecklists(card);
  if (!isChecklistStageVisibleToMe(card.checklistAssignees, card.column)) return [];
  const stageCol = BOARD_COLUMNS.find(function (c) { return c.id === card.column; });
  const templ = (stageCol && stageCol.defaultChecklist) || [];
  const stored = (card.checklists && card.checklists[card.column]) || [];
  const storedIds = stored.map(function (i) { return i.id; });
  const checklist: ChecklistItem[] = stored.filter(function (i) { return !i.removed; }).concat(
    templ.filter(function (d) { return storedIds.indexOf(d.id) === -1; }).map(function (d): ChecklistItem { return { id: d.id, text: d.text, done: false, assignee: '' }; })
  );
  // Once any item on this stage has been flagged required (the "killer
  // item" set — see toggleMyChecklistItemRequired(), a later phase),
  // only THOSE gate a move; a stage nobody's triaged yet still gates on
  // everything so this never silently goes quiet just because required
  // flags haven't been set up.
  const hasRequired = checklist.some(function (i) { return i.required; });
  const gating = hasRequired ? checklist.filter(function (i) { return i.required; }) : checklist;
  const open: string[] = [];
  gating.forEach(function (item) {
    if (!item.done) open.push(item.text);
    (item.subItems || []).forEach(function (sub: ChecklistSubItem) {
      if (!sub.done) open.push(item.text + ' → ' + sub.text);
    });
  });
  return open;
}

// Soft gate, not a hard block — a confirm dialog naming what's still open
// so leaving a stage with unfinished items is a deliberate choice, not an
// invisible default. Returns true (nothing to confirm, or user accepted).
function confirmChecklistBeforeMove(card: BoardCard): boolean {
  const open = getOpenChecklistItemsForCard(card);
  if (!open.length) return true;
  const preview = open.slice(0, 5).map(function (t) { return '- ' + t; }).join('\n');
  const more = open.length > 5 ? '\n...and ' + (open.length - 5) + ' more' : '';
  return window.confirm('"' + card.title + '" still has ' + open.length + ' open checklist item' + (open.length === 1 ? '' : 's') + ' on this stage:\n\n' + preview + more + '\n\nMove it anyway?');
}

export {
  ensureCardChecklists,
  normalizeChecklistAssignees,
  isChecklistStageVisibleToMe,
  getOpenChecklistItemsForCard,
  confirmChecklistBeforeMove,
};
