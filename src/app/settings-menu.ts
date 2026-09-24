// The Settings (⋮) and Admin dropdowns. Each has two triggers sharing one
// dropdown — the desktop rail-tab-row's and the mobile view-switcher's own
// — only one of which is ever actually on-screen at a time, per the usual
// @media rules. The dropdowns themselves live at the top level (see
// #settingsDropdown's own markup comment), not nested inside either
// trigger, so each one's position is computed fresh from whichever trigger
// is visible each time it opens rather than relying on being a positioned
// ancestor's child. Only one of the two menus is open at a time.

interface MenuDef {
  dropdownId: string;
  wrapSelector: string;   // the trigger wraps (.settings-menu-wrap / .admin-menu-wrap)
  triggerIds: string[];   // the buttons carrying aria-expanded
  onOpen?: () => void;
  closeTimer: ReturnType<typeof setTimeout> | null;
}

const settingsMenu: MenuDef = {
  dropdownId: 'settingsDropdown', wrapSelector: '.settings-menu-wrap',
  triggerIds: ['desktopSettingsBtn', 'mobileSettingsBtn'], closeTimer: null,
};
const adminMenu: MenuDef = {
  dropdownId: 'adminDropdown', wrapSelector: '.admin-menu-wrap',
  triggerIds: ['desktopAdminBtn', 'mobileAdminBtn'], closeTimer: null,
};
const MENUS = [settingsMenu, adminMenu];

// src/app/admin-notices.ts fills the Admin menu's notice list as it opens.
export function setAdminMenuOnOpen(fn: () => void): void {
  adminMenu.onOpen = fn;
}

function positionMenu(menu: MenuDef): void {
  const dropdown = document.getElementById(menu.dropdownId) as HTMLElement | null;
  if (!dropdown) return;
  let trigger: HTMLElement | null = null;
  document.querySelectorAll(menu.wrapSelector).forEach(function(el) {
    if (!trigger && (el as HTMLElement).offsetParent !== null) trigger = el as HTMLElement;
  });
  if (!trigger) return;
  const rect = (trigger as HTMLElement).getBoundingClientRect();
  const dropdownWidth = dropdown.offsetWidth || 196; // 190 min-width + 6 padding — offsetWidth is 0 the very first time (display:none until opened)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 8));
  dropdown.style.left = left + 'px';
  dropdown.style.top = (rect.bottom + 8) + 'px';
}

// The on-screen trigger button (desktop or the mobile one).
function visibleTrigger(menu: MenuDef): HTMLElement | null {
  let btn: HTMLElement | null = null;
  document.querySelectorAll(menu.wrapSelector).forEach(function(el) {
    if (btn || (el as HTMLElement).offsetParent === null) return;
    btn = el.matches('button') ? el as HTMLElement : el.querySelector('button');
  });
  return btn;
}
function setTriggersExpanded(menu: MenuDef, open: boolean): void {
  menu.triggerIds.forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.setAttribute('aria-expanded', String(open));
  });
}

function toggleMenu(menu: MenuDef): void {
  const dropdown = document.getElementById(menu.dropdownId) as HTMLElement | null;
  if (!dropdown) return;
  const opening = !dropdown.classList.contains('show');
  if (opening) {
    MENUS.forEach(function(other) { if (other !== menu) closeMenu(other); });
    if (menu.onOpen) menu.onOpen();
    positionMenu(menu);
  }
  dropdown.classList.toggle('show', opening);
  setTriggersExpanded(menu, opening);
  cancelAutoClose(menu);
  // The dropdown sits far earlier in the page than its triggers, so Tab
  // from the trigger would never reach it — opened from the keyboard, move
  // focus into it (A5). A mouse click leaves focus alone.
  const trigger = visibleTrigger(menu);
  if (opening && trigger && trigger.matches(':focus-visible')) {
    const first = dropdown.querySelector('.settings-dropdown-item:not([style*="display: none"]):not([style*="display:none"]):not(.perm-hidden)') as HTMLElement | null;
    if (first) first.focus();
  }
}

function closeMenu(menu: MenuDef): void {
  const dropdown = document.getElementById(menu.dropdownId);
  if (dropdown) dropdown.classList.remove('show');
  setTriggersExpanded(menu, false);
  cancelAutoClose(menu);
}

// Auto-closes a moment after the mouse leaves BOTH the trigger and the
// dropdown itself — armed only while open, and cancelled the moment the
// mouse re-enters either one, so lingering on either piece keeps it open
// indefinitely. Touch taps don't fire mouseenter/mouseleave the same way a
// real pointer does, so this is effectively inert on mobile — tap-to-toggle
// and the existing click-outside-closes handler (src/app/boot.ts) are
// unaffected.
const MENU_AUTOCLOSE_MS = 1000;
function armAutoClose(menu: MenuDef): void {
  if (menu.closeTimer) clearTimeout(menu.closeTimer);
  menu.closeTimer = setTimeout(function() { closeMenu(menu); }, MENU_AUTOCLOSE_MS);
}
function cancelAutoClose(menu: MenuDef): void {
  if (menu.closeTimer) clearTimeout(menu.closeTimer);
  menu.closeTimer = null;
}

export function positionSettingsMenu(): void { positionMenu(settingsMenu); }
export function toggleSettingsMenu(): void { toggleMenu(settingsMenu); }
export function closeSettingsMenu(): void { closeMenu(settingsMenu); }
export function armSettingsMenuAutoClose(): void { armAutoClose(settingsMenu); }
export function cancelSettingsMenuAutoClose(): void { cancelAutoClose(settingsMenu); }
export function toggleAdminMenu(): void { toggleMenu(adminMenu); }
export function closeAdminMenu(): void { closeMenu(adminMenu); }

MENUS.forEach(function(menu) {
  document.querySelectorAll(menu.wrapSelector).forEach(function(el) {
    el.addEventListener('mouseenter', function() { cancelAutoClose(menu); });
    el.addEventListener('mouseleave', function() {
      const dropdown = document.getElementById(menu.dropdownId);
      if (dropdown && dropdown.classList.contains('show')) armAutoClose(menu);
    });
  });
  const dropdownEl = document.getElementById(menu.dropdownId);
  if (!dropdownEl) return;
  dropdownEl.addEventListener('mouseenter', function() { cancelAutoClose(menu); });
  dropdownEl.addEventListener('mouseleave', function() {
    if (dropdownEl.classList.contains('show')) armAutoClose(menu);
  });
  // Items are real <button>s (A5), so Enter/Space work natively. Escape
  // closes the menu and puts focus back on whichever trigger opened it.
  dropdownEl.addEventListener('keydown', function(e) {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    e.preventDefault();
    closeMenu(menu);
    const trigger = visibleTrigger(menu);
    if (trigger) trigger.focus();
  });
});
