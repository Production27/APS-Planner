// The job/phase/card data model: schema-lock (normalizeTasksToColumns/
// ensureJobTasksMatchColumns/dedupeTaskIdsAcrossPhases), phase/sub-phase
// split/add/remove/un-split, ensureJobHasCards()/migrateOrphanedCards(),
// the auto-derive-column-from-dates logic (deriveColumnForTasks/
// setCardColumn/runColumnEntryActions/syncCardColumns), and job
// visibility/finished-status. This is the first slice of Phase 10 of the
// extraction plan ("Project management & the shared job/phase data
// model") — the rest (switchProject/loadActiveProjectData/renderAll/
// applyPermissionGating, the project bootstrap, and the linked-job data
// model) stays in index.html for a later slice of the same phase.
//
// Two real, already-fixed production bugs live in this exact file (moved
// verbatim from index.html, comments intact): dedupeTaskIdsAcrossPhases()
// fixes a task-id collision bug (dragging one phase's bar visibly moved
// another phase's), and deriveColumnForTasks()'s priority-order comment
// documents a real bug report (a manual drag was losing to whichever
// board happened to be "active today" elsewhere on the same job).
// Regression tests were written locking in today's exact behavior for
// both before this code moved — see tests/unit-jobs-model.spec.js.
import type { Job, Phase, SubPhase, Task, BoardCard, BoardColumn } from './types';
import { getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from './models';
import { genId } from '../utils/id';
import { getStoredUsername } from '../auth/session';
import { hasMinTier } from '../auth/permissions';
import { deleteCardFromShared, recordTombstone, logActivity } from '../sync/outbound';
import { getChecklistForStageInProject } from '../views/checklist';

// ===== Section 1: Schema Lock — normalize tasks to the current board columns =====
export function normalizeTasksToColumns(tasks: Task[] | undefined, fallbackColor: string | undefined): Task[] {
  tasks = tasks || [];
  const colCount = BOARD_COLUMNS.length;
  if (colCount === 0) return tasks;

  const newTasks: Task[] = [];
  const usedExisting = new Set<number>();

  BOARD_COLUMNS.forEach(function (col: BoardColumn, i: number) {
    const colName = col.label;
    let existingIdx = -1;
    // Match by the column's stable id first — immune to the column being
    // renamed (renameBoardColumn()) after the task was created. Only tasks
    // that predate columnId existing (never yet matched by id) fall back
    // to matching by name; that fallback also backfills columnId onto them
    // below, so it's a one-time migration rather than an ongoing behavior.
    // Without the id match, renaming a column would make every job's task
    // for it fail to match by name, silently demoting real start/finish
    // dates to a text note (see the "unmatched" handling below) the next
    // time this runs — which is on essentially every save/load.
    for (let j = 0; j < tasks!.length; j++) {
      if (usedExisting.has(j)) continue;
      if (tasks![j].columnId === col.id) { existingIdx = j; break; }
    }
    if (existingIdx === -1) {
      for (let j = 0; j < tasks!.length; j++) {
        if (usedExisting.has(j)) continue;
        if (!tasks![j].columnId && (tasks![j].name || '').toLowerCase() === colName.toLowerCase()) {
          existingIdx = j;
          break;
        }
      }
    }

    const rowColor = col.color || fallbackColor || '#3949ab';

    if (existingIdx !== -1) {
      usedExisting.add(existingIdx);
      const t = tasks![existingIdx];
      t.name = colName;
      t.columnId = col.id;
      t.order = i;
      t.color = rowColor; // task color always mirrors its board column
      newTasks.push(t);
    } else {
      newTasks.push({
        id: genId(),
        name: colName,
        columnId: col.id,
        start: '',
        finish: '',
        notes: '',
        color: rowColor,
        order: i,
      });
    }
  });

  const unmatched: Task[] = [];
  for (let j = 0; j < tasks.length; j++) {
    if (!usedExisting.has(j)) unmatched.push(tasks[j]);
  }
  if (unmatched.length > 0) {
    const legacyNote = unmatched.map(function (t) {
      return (t.name || 'Untitled') + (t.start ? ' (' + t.start + '–' + t.finish + ')' : '') + (t.notes ? ': ' + t.notes : '');
    }).join('; ');
    if (newTasks.length > 0) {
      newTasks[0].notes = (newTasks[0].notes ? newTasks[0].notes + '\n\n' : '') + 'Legacy tasks: ' + legacyNote;
    }
  }

  return newTasks;
}

export function ensureJobTasksMatchColumns(job: Job): void {
  if (job.phases && job.phases.length) {
    job.phases.forEach(function (phase) {
      if (phase.subPhases && phase.subPhases.length) {
        phase.subPhases.forEach(function (sub) {
          sub.tasks = normalizeTasksToColumns(sub.tasks, (sub as any).color || (phase as any).color || job.color);
        });
      } else {
        phase.tasks = normalizeTasksToColumns(phase.tasks, (phase as any).color || job.color);
      }
    });
    dedupeTaskIdsAcrossPhases(job);
    return;
  }
  job.tasks = normalizeTasksToColumns(job.tasks, job.color);
}

// Defensive repair: a task id must be unique within a job, never shared
// across two of its phases (or two of a phase's sub-phases) —
// findTask()/cascadeShiftLaterTasks()/etc. all resolve "which unit does
// this task id belong to" by returning the FIRST unit (in array order)
// whose tasks contain a matching id, so a shared id makes every later
// unit's interaction with that task silently resolve to the earlier one
// instead — dragging phase 2's bar visibly moving phase 1's, with no
// error anywhere. Confirmed on real production data; the most likely
// origin is a stale snapshot merging back in during one of this session's
// now-fixed sync gaps, before a job actually had phases to worry about
// colliding across. Runs on every load (this function already does, via
// loadActiveProjectData()) so it self-heals without needing a one-off
// migration script — keeps each duplicate's own dates/notes/etc, just
// hands it a fresh id.
export function dedupeTaskIdsAcrossPhases(job: Job): void {
  const seen = new Set<string>();
  job.phases!.forEach(function (phase) {
    getPhaseSubUnits(phase).forEach(function (unit) {
      (unit.tasks || []).forEach(function (t) {
        if (seen.has(t.id)) t.id = genId();
        seen.add(t.id);
      });
    });
  });
}

export function makeBlankPhaseTasks(color: string | null | undefined): Task[] {
  return BOARD_COLUMNS.map(function (col: BoardColumn, i: number) {
    return { id: genId(), name: col.label, columnId: col.id, start: '', finish: '', notes: '', color: col.color || color || '#3949ab', order: i };
  });
}

export function makePhaseCard(job: Job, phase: Phase): BoardCard {
  const card: BoardCard = {
    id: genId(),
    title: job.name + (phase.isDefault ? '' : ' — ' + phase.name),
    description: '',
    due: '',
    color: job.color || '#3949ab',
    column: BOARD_COLUMNS[0] ? BOARD_COLUMNS[0].id : '',
    columnEnteredAt: Date.now(),
    jobId: job.id,
    phaseId: phase.id || null,
    manualColumn: null,
    manualColumnUntil: null,
    customFields: {},
    checklists: {},
    attachments: [],
  };
  // Not routed through setCardColumn() — there's no prior column to
  // compare against for a brand-new card, so its early-return guard
  // would never apply here anyway. Still runs the same column-entry
  // automation (e.g. checklist action-item) a card landing in this
  // column via a drag would get.
  runColumnEntryActions(card, card.column);
  return card;
}

// Converts a phase-less job in place into its first phase, preserving the
// existing card's description/checklists/attachments/customFields (only
// its title and phaseId change) rather than starting that data over.
export function splitJobIntoPhases(job: Job): void {
  if (job.phases && job.phases.length) return;
  const existingCard = getPhaseCard(job, null);
  // Left blank rather than defaulting to "Phase 1" — the phase strip shows
  // a placeholder ("Add name") for an unnamed phase (see
  // renderJobPhaseStrip()), and renameJobPhaseUI() allows clearing a name
  // back to blank too.
  const phase: Phase = { id: genId(), name: '', order: 0, tasks: job.tasks || [], isDefault: false };
  job.phases = [phase];
  job.tasks = [];
  if (existingCard) {
    existingCard.phaseId = phase.id;
    existingCard.title = job.name + (phase.name ? ' — ' + phase.name : '');
  }
}

export function addJobPhase(job: Job): Phase {
  splitJobIntoPhases(job); // no-op if already phased
  const order = job.phases!.length;
  const phase: Phase = { id: genId(), name: 'Phase ' + (order + 1), order: order, tasks: makeBlankPhaseTasks(job.color), isDefault: false };
  job.phases!.push(phase);
  return phase;
}

// Blocked by the caller (Job Manager UI) when it's the job's last phase —
// use unsplitJobFromPhases() instead in that case, which reverts the job
// back to unphased rather than leaving it with zero (an invalid state).
export function removeJobPhase(job: Job, phaseId: string): void {
  if (!job.phases) return;
  job.phases = job.phases.filter(function (p) { return p.id !== phaseId; });
  const card = getPhaseCard(job, phaseId);
  if (card) {
    boardCards = boardCards.filter(function (c) { return c !== card; });
    deleteCardFromShared(activeProjectId, card.id);
  }
  // Tombstoned like a deleted job/card/event — without this, another
  // client's phase-orphan self-heal (see applyLiveblocksState()) could
  // resurrect this phase from a stale copy of its card.
  recordTombstone(activeProjectId as string, phaseId);
}

// Undoes splitJobIntoPhases() — only valid with exactly one phase left (the
// "Phase 1" a split creates, or whatever's left after deleting down to it).
// Merges that phase's tasks back into job.tasks and re-points its card back
// to being the job's own (unphased) card, same shape a job that was never
// split has. Refuses if that last phase still has sub-phases of its own —
// those would have nowhere to go; the caller should have the user delete
// them first, same as a phase with sub-phases can't itself be deleted.
export function unsplitJobFromPhases(job: Job): boolean {
  if (!job.phases || job.phases.length !== 1) return false;
  const phase = job.phases[0];
  if (phase.subPhases && phase.subPhases.length) return false;
  job.tasks = phase.tasks || [];
  const card = getPhaseCard(job, phase.id);
  if (card) {
    card.phaseId = null;
    card.title = job.name;
  }
  job.phases = [];
  recordTombstone(activeProjectId as string, phase.id as string);
  return true;
}

// Sub-phases mirror phases one level down, minus the card: no
// ensureJobHasCards()-style self-heal or orphan-recovery tombstoning
// applies here at all, since a sub-phase never has a card of its own to
// go stale or get orphaned — deleting one is just an array splice.
export function splitPhaseIntoSubPhases(phase: Phase): void {
  if (phase.subPhases && phase.subPhases.length) return;
  const sub: SubPhase = { id: genId(), name: 'Sub-Phase 1', order: 0, tasks: phase.tasks || [], isDefault: false };
  phase.subPhases = [sub];
  phase.tasks = [];
}

export function addPhaseSubUnit(phase: Phase): SubPhase {
  splitPhaseIntoSubPhases(phase); // no-op if already split
  const order = phase.subPhases!.length;
  const color = (phase as any).color || null;
  const sub: SubPhase = { id: genId(), name: 'Sub-Phase ' + (order + 1), order: order, tasks: makeBlankPhaseTasks(color), isDefault: false };
  phase.subPhases!.push(sub);
  return sub;
}

// Blocked by the caller (Job Manager UI) when it's the phase's last
// sub-phase — use unsplitPhaseFromSubPhases() instead in that case, which
// reverts the phase back to unsplit rather than leaving it with zero.
export function removePhaseSubUnit(phase: Phase, subId: string): void {
  if (!phase.subPhases) return;
  phase.subPhases = phase.subPhases.filter(function (s) { return s.id !== subId; });
}

// Undoes splitPhaseIntoSubPhases() — only valid with exactly one sub-phase
// left. Merges its tasks back into phase.tasks; no card involved (a
// sub-phase never has one of its own), so unlike unsplitJobFromPhases()
// there's nothing to re-point.
export function unsplitPhaseFromSubPhases(phase: Phase): boolean {
  if (!phase.subPhases || phase.subPhases.length !== 1) return false;
  phase.tasks = phase.subPhases[0].tasks || [];
  phase.subPhases = [];
  return true;
}

export function ensureJobHasCards(job: Job): void {
  // Archived jobs are hidden from the board (see renderBoard's
  // isCardFromArchivedJob filter) and shouldn't have their cards silently
  // regenerated if the user deletes them while archived. Restoring the job
  // re-enables this invariant, so fresh cards get created then if needed.
  if (job.archived) return;

  const phases = getJobPhases(job);

  // Deliberately no "delete any card whose phaseId doesn't match a current
  // phase" cleanup here. A local, deliberate phase delete already cleans up
  // its own card directly and immediately (see removeJobPhase()) — the only
  // other way a card ends up phase-orphaned is a remote-merge race (the
  // card arrives before the phase does, or vice versa), and that's handled
  // by applyLiveblocksState()'s grace-period-aware phase-orphan recovery.
  // This function runs on every load (loadActiveProjectData(), right after
  // a remote merge), so an immediate delete here used to win the race
  // against that grace period every time — deleting (and tombstoning) a
  // phase-card the instant it arrived, before the phase itself had any
  // chance to catch up moments later.

  phases.forEach(function (phase) {
    const pid = phase.id || null;
    const linked = boardCards.filter(function (c) { return c.jobId === job.id && (c.phaseId || null) === pid; });
    if (linked.length === 0) {
      boardCards.push(makePhaseCard(job, phase));
    } else {
      if (linked.length > 1) {
        for (let i = 1; i < linked.length; i++) {
          const idx = boardCards.indexOf(linked[i]);
          if (idx !== -1) boardCards.splice(idx, 1);
          // Routine saves are upsert-only now (see pushProjectToShared) and no
          // longer delete-by-absence, so a duplicate removed locally needs an
          // explicit remote delete too or it'll just keep re-appearing.
          deleteCardFromShared(activeProjectId, linked[i].id);
        }
      }
      const card = linked[0];
      card.title = job.name + (phase.isDefault ? '' : ' — ' + phase.name);
      // Cards have no independent color anymore — the card modal's own
      // color picker was removed since it silently fought with this sync
      // (see git history). job.color is the single source of truth now,
      // re-applied on every load so changing a job's color updates its
      // card(s) immediately instead of only at creation time.
      card.color = job.color || '#3949ab';
      if (!card.jobId) card.jobId = job.id;
      if ((card.phaseId || null) !== pid) card.phaseId = pid;
    }
  });
}

// ===== Section 6: Migration — adopt cards that predate the jobId field =====
// Run once per load, before the ensureJobTasksMatchColumns/ensureJobHasCard
// pass, so any stub jobs created here get normalized in that same pass.
// Idempotent: a card only qualifies while it has no jobId, so re-running
// this on an already-migrated project is a no-op.
export function migrateOrphanedCards(): void {
  const orphans = boardCards.filter(function (c) { return !c.jobId; });
  orphans.forEach(function (card) {
    const match = jobs.find(function (j) { return j.name === card.title; });
    if (match) {
      card.jobId = match.id;
      logActivity('linked orphaned card "' + card.title + '" to matching job');
    } else {
      // No job shares this card's title — adopt it as a new job so it
      // doesn't just vanish once every card is required to have one.
      const stubJob: Job = {
        id: genId(),
        name: card.title || 'Untitled',
        color: card.color || '#3949ab',
        archived: false,
        comments: [],
        tasks: [],
      };
      jobs.push(stubJob);
      card.jobId = stubJob.id;
      logActivity('created job for orphaned card "' + card.title + '"');
    }
  });
}

// ===== Section 2: Auto-Derive Column from Dates =====
// Section 5 adds an optional `card` argument: if that card has an active
// manual override (drag-and-drop placement), it wins over the date-derived
// column until the override expires or the job's dates are re-saved.
//
// Priority order (confirmed with the user, and corrected after a real
// bug report: a manual drag between two regular boards was losing to
// whatever board happened to be active "today" elsewhere on the same
// job — e.g. dragging out of "Design" while Design was still the
// currently-active task snapped straight back, ignoring the fresh
// manual override entirely):
//  1. A column-level "Connect to Schedule" toggle turned off (scheduleDisconnected)
//     always wins — a deliberate, indefinite admin freeze on that whole board.
//  2. No dates entered anywhere on this job/phase at all: nothing to derive
//     from, so the card is freely movable and just stays wherever it's put,
//     indefinitely (no auto-snap-back, no 24h expiry — there's no "correct"
//     position to snap back to without dates).
//  3. The temporary 24h manual-drag override, if one is active — a fresh
//     manual placement into a REGULAR board always wins for its full
//     window, regardless of what else is active today. (A drop into a
//     hideFromSchedule board never sets this — see dropNeedsManualOverride
//     — so this step is naturally skipped for that case, falling through
//     to step 4 below instead.)
//  4. Today falls inside an actual scheduled task's date range: this pulls
//     the card onto the live schedule, including out of a hideFromSchedule
//     holding board — this is the "until the date hits today" trigger for
//     a card parked there (which never has an active override to lose to).
//  5. Otherwise, if the card is currently sitting in a hideFromSchedule
//     board (Bid/Invoiced-style — no meaningful dates of its own), that's a
//     deliberately-chosen holding spot, not something to auto-correct out
//     of — leave it alone, freely, same as the no-dates case.
//  6. Otherwise, the normal before/after/gap date-derived fallback.
export function deriveColumnForTasks(tasks: Task[], card?: BoardCard | null): string {
  if (card) {
    const currentCol = BOARD_COLUMNS.find(function (c: BoardColumn) { return c.id === card.column; });
    if (currentCol && currentCol.scheduleDisconnected) return card.column;
  }

  const hasAnyDates = (tasks || []).some(function (t) { return t.start && t.finish; });
  if (!hasAnyDates) {
    return card ? card.column : (BOARD_COLUMNS[0] ? BOARD_COLUMNS[0].id : '');
  }

  if (card && card.manualColumn && card.manualColumnUntil && Date.now() < card.manualColumnUntil) {
    return card.manualColumn;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (BOARD_COLUMNS.length === 0) return '';

  let activeIdx = -1;
  let lastFinishedIdx = -1;
  let firstDatedIdx = -1;
  let lastDatedIdx = -1;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.start || !t.finish) continue;

    const s = new Date(t.start + 'T00:00:00');
    const f = new Date(t.finish + 'T00:00:00');
    if (isNaN(s.getTime()) || isNaN(f.getTime())) continue;

    if (firstDatedIdx === -1) firstDatedIdx = i;
    lastDatedIdx = i;

    if (today >= s && today <= f) {
      activeIdx = i; // later overlapping tasks overwrite earlier ones
    }
    if (today > f) {
      lastFinishedIdx = i;
    }
  }

  if (activeIdx !== -1) {
    return BOARD_COLUMNS[activeIdx] ? BOARD_COLUMNS[activeIdx].id : '';
  }

  if (card) {
    const currentCol = BOARD_COLUMNS.find(function (c: BoardColumn) { return c.id === card.column; });
    if (currentCol && currentCol.hideFromSchedule) return card.column;
  }

  if (firstDatedIdx === -1) {
    // Defensive fallback — hasAnyDates already guarantees this shouldn't
    // happen, but keep the same safe default as before just in case.
    return BOARD_COLUMNS[0] ? BOARD_COLUMNS[0].id : '';
  }

  const firstStart = new Date(tasks[firstDatedIdx].start + 'T00:00:00');
  const lastFinish = new Date(tasks[lastDatedIdx].finish + 'T00:00:00');

  if (today < firstStart) {
    return BOARD_COLUMNS[firstDatedIdx] ? BOARD_COLUMNS[firstDatedIdx].id : '';
  }

  if (today > lastFinish) {
    return BOARD_COLUMNS[lastDatedIdx] ? BOARD_COLUMNS[lastDatedIdx].id : '';
  }

  // In a gap between tasks — park in the last finished task's column
  if (lastFinishedIdx !== -1) {
    return BOARD_COLUMNS[lastFinishedIdx] ? BOARD_COLUMNS[lastFinishedIdx].id : '';
  }

  return BOARD_COLUMNS[0] ? BOARD_COLUMNS[0].id : '';
}

// Single point where a card's column actually changes — used instead of
// assigning card.column directly so "entered a new column" side effects
// (columnEnteredAt for stalled-job tracking, runColumnEntryActions() for
// column-configured automation below) fire exactly once per real
// transition, not on every no-op re-derivation — syncCardColumns()
// below reassigns every job-linked card's column on nearly every
// render, even when nothing about it actually changed, so this early-
// return is what keeps that from resetting the stalled-time clock or
// re-firing checklist assignment constantly.
export function setCardColumn(card: BoardCard, newColumnId: string): void {
  if (card.column === newColumnId) return;
  card.column = newColumnId;
  card.columnEnteredAt = Date.now();
  runColumnEntryActions(card, newColumnId);
}

// Column-configured actions that fire once, at the moment a card enters
// a column — currently just the checklist action-item automation
// (col.autoAssignChecklist, see toggleColumnAutoAssignChecklist()). The
// one seam any future column-entry action (set/clear due date, an
// activity-log note, auto-color) would slot into as another
// `if (col.<flag>)` block here, without touching setCardColumn() or its
// three call sites.
export function runColumnEntryActions(card: BoardCard, colId: string): void {
  const col = BOARD_COLUMNS.find(function (c: BoardColumn) { return c.id === colId; });
  if (!col) return;
  if (col.autoAssignChecklist) {
    // getChecklistForStageInProject() already exists (see MY CHECKLIST
    // below) to lazily seed a stage's checklist from the column's
    // defaultChecklist the first time something asks for it — this is
    // that same seeding, just run eagerly right now instead of waiting
    // for someone to happen to open My Checklist or the card first.
    if (!card.checklists) card.checklists = {};
    const items = getChecklistForStageInProject(card.checklists, colId, BOARD_COLUMNS);
    const assignee = col.checklistAssigneeOverride
      || (card.customFields && (card.customFields as any).foreman)
      || (card.customFields && (card.customFields as any).pm)
      || '';
    // Only fills items nobody's already claimed — doesn't reassign an
    // item someone picked up before this column's automation was turned
    // on, or before the card's foreman/PM was set.
    if (assignee) {
      items.forEach(function (item) { if (!item.assignee) item.assignee = assignee; });
    }
  }
}

export function syncCardColumns(): void {
  // Was calling getPhaseCard() (a full boardCards.find() scan) once per
  // phase across every job -- an O(jobs x phases x boardCards) scan that
  // runs at the top of renderJobList(), including once per keystroke via
  // filterJobList(). Builds one jobId|phaseId -> card lookup Map here
  // instead, scoped to just this call (not a persistent cross-call
  // cache -- boardCards is mutated from enough places elsewhere in this
  // file that keeping a cache reliably invalidated everywhere would be
  // its own risk), so the O(cards) cost of building it is paid once per
  // call instead of once per phase.
  const cardMap = new Map<string, BoardCard>();
  boardCards.forEach(function (c) { cardMap.set(c.jobId + '|' + (c.phaseId || ''), c); });
  jobs.forEach(function (job) {
    getJobPhases(job).forEach(function (phase) {
      const card = cardMap.get(job.id + '|' + (phase.id || ''));
      if (card) {
        // A phase with sub-phases has nothing left in its own phase.tasks
        // (mirrors job.tasks emptying once split into phases) — its one
        // card's column is deliberately derived from just the FIRST
        // sub-phase's own dates, not a combined read across all of them
        // (confirmed with the user).
        const tasksForColumn = getPhaseSubUnits(phase)[0].tasks;
        setCardColumn(card, deriveColumnForTasks(tasksForColumn, card));
      }
    });
  });
}

export function ensureCardIds(arr: BoardCard[]): BoardCard[] {
  (arr || []).forEach(function (c) { if (!c.id) c.id = genId(); });
  return arr;
}

// ===== JOB VISIBILITY BY MEMBERSHIP =====
export function isJobVisibleToMe(job: Job): boolean {
  if (!job) return false;
  const card = getPrimaryPhaseCard(job);
  const members = (card && card.customFields && (card.customFields as any).members) || [];
  if (hasMinTier('projectAdmin')) return true;
  const asUsername = viewAsUsername || getStoredUsername();
  return members.indexOf(asUsername) !== -1;
}

export function getVisibleJobs(): Job[] {
  return jobs.filter(isJobVisibleToMe);
}

// A job is "finished" only once every one of its tasks has finished —
// used for the job-card styling in the Manager list, where a single
// finished task shouldn't mark a still-in-progress multi-task job as done.
export function isTaskFinished(job: Job, task: Task): boolean {
  if (job.archived) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.finish + 'T00:00:00') < today;
}

export function isJobFinished(job: Job): boolean {
  if (job.archived) return false;
  if (!job.tasks || !job.tasks.length) return false;
  return job.tasks.every(function (t) { return isTaskFinished(job, t); });
}
