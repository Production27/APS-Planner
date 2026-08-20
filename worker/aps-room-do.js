// ==========================================
// APS Planner — Room Durable Object
// ==========================================
//
// The actual real-time backend, replacing Liveblocks' hosted room. Thin
// by design: all the correctness logic (staleness rejection, tombstones,
// delete-safety) lives in the pure, already-tested aps-room-state.js —
// this file is just the WebSocket/hibernation plumbing and
// state.storage persistence wrapped around it. Auth verification uses
// aps-room-token.js's signed tokens, checked here without any KV access
// of its own (the KV-backed credential check already happened once, in
// the main Worker's auth endpoint, before a token was ever minted).
//
// IMPORTANT — flagged honestly rather than glossed over: this file was
// written and reasoned through carefully, but could NOT be run against a
// real Durable Objects runtime while building it (no wrangler/local
// Workers runtime available in this dev environment). The pure logic it
// calls into (applyMessage, signRoomToken/verifyRoomToken) is fully
// tested; the Cloudflare-specific plumbing here (acceptWebSocket,
// setWebSocketAutoResponse, serializeAttachment, the exact shape of the
// constructor's first argument) is written to match Cloudflare's
// documented Hibernation WebSocket API as of this writing, but has NOT
// been exercised end to end. Verifying this against a real staging
// deployment is an explicit, required step before any production
// cutover — see the migration plan.
//
// ---- Wire protocol ----
// Client -> DO (over the WebSocket): JSON messages matching
// aps-room-state.js's applyMessage() input shape, e.g.
//   { type: 'upsertJob', msgId, projectId, job: {...} }
//   { type: 'setBoardColumns', msgId, projectId, value: [...], baseFieldRevision }
// DO -> client:
//   { type: 'snapshot', projects: {...} }        — sent on connect, and
//                                                    broadcast after every
//                                                    accepted change
//   { type: 'ack', msgId, newFieldRevision? }     — one per processed message
//   { type: 'rejected', msgId, reason, ... }       — stale whole-value write
//   { type: 'error', msgId?, message }             — malformed/invalid message
//
// ---- Storage ----
// The whole room state lives under ONE storage key ('room') as a single
// JSON blob. Deliberate, not a placeholder: current data is ~59KB, well
// under any per-key limit, and a single key means every read/write is
// trivially atomic with no multi-key transaction to reason about. If
// data size ever becomes a real concern (e.g. a huge attachment volume —
// though attachments themselves are stored in R2, not inline, precisely
// to avoid this) this would need revisiting, but doing that now would be
// solving a problem that doesn't exist yet.

// A presence entry is dropped from the broadcast if its connection hasn't
// sent a setPresence heartbeat in this long — well above the client's
// heartbeat interval so a couple of missed beats (backgrounded tab,
// brief network hiccup) don't cause a false prune.
const PRESENCE_STALE_MS = 90 * 1000;

class ApsRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.roomState = null; // hydrated lazily on first use, cached for the DO's in-memory lifetime (cleared naturally on hibernation eviction/restart, re-loaded from storage on next access)

    // Cloudflare answers "ping" with "pong" at the edge without waking
    // this object — the whole point of pairing hibernation with a
    // heartbeat. Configuring this in the constructor also means it's
    // re-applied every time the DO wakes from hibernation and the
    // constructor re-runs, not just on first creation.
    if (typeof WebSocketRequestResponsePair !== 'undefined' && this.state.setWebSocketAutoResponse) {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async loadRoomState() {
    if (this.roomState) return this.roomState;
    const stored = await this.state.storage.get('room');
    this.roomState = stored || emptyRoomState();
    return this.roomState;
  }

  async persist() {
    await this.state.storage.put('room', this.roomState);
  }

  // Only ever reachable via env.APS_ROOM.get(id).fetch(...) from the main
  // Worker's own code (server-to-server) — there is no public route that
  // forwards arbitrary paths into this DO, so /internal/* needs no auth
  // of its own; the caller (the main Worker's backup/restore handlers)
  // already gated who's allowed to trigger this before ever reaching here.
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/export') {
      const roomState = await this.loadRoomState();
      return new Response(JSON.stringify(roomState), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/internal/import' && request.method === 'POST') {
      let imported;
      try {
        imported = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!imported || typeof imported !== 'object' || typeof imported.projects !== 'object') {
        return new Response(JSON.stringify({ error: 'expected { projects: {...} }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      // One synchronous assignment + one storage write, no awaits in
      // between — the DO's single-threaded message processing only
      // protects a restore from interleaving with a concurrent live edit
      // if the whole thing happens as one atomic step like this, not
      // spread across multiple awaited writes a queued message could
      // land in the middle of.
      this.roomState = imported;
      await this.persist();
      this.broadcastSnapshot();
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleWebSocketUpgrade(request) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    const identity = await verifyRoomToken(this.env.ROOM_TOKEN_SECRET, token);
    if (!identity) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Registers the socket with the runtime so it can hibernate between
    // messages instead of holding this DO in memory (and billing GB-s)
    // for the entire connection lifetime — this is the actual capability
    // this whole migration is for.
    this.state.acceptWebSocket(server);
    // Recall who this connection belongs to after a hibernation wake
    // without re-verifying the token on every single message — the
    // token was already checked once, right here, at connect time.
    // view/projectId start null (see setPresence handling below) and
    // live in this SAME attachment specifically so they survive
    // hibernation too, the same way identity already does — a plain
    // instance field (e.g. this.presence = new Map()) would NOT survive
    // a hibernation eviction/restart, since only serializeAttachment()
    // data does.
    server.serializeAttachment({ username: identity.username, displayName: identity.displayName, role: identity.role, view: null, projectId: null });

    const roomState = await this.loadRoomState();
    server.send(JSON.stringify(Object.assign({ type: 'snapshot' }, roomState)));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Presence (who's currently looking at which tab/project) is
  // deliberately kept completely separate from applyMessage()/room
  // state: it's ephemeral connection metadata, not data — never touches
  // state.storage, never persisted, never goes through staleness/
  // revision checks. A bug here can show a wrong avatar; it can't lose
  // or corrupt anyone's actual jobs/cards/boards, by construction (this
  // handler returns before ever reaching applyMessage for this message
  // type, and nothing here ever calls this.persist()).
  // sessionId is a random id the CLIENT generates once per page load and
  // includes on every setPresence call — the only reliable way for that
  // client to recognize its own entry in the broadcast list afterward.
  // username doesn't work for this: anyone connected via the shared team
  // password gets username: null server-side regardless of what they
  // typed into the login prompt, so two different people on that path
  // (or one person comparing against their own locally-typed username,
  // which never matches the server's null) would either collide with
  // each other or never match themselves — this is exactly the "seeing
  // my own presence bubble as a phantom second user" bug reported live.
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
  handlePresenceMessage(ws, msg) {
    const attachment = ws.deserializeAttachment() || {};
    ws.serializeAttachment(Object.assign({}, attachment, {
      view: typeof msg.view === 'string' ? msg.view : null,
      projectId: typeof msg.projectId === 'string' ? msg.projectId : null,
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
      lastSeen: Date.now()
    }));
    this.broadcastPresence();
  }

  broadcastPresence() {
    const now = Date.now();
    const users = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      if (a.lastSeen && (now - a.lastSeen) > PRESENCE_STALE_MS) continue;
      users.push({ username: a.username, displayName: a.displayName, view: a.view || null, projectId: a.projectId || null, sessionId: a.sessionId || null });
    }
    const payload = JSON.stringify({ type: 'presence', users: users });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* dead socket — webSocketClose() cleans up */ }
    }
  }

  async webSocketMessage(ws, message) {
    let msg;
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
    const result = applyMessage(roomState, msg);

    if (result.error) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: result.error }));
      return;
    }

    if (result.rejected) {
      // The rejecting client applied its edit optimistically (this app has
      // always worked that way — local state updates immediately, sync
      // happens in the background) before finding out the server already
      // had something newer. Their local view is now wrong until they get
      // fresh data — send it immediately rather than leaving them stale
      // until the next unrelated snapshot broadcast happens to correct it.
      ws.send(JSON.stringify(Object.assign({ type: 'rejected', msgId: msg.msgId }, result.rejected)));
      ws.send(JSON.stringify(Object.assign({ type: 'snapshot' }, this.roomState)));
      return;
    }

    if (result.ack) ws.send(JSON.stringify(result.ack));

    if (result.changed) {
      this.roomState = result.state;
      await this.persist();
      this.broadcastSnapshot();
    }
  }

  broadcastSnapshot() {
    const payload = JSON.stringify(Object.assign({ type: 'snapshot' }, this.roomState));
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch (e) {
        // Dead socket — webSocketClose() below will clean up the
        // connection itself; nothing further to do here.
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch (e) {
      // Already closed — fine.
    }
    // So everyone else's presence list drops this person promptly
    // instead of waiting for the next unrelated broadcast.
    this.broadcastPresence();
  }

  async webSocketError(ws, error) {
    console.error('APS room websocket error:', error);
  }
}

// Attached to globalThis (rather than only `export`ed) so this file can
// be concatenated directly into the single deployable Worker file, same
// no-build-step pattern as everything else in this repo — see
// worker/README.md for the assembly/deploy process.
if (typeof module !== 'undefined') module.exports = { ApsRoom };
