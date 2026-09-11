// --- AUTH HANDLER — verifies credentials (resolveIdentity, in users.ts)
// and mints a signed room token used to authenticate the client's
// WebSocket connection. ---
import { jsonResponse } from './http.ts';
import { signRoomToken } from './room-token.ts';
import {
  normalizeUsername, resolveIdentity,
  AUTH_MAX_FAILURES_PER_USERNAME, AUTH_MAX_FAILURES_PER_IP,
  getAuthFailureCount, bumpAuthFailure
} from './users.ts';

export async function handleAuth(request: Request, env: Env, corsHeaders: Record<string, string>, ctx: ExecutionContext | undefined): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  let body: { username?: string; password?: string; name?: string };
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

  const identity = await resolveIdentity(env, body.username as string, body.password);
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
