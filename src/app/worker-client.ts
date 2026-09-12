// Generic authenticated-request helpers shared by every admin surface
// that talks to the Cloudflare Worker (Backups, Manage Users, the error
// log, and the maintenance-mode toggle) — not any one of them.
import { getSessionToken, reauthenticateOnce } from '../auth/login';
import { setStoredSessionToken } from '../auth/session';

// Was a plain window.open(url) with credentials in the query string —
// window.open() can only do a GET navigation, so moving to POST+JSON-body
// auth (matching every other endpoint here) means fetching the file
// ourselves and handing the browser the resulting blob instead of letting
// it navigate directly (see downloadBackupFile() in src/app/backups.ts).
// Shared by downloadBackupFile()/postUsersEndpoint()/uploadAttachmentFile()
// (still in index.html) — each used to hand-roll the identical "fetch, if
// 401 clear the stored token + force a fresh login + refetch" cycle.
// buildOptions is a function of the token (not a fixed options object)
// since the retry needs the NEW token reauthenticateOnce() just minted,
// not the stale one that got the 401.
export async function fetchWithReauth(url: string, buildOptions: (token: string) => RequestInit): Promise<Response> {
  let token = await getSessionToken();
  let res = await fetch(url, buildOptions(token));
  if (res.status === 401) {
    setStoredSessionToken(null);
    token = await reauthenticateOnce(true);
    res = await fetch(url, buildOptions(token));
  }
  return res;
}

// Every call sends the CURRENTLY logged-in user's own session token (see
// getSessionToken()) — the Worker re-verifies it, and the caller's role,
// on every single request; nothing here is trusted client-side.
export async function postUsersEndpoint(path: string, extraBody?: Record<string, unknown>): Promise<any> {
  const res = await fetchWithReauth(API_BASE_URL + path, function(token) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: token }, extraBody || {})),
    };
  });
  const data = await res.json().catch(function() { return {}; });
  if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}
