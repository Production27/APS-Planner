// Settings > Security & data (admins): download the audit log, export all
// company data, and schedule or cancel deletion of all company data. Plus
// the deletion warning banner every signed-in user sees while a deletion is
// pending. Server side: worker/src/compliance.ts and worker/src/audit.ts.
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint, fetchWithReauth } from './worker-client';
import { toCsv, downloadTextFile } from './export';
import { toIsoDate } from '../utils/date';
import { loadSignInPolicy } from './two-step';
import { loadGoogleSettings } from './sso-settings';

interface AuditEntry {
  at: number; user: string; role?: string; action: string; projectId?: string | null; projectName?: string;
  item?: string; itemId?: string; ip?: string; details?: string;
}
interface ScheduledDeletion { requestedBy: string; requestedAt: number; executeAt: number }

export const DELETION_CONFIRM_PHRASE = 'DELETE ALL DATA';
const AUDIT_DEFAULT_DAYS = 90;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function openSecurityModal(): void {
  const from = el<HTMLInputElement>('auditFrom');
  const to = el<HTMLInputElement>('auditTo');
  const start = new Date();
  start.setDate(start.getDate() - AUDIT_DEFAULT_DAYS);
  if (from) from.value = toIsoDate(start);
  if (to) to.value = toIsoDate(new Date());
  renderDeletionSection(lastDeletionStatus);
  openModal('securityModal');
  refreshDeletionStatus();
  loadSignInPolicy();
  loadGoogleSettings();
}

export function closeSecurityModal(): void {
  closeModal('securityModal');
  const pw = el<HTMLInputElement>('deletionPassword');
  if (pw) pw.value = '';
}

// ---- Audit log ----
export function auditRowsToCsv(entries: AuditEntry[]): string {
  const rows: (string | number)[][] = [['Time (UTC)', 'Time (local)', 'User', 'Role', 'Action', 'Project', 'Item', 'Item ID', 'IP address', 'Details']];
  entries.forEach(function (e) {
    const d = new Date(e.at);
    rows.push([
      d.toISOString().replace('T', ' ').slice(0, 19),
      d.toLocaleString(),
      e.user || '', e.role || '', e.action || '', e.projectName || e.projectId || '',
      e.item || '', e.itemId || '', e.ip || '', e.details || '',
    ]);
  });
  return toCsv(rows);
}

export async function downloadAuditLog(): Promise<void> {
  const fromVal = (el<HTMLInputElement>('auditFrom') || { value: '' }).value;
  const toVal = (el<HTMLInputElement>('auditTo') || { value: '' }).value;
  if (!fromVal || !toVal) { showToast('Pick a start and end date', 'error'); return; }
  const from = new Date(fromVal + 'T00:00:00').getTime();
  const to = new Date(toVal + 'T23:59:59.999').getTime();
  if (!(to >= from)) { showToast('The end date is before the start date', 'error'); return; }
  const btn = el<HTMLButtonElement>('auditDownloadBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const entries: AuditEntry[] = [];
    let after: string | null = null;
    do {
      const page: { entries: AuditEntry[]; cursor: string | null } = await postUsersEndpoint('audit/export', { from: from, to: to, after: after });
      entries.push.apply(entries, page.entries || []);
      after = page.cursor;
    } while (after);
    downloadTextFile('teamsync-audit-log-' + fromVal + '-to-' + toVal + '.csv', auditRowsToCsv(entries), 'text/csv');
    showToast(entries.length + ' audit entr' + (entries.length === 1 ? 'y' : 'ies') + ' downloaded', 'success');
  } catch (err: any) {
    showToast('Could not download the audit log: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download CSV'; }
  }
}

// ---- Export all data ----
export async function exportAllData(): Promise<void> {
  const btn = el<HTMLButtonElement>('dataExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const res = await fetchWithReauth(API_BASE_URL + 'data/export', function (token) {
      return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) };
    });
    if (!res.ok) {
      const data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || ('Request failed: ' + res.status));
    }
    downloadTextFile('teamsync-export-' + toIsoDate(new Date()) + '.json', await res.text(), 'application/json', false);
    showToast('Company data exported', 'success');
  } catch (err: any) {
    showToast('Could not export: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download export'; }
  }
}

// ---- Delete all data ----
let lastDeletionStatus: ScheduledDeletion | null = null;

function renderDeletionSection(scheduled: ScheduledDeletion | null): void {
  const idle = el('deletionIdle');
  const pending = el('deletionPending');
  if (!idle || !pending) return;
  idle.hidden = !!scheduled;
  pending.hidden = !scheduled;
  if (scheduled) {
    const when = el('deletionPendingWhen');
    if (when) when.textContent = formatWhen(scheduled.executeAt);
    const by = el('deletionPendingBy');
    if (by) by.textContent = scheduled.requestedBy + ' on ' + formatWhen(scheduled.requestedAt);
  }
}

export function applyDeletionStatus(scheduled: ScheduledDeletion | null): void {
  lastDeletionStatus = scheduled;
  renderDeletionSection(scheduled);
  const banner = el('dataDeletionBanner');
  if (!banner) return;
  banner.classList.toggle('show', !!scheduled);
  const text = el('dataDeletionBannerText');
  if (text && scheduled) {
    text.textContent = 'All company data is scheduled for permanent deletion on ' + formatWhen(scheduled.executeAt) +
      ' (requested by ' + scheduled.requestedBy + '). An admin can cancel this in Settings → Security & data.';
  }
}

export async function refreshDeletionStatus(): Promise<void> {
  try {
    const data = await postUsersEndpoint('data/delete/status');
    applyDeletionStatus(data.scheduled || null);
  } catch (err) {
    // Offline, or signed out: the next check tries again.
  }
}

export async function scheduleDeletion(): Promise<void> {
  const pw = el<HTMLInputElement>('deletionPassword');
  const phrase = el<HTMLInputElement>('deletionPhrase');
  if (!pw || !phrase) return;
  if (phrase.value !== DELETION_CONFIRM_PHRASE) { showToast('Type ' + DELETION_CONFIRM_PHRASE + ' exactly to confirm', 'error'); return; }
  if (!pw.value) { showToast('Enter your password', 'error'); return; }
  try {
    const data = await postUsersEndpoint('data/delete/schedule', { password: pw.value, confirm: phrase.value });
    pw.value = '';
    phrase.value = '';
    applyDeletionStatus(data.scheduled || null);
    showToast('Deletion scheduled. Any admin can cancel it before then.', 'info');
  } catch (err: any) {
    showToast('Could not schedule deletion: ' + err.message, 'error');
  }
}

export async function cancelDeletion(): Promise<void> {
  try {
    await postUsersEndpoint('data/delete/cancel');
    applyDeletionStatus(null);
    showToast('Deletion cancelled. Nothing was deleted.', 'success');
  } catch (err: any) {
    showToast('Could not cancel: ' + err.message, 'error');
  }
}

// Every signed-in user checks for a pending deletion at startup and every
// 15 minutes, so nobody is surprised by it.
export function startDeletionStatusChecks(): void {
  refreshDeletionStatus();
  setInterval(refreshDeletionStatus, 15 * 60 * 1000);
}
