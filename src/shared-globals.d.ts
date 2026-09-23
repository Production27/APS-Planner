// Ambient type declarations for the index.html globals that more than
// one src/ file reads or calls. Each of these is a real `var`/`function`
// still living in index.html (not yet extracted) — this file just tells
// TypeScript its shape once, so every src/ file that touches it agrees.
// TypeScript's ambient global declaration merging requires every
// re-declaration of the same `var` to be structurally identical (not
// just compatible), so keeping each one in exactly one place, rather
// than copy-pasted per file, is what actually prevents two files' copies
// from silently drifting apart. `function` declarations are the
// exception — TypeScript treats repeated ones as overloads, so a
// function that genuinely needs a different, more specific type per
// caller (e.g. getVisibleJobs()) is deliberately left declared locally
// in whichever view files need that — see those files' own comments.
//
// This file needs no import/export to take effect — every other file
// under src/ (picked up via tsconfig's "include": ["src/**/*.ts"]) sees
// these as real globals automatically.
import type { Job, BoardCard, BoardColumn, WorkflowItem, CustomFieldDef } from './core/types';
import type { PresenceUser } from './sync/presence';

declare global {
  // ----- data state (still `var`/`const`-declared in index.html) -----
  const API_BASE_URL: string;
  var jobs: Job[];
  var boardCards: BoardCard[];
  var BOARD_COLUMNS: BoardColumn[];
  var WORKFLOW_ITEMS: WorkflowItem[];
  var DEFAULT_BOARD_COLUMNS: { id: string; label: string }[];
  var DEFAULT_STALLED_AFTER_DAYS: number;
  var COLOR_PRESETS: string[];
  // Real exports of src/views/board.ts now — src/views/job-form.ts reads
  // these three as bare ambient globals rather than importing them (same
  // idiom board.ts's own doc comment describes for its other
  // job-form.ts-shared functions).
  var DEFAULT_TASK_DURATION_DAYS: number;
  var CUSTOM_FIELD_DEFS: CustomFieldDef[];
  var TEAM_FIELD_KEYS: string[];
  var activeProjectId: string | null;
  var currentUserRole: string | null;
  var roleConfirmed: boolean;
  // Every field this shape lists is actually read by at least one src/
  // file's push functions (jobs/boardCards/calendarEvents/header/
  // boardColumns/fieldOptions/workflowItems/fieldRevisions/deletedIds/
  // ...) — a narrower per-project type isn't worth maintaining just for
  // the handful of call sites that only read one field off it.
  var projects: Record<string, any>;
  var editingJobId: string | null;
  var homeExpandedWidgetId: string | null;
  var draggedCardId: string | null;
  var draggedColId: string | null;
  var cachedUserRoster: { username: string; displayName: string; isLead: boolean }[] | null;
  var viewAsUsername: string | null;
  var calendarViewMode: string;
  var CAL_BAR_H: number;
  var CAL_BAR_GAP: number;
  var CAL_DAYNUM_H: number;
  var DUE_MARKER_TASK_ID: string;
  // `close` is required because src/sync/outbound.ts's logout() calls
  // roomSocket.close() directly.
  var roomSocket: { readyState: number; send: (data: string) => void; close: () => void; addEventListener: (type: string, listener: (event: any) => void) => void } | null;
  var roomEverConnected: boolean;
  var pendingWrites: Map<string, { msg: Record<string, unknown>; sentAt: number }>;
  var latestPresenceUsers: PresenceUser[];

  // ----- functions called ambiently (bare, not imported) from more than
  // one src/ file — most are real functions elsewhere in src/ by now
  // (saveJobs/saveProjects/saveBoardColumns/applyPermissionGating/
  // updateProjectToggle in src/app/project.ts, logActivity in
  // src/sync/outbound.ts, isJobVisibleToMe/getJobDueMarkerTask in
  // src/core/jobs.ts and src/views/gantt.ts, mergeTombstones in
  // src/app/boot.ts, renderJobList/renderGantt/renderBoard/
  // renderHomeDashboard/refreshJobFormIfOpen in their own view files);
  // isFinishedColumnId is the one still genuinely index.html-only. Kept
  // declared here rather than converted to a real import at every call
  // site — this file is just the one place their shared type is defined.
  function saveJobs(): void;
  function saveProjects(): void;
  function flushProjectsToLocalCache(): void;
  function saveBoardColumns(): void;
  function logActivity(text: string): void;
  function isJobVisibleToMe(job: Job): boolean;
  function isFinishedColumnId(colId: string): boolean;
  function applyPermissionGating(): void;
  function updateProjectToggle(): void;
  function mergeTombstones(a: Record<string, number> | undefined, b: Record<string, number>): Record<string, number>;
  function renderJobList(): void;
  function renderGantt(): void;
  function renderBoard(): void;
  function renderHomeDashboard(): void;
  function refreshJobFormIfOpen(jobId: string): void;
  // The anonymous shape (rather than any one file's own CalJob/GanttJob
  // pseudo-type) is the deliberate common denominator every caller
  // satisfies.
  function getJobDueMarkerTask(job: { id: string; name: string; [key: string]: unknown }, phaseId: string | null): { id: string; name: string; start?: string; finish?: string; [key: string]: unknown } | null;
}

export {};
