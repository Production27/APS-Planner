// Maintenance-mode banner + admin toggle (see worker's maintenance.ts).
// Same "poll rather than push" shape as version-check.ts, on a shorter
// interval since a maintenance window is meant to be brief and worth
// catching promptly, not eventually. Deliberately does NOT block
// #loginOverlay — an admin needs to be able to log in during a
// maintenance window to turn it back off, and gating login itself would
// have no upside (login doesn't touch shared project data). The block
// only ever applies AFTER identity resolves, and only to non-admins —
// see index.html's applyIdentityFromTokenPayload()'s call into this.
import { showToast } from '../utils/ui';

declare global {
  // eslint-disable-next-line no-var
  var roleConfirmed: boolean;
  // eslint-disable-next-line no-var
  var currentUserRole: string;
  function logActivity(text: string): void;
  function postUsersEndpoint(path: string, body: unknown): Promise<any>;
}

interface MaintenanceStatus {
  active: boolean;
  message: string;
}

export async function checkMaintenanceStatus(): Promise<void> {
  try {
    const res = await fetch(API_BASE_URL + 'maintenance-status?_v=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    applyMaintenanceStatus(data);
  } catch (err) {
    // Offline or a network hiccup — not worth surfacing, same reasoning
    // as version-check.ts; the next periodic check (or the next
    // tab-focus) will just try again.
  }
}

// Split from checkMaintenanceStatus() so setMaintenanceMode() below can
// apply the worker's response immediately, without waiting for the next
// poll to reflect an admin's own change back to themselves.
export function applyMaintenanceStatus(status: MaintenanceStatus | null | undefined): void {
  const shouldBlock = !!(status && status.active) && roleConfirmed && currentUserRole !== 'admin';
  const overlay = document.getElementById('maintenanceOverlay')!;
  overlay.classList.toggle('show', shouldBlock);
  if (shouldBlock) document.getElementById('maintenanceOverlayMessage')!.textContent = status!.message;

  const toggle = document.getElementById('maintenanceToggle');
  if (toggle) toggle.classList.toggle('active', !!(status && status.active));
  const enableBtn = document.getElementById('maintenanceEnableBtn');
  if (enableBtn) {
    const isActive = !!(status && status.active);
    enableBtn.textContent = isActive ? 'Turn Off Maintenance Mode' : 'Turn On Maintenance Mode';
    enableBtn.onclick = function() { setMaintenanceMode(!isActive); };
  }
}

export function toggleMaintenancePanel(): void {
  document.getElementById('maintenancePanel')!.classList.toggle('open');
}

export async function setMaintenanceMode(active: boolean): Promise<void> {
  const messageInput = document.getElementById('maintenanceMessageInput') as HTMLInputElement | null;
  const message = messageInput ? messageInput.value.trim() : '';
  try {
    const data = await postUsersEndpoint('maintenance-status/set', { active: active, message: message });
    showToast(active ? 'Maintenance mode turned on' : 'Maintenance mode turned off', active ? 'info' : 'success');
    logActivity(active ? 'turned on maintenance mode' : 'turned off maintenance mode');
    applyMaintenanceStatus(data.status);
    if (!active && messageInput) messageInput.value = '';
    document.getElementById('maintenancePanel')!.classList.remove('open');
  } catch (err: any) {
    showToast('Could not update maintenance mode: ' + err.message, 'error');
  }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') checkMaintenanceStatus();
});
setInterval(checkMaintenanceStatus, 30 * 1000);
