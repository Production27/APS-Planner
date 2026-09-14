// The public, non-admin team roster (cachedUserRoster, via /users/roster) —
// used by Board/Calendar/Checklist's PM/Foreman/Members pickers and
// checklist-assignee dropdowns. Deliberately separate from Manage Users'
// own admin-only roster-with-role (src/app/users-admin.ts's loadUsersList(),
// hitting /users/list) — this one strips role for privacy, per the Worker's
// own /users/roster handler.
import { postUsersEndpoint } from './worker-client';
import { showToast } from '../utils/ui';

// cachedUserRoster stays a real `var` in index.html (not owned here) —
// declared once in src/shared-globals.d.ts since well over a dozen already-
// extracted src/ files (board.ts/calendar.ts/checklist.ts/etc.) all read it
// directly as an ambient global, same as jobs/boardCards/BOARD_COLUMNS.
// userRosterLoadError is purely internal to ensureUserRosterLoaded() below
// (nothing else in the app reads it), so it's a real module-local variable
// here instead.
let userRosterLoadError: string | null = null;

// pm/foreman ('user-select' fields) store a USERNAME, not a display name —
// resolve it for display purposes (board card face, etc.). Falls back to
// the raw username if the roster hasn't loaded yet or the account is gone,
// same defensive fallback getLeadRoster() uses.
export function displayNameForUsername(username: string): string {
  const match = (cachedUserRoster || []).find(function (u) { return u.username === username; });
  return match ? match.displayName : username;
}

// PM/Foreman ('user-select' fields) only offer accounts marked as a Lead
// (see the Classification field in Manage Users / handleUsersAdd's
// newIsLead). If a job's already-stored value belongs to an account that
// isn't (or is no longer) a Lead, keep it in the list anyway so the
// dropdown doesn't silently blank out an existing pick.
export function getLeadRoster(currentValueUsername: string): { username: string; displayName: string; isLead: boolean }[] {
  const roster = cachedUserRoster || [];
  const leads = roster.filter(function (u) { return u.isLead; });
  if (currentValueUsername && !leads.some(function (u) { return u.username === currentValueUsername; })) {
    const existing = roster.find(function (u) { return u.username === currentValueUsername; });
    if (existing) leads.push(existing);
  }
  return leads;
}

// Cached indefinitely once loaded (a successful fetch with zero accounts
// sets it to []) — a failed fetch is not cached, so the next render retries
// instead of the dropdown silently looking identical to "no accounts exist"
// forever for the rest of the session. userRosterLoadError holds the last
// failure's message, purely so the dropdown can tell the user something
// actually went wrong instead of just showing "Everyone" with no
// explanation either way.
export async function ensureUserRosterLoaded(): Promise<{ username: string; displayName: string; isLead: boolean }[]> {
  if (cachedUserRoster) return cachedUserRoster;
  try {
    const data = await postUsersEndpoint('users/roster');
    cachedUserRoster = data.users || [];
    userRosterLoadError = null;
  } catch (e: any) {
    console.error('Failed to load team roster for checklist assignment:', e);
    userRosterLoadError = e.message || String(e);
    // Single choke point every caller of ensureUserRosterLoaded() goes
    // through, so this covers all of them at once rather than needing a
    // toast at each call site individually.
    showToast("Couldn't load the team list — " + userRosterLoadError, 'error');
  }
  return cachedUserRoster || [];
}
