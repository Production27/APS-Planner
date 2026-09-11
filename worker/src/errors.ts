// ===== CLIENT ERROR REPORTS =====
// Nothing surfaced a client-side crash automatically before this — an
// admin only found out if the person who hit it happened to mention it.
// KV-backed (reuses USERS_KV, same reasoning as the login-rate-limit
// counters in users.ts: infrequent enough that a new binding isn't worth
// it), a single capped JSON array rather than one KV entry per error —
// plenty for "did anything break recently", not meant to be a real
// observability system.
import { jsonResponse } from './http.ts';
import { resolveCaller } from './users.ts';

export const CLIENT_ERROR_LOG_KEY = "client_errors";
export const CLIENT_ERROR_LOG_CAP = 200;

interface ReportErrorBody {
  token?: string;
  kind?: string;
  message?: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
  pageUrl?: string;
  userAgent?: string;
  appVersion?: string;
}

// No auth required to POST — a crash can happen before login even
// resolves, and the whole point is catching those too. A token is still
// used to attach a VERIFIED identity when one is present (same reasoning
// as sanitizeJobCommentAuthors() in room-state.ts: prefer the server's
// own knowledge of who's connected over anything client-claimed), falling
// back to "unauthenticated" rather than trusting a spoofable plain-text
// username field.
export async function handleReportError(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: ReportErrorBody;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }

  let identity = null;
  try { identity = await resolveCaller(env, body); } catch (e) { /* unauthenticated report — fine */ }

  const entry = {
    receivedAt: new Date().toISOString(),
    kind: String(body.kind || "error").slice(0, 40),
    message: String(body.message || "").slice(0, 500),
    stack: body.stack ? String(body.stack).slice(0, 2000) : null,
    source: body.source ? String(body.source).slice(0, 300) : null,
    line: Number.isFinite(body.line) ? body.line : null,
    col: Number.isFinite(body.col) ? body.col : null,
    pageUrl: body.pageUrl ? String(body.pageUrl).slice(0, 300) : null,
    userAgent: body.userAgent ? String(body.userAgent).slice(0, 300) : null,
    appVersion: body.appVersion ? String(body.appVersion).slice(0, 40) : null,
    username: identity ? identity.username : null,
    role: identity ? identity.role : null,
  };

  try {
    const raw = await env.USERS_KV.get(CLIENT_ERROR_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await env.USERS_KV.put(CLIENT_ERROR_LOG_KEY, JSON.stringify(list.slice(0, CLIENT_ERROR_LOG_CAP)));
  } catch (e) {
    console.error("Failed to store client error report:", e);
    // Still 200 — the client's fetch() is fire-and-forget either way, and
    // a storage hiccup here isn't something the reporting browser can act on.
  }
  return jsonResponse({ success: true }, 200, corsHeaders);
}

export async function handleErrorsList(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller || caller.role !== "admin") {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }
  const raw = await env.USERS_KV.get(CLIENT_ERROR_LOG_KEY);
  return jsonResponse({ errors: raw ? JSON.parse(raw) : [] }, 200, corsHeaders);
}
