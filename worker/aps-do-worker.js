// ==========================================
// APS Planner — Worker (Durable Objects backend)
// LIVE — this is what's actually deployed at aps-planner-staging
// (confirmed via `wrangler deployments list` against this file's own git
// history). worker/aps-liveblocks-worker.js and this file's README.md
// describe the OLD pre-migration Liveblocks-based worker and its
// hand-paste deploy process — both stale, superseded by this file and
// wrangler.jsonc's wrangler-based deploy.
// ==========================================
//
// Replaces Liveblocks entirely with a single Durable Object (ApsRoom,
// defined at the bottom of this file — Cloudflare requires a Durable
// Object's class to live in the same deployed script as the binding that
// references it, hence one big file rather than several small ones, same
// as every other Worker in this repo). The user-accounts section is
// carried over byte-for-byte unchanged from aps-liveblocks-worker.js —
// confirmed independent of Liveblocks by exploration before this
// migration started.
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

// --- 1. ROOM STATE REDUCER (pure logic — see worker/aps-room-state.js
// in the repo for the source-of-truth copy with full design-rationale
// comments; inlined here verbatim since Workers has no local import) ---

const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_LOG_CAP = 50;
// A presence entry is dropped from the broadcast if its connection hasn't
// sent a setPresence heartbeat in this long — well above the client's
// heartbeat interval so a couple of missed beats (backgrounded tab,
// brief network hiccup) don't cause a false prune.
const PRESENCE_STALE_MS = 90 * 1000;

function mergeTombstones(a, b) {
  const merged = Object.assign({}, a || {}, b || {});
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  Object.keys(merged).forEach(function (id) {
    if (!merged[id] || merged[id] < cutoff) delete merged[id];
  });
  return merged;
}

function blankProject(name) {
  return {
    name: name || 'Untitled Project',
    jobs: {},
    boardCards: {},
    calendarEvents: {},
    boardColumns: [],
    fieldOptions: {},
    deletedIds: {},
    header: { title: name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } },
    activityLog: [],
    rev: 0,
    fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 }
  };
}

function cloneRoomState(state) {
  return JSON.parse(JSON.stringify(state));
}

function ensureProject(state, projectId, seedName) {
  if (state.projects[projectId]) return state;
  const next = cloneRoomState(state);
  next.projects[projectId] = blankProject(seedName);
  return next;
}

function emptyRoomState() {
  return { projects: {} };
}

function handleUpsertJob(project, msg) {
  const job = msg.job;
  if (!job || !job.id) return { project, changed: false, error: 'upsertJob missing job.id' };
  if (project.deletedIds[job.id]) return { project, changed: false };
  const existing = project.jobs[job.id];
  const incomingUpdatedAt = job.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.jobs[job.id] = job;
  next.rev++;
  return { project: next, changed: true };
}

function handleUpsertCard(project, msg) {
  const card = msg.card;
  if (!card || !card.id) return { project, changed: false, error: 'upsertCard missing card.id' };
  if (project.deletedIds[String(card.id)]) return { project, changed: false };
  const existing = project.boardCards[card.id];
  const incomingUpdatedAt = card.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.boardCards[card.id] = card;
  next.rev++;
  return { project: next, changed: true };
}

function handleUpsertCalendarEvent(project, msg) {
  const event = msg.event;
  if (!event || !event.id) return { project, changed: false, error: 'upsertCalendarEvent missing event.id' };
  if (project.deletedIds[String(event.id)]) return { project, changed: false };
  const existing = project.calendarEvents[event.id];
  const incomingUpdatedAt = event.updatedAt || 0;
  if (existing && (existing.updatedAt || 0) > incomingUpdatedAt) {
    return { project, changed: false, rejected: 'stale' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.calendarEvents[event.id] = event;
  next.rev++;
  return { project: next, changed: true };
}

// The client's routine (debounced) save batches every job/card/calendar-
// event in the active project into ONE message rather than one per item —
// keeps a save touching a few dozen items down to one storage write and
// one broadcast instead of dozens of each. Each item inside still gets
// its own independent staleness check. header is intentionally NOT
// staleness-protected here (unlike setBoardColumns/setFieldOptions/
// setHeader's baseFieldRevision) — see worker/aps-room-state.js's fuller
// comment on this function for why that's a deliberate, known, low-
// priority gap carried over from the pre-migration behavior rather than
// something newly introduced.
function handleUpsertProjectBatch(project, msg) {
  let next = project;
  let changed = false;
  function ensureCloned() { if (next === project) next = cloneRoomState({ projects: { p: next } }).projects.p; }

  if (typeof msg.name === 'string' && msg.name !== next.name) {
    ensureCloned();
    next.name = msg.name;
    changed = true;
  }

  (msg.jobs || []).forEach(function (job) {
    if (!job || !job.id) return;
    if (next.deletedIds[job.id]) return;
    const existing = next.jobs[job.id];
    if (existing && (existing.updatedAt || 0) > (job.updatedAt || 0)) return;
    ensureCloned();
    next.jobs[job.id] = job;
    changed = true;
  });

  (msg.boardCards || []).forEach(function (card) {
    if (!card || !card.id) return;
    if (next.deletedIds[String(card.id)]) return;
    const existing = next.boardCards[card.id];
    if (existing && (existing.updatedAt || 0) > (card.updatedAt || 0)) return;
    ensureCloned();
    next.boardCards[card.id] = card;
    changed = true;
  });

  (msg.calendarEvents || []).forEach(function (ev) {
    if (!ev || !ev.id) return;
    if (next.deletedIds[String(ev.id)]) return;
    const existing = next.calendarEvents[ev.id];
    if (existing && (existing.updatedAt || 0) > (ev.updatedAt || 0)) return;
    ensureCloned();
    next.calendarEvents[ev.id] = ev;
    changed = true;
  });

  if (msg.header && typeof msg.header === 'object') {
    ensureCloned();
    next.header = msg.header;
    changed = true;
  }

  if (!changed) return { project, changed: false };
  next.rev++;
  return { project: next, changed: true };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (!deepEqual(a[i], b[i])) return false; }
    return true;
  }
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function fieldsChangedExcluding(a, b, ignoreKeys) {
  const aKeys = Object.keys(a).filter(function (k) { return ignoreKeys.indexOf(k) === -1; });
  const bKeys = Object.keys(b).filter(function (k) { return ignoreKeys.indexOf(k) === -1; });
  if (aKeys.length !== bKeys.length) return true;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return true;
    if (!deepEqual(a[k], b[k])) return true;
  }
  return false;
}

// pushProjectToShared() (index.html) always sends the ENTIRE project's
// jobs/boardCards/calendarEvents/name/header on every save, not a diff —
// every job gets a freshly stamped updatedAt on every push regardless of
// whether it actually changed. So "is this field present in the message"
// can't tell a real edit from routine re-transmission; each item here is
// compared against what's actually stored (roomState, loaded fresh above
// in webSocketMessage()) to find out. Runs AFTER the message-type/project
// floor in webSocketMessage() has already confirmed the caller is at
// least 'commenter' — this only narrows further, per-item, so a commenter
// can't smuggle a non-comment edit and an editor can't smuggle a
// brand-new job/card/event past the type-level floor above.
function filterUpsertProjectBatchByTier(msg, storedProject, role) {
  const stored = storedProject || { jobs: {}, boardCards: {}, calendarEvents: {}, name: null, header: null };

  function filterMap(items, storedMap, extraIgnoreKeys) {
    return (items || []).filter(function (item) {
      if (!item || !item.id) return false;
      const existing = storedMap[item.id];
      if (!existing) return tierAtLeast(role, 'projectAdmin');
      const realChange = fieldsChangedExcluding(item, existing, ['updatedAt'].concat(extraIgnoreKeys || []));
      if (!realChange) return tierAtLeast(role, 'commenter');
      return tierAtLeast(role, 'editor');
    });
  }

  const out = Object.assign({}, msg, {
    jobs: filterMap(msg.jobs, stored.jobs || {}, ['comments']),
    boardCards: filterMap(msg.boardCards, stored.boardCards || {}, []),
    calendarEvents: filterMap(msg.calendarEvents, stored.calendarEvents || {}, [])
  });

  if (typeof out.name === 'string' && (out.name === stored.name || !tierAtLeast(role, 'projectAdmin'))) {
    delete out.name;
  }
  if (out.header && typeof out.header === 'object' && (deepEqual(out.header, stored.header) || !tierAtLeast(role, 'projectAdmin'))) {
    delete out.header;
  }

  return out;
}

function handleSetWholeField(project, msg, fieldName) {
  const currentRev = project.fieldRevisions[fieldName] || 0;
  const baseRev = typeof msg.baseFieldRevision === 'number' ? msg.baseFieldRevision : -1;
  if (baseRev < currentRev) {
    return { project, changed: false, rejected: 'stale', currentFieldRevision: currentRev };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next[fieldName] = msg.value;
  next.fieldRevisions[fieldName] = currentRev + 1;
  next.rev++;
  return { project: next, changed: true, newFieldRevision: currentRev + 1 };
}

function handleDeleteFromMap(project, msg) {
  const mapKey = msg.mapKey;
  const id = String(msg.id);
  if (['jobs', 'boardCards', 'calendarEvents'].indexOf(mapKey) === -1) {
    return { project, changed: false, error: 'deleteFromMap: invalid mapKey' };
  }
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  delete next[mapKey][id];
  delete next[mapKey][msg.id];
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true };
}

function handleRecordTombstone(project, msg) {
  const id = String(msg.id);
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.deletedIds = mergeTombstones(next.deletedIds, { [id]: Date.now() });
  next.rev++;
  return { project: next, changed: true };
}

function handleLogActivity(project, msg) {
  const next = cloneRoomState({ projects: { p: project } }).projects.p;
  next.activityLog.push({ who: msg.who || 'Someone', what: msg.what || '', when: msg.when || Date.now() });
  while (next.activityLog.length > ACTIVITY_LOG_CAP) next.activityLog.shift();
  next.rev++;
  return { project: next, changed: true };
}

// Minimum tier required to send each WebSocket message type — enforced in
// webSocketMessage() below, BEFORE applyMessage() ever runs, so an
// unauthorized write is rejected rather than applied and broadcast. Floors
// mirror what the client's own hasMinTier()/data-min-tier gating already
// treats as the minimum for the equivalent UI action. Types with no entry
// here (setPresence is short-circuited earlier; anything unrecognized)
// fall through unchanged to applyMessage()'s own 'unknown message type'
// error — this table only ever narrows, never grants new capability.
const MESSAGE_TIER_REQUIREMENTS = {
  upsertProjectBatch: 'commenter',
  logActivity: 'commenter',
  upsertJob: 'editor',
  upsertCard: 'editor',
  upsertCalendarEvent: 'editor',
  deleteFromMap: 'editor',
  recordTombstone: 'editor',
  setBoardColumns: 'projectAdmin',
  setFieldOptions: 'projectAdmin',
  setHeader: 'projectAdmin',
  setWorkflowItems: 'projectAdmin',
  renameProject: 'projectAdmin',
  removeProject: 'admin'
};

function applyMessage(state, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { state, changed: false, error: 'malformed message' };
  }
  if (!msg.projectId) {
    return { state, changed: false, error: 'message missing projectId' };
  }

  // Special-cased ahead of ensureProject() below: removing a project
  // operates on the whole state directly (see removeProject() just below
  // applyMessage), no reason to fabricate a blank project first.
  if (msg.type === 'removeProject') {
    const result = removeProject(state, msg.projectId);
    return {
      state: result.state,
      changed: result.changed,
      ack: { type: 'ack', msgId: msg.msgId }
    };
  }

  let working = ensureProject(state, msg.projectId, msg.seedProjectName);
  const project = working.projects[msg.projectId];
  let result;

  switch (msg.type) {
    case 'upsertJob': result = handleUpsertJob(project, msg); break;
    case 'upsertCard': result = handleUpsertCard(project, msg); break;
    case 'upsertCalendarEvent': result = handleUpsertCalendarEvent(project, msg); break;
    case 'upsertProjectBatch': result = handleUpsertProjectBatch(project, msg); break;
    case 'setBoardColumns': result = handleSetWholeField(project, msg, 'boardColumns'); break;
    case 'setFieldOptions': result = handleSetWholeField(project, msg, 'fieldOptions'); break;
    case 'setHeader': result = handleSetWholeField(project, msg, 'header'); break;
    case 'setWorkflowItems': result = handleSetWholeField(project, msg, 'workflowItems'); break;
    case 'deleteFromMap': result = handleDeleteFromMap(project, msg); break;
    case 'recordTombstone': result = handleRecordTombstone(project, msg); break;
    case 'logActivity': result = handleLogActivity(project, msg); break;
    case 'renameProject': {
      const next = cloneRoomState({ projects: { p: project } }).projects.p;
      next.name = msg.name || next.name;
      next.rev++;
      result = { project: next, changed: true };
      break;
    }
    default:
      return { state, changed: false, error: 'unknown message type: ' + msg.type };
  }

  if (result.error) return { state, changed: false, error: result.error };
  if (!result.changed) {
    return {
      state,
      changed: false,
      rejected: result.rejected ? { reason: result.rejected, currentFieldRevision: result.currentFieldRevision } : undefined,
      ack: { type: 'ack', msgId: msg.msgId }
    };
  }

  const newState = cloneRoomState(working);
  newState.projects[msg.projectId] = result.project;
  return {
    state: newState,
    changed: true,
    ack: { type: 'ack', msgId: msg.msgId, newFieldRevision: result.newFieldRevision }
  };
}

// Removes a project entirely — a real capability now (used once to clean
// up a stray empty project a client-side bug created; see the fix in
// applyRoomSnapshot()'s isFirstSnapshot handling in index.html). Project
// deletion is still not exposed anywhere in the app's own UI otherwise.
function removeProject(state, projectId) {
  if (!state.projects[projectId]) return { state, changed: false };
  const next = cloneRoomState(state);
  delete next.projects[projectId];
  return { state: next, changed: true };
}

// --- 2. ROOM TOKEN SIGNING (see worker/aps-room-token.js for the
// source-of-truth copy with full design-rationale comments) ---

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function importHmacKey(secret, usage) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
async function signRoomToken(secret, payload, ttlMs) {
  const enc = new TextEncoder();
  const body = JSON.stringify(Object.assign({}, payload, { exp: Date.now() + (ttlMs || DEFAULT_TOKEN_TTL_MS) }));
  const bodyB64 = base64UrlEncode(enc.encode(body));
  const key = await importHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(bodyB64));
  return bodyB64 + '.' + base64UrlEncode(new Uint8Array(sig));
}
async function verifyRoomToken(secret, token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const dot = token.lastIndexOf('.');
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!bodyB64 || !sigB64) return null;
  let sigBytes;
  try { sigBytes = base64UrlDecode(sigB64); } catch (e) { return null; }
  const enc = new TextEncoder();
  const key = await importHmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(bodyB64));
  if (!valid) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(bodyB64))); } catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

// --- 3. BACKUP/RESTORE — now talks to our own Durable Object instead of
// Liveblocks' REST API. Much simpler: no DELETE-then-POST dance, no
// external round trip, no typed LSON wrapping — the DO's /internal/export
// and /internal/import already speak plain JSON in the room's own shape.
// External backup FILE shape is unchanged from the just-fixed Liveblocks
// version (v3: jobs/boardCards/calendarEvents as arrays, deletedIds,
// boardColumns, fieldOptions, header) for continuity with existing
// backups and index.html's importData().

function roomStateToAppFormat(roomState) {
  const projects = {};
  for (const [projId, proj] of Object.entries(roomState.projects || {})) {
    projects[projId] = {
      id: projId,
      name: proj.name || 'Untitled Project',
      jobs: Object.values(proj.jobs || {}).sort((a, b) => (a.order || 0) - (b.order || 0)),
      boardColumns: proj.boardColumns || [],
      boardCards: Object.values(proj.boardCards || {}),
      calendarEvents: Object.values(proj.calendarEvents || {}),
      fieldOptions: proj.fieldOptions || {},
      deletedIds: proj.deletedIds || {},
      header: proj.header || { title: proj.name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } }
    };
  }
  return { version: 3, projects, activeProjectId: Object.keys(projects)[0] || null };
}

function appFormatToRoomState(appData) {
  const projects = {};
  for (const [projId, proj] of Object.entries(appData.projects || {})) {
    const jobsObj = {};
    (proj.jobs || []).forEach(function (j) { if (j && j.id) jobsObj[j.id] = j; });
    const cardsObj = {};
    (proj.boardCards || []).forEach(function (c) { if (c && c.id !== undefined && c.id !== null) cardsObj[String(c.id)] = c; });
    const eventsObj = {};
    (proj.calendarEvents || []).forEach(function (ev) { if (ev && ev.id !== undefined && ev.id !== null) eventsObj[String(ev.id)] = ev; });
    projects[projId] = {
      name: proj.name || 'Untitled Project',
      jobs: jobsObj,
      boardCards: cardsObj,
      calendarEvents: eventsObj,
      boardColumns: proj.boardColumns || [],
      fieldOptions: proj.fieldOptions || {},
      deletedIds: proj.deletedIds || {},
      header: proj.header || { title: proj.name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } },
      activityLog: [],
      rev: 0,
      fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0, workflowItems: 0 }
    };
  }
  return { projects };
}

function getRoomStub(env) {
  const id = env.APS_ROOM.idFromName('aps-production-room');
  return env.APS_ROOM.get(id);
}

async function runBackup(env) {
  const stub = getRoomStub(env);
  const res = await stub.fetch('https://internal/internal/export');
  if (!res.ok) throw new Error(`Room export failed: ${res.status}`);
  const roomState = await res.json();
  const appData = roomStateToAppFormat(roomState);
  const timestamp = new Date().toISOString();
  const key = `backups/aps-planner-${timestamp}.json`;

  await env.BACKUP_BUCKET.put(key, JSON.stringify(appData, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  try {
    const list = await env.BACKUP_BUCKET.list({ prefix: "backups/" });
    const sorted = list.objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    for (let i = 30; i < sorted.length; i++) {
      await env.BACKUP_BUCKET.delete(sorted[i].key);
    }
  } catch (pruneErr) {
    console.error("Backup succeeded but pruning old snapshots failed:", pruneErr);
  }

  console.log("Backup complete:", key);
  return key;
}

async function runRestore(env, backupKey) {
  const stub = getRoomStub(env);

  const backupObj = await env.BACKUP_BUCKET.get(backupKey);
  if (!backupObj) throw new Error(`Backup not found in bucket: ${backupKey}`);
  const appData = JSON.parse(await backupObj.text());
  if (!appData || (appData.version !== 2 && appData.version !== 3) || !appData.projects) {
    throw new Error("Backup file doesn't look like a valid v2/v3 export (missing 'projects').");
  }

  // Safety snapshot of current state before we touch anything.
  const currentRes = await stub.fetch('https://internal/internal/export');
  if (currentRes.ok) {
    const currentRoomState = await currentRes.json();
    const currentAppData = roomStateToAppFormat(currentRoomState);
    const safetyKey = `backups/pre-restore-safety-${new Date().toISOString()}.json`;
    await env.BACKUP_BUCKET.put(safetyKey, JSON.stringify(currentAppData, null, 2), {
      httpMetadata: { contentType: "application/json" }
    });
    console.log("Pre-restore safety snapshot saved:", safetyKey);
  } else {
    console.error("Could not fetch current room state for safety snapshot — proceeding anyway.");
  }

  const newRoomState = appFormatToRoomState(appData);
  const importRes = await stub.fetch('https://internal/internal/import', {
    method: 'POST',
    body: JSON.stringify(newRoomState)
  });
  if (!importRes.ok) {
    const body = await importRes.text().catch(() => "");
    throw new Error(`Room import failed: ${importRes.status} ${body}`);
  }

  console.log("Restore complete from:", backupKey);
  return { restoredFrom: backupKey };
}

// --- 4. USER ACCOUNTS (byte-for-byte unchanged from
// aps-liveblocks-worker.js — confirmed independent of Liveblocks by
// exploration before this migration started) ---

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
function genSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}
async function hashPasswordPBKDF2(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function normalizeUsername(username) {
  return (typeof username === "string" ? username : "").trim().toLowerCase();
}

// Permission tiers, lowest to highest — matches PERMISSION_TIERS in
// index.html. Used both to validate incoming role values in
// handleUsersAdd/handleUsersUpdate below, and (via tierAtLeast()) to
// enforce content-write permissions in webSocketMessage() below.
const VALID_TIERS = ["viewer", "commenter", "editor", "projectAdmin", "admin"];
function tierAtLeast(role, minTier) {
  const mine = VALID_TIERS.indexOf(role);
  const need = VALID_TIERS.indexOf(minTier);
  return mine !== -1 && need !== -1 && mine >= need;
}

// Lazy migration: pre-tier accounts stored role:"member" (the old binary
// scheme) — coerced to "editor" (the closest match to what an unrestricted
// member could already do) at read time, never rewritten back to KV, so
// there's no separate one-off migration script to run. assignedProjectId
// defaults to null (unrestricted — sees both fixed projects) for anyone who
// predates the field entirely.
function normalizeUserRecord(u) {
  if (!u) return u;
  if (u.role === "member") u.role = "editor";
  if (u.assignedProjectId === undefined) u.assignedProjectId = null;
  return u;
}

async function getUser(env, username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const raw = await env.USERS_KV.get("user:" + key);
  return raw ? normalizeUserRecord(JSON.parse(raw)) : null;
}
async function putUser(env, user) {
  await env.USERS_KV.put("user:" + normalizeUsername(user.username), JSON.stringify(user));
}
async function deleteUser(env, username) {
  await env.USERS_KV.delete("user:" + normalizeUsername(username));
}
async function listAllUsers(env) {
  const list = await env.USERS_KV.list({ prefix: "user:" });
  const users = [];
  for (const k of list.keys) {
    const raw = await env.USERS_KV.get(k.name);
    if (!raw) continue;
    const u = normalizeUserRecord(JSON.parse(raw));
    users.push({ username: u.username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId, createdAt: u.createdAt, isLead: !!u.isLead });
  }
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return users;
}

async function verifyCredentials(env, username, password) {
  const user = await getUser(env, username);
  if (!user || !password) return null;
  const hash = await hashPasswordPBKDF2(password, user.salt);
  if (hash !== user.passwordHash) return null;
  return user;
}

// The shared team-password fallback (and TEAM_PASSWORD itself) is gone —
// every caller now authenticates as a real individual account, full stop.
// fallbackName is kept as a parameter (unused) rather than removed from
// every call site across this file for a change that's otherwise purely
// subtractive.
async function resolveIdentity(env, username, password, fallbackName) {
  if (!username) return null;
  const user = await verifyCredentials(env, username, password);
  if (!user) return null;
  return { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
}

// Resolves identity from a signed room token (see signRoomToken/
// verifyRoomToken above) instead of re-verifying a password against KV.
// Returns the same shape as resolveIdentity() so every downstream call
// site is agnostic to which path produced it.
async function resolveIdentityFromToken(env, token) {
  const payload = await verifyRoomToken(env.ROOM_TOKEN_SECRET, token);
  if (!payload || !payload.username) return null;
  return { username: payload.username, displayName: payload.displayName, role: payload.role, assignedProjectId: payload.assignedProjectId || null };
}

// Single entry point every authenticated JSON-body endpoint below uses.
// handleAuth() (the /auth login endpoint) is the only remaining place a
// raw password is verified — everything past it runs on the token that
// mints. (The legacy username+password fallback this used to also accept
// was removed once every client had picked up the token-based build.)
async function resolveCaller(env, body) {
  return resolveIdentityFromToken(env, body && body.token);
}

// Login rate limiting (KV-backed, reuses USERS_KV — no new binding). Per-
// username lockout is the primary defense (protects an individual account
// even when a small team shares one office IP); per-IP is a blunter
// secondary layer against a spray across many usernames from one source,
// deliberately looser so it doesn't lock out the whole team over one
// person's typos. KV's own expirationTtl handles cleanup — no cron job.
// Both "wrong password" and "unknown username" charge the same counter —
// only charging the former would let someone enumerate valid usernames
// for free by noticing which attempts don't count against the limit.
const AUTH_LOCKOUT_WINDOW_SECONDS = 900; // 15 minutes
const AUTH_MAX_FAILURES_PER_USERNAME = 10;
const AUTH_MAX_FAILURES_PER_IP = 30;

async function getAuthFailureCount(env, key) {
  const raw = await env.USERS_KV.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  return isNaN(n) ? 0 : n;
}
async function bumpAuthFailure(env, key) {
  const n = (await getAuthFailureCount(env, key)) + 1;
  await env.USERS_KV.put(key, String(n), { expirationTtl: AUTH_LOCKOUT_WINDOW_SECONDS });
}

// --- 5. AUTH HANDLER — now mints a signed room token instead of calling
// Liveblocks. Credential checking (resolveIdentity, above) is completely
// unchanged; only what happens after a successful check is different.
async function handleAuth(request, env, corsHeaders, ctx) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const usernameFailKey = "authfail:" + normalizeUsername(body.username);
  const ipFailKey = "authfail-ip:" + (request.headers.get("CF-Connecting-IP") || "unknown");
  const [userFailures, ipFailures] = await Promise.all([
    getAuthFailureCount(env, usernameFailKey),
    getAuthFailureCount(env, ipFailKey)
  ]);
  if (userFailures >= AUTH_MAX_FAILURES_PER_USERNAME || ipFailures >= AUTH_MAX_FAILURES_PER_IP) {
    // Skips resolveIdentity()/the PBKDF2 hash entirely once locked out.
    return jsonResponse({ error: "Too many attempts — try again in a few minutes." }, 429, corsHeaders);
  }

  const identity = await resolveIdentity(env, body.username, body.password, body.name);
  if (!identity) {
    const bump = Promise.all([bumpAuthFailure(env, usernameFailKey), bumpAuthFailure(env, ipFailKey)]);
    if (ctx) ctx.waitUntil(bump); else await bump;
    return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  }
  const clearUserFailures = env.USERS_KV.delete(usernameFailKey);
  if (ctx) ctx.waitUntil(clearUserFailures); else await clearUserFailures;

  const token = await signRoomToken(env.ROOM_TOKEN_SECRET, {
    username: identity.username,
    displayName: identity.displayName,
    role: identity.role,
    assignedProjectId: identity.assignedProjectId || null
  });

  return jsonResponse({
    token,
    user: { username: identity.username, displayName: identity.displayName, role: identity.role, assignedProjectId: identity.assignedProjectId || null }
  }, 200, corsHeaders);
}

// --- 6. USER MANAGEMENT HANDLERS (unchanged) ---
async function handleUsersList(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  if (caller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);
  const users = await listAllUsers(env);
  return jsonResponse({ users }, 200, corsHeaders);
}

// Deliberately NOT admin-gated (unlike handleUsersList above) — this
// powers the client's per-checklist-stage "Visible to" picker, which any
// logged-in team member needs to pick a teammate from, not just admins.
// Strips role/createdAt/etc. down to just {username, displayName} so it
// can't be used as a lightweight admin-only-data leak.
async function handleUsersRoster(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const users = await listAllUsers(env);
  return jsonResponse({ users: users.map(function(u) { return { username: u.username, displayName: u.displayName, isLead: !!u.isLead }; }) }, 200, corsHeaders);
}

async function handleUsersAdd(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  // Re-checked fresh from KV rather than trusted off the token: this
  // endpoint grants power, so a caller demoted after their token was
  // minted must lose access immediately, not after the token's TTL.
  const freshCaller = await getUser(env, caller.username);
  if (!freshCaller || freshCaller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);

  const newUsername = normalizeUsername(body.newUsername);
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const newDisplayName = (typeof body.newDisplayName === "string" && body.newDisplayName.trim())
    ? body.newDisplayName.trim().slice(0, 60) : newUsername;
  const newRole = VALID_TIERS.includes(body.newRole) ? body.newRole : "editor";
  // Only meaningful for non-admin tiers — an admin is never project-scoped.
  const newAssignedProjectId = (newRole !== "admin" && typeof body.newAssignedProjectId === "string" && body.newAssignedProjectId)
    ? body.newAssignedProjectId : null;
  const newIsLead = !!body.newIsLead;

  if (!newUsername || !/^[a-z0-9._-]{2,40}$/.test(newUsername)) {
    return jsonResponse({ error: "Username must be 2-40 characters (letters, numbers, . _ -)" }, 400, corsHeaders);
  }
  if (newPassword.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters" }, 400, corsHeaders);
  }
  if (await getUser(env, newUsername)) {
    return jsonResponse({ error: "That username is already taken" }, 409, corsHeaders);
  }

  const salt = genSaltHex();
  const passwordHash = await hashPasswordPBKDF2(newPassword, salt);
  await putUser(env, {
    username: newUsername,
    displayName: newDisplayName,
    role: newRole,
    assignedProjectId: newAssignedProjectId,
    isLead: newIsLead,
    passwordHash,
    salt,
    createdAt: Date.now()
  });
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// Admin-only: reassign an EXISTING account's tier and/or project scope
// without deleting/recreating it (which would also force a password reset).
// Same shape as handleUsersResetPassword below, plus handleUsersRemove's
// last-admin guard reused here so the last true admin can't be demoted away,
// same rationale as not being able to delete the last admin account.
async function handleUsersUpdate(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const freshCaller = await getUser(env, caller.username);
  if (!freshCaller || freshCaller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);

  const targetUsername = normalizeUsername(body.targetUsername);
  const target = await getUser(env, targetUsername);
  if (!target) return jsonResponse({ error: "User not found" }, 404, corsHeaders);

  if (!VALID_TIERS.includes(body.newRole)) {
    return jsonResponse({ error: "Invalid role" }, 400, corsHeaders);
  }
  if (body.newAssignedProjectId !== null && body.newAssignedProjectId !== undefined && typeof body.newAssignedProjectId !== "string") {
    return jsonResponse({ error: "Invalid project assignment" }, 400, corsHeaders);
  }

  if (target.role === "admin" && body.newRole !== "admin") {
    const all = await listAllUsers(env);
    const adminCount = all.filter(u => u.role === "admin").length;
    if (adminCount <= 1) {
      return jsonResponse({ error: "Can't demote the last admin account" }, 400, corsHeaders);
    }
  }

  target.role = body.newRole;
  target.assignedProjectId = (target.role !== "admin" && typeof body.newAssignedProjectId === "string" && body.newAssignedProjectId)
    ? body.newAssignedProjectId : null;
  target.isLead = !!body.newIsLead;
  await putUser(env, target);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

async function handleUsersRemove(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const freshCaller = await getUser(env, caller.username);
  if (!freshCaller || freshCaller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);

  const targetUsername = normalizeUsername(body.targetUsername);
  const target = await getUser(env, targetUsername);
  if (!target) return jsonResponse({ error: "User not found" }, 404, corsHeaders);

  if (target.role === "admin") {
    const all = await listAllUsers(env);
    const adminCount = all.filter(u => u.role === "admin").length;
    if (adminCount <= 1) {
      return jsonResponse({ error: "Can't remove the last admin account" }, 400, corsHeaders);
    }
  }

  await deleteUser(env, targetUsername);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

async function handleUsersResetPassword(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const targetUsername = normalizeUsername(body.targetUsername);
  const isSelfService = !!caller.username && caller.username === targetUsername;
  if (caller.role !== "admin" && !isSelfService) {
    return jsonResponse({ error: "Admin access required (or reset your own account only)" }, 403, corsHeaders);
  }

  const target = await getUser(env, targetUsername);
  if (!target) return jsonResponse({ error: "User not found" }, 404, corsHeaders);

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters" }, 400, corsHeaders);
  }

  const salt = genSaltHex();
  target.passwordHash = await hashPasswordPBKDF2(newPassword, salt);
  target.salt = salt;
  await putUser(env, target);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// --- 7. ATTACHMENTS — new. Card/job file uploads now go to R2 (the same
// BACKUP_BUCKET, under an attachments/ prefix) instead of inline base64
// in the synced data, which would otherwise bloat the Durable Object's
// storage and every snapshot broadcast. The key prefix check on
// download/delete matters: it's what stops these endpoints from being
// used to read/delete backup files out of the same shared bucket.
async function handleAttachmentUpload(request, env, corsHeaders, url) {
  // Credentials via headers, not query params — this request's body IS
  // the raw file (streamed straight into R2 below), so there's no JSON
  // body to put them in the way every other POST endpoint does, and a
  // query string would land in Worker access logs like the backup
  // endpoints used to.
  const identity = await resolveIdentityFromToken(env, request.headers.get("X-Aps-Token"));
  if (!identity) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const name = url.searchParams.get("name") || "file";
  const type = url.searchParams.get("type") || "application/octet-stream";
  const dotIdx = name.lastIndexOf(".");
  const ext = dotIdx > -1 ? name.slice(dotIdx) : "";
  const key = "attachments/" + crypto.randomUUID() + ext;

  await env.BACKUP_BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
  return jsonResponse({ key, name }, 200, corsHeaders);
}

async function handleAttachmentDownload(request, env, corsHeaders, url) {
  const identity = await resolveIdentityFromToken(env, url.searchParams.get("token"));
  if (!identity) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

  const key = url.searchParams.get("key") || "";
  if (!key.startsWith("attachments/")) return new Response("Bad request", { status: 400, headers: corsHeaders });

  const obj = await env.BACKUP_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders });

  return new Response(obj.body, {
    headers: Object.assign({}, corsHeaders, {
      "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream"
    })
  });
}

async function handleAttachmentDelete(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const identity = await resolveCaller(env, body);
  if (!identity) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const key = body.key || "";
  if (!key.startsWith("attachments/")) return jsonResponse({ error: "Bad key" }, 400, corsHeaders);

  await env.BACKUP_BUCKET.delete(key);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// --- 8. UTILITIES ---
function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// Backups used to be gated by the shared team password alone, with no tie
// to individual accounts at all. Now they require a real Admin-tier
// account's own credentials — same resolveIdentity() every other
// authenticated endpoint uses, just requiring username+password instead of
// a single shared secret.
async function checkAdminAuth(request, env) {
  try {
    const body = await request.clone().json();
    const caller = await resolveCaller(env, body);
    return !!(caller && caller.role === "admin");
  } catch (e) {
    return false;
  }
}

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
      if (!(await checkAdminAuth(request, env))) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      try {
        const key = await runBackup(env);
        return jsonResponse({ success: true, key }, 200, corsHeaders);
      } catch (err) {
        console.error("Manual backup failed:", err);
        return jsonResponse({ success: false, error: String(err) }, 500, corsHeaders);
      }
    }

    if (url.pathname === "/list-backups" && request.method === "POST") {
      if (!(await checkAdminAuth(request, env))) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const list = await env.BACKUP_BUCKET.list({ prefix: "backups/" });
      const backups = list.objects
        .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
        .map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          date: new Date(o.uploaded).toLocaleString("en-US", { timeZone: "America/Chicago" })
        }));
      return jsonResponse({ backups }, 200, corsHeaders);
    }

    // POST-only, credentials in the JSON body — was GET with
    // username/password/key as query params, which lands verbatim in
    // Worker access logs on every download. The client now fetch()es this
    // (instead of window.open(), which can't send a POST body) and turns
    // the response into a local download itself.
    if (url.pathname === "/download-backup" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
      const dlCaller = await resolveCaller(env, body);
      if (!dlCaller || dlCaller.role !== "admin") {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const key = body.key;
      if (!key) return jsonResponse({ error: "Missing key" }, 400, corsHeaders);

      const obj = await env.BACKUP_BUCKET.get(key);
      if (!obj) return jsonResponse({ error: "Not found" }, 404, corsHeaders);

      return new Response(obj.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="aps-backup-${key.split("/").pop()}"`
        }
      });
    }

    // Same reasoning as /download-backup above — POST + JSON body instead
    // of the admin password sitting in a GET query string.
    if (url.pathname === "/restore-backup" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
      const restoreCaller = await resolveCaller(env, body);
      if (!restoreCaller || restoreCaller.role !== "admin") {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const key = body.key;
      const confirm = body.confirm;
      if (!key) return jsonResponse({ error: "Missing key" }, 400, corsHeaders);
      if (confirm !== "RESTORE") {
        return jsonResponse({ error: "Missing confirm:'RESTORE' — this action overwrites the live room. Include confirm:'RESTORE' in the body to proceed." }, 400, corsHeaders);
      }
      try {
        const result = await runRestore(env, key);
        return jsonResponse({ success: true, ...result }, 200, corsHeaders);
      } catch (err) {
        console.error("Restore failed:", err);
        return jsonResponse({ success: false, error: String(err) }, 500, corsHeaders);
      }
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

// --- 10. THE DURABLE OBJECT ITSELF (see worker/aps-room-do.js for the
// source-of-truth copy with full design-rationale comments, including
// the honest caveat about what could and couldn't be tested without a
// real Durable Objects runtime) ---

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
    server.send(JSON.stringify(Object.assign({ type: 'snapshot' }, roomState)));
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
    if (msg && msg.projectId && attachment && attachment.assignedProjectId && msg.projectId !== attachment.assignedProjectId) {
      ws.send(JSON.stringify({ type: 'error', msgId: msg.msgId, message: 'Forbidden: outside your assigned project' }));
      return;
    }
    if (msg && msg.type === 'upsertProjectBatch' && attachment) {
      msg = filterUpsertProjectBatchByTier(msg, roomState.projects[msg.projectId], attachment.role);
    }

    const result = applyMessage(roomState, msg);

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
