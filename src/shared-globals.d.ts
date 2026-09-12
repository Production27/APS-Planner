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
import type { Job, BoardCard, BoardColumn, WorkflowItem } from './core/types';
import type { PresenceUser } from './sync/presence';

declare global {
  // ----- data state (still `var`-declared in index.html) -----
  // eslint-disable-next-line no-var
  var jobs: Job[];
  // eslint-disable-next-line no-var
  var boardCards: BoardCard[];
  // eslint-disable-next-line no-var
  var BOARD_COLUMNS: BoardColumn[];
  // eslint-disable-next-line no-var
  var WORKFLOW_ITEMS: WorkflowItem[];
  // eslint-disable-next-line no-var
  var DEFAULT_BOARD_COLUMNS: { id: string; label: string }[];
  // eslint-disable-next-line no-var
  var DEFAULT_STALLED_AFTER_DAYS: number;
  // eslint-disable-next-line no-var
  var COLOR_PRESETS: string[];
  // eslint-disable-next-line no-var
  var activeProjectId: string | null;
  // Every field this shape lists is actually read by at least one src/
  // file's push functions (jobs/boardCards/calendarEvents/header/
  // boardColumns/fieldOptions/workflowItems/fieldRevisions/deletedIds/
  // ...) — a narrower per-project type isn't worth maintaining just for
  // the handful of call sites that only read one field off it.
  // eslint-disable-next-line no-var
  var projects: Record<string, any>;
  // eslint-disable-next-line no-var
  var editingJobId: string | null;
  // eslint-disable-next-line no-var
  var homeExpandedWidgetId: string | null;
  // eslint-disable-next-line no-var
  var draggedCardId: string | null;
  // eslint-disable-next-line no-var
  var draggedColId: string | null;
  // eslint-disable-next-line no-var
  var cachedUserRoster: { username: string; displayName: string }[] | null;
  // eslint-disable-next-line no-var
  var viewAsUsername: string | null;
  // eslint-disable-next-line no-var
  var calendarViewMode: string;
  // eslint-disable-next-line no-var
  var CAL_BAR_H: number;
  // eslint-disable-next-line no-var
  var CAL_BAR_GAP: number;
  // eslint-disable-next-line no-var
  var CAL_DAYNUM_H: number;
  // eslint-disable-next-line no-var
  var DUE_MARKER_TASK_ID: string;
  // `close` is required because src/sync/outbound.ts's logout() calls
  // roomSocket.close() directly.
  // eslint-disable-next-line no-var
  var roomSocket: { readyState: number; send: (data: string) => void; close: () => void; addEventListener: (type: string, listener: (event: any) => void) => void } | null;
  // eslint-disable-next-line no-var
  var roomEverConnected: boolean;
  // eslint-disable-next-line no-var
  var pendingWrites: Map<string, { msg: Record<string, unknown>; sentAt: number }>;
  // eslint-disable-next-line no-var
  var latestPresenceUsers: PresenceUser[];

  // ----- functions (still `function`-declared in index.html) -----
  function saveJobs(): void;
  function saveProjects(): void;
  function saveBoardColumns(): void;
  function logActivity(text: string): void;
  function hasMinTier(tier: string): boolean;
  function isJobVisibleToMe(job: Job): boolean;
  function isFinishedColumnId(colId: string): boolean;
  function applyPermissionGating(): void;
  function ensureUserRosterLoaded(): Promise<void>;
  function getEffectiveRole(): string;
  function getStoredUsername(): string;
  function getStoredDisplayName(): string;
  function setStoredSessionToken(token: string | null): void;
  function updateProjectToggle(): void;
  function mergeTombstones(a: Record<string, number> | undefined, b: Record<string, number>): Record<string, number>;
  function renderJobList(): void;
  function renderGantt(): void;
  function renderBoard(): void;
  function renderHomeDashboard(): void;
  function renderActivityLogSidebar(): void;
  function refreshJobFormIfOpen(jobId: string): void;
  function setupScrollSync(): void;
  // The anonymous shape (rather than any one file's own CalJob/GanttJob
  // pseudo-type) is the deliberate common denominator every caller of
  // this one index.html function satisfies.
  function getJobDueMarkerTask(job: { id: string; name: string; [key: string]: unknown }, phaseId: string | null): { id: string; name: string; start?: string; finish?: string; [key: string]: unknown } | null;
}

export {};
