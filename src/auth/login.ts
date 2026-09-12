// The login overlay (#loginOverlay in the markup) and the token-refresh
// flow built on top of it. Replaces the old window.prompt()-pair flow —
// showLoginOverlay() displays it and waitForLoginSubmit() resolves once
// the form is submitted; reauthenticate() drives the two in a retry loop
// so a wrong password or a rate-limit lockout just re-shows the form with
// an inline message instead of throwing back up to the caller — there's
// no cancel affordance by design, matching blocking the whole app until a
// valid session exists (see index.html's boot() at the bottom of the
// file, which this whole flow exists to satisfy).
import { getStoredUsername, getStoredSessionToken, setStoredSessionToken, isSessionTokenUsable, decodeSessionTokenPayload, USERNAME_KEY } from './session';
import { applyIdentityFromTokenPayload } from './permissions';

let loginFormSubmit: (() => void) | null = null;

function showLoginOverlay(prefillUsername?: string): void {
  const userInput = document.getElementById('loginUsername') as HTMLInputElement;
  const passInput = document.getElementById('loginPassword') as HTMLInputElement;
  document.getElementById('loginOverlay')!.classList.add('show');
  userInput.value = prefillUsername || '';
  passInput.value = '';
  passInput.type = 'password';
  document.getElementById('loginPwToggle')!.classList.remove('showing');
  setLoginBusy(false);
  (prefillUsername ? passInput : userInput).focus();
}
function hideLoginOverlay(): void {
  document.getElementById('loginOverlay')!.classList.remove('show');
}
function setLoginBanner(message: string | null, tone?: string): void {
  const banner = document.getElementById('loginBanner')!;
  document.getElementById('loginFieldUser')!.classList.toggle('has-error', tone === 'err');
  document.getElementById('loginFieldPass')!.classList.toggle('has-error', tone === 'err');
  if (!message) { banner.classList.remove('show', 'err', 'lockout'); return; }
  document.getElementById('loginBannerText')!.textContent = message;
  banner.classList.add('show');
  banner.classList.toggle('err', tone === 'err');
  banner.classList.toggle('lockout', tone === 'lockout');
}
function setLoginBusy(busy: boolean): void {
  const btn = document.getElementById('loginSubmit') as HTMLButtonElement;
  btn.classList.toggle('loading', busy);
  btn.disabled = busy;
}
function waitForLoginSubmit(): Promise<{ username: string; password: string }> {
  return new Promise(function(resolve) {
    loginFormSubmit = function() {
      resolve({
        username: (document.getElementById('loginUsername') as HTMLInputElement).value.trim(),
        password: (document.getElementById('loginPassword') as HTMLInputElement).value,
      });
    };
  });
}
{
  const loginFormEl = document.getElementById('loginForm');
  if (loginFormEl) loginFormEl.addEventListener('submit', function(e) {
    e.preventDefault();
    if (loginFormSubmit) loginFormSubmit();
  });
}
{
  const loginPwToggleEl = document.getElementById('loginPwToggle');
  if (loginPwToggleEl) loginPwToggleEl.addEventListener('click', function(this: HTMLElement) {
    const passInput = document.getElementById('loginPassword') as HTMLInputElement;
    const showing = this.classList.toggle('showing');
    if (passInput) passInput.type = showing ? 'text' : 'password';
    this.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  });
}

// Shows the login overlay and loops on it until a real token is minted —
// caches only the username so people aren't asked for it again every
// visit (the password is used here purely in-memory to mint a token and
// is never written to localStorage). forceReprompt is true for a later
// reprompt (e.g. a token that stopped being accepted mid-session, not
// just the very first boot) and just changes the initial banner text.
// Deliberately never throws for a credential/lockout failure — the
// overlay has no cancel button, so the only way out of this loop is a
// successful login, which is also what lets this same function gate app
// boot.
export async function reauthenticate(forceReprompt?: boolean): Promise<string> {
  let username = getStoredUsername();
  showLoginOverlay(username);
  if (forceReprompt) setLoginBanner('Your session ended — please sign in again.', 'err');

  while (true) {
    const creds = await waitForLoginSubmit();
    username = creds.username;
    const password = creds.password;
    localStorage.setItem(USERNAME_KEY, username);
    setLoginBusy(true);

    let res: Response;
    try {
      // `name` is vestigial now that resolveIdentity() has no team-password
      // fallback path left to use it for — harmless to keep sending, not
      // worth a change just to remove an unused field.
      res = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, name: username }),
      });
    } catch (networkErr) {
      setLoginBusy(false);
      setLoginBanner('Could not reach the server — check your connection and try again.', 'err');
      continue;
    }

    if (res.status === 429) {
      // The Worker's login rate limiter tripped — this is not a bad
      // credential, so (unlike the block below) the cached username must
      // NOT be cleared: the account is fine, it's just temporarily locked
      // out. Surface the Worker's own message rather than a raw status code.
      let lockoutMessage = 'Too many attempts — try again in a few minutes.';
      try {
        const data = await res.json();
        if (data && data.error) lockoutMessage = data.error;
      } catch (e) { /* fall back to the default message above */ }
      setLoginBusy(false);
      setLoginBanner(lockoutMessage, 'lockout');
      (document.getElementById('loginPassword') as HTMLInputElement).focus();
      continue;
    }
    if (!res.ok) {
      // A rejected login (wrong username OR wrong password — the Worker's
      // handleAuth() doesn't distinguish which) must not leave a bad
      // username cached or displayed: every later attempt with no valid
      // token reuses getStoredUsername() as-is, so a typo on the very
      // first attempt would otherwise keep getting silently reused
      // forever. Clearing both here means the next attempt starts fresh
      // on both fields.
      localStorage.removeItem(USERNAME_KEY);
      (document.getElementById('loginUsername') as HTMLInputElement).value = '';
      (document.getElementById('loginPassword') as HTMLInputElement).value = '';
      setLoginBusy(false);
      setLoginBanner('Incorrect username or password.', 'err');
      document.getElementById('loginUsername')!.focus();
      continue;
    }

    const data = await res.json();
    if (!data || !data.token) {
      setLoginBusy(false);
      setLoginBanner('Unexpected error — please try again.', 'err');
      continue;
    }
    setStoredSessionToken(data.token);
    setLoginBusy(false);
    hideLoginOverlay();
    return data.token;
  }
}

// Returns a usable session token: the cached one if it's still valid
// (checked locally via isSessionTokenUsable(), no network call), otherwise
// mints a fresh one via reauthenticate() (which only prompts when there's
// no cached username, or when forced). Every authenticated call in the
// app goes through this instead of ever touching a stored password.
//
// Several independent things can all discover they need a token within
// the same tick at boot (the WebSocket connection, the user roster
// fetch, ...) — without the dedup below, each would independently see no
// cached token yet and call reauthenticate() on its own, prompting for
// the password once per caller instead of once total. inFlightAuthPromise
// makes every concurrent caller (forced or not) share the one request
// already in progress rather than starting their own.
let inFlightAuthPromise: Promise<string> | null = null;
export function reauthenticateOnce(forceReprompt?: boolean): Promise<string> {
  if (!inFlightAuthPromise) {
    inFlightAuthPromise = reauthenticate(forceReprompt).finally(function() { inFlightAuthPromise = null; });
  }
  return inFlightAuthPromise;
}
export async function getSessionToken(): Promise<string> {
  const cached = getStoredSessionToken();
  if (isSessionTokenUsable(cached)) return cached;
  return await reauthenticateOnce(false);
}

// Runs on every WebSocket (re)connect attempt (see buildRoomWsUrl() below,
// called fresh by ReconnectingWebSocket each try) — re-asserts project
// scoping/gating from whatever token ends up in play every time, in case
// an admin changed this account's tier/project assignment since the last
// connection. Only hits the network (via getSessionToken()) when there's
// no still-valid cached token; a valid one is reused and its claims
// re-decoded locally, rather than re-authenticating from scratch on every
// single reconnect. That does mean a role/project change now takes up to
// the token's TTL to be reflected here if the connection stays up the
// whole time without a single reconnect — an accepted tradeoff for a
// small trusted-team tool.
export async function fetchRoomToken(): Promise<string> {
  const token = await getSessionToken();
  applyIdentityFromTokenPayload(decodeSessionTokenPayload(token));
  return token;
}

// Called fresh by ReconnectingWebSocket on every (re)connect attempt, not
// just once — passing the async function itself (not its resolved value)
// as the url is what makes that happen, so a token minted hours ago never
// gets reused past its expiry on a long-lived tab's reconnect.
export async function buildRoomWsUrl(): Promise<string> {
  const token = await fetchRoomToken();
  const httpUrl = new URL('room', API_BASE_URL);
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  httpUrl.searchParams.set('token', token);
  return httpUrl.toString();
}
