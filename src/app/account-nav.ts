// The navbar's Account button (#accountBtn) and the "who's signed in"
// header at the top of its menu (#settingsDropdown): your initials (on
// the indigo --primary-light, which keeps white text readable; several of
// the presence avatar colors don't), your first name, and your full name
// + role in the menu.
import { getStoredDisplayName, getStoredUsername } from '../auth/session';
import { presenceInitials } from '../sync/presence';

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', projectAdmin: 'Project Admin', editor: 'Editor', commenter: 'Commenter', viewer: 'Viewer' };

export function updateAccountButton(): void {
  const username = getStoredUsername();
  const name = getStoredDisplayName() || username;
  const initials = name ? presenceInitials(name) : '?';
  ['accountAvatar', 'accountWhoAvatar'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = initials;
  });
  const first = document.getElementById('accountName');
  if (first) first.textContent = name ? name.trim().split(/\s+/)[0] : 'Account';
  const full = document.getElementById('accountWhoName');
  if (full) full.textContent = name || 'Signed in';
  const role = document.getElementById('accountWhoRole');
  if (role) role.textContent = (currentUserRole && ROLE_LABELS[currentUserRole]) || '';
}
