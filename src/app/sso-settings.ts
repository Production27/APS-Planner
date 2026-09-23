// Security & data > Sign in with Google (admins). Server side:
// worker/src/sso.ts. Until the server has a Google sign-in key this shows
// the redirect address that key needs; after that, the on/off switch and
// the allowed Workspace domains. Passwords always keep working.
import { showToast } from '../utils/ui';
import { postUsersEndpoint } from './worker-client';

interface SsoSettings { googleEnabled: boolean; allowedDomains: string[]; updatedBy?: string; updatedAt?: number }

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function render(settings: SsoSettings, configured: boolean, redirectUri: string): void {
  const off = el('ssoNotConfigured');
  const on = el('ssoConfigured');
  if (!off || !on) return;
  off.hidden = configured;
  on.hidden = !configured;
  const uri = el('ssoRedirectUri');
  if (uri) uri.textContent = redirectUri || '';
  el<HTMLInputElement>('ssoEnabledToggle')!.checked = settings.googleEnabled;
  el<HTMLInputElement>('ssoDomains')!.value = settings.allowedDomains.join(', ');
  const note = el('ssoNote');
  if (note) {
    note.textContent = settings.updatedBy && settings.updatedAt
      ? 'Last changed by ' + settings.updatedBy + ' on ' + new Date(settings.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) + '.'
      : '';
  }
}

export async function loadGoogleSettings(): Promise<void> {
  const section = el('ssoSection');
  if (!section) return;
  try {
    const data = await postUsersEndpoint('sso/settings');
    render(data.settings, !!data.configured, data.redirectUri || '');
  } catch (err) {
    // An older server without Google sign-in: hide the section.
    section.hidden = true;
  }
}

export async function saveGoogleSettings(): Promise<void> {
  const enabled = el<HTMLInputElement>('ssoEnabledToggle')!.checked;
  const domains = el<HTMLInputElement>('ssoDomains')!.value.split(/[\s,;]+/).filter(Boolean);
  const btn = el<HTMLButtonElement>('ssoSaveBtn');
  if (btn) btn.disabled = true;
  try {
    const data = await postUsersEndpoint('sso/settings', { googleEnabled: enabled, allowedDomains: domains });
    render(data.settings, !!data.configured, data.redirectUri || '');
    showToast('Google sign-in settings saved', 'success');
  } catch (err: any) {
    showToast('Could not save: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
