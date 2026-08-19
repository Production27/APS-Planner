// ==========================================
// APS Planner — Worker (Durable Objects backend)
// NOT YET DEPLOYED — this is the migration target, built and tested
// alongside the still-live worker/aps-liveblocks-worker.js. See the
// migration plan and worker/README.md before deploying this anywhere.
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
    fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0 }
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

function applyMessage(state, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { state, changed: false, error: 'malformed message' };
  }
  if (!msg.projectId) {
    return { state, changed: false, error: 'message missing projectId' };
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
      fieldRevisions: { boardColumns: 0, fieldOptions: 0, header: 0 }
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

async function getUser(env, username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const raw = await env.USERS_KV.get("user:" + key);
  return raw ? JSON.parse(raw) : null;
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
    const u = JSON.parse(raw);
    users.push({ username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt });
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

async function resolveIdentity(env, username, password, fallbackName) {
  if (username) {
    const user = await verifyCredentials(env, username, password);
    if (user) return { username: user.username, displayName: user.displayName, role: user.role };
  }
  if (password && password === env.TEAM_PASSWORD) {
    const name = (typeof fallbackName === "string" && fallbackName.trim())
      ? fallbackName.trim().slice(0, 60)
      : "Team member";
    return { username: null, displayName: name, role: "admin" };
  }
  return null;
}

// --- 5. AUTH HANDLER — now mints a signed room token instead of calling
// Liveblocks. Credential checking (resolveIdentity, above) is completely
// unchanged; only what happens after a successful check is different.
async function handleAuth(request, env, corsHeaders) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const identity = await resolveIdentity(env, body.username, body.password, body.name);
  if (!identity) {
    return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  }

  const token = await signRoomToken(env.ROOM_TOKEN_SECRET, {
    username: identity.username,
    displayName: identity.displayName,
    role: identity.role
  });

  return jsonResponse({
    token,
    user: { username: identity.username, displayName: identity.displayName, role: identity.role }
  }, 200, corsHeaders);
}

// --- 6. USER MANAGEMENT HANDLERS (unchanged) ---
async function handleUsersList(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveIdentity(env, body.username, body.password);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  if (caller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);
  const users = await listAllUsers(env);
  return jsonResponse({ users }, 200, corsHeaders);
}

async function handleUsersAdd(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveIdentity(env, body.username, body.password);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  if (caller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);

  const newUsername = normalizeUsername(body.newUsername);
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const newDisplayName = (typeof body.newDisplayName === "string" && body.newDisplayName.trim())
    ? body.newDisplayName.trim().slice(0, 60) : newUsername;
  const newRole = body.newRole === "admin" ? "admin" : "member";

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
    passwordHash,
    salt,
    createdAt: Date.now()
  });
  return jsonResponse({ success: true }, 200, corsHeaders);
}

async function handleUsersRemove(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveIdentity(env, body.username, body.password);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  if (caller.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403, corsHeaders);

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
  const caller = await resolveIdentity(env, body.username, body.password);
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
  const identity = await resolveIdentity(env, url.searchParams.get("username"), url.searchParams.get("password"));
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
  const identity = await resolveIdentity(env, url.searchParams.get("username"), url.searchParams.get("password"));
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
  const identity = await resolveIdentity(env, body.username, body.password);
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

async function checkPassword(request, env) {
  try {
    const body = await request.clone().json();
    return body.password === env.TEAM_PASSWORD;
  } catch (e) {
    return false;
  }
}

async function checkPasswordFlexible(request, env, url) {
  const qp = url.searchParams.get("password");
  if (qp && qp === env.TEAM_PASSWORD) return true;
  return checkPassword(request, env);
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
      "Access-Control-Allow-Headers": "Content-Type",
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
      return handleAuth(request, env, corsHeaders);
    }

    if (url.pathname === "/trigger-backup") {
      if (!(await checkPasswordFlexible(request, env, url))) {
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

    if (url.pathname === "/list-backups") {
      if (!(await checkPasswordFlexible(request, env, url))) {
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

    if (url.pathname === "/download-backup") {
      const password = url.searchParams.get("password");
      if (password !== env.TEAM_PASSWORD) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const key = url.searchParams.get("key");
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

    if (url.pathname === "/restore-backup") {
      const password = url.searchParams.get("password");
      if (password !== env.TEAM_PASSWORD) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const key = url.searchParams.get("key");
      const confirm = url.searchParams.get("confirm");
      if (!key) return jsonResponse({ error: "Missing key" }, 400, corsHeaders);
      if (confirm !== "RESTORE") {
        return jsonResponse({ error: "Missing confirm=RESTORE — this action overwrites the live room. Add &confirm=RESTORE to proceed." }, 400, corsHeaders);
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
    if (url.pathname === "/users/add" && request.method === "POST") {
      return handleUsersAdd(request, env, corsHeaders);
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
    server.serializeAttachment({ username: identity.username, displayName: identity.displayName, role: identity.role });

    const roomState = await this.loadRoomState();
    server.send(JSON.stringify(Object.assign({ type: 'snapshot' }, roomState)));

    return new Response(null, { status: 101, webSocket: client });
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

    const roomState = await this.loadRoomState();
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
  }

  async webSocketError(ws, error) {
    console.error('APS room websocket error:', error);
  }
}
