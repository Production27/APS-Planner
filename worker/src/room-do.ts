// --- THE DURABLE OBJECT ITSELF (this file is the sole source of
// truth for it; an earlier design-iteration copy that used to live at
// worker/aps-room-do.js — including the honest caveat about what could
// and couldn't be tested without a real Durable Objects runtime — was
// removed in commit a4da847) ---
import { verifyRoomToken } from './room-token.ts';
import { tierAtLeast } from './tiers.ts';
import {
  emptyRoomState, MESSAGE_TIER_REQUIREMENTS,
  filterRoomStateForAttachment, filterUpsertProjectBatchByTier, applyMessage
} from './room-state.ts';
import type { UpsertProjectBatchMessage } from './room-state.ts';
import type { RoomState, RoomMessage, Attachment } from './types.ts';

// A presence entry is dropped from the broadcast if its connection hasn't
// sent a setPresence heartbeat in this long — well above the client's
// heartbeat interval so a couple of missed beats (backgrounded tab,
// brief network hiccup) don't cause a false prune.
const PRESENCE_STALE_MS = 90 * 1000;

// What serializeAttachment()/deserializeAttachment() actually stores on
// each WebSocket — the connect-time identity plus presence fields that
// get updated on every setPresence heartbeat.
interface RoomAttachment extends Attachment {
  view: string | null;
  projectId: string | null;
  sessionId?: string | null;
  lastSeen?: number;
}

export class ApsRoom {
  state: DurableObjectState;
  env: Env;
  roomState: RoomState | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.roomState = null;

    if (typeof WebSocketRequestResponsePair !== 'undefined' && this.state.setWebSocketAutoResponse) {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async loadRoomState(): Promise<RoomState> {
    if (this.roomState) return this.roomState;
    const stored = await this.state.storage.get<RoomState>('room');
    this.roomState = stored || emptyRoomState();
    return this.roomState;
  }

  async persist(): Promise<void> {
    await this.state.storage.put('room', this.roomState);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/internal/export') {
      const roomState = await this.loadRoomState();
      return new Response(JSON.stringify(roomState), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/import' && request.method === 'POST') {
      let imported: RoomState;
      try {
        imported = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!imported || typeof imported !== 'object' || typeof imported.projects !== 'object') {
        return new Response(JSON.stringify({ error: 'expected { projects: {...} }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      this.roomState = imported;
      await this.persist();
      this.broadcastSnapshot();
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Called by handleUsersUpdate()/handleUsersRemove() (plain HTTP
    // handlers with no access to this DO's live sockets otherwise) right
    // after a role/project/removal change actually lands in KV — force-
    // closes that user's connection(s) so a stale role can't just keep
    // working until the token's own 24h expiry. Closing alone isn't
    // enough to fix stale permissions on its own (a plain reconnect would
    // just resend the same still-valid, now-stale token) — the client's
    // handleRoomClose() is what turns this specific close code into a
    // forced re-login instead of a silent reconnect.
    if (url.pathname === '/internal/kick-user' && request.method === 'POST') {
      const targetUsername = url.searchParams.get('username') || '';
      let kicked = 0;
      for (const ws of this.state.getWebSockets()) {
        const a = ws.deserializeAttachment() as RoomAttachment | null;
        if (a && a.username === targetUsername) {
          try { ws.close(4001, 'Permissions changed — please sign in again'); } catch (e) {}
          kicked++;
        }
      }
      return new Response(JSON.stringify({ success: true, kicked }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const identity = await verifyRoomToken(this.env.ROOM_TOKEN_SECRET, token);
    if (!identity) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    // view/projectId start null (see handlePresenceMessage below) and
    // live in this SAME attachment as identity specifically so they
    // survive hibernation too — a plain instance field would not.
    const attachment: RoomAttachment = {
      username: identity.username as string,
      displayName: identity.displayName as string,
      role: identity.role as string,
      assignedProjectId: (identity.assignedProjectId as string) || null,
      view: null,
      projectId: null
    };
    server.serializeAttachment(attachment);

    const roomState = await this.loadRoomState();
    const scoped = filterRoomStateForAttachment(roomState, attachment);
    server.send(JSON.stringify(Object.assign({ type: 'snapshot' }, scoped)));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Presence (who's currently looking at which tab/project) is
  // deliberately kept completely separate from applyMessage()/room
  // state: ephemeral connection metadata, never touches state.storage,
  // never persisted, never staleness/revision-checked. A bug here can
  // show a wrong avatar; it cannot lose or corrupt any actual data — this
  // returns before ever reaching applyMessage, and never calls persist().
  // sessionId is a random id the CLIENT generates once per page load and
  // includes on every setPresence call — the only reliable way to
  // recognize its own entry afterward. username doesn't work: anyone
  // connected via the shared team password gets username: null
  // server-side regardless of what they typed into the login prompt, so
  // comparing against the locally-typed username never matches — the
  // "seeing my own presence bubble as a phantom second user" bug
  // reported live.
  //
  // lastSeen + PRESENCE_STALE_MS below is a second, independent layer on
  // top of that: webSocketClose() is the fast path for a clean disconnect,
  // but a tab that's closed without one (crash, network drop) leaves a
  // hibernated connection in state.getWebSockets() that Cloudflare's
  // ping/pong heartbeat can take a while to notice is dead — in the
  // meantime it shows up as a ghost bubble nobody can dismiss (reported
  // live twice: once as a stray "TM" bubble, once as a duplicate "Josh"
  // bubble on someone else's screen). Since the client re-sends setPresence
  // periodically (see the index.html heartbeat), a live connection's
  // lastSeen never goes stale; one that stops updating gets quietly
  // dropped from the broadcast list on the next presence event, without
  // needing to actually close the underlying socket.
  handlePresenceMessage(ws: WebSocket, msg: { view?: unknown; projectId?: unknown; sessionId?: unknown }): void {
    const attachment = (ws.deserializeAttachment() || {}) as RoomAttachment;
    ws.serializeAttachment(Object.assign({}, attachment, {
      view: typeof msg.view === 'string' ? msg.view : null,
      projectId: typeof msg.projectId === 'string' ? msg.projectId : null,
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
      lastSeen: Date.now()
    }));
    this.broadcastPresence();
  }

  broadcastPresence(): void {
    const now = Date.now();
    const users: { username: string; displayName: string; view: string | null; projectId: string | null; sessionId: string | null }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as RoomAttachment | null;
      if (!a) continue;
      if (a.lastSeen && (now - a.lastSeen) > PRESENCE_STALE_MS) continue;
      users.push({ username: a.username, displayName: a.displayName, view: a.view || null, projectId: a.projectId || null, sessionId: a.sessionId || null });
    }
    const payload = JSON.stringify({ type: 'presence', users: users });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* dead socket — webSocketClose() cleans up */ }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: RoomMessage;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
      return;
    }

    if (msg && msg.type === 'setPresence') {
      this.handlePresenceMessage(ws, msg);
      return;
    }

    const roomState = await this.loadRoomState();

    // Content-write authorization: the token was already verified at
    // connect time (handleWebSocketUpgrade()) and its role/assignedProjectId
    // captured in the WebSocket's own attachment, so no per-message KV
    // round-trip is needed — resolveCaller() (users.ts) already accepts
    // up-to-token-TTL staleness for the same reason. A message with no
    // matching attachment (shouldn't happen post-upgrade, but don't trust it
    // blindly) is treated as unauthorized.
    const attachment = ws.deserializeAttachment() as RoomAttachment | null;
    const requiredTier = msg && MESSAGE_TIER_REQUIREMENTS[msg.type];
    if (requiredTier && (!attachment || !tierAtLeast(attachment.role, requiredTier))) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg && msg.msgId, message: 'Forbidden: requires ' + requiredTier + ' or higher' }));
      return;
    }
    // 'admin' always bypasses project scoping, same as every other project-
    // restriction check in this app (see switchProject()/
    // enforceProjectScopeForRole() in index.html) — an admin account can
    // have a stored assignedProjectId left over from before being promoted
    // (the client already ignores it for role==='admin'), and this check
    // was missing that same exemption, incorrectly blocking an unrestricted
    // admin's own cross-project writes (e.g. linking a job to the other
    // project — see linkJobs() in index.html, which deliberately writes to
    // BOTH fixed projects for exactly this feature).
    if (msg && msg.projectId && attachment && attachment.role !== 'admin' && attachment.assignedProjectId && msg.projectId !== attachment.assignedProjectId) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: 'Forbidden: outside your assigned project' }));
      return;
    }
    if (msg && msg.type === 'upsertProjectBatch' && attachment) {
      msg = Object.assign({ type: msg.type }, filterUpsertProjectBatchByTier(msg as unknown as UpsertProjectBatchMessage, roomState.projects[msg.projectId as string], attachment.role)) as RoomMessage;
    }

    const result = applyMessage(roomState, msg, attachment);

    if (result.error) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: result.error }));
      return;
    }
    if (result.rejected) {
      // The rejecting client applied its edit optimistically (this app has
      // always worked that way) before finding out the server already had
      // something newer — send fresh data immediately rather than leaving
      // their local view wrong until the next unrelated broadcast.
      ws.send(JSON.stringify(Object.assign({ type: 'rejected', msgId: msg.msgId }, result.rejected)));
      ws.send(JSON.stringify(Object.assign({ type: 'snapshot' }, filterRoomStateForAttachment(this.roomState as RoomState, attachment))));
      return;
    }
    if (result.ack) ws.send(JSON.stringify(result.ack));

    if (result.changed) {
      this.roomState = result.state;
      await this.persist();
      this.broadcastSnapshot();
    }
  }

  // Per-socket, not one shared payload — two connections can have
  // different assignedProjectId scoping (see filterRoomStateForAttachment()),
  // so what each one is allowed to receive can differ.
  broadcastSnapshot(): void {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as RoomAttachment | null;
      const scoped = filterRoomStateForAttachment(this.roomState as RoomState, attachment);
      const payload = JSON.stringify(Object.assign({ type: 'snapshot' }, scoped));
      try { ws.send(payload); } catch (e) { /* dead socket, webSocketClose() cleans up */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch (e) {}
    // So everyone else's presence list drops this person promptly
    // instead of waiting for the next unrelated broadcast.
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('APS room websocket error:', error);
  }
}
