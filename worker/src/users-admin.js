// --- USER MANAGEMENT HANDLERS (unchanged) ---
import { jsonResponse } from './http.js';
import { VALID_TIERS } from './tiers.js';
import { getRoomStub } from './room-stub.js';
import {
  getUser, putUser, deleteUser, listAllUsers,
  hashPasswordPBKDF2, genSaltHex, normalizeUsername, resolveCaller
} from './users.js';

// Re-checked fresh from KV rather than trusted off the token: an
// admin-gated endpoint must not honor a caller demoted after their token
// was minted, only after the token's own TTL expires. Shared by every
// admin-only handler below so a future one can't accidentally skip the
// fresh recheck the way handleUsersList and handleUsersResetPassword
// used to (both trusted caller.role straight off the token until this).
export async function requireAdmin(env, caller, corsHeaders) {
  if (!caller) return { error: jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders) };
  const user = await getUser(env, caller.username);
  if (!user || user.role !== "admin") return { error: jsonResponse({ error: "Admin access required" }, 403, corsHeaders) };
  return { user };
}

export async function handleUsersList(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const admin = await requireAdmin(env, caller, corsHeaders);
  if (admin.error) return admin.error;
  const users = await listAllUsers(env);
  return jsonResponse({ users }, 200, corsHeaders);
}

// Deliberately NOT admin-gated (unlike handleUsersList above) — this
// powers the client's per-checklist-stage "Visible to" picker, which any
// logged-in team member needs to pick a teammate from, not just admins.
// Strips role/createdAt/etc. down to just {username, displayName} so it
// can't be used as a lightweight admin-only-data leak.
export async function handleUsersRoster(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);
  const users = await listAllUsers(env);
  return jsonResponse({ users: users.map(function(u) { return { username: u.username, displayName: u.displayName, isLead: !!u.isLead }; }) }, 200, corsHeaders);
}

export async function handleUsersAdd(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const admin = await requireAdmin(env, caller, corsHeaders);
  if (admin.error) return admin.error;

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
// Best-effort — worst case a stale-permission connection just persists
// until its token naturally expires (see ApsRoom's /internal/kick-user
// for why closing the socket is what actually matters here, not this
// call itself failing or succeeding).
export async function kickUserFromRoom(env, targetUsername) {
  try {
    await getRoomStub(env).fetch('https://internal/internal/kick-user?username=' + encodeURIComponent(targetUsername), { method: 'POST' });
  } catch (e) { /* best-effort */ }
}

// Pure decision logic pulled out of handleUsersUpdate() below so it's
// independently testable — an isLead-only edit shouldn't force a
// reconnect, only an actual role/project change should.
export function computeRoleProjectChange(target, body) {
  const roleChanged = target.role !== body.newRole;
  const newAssignedProjectId = (body.newRole !== "admin" && typeof body.newAssignedProjectId === "string" && body.newAssignedProjectId)
    ? body.newAssignedProjectId : null;
  const projectChanged = target.assignedProjectId !== newAssignedProjectId;
  return { roleChanged, projectChanged, newAssignedProjectId };
}

export async function handleUsersUpdate(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const admin = await requireAdmin(env, caller, corsHeaders);
  if (admin.error) return admin.error;

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

  // Captured before mutating target below.
  const { roleChanged, projectChanged, newAssignedProjectId } = computeRoleProjectChange(target, body);

  target.role = body.newRole;
  target.assignedProjectId = newAssignedProjectId;
  target.isLead = !!body.newIsLead;
  await putUser(env, target);

  if (roleChanged || projectChanged) {
    await kickUserFromRoom(env, targetUsername);
  }

  return jsonResponse({ success: true }, 200, corsHeaders);
}

export async function handleUsersRemove(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  const admin = await requireAdmin(env, caller, corsHeaders);
  if (admin.error) return admin.error;

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
  await kickUserFromRoom(env, targetUsername);
  return jsonResponse({ success: true }, 200, corsHeaders);
}

export async function handleUsersResetPassword(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders); }
  const caller = await resolveCaller(env, body);
  if (!caller) return jsonResponse({ error: "Invalid credentials" }, 401, corsHeaders);

  const targetUsername = normalizeUsername(body.targetUsername);
  const isSelfService = !!caller.username && caller.username === targetUsername;
  if (!isSelfService) {
    // Same fresh-from-KV recheck as every other admin-gated handler now
    // uses — this branch used to trust caller.role straight off the
    // token, unlike its siblings, so a demoted admin could reset another
    // user's password until the token's own TTL expired.
    const admin = await requireAdmin(env, caller, corsHeaders);
    if (admin.error) return admin.error;
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
