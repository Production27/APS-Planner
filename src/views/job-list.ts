// Job Manager: the job list sidebar (search/filter, per-card duplicate/
// delete buttons, the "+ Add Job" tile), archive/restore (including the
// Archived Jobs modal), duplicateJob(), and the delete-job confirmation
// flow. The rest of Job Manager — the actual job/phase/task editing form
// and autosave (src/views/job-form.ts), comments (src/views/job-comments.ts) —
// lives elsewhere; this file calls that (editJob/addNewJob/cancelEdit/
// isJobFinished/getVisibleJobs/ensureJobHasCards/syncCardColumns and
// friends) as ambient globals rather than importing it.
import { formatDate } from '../utils/date';
import type { Job } from '../core/types';
import { findJob, getJobPhases, getPhaseCard, getJobCards, getPrimaryPhaseCard } from '../core/models';
import { genId } from '../utils/id';
import { tintedTextColor } from '../utils/color';
import { openModal, closeModal, showToast, isPanelActive } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';
import { logActivity, deleteJobFromShared, deleteCardFromShared } from '../sync/outbound';
import { ensureCardChecklists } from './checklist';
import { renderGantt } from './gantt';
import { renderCalendar } from './calendar';
import { renderBoard } from './board';
import { getVisibleJobs, isJobFinished, ensureJobHasCards, syncCardColumns } from '../core/jobs';
import { renderJobListInto, type JobCardProps, type JobBoardDotProps } from './job-list-card';
import { renderArchivedJobsListInto } from './job-list-archived';

// editJob()/cancelEdit() are already declared ambient (identically) by
// gantt.ts/home.ts — not repeated here (TypeScript's ambient declaration
// merging is global, not per-file, so redeclaring them here would just
// be a duplicate, and one with the wrong overload ordering has actually
// broken cross-file type resolution before — see gantt.ts's own
// getVisibleJobs()/getLinkedReferenceJobs() calls if this ever needs
// revisiting).
declare global {
  // eslint-disable-next-line no-var
  var editingTaskId: string | null;
  function addNewJob(): void;
  function setJobNameHint(show: boolean): void;
  function showTaskRowWarnings(labels: string[]): void;
  function closeJobDrawer(): void;
  function cancelPendingJobAutosave(): void;
}

// Teammates' changes skip redrawing the Jobs list while it isn't on
// screen (the desktop rail is closed by default; on a phone it only shows
// in the Jobs view). At 1,000 jobs that redraw was ~85 ms on every
// incoming change, whatever tab was open. The list is marked stale
// instead and redrawn as soon as it's shown (renderJobListIfStale(), from
// toggleJobRail()/setMobileView()/resize). Checked from the element itself
// rather than re-deriving the CSS rules that hide it: closed on desktop
// is opacity 0, hidden on mobile is display:none. body.job-rail-open counts
// as visible on its own, since the rail fades in: in the first frame
// after opening, the computed opacity still reads 0.
let jobListStale = false;
function isJobListOnScreen(): boolean {
  const list = document.getElementById('jobList');
  if (!list || list.getClientRects().length === 0) return false;
  return document.body.classList.contains('job-rail-open') || getComputedStyle(list).opacity !== '0';
}
export function renderJobListWhenVisible(): void {
  if (isJobListOnScreen()) { renderJobList(); return; }
  jobListStale = true;
  // Still resolve date-derived stages, which renderJobList() would have.
  syncCardColumns();
}
export function renderJobListIfStale(): void {
  if (jobListStale) renderJobList();
}

export function renderJobList(): void {
  jobListStale = false;
  const list = document.getElementById('jobList')!;
  const search = (document.getElementById('jobSearch') as HTMLInputElement).value.toLowerCase();

  // Column placement is date-derived (or manually overridden) — resolve it
  // before reading card.column below so the board tag is never stale.
  syncCardColumns();

  const cards: JobCardProps[] = [];
  getVisibleJobs().forEach((job) => {
    if (job.archived) return;
    if (search && !job.name.toLowerCase().includes(search)) return;

    const phases = getJobPhases(job);
    let s: Date | null = null, f: Date | null = null;
    phases.forEach(function (phase) {
      (phase.tasks || []).forEach(function (t) {
        // Skip undated tasks entirely — building a Date from an empty string
        // produces an invalid Date, and once `s`/`f` land on one, every later
        // comparison against it is false (NaN never compares less/greater
        // than anything), so a bad first task would otherwise permanently
        // stick the whole card at "Invalid Date" even if other tasks have
        // real dates.
        if (!t.start || !t.finish) return;
        const ts = new Date(t.start + 'T00:00:00');
        const tf = new Date(t.finish + 'T00:00:00');
        if (isNaN(ts.getTime()) || isNaN(tf.getTime())) return;
        if (!s || ts < s) s = ts;
        if (!f || tf > f) f = tf;
      });
    });
    // A phase-less job shows the same single "current board" tag it always
    // has. A phased job instead shows one small dot per phase (title gives
    // the phase name + stage on hover) — a single tag can't represent N
    // independently-tracked stages without picking one arbitrarily.
    let boardDots: JobBoardDotProps[] | null = null;
    let singleBoardTag: { color: string; label: string } | null = null;
    if (job.phases && job.phases.length) {
      boardDots = phases.map(function (phase) {
        const card = getPhaseCard(job, phase.id);
        const col = card ? BOARD_COLUMNS.find(function (c) { return c.id === card.column; }) : null;
        return {
          dotKey: phase.id || phase.name,
          color: col ? (col.color || '#3949ab') : '#ccc',
          title: phase.name + (col ? ': ' + col.label : ''),
        };
      });
    } else {
      const linkedCard = getPhaseCard(job, null);
      const boardCol = linkedCard ? BOARD_COLUMNS.find(function (c) { return c.id === linkedCard.column; }) : null;
      if (boardCol) singleBoardTag = { color: boardCol.color || '#3949ab', label: boardCol.label };
    }

    const comments = job.comments as any[] | undefined;
    cards.push({
      jobKey: job.id,
      active: editingJobId === job.id,
      archived: !!job.archived,
      finished: isJobFinished(job),
      color: job.color,
      // Identical to the Board card's title color for this job (same
      // inputs as buildCardProps() in board.ts), so a job reads as the
      // same color in both places.
      titleColorLight: tintedTextColor(job.color || '#3949ab', '#ffffff', 6),
      titleColorDark: tintedTextColor(job.color || '#3949ab', '#242732', 6),
      name: job.name,
      dateRangeLabel: (s && f) ? (formatDate(s as Date, { month: 'short', day: 'numeric' }) + ' – ' + formatDate(f as Date, { month: 'short', day: 'numeric' })) : null,
      boardDots: boardDots,
      singleBoardTag: singleBoardTag,
      commentCount: (comments && comments.length) || 0,
      // Clicking the job that's already open closes the drawer instead of
      // just re-loading it — a toggle, same as clicking an already-selected
      // item elsewhere in the app typically does.
      onActivate: function () { if (editingJobId === job.id) cancelEdit(); else editJob(job.id); },
      onDuplicate: function (e: Event) { duplicateJob(job.id, e); },
      onDelete: function (e: Event) { e.stopPropagation(); promptDeleteJob(job.id); },
    });
  });

  // The "+ Add Job" tile lives inside the scrolling list itself (not the
  // fixed toolbar below it) so it moves down with the list as more jobs
  // get added, landing right after the last one — same idea as the
  // Board's dashed "+ Add Board" tile at the end of the column row.
  // Archived jobs are reached from a link at the bottom of this list (it
  // used to be an item in the settings menu, far from the jobs it's about).
  const archivedCount = getVisibleJobs().filter(function (j) { return j.archived; }).length;
  renderJobListInto(list, cards, function () { addNewJob(); }, archivedCount, openArchivedJobsModal);

  updateJobCount();
  applyPermissionGating(); // rebuilt on every job list refresh, outside renderAll()'s own sweep
}

// Debounced — renderJobList() tears down and rebuilds the entire job
// list's innerHTML (with per-card inline SVGs) on every call, which used
// to run on every single keystroke. 150ms is short enough that typing
// still feels immediate (the gap between keystrokes during normal typing
// is usually well over that) but collapses a fast typist's burst of
// keystrokes into one render instead of one per character.
let filterJobListDebounceTimer: ReturnType<typeof setTimeout> | null = null;
export function filterJobList(): void {
  if (filterJobListDebounceTimer) clearTimeout(filterJobListDebounceTimer);
  filterJobListDebounceTimer = setTimeout(renderJobList, 150);
}

export function updateJobCount(): void {
  const myJobs = getVisibleJobs();
  const visible = myJobs.filter((j) => !j.archived).length;
  const archived = myJobs.filter((j) => j.archived).length;
  document.getElementById('jobCount')!.textContent = String(visible) + (archived > 0 ? ' / ' + myJobs.length : '');
}

export function archiveJob(jobId: string): void {
  // Defense-in-depth, matching addNewJob()/duplicateJob()/
  // promptDeleteJob()'s same pattern — its trigger button is already
  // data-min-tier gated, but a function-level check here doesn't depend
  // on that DOM state having been applied correctly at the moment of the
  // click.
  if (!hasMinTier('editor')) return;
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  job.archived = true;
  saveJobs();
  logActivity('archived job "' + job.name + '"');
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  showToast('Job archived', 'success');
  if (editingJobId === jobId) editJob(jobId);
}

export function restoreJob(jobId: string): void {
  // Defense-in-depth, matching archiveJob()'s same pattern just above.
  if (!hasMinTier('editor')) return;
  const found = findJob(jobId);
  if (!found) return;
  const job = found.job;
  job.archived = false;
  saveJobs();
  logActivity('restored job "' + job.name + '"');
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  if (isPanelActive('board')) renderBoard();
  showToast('Job restored', 'success');
  if (editingJobId === jobId) editJob(jobId);
  refreshArchivedJobsListIfOpen();
}

export function openArchivedJobsModal(): void {
  openModal('archivedJobsModal');
  renderArchivedJobsList();
}
export function closeArchivedJobsModal(): void {
  closeModal('archivedJobsModal');
}
export function refreshArchivedJobsListIfOpen(): void {
  const modal = document.getElementById('archivedJobsModal');
  if (modal && modal.classList.contains('show')) renderArchivedJobsList();
}

export function renderArchivedJobsList(): void {
  const listEl = document.getElementById('archivedJobsList');
  if (!listEl) return;
  const archivedJobs = getVisibleJobs().filter(function (j) { return j.archived; });
  renderArchivedJobsListInto(listEl, {
    jobs: archivedJobs.map(function (job) {
      return {
        jobKey: job.id,
        name: job.name,
        onRestore: function () { restoreJob(job.id); },
        onDelete: function () { promptDeleteJob(job.id); },
      };
    }),
  });
  applyPermissionGating(); // this list is rebuilt outside renderAll()'s own sweep
}

export function archiveCurrentJob(): void {
  if (editingJobId) {
    const found = findJob(editingJobId);
    if (!found) return;
    if (found.job.archived) restoreJob(editingJobId);
    else archiveJob(editingJobId);
  }
}

// Duplicates a job's tasks, color, and linked card (description/due/custom
// fields/checklist/attachments) under a new name. Comments, archived
// status, and any manual board-column override are deliberately NOT
// carried over — the copy starts as a fresh, active, auto-positioned job.
export function duplicateJob(jobId: string, event?: Event): void {
  if (event) event.stopPropagation();
  // Defense-in-depth, matching promptDeleteJob()'s same pattern — its
  // trigger button is already data-min-tier gated (and hidden entirely,
  // see applyPermissionGating()), but a function-level check here doesn't
  // depend on that DOM state having been applied correctly at the moment
  // of the click.
  if (!hasMinTier('projectAdmin')) return;
  const found = findJob(jobId);
  if (!found) return;
  const original = found.job;
  const newName = window.prompt('Name for the copy:', original.name + ' (copy)');
  if (!newName || !newName.trim()) return;

  const newJob: Job = {
    id: genId(),
    name: newName.trim(),
    color: original.color,
    archived: false,
    comments: [],
    tasks: (original.tasks || []).map(function (t) { return Object.assign({}, t, { id: genId() }); }),
  };
  if (original.phases && original.phases.length) {
    newJob.phases = original.phases.map(function (phase, i) {
      return {
        id: genId(),
        name: phase.name,
        order: i,
        tasks: (phase.tasks || []).map(function (t) { return Object.assign({}, t, { id: genId() }); }),
        // false, not phase.isDefault — a real (not synthetic-wrapper) phase
        // on the duplicate either way, matching getJobPhases()'s own
        // convention for genuinely-phased jobs.
        isDefault: false,
      };
    });
  }
  jobs.push(newJob);
  ensureJobHasCards(newJob);

  // Copy each original phase's card metadata onto its corresponding new
  // phase's card, matched by position (getJobPhases() returns both in the
  // same order phases/newJob.phases were built in above) — covers the
  // unphased case too, since getJobPhases() gives back a single-entry
  // array either way.
  const originalPhases = getJobPhases(original);
  const newPhases = getJobPhases(newJob);
  originalPhases.forEach(function (origPhase, i) {
    const newPhase = newPhases[i];
    if (!newPhase) return;
    const originalCard = getPhaseCard(original, origPhase.id);
    const newCard = getPhaseCard(newJob, newPhase.id);
    if (!originalCard || !newCard) return;
    newCard.description = originalCard.description || '';
    newCard.due = originalCard.due || '';
    newCard.customFields = Object.assign({}, originalCard.customFields || {});
    ensureCardChecklists(originalCard);
    newCard.checklists = {};
    Object.keys(originalCard.checklists || {}).forEach(function (colId) {
      // A template-sourced item keeps its id (which is the template item's
      // own id — see getChecklistForStageInProject(), the My Checklist tab)
      // rather than getting a fresh one, so the duplicate stays correctly
      // linked to the template: a regenerated id would look "never seen"
      // to the merge-in logic and duplicate every still-active template
      // item the next time the template changes. Only genuinely custom
      // items get a fresh id.
      const col = BOARD_COLUMNS.find(function (c) { return c.id === colId; });
      const templateIds = ((col && (col as any).defaultChecklist) || []).map(function (d: any) { return d.id; });
      // Deep-cloned (not Object.assign's shallow copy) — an item's
      // assignee/subItems are arrays, and a shallow copy would leave the
      // duplicate sharing those same array references with the original,
      // so toggling a sub-item or reassigning on one would silently
      // mutate the other too.
      (newCard.checklists as any)[colId] = (originalCard.checklists as any)[colId].map(function (i: any) {
        return Object.assign(JSON.parse(JSON.stringify(i)), { id: templateIds.indexOf(i.id) !== -1 ? i.id : genId() });
      });
    });
    (newCard as any).checklistAssignees = JSON.parse(JSON.stringify((originalCard as any).checklistAssignees || {}));
    newCard.attachments = ((originalCard.attachments as any[]) || []).map(function (a) { return Object.assign({}, a, { id: genId() }); });
  });

  saveJobs();
  logActivity('duplicated job "' + original.name + '" as "' + newJob.name + '"');
  renderJobList();
  if (isPanelActive('gantt')) renderGantt();
  if (isPanelActive('calendar')) renderCalendar();
  syncCardColumns();
  if (isPanelActive('board')) renderBoard();
  showToast('Job duplicated', 'success');
  editJob(newJob.id);
}

// null when no delete is pending — the only src/ or index.html code that
// reads or writes this is the delete-confirmation flow right below, all
// moved here together, so this stays real module state rather than an
// ambient index.html global.
let deleteTargetJobId: string | null = null;

export function promptDeleteJob(jobId: string): void {
  // Defense-in-depth — its own trigger buttons are already data-min-tier
  // gated, but delete is irreversible enough to warrant a second check here.
  if (!hasMinTier('projectAdmin')) return;
  deleteTargetJobId = jobId;
  const found = findJob(jobId);
  document.getElementById('deleteJobName')!.textContent = found ? found.job.name : '';
  openModal('deleteModal');
}

export function confirmDelete(): void {
  if (editingJobId) promptDeleteJob(editingJobId);
}

export function executeDelete(): void {
  if (deleteTargetJobId) {
    // Cancel (not flush!) any pending autosave for the job about to be
    // deleted — flushing here would just resave it a moment before the
    // splice, and if the timer somehow survived the splice, it must never
    // fire afterward and recreate it from stale form values.
    if (editingJobId === deleteTargetJobId) cancelPendingJobAutosave();
    const found = findJob(deleteTargetJobId);
    if (!found) return;
    const jobName = found.job.name;
    const idx = found.idx;
    const jobId = found.job.id;
    jobs.splice(idx, 1);

    // The schema-lock pass (ensureJobHasCard) only ever creates a missing
    // card — it never removes an extra one — so without this, a deleted
    // job's card was left behind as a phantom on the Board forever (it
    // used to get cleaned up only as a side effect of the old delete-by-
    // absence push logic, which was removed for being unsafe under
    // concurrent edits; see the comment on pushProjectToShared's jobsMap).
    const orphanedCardIds = getJobCards(found.job).map(function (c) { return c.id; });
    boardCards = boardCards.filter(function (c) { return c.jobId !== jobId; });

    saveJobs();
    const activeId = activeProjectId as string;
    deleteJobFromShared(activeId, jobId);
    orphanedCardIds.forEach(function (cardId) { deleteCardFromShared(activeId, cardId); });

    logActivity('deleted job "' + jobName + '"');
    if (editingJobId === deleteTargetJobId) {
      editingJobId = null;
      editingTaskId = null;
      setJobNameHint(false);
      showTaskRowWarnings([]);
      closeJobDrawer();
      document.getElementById('jobForm')!.style.display = 'none';
      document.getElementById('jobCommentsPanel')!.style.display = 'none';
    }
    renderJobList();
    if (isPanelActive('gantt')) renderGantt();
    if (isPanelActive('calendar')) renderCalendar();
    if (isPanelActive('board')) renderBoard();
    showToast('Job deleted', 'info');
    refreshArchivedJobsListIfOpen();
  }
  closeDeleteJobModal();
}

export function closeDeleteJobModal(): void {
  closeModal('deleteModal', function () {
    deleteTargetJobId = null;
  });
}
