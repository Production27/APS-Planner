// --- MY ACCOUNT (self-service) ---
//   POST /account/me     {token}                  -> {username, displayName, email, emailConfirmed}
//   POST /account/email  {token, password, email} -> {email, emailConfirmed}
// Anyone can add or change their own email (any provider) after re-entering
// their password. It works for signing in with email + password straight
// away, but stays unconfirmed (no Google sign-in, no reset emails) until
// proven: "Connect Google account" (sso.ts) confirms a Google address. An
// admin-entered email is confirmed from the start. See users.ts.
import { jsonResponse } from './http.ts';
import { resolveCaller, getUser, putUser, verifyCredentials, bumpAuthFailure, setAccountEmail, normalizeUsername } from './users.ts';
import { recordAudit, clientIp } from './audit.ts';

export async function handleAccountMe(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const user = caller ? await getUser(env, caller.username) : null;
  if (!user) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  return jsonResponse({ username: user.username, displayName: user.displayName, email: user.email || '', emailConfirmed: !!user.emailConfirmed }, 200, corsHeaders);
}

export async function handleAccountEmail(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  let body: { token?: string; password?: string; email?: string };
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const user = await verifyCredentials(env, caller.username, body.password);
  if (!user) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(caller.username));
    return jsonResponse({ error: "Your password is incorrect" }, 403, corsHeaders);
  }
  const before = user.email || '';
  const error = await setAccountEmail(env, user, typeof body.email === "string" ? body.email : '', false);
  if (error) return jsonResponse({ error }, 400, corsHeaders);
  await putUser(env, user);
  if ((user.email || '') !== before) {
    await recordAudit(env, { user: user.username, role: user.role, action: 'Changed own email', ip: clientIp(request), details: (before || 'none') + ' -> ' + (user.email || 'none') + ' (not confirmed)' });
  }
  return jsonResponse({ email: user.email || '', emailConfirmed: !!user.emailConfirmed }, 200, corsHeaders);
}
