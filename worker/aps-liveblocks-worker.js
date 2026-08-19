// ==========================================
// APS Planner — Liveblocks Auth + Backup Agent + User Accounts
// Complete, deployable Worker file
//
// This is a versioned snapshot of the code actually running at
// https://lucky-snow-8179.production-db3.workers.dev/, committed here so
// there's a rollback artifact and a real diff base — until now this Worker
// only ever existed as hand-pasted code in the Cloudflare dashboard's
// Quick Edit box, with no history at all. Deploy process is still manual:
// paste this whole file into that same editor and Deploy. See the repo's
// index.html (LIVEBLOCKS_AUTH_ENDPOINT) for the deployed URL, and
// worker/README.md for the bindings/secrets this expects.
// ==========================================

// --- 1. LIVEBLOCKS STORAGE UNWRAPPING ---
// The REST API returns LiveObjects/LiveMaps as typed JSON nodes.
// This recursively flattens them into plain JS objects.
function unwrapLiveblocks(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(unwrapLiveblocks);
  if (node.liveblocksType === 'LiveObject') return unwrapLiveblocks(node.data);
  if (node.liveblocksType === 'LiveMap') {
    const obj = {};
    for (const [k, v] of Object.entries(node.data)) obj[k] = unwrapLiveblocks(v);
    return obj;
  }
  if (node.liveblocksType === 'LiveList') return (node.data || []).map(unwrapLiveblocks);
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = unwrapLiveblocks(v);
  return out;
}

// Convert the raw Liveblocks storage into YOUR app's native export format
// (same shape as clicking Settings → Export)
function transformStorageToAppFormat(storage) {
  const root = unwrapLiveblocks(storage);
  const projectsMap = root.projects || {};
  const projects = {};

  for (const [projId, proj] of Object.entries(projectsMap)) {
    const rawTasks = proj.tasksMap || {};
    const tasks = Object.entries(rawTasks).map(([id, t]) => {
      if (t && typeof t === 'object' && !t.id) t.id = id;
      return t;
    }).sort((a, b) => (a.order || 0) - (b.order || 0));

    const rawCards = proj.boardCardsMap || {};
    const boardCards = Object.entries(rawCards).map(([id, c]) => {
      if (c && typeof c === 'object' && !c.id) c.id = id;
      return c;
    });

    projects[projId] = {
      id: projId,
      name: proj.name || 'Untitled Project',
      tasks,
      boardColumns: proj.boardColumns || [],
      boardCards,
      fieldOptions: proj.fieldOptions || {},
      header: proj.header || { title: proj.name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } }
    };
  }

  return {
    version: 2,
    projects,
    activeProjectId: Object.keys(projects)[0] || null
  };
}

// --- 1b. REVERSE: convert YOUR app's export/backup format BACK into
// the typed Liveblocks LSON shape, matching the exact schema confirmed
// via /debug-storage on 2026-08-10:
//   root (LiveObject)
//     projects (LiveMap)
//       [projectId] (LiveObject): name, boardColumns (plain array),
//         fieldOptions (plain object), header (LiveObject),
//         tasksMap (LiveMap of plain task objects),
//         boardCardsMap (LiveMap of plain card objects)
function projectToLive(proj) {
  const tasksData = {};
  for (const t of (proj.tasks || [])) {
    if (t && t.id) tasksData[t.id] = t;
  }
  const cardsData = {};
  for (const c of (proj.boardCards || [])) {
    if (c && c.id !== undefined && c.id !== null) cardsData[String(c.id)] = c;
  }

  return {
    liveblocksType: "LiveObject",
    data: {
      name: proj.name || 'Untitled Project',
      boardColumns: proj.boardColumns || [],
      fieldOptions: proj.fieldOptions || {},
      boardCardsMap: { liveblocksType: "LiveMap", data: cardsData },
      header: {
        liveblocksType: "LiveObject",
        data: proj.header || { title: proj.name || 'Untitled', subtitle: '', theme: { c1: '#1a237e', c2: '#3949ab' } }
      },
      tasksMap: { liveblocksType: "LiveMap", data: tasksData }
    }
  };
}

function buildLsonFromBackup(appData) {
  const projectsData = {};
  for (const [projId, proj] of Object.entries(appData.projects || {})) {
    projectsData[projId] = projectToLive(proj);
  }
  return {
    liveblocksType: "LiveObject",
    data: {
      projects: { liveblocksType: "LiveMap", data: projectsData }
    }
  };
}

// --- 2. BACKUP CORE ---
// IMPORTANT: this throws on failure instead of swallowing errors. That's
// deliberate — the whole point of this backup system is to be trustworthy,
// so a failed backup needs to be *visible* (as a failed scheduled run in
// the Cloudflare dashboard, and as a real error from /trigger-backup)
// rather than silently logged and forgotten.
async function runBackup(env) {
  const roomId = "aps-production-room";
  const res = await fetch(`https://api.liveblocks.io/v2/rooms/${roomId}/storage`, {
    headers: { Authorization: `Bearer ${env.LIVEBLOCKS_SECRET_KEY}` }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Liveblocks storage fetch failed: ${res.status} ${res.statusText} ${body}`);
  }

  const storage = await res.json();
  const appData = transformStorageToAppFormat(storage);
  const timestamp = new Date().toISOString();
  const key = `backups/aps-planner-${timestamp}.json`;

  await env.BACKUP_BUCKET.put(key, JSON.stringify(appData, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  // Retention: keep only the 30 most recent snapshots.
  // A failure here shouldn't erase the fact that the backup itself
  // succeeded, so it's caught and logged separately rather than thrown.
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

// --- 2b. RESTORE CORE ---
// Overwrites the LIVE Liveblocks room with a chosen backup.
// This is destructive: it disconnects all connected users and replaces
// the entire room storage. To reduce risk:
//   1. It fetches + saves the CURRENT live storage to R2 first, as a
//      "pre-restore safety snapshot" — so if the restore goes wrong,
//      today's live state (right before you overwrote it) isn't lost.
//   2. Liveblocks only allows re-initializing storage when it's empty,
//      so we DELETE the room's storage, then POST the rebuilt backup.
async function runRestore(env, backupKey) {
  const roomId = "aps-production-room";

  // 1. Load the chosen backup from R2
  const backupObj = await env.BACKUP_BUCKET.get(backupKey);
  if (!backupObj) throw new Error(`Backup not found in bucket: ${backupKey}`);
  const appData = JSON.parse(await backupObj.text());
  if (!appData || appData.version !== 2 || !appData.projects) {
    throw new Error("Backup file doesn't look like a valid v2 export (missing 'projects').");
  }

  // 2. Safety snapshot of CURRENT live state before we touch anything
  const currentRes = await fetch(`https://api.liveblocks.io/v2/rooms/${roomId}/storage`, {
    headers: { Authorization: `Bearer ${env.LIVEBLOCKS_SECRET_KEY}` }
  });
  if (currentRes.ok) {
    const currentStorage = await currentRes.json();
    const currentAppData = transformStorageToAppFormat(currentStorage);
    const safetyKey = `backups/pre-restore-safety-${new Date().toISOString()}.json`;
    await env.BACKUP_BUCKET.put(safetyKey, JSON.stringify(currentAppData, null, 2), {
      httpMetadata: { contentType: "application/json" }
    });
    console.log("Pre-restore safety snapshot saved:", safetyKey);
  } else {
    console.error("Could not fetch current storage for safety snapshot — proceeding anyway.");
  }

  // 3. Delete existing storage (required before re-initializing)
  const delRes = await fetch(`https://api.liveblocks.io/v2/rooms/${roomId}/storage`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.LIVEBLOCKS_SECRET_KEY}` }
  });
  if (!delRes.ok) {
    const body = await delRes.text().catch(() => "");
    throw new Error(`Failed to delete existing storage: ${delRes.status} ${body}`);
  }

  // 4. Re-initialize storage with the rebuilt backup data
  const lson = buildLsonFromBackup(appData);
  const initRes = await fetch(`https://api.liveblocks.io/v2/rooms/${roomId}/storage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LIVEBLOCKS_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(lson)
  });
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(`Failed to re-initialize storage: ${initRes.status} ${body}`);
  }

  console.log("Restore complete from:", backupKey);
  return { restoredFrom: backupKey };
}

// --- 3. USER ACCOUNTS ---
// Stored in a KV namespace bound as USERS_KV (Workers & Pages -> this
// worker -> Settings -> Bindings -> Add -> KV namespace -> bind as
// USERS_KV). Key "user:<username lowercased>" -> JSON record:
//   { username, displayName, role, passwordHash, salt, createdAt }
// role is "admin" or "member". Passwords are hashed with PBKDF2-SHA256
// (100k iterations, random 16-byte salt) via the runtime's native
// crypto.subtle — no external dependency needed.

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
    // Never expose passwordHash/salt — this is the only place a user
    // record is read for anything other than verifying a login.
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

// Resolves whoever is calling in to a { username, displayName, role }
// identity, or null if the credentials don't check out. Tries a real
// per-user account first; falls back to the shared TEAM_PASSWORD as a
// break-glass admin identity — this is deliberate, not a bug: it's what
// keeps everyone's existing cached password working the moment this
// ships, and it's how the very first real admin account gets created
// (log in with the old shared password, then use Manage Users to add
// yourself a real one).
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

// --- 4. AUTH HANDLER ---
// This is what your frontend calls to get a Liveblocks token.
//
// NOTE (2026-08-10): Liveblocks removed the old `POST /v2/rooms/:roomId/authorize`
// endpoint entirely (it used to be listed as deprecated, but it no longer appears
// in the REST API reference at all). This is why new connections started failing
// with a "NOT_FOUND" / "No such endpoint exists" error while already-connected
// clients kept working fine — their existing sessions just didn't need to
// re-auth. This handler now calls the replacement, `POST /v2/authorize-user`,
// which requires an explicit `permissions` map since the room is no longer
// implied by the URL path. Note the scope string is "*:write" (access-token
// vocabulary), NOT "room:write" (that's the scope used for a room's own
// defaultAccesses/usersAccesses config, which is a different thing).
//
// NOTE (2026-08-19): body now carries {username, password} for a real
// per-user account, checked via resolveIdentity() above (which still
// accepts the old shared password as a fallback — see its comment). The
// JSON response is the raw Liveblocks token response with one extra
// sibling field, `user: {...}`, appended — the Liveblocks client SDK only
// reads `.token` off this object and ignores properties it doesn't
// recognize, so this rides along for free without a second endpoint. The
// frontend uses it to know its own confirmed display name + role.
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

  const roomId = "aps-production-room";

  const res = await fetch(`https://api.liveblocks.io/v2/authorize-user`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.LIVEBLOCKS_SECRET_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      userId: (identity.username || "legacy") + "-" + Date.now(),
      userInfo: { name: identity.displayName },
      permissions: {
        [roomId]: ["*:write"]
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    return jsonResponse({ error: "Liveblocks auth failed", details: text }, 500, corsHeaders);
  }

  const data = await res.json();
  return jsonResponse({
    ...data,
    user: { username: identity.username, displayName: identity.displayName, role: identity.role }
  }, 200, corsHeaders);
}

// --- 5. USER MANAGEMENT HANDLERS ---
// Every one of these re-verifies the CALLER's own {username, password}
// on every single call — there's no session/cookie anywhere in this
// Worker, same "re-check every time" pattern the backup endpoints below
// already use for the shared password.
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

// --- 6. UTILITIES ---
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

// Accepts the password either as a URL query param (?password=...) or in a
// POST JSON body — so simple browser links work, not just programmatic POSTs.
async function checkPasswordFlexible(request, env, url) {
  const qp = url.searchParams.get("password");
  if (qp && qp === env.TEAM_PASSWORD) return true;
  return checkPassword(request, env);
}

// --- 7. WORKER ENTRYPOINTS ---
export default {
  // Auto-runs every 6 hours from the Cron trigger.
  // Letting this throw (rather than catching internally) is deliberate:
  // an uncaught error here makes Cloudflare mark the scheduled run as
  // "failed" in the dashboard's Cron Triggers > Logs view, which is the
  // only way you'd otherwise notice a silently-broken backup.
  async scheduled(controller, env, ctx) {
    await runBackup(env);
  },

  // Handles all HTTP requests
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

    // Your existing Liveblocks auth endpoint
    if (url.pathname === "/" || url.pathname === "/auth") {
      return handleAuth(request, env, corsHeaders);
    }

    // A. Manual backup trigger (for testing) — visit this URL directly in a
    // browser with ?password=YOUR_PASSWORD to trigger a backup right now.
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

    // B. List available backups — visit directly with ?password=YOUR_PASSWORD
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

    // C. Download a backup file
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

    // D. Restore a backup into the LIVE Liveblocks room.
    // DESTRUCTIVE — disconnects all users and replaces current room data.
    // Requires password + explicit confirm=RESTORE to avoid accidental triggers.
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

    // E. User accounts (admin-managed). All POST + JSON body, carrying the
    // CALLER's own {username, password} for re-verification on every call.
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

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};
