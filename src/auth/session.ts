// Session token storage + decoding. The browser holds no secret — a
// short-lived signed token (minted by the Worker from a username+
// password, see login.ts's reauthenticate()) is cached and reused across
// calls instead. The raw password only ever exists transiently in memory
// between a login submit and the /auth-equivalent call that consumes it.

// Read by src/sync/outbound.ts's logout() too (a real import, not ambient
// — see that file).
export const DISPLAY_NAME_KEY = 'gantt_display_name_v1';
export const USERNAME_KEY = 'gantt_username_v1';
// Retired: used to hold the raw password in localStorage indefinitely.
// Kept only as a key name to scrub (see the boot-time cleanup below) —
// nothing writes to it anymore.
const USER_PASSWORD_KEY = 'gantt_user_password_v1';
// Holds the signed room token (see signRoomToken/verifyRoomToken in the
// Worker) returned by /auth — this, not a password, is what every
// authenticated request now sends.
const SESSION_TOKEN_KEY = 'gantt_session_token_v1';

export function getStoredDisplayName(): string {
  return localStorage.getItem(DISPLAY_NAME_KEY) || '';
}
export function getStoredUsername(): string {
  return localStorage.getItem(USERNAME_KEY) || '';
}
export function getStoredSessionToken(): string {
  return localStorage.getItem(SESSION_TOKEN_KEY) || '';
}
export function setStoredSessionToken(token: string | null): void {
  if (token) localStorage.setItem(SESSION_TOKEN_KEY, token);
  else localStorage.removeItem(SESSION_TOKEN_KEY);
}

// One-time cleanup for browsers that logged in before this file switched
// to token-based auth: scrubs the raw password sitting in localStorage
// from before, regardless of whether a fresh token has been minted yet.
(function scrubLegacyStoredPassword() {
  if (localStorage.getItem(USER_PASSWORD_KEY)) {
    localStorage.removeItem(USER_PASSWORD_KEY);
  }
})();

// Decodes a signed room token's JSON payload WITHOUT verifying its
// signature — safe to do purely to read exp/role/etc. client-side, since
// the Worker independently re-verifies the real signature on every actual
// request. Only ever used to decide whether a cached token is worth
// reusing and to re-apply its identity claims without a network round-
// trip. Returns null for anything missing/malformed.
export function decodeSessionTokenPayload(token: string | null | undefined): any {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  try {
    const bodyB64 = token.slice(0, token.lastIndexOf('.'));
    const padded = bodyB64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((bodyB64.length + 3) % 4);
    return JSON.parse(atob(padded));
  } catch (e) { return null; }
}
// 60s safety margin so a token that's about to expire isn't treated as
// still usable, sent, and rejected by the Worker a moment later.
export function isSessionTokenUsable(token: string | null | undefined): boolean {
  const payload = decodeSessionTokenPayload(token);
  return !!(payload && typeof payload.exp === 'number' && Date.now() < payload.exp - 60000);
}
