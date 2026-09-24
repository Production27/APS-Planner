// The Settings (⋮) dropdown. Two triggers share this one dropdown — the
// desktop rail-tab-row's (.settings-menu-wrap > .settings-dots-btn) and
// the mobile view-switcher's own (.mobile-view-btn.settings-menu-wrap) —
// only one of which is ever actually on-screen at a time, per the usual
// @media rules. #settingsDropdown itself lives at the top level (see its
// own markup comment), not nested inside either trigger, so its position
// is computed fresh from whichever one is visible each time it opens
// rather than relying on being a positioned ancestor's child.

export function positionSettingsMenu(): void {
  const dropdown = document.getElementById('settingsDropdown') as HTMLElement;
  let trigger: HTMLElement | null = null;
  document.querySelectorAll('.settings-menu-wrap').forEach(function(el) {
    if (!trigger && (el as HTMLElement).offsetParent !== null) trigger = el as HTMLElement;
  });
  if (!trigger) return;
  const rect = (trigger as HTMLElement).getBoundingClientRect();
  const dropdownWidth = dropdown.offsetWidth || 196; // 190 min-width + 6 padding — offsetWidth is 0 the very first time (display:none until opened)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - dropdownWidth - 8));
  dropdown.style.left = left + 'px';
  dropdown.style.top = (rect.bottom + 8) + 'px';
}

// The on-screen trigger button (desktop ⋮ or the mobile one).
function visibleSettingsTrigger(): HTMLElement | null {
  let btn: HTMLElement | null = null;
  document.querySelectorAll('.settings-menu-wrap').forEach(function(el) {
    if (btn || (el as HTMLElement).offsetParent === null) return;
    btn = el.matches('button') ? el as HTMLElement : el.querySelector('button');
  });
  return btn;
}
function setSettingsTriggersExpanded(open: boolean): void {
  document.querySelectorAll('#desktopSettingsBtn, #mobileSettingsBtn').forEach(function(el) {
    el.setAttribute('aria-expanded', String(open));
  });
}

export function toggleSettingsMenu(): void {
  const dropdown = document.getElementById('settingsDropdown') as HTMLElement;
  const opening = !dropdown.classList.contains('show');
  if (opening) positionSettingsMenu();
  dropdown.classList.toggle('show', opening);
  setSettingsTriggersExpanded(opening);
  cancelSettingsMenuAutoClose();
  // #settingsDropdown sits far earlier in the page than its triggers, so
  // Tab from the trigger would never reach it — opened from the keyboard,
  // move focus into it (A5). A mouse click leaves focus alone.
  const trigger = visibleSettingsTrigger();
  if (opening && trigger && trigger.matches(':focus-visible')) {
    const first = dropdown.querySelector('.settings-dropdown-item:not([style*="display: none"]):not([style*="display:none"])') as HTMLElement | null;
    if (first) first.focus();
  }
}

export function closeSettingsMenu(): void {
  document.getElementById('settingsDropdown')!.classList.remove('show');
  setSettingsTriggersExpanded(false);
  cancelSettingsMenuAutoClose();
}

// Auto-closes a few seconds after the mouse leaves BOTH the trigger and the
// dropdown itself — armed only while open, and cancelled the moment the
// mouse re-enters either one, so lingering on either piece keeps it open
// indefinitely. Two triggers share this dropdown (see positionSettingsMenu()'s
// own comment); only one is ever visible at a time, but listening on both is
// harmless. Touch taps don't fire mouseenter/mouseleave the same way a real
// pointer does, so this is effectively inert on mobile — tap-to-toggle and
// the existing click-outside-closes handler (src/app/boot.ts) are
// unaffected.
const SETTINGS_MENU_AUTOCLOSE_MS = 1000;
let settingsMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
export function armSettingsMenuAutoClose(): void {
  if (settingsMenuCloseTimer) clearTimeout(settingsMenuCloseTimer);
  settingsMenuCloseTimer = setTimeout(closeSettingsMenu, SETTINGS_MENU_AUTOCLOSE_MS);
}
export function cancelSettingsMenuAutoClose(): void {
  if (settingsMenuCloseTimer) clearTimeout(settingsMenuCloseTimer);
  settingsMenuCloseTimer = null;
}
document.querySelectorAll('.settings-menu-wrap').forEach(function(el) {
  el.addEventListener('mouseenter', cancelSettingsMenuAutoClose);
  el.addEventListener('mouseleave', function() {
    const settingsDropdownForWrap = document.getElementById('settingsDropdown');
    if (settingsDropdownForWrap && settingsDropdownForWrap.classList.contains('show')) armSettingsMenuAutoClose();
  });
});
{
  const settingsDropdownEl = document.getElementById('settingsDropdown');
  if (settingsDropdownEl) {
    settingsDropdownEl.addEventListener('mouseenter', cancelSettingsMenuAutoClose);
    settingsDropdownEl.addEventListener('mouseleave', function() {
      if (settingsDropdownEl.classList.contains('show')) armSettingsMenuAutoClose();
    });
    // Items are real <button>s (A5), so Enter/Space work natively. Escape
    // closes the menu and puts focus back on whichever trigger opened it.
    settingsDropdownEl.addEventListener('keydown', function(e) {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      e.preventDefault();
      closeSettingsMenu();
      const trigger = visibleSettingsTrigger();
      if (trigger) trigger.focus();
    });
  }
}
