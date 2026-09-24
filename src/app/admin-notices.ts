// The Admin menu's "What's new" list and the red badge on its trigger
// (see the worker's admin-notices.ts). Counts app crashes and notable
// account events — someone changing their email, users added or removed,
// two-step turned off, and so on — that happened since this admin last
// opened the menu. Polled like maintenance.ts rather than pushed; a couple
// of minutes late is fine for this.
import { escapeHtml } from '../utils/html';
import { postUsersEndpoint } from './worker-client';
import { setAdminMenuOnOpen } from './settings-menu';

interface AdminNotice {
  at: number;
  kind: 'account' | 'error';
  user: string | null;
  action: string;
  item?: string | null;
  details?: string | null;
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
      // A poll can answer before the "seen" save from opening the menu has
      // landed; the local time wins then, so the badge doesn't come back.
      const serverSeenAt = Number(data.seenAt) || 0;
      if (serverSeenAt >= seenAt) {
        seenAt = serverSeenAt;
        unread = Number(data.unread) || 0;
      } else {
        unread = items.filter(function(n) { return n.at > seenAt; }).length;
      }
      renderBadge();
    }
  } catch (err) {
    // Offline, or an older worker without this endpoint — the badge just
    // stays as it was; the next poll tries again.
  } finally {
    loading = false;
  }
}

function renderBadge(): void {
  const text = unread > 99 ? '99+' : String(unread);
  document.querySelectorAll<HTMLElement>('.admin-badge').forEach(function(el) {
    el.textContent = text;
    el.hidden = unread === 0;
  });
  document.querySelectorAll<HTMLElement>('#desktopAdminBtn, #mobileAdminBtn').forEach(function(el) {
    el.setAttribute('aria-label', unread ? 'Admin, ' + unread + ' new' : 'Admin');
  });
}

function timeAgo(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.round(hours / 24);
  if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
  return new Date(at).toLocaleDateString();
}

function describe(n: AdminNotice): string {
  const who = n.user ? escapeHtml(n.user) : 'someone not signed in';
  if (n.kind === 'error') return '<b>App error</b> for ' + who;
  const action = n.action.charAt(0).toLowerCase() + n.action.slice(1).replace(/\bown\b/, 'their');
  return '<b>' + who + '</b> ' + escapeHtml(action) + (n.item ? ': ' + escapeHtml(n.item) : '');
}

function renderList(): void {
  const list = document.getElementById('adminNoticesList');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="admin-notice-empty">Nothing new.</div>';
    return;
  }
  list.innerHTML = items.slice(0, 8).map(function(n) {
    const isNew = n.at > seenAt;
    const details = n.details ? '<div class="admin-notice-details">' + escapeHtml(n.details).replace(/ -&gt; /g, ' → ') + '</div>' : '';
    return '<div class="admin-notice' + (isNew ? ' is-new' : '') + (n.kind === 'error' ? ' is-error' : '') + '">'
      + '<div class="admin-notice-text">' + describe(n) + '</div>' + details
      + '<div class="admin-notice-time">' + (isNew ? 'New · ' : '') + timeAgo(n.at) + '</div>'
      + '</div>';
  }).join('');
}

// Opening the menu shows what's new (still highlighted this time) and
// marks it seen, so the badge clears.
function onAdminMenuOpen(): void {
  renderList();
  if (!unread || !items.length) return;
  const newest = items[0].at;
  unread = 0;
  renderBadge();
  postUsersEndpoint('admin/notices/seen', { at: newest }).catch(function() {});
  // Next open shows these as read.
  seenAt = Math.max(seenAt, newest);
}
setAdminMenuOnOpen(onAdminMenuOpen);

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') refreshAdminNotices();
});
setInterval(refreshAdminNotices, POLL_MS);
