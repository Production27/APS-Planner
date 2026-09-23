// --- TWO-STEP VERIFICATION ENDPOINTS (see mfa.ts for how it works) ---
//   POST /mfa/status          {token}                       -> {enabled, enabledAt, recoveryCodesLeft, required}
//   POST /mfa/setup           {token, password} | {ticket}  -> {secret, uri}   (not yet on)
//   POST /mfa/enable          {token | ticket, code}        -> {recoveryCodes} (+ {token, user} with a ticket)
//   POST /mfa/disable         {token, password, code}
//   POST /mfa/recovery-codes  {token, code}                 -> {recoveryCodes} (replaces the old ones)
//   POST /users/reset-mfa     {token, targetUsername}       admin: turn it off for someone who lost their phone
//   POST /security/policy     {token, requireMfa?}          admin: read, or set, the company policy
// The {ticket} forms are for someone the company requires to set up
// two-step before they can finish signing in (auth.ts).
import { jsonResponse } from './http.ts';
import { resolveCaller, getUser, putUser, verifyCredentials, normalizeUsername, bumpAuthFailure } from './users.ts';
import { requireAdmin } from './users-admin.ts';
import { recordAudit, clientIp } from './audit.ts';
import { resolveTicket, issueSession, checkSecondFactor } from './auth.ts';
import {
  generateTotpSecret, otpauthUri, verifyTotp, encryptSecret, decryptSecret,
  generateRecoveryCodes, hashRecoveryCode, getSecurityPolicy, putSecurityPolicy
} from './mfa.ts';
import type { UserRecord } from './types.ts';

// A shown-but-unconfirmed secret expires after this long.
export const MFA_PENDING_TTL_MS = 30 * 60 * 1000;

type Body = { token?: string; ticket?: string; password?: string; code?: string; targetUsername?: string; requireMfa?: unknown };

async function readBody(request: Request): Promise<Body | null> {
  try { return await request.json(); } catch (e) { return null; }
}

// The account acting: a signed-in session, or (allowTicket) a sign-in
// that's waiting on two-step setup.
async function resolveAccount(env: Env, body: Body, allowTicket: boolean): Promise<{ user: UserRecord; viaTicket: boolean } | null> {
  if (allowTicket && body.ticket) {
    const user = await resolveTicket(env, body.ticket, 'mfa-setup');
    return user ? { user, viaTicket: true } : null;
  }
  const caller = await resolveCaller(env, body);
  if (!caller) return null;
  const user = await getUser(env, caller.username);
  return user ? { user, viaTicket: false } : null;
}

async function hashAll(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map(hashRecoveryCode));
}

export async function handleMfaStatus(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const acct = await resolveAccount(env, body, false);
  if (!acct) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const policy = await getSecurityPolicy(env);
  const mfa = acct.user.mfa;
  return jsonResponse({ enabled: !!mfa, enabledAt: mfa ? mfa.enabledAt : null, recoveryCodesLeft: mfa ? mfa.recovery.length : 0, required: policy.requireMfa }, 200, corsHeaders);
}

export async function handleMfaSetup(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const acct = await resolveAccount(env, body, true);
  if (!acct) return jsonResponse({ error: "Invalid credentials", restart: !!body.ticket }, 401, corsHeaders);
  const user = acct.user;
  // From a live session, the password is asked again, so someone at an
  // unlocked computer can't attach their own phone to the account.
  if (!acct.viaTicket && !(await verifyCredentials(env, user.username, body.password))) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(user.username));
    return jsonResponse({ error: "Incorrect password" }, 403, corsHeaders);
  }
  if (user.mfa) return jsonResponse({ error: "Two-step verification is already on" }, 409, corsHeaders);
  const secret = generateTotpSecret();
  user.mfaPending = { secret: await encryptSecret(env, secret), createdAt: Date.now() };
  await putUser(env, user);
  return jsonResponse({ secret, uri: otpauthUri(secret, user.username) }, 200, corsHeaders);
}

export async function handleMfaEnable(request: Request, env: Env, corsHeaders: Record<string, string>, ctx: ExecutionContext | undefined): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const acct = await resolveAccount(env, body, true);
  if (!acct) return jsonResponse({ error: "Invalid credentials", restart: !!body.ticket }, 401, corsHeaders);
  const user = acct.user;
  if (user.mfa) return jsonResponse({ error: "Two-step verification is already on" }, 409, corsHeaders);
  const pending = user.mfaPending;
  if (!pending || Date.now() - pending.createdAt > MFA_PENDING_TTL_MS) {
    return jsonResponse({ error: "Setup timed out — start again." }, 410, corsHeaders);
  }
  const secret = await decryptSecret(env, pending.secret);
  const step = secret ? await verifyTotp(secret, String(body.code || ''), Date.now()) : null;
  if (step === null) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(user.username));
    return jsonResponse({ error: "That code didn't match — make sure you scanned the new code and try the current one." }, 400, corsHeaders);
  }
  const recoveryCodes = generateRecoveryCodes();
  user.mfa = { secret: pending.secret, enabledAt: Date.now(), lastStep: step, recovery: await hashAll(recoveryCodes) };
  delete user.mfaPending;
  await putUser(env, user);
  await recordAudit(env, { user: user.username, role: user.role, action: 'Turned on two-step verification', ip: clientIp(request) });
  if (acct.viaTicket) {
    return issueSession(env, request, ctx, user, 'password + new two-step setup', corsHeaders, { recoveryCodes });
  }
  return jsonResponse({ recoveryCodes }, 200, corsHeaders);
}

export async function handleMfaDisable(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const acct = await resolveAccount(env, body, false);
  if (!acct) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const user = acct.user;
  if (!user.mfa) return jsonResponse({ success: true }, 200, corsHeaders);
  if ((await getSecurityPolicy(env)).requireMfa) {
    return jsonResponse({ error: "Your company requires two-step verification, so it can't be turned off." }, 403, corsHeaders);
  }
  if (!(await verifyCredentials(env, user.username, body.password))) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(user.username));
    return jsonResponse({ error: "Incorrect password" }, 403, corsHeaders);
  }
  if (!(await checkSecondFactor(env, user, body.code))) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(user.username));
    return jsonResponse({ error: "That code didn't work" }, 403, corsHeaders);
  }
  delete user.mfa;
  await putUser(env, user);
  await recordAudit(env, { user: user.username, role: user.role, action: 'Turned off two-step verification', ip: clientIp(request) });
  return jsonResponse({ success: true }, 200, corsHeaders);
}

export async function handleMfaRecoveryCodes(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const acct = await resolveAccount(env, body, false);
  if (!acct) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const user = acct.user;
  if (!user.mfa) return jsonResponse({ error: "Two-step verification isn't on" }, 400, corsHeaders);
  if (!(await checkSecondFactor(env, user, body.code))) {
    await bumpAuthFailure(env, "authfail:" + normalizeUsername(user.username));
    return jsonResponse({ error: "That code didn't work" }, 403, corsHeaders);
  }
  const recoveryCodes = generateRecoveryCodes();
  user.mfa.recovery = await hashAll(recoveryCodes);
  await putUser(env, user);
  await recordAudit(env, { user: user.username, role: user.role, action: 'Made new two-step recovery codes', ip: clientIp(request) });
  return jsonResponse({ recoveryCodes }, 200, corsHeaders);
}

export async function handleUsersResetMfa(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  const target = await getUser(env, normalizeUsername(body.targetUsername));
  if (!target) return jsonResponse({ error: "User not found" }, 404, corsHeaders);
  delete target.mfa;
  delete target.mfaPending;
  await putUser(env, target);
  await recordAudit(env, { user: admin.user!.username, role: 'admin', action: 'Reset two-step verification', item: target.username, ip: clientIp(request) });
  return jsonResponse({ success: true }, 200, corsHeaders);
}

export async function handleSecurityPolicy(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await readBody(request);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  const admin = await requireAdmin(env, await resolveCaller(env, body), corsHeaders);
  if (admin.error) return admin.error;
  let policy = await getSecurityPolicy(env);
  if (typeof body.requireMfa === "boolean" && body.requireMfa !== policy.requireMfa) {
    policy = Object.assign({}, policy, { requireMfa: body.requireMfa, updatedBy: admin.user!.username, updatedAt: Date.now() });
    await putSecurityPolicy(env, policy);
    await recordAudit(env, { user: admin.user!.username, role: 'admin', action: body.requireMfa ? 'Required two-step verification for everyone' : 'Stopped requiring two-step verification', ip: clientIp(request) });
  }
  return jsonResponse({ policy }, 200, corsHeaders);
}
