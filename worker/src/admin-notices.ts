// ===== ADMIN NOTICES =====
// What the badge on the Admin menu counts: account events (audit.ts's
// ADMIN_NOTICE_ACTIONS) plus app crashes (errors.ts), newest first. Each
// admin has their own "seen up to" time in KV, so the badge clears on every
// device once they've opened the menu. An admin's own actions never count
// against them.
import { jsonResponse } from './http.ts';
import { resolveCaller } from './users.ts';
import { requireAdmin } from './users-admin.ts';
import { ADMIN_NOTICE_LOG_KEY } from './audit.ts';
import { CLIENT_ERROR_LOG_KEY } from './errors.ts';

export const ADMIN_NOTICES_RETURNED = 30;
const SEEN_KEY_PREFIX = 'admin_notices_seen:';

interface NoticeItem {
  at: number;
  kind: 'account' | 'error';
  user: string | null;
  action: string;
  item?: string | null;
  details?: string | null;
}

async function readList(env: Env, key: string): Promise<any[]> {
  try {
    const raw = await env.USERS_KV.get(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

// POST { token } -> { items, unread, seenAt }
export async function handleAdminNotices(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const me = admin.user!.username;

  const account: NoticeItem[] = (await readList(env, ADMIN_NOTICE_LOG_KEY))
    .filter(function (n) { return n && n.user !== me; })
    .map(function (n) { return { at: Number(n.at) || 0, kind: 'account', user: n.user || null, action: String(n.action || ''), item: n.item || null, details: n.details || null }; });
  const errors: NoticeItem[] = (await readList(env, CLIENT_ERROR_LOG_KEY))
    .map(function (e) { return { at: Date.parse(e && e.receivedAt) || 0, kind: 'error', user: (e && e.username) || null, action: 'App error', details: (e && e.message) || null }; });
  const all = account.concat(errors).sort(function (a, b) { return b.at - a.at; });

  const seenAt = Number(await env.USERS_KV.get(SEEN_KEY_PREFIX + me)) || 0;
  const unread = all.filter(function (n) { return n.at > seenAt; }).length;
  return jsonResponse({ items: all.slice(0, ADMIN_NOTICES_RETURNED), unread: unread, seenAt: seenAt }, 200, corsHeaders);
}

// POST { token, at } — marks everything up to `at` as seen. The client
// sends the newest time it actually showed, so a notice arriving while the
// menu was open still counts as new.
export async function handleAdminNoticesSeen(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; at?: number };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const at = Number(body.at);
  if (!Number.isFinite(at) || at <= 0) return jsonResponse({ error: "Invalid time" }, 400, corsHeaders);
  const key = SEEN_KEY_PREFIX + admin.user!.username;
  const prev = Number(await env.USERS_KV.get(key)) || 0;
  const next = Math.max(prev, Math.min(at, Date.now()));
  if (next !== prev) await env.USERS_KV.put(key, String(next));
  return jsonResponse({ success: true, seenAt: next }, 200, corsHeaders);
}
