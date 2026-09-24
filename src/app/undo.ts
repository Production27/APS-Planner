// Undo for high-impact actions (roadmap B7): deleting a job, deleting a
// phase, archiving a job, and deleting a board. Each shows a toast with an
// Undo button for UNDO_WINDOW_MS; only one action is undoable at a time —
// offering a new one finalizes the previous. Deliberately NOT used for
// moves or date changes (Karl's call: only the actions that lose things).
//
// Two shapes of undoable action:
//   - Plain restore (archive, phase, board): the change is saved and synced
//     immediately as always; undo() just puts things back, and commit() is
//     a no-op.
//   - Held-back delete (a job): the server tombstones deleted ids forever
//     (see handleUpsertJob() in worker/src/room-state.ts), so once a job's
//     delete reaches the server it can never be re-added under the same id
//     — and its id is what cross-project links point at. So the job is
//     removed and tombstoned LOCALLY only (the local tombstone keeps a
//     snapshot/delta from bringing it back meanwhile), and the actual
//     server delete is sent by commit(): when the window ends, when
//     another undoable action replaces it, when the project changes, or
//     when the page is closed. The pending delete is also written to
//     localStorage so a crash/kill mid-window still finishes it on the
//     next load instead of leaving it deleted here but not for anyone else.
import { deleteJobFromShared, deleteCardFromShared } from '../sync/outbound';

export const UNDO_WINDOW_MS = 10000;
const PENDING_DELETES_KEY = 'teamsync_pending_deletes_v1';

interface UndoableAction {
  undo: () => void;
  commit: () => void;
}

interface PendingJobDelete {
  projectId: string;
  jobId: string;
  cardIds: string[];
}

let current: UndoableAction | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;
let currentToast: HTMLElement | null = null;

function removeToast(): void {
  if (!currentToast) return;
  const t = currentToast;
  currentToast = null;
  t.style.animation = 'none';
  t.style.opacity = '0';
  t.style.transform = 'translateX(20px)';
  t.style.transition = 'all 0.3s ease';
  setTimeout(() => t.remove(), 300);
}

function clearCurrent(): UndoableAction | null {
  const a = current;
  current = null;
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
  removeToast();
  return a;
}

// Finalizes whatever is currently undoable (no-op if nothing is). Called
// before a project switch — every undo() works on the ACTIVE project's
// globals (jobs/boardCards/BOARD_COLUMNS), so it must never run after the
// active project has changed underneath it.
export function commitPendingUndo(): void {
  const a = clearCurrent();
  if (a) a.commit();
}

export function offerUndo(message: string, action: UndoableAction): void {
  commitPendingUndo();
  current = action;

  const container = document.getElementById('toastContainer')!;
  const toast = document.createElement('div');
  toast.className = 'toast info undo-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'undo-toast-btn';
  btn.textContent = 'Undo';
  btn.addEventListener('click', function () {
    const a = clearCurrent();
    if (a) a.undo();
  });
  toast.appendChild(text);
  toast.appendChild(btn);
  container.appendChild(toast);
  currentToast = toast;

  currentTimer = setTimeout(commitPendingUndo, UNDO_WINDOW_MS);
}

// ---- Held-back job delete ----

function readPending(): PendingJobDelete[] {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_DELETES_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function writePending(list: PendingJobDelete[]): void {
  try {
    if (list.length) localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_DELETES_KEY);
  } catch (e) { /* storage unavailable — the in-memory commit still runs */ }
}
function samePending(a: PendingJobDelete, b: PendingJobDelete): boolean {
  return a.projectId === b.projectId && a.jobId === b.jobId;
}

function sendJobDelete(p: PendingJobDelete): void {
  deleteJobFromShared(p.projectId, p.jobId);
  p.cardIds.forEach(function (id) { deleteCardFromShared(p.projectId, id); });
  writePending(readPending().filter(function (x) { return !samePending(x, p); }));
}

// Local-only tombstones: same map deleteFromSharedMap() writes, without the
// server message. Inbound sync already skips anything tombstoned here.
function tombstoneLocally(projectId: string, ids: string[]): void {
  const proj = projects[projectId];
  if (!proj) return;
  const add: Record<string, number> = {};
  ids.forEach(function (id) { add[String(id)] = Date.now(); });
  proj.deletedIds = mergeTombstones(proj.deletedIds, add);
}
function untombstoneLocally(projectId: string, ids: string[]): void {
  const proj = projects[projectId];
  if (!proj || !proj.deletedIds) return;
  ids.forEach(function (id) { delete proj.deletedIds[String(id)]; });
}

// Called by the delete-job flow AFTER it has already removed the job and
// its cards from the local arrays. restore() puts them back locally; the
// server never saw the delete, so nothing needs re-sending.
export function holdBackJobDelete(pending: PendingJobDelete, message: string, restore: () => void): void {
  tombstoneLocally(pending.projectId, [pending.jobId].concat(pending.cardIds));
  writePending(readPending().filter(function (x) { return !samePending(x, pending); }).concat([pending]));
  offerUndo(message, {
    undo: function () {
      untombstoneLocally(pending.projectId, [pending.jobId].concat(pending.cardIds));
      writePending(readPending().filter(function (x) { return !samePending(x, pending); }));
      restore();
    },
    commit: function () { sendJobDelete(pending); },
  });
}

// Boot: finish any delete a previous page load held back but never sent
// (tab killed mid-window). Messages queue in pendingWrites until the room
// socket opens, so this is safe to call before the connection is up.
export function finishLeftoverJobDeletes(): void {
  readPending().forEach(sendJobDelete);
}

// Page closing mid-window: send the held-back delete now, while the socket
// is still open, rather than leave it for the next load.
export function initUndo(): void {
  window.addEventListener('pagehide', commitPendingUndo);
}
