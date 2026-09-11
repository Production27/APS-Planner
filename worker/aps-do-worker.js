// ==========================================
// APS Planner — Worker (Durable Objects backend)
// LIVE — this is what's actually deployed at aps-planner-staging
// (confirmed via `wrangler deployments list` against this file's own git
// history). This file is the sole source of truth for everything in it —
// the old pre-migration Liveblocks-based worker, its README, and a set of
// design-iteration reference files this used to point readers to were all
// removed in commit a4da847 ("Remove stale unused worker reference
// files"); deploys go through wrangler.jsonc's wrangler-based pipeline.
// ==========================================
//
// Replaces Liveblocks entirely with a single Durable Object (ApsRoom,
// defined at the bottom of this file for now). Cloudflare requires a
// Durable Object's class to live in the same DEPLOYED script as the
// binding that references it — but that's a bundling requirement, not a
// source-file one: wrangler bundles a Worker's local ES module imports
// into one script automatically (confirmed via Cloudflare's own Durable
// Objects docs), so this file is mid-way through being split into
// worker/src/*.js modules that wrangler.jsonc's `main` will bundle back
// together. Functions still get pulled out of here into worker/src/ one
// at a time — see the git log for the in-progress split. The
// user-accounts section is carried over byte-for-byte unchanged from
// aps-liveblocks-worker.js — confirmed independent of Liveblocks by
// exploration before this migration started.
//
// New bindings this file needs beyond what's already configured:
//   APS_ROOM        Durable Object namespace, class name "ApsRoom",
//                    pointing at this same script.
//   ROOM_TOKEN_SECRET  Secret (Settings -> Variables and Secrets) — any
//                    long random string, used to sign/verify room
//                    connection tokens. Generate once, never reuse
//                    TEAM_PASSWORD or LIVEBLOCKS_SECRET_KEY for this.
// Everything else (BACKUP_BUCKET, USERS_KV, TEAM_PASSWORD) is reused
// as-is from the current worker.
//
// Attachments (card/job file uploads) now live in R2 under an
// attachments/ prefix in the SAME BACKUP_BUCKET, rather than inline
// base64 in the synced data — see the attachment endpoints below. This
// was a late addition to the migration, decided after noticing the
// original design (one JSON blob per room, broadcast on every change)
// would otherwise grow unboundedly with every photo/PDF someone attaches.

import { VALID_TIERS, tierAtLeast } from './src/tiers.js';
import { verifyRoomToken } from './src/room-token.js';
import { getRoomStub } from './src/room-stub.js';
import {
  emptyRoomState, MESSAGE_TIER_REQUIREMENTS,
  filterRoomStateForAttachment, filterUpsertProjectBatchByTier, applyMessage
} from './src/room-state.js';
import { handleAuth } from './src/auth.js';
import { runBackup, handleTriggerBackup, handleListBackups, handleDownloadBackup, handleRestoreBackup } from './src/backup.js';
import {
  handleUsersList, handleUsersRoster, handleUsersAdd,
  handleUsersUpdate, handleUsersRemove, handleUsersResetPassword
} from './src/users-admin.js';
import { handleAttachmentUpload, handleAttachmentDownload, handleAttachmentDelete } from './src/attachments.js';
import { handleReportError, handleErrorsList } from './src/errors.js';

// A presence entry is dropped from the broadcast if its connection hasn't
// sent a setPresence heartbeat in this long — well above the client's
// heartbeat interval so a couple of missed beats (backgrounded tab,
// brief network hiccup) don't cause a false prune. (Stays here rather than
// in room-state.js: it's connection/presence-layer state, consumed only by
// ApsRoom.broadcastPresence() below — this constant moves into
// worker/src/room-do.js once the DO class itself does, in a later split
// phase.)
const PRESENCE_STALE_MS = 90 * 1000;

// --- 9. WORKER ENTRYPOINTS ---
export default {
  async scheduled(controller, env, ctx) {
    await runBackup(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      // X-Aps-Token — attachment upload sends the session token as a
      // header instead of a query param (its POST body is the raw file
      // bytes, not JSON, so there's no body field to put it in) — see
      // handleAttachmentUpload().
      "Access-Control-Allow-Headers": "Content-Type, X-Aps-Token",
      "Cache-Control": "no-store",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Realtime room connection — the client opens a WebSocket here with
    // ?token=... (minted by POST / below). Auth is checked by the
    // Durable Object itself on upgrade, not here; this just routes to
    // the one shared room instance.
    if (url.pathname === "/room" && request.headers.get("Upgrade") === "websocket") {
      return getRoomStub(env).fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/auth") {
      return handleAuth(request, env, corsHeaders, ctx);
    }

    if (url.pathname === "/trigger-backup" && request.method === "POST") {
      return handleTriggerBackup(request, env, corsHeaders);
    }
    if (url.pathname === "/list-backups" && request.method === "POST") {
      return handleListBackups(request, env, corsHeaders);
    }
    // POST-only, credentials in the JSON body — was GET with
    // username/password/key as query params, which lands verbatim in
    // Worker access logs on every download. The client now fetch()es this
    // (instead of window.open(), which can't send a POST body) and turns
    // the response into a local download itself.
    if (url.pathname === "/download-backup" && request.method === "POST") {
      return handleDownloadBackup(request, env, corsHeaders);
    }
    // Same reasoning as /download-backup above — POST + JSON body instead
    // of the admin password sitting in a GET query string.
    if (url.pathname === "/restore-backup" && request.method === "POST") {
      return handleRestoreBackup(request, env, corsHeaders);
    }

    if (url.pathname === "/users/list" && request.method === "POST") {
      return handleUsersList(request, env, corsHeaders);
    }
    if (url.pathname === "/users/roster" && request.method === "POST") {
      return handleUsersRoster(request, env, corsHeaders);
    }
    if (url.pathname === "/users/add" && request.method === "POST") {
      return handleUsersAdd(request, env, corsHeaders);
    }
    if (url.pathname === "/users/update" && request.method === "POST") {
      return handleUsersUpdate(request, env, corsHeaders);
    }
    if (url.pathname === "/users/remove" && request.method === "POST") {
      return handleUsersRemove(request, env, corsHeaders);
    }
    if (url.pathname === "/users/reset-password" && request.method === "POST") {
      return handleUsersResetPassword(request, env, corsHeaders);
    }

    if (url.pathname === "/report-error" && request.method === "POST") {
      return handleReportError(request, env, corsHeaders);
    }
    if (url.pathname === "/errors/list" && request.method === "POST") {
      return handleErrorsList(request, env, corsHeaders);
    }

    if (url.pathname === "/attachments/upload" && request.method === "POST") {
      return handleAttachmentUpload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/download") {
      return handleAttachmentDownload(request, env, corsHeaders, url);
    }
    if (url.pathname === "/attachments/delete" && request.method === "POST") {
      return handleAttachmentDelete(request, env, corsHeaders);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};

// --- 10. THE DURABLE OBJECT ITSELF (this file is the sole source of
// truth for it; an earlier design-iteration copy that used to live at
// worker/aps-room-do.js — including the honest caveat about what could
// and couldn't be tested without a real Durable Objects runtime — was
// removed in commit a4da847) ---

export class ApsRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.roomState = null;

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
        const a = ws.deserializeAttachment();
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

    this.state.acceptWebSocket(server);
    // view/projectId start null (see handlePresenceMessage below) and
    // live in this SAME attachment as identity specifically so they
    // survive hibernation too — a plain instance field would not.
    server.serializeAttachment({ username: identity.username, displayName: identity.displayName, role: identity.role, assignedProjectId: identity.assignedProjectId || null, view: null, projectId: null });

    const roomState = await this.loadRoomState();
    const scoped = filterRoomStateForAttachment(roomState, identity);
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

    // Content-write authorization: the token was already verified at
    // connect time (handleWebSocketUpgrade()) and its role/assignedProjectId
    // captured in the WebSocket's own attachment, so no per-message KV
    // round-trip is needed — this file's own resolveCaller() already accepts
    // up-to-token-TTL staleness for the same reason. A message with no
    // matching attachment (shouldn't happen post-upgrade, but don't trust it
    // blindly) is treated as unauthorized.
    const attachment = ws.deserializeAttachment();
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
      msg = filterUpsertProjectBatchByTier(msg, roomState.projects[msg.projectId], attachment.role);
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
      ws.send(JSON.stringify(Object.assign({ type: 'snapshot' }, filterRoomStateForAttachment(this.roomState, attachment))));
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
  broadcastSnapshot() {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      const scoped = filterRoomStateForAttachment(this.roomState, attachment);
      const payload = JSON.stringify(Object.assign({ type: 'snapshot' }, scoped));
      try { ws.send(payload); } catch (e) { /* dead socket, webSocketClose() cleans up */ }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (e) {}
    // So everyone else's presence list drops this person promptly
    // instead of waiting for the next unrelated broadcast.
    this.broadcastPresence();
  }

  async webSocketError(ws, error) {
    console.error('APS room websocket error:', error);
  }
}
