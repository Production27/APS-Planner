// Job Manager: the job list sidebar (search/filter, per-card duplicate/
// delete buttons, the "+ Add Job" tile), archive/restore (including the
// Archived Jobs modal), duplicateJob(), and the delete-job confirmation
// flow. The rest of Job Manager (the actual job/phase/task editing form,
// autosave, comments — see src/views/job-comments.ts) stays in
// index.html until later phases; this file calls that remaining code
// (editJob/addNewJob/cancelEdit/isJobFinished/getVisibleJobs/
// ensureJobHasCards/syncCardColumns and friends) as ambient globals, same
// forward-reference pattern as the rest of this extraction.
import type { Job } from '../core/types';
import { findJob, getJobPhases, getPhaseCard, getJobCards, getPrimaryPhaseCard } from '../core/models';
import { escapeHtml } from '../utils/html';
import { genId } from '../utils/id';
import { openModal, closeModal, showToast } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';
import { logActivity, deleteJobFromShared, deleteCardFromShared } from '../sync/outbound';
import { ensureCardChecklists } from './checklist';
import { renderGantt } from './gantt';
import { renderCalendar } from './calendar';
import { renderBoard } from './board';

// getVisibleJobs()/syncCardColumns()/editJob()/cancelEdit() are already
// declared ambient (identically) by gantt.ts/board.ts/home.ts — not
// repeated here (TypeScript's ambient declaration merging is global, not
// per-file, so redeclaring them here would just be a duplicate, and one
// with the wrong overload ordering has actually broken cross-file type
// resolution before — see gantt.ts's own getVisibleJobs()/
// getLinkedReferenceJobs() calls if this ever needs revisiting).
declare global {
  // eslint-disable-next-line no-var
  var editingTaskId: string | null;
  function isJobFinished(job: Job): boolean;
  function ensureJobHasCards(job: Job): void;
  function addNewJob(): void;
  function setJobNameHint(show: boolean): void;
  function showTaskRowWarnings(labels: string[]): void;
  function closeJobDrawer(): void;
  function cancelPendingJobAutosave(): void;
}

export function renderJobList(): void {
  const list = document.getElementById('jobList')!;
  const search = (document.getElementById('jobSearch') as HTMLInputElement).value.toLowerCase();
  list.innerHTML = '';

  // Column placement is date-derived (or manually overridden) — resolve it
  // before reading card.column below so the board tag is never stale.
  syncCardColumns();

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
    let boardTag = '';
    if (job.phases && job.phases.length) {
      boardTag = '<span class="job-card-phase-dots">' + phases.map(function (phase) {
        const card = getPhaseCard(job, phase.id);
        const col = card ? BOARD_COLUMNS.find(function (c) { return c.id === card.column; }) : null;
        return '<span class="job-card-board-dot" style="background:' + (col ? (col.color || '#3949ab') : '#ccc') + ';" title="' + escapeHtml(phase.name) + (col ? ': ' + escapeHtml(col.label) : '') + '"></span>';
      }).join('') + '</span>';
    } else {
      const linkedCard = getPhaseCard(job, null);
      const boardCol = linkedCard ? BOARD_COLUMNS.find(function (c) { return c.id === linkedCard.column; }) : null;
      boardTag = boardCol
        ? '<span class="job-card-board-tag" title="Current board"><span class="job-card-board-dot" style="background:' + (boardCol.color || '#3949ab') + ';"></span>' + escapeHtml(boardCol.label) + '</span>'
        : '';
    }

    const card = document.createElement('div');
    const comments = job.comments as any[] | undefined;
    card.className = 'job-card' + (editingJobId === job.id ? ' active' : '') + (job.archived ? ' archived' : '') + (isJobFinished(job) ? ' finished' : '');
    card.innerHTML = '<div class="color-strip" style="background:' + job.color + ';"></div>' +
      '<div class="job-card-title">' + escapeHtml(job.name) + (job.archived ? ' <span style="font-size: var(--t-2xs);color:#888;">(archived)</span>' : '') + '</div>' +
      '<div class="job-card-meta">' +
      (s && f ? '<span><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935"/><rect x="6" y="13" width="3" height="3" fill="#e53935"/><rect x="10.5" y="13" width="3" height="3" fill="#e53935"/><rect x="15" y="13" width="3" height="3" fill="#e53935"/></svg> ' + (s as Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + (f as Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</span>' : '') +
      boardTag +
      ((comments && comments.length) ? '<span class="note-icon" title="' + comments.length + ' comment' + (comments.length === 1 ? '' : 's') + '"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16v12H8l-4 4V4z" fill="#3949ab"/></svg> ' + comments.length + '</span>' : '') + '</div>' +
      '<button class="copy-btn" onclick="event.stopPropagation(); duplicateJob(\'' + job.id + '\', event)" title="Duplicate"><svg viewBox="0 0 24 24" width="13" height="13" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg></button>' +
      '<button class="delete-btn" onclick="event.stopPropagation(); promptDeleteJob(\'' + job.id + '\')" title="Delete">×</button>';
    // Clicking the job that's already open closes the drawer instead of
    // just re-loading it — a toggle, same as clicking an already-selected
    // item elsewhere in the app typically does.
    card.onclick = () => { if (editingJobId === job.id) cancelEdit(); else editJob(job.id); };
    list.appendChild(card);
  });

  // Lives inside the scrolling list itself (not the fixed toolbar below
  // it) so it moves down with the list as more jobs get added, landing
  // right after the last one — same idea as the Board's dashed "+ Add
  // Board" tile at the end of the column row.
  const addBtn = document.createElement('button');
  addBtn.className = 'job-list-add-btn';
  addBtn.textContent = '+ Add Job';
  addBtn.onclick = () => addNewJob();
  list.appendChild(addBtn);

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
  renderGantt();
  renderCalendar();
  renderBoard();
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
  renderGantt();
  renderCalendar();
  renderBoard();
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
  if (!archivedJobs.length) {
    listEl.innerHTML = '<div style="padding: var(--s-3-5); color:var(--text-secondary);">No archived jobs.</div>';
    return;
  }
  listEl.innerHTML = '';
  archivedJobs.forEach(function (job) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding: var(--s-2-5) var(--s-3); border-bottom:1px solid var(--border); gap: var(--s-2);';
    row.innerHTML =
      '<div style="min-width:0; font-size: var(--t-base); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(job.name) + '</div>' +
      '<div style="display:flex; gap: var(--s-1-5); flex-shrink:0;">' +
        '<button class="btn btn-secondary" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="restore" data-min-tier="editor"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M6 8H3V5" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 8a9 9 0 1 1 2 8" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round"/></svg> Restore</button>' +
        '<button class="btn btn-danger" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="delete" data-min-tier="projectAdmin"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg> Delete</button>' +
      '</div>';
    (row.querySelector('[data-action="restore"]') as HTMLButtonElement).onclick = function () { restoreJob(job.id); };
    (row.querySelector('[data-action="delete"]') as HTMLButtonElement).onclick = function () { promptDeleteJob(job.id); };
    listEl.appendChild(row);
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
  renderGantt();
  renderCalendar();
  syncCardColumns();
  renderBoard();
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
    renderGantt();
    renderCalendar();
    renderBoard();
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
