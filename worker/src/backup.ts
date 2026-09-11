// --- BACKUP/RESTORE — talks to the room's own Durable Object, whose
// /internal/export and /internal/import endpoints speak plain JSON in
// the room's own shape.
// External backup FILE shape (v3: jobs/boardCards/calendarEvents as
// arrays, deletedIds, boardColumns, fieldOptions, header) is kept stable
// for continuity with existing backups and index.html's importData().
import { jsonResponse } from './http.ts';
import { getRoomStub } from './room-stub.ts';
import { resolveCaller } from './users.ts';
import type { RoomState, Project, Job, BoardCard, CalendarEvent } from './types.ts';

// The external backup FILE shape — an array-based projection of the
// room's own map-based Project shape, kept stable for continuity with
// existing backups and index.html's importData().
export interface AppFormatProject {
  id?: string;
  name: string;
  jobs: Job[];
  boardColumns: unknown[];
  boardCards: BoardCard[];
  calendarEvents: CalendarEvent[];
  fieldOptions: Record<string, unknown>;
  deletedIds: Record<string, number>;
  header: Record<string, unknown>;
}

export interface AppFormat {
  version: number;
  projects: Record<string, AppFormatProject>;
  activeProjectId: string | null;
}

export function roomStateToAppFormat(roomState: RoomState): AppFormat {
  const projects: Record<string, AppFormatProject> = {};
  for (const [projId, proj] of Object.entries(roomState.projects || {})) {
    projects[projId] = {
      id: projId,
      name: proj.name || 'Untitled Project',
      jobs: Object.values(proj.jobs || {}).sort((a, b) => ((a.order as number) || 0) - ((b.order as number) || 0)),
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

export function appFormatToRoomState(appData: { projects?: Record<string, Partial<AppFormatProject>> }): RoomState {
  const projects: Record<string, Project> = {};
  for (const [projId, proj] of Object.entries(appData.projects || {})) {
    const jobsObj: Record<string, Job> = {};
    (proj.jobs || []).forEach(function (j) { if (j && j.id) jobsObj[j.id] = j; });
    const cardsObj: Record<string, BoardCard> = {};
    (proj.boardCards || []).forEach(function (c) { if (c && c.id !== undefined && c.id !== null) cardsObj[String(c.id)] = c; });
    const eventsObj: Record<string, CalendarEvent> = {};
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

export async function runBackup(env: Env): Promise<string> {
  const stub = getRoomStub(env);
  const res = await stub.fetch('https://internal/internal/export');
  if (!res.ok) throw new Error(`Room export failed: ${res.status}`);
  const roomState = await res.json() as RoomState;
  const appData = roomStateToAppFormat(roomState);
  const timestamp = new Date().toISOString();
  const key = `backups/aps-planner-${timestamp}.json`;

  await env.BACKUP_BUCKET.put(key, JSON.stringify(appData, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  try {
    const list = await env.BACKUP_BUCKET.list({ prefix: "backups/" });
    const sorted = list.objects.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
    for (let i = 30; i < sorted.length; i++) {
      await env.BACKUP_BUCKET.delete(sorted[i].key);
    }
  } catch (pruneErr) {
    console.error("Backup succeeded but pruning old snapshots failed:", pruneErr);
  }

  console.log("Backup complete:", key);
  return key;
}

export async function runRestore(env: Env, backupKey: string): Promise<{ restoredFrom: string }> {
  const stub = getRoomStub(env);

  const backupObj = await env.BACKUP_BUCKET.get(backupKey);
  if (!backupObj) throw new Error(`Backup not found in bucket: ${backupKey}`);
  const appData = JSON.parse(await backupObj.text()) as AppFormat;
  if (!appData || (appData.version !== 2 && appData.version !== 3) || !appData.projects) {
    throw new Error("Backup file doesn't look like a valid v2/v3 export (missing 'projects').");
  }

  // Safety snapshot of current state before we touch anything.
  const currentRes = await stub.fetch('https://internal/internal/export');
  if (currentRes.ok) {
    const currentRoomState = await currentRes.json() as RoomState;
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

// Backups used to be gated by the shared team password alone, with no tie
// to individual accounts at all. Now they require a real Admin-tier
// account's own credentials — same resolveIdentity() every other
// authenticated endpoint uses, just requiring username+password instead of
// a single shared secret.
export async function checkAdminAuth(request: Request, env: Env): Promise<boolean> {
  try {
    const body = await request.clone().json() as { token?: string };
    const caller = await resolveCaller(env, body);
    return !!(caller && caller.role === "admin");
  } catch (e) {
    return false;
  }
}

// The four route handlers below were previously inlined directly in the
// router's fetch() body rather than wrapped in named functions like every
// other route — pulled out here as a pure mechanical extract-function (no
// logic change) so index.ts can eventually be a uniform one-line-per-route
// dispatcher, same as every other route.

export async function handleTriggerBackup(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
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

export async function handleListBackups(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  if (!(await checkAdminAuth(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const list = await env.BACKUP_BUCKET.list({ prefix: "backups/" });
  const backups = list.objects
    .sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime())
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
export async function handleDownloadBackup(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; key?: string };
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

// Same reasoning as handleDownloadBackup above — POST + JSON body instead
// of the admin password sitting in a GET query string.
export async function handleRestoreBackup(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; key?: string; confirm?: string };
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
