// Sync/Presence, moved out of index.html starting with Phase 7 of the
// architecture roadmap. Deliberately tackled LAST of everything — this is
// the real-time collaboration engine (WebSocket connection lifecycle,
// incoming-change merge/conflict-resolution, and presence) that every
// other view's save/load path ultimately calls into, and a bug here can
// silently affect every user in a project at once (lost/overwritten work),
// not just one person's own screen the way a Board/Calendar/Gantt bug
// would. Phased narrowest/lowest-risk first, same discipline as every
// prior phase, but with extra scrutiny given the stakes — see each
// sub-phase's own notes as they land.
//
//   Phase 7a — presence avatars (this file's initial content):
//     sendPresenceUpdate/presenceAvatarColor/presenceInitials/
//     presenceAnimDelay/renderPresenceAvatars. Purely cosmetic — "who
//     else is viewing this project right now" bubbles — with zero data-
//     mutation risk (worst case of a bug here is a wrong-colored or
//     missing avatar, never a corrupted job/task). Chosen as the
//     starting slice specifically because it's the lowest-stakes corner
//     of the whole sync system, the same "smallest/safest first" logic
//     used to open every other multi-phase extraction this session.
//
// roomSocket/activeProjectId/latestPresenceUsers/myPresenceSessionId/
// projects stay in index.html (the actual WebSocket connection, the
// active-project pointer, and the shared project-data map are all
// still-to-be-extracted sync/data-layer state) and are referenced below
// as ambient globals — converted let/const -> var where needed, same
// mechanism as every prior phase's cross-script globals.
import { escapeHtml } from '../utils/html';

declare global {
  // Shared verbatim with src/sync/connection.ts's and src/sync/outbound.ts's
  // identical ambient declaration for this same global — see connection.ts's
  // own comment on this line for why the shape must match exactly.
  // eslint-disable-next-line no-var
  var roomSocket: { readyState: number; send: (data: string) => void; close: () => void; addEventListener: (type: string, listener: (event: any) => void) => void } | null;
  // eslint-disable-next-line no-var
  var activeProjectId: string | null;
  // eslint-disable-next-line no-var
  var latestPresenceUsers: PresenceUser[];
  // eslint-disable-next-line no-var
  var myPresenceSessionId: string;
  // Widened to `any` values in Phase 7c (see src/sync/outbound.ts's
  // identical declaration and comment) — that file's push functions read
  // many more project fields than this file's read-only "what's this
  // project called" use, and every declaration of the same global must
  // stay structurally identical.
  // eslint-disable-next-line no-var
  var projects: Record<string, any>;
}

// Exported (Phase 7d) so src/sync/inbound.ts's handleRoomMessage() can
// reuse this exact named type for its own identical `latestPresenceUsers`
// ambient declaration, rather than duplicating an inline shape that could
// silently drift out of sync with this one.
export interface PresenceUser {
  sessionId?: string;
  username?: string;
  displayName?: string;
  projectId?: string | null;
  view?: string;
}

function sendPresenceUpdate(): void {
  if (!roomSocket || roomSocket.readyState !== 1) return;
  const tabEl = document.querySelector('.rail-tab.active');
  const view = tabEl ? tabEl.id.replace('tab-', '') : null;
  try {
    roomSocket.send(JSON.stringify({ type: 'setPresence', view: view, projectId: activeProjectId || null, sessionId: myPresenceSessionId }));
  } catch (e) { /* best-effort — a missed update just means a stale avatar briefly */ }
}
// Periodic re-affirm so the server can prune a ghost presence entry (a tab
// closed without a clean WebSocket close) instead of it lingering as a
// phantom bubble until someone manually finds and closes the stale tab —
// this happened live twice before this heartbeat existed. A stopped tab's
// entry simply stops getting refreshed and ages out server-side; nothing
// special has to happen client-side for cleanup.
setInterval(sendPresenceUpdate, 25000);

const PRESENCE_AVATAR_COLORS = ['#3949ab', '#00897b', '#c62828', '#f0ad4e', '#7e57c2', '#00acc1', '#8d6e63', '#5c6bc0'];
function presenceAvatarColor(key: string | null | undefined): string {
  key = key || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PRESENCE_AVATAR_COLORS[hash % PRESENCE_AVATAR_COLORS.length];
}
function presenceInitials(displayName: string | null | undefined): string {
  const parts = (displayName || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const PRESENCE_VIEW_LABELS: Record<string, string> = { gantt: 'Gantt Chart', board: 'Board', calendar: 'Calendar' };

// Deterministic per-user delay (not random-per-render, which would make
// the pulse visibly jitter/restart every time presence re-broadcasts) so
// a row of several avatars breathes at slightly different offsets
// instead of in rigid unison, without ever changing for the same person.
function presenceAnimDelay(key: string | null | undefined): number {
  key = key || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 17 + key.charCodeAt(i)) >>> 0;
  return (hash % 26) / 10; // 0.0s-2.5s
}

function renderPresenceAvatars(): void {
  const el = document.getElementById('presenceAvatars');
  if (!el) return;
  const others = latestPresenceUsers.filter(function (u) { return u.sessionId !== myPresenceSessionId; });
  el.innerHTML = others.map(function (u) {
    const name = u.displayName || u.username || 'Someone';
    const proj = u.projectId && projects[u.projectId] ? projects[u.projectId].name : '';
    const view = u.view ? (PRESENCE_VIEW_LABELS[u.view] || u.view) : '';
    const whereLabel = [view, proj].filter(Boolean).join(' — ');
    const title = whereLabel ? (name + ' — ' + whereLabel) : name;
    const delayKey = u.sessionId || u.username || name;
    return '<span class="presence-avatar" style="background:' + presenceAvatarColor(u.username || name) + ';animation-delay:' + presenceAnimDelay(delayKey) + 's;" title="' + escapeHtml(title) + '">' + escapeHtml(presenceInitials(name)) + '</span>';
  }).join('');
}

export {
  sendPresenceUpdate,
  presenceAvatarColor,
  presenceInitials,
  presenceAnimDelay,
  renderPresenceAvatars,
};
