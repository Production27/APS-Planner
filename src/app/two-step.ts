// Settings > Two-step verification (#mfaModal): anyone can turn it on for
// their own account, make new recovery codes, or turn it off (unless the
// company requires it). Admins also get the company-wide "require it"
// switch in Security & data, and "Reset two-step" in Manage Users.
// Server side: worker/src/mfa.ts and mfa-handlers.ts.
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint } from './worker-client';
import { getStoredUsername } from '../auth/session';
import { renderQrInto, renderRecoveryCodesInto, formatSecret } from '../auth/two-step-render';

interface MfaStatus { enabled: boolean; enabledAt: number | null; recoveryCodesLeft: number; required: boolean }

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function val(id: string): string {
  return (el<HTMLInputElement>(id).value || '').trim();
}
function clearInputs(): void {
  ['mfaSetupPassword', 'mfaSetupCode', 'mfaManageCode', 'mfaDisablePassword'].forEach(function (id) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = '';
  });
}

type View = 'loading' | 'off' | 'setup' | 'codes' | 'on';
function showView(view: View): void {
  (['off', 'setup', 'codes', 'on'] as View[]).forEach(function (v) {
    el('mfa' + v.charAt(0).toUpperCase() + v.slice(1)).hidden = v !== view;
  });
  el('mfaLoading').hidden = view !== 'loading';
}

function renderOn(status: MfaStatus): void {
  el('mfaOnSince').textContent = status.enabledAt ? new Date(status.enabledAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
  el('mfaCodesLeft').textContent = String(status.recoveryCodesLeft);
  el('mfaCodesLeftWarn').hidden = status.recoveryCodesLeft > 2;
  el('mfaRequiredNote').hidden = !status.required;
  el('mfaDisableGroup').hidden = status.required;
  el('mfaDisableBtn').hidden = status.required;
  showView('on');
}

export async function openTwoStepModal(): Promise<void> {
  clearInputs();
  showView('loading');
  openModal('mfaModal');
  try {
    const status: MfaStatus = await postUsersEndpoint('mfa/status');
    if (status.enabled) renderOn(status); else showView('off');
  } catch (err: any) {
    closeModal('mfaModal');
    showToast('Could not load two-step verification: ' + err.message, 'error');
  }
}

export function closeTwoStepModal(): void {
  clearInputs();
  el('mfaQr').innerHTML = '';
  el('mfaSecret').textContent = '';
  el('mfaCodesList').innerHTML = '';
  closeModal('mfaModal');
}

export async function startTwoStepSetup(): Promise<void> {
  const password = el<HTMLInputElement>('mfaSetupPassword').value;
  if (!password) { showToast('Enter your password', 'error'); return; }
  try {
    const data = await postUsersEndpoint('mfa/setup', { password: password });
    el<HTMLInputElement>('mfaSetupPassword').value = '';
    renderQrInto(el('mfaQr'), data.uri);
    el('mfaSecret').textContent = formatSecret(data.secret);
    showView('setup');
    el('mfaSetupCode').focus();
  } catch (err: any) {
    showToast('Could not start setup: ' + err.message, 'error');
  }
}

export async function confirmTwoStepSetup(): Promise<void> {
  const code = val('mfaSetupCode').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) { showToast('Enter the 6-digit code from your app', 'error'); return; }
  try {
    const data = await postUsersEndpoint('mfa/enable', { code: code });
    el('mfaQr').innerHTML = '';
    el('mfaSecret').textContent = '';
    renderRecoveryCodesInto(el('mfaCodesList'), data.recoveryCodes, getStoredUsername());
    showView('codes');
    showToast('Two-step verification is on', 'success');
  } catch (err: any) {
    showToast(err.message, 'error');
  }
}

export async function makeNewRecoveryCodes(): Promise<void> {
  const code = val('mfaManageCode');
  if (!code) { showToast('Enter a code from your app first', 'error'); return; }
  try {
    const data = await postUsersEndpoint('mfa/recovery-codes', { code: code });
    clearInputs();
    renderRecoveryCodesInto(el('mfaCodesList'), data.recoveryCodes, getStoredUsername());
    showView('codes');
    showToast('New recovery codes made. The old ones no longer work.', 'success');
  } catch (err: any) {
    showToast('Could not make new codes: ' + err.message, 'error');
  }
}

export async function turnOffTwoStep(): Promise<void> {
  const code = val('mfaManageCode');
  const password = el<HTMLInputElement>('mfaDisablePassword').value;
  if (!code || !password) { showToast('Enter a code from your app and your password', 'error'); return; }
  try {
    await postUsersEndpoint('mfa/disable', { code: code, password: password });
    clearInputs();
    showView('off');
    showToast('Two-step verification is off', 'info');
  } catch (err: any) {
    showToast('Could not turn it off: ' + err.message, 'error');
  }
}

// ---- Admin: the company-wide policy (Security & data) ----
export async function loadSignInPolicy(): Promise<void> {
  const box = document.getElementById('requireMfaToggle') as HTMLInputElement | null;
  if (!box) return;
  box.disabled = true;
  try {
    const data = await postUsersEndpoint('security/policy');
    box.checked = !!data.policy.requireMfa;
    renderPolicyNote(data.policy);
  } catch (err) {
    // Leave it disabled; the rest of the panel still works.
    return;
  }
  box.disabled = false;
}

function renderPolicyNote(policy: { requireMfa: boolean; updatedBy?: string; updatedAt?: number }): void {
  const note = document.getElementById('requireMfaNote');
  if (!note) return;
  note.textContent = policy.updatedBy && policy.updatedAt
    ? 'Last changed by ' + policy.updatedBy + ' on ' + new Date(policy.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) + '.'
    : '';
}

export async function setRequireTwoStep(on: boolean): Promise<void> {
  const box = document.getElementById('requireMfaToggle') as HTMLInputElement;
  if (on && !window.confirm('Require two-step verification for everyone?\n\nAnyone who hasn\'t set it up will be asked to at their next sign-in, and nobody can turn it off while this is on.')) {
    box.checked = false;
    return;
  }
  box.disabled = true;
  try {
    const data = await postUsersEndpoint('security/policy', { requireMfa: on });
    box.checked = !!data.policy.requireMfa;
    renderPolicyNote(data.policy);
    showToast(on ? 'Two-step verification is now required' : 'Two-step verification is no longer required', 'success');
  } catch (err: any) {
    box.checked = !on;
    showToast('Could not change the setting: ' + err.message, 'error');
  } finally {
    box.disabled = false;
  }
}

// ---- Admin: Manage Users > Reset two-step ----
export async function resetUserTwoStep(username: string, displayName: string): Promise<boolean> {
  if (!window.confirm('Turn off two-step verification for ' + displayName + '?\n\nDo this if they lost their phone and recovery codes. They can sign in with just their password until they set it up again' + ' (or, if your company requires it, they\'ll be asked to at their next sign-in).')) {
    return false;
  }
  try {
    await postUsersEndpoint('users/reset-mfa', { targetUsername: username });
    showToast('Two-step verification reset for ' + displayName, 'success');
    return true;
  } catch (err: any) {
    showToast('Could not reset: ' + err.message, 'error');
    return false;
  }
}
