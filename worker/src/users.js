// --- USER ACCOUNTS (byte-for-byte unchanged from
// aps-liveblocks-worker.js — confirmed independent of Liveblocks by
// exploration before this migration started) ---
import { verifyRoomToken } from './room-token.js';

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
export function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
export function genSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}
export async function hashPasswordPBKDF2(password, saltHex) {
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

export function normalizeUsername(username) {
  return (typeof username === "string" ? username : "").trim().toLowerCase();
}

// Lazy migration: pre-tier accounts stored role:"member" (the old binary
// scheme) — coerced to "editor" (the closest match to what an unrestricted
// member could already do) at read time, never rewritten back to KV, so
// there's no separate one-off migration script to run. assignedProjectId
// defaults to null (unrestricted — sees both fixed projects) for anyone who
// predates the field entirely.
export function normalizeUserRecord(u) {
  if (!u) return u;
  if (u.role === "member") u.role = "editor";
  if (u.assignedProjectId === undefined) u.assignedProjectId = null;
  return u;
}

export async function getUser(env, username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const raw = await env.USERS_KV.get("user:" + key);
  return raw ? normalizeUserRecord(JSON.parse(raw)) : null;
}
export async function putUser(env, user) {
  await env.USERS_KV.put("user:" + normalizeUsername(user.username), JSON.stringify(user));
}
export async function deleteUser(env, username) {
  await env.USERS_KV.delete("user:" + normalizeUsername(username));
}
export async function listAllUsers(env) {
  const list = await env.USERS_KV.list({ prefix: "user:" });
  const users = [];
  for (const k of list.keys) {
    const raw = await env.USERS_KV.get(k.name);
    if (!raw) continue;
    const u = normalizeUserRecord(JSON.parse(raw));
    users.push({ username: u.username, displayName: u.displayName, role: u.role, assignedProjectId: u.assignedProjectId, createdAt: u.createdAt, isLead: !!u.isLead });
  }
  users.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return users;
}

export async function verifyCredentials(env, username, password) {
  const user = await getUser(env, username);
  if (!user || !password) return null;
  const hash = await hashPasswordPBKDF2(password, user.salt);
  if (hash !== user.passwordHash) return null;
  return user;
}

// The shared team-password fallback (and TEAM_PASSWORD itself) is gone —
// every caller now authenticates as a real individual account, full stop.
// fallbackName is kept as a parameter (unused) rather than removed from
// every call site across this file for a change that's otherwise purely
// subtractive.
export async function resolveIdentity(env, username, password, fallbackName) {
  if (!username) return null;
  const user = await verifyCredentials(env, username, password);
  if (!user) return null;
  return { username: user.username, displayName: user.displayName, role: user.role, assignedProjectId: user.assignedProjectId || null };
}

// Resolves identity from a signed room token (see signRoomToken/
// verifyRoomToken in room-token.js) instead of re-verifying a password
// against KV. Returns the same shape as resolveIdentity() so every
// downstream call site is agnostic to which path produced it.
export async function resolveIdentityFromToken(env, token) {
  const payload = await verifyRoomToken(env.ROOM_TOKEN_SECRET, token);
  if (!payload || !payload.username) return null;
  return { username: payload.username, displayName: payload.displayName, role: payload.role, assignedProjectId: payload.assignedProjectId || null };
}

// Single entry point every authenticated JSON-body endpoint uses.
// handleAuth() (the /auth login endpoint, in auth.js) is the only
// remaining place a raw password is verified — everything past it runs
// on the token that mints. (The legacy username+password fallback this
// used to also accept was removed once every client had picked up the
// token-based build.)
export async function resolveCaller(env, body) {
  return resolveIdentityFromToken(env, body && body.token);
}

// Login rate limiting (KV-backed, reuses USERS_KV — no new binding). Per-
// username lockout is the primary defense (protects an individual account
// even when a small team shares one office IP); per-IP is a blunter
// secondary layer against a spray across many usernames from one source,
// deliberately looser so it doesn't lock out the whole team over one
// person's typos. KV's own expirationTtl handles cleanup — no cron job.
// Both "wrong password" and "unknown username" charge the same counter —
// only charging the former would let someone enumerate valid usernames
// for free by noticing which attempts don't count against the limit.
export const AUTH_LOCKOUT_WINDOW_SECONDS = 900; // 15 minutes
export const AUTH_MAX_FAILURES_PER_USERNAME = 10;
export const AUTH_MAX_FAILURES_PER_IP = 30;

export async function getAuthFailureCount(env, key) {
  const raw = await env.USERS_KV.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  return isNaN(n) ? 0 : n;
}
export async function bumpAuthFailure(env, key) {
  const n = (await getAuthFailureCount(env, key)) + 1;
  await env.USERS_KV.put(key, String(n), { expirationTtl: AUTH_LOCKOUT_WINDOW_SECONDS });
}
