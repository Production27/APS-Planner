// The red badge on the Settings button and its Admin tab (see the worker's
// admin-notices.ts). Counts app crashes and notable account events —
// someone changing their email, users added or removed, two-step turned
// off, and so on — that happened since this admin last opened the Admin
// tab. Recent Errors gets its own count of the new errors. Polled like
// maintenance.ts rather than pushed; a couple of minutes late is fine.
import { postUsersEndpoint } from './worker-client';
import { setAdminTabOnOpen } from './settings-menu';

interface AdminNotice {
  at: number;
  kind: 'account' | 'error';
}

const POLL_MS = 2 * 60 * 1000;
let items: AdminNotice[] = [];
let unread = 0;
let seenAt = 0;
let loading = false;

function isRealAdmin(): boolean {
  return currentUserRole === 'admin' && !viewAsUsername;
}

export async function refreshAdminNotices(): Promise<void> {
  if (!isRealAdmin() || loading) return;
  loading = true;
  try {
    const data = await postUsersEndpoint('admin/notices', {});
    if (Array.isArray(data.items)) {
      items = data.items;
      // A poll can answer before the "seen" save from opening the Admin tab
      // has landed; the local time wins then, so the badge doesn't come back.
      const serverSeenAt = Number(data.seenAt) || 0;
      if (serverSeenAt >= seenAt) {
        seenAt = serverSeenAt;
        unread = Number(data.unread) || 0;
      } else {
        unread = items.filter(function(n) { return n.at > seenAt; }).length;
      }
      renderBadges(countNewErrors());
    }
  } catch (err) {
    // Offline, or an older worker without this endpoint — the badge just
    // stays as it was; the next poll tries again.
  } finally {
    loading = false;
  }
}

function countNewErrors(): number {
  return items.filter(function(n) { return n.kind === 'error' && n.at > seenAt; }).length;
}

function setBadge(el: HTMLElement, count: number): void {
  el.textContent = count > 99 ? '99+' : String(count);
  el.hidden = count === 0;
}

function renderBadges(newErrors: number): void {
  document.querySelectorAll<HTMLElement>('#desktopSettingsBtn .admin-badge, #mobileSettingsBtn .admin-badge, #settingsTabAdmin .admin-badge').forEach(function(el) {
    setBadge(el, unread);
  });
  const errorsCount = document.getElementById('errorsNewCount');
  if (errorsCount) setBadge(errorsCount, newErrors);
  document.querySelectorAll<HTMLElement>('#desktopSettingsBtn, #mobileSettingsBtn').forEach(function(el) {
    el.setAttribute('aria-label', unread ? 'Settings, ' + unread + ' new admin notices' : 'Settings');
  });
}

// Opening the Admin tab marks everything seen. The Recent Errors count
// stays up while the menu is open so it's clear where the new ones are.
setAdminTabOnOpen(function() {
  if (!unread || !items.length) return;
  const newErrors = countNewErrors();
  const newest = items[0].at;
  unread = 0;
  seenAt = Math.max(seenAt, newest);
  renderBadges(newErrors);
  postUsersEndpoint('admin/notices/seen', { at: newest }).catch(function() {});
});

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') refreshAdminNotices();
});
setInterval(refreshAdminNotices, POLL_MS);
