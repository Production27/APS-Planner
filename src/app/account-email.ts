// Settings > My email (#accountEmailModal): anyone can add or change their
// own email after re-entering their password, and (when Google sign-in is
// on) confirm it with "Connect Google account". Server side:
// worker/src/account.ts and worker/src/sso.ts; the confirmed/unconfirmed
// rules are explained in worker/src/users.ts.
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint } from './worker-client';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function renderStatus(email: string, confirmed: boolean): void {
  const status = el('myEmailStatus');
  status.textContent = '';
  if (!email) {
    status.textContent = 'No email on your account yet.';
    return;
  }
  const b = document.createElement('b');
  b.textContent = email;
  const badge = document.createElement('span');
  badge.className = 'my-email-badge ' + (confirmed ? 'ok' : 'pending');
  badge.textContent = confirmed ? 'Confirmed' : 'Not confirmed';
  status.append('Your email: ', b, ' ', badge);
  el('myEmailUnconfirmedNote').hidden = confirmed;
}

export async function openAccountEmailModal(): Promise<void> {
  el<HTMLInputElement>('myEmailInput').value = '';
  el<HTMLInputElement>('myEmailPassword').value = '';
  el('myEmailStatus').textContent = 'Loading…';
  el('myEmailUnconfirmedNote').hidden = true;
  el('myEmailGoogle').hidden = true;
  openModal('accountEmailModal');
  try {
    const me = await postUsersEndpoint('account/me');
    renderStatus(me.email || '', !!me.emailConfirmed);
    el<HTMLInputElement>('myEmailInput').value = me.email || '';
  } catch (err: any) {
    el('myEmailStatus').textContent = 'Could not load your account: ' + err.message;
  }
  try {
    const res = await fetch(API_BASE_URL + 'sso/config', { cache: 'no-store' });
    const cfg = await res.json();
    el('myEmailGoogle').hidden = !(res.ok && cfg && cfg.google);
  } catch (e) { /* leave the Google part hidden */ }
}

export function closeAccountEmailModal(): void {
  el<HTMLInputElement>('myEmailPassword').value = '';
  closeModal('accountEmailModal');
}

export async function saveMyEmail(): Promise<void> {
  const email = el<HTMLInputElement>('myEmailInput').value.trim();
  const password = el<HTMLInputElement>('myEmailPassword').value;
  if (!password) { showToast('Enter your password to change your email', 'error'); return; }
  try {
    const data = await postUsersEndpoint('account/email', { email: email, password: password });
    el<HTMLInputElement>('myEmailPassword').value = '';
    renderStatus(data.email || '', !!data.emailConfirmed);
    showToast(data.email ? 'Email saved. You can now sign in with it.' : 'Email removed', 'success');
  } catch (err: any) {
    showToast('Could not save your email: ' + err.message, 'error');
  }
}

// Sends the page through Google (worker/src/sso.ts, "Connect Google
// account"); it comes back with #sso_linked=... (handled in login.ts).
export async function connectGoogleAccount(): Promise<void> {
  const btn = el<HTMLButtonElement>('myEmailGoogleBtn');
  btn.disabled = true;
  try {
    const data = await postUsersEndpoint('sso/link-ticket');
    const here = location.href.split('#')[0];
    location.assign(API_BASE_URL + 'sso/google/start?return=' + encodeURIComponent(here) + '&link=' + encodeURIComponent(data.ticket));
  } catch (err: any) {
    btn.disabled = false;
    showToast('Could not start: ' + err.message, 'error');
  }
}
