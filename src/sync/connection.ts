// Sync connection: the WebSocket connection lifecycle and its status
// indicator — initSyncIndicator/setSyncIndicator/
// scheduleOfflineEscalation/cancelOfflineEscalation/isBusyEditing/
// handleRoomOpen/handleRoomClose/handleRoomSocketError/
// handleRoomSocketMessageEvent/setupLiveblocksSync.
//
// Deliberately does NOT include handleRoomMessage() itself — the
// function handleRoomSocketMessageEvent() dispatches to — where the
// actual incoming-snapshot merge/conflict-resolution logic lives; see
// src/sync/inbound.ts.
//
// pendingWrites/sendRoomMessage/armStuckWriteWatch/clearPendingWrite/
// queueSharedSync/flushPendingRoomPush/pushLiveblocksState (the OUTBOUND
// half of sync — sending local changes out) live in src/sync/outbound.ts
// instead — this file is scoped to the connection's own lifecycle and
// status, not what flows over it once open.
//
// isBusyEditing() reads barMoveState/tickResizeState/barResizeState/
// calDragState (Gantt/Calendar's own drag-in-progress flags, in
// src/views/gantt.ts and src/views/calendar.ts) and draggedCardId/
// draggedColId (Board's own, in src/views/board.ts).
import { sendPresenceUpdate } from './presence';

// Ambient globals this file shares verbatim with other src/ files
// (roomSocket, roomEverConnected, pendingWrites, draggedCardId,
// draggedColId, setStoredSessionToken(), etc.) are declared once in
// src/shared-globals.d.ts, not repeated here.
declare global {
  function reauthenticateOnce(forceReprompt: boolean): Promise<unknown>;
  function buildRoomWsUrl(): Promise<string>;
  function handleRoomMessage(msg: unknown): void;
}

// Single small dot, bottom-right — replaces the old always-visible
// "connecting…/saving…/live" text badge, the full-width red top banner,
// and the stuck-write toast popup. Stays small and quiet at every state
// (no text, no popups) — but stays visibly PRESENT rather than
// disappearing entirely once connected, as a first cut of this redesign
// briefly did: a faint, low-opacity green dot when everything's fine, so
// there's still an at-a-glance "yes, this is live" to find if you go
// looking for it, without it demanding attention. Gets more noticeable
// only once there's something worth knowing: reconnecting (quiet amber,
// no motion) or an actual problem — offline for a while, or a change
// stuck unconfirmed (red, gently pulsing). Hovering it shows the
// specific reason via a native tooltip rather than a popup.
let syncDotEl: HTMLElement | null = null;
let offlineSince: number | null = null;
let offlineEscalateTimer: ReturnType<typeof setTimeout> | null = null;

function initSyncIndicator(): void {
  const dot = document.createElement('div');
  dot.id = 'syncDot';
  dot.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:9999;width:9px;height:9px;border-radius:50%;background:#43a047;opacity:0.35;pointer-events:auto;transition:opacity 0.4s ease,background 0.3s ease;box-shadow:0 1px 3px rgba(0,0,0,0.25);';
  document.body.appendChild(dot);
  syncDotEl = dot;
}

// state: 'ok' (faint green — connected, nothing wrong, the default/happy
// state most of the time), 'connecting' (quiet amber, e.g. initial
// connect or a fresh disconnect that might recover in a second or two),
// 'problem' (red, gently pulsing — offline long enough to matter, or a
// write that hasn't confirmed in 8+ seconds).
function setSyncIndicator(state: string, tooltip?: string): void {
  if (!syncDotEl) return;
  syncDotEl.title = tooltip || (state === 'ok' ? 'Live' : '');
  if (state === 'ok') {
    syncDotEl.style.opacity = '0.35';
    syncDotEl.style.background = '#43a047';
    syncDotEl.style.animation = 'none';
    return;
  }
  syncDotEl.style.opacity = '0.85';
  if (state === 'problem') {
    syncDotEl.style.background = '#e53935';
    syncDotEl.style.animation = 'syncDotPulse 1.6s ease-in-out infinite';
  } else {
    syncDotEl.style.background = '#f0ad4e';
    syncDotEl.style.animation = 'none';
  }
}

// Mirrors the old banner's debounce: a one-second wifi blip shouldn't
// escalate to the red/pulsing state, only a connection that's actually
// stayed down for a bit.
function scheduleOfflineEscalation(): void {
  if (offlineEscalateTimer !== null) clearTimeout(offlineEscalateTimer);
  if (!offlineSince) offlineSince = Date.now();
  offlineEscalateTimer = setTimeout(function () {
    setSyncIndicator('problem', "You're offline — changes aren't syncing. Try reloading once you're back online.");
  }, 8000);
}
function cancelOfflineEscalation(): void {
  if (offlineEscalateTimer !== null) clearTimeout(offlineEscalateTimer);
  offlineEscalateTimer = null;
  offlineSince = null;
}

function isBusyEditing(): boolean {
  const openModal = ['cardModal', 'themeModal', 'manageFieldsModal', 'deleteModal', 'calendarEventModal', 'manageColumnChecklistModal'].some(function (id) {
    const el = document.getElementById(id);
    return el && el.classList.contains('show');
  });
  if (openModal) return true;

  // A Gantt/Calendar bar drag or resize in progress is just as disruptable
  // by a mid-gesture remote refresh as typing in a form field is: a remote
  // update replaces `jobs` with freshly-parsed objects and renderGantt()/
  // renderCalendar() tear down and rebuild every bar element — while the
  // in-progress drag's state (barMoveState.bar, task references, etc.)
  // still points at the pre-refresh DOM/objects. Left unguarded, dropping
  // the drag after that lands on stale objects instead of the fresh ones,
  // which can end up mutating the wrong task's dates entirely.
  // draggedCardId/draggedColId are the Board's own drag-in-progress flags
  // (set/cleared by handleCardDragStart/End, handleColumnDragStart/End) —
  // same idiom as the Gantt/Calendar flags above, added here so a remote
  // snapshot mid-drag can't rebuild the board out from under the user the
  // same way it already can't for a Gantt/Calendar drag.
  if (barMoveState || tickResizeState || barResizeState || calDragState || draggedCardId || draggedColId) return true;

  const active = document.activeElement as HTMLElement | null;
  if (active) {
    if (active.isContentEditable) return true;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Only block if the focused input is actually inside the job form
      // (or the comments panel beside it, so a mid-draft comment isn't
      // disrupted by a remote refresh either)
      if (active.closest && (active.closest('#jobForm') || active.closest('#jobCommentsPanel'))) return true;
    }
  }
  return false;
}

function handleRoomOpen(): void {
  setSyncIndicator('ok');
  cancelOfflineEscalation();
  // Replay anything that didn't get confirmed before the connection
  // dropped — the server will just re-apply/re-ack it (upserts are
  // idempotent by id; a delete/tombstone replay is a harmless no-op if it
  // already landed; a stale whole-value replay gets correctly rejected +
  // re-synced the same as any other stale write).
  pendingWrites.forEach(function (entry) {
    // Unlike its fire-and-forget siblings elsewhere in this file, this is
    // resending real unsaved user data — armStuckWriteWatch()'s 8s timer
    // remains the actual safety net either way, but a silent failure here
    // shouldn't also be a silent one in the console.
    try { roomSocket!.send(JSON.stringify(entry.msg)); } catch (e) { console.error('Failed to resend pending write on reconnect', entry.msg, e); }
  });
  sendPresenceUpdate();
}

function handleRoomClose(event?: { code?: number }): void {
  // Close code 4001 = the server force-closed this connection because an
  // admin changed our role/project assignment (see the Worker's
  // /internal/kick-user, called from handleUsersUpdate/handleUsersRemove).
  // The cached token still encodes the OLD permissions and buildRoomWsUrl()
  // would happily reuse it on a plain reconnect (getSessionToken() only
  // re-authenticates when the cached token is actually expired) — clearing
  // it here forces a fresh interactive login instead, so the reconnect
  // picks up real, current permissions (or correctly fails if removed).
  if (event && event.code === 4001) {
    setStoredSessionToken(null);
    reauthenticateOnce(true);
  }
  // Escalate to the offline indicator on ANY close, not just one after a
  // previously-successful connection — a first-connection failure (cold
  // start, brief outage right at page load) used to leave the dot stuck on
  // "Connecting…" forever since roomEverConnected was still false.
  // scheduleOfflineEscalation() already dedupes via offlineSince/
  // clearTimeout, so calling it unconditionally here is safe.
  if (roomEverConnected) {
    setSyncIndicator('connecting', 'Reconnecting…');
  }
  scheduleOfflineEscalation();
}
function handleRoomSocketError(err: unknown): void {
  console.error('Room socket error', err);
}
function handleRoomSocketMessageEvent(event: { data: string }): void {
  try {
    handleRoomMessage(JSON.parse(event.data));
  } catch (err) {
    console.error('handleRoomMessage failed — a remote update may not have fully applied', err);
  }
}

async function setupLiveblocksSync(): Promise<void> {
  initSyncIndicator();
  setSyncIndicator('connecting', 'Connecting…');

  try {
    // Assigned to a variable rather than a string literal directly in the
    // import() call — a literal specifier makes TypeScript try to resolve
    // a real module (and its types) for it at compile time, which fails
    // for an arbitrary runtime CDN URL with no local declarations; a
    // non-literal specifier is exactly what makes TS fall back to typing
    // the whole result as `any` instead, same as this dynamic import
    // already behaved (untyped) before this file existed. esbuild's own
    // bundling behavior is unaffected either way — an absolute
    // http(s) specifier is already left external, not bundled, regardless
    // of whether it's a literal or a variable.
    const reconnectingWebSocketSpecifier = 'https://esm.sh/reconnecting-websocket@4.4.0';
    const { default: ReconnectingWebSocketCtor } = await import(reconnectingWebSocketSpecifier);

    roomSocket = new ReconnectingWebSocketCtor(buildRoomWsUrl, [], { maxRetries: Infinity });
    roomSocket!.addEventListener('open', handleRoomOpen);
    roomSocket!.addEventListener('close', handleRoomClose);
    roomSocket!.addEventListener('error', handleRoomSocketError);
    roomSocket!.addEventListener('message', handleRoomSocketMessageEvent);

    window.addEventListener('offline', function () { scheduleOfflineEscalation(); });

  } catch (err) {
    console.error('Room sync init failed:', err);
    setSyncIndicator('problem', 'Sync failed: ' + (err as Error).message);
  }
}

export {
  initSyncIndicator,
  setSyncIndicator,
  scheduleOfflineEscalation,
  cancelOfflineEscalation,
  isBusyEditing,
  handleRoomOpen,
  handleRoomClose,
  handleRoomSocketError,
  handleRoomSocketMessageEvent,
  setupLiveblocksSync,
};
