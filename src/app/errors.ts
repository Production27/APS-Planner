// Error log (client-reported errors, viewable by admins via the Worker).
import { openModal, closeModal, showToast } from '../utils/ui';
import { escapeHtml } from '../utils/html';
import { postUsersEndpoint } from './worker-client';

export function openErrorsModal(): void {
  openModal('errorsModal');
  loadErrorsList();
}
export function closeErrorsModal(): void {
  closeModal('errorsModal');
}

export async function loadErrorsList(): Promise<void> {
  const statusEl = document.getElementById('errorsListStatus')!;
  const listEl = document.getElementById('errorsList')!;
  statusEl.textContent = 'Loading…';
  listEl.innerHTML = '';
  try {
    const data = await postUsersEndpoint('errors/list', {});
    statusEl.textContent = `${data.errors.length} report(s) — most recent first`;
    if (!data.errors.length) {
      listEl.innerHTML = '<div style="padding: var(--s-3-5); color:var(--text-secondary);">No errors reported. Good sign.</div>';
      return;
    }
    data.errors.forEach(function(e: any) {
      const row = document.createElement('div');
      row.style.cssText = 'padding: var(--s-2-5) var(--s-3); border-bottom:1px solid var(--border);';
      const who = e.username ? escapeHtml(e.username) + (e.role ? ' (' + escapeHtml(e.role) + ')' : '') : 'unauthenticated';
      const where = e.source ? escapeHtml(e.source) + (e.line ? ':' + e.line : '') : '';
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap: var(--s-2); font-size: var(--t-sm); color:var(--text-secondary); margin-bottom: var(--s-1);">
          <span>${new Date(e.receivedAt).toLocaleString()} — ${who}</span>
          <span>${escapeHtml(e.kind || 'error')}</span>
        </div>
        <div style="font-size: var(--t-base); font-weight:600; word-break:break-word;">${escapeHtml(e.message || '(no message)')}</div>
        ${where ? '<div style="font-size: var(--t-sm); color:var(--text-secondary); margin-top: var(--s-0-5);">' + where + '</div>' : ''}
      `;
      listEl.appendChild(row);
    });
  } catch (err: any) {
    statusEl.textContent = '';
    showToast('Could not load errors: ' + err.message, 'error');
  }
}
