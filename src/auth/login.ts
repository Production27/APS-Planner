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
import { renderQrInto, renderRecoveryCodesInto, formatSecret } from './two-step-render';
import { showToast } from '../utils/ui';

let loginFormSubmit: (() => void) | null = null;

// Which part of the overlay is showing: the password form, or one of the
// two-step verification steps (see runCodeStep()/runSetupStep() below).
type LoginStep = 'password' | 'code' | 'setup' | 'recovery';
const STEP_FORMS: Record<LoginStep, string> = { password: 'loginForm', code: 'loginMfaForm', setup: 'loginMfaSetupForm', recovery: 'loginRecoveryForm' };
function showLoginStep(step: LoginStep): void {
  (Object.keys(STEP_FORMS) as LoginStep[]).forEach(function(k) {
    const form = document.getElementById(STEP_FORMS[k]);
    if (form) form.hidden = k !== step;
  });
  const forgot = document.getElementById('loginForgot');
  if (forgot) forgot.hidden = step !== 'password';
  const sso = document.getElementById('loginSso');
  if (sso) sso.hidden = !(step === 'password' && googleSignInOffered);
}

// ---- Sign in with Google (worker/src/sso.ts) ----
// The button shows only when the server says an admin turned it on. It
// sends the whole page to Google via the Worker; Google sends it back here
// with #sso_code=... (a one-time code swapped for a session below) or
// #sso_error=....
let googleSignInOffered = false;
async function refreshSsoConfig(): Promise<void> {
  try {
    const res = await fetch(API_BASE_URL + 'sso/config', { cache: 'no-store' });
    const data = await res.json();
    googleSignInOffered = !!(res.ok && data && data.google);
  } catch (e) {
    googleSignInOffered = false;
  }
  const form = document.getElementById('loginForm');
  const sso = document.getElementById('loginSso');
  if (sso) sso.hidden = !(googleSignInOffered && form && !form.hidden);
}
{
  const googleBtn = document.getElementById('loginGoogleBtn') as HTMLButtonElement | null;
  if (googleBtn) googleBtn.addEventListener('click', function() {
    googleBtn.disabled = true;
    const here = location.href.split('#')[0];
    location.assign(API_BASE_URL + 'sso/google/start?return=' + encodeURIComponent(here));
  });
}

export const SSO_ERROR_MESSAGES: Record<string, string> = {
  no_account: 'That Google account isn’t linked to a TeamSync account. Ask your admin to add your Google email in Manage Users.',
  domain: 'That Google account isn’t from your company. Sign in with your work Google account.',
  cancelled: 'Google sign-in was cancelled.',
  expired: 'That sign-in took too long, or was started in another browser. Try again.',
  not_enabled: 'Sign in with Google isn’t turned on.',
  failed: 'Google sign-in didn’t work. Try again.',
};
let pendingSsoError: string | null = null;
let ssoReturnPromise: Promise<string | null> | null = null;

// Handles the page coming back from Google, once per page load. Returns
// the new session token, or null (nothing to handle, or it failed, in
// which case the sign-in screen shows why).
function takeSsoReturn(): Promise<string | null> {
  if (ssoReturnPromise) return ssoReturnPromise;
  ssoReturnPromise = (async function(): Promise<string | null> {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const code = params.get('sso_code');
    const error = params.get('sso_error');
    if (!code && !error) return null;
    // Take the code out of the address bar and history straight away.
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// in tests */ }
    if (error) { pendingSsoError = SSO_ERROR_MESSAGES[error] || SSO_ERROR_MESSAGES.failed; return null; }
    const { res, data } = await postJson('sso/redeem', { code: code });
    if (res && res.ok && data.token) {
      setStoredSessionToken(data.token);
      if (data.user && data.user.username) localStorage.setItem(USERNAME_KEY, data.user.username);
      return data.token as string;
    }
    pendingSsoError = (data && data.error) || SSO_ERROR_MESSAGES.failed;
    return null;
  })();
  return ssoReturnPromise;
}

// Resolves 'submit' when the step's form is submitted, or 'back' when its
// "Back to sign in" link is clicked. One pending wait per form.
const stepWaiters: Record<string, ((how: 'submit' | 'back') => void) | undefined> = {};
function waitForStep(formId: string): Promise<'submit' | 'back'> {
  return new Promise(function(resolve) { stepWaiters[formId] = resolve; });
}
function settleStep(formId: string, how: 'submit' | 'back'): void {
  const w = stepWaiters[formId];
  stepWaiters[formId] = undefined;
  if (w) w(how);
}
[['loginMfaForm', 'loginMfaBack'], ['loginMfaSetupForm', 'loginMfaSetupBack'], ['loginRecoveryForm', '']].forEach(function(pair) {
  const form = document.getElementById(pair[0]);
  if (form) form.addEventListener('submit', function(e) { e.preventDefault(); settleStep(pair[0], 'submit'); });
  const back = pair[1] ? document.getElementById(pair[1]) : null;
  if (back) back.addEventListener('click', function() { settleStep(pair[0], 'back'); });
});

function setButtonBusy(id: string, busy: boolean): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  btn.classList.toggle('loading', busy);
  btn.disabled = busy;
}

async function postJson(path: string, body: Record<string, unknown>): Promise<{ res: Response | null; data: any }> {
  try {
    const res = await fetch(API_BASE_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(function() { return {}; });
    return { res, data };
  } catch (e) {
    return { res: null, data: {} };
  }
}

// Second half of a sign-in for an account with two-step verification on.
// Returns the session token, or null to go back to the password form
// (the user clicked Back, or the ticket expired).
async function runCodeStep(ticket: string): Promise<string | null> {
  const input = document.getElementById('loginCode') as HTMLInputElement;
  showLoginStep('code');
  setLoginBanner(null);
  input.value = '';
  input.focus();
  while (true) {
    if (await waitForStep('loginMfaForm') === 'back') { setLoginBanner(null); return null; }
    const code = input.value.trim();
    if (!code) continue;
    setButtonBusy('loginCodeSubmit', true);
    const { res, data } = await postJson('auth/mfa', { ticket: ticket, code: code });
    setButtonBusy('loginCodeSubmit', false);
    if (!res) { setLoginBanner('Could not reach the server — check your connection and try again.', 'err'); continue; }
    if (res.ok && data.token) {
      if (typeof data.recoveryCodesLeft === 'number') {
        const left = data.recoveryCodesLeft;
        setTimeout(function() {
          showToast('You used a recovery code — ' + left + ' left. Make new ones in Settings → Two-step verification.', left <= 2 ? 'error' : 'info');
        }, 0);
      }
      return data.token;
    }
    if (res.status === 429) { setLoginBanner(data.error || 'Too many attempts — try again in a few minutes.', 'lockout'); continue; }
    setLoginBanner(data.error || 'That code didn’t work.', 'err');
    if (data.restart) return null;
    input.value = '';
    input.focus();
  }
}

// For someone the company requires to use two-step verification who
// hasn't set it up: shows the QR code, checks the first code, shows the
// recovery codes once, and returns the session token (or null to go back
// to the password form).
async function runSetupStep(ticket: string, username: string): Promise<string | null> {
  setLoginBanner(null);
  const start = await postJson('mfa/setup', { ticket: ticket });
  if (!start.res || !start.res.ok || !start.data.uri) {
    setLoginBanner(start.data.error || 'Could not start two-step setup — try again.', 'err');
    return null;
  }
  renderQrInto(document.getElementById('loginMfaQr')!, start.data.uri);
  document.getElementById('loginMfaSecret')!.textContent = formatSecret(start.data.secret);
  const input = document.getElementById('loginSetupCode') as HTMLInputElement;
  input.value = '';
  showLoginStep('setup');
  input.focus();
  const clear = function() {
    document.getElementById('loginMfaQr')!.innerHTML = '';
    document.getElementById('loginMfaSecret')!.textContent = '';
  };
  while (true) {
    if (await waitForStep('loginMfaSetupForm') === 'back') { clear(); setLoginBanner(null); return null; }
    const code = input.value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { setLoginBanner('Enter the 6-digit code from your app.', 'err'); continue; }
    setButtonBusy('loginSetupSubmit', true);
    const { res, data } = await postJson('mfa/enable', { ticket: ticket, code: code });
    setButtonBusy('loginSetupSubmit', false);
    if (!res) { setLoginBanner('Could not reach the server — check your connection and try again.', 'err'); continue; }
    if (res.ok && data.token) {
      clear();
      setLoginBanner(null);
      renderRecoveryCodesInto(document.getElementById('loginRecoveryCodes')!, data.recoveryCodes || [], username);
      showLoginStep('recovery');
      await waitForStep('loginRecoveryForm');
      document.getElementById('loginRecoveryCodes')!.innerHTML = '';
      return data.token;
    }
    setLoginBanner(data.error || 'That code didn’t match.', 'err');
    if (data.restart || res.status === 410) { clear(); return null; }
    input.value = '';
    input.focus();
  }
}

function showLoginOverlay(prefillUsername?: string): void {
  const userInput = document.getElementById('loginUsername') as HTMLInputElement;
  const passInput = document.getElementById('loginPassword') as HTMLInputElement;
  document.getElementById('loginOverlay')!.classList.add('show');
  showLoginStep('password');
  refreshSsoConfig();
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
  if (pendingSsoError) { setLoginBanner(pendingSsoError, 'err'); pendingSsoError = null; }

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
    if (res.status === 403) {
      // "Google only" is on for this company (worker/src/sso.ts): the
      // password was right, but this account has to use Google.
      let message = 'Your company signs in with Google.';
      try { const d = await res.json(); if (d && d.error) message = d.error; } catch (e) { /* default above */ }
      (document.getElementById('loginPassword') as HTMLInputElement).value = '';
      setLoginBusy(false);
      setLoginBanner(message, 'lockout');
      continue;
    }
    if (!res.ok) {
      // A rejected login (wrong username OR wrong password — the Worker's
      // handleAuth() doesn't distinguish which) must not leave a bad
      // username cached: a later boot's reauthenticate() reuses
      // getStoredUsername() as-is, so a typo on the very first attempt
      // would otherwise keep getting silently reused forever. That's only
      // about what a *future* page load prefills, though — it doesn't
      // require blanking the username field the user is looking at right
      // now within this same loop, so only the password is cleared here;
      // the user shouldn't have to retype a username they just typed
      // correctly because the password was wrong.
      localStorage.removeItem(USERNAME_KEY);
      (document.getElementById('loginPassword') as HTMLInputElement).value = '';
      setLoginBusy(false);
      setLoginBanner('Incorrect username or password.', 'err');
      document.getElementById('loginPassword')!.focus();
      continue;
    }

    const data = await res.json();
    setLoginBusy(false);
    let token: string | null = data && data.token;
    // Two-step verification: the password was right, and the server
    // handed back a short-lived ticket for the next step instead of a
    // session.
    if (data && data.ticket && (data.mfaRequired || data.mfaSetupRequired)) {
      token = data.mfaRequired ? await runCodeStep(data.ticket) : await runSetupStep(data.ticket, username);
      if (!token) {
        showLoginStep('password');
        (document.getElementById('loginPassword') as HTMLInputElement).value = '';
        document.getElementById('loginPassword')!.focus();
        continue;
      }
    }
    if (!token) {
      setLoginBanner('Unexpected error — please try again.', 'err');
      continue;
    }
    setStoredSessionToken(token);
    hideLoginOverlay();
    showLoginStep('password');
    return token;
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
  const fromGoogle = await takeSsoReturn();
  if (fromGoogle) return fromGoogle;
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
  // Sync protocol 2: after each write the server sends only what changed
  // ({type:'delta'}, see src/sync/inbound.ts) instead of a full snapshot.
  // An older server ignores this and keeps sending snapshots, which are
  // still handled, so client and worker can be deployed in either order.
  httpUrl.searchParams.set('proto', '2');
  return httpUrl.toString();
}
