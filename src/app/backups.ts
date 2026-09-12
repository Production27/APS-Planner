// Backups (shared room, via the Cloudflare Worker). Used to be gated by
// a separate shared team password, unrelated to individual accounts. Now
// uses the caller's own logged-in session token — same as every other
// authenticated action — and the Worker itself additionally requires
// that account be Admin-tier.
import { openModal, closeModal, showToast } from '../utils/ui';
import { postUsersEndpoint, fetchWithReauth } from './worker-client';

export function openBackupsModal(): void {
  openModal('backupsModal');
  loadBackupsList();
}
export function closeBackupsModal(): void {
  closeModal('backupsModal');
}

export async function triggerBackupNow(): Promise<void> {
  const statusEl = document.getElementById('backupsListStatus')!;
  statusEl.textContent = 'Running backup…';
  try {
    // postUsersEndpoint() — POST + JSON body, not a GET query string
    // carrying the admin password into Worker access logs.
    await postUsersEndpoint('trigger-backup', {});
    logActivity('triggered manual backup');
    showToast('Backup saved', 'success');
    loadBackupsList();
  } catch (err: any) {
    statusEl.textContent = '';
    showToast('Backup failed: ' + err.message, 'error');
  }
}

export async function loadBackupsList(): Promise<void> {
  const statusEl = document.getElementById('backupsListStatus')!;
  const listEl = document.getElementById('backupsList')!;
  statusEl.textContent = 'Loading…';
  listEl.innerHTML = '';
  try {
    const data = await postUsersEndpoint('list-backups', {});
    statusEl.textContent = `${data.backups.length} backup(s) — most recent first`;
    if (!data.backups.length) {
      listEl.innerHTML = '<div style="padding: var(--s-3-5); color:var(--text-secondary);">No backups yet.</div>';
      return;
    }
    data.backups.forEach((b: any) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding: var(--s-2-5) var(--s-3); border-bottom:1px solid var(--border); gap: var(--s-2);';
      const isSafety = b.key.includes('pre-restore-safety');
      row.innerHTML = `
        <div style="min-width:0;">
          <div style="font-size: var(--t-base); font-weight:600;">${isSafety ? '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z" fill="#3949ab"/><path d="M8.5 12l2.5 2.5 5-5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg> Safety snapshot' : '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M3 8l9-4 9 4-9 4-9-4z" fill="#d7ccc8"/><path d="M3 8v9l9 4V12L3 8z" fill="#bcaaa4"/><path d="M21 8v9l-9 4V12l9-4z" fill="#a1887f"/></svg> Backup'}</div>
          <div style="font-size: var(--t-sm); color:var(--text-secondary);">${b.date}</div>
        </div>
        <div style="display:flex; gap: var(--s-1-5); flex-shrink:0;">
          <button class="btn btn-secondary" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="download" data-min-tier="admin"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v12m0 0l-5-5m5 5l5-5" stroke="#28a745" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><rect x="4" y="19" width="16" height="2.5" rx="1.25" fill="#28a745"/></svg></button>
          <button class="btn btn-danger" style="padding: var(--s-1) var(--s-2-5); font-size: var(--t-sm);" data-action="restore" data-min-tier="admin"><svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><path d="M6 8H3V5" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 8a9 9 0 1 1 2 8" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round"/></svg> Restore</button>
        </div>`;
      row.querySelector('[data-action="download"]')!.addEventListener('click', () => downloadBackupFile(b.key));
      row.querySelector('[data-action="restore"]')!.addEventListener('click', () => restoreBackupFile(b.key, b.date));
      listEl.appendChild(row);
    });
    applyPermissionGating(); // rebuilt on every list refresh, outside renderAll()'s own sweep
  } catch (err: any) {
    statusEl.textContent = '';
    showToast('Could not load backups: ' + err.message, 'error');
  }
}

export async function downloadBackupFile(key: string): Promise<void> {
  try {
    const res = await fetchWithReauth(API_BASE_URL + 'download-backup', function(token) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, key: key }),
      };
    });
    if (!res.ok) {
      const data = await res.json().catch(function() { return {}; });
      throw new Error(data.error || ('Download failed: ' + res.status));
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = 'aps-backup-' + key.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err: any) {
    showToast('Download failed: ' + err.message, 'error');
  }
}

export async function restoreBackupFile(key: string, dateLabel: string): Promise<void> {
  const step1 = window.confirm(
    `Restore the SHARED project back to the backup from:\n\n${dateLabel}\n\n` +
    `This replaces the live data for everyone and briefly disconnects the team while it happens. ` +
    `A safety snapshot of today's current data is saved automatically first, so this can be undone. Continue?`
  );
  if (!step1) return;

  const typed = window.prompt('Type RESTORE (all caps) to confirm this action:');
  if (typed !== 'RESTORE') {
    showToast('Restore cancelled', 'error');
    return;
  }

  const statusEl = document.getElementById('backupsListStatus')!;
  statusEl.textContent = 'Restoring… please wait';
  try {
    await postUsersEndpoint('restore-backup', { key: key, confirm: 'RESTORE' });
    logActivity('restored from backup');
    showToast('Restore complete — reloading…', 'success');
    setTimeout(() => window.location.reload(), 1500);
  } catch (err: any) {
    statusEl.textContent = '';
    showToast('Restore failed: ' + err.message, 'error');
  }
}
