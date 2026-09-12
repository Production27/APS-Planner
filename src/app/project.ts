// Project management: the two-fixed-project bootstrap/migration, loading
// and saving the whole `projects` map, switchProject() (the single
// highest-blast-radius function in the app — it touches every already-
// extracted view's own close/flush logic on every switch, for every
// user), renderAll()/applyPermissionGating(), the per-field save
// wrappers, and the cross-project job-link data model. This is the
// second (and largest) slice of Phase 10 of the extraction plan
// ("Project management & the shared job/phase data model") — deliberately
// last among the risky work, same reasoning Sync/Presence was last in the
// original architecture roadmap: a mistake here can affect every user in
// a project at once. Regression tests cover switchProject()'s own
// flush-before-switch/fail-closed/scope-restriction guards and the
// linked-job data model before this code moved — see
// tests/unit-project.spec.js.
import { genId, safeJsonParse } from '../utils/id';
import { showToast } from '../utils/ui';
import { hasMinTier } from '../auth/permissions';
import {
  queueSharedSync, flushPendingRoomPush, pushProjectToShared, pushBoardColumnsToShared,
  pushWorkflowItemsToShared, pushFieldOptionsToShared, pushHeaderToShared, logActivity,
} from '../sync/outbound';
import { sendPresenceUpdate } from '../sync/presence';
import { renderGantt } from '../views/gantt';
import { renderCalendar, closeCalendarEventModal, ensureCalendarEventIds } from '../views/calendar';
import { renderBoard, closeCardModal } from '../views/board';
import { renderJobList, updateJobCount } from '../views/job-list';
import { renderMyChecklist } from '../views/checklist';
import { renderHomeDashboard } from '../views/home';
import { cancelEdit } from '../views/job-form';
import { applyThemeColor, applyProjectBgVisual, getSavedThemeColor, normalizeThemeColor, DEFAULT_THEME_COLOR } from './theme';
import { ensureCardIds, ensureJobTasksMatchColumns, ensureJobHasCards, migrateOrphanedCards } from '../core/jobs';

declare global {
  function editJob(jobId: string, phaseId?: string | null, subPhaseId?: string | null): void;
  // eslint-disable-next-line no-var
  var DEFAULT_JOBS: any[];
  // eslint-disable-next-line no-var
  var freshLocalSeed: boolean;
  // eslint-disable-next-line no-var
  var freshLocalSeedProjectIds: string[];
}

// ===== PROJECT MANAGEMENT =====
export const PROJECTS_KEY = 'aps-planner:projects-v2';
export const ACTIVE_PROJECT_KEY = 'aps-planner:active-project-v2';

// freshLocalSeed/freshLocalSeedProjectIds stay real `var`s in index.html
// (not owned here) — init() there reads freshLocalSeed as a bare global
// right after calling enforceFixedProjectSet() below. See their own
// comment in index.html for what they track.

export function migrateFromLegacy(): void {
  const oldTasks = localStorage.getItem('gantt_jobs_v4');
  const oldColumns = localStorage.getItem('gantt_board_columns_v1');
  const oldCards = localStorage.getItem('gantt_board_cards_v1');
  const oldFields = localStorage.getItem('gantt_board_field_options_v1');
  const oldTitle = localStorage.getItem('gantt_header_title_v2');
  const oldSub = localStorage.getItem('gantt_header_subtitle_v2');
  // Old shape was {c1,c2} (a header gradient) — c2 was the lighter/more
  // visible of the two, closest to what's now a single theme color.
  const oldThemeRaw = localStorage.getItem('gantt_header_theme_v1');
  const oldTheme = oldThemeRaw ? (function () { try { const t = JSON.parse(oldThemeRaw); return t.c2 || t.c1 || null; } catch (e) { return null; } })() : null;
  const oldBg = localStorage.getItem('gantt_header_bg_photo_v1');
  const oldBoardBg = localStorage.getItem('gantt_board_bg_photo_v1');

  const defaultId = 'project-' + Date.now();
  let jobList: any[] = [];
  if (oldTasks) {
    const parsed = JSON.parse(oldTasks);
    parsed.forEach(function (t: any) {
      jobList.push({
        id: genId(),
        name: t.job || 'Untitled Job',
        color: t.color || '#3949ab',
        archived: t.archived || false,
        notes: t.notes || '',
        tasks: [{
          id: t.id || genId(),
          name: t.job || 'Task',
          start: t.start,
          finish: t.finish,
          notes: t.notes || '',
          order: 0,
        }],
      });
    });
  } else {
    jobList = JSON.parse(JSON.stringify(DEFAULT_JOBS));
  }

  const project = {
    id: defaultId,
    name: oldTitle || 'Default Project',
    jobs: jobList,
    boardColumns: (oldColumns && JSON.parse(oldColumns).length) ? JSON.parse(oldColumns) : JSON.parse(JSON.stringify(DEFAULT_BOARD_COLUMNS)),
    boardCards: oldCards ? JSON.parse(oldCards) : [],
    fieldOptions: oldFields ? JSON.parse(oldFields) : {
      pm: [], foreman: [],
      jobType: ['New Home', 'Remodel', 'Commercial', 'Addition', 'Service Call'],
      timeframe: ['This Week', 'Next Week', 'This Month', 'This Quarter'],
      incentivePeriod: ['Q1', 'Q2', 'Q3', 'Q4'],
    },
    header: {
      title: oldTitle || 'TeamSync',
      subtitle: oldSub || '',
      theme: oldTheme || DEFAULT_THEME_COLOR,
      bgPhoto: oldBg || null,
      boardBgPhoto: oldBoardBg || null,
    },
  };
  projects[defaultId] = project;
  activeProjectId = defaultId;
  saveProjects();
  localStorage.setItem(ACTIVE_PROJECT_KEY, defaultId);

  if (!oldTasks && !oldColumns && !oldCards && !oldFields && !oldTitle && !oldSub && !oldTheme && !oldBg && !oldBoardBg) {
    freshLocalSeed = true;
    freshLocalSeedProjectIds.push(defaultId);
  }
}

export function loadProjects(): void {
  const saved = localStorage.getItem(PROJECTS_KEY);
  const active = localStorage.getItem(ACTIVE_PROJECT_KEY);
  // safeJsonParse(saved, null) — a corrupted PROJECTS_KEY value used to
  // throw here uncaught, halting the whole script before init() finishes
  // and leaving a blank page with no error shown. Falls back to the same
  // migrateFromLegacy() path already used for "nothing saved yet" rather
  // than a corrupted save being any worse than a fresh install.
  const parsed = saved ? safeJsonParse(saved, null) : null;
  if (parsed) {
    projects = parsed;
    activeProjectId = active && projects[active] ? active : Object.keys(projects)[0];
  } else {
    migrateFromLegacy();
  }
}

export function saveProjects(): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId as string);
}

export function getActiveProject(): any {
  return projects[activeProjectId as string];
}

export function switchProject(projectId: string): void {
  if (!projects[projectId] || projectId === activeProjectId) return;
  // Fail closed, not open, until the account's real tier/project assignment
  // is actually known — right after a page load/refresh, currentAssignedProjectId
  // still holds its default null (indistinguishable from "confirmed
  // unrestricted") until fetchRoomToken()'s first response comes back, which
  // would otherwise let a switch through during that brief window every time.
  if (!roleConfirmed) {
    showToast('Still confirming your account — try again in a moment', 'info');
    return;
  }
  // Below-Admin tiers can be restricted to one project (see
  // currentAssignedProjectId/enforceProjectScopeForRole()) — this is the
  // single choke point both switchProject() call sites go through
  // (toggleProject()'s button and jumpToLinkedJobReference()'s cross-project
  // link jump), so gating it here covers both without touching either caller.
  if (currentUserRole !== 'admin' && currentAssignedProjectId && projectId !== currentAssignedProjectId) {
    showToast("You're restricted to one project — ask an admin to change your assignment", 'error');
    return;
  }
  // The job/card/event forms hold IDs scoped to the OLD project's data —
  // left open across a project switch, autoSaveJobForm() would find no
  // matching job in the new project's array and (since a form with a name
  // typed in it materializes as a new job once autosave can't find the one
  // it thinks it's editing) could create a stray duplicate job in the WRONG
  // project. cancelEdit() flushes any pending edit to the OLD project
  // first (still correct while it's still the active one) before closing.
  cancelEdit();
  closeCardModal();
  closeCalendarEventModal();
  // Those flushes above can re-arm the debounced ROOM-sync push (see
  // flushPendingRoomPush()'s own comment) — must fire it now, synchronously,
  // while activeProjectId still correctly points at the OLD project.
  // Otherwise the 300ms timer fires after the flip below and pushes the
  // NEW project's data instead, silently dropping this edit from ever
  // reaching the shared room.
  flushPendingRoomPush();
  // The old project's job id means nothing in the new one — see
  // ganttFocusedJobId/buildVisibleTaskRows(). Same reasoning for the
  // "view as member" preview — see viewAsUsername/isJobVisibleToMe().
  ganttFocusedJobId = null;
  viewAsUsername = null;
  viewAsRole = null;
  activeProjectId = projectId;
  saveProjects();
  loadActiveProjectData();
  renderAll();
  const sidebar = document.getElementById('activitySidebar');
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    renderActivityLogSidebar();
  }
  logActivity('switched to project "' + projects[projectId].name + '"');
  showToast('Switched to "' + projects[projectId].name + '"', 'success');
  sendPresenceUpdate();
}

// Forces activeProjectId onto a restricted account's assigned project — a
// silent boot-time/reconnect correction, not a user-initiated switch, so it
// deliberately does NOT call switchProject() (which fires activity-log/
// toast/presence side effects appropriate for a deliberate click, not for
// this). Called from fetchRoomToken() (role/project assignment may arrive
// or change on any reconnect, not just first load) and again once the first
// real room snapshot lands, since fetchRoomToken() resolves before that
// snapshot arrives and `projects` may still only reflect stale localStorage
// at the point this first runs.
export function enforceProjectScopeForRole(): void {
  if (currentUserRole === 'admin' || !currentAssignedProjectId) return;
  if (!projects[currentAssignedProjectId]) return; // assigned project not loaded/known yet — fail open, not crash
  if (activeProjectId !== currentAssignedProjectId) {
    // Same reasoning as switchProject()'s own flushPendingRoomPush() call
    // — an admin reassigning this account to a different project while
    // it's mid-edit on the (about to be former) assigned one must not
    // silently drop that edit when this reconnect-triggered reassignment
    // yanks activeProjectId out from under it.
    flushPendingRoomPush();
    activeProjectId = currentAssignedProjectId;
    saveProjects();
    loadActiveProjectData();
    renderAll();
  }
}

// Adding, duplicating, and deleting projects is intentionally disabled —
// this app is locked to exactly two fixed projects (see
// enforceFixedProjectSet). These are kept as no-ops, rather than removed
// outright, so any leftover call site just shows a toast instead of erroring.
// ===== FIXED PROJECT SET =====
// This app is locked to exactly two projects. On load (and again after the
// initial Liveblocks sync resolves — since remote data can otherwise
// overwrite this local rename) it renames whatever the original single
// project was into "ADVANCED PRECUT SYSTEMS" and creates "BLUDORN BUILDERS"
// if it doesn't exist yet, so every browser and the shared room converge on
// the same two. Returns the ids of any project it created, so the caller
// can push just those to the shared room.
//
// IMPORTANT: this only ever CREATES a project, when there are fewer than
// two — it never renames an existing one. It used to also forcibly rename
// "whichever project came first" back to FIXED_PROJECT_NAMES[0]/[1] every
// single time it ran (this runs on every page load), which meant a rename
// would silently revert on the next reload. Nothing in the UI can rename a
// project any more (the old "Edit Header Title" settings item and
// renameProject() were removed — per-user request, project rename isn't
// needed), but saveActiveProject() still syncs p.name from the (hidden)
// header text on every save, so that path is harmless dead weight rather
// than actively wrong — so FIXED_PROJECT_NAMES is only ever used as a
// starter name for a newly
// created project, never re-asserted onto an existing one.
export const FIXED_PROJECT_NAMES = ['ADVANCED PRECUT SYSTEMS', 'BLUDORN BUILDERS'];

// Deterministic, not Date.now()-based: two browsers racing to bootstrap a
// genuinely empty shared room (see bootstrapFirstSnapshot() in
// src/sync/inbound.ts) each independently fabricate this project locally
// before pushing it. If the id were time-based, the two would almost never
// match, and the worker's ensureProject() (no dedup-by-name) would create
// two separate stored projects with the same name. A deterministic id
// means both racers compute the SAME id, so the second push just updates
// the project the first one already created instead of duplicating it.
export function slugifyFixedProjectName(name: string): string {
  return 'project-fixed-' + name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

export function enforceFixedProjectSet(): string[] {
  const changedIds: string[] = [];
  if (Object.keys(projects).length >= 2) return changedIds;

  function makeProject(id: string, name: string) {
    const p: any = {
      id: id,
      name: name,
      jobs: JSON.parse(JSON.stringify(DEFAULT_JOBS)),
      boardColumns: JSON.parse(JSON.stringify(DEFAULT_BOARD_COLUMNS)),
      boardCards: [],
      deletedIds: {},
      fieldOptions: {
        pm: [], foreman: [],
        jobType: ['New Home', 'Remodel', 'Commercial', 'Addition', 'Service Call'],
        timeframe: ['This Week', 'Next Week', 'This Month', 'This Quarter'],
        incentivePeriod: ['Q1', 'Q2', 'Q3', 'Q4'],
      },
      header: { title: name, subtitle: '', theme: DEFAULT_THEME_COLOR, bgPhoto: null, boardBgPhoto: null },
    };
    p.jobs.forEach(function (j: any) { if (!j.notes) j.notes = ''; });
    return p;
  }

  while (Object.keys(projects).length < 2) {
    // Whichever default name isn't already taken, so backfilling a second
    // project never creates a same-named duplicate of the first (e.g. a
    // solo project that already happens to be named FIXED_PROJECT_NAMES[0]).
    const usedNames = Object.values(projects).map(function (p: any) { return p.name; });
    const name = usedNames.indexOf(FIXED_PROJECT_NAMES[0]) === -1 ? FIXED_PROJECT_NAMES[0] : FIXED_PROJECT_NAMES[1];
    const id = slugifyFixedProjectName(name);
    projects[id] = makeProject(id, name);
    if (!activeProjectId) activeProjectId = id;
    // This id is just as much a locally-fabricated placeholder as the one
    // migrateFromLegacy() creates — same reasoning applies (see the
    // freshLocalSeedProjectIds comment above), or setupLiveblocksSync's
    // "is this browser's whole local project set just fake starter
    // content" check silently never fires for whichever placeholder was
    // created here instead of there.
    if (freshLocalSeed) freshLocalSeedProjectIds.push(id);
    changedIds.push(id);
  }

  if (changedIds.length) saveProjects();
  return changedIds;
}

export function loadActiveProjectData(): void {
  const p = getActiveProject();
  if (!p) return;
  if (p.tasks && !p.jobs) {
    p.jobs = [];
    p.tasks.forEach(function (t: any) {
      p.jobs.push({
        id: genId(),
        name: t.job || 'Untitled',
        color: t.color || '#3949ab',
        archived: t.archived || false,
        notes: t.notes || '',
        tasks: [{
          id: t.id || genId(),
          name: t.job || 'Task',
          start: t.start,
          finish: t.finish,
          notes: t.notes || '',
          order: 0,
        }],
      });
    });
    delete p.tasks;
    saveProjects();
  }
  jobs = ensureJobAndTaskIds(p.jobs || []);
  BOARD_COLUMNS = p.boardColumns || JSON.parse(JSON.stringify(DEFAULT_BOARD_COLUMNS));
  WORKFLOW_ITEMS = p.workflowItems || [];
  boardCards = ensureCardIds(p.boardCards || []);
  calendarEvents = ensureCalendarEventIds(p.calendarEvents || []);
  fieldOptions = p.fieldOptions || {};
  document.getElementById('headerTitle')!.textContent = p.header.title || 'TeamSync';
  document.getElementById('headerSubtitle')!.textContent = p.header.subtitle || '';
  if (p.header.theme) localStorage.setItem('gantt_theme_color_v1', normalizeThemeColor(p.header.theme));
  if (p.header.bgPhoto) localStorage.setItem('gantt_header_bg_photo_v1', p.header.bgPhoto);
  else localStorage.removeItem('gantt_header_bg_photo_v1');
  if (p.header.boardBgPhoto) localStorage.setItem('gantt_board_bg_photo_v1', p.header.boardBgPhoto);
  else localStorage.removeItem('gantt_board_bg_photo_v1');
  applyThemeColor();
  applyProjectBgVisual();

  // Section 6: link/adopt any cards that predate the jobId field, before
  // the schema-lock pass normalizes tasks and cards for every job below.
  migrateOrphanedCards();

  // Section 1: Schema Lock — normalize tasks and cards on load
  jobs.forEach(function (job) {
    ensureJobTasksMatchColumns(job);
    ensureJobHasCards(job);
  });
  saveActiveProject();
}

export function saveActiveProject(): void {
  const p = getActiveProject();
  if (!p) return;

  // Section 1: maintain schema invariant before saving
  jobs.forEach(function (job) {
    ensureJobTasksMatchColumns(job);
    ensureJobHasCards(job);
  });

  p.jobs = jobs;
  p.boardColumns = BOARD_COLUMNS;
  p.workflowItems = WORKFLOW_ITEMS;
  p.boardCards = boardCards;
  p.calendarEvents = calendarEvents;
  p.fieldOptions = fieldOptions;
  p.header.title = document.getElementById('headerTitle')!.textContent!.trim();
  // The header text IS the project/board name as far as anyone using the
  // app can tell — keep the two in sync so editing it (already possible,
  // it's contenteditable) actually renames the project everywhere its name
  // shows up (the project switcher's tooltip, etc.) instead of just
  // changing the display text while the underlying name silently stays the
  // old one. Guarded against blanking it out if the title is momentarily
  // empty mid-edit.
  if (p.header.title) p.name = p.header.title;
  p.header.subtitle = document.getElementById('headerSubtitle')!.textContent!.trim();
  p.header.theme = getSavedThemeColor();
  p.header.bgPhoto = localStorage.getItem('gantt_header_bg_photo_v1') || null;
  p.header.boardBgPhoto = localStorage.getItem('gantt_board_bg_photo_v1') || null;
  saveProjects();
}

export function toggleProject(): void {
  const ids = Object.keys(projects);
  if (ids.length < 2) return;
  const currentIdx = ids.indexOf(activeProjectId as string);
  const nextIdx = (currentIdx + 1) % ids.length;
  switchProject(ids[nextIdx]);
}

export function updateProjectToggle(): void {
  const item = document.getElementById('projectToggleBtn');
  const label = document.getElementById('projectToggleLabel');
  if (!item) return;
  // Fail closed until the real tier/project assignment is confirmed (see
  // roleConfirmed) — same reasoning as switchProject()'s own guard, applied
  // to the item itself so it doesn't sit there clickable during the brief
  // window right after a page load/refresh before that's known.
  // A restricted (non-admin, project-scoped) account has nothing to toggle
  // to — hiding the item entirely reads more honestly than leaving a
  // permanently-disabled control around, matching how this codebase already
  // hides irrelevant UI outright elsewhere (e.g. the mobile view switcher).
  // Kept as bespoke JS rather than data-min-tier since this depends on the
  // ACCOUNT's project assignment, not just its role tier.
  if (!roleConfirmed || (currentUserRole !== 'admin' && currentAssignedProjectId)) {
    (item as HTMLElement).style.display = 'none';
    return;
  }
  const ids = Object.keys(projects);
  if (ids.length < 2) {
    (item as HTMLElement).style.display = 'none';
    return;
  }
  (item as HTMLElement).style.display = '';
  const currentIdx = ids.indexOf(activeProjectId as string);
  const nextIdx = (currentIdx + 1) % ids.length;
  const nextProject = projects[ids[nextIdx]];
  if (label) label.textContent = 'Switch to ' + (nextProject ? nextProject.name : 'project');
}

export function renderAll(): void {
  renderGantt();
  renderJobList();
  updateJobCount();
  renderBoard();
  renderCalendar();
  renderMyChecklist();
  renderHomeDashboard();
  updateProjectToggle();
  applyPermissionGating();
}

// Sweeps every element tagged data-min-tier="<tier>" (added across this
// file's template strings — job/board/checklist/comment/settings controls)
// and disables inputs/buttons/selects or hides everything else per the
// current account's tier, via hasMinTier(). Runs at the end of renderAll()
// (called on init, every switchProject, and every remote snapshot refresh —
// see its own call sites) so it self-heals after any re-render without
// individual render functions needing to know about permissions at all.
// Extends this file's existing convention of disabling a control at render
// time rather than guarding inside the handler (e.g. the checklist
// visibility picker's `sel.disabled = !isAdmin`, see canAssignChecklistStages())
// — this is that same idea generalized across the whole app via one data
// attribute instead of one-off boolean checks per control.
export function applyPermissionGating(): void {
  document.querySelectorAll('[data-min-tier]').forEach(function (el) {
    const allowed = hasMinTier((el as HTMLElement).dataset.minTier!);
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA') {
      (el as HTMLInputElement).disabled = !allowed;
    } else {
      el.classList.toggle('perm-hidden', !allowed);
    }
  });
  // Job add/delete/duplicate, and the Archived Jobs list's own delete
  // button, get the same full-hide treatment — a greyed-out Delete/
  // Duplicate button sitting right in the job form reads as "still there"
  // even when inert. Delete/duplicate also have their own job-context
  // visibility (see editJob()/addNewJob(), which run before this on any
  // given call) — only ever overridden in the hide direction here, never
  // forced back visible (showing them for a brand-new unsaved job would be
  // wrong regardless of tier).
  const addJobBtn = document.querySelector('.job-rail-add-btn') as HTMLElement | null;
  if (addJobBtn) addJobBtn.style.display = hasMinTier('projectAdmin') ? '' : 'none';
  ['deleteBtn', 'duplicateJobBtn'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el && !hasMinTier('projectAdmin')) el.style.display = 'none';
  });
  document.querySelectorAll('#archivedJobsList [data-action="delete"]').forEach(function (el) {
    if (!hasMinTier('projectAdmin')) (el as HTMLElement).style.display = 'none';
  });
  // A SEPARATE second set entirely — renderJobList() builds its own
  // "+ Add Job" tile at the bottom of the scrolling list, plus a
  // copy/delete icon pair on every individual job card, none of which
  // share any element with the ones above (those live in the Jobs rail
  // header and the job edit form). Missed in the original pass since
  // they're a different button on a different part of the screen calling
  // the same underlying functions — hence still visibly "there" even after
  // duplicateJob()/promptDeleteJob()/addNewJob() were locked down at the
  // function level.
  const jobListAddBtn = document.querySelector('.job-list-add-btn') as HTMLElement | null;
  if (jobListAddBtn) jobListAddBtn.style.display = hasMinTier('projectAdmin') ? '' : 'none';
  if (!hasMinTier('projectAdmin')) {
    document.querySelectorAll('.job-card .copy-btn, .job-card .delete-btn').forEach(function (el) {
      (el as HTMLElement).style.display = 'none';
    });
  }
}

// Override old save functions to use project layer
export function saveJobs(): void {
  ensureJobAndTaskIds(jobs);
  jobs.forEach(function (job, i) { job.order = i; });
  autoArchiveJobs();
  saveActiveProject();
  queueSharedSync();
}

export function autoArchiveJobs(): void {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - ARCHIVE_CUTOFF_DAYS);
  let changed = false;
  jobs.forEach(function (job) {
    if (job.archived) return;
    const finishes = (job.tasks || []).map(function (t) { return new Date(t.finish + 'T00:00:00').getTime(); });
    const maxFinish = finishes.length ? Math.max.apply(null, finishes) : 0;
    if (maxFinish && new Date(maxFinish) < cutoff) {
      job.archived = true;
      changed = true;
    }
  });
  if (changed) {
    saveActiveProject();
    queueSharedSync();
    logActivity('auto-archived old jobs');
    showToast('Old jobs auto-archived', 'info');
  }
}

// Targeted, immediate pushes (not the debounced queueSharedSync()) — see
// pushBoardColumnsToShared()/pushFieldOptionsToShared() for why routine
// saves must never touch these two fields.
export function saveBoardColumns(): void { saveActiveProject(); pushBoardColumnsToShared(activeProjectId as string); }
export function saveWorkflowItems(): void { saveActiveProject(); pushWorkflowItemsToShared(activeProjectId as string); }
export function saveBoardCards(): void { ensureCardIds(boardCards); saveActiveProject(); queueSharedSync(); }
export function saveCalendarEvents(): void { ensureCalendarEventIds(calendarEvents); saveActiveProject(); queueSharedSync(); }
export function saveFieldOptions(): void { saveActiveProject(); pushFieldOptionsToShared(activeProjectId as string); }
// Uses the staleness-protected setHeader path (pushHeaderToShared), not
// the routine queueSharedSync() batch — the batch's header field has no
// revision check, so a snapshot arriving before it's acked could revert
// this edit back to whatever the server had before (see the comment on
// applyRoomSnapshot()'s header merge).
export function saveHeader(): void { saveActiveProject(); logActivity('updated header'); pushHeaderToShared(activeProjectId as string); }

// ===== Cross-project job links =====
// A link is per-job (not whole-project) and renders as a real,
// precisely-dated row on the Gantt/Calendar — never the Board — rather
// than a loosely-positioned translucent backdrop like the ghost overlay
// above. Stored symmetrically: linking job A (in project A) to job B (in
// project B) writes a `.link = { jobId, projectId }` on BOTH jobs,
// pointing at each other. THIS part — the link's existence — is shared,
// synced data: everyone should see that two jobs are linked.
//
// Whether the link is actually turned ON, though, is deliberately a
// per-browser localStorage preference (see LINK_ENABLED_KEY below), same
// as the ghost overlay — turning it on used to be shared/synced, meaning
// one person flipping it on made the linked job appear on everyone's
// schedule, which wasn't the intent (a report from real usage: it was
// "turning on for everyone" when only one person wanted to see it).
export const LINK_ENABLED_KEY = 'aps-planner:link-enabled-v1';
let localEnabledLinks: Record<string, boolean> = {}; // { [jobId]: true }

export function loadLinkEnabledPref(): void {
  try {
    const saved = localStorage.getItem(LINK_ENABLED_KEY);
    localEnabledLinks = saved ? JSON.parse(saved) : {};
  } catch (e) {
    localEnabledLinks = {};
  }
}
export function saveLinkEnabledPref(): void {
  localStorage.setItem(LINK_ENABLED_KEY, JSON.stringify(localEnabledLinks));
}
export function isLinkEnabledLocally(jobId: string): boolean {
  return !!localEnabledLinks[jobId];
}
// Mirrors both sides of the link locally, same as the old shared version
// mirrored both sides remotely — so turning it on from either job (or
// either project) shows consistently for THIS browser, without touching
// what anyone else sees.
export function setLinkEnabledLocally(jobId: string, otherJobId: string, enabled: boolean): void {
  if (enabled) { localEnabledLinks[jobId] = true; localEnabledLinks[otherJobId] = true; }
  else { delete localEnabledLinks[jobId]; delete localEnabledLinks[otherJobId]; }
  saveLinkEnabledPref();
}

export function getOtherFixedProjectId(projectId: string | null): string | null {
  return Object.keys(projects).find(function (id) { return id !== projectId; }) || null;
}

// One entry per active-project job whose link is turned on for THIS
// browser (see isLinkEnabledLocally), carrying the *referenced* job's own
// data (tasks/phases) tagged so every render seam can treat it as a
// normal-but-read-only row.
export function getLinkedReferenceJobs(): any[] {
  // Admin/Project Admin only — a stale "on" flag from before a tier
  // downgrade (see toggleJobLinkEnabledUI()) shouldn't keep leaking a
  // linked job in here.
  if (!hasMinTier('projectAdmin')) return [];
  return jobs.reduce(function (acc: any[], job) {
    const link = job.link as { jobId: string; projectId: string } | null | undefined;
    if (!link || !isLinkEnabledLocally(job.id)) return acc;
    const otherProj = projects[link.projectId];
    const refJob = otherProj && (otherProj.jobs || []).find(function (j: any) { return j.id === link.jobId; });
    if (!refJob) return acc; // the other job was deleted/unlinked remotely — nothing to show
    acc.push(Object.assign({}, refJob, {
      isLinkedReference: true,
      linkedFromProjectName: otherProj.name || '',
      linkedFromProjectId: link.projectId,
    }));
    return acc;
  }, []);
}

// Read-only rows/bars for a linked reference job route clicks here instead
// of editJob() — switches to its home project (if needed) and opens it
// there, rather than trying to edit a job that isn't this project's own.
export function jumpToLinkedJobReference(job: any): void {
  if (!job.isLinkedReference || !job.linkedFromProjectId) return;
  switchProject(job.linkedFromProjectId);
  editJob(job.id);
}

// jobA/projectAId identify a job in the CURRENT (active) project;
// jobBId/projectBId identify the job being linked to, which may live in
// either project. The link itself is shared (everyone should see the two
// jobs are linked) — whether it's turned ON is not (see
// isLinkEnabledLocally above), so there's no "enabled" here at all
// anymore; "link" and "turn on" are still deliberately two separate
// steps, the second one just doesn't leave this browser.
export function linkJobs(jobA: any, projectAId: string | null, jobBId: string, projectBId: string): boolean {
  const jobB = ((projects[projectBId] && projects[projectBId].jobs) || []).find(function (j: any) { return j.id === jobBId; });
  if (!jobB) return false;
  jobA.link = { jobId: jobB.id, projectId: projectBId };
  jobB.link = { jobId: jobA.id, projectId: projectAId };
  saveJobs();
  if (projectAId === activeProjectId) queueSharedSync(); else pushProjectToShared(projectAId as string);
  if (projectBId === activeProjectId) queueSharedSync(); else pushProjectToShared(projectBId);
  return true;
}

// Purely local now — no sync push. jobId/projectId can be the job the
// user has open OR the job it's linked to (both carry a mirrored `.link`
// pointing at each other); only the counterpart's id is actually needed,
// to mirror the on/off state locally for both sides of the link the same
// way the old shared version mirrored it for both sides remotely.
export function setJobLinkEnabled(jobId: string, projectId: string | null, enabled: boolean): void {
  const proj = projects[projectId as string];
  const job = proj && (proj.jobs || []).find(function (j: any) { return j.id === jobId; });
  if (!job || !job.link) return;
  setLinkEnabledLocally(job.id, job.link.jobId, enabled);
}

export function unlinkJobById(jobId: string, projectId: string | null): void {
  const proj = projects[projectId as string];
  const job = proj && (proj.jobs || []).find(function (j: any) { return j.id === jobId; });
  if (!job || !job.link) return;
  const otherProjectId = job.link.projectId;
  const otherJobId = job.link.jobId;
  const otherProj = projects[otherProjectId];
  const otherJob = otherProj && (otherProj.jobs || []).find(function (j: any) { return j.id === otherJobId; });
  // Local on/off state has no meaning once the link itself is gone.
  delete localEnabledLinks[jobId];
  delete localEnabledLinks[otherJobId];
  saveLinkEnabledPref();
  delete job.link;
  if (otherJob) delete otherJob.link;
  saveJobs();
  if (projectId === activeProjectId) queueSharedSync(); else pushProjectToShared(projectId as string);
  if (otherProjectId === activeProjectId) queueSharedSync(); else pushProjectToShared(otherProjectId);
}
