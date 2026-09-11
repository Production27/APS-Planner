// --- MAINTENANCE MODE — a small admin-controlled flag the client polls
// so a genuine cutover moment shows a "TeamSync is being updated"
// message instead of a half-migrated app quietly misbehaving. KV-backed
// (reuses USERS_KV, same reasoning as the login-lockout counters and the
// client-error log: infrequent enough that a new binding isn't worth
// it), a single small JSON object rather than anything more elaborate —
// this is advisory UI, not a write-blocking enforcement mechanism (it
// does nothing to stop a script from writing bad data while nobody's
// watching; it only stops ordinary team members from using a half-
// migrated app while one is running).
import { jsonResponse } from './http.ts';
import { resolveCaller } from './users.ts';
import { requireAdmin } from './users-admin.ts';

export const MAINTENANCE_KV_KEY = 'maintenance_mode';
const DEFAULT_MESSAGE = "We're making some backend changes — back shortly.";

export interface MaintenanceStatus {
  active: boolean;
  message: string;
}

// Shared by both the read path (a KV value that might be missing or, in
// principle, malformed) and the write path (turning it on always needs
// SOME message) — one normalization rule for what "the status" means,
// used both ways.
export function normalizeMaintenanceStatus(raw: unknown): MaintenanceStatus {
  if (!raw || typeof raw !== 'object') return { active: false, message: DEFAULT_MESSAGE };
  const r = raw as Record<string, unknown>;
  return {
    active: !!r.active,
    message: typeof r.message === 'string' && r.message.trim() ? r.message.trim().slice(0, 500) : DEFAULT_MESSAGE
  };
}

export async function getMaintenanceStatus(env: Env): Promise<MaintenanceStatus> {
  const raw = await env.USERS_KV.get(MAINTENANCE_KV_KEY);
  return normalizeMaintenanceStatus(raw ? JSON.parse(raw) : null);
}

// Public, no auth — a crash-prone or logged-out browser needs to see this
// exactly as readily as a logged-in one, and there's nothing sensitive in
// the response (just whether the team's being asked to wait, and why).
export async function handleMaintenanceStatus(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const status = await getMaintenanceStatus(env);
  return jsonResponse(status, 200, corsHeaders);
}

// Admin-only, and re-checked fresh from KV (requireAdmin, not a bare
// role-off-the-token check like /download-backup and /restore-backup
// still use) — this locks the whole team out of ordinary use at once,
// a bigger blast radius than either of those, so it gets the stronger of
// the two admin-gating patterns already in use elsewhere in this file.
export async function handleSetMaintenanceStatus(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; active?: boolean; message?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const admin = await requireAdmin(env, caller, corsHeaders);
  if (admin.error) return admin.error;

  const status = normalizeMaintenanceStatus({ active: !!body.active, message: body.message });
  await env.USERS_KV.put(MAINTENANCE_KV_KEY, JSON.stringify(status));
  return jsonResponse({ success: true, status }, 200, corsHeaders);
}
