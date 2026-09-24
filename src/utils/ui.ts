// Small, generic UI helpers with no shared-app-state reads/writes of
// their own — used across every view.

// Whether a given main tab (gantt/calendar/board — anything with a
// #panel-<tab> element) is the one currently on screen, on both desktop
// (switchTab()'s .active class on #panel-<tab>) and mobile (setMobileView()
// routes gantt/calendar/board through switchTab() too, so the same class
// applies there). Lets a render call after a data edit skip a tab nobody
// is looking at — switchTab() already does a full, unconditional render
// of whichever tab it switches TO, so a hidden tab's data just gets
// rendered fresh next time the user actually navigates there instead of
// being rebuilt now for nothing.
export function isPanelActive(tab: string): boolean {
  const panel = document.getElementById('panel-' + tab);
  return !!panel && panel.classList.contains('active');
}

// Shared show/hide for the app's 9 modal dialogs (deleteModal, cardModal,
// calendarEventModal, archivedJobsModal, backupsModal, manageUsersModal,
// manageFieldsModal, manageColumnChecklistModal, themeModal). Each keeps
// its own named openXModal()/closeXModal() wrapper — referenced by
// onclick= attributes in the HTML and by call sites throughout the app —
// which delegates here instead of hand-rolling the same classList shape
// 9 times. onClose (if given) runs AFTER the modal is hidden, for state
// that only needs resetting once the modal's actually closed; any work
// that must happen BEFORE hiding (like cardModal's autosave flush) stays
// in the wrapper, ahead of this call.
//
// Keyboard/screen-reader behavior (A5), applied here once for all of them:
// the .modal-box becomes a labelled role="dialog" (aria-modal), focus moves
// into it on open and back to whatever had it on close, Tab stays inside
// while it's open, and Escape presses the dialog's own close button — the
// one marked data-modal-close in index.html (so it runs exactly what that
// button already does — autosave flushes included — rather than a second,
// generic close path). Marked explicitly, not matched by id: the Security
// dialog's first "…CancelBtn" is "Cancel deletion", which Escape must
// never press.
const modalReturnFocus: Record<string, HTMLElement | null> = {};

function modalBox(overlay: HTMLElement): HTMLElement {
  return (overlay.querySelector('.modal-box') as HTMLElement | null) || overlay;
}

function prepareDialog(overlay: HTMLElement): HTMLElement {
  const box = modalBox(overlay);
  if (box.getAttribute('role') !== 'dialog') {
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const heading = box.querySelector('h1, h2, h3, h4, h5') as HTMLElement | null;
    if (heading) {
      if (!heading.id) heading.id = overlay.id + 'Title';
      box.setAttribute('aria-labelledby', heading.id);
    }
    box.tabIndex = -1;
  }
  return box;
}

function isShown(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

export function openModal(id: string): void {
  const overlay = document.getElementById(id)!;
  const box = prepareDialog(overlay);
  const active = document.activeElement as HTMLElement | null;
  if (!overlay.classList.contains('show')) modalReturnFocus[id] = active && !overlay.contains(active) ? active : null;
  overlay.classList.add('show');
  if (!box.contains(document.activeElement)) box.focus({ preventScroll: true });
}
export function closeModal(id: string, onClose?: () => void): void {
  const overlay = document.getElementById(id)!;
  const hadFocus = overlay.contains(document.activeElement);
  overlay.classList.remove('show');
  if (onClose) onClose();
  const back = modalReturnFocus[id];
  delete modalReturnFocus[id];
  if (hadFocus && back && document.contains(back) && isShown(back)) back.focus({ preventScroll: true });
}

function topOpenModal(): HTMLElement | null {
  const open = document.querySelectorAll('.modal-overlay.show');
  return open.length ? open[open.length - 1] as HTMLElement : null;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function initModalKeyboard(): void {
  // Escape also dismisses the hover tooltip (WCAG 1.4.13) without moving the mouse.
  document.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    const tt = document.getElementById('tooltip');
    if (tt && tt.classList.contains('show')) hideTooltip();
  });
  document.addEventListener('keydown', function (e: KeyboardEvent) {
    const overlay = topOpenModal();
    if (!overlay) return;
    const box = modalBox(overlay);
    if (e.key === 'Escape') {
      const closeBtn = Array.prototype.filter.call(box.querySelectorAll('[data-modal-close]'), isShown)[0] as HTMLElement | undefined;
      if (closeBtn) { e.preventDefault(); closeBtn.click(); }
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), isShown) as HTMLElement[];
    if (!items.length) { e.preventDefault(); box.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || cur === box || !box.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !box.contains(cur))) { e.preventDefault(); first.focus(); }
  });
}

export function showToast(msg: string, type?: string): void {
  const container = document.getElementById('toastContainer')!;
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  // Read out by screen readers without moving focus (WCAG 4.1.3, A5).
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icons: Record<string, string> = { success: '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#28a745"/><path d="M8 12.5l2.5 2.5L16 9.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', error: '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#dc3545"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>', info: '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#3949ab"/><rect x="11" y="10" width="2" height="7" rx="1" fill="#fff"/><circle cx="12" cy="7.3" r="1.3" fill="#fff"/></svg>' };
  toast.innerHTML = '<span>' + (icons[type || ''] || '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;margin-right: var(--s-0-75)" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#3949ab"/><rect x="11" y="10" width="2" height="7" rx="1" fill="#fff"/><circle cx="12" cy="7.3" r="1.3" fill="#fff"/></svg>') + '</span><span>' + msg + '</span>';
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'none';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Shared between src/views/calendar.ts and src/views/gantt.ts — each
// file's own showTooltip()-equivalent builds the popup's HTML (typed to
// its own Job/Task shape), then calls these two generic positioning/hide
// helpers.
export function moveTooltip(e: MouseEvent): void {
  const tt = document.getElementById('tooltip')!;
  let x = e.clientX + 16, y = e.clientY + 16;
  if (x + tt.offsetWidth > window.innerWidth) x = e.clientX - tt.offsetWidth - 8;
  if (y + tt.offsetHeight > window.innerHeight) y = e.clientY - tt.offsetHeight - 8;
  tt.style.left = x + 'px'; tt.style.top = y + 'px';
}
export function hideTooltip(): void { document.getElementById('tooltip')!.classList.remove('show'); }

// Collapses a cf-multiselect checkbox list (Members custom field, calendar
// event "Visible to") behind a toggle button instead of listing every
// account inline. Generic over any .ms-dropdown wrapper — see
// renderFieldDefHtml()'s 'multiselect' branch and
// toggleCalendarEventVisibilityFields() for the two current callers.
export function toggleMsDropdown(id: string, forceOpen?: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  const open = forceOpen != null ? forceOpen : !el.classList.contains('open');
  closeAllMsDropdowns();
  el.classList.toggle('open', open);
}
export function closeAllMsDropdowns(): void {
  document.querySelectorAll('.ms-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
}
// Dispatches a real 'change' event per checkbox (rather than just setting
// .checked) so each grid's own delegated autosave listener still fires —
// same reason the rest of this app avoids setting .checked silently.
export function msSetAll(optionsId: string, checked: boolean): void {
  document.querySelectorAll('#' + optionsId + ' input[type="checkbox"]').forEach(function(cb) {
    const input = cb as HTMLInputElement;
    if (input.checked !== checked) {
      input.checked = checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}
// emptyText overrides the zero-selected wording — the checklist "Visible
// to" dropdown uses "Everyone" (unrestricted, its actual default meaning)
// instead of the generic "Select members..." placeholder.
export function msDropdownLabelText(count: number, emptyText?: string): string {
  if (!count) return emptyText || 'Select members...';
  return count + ' member' + (count === 1 ? '' : 's') + ' selected';
}
// Keeps every open dropdown's toggle-button label in sync with its
// checkboxes — one delegated listener instead of attaching/detaching one
// per render (these panels get rebuilt often: roster load, Manage Fields
// close, every job-form/card-modal open).
document.addEventListener('change', function(e) {
  const target = e.target as HTMLInputElement;
  if (target.type !== 'checkbox') return;
  const dropdown = target.closest('.ms-dropdown') as HTMLElement | null;
  if (!dropdown) return;
  const labelEl = dropdown.querySelector('.ms-dropdown-toggle span:first-child');
  if (!labelEl) return;
  const count = dropdown.querySelectorAll('input[type="checkbox"]:checked').length;
  labelEl.textContent = msDropdownLabelText(count, dropdown.dataset.msEmptyLabel);
});

// Debounced — a manual window resize-drag or a mobile orientation
// change/on-screen-keyboard show-hide can fire 'resize' many times in
// quick succession, each otherwise triggering a full rebuild mid-gesture
// instead of one settled render once it's actually done. Registers a
// permanent resize listener that re-renders renderFn only while panelId's
// panel is the active one, optionally debounced — the shape shared by
// the Calendar/Home-workflow/Board-workflow resize listeners (each used
// to hand-roll its own clearTimeout/setTimeout pair, or for the Board
// workflow strip, none at all — debounceMs: 0 preserves that exact
// synchronous behavior rather than changing it). Each caller registers
// its own panel at its own module's top level (src/views/calendar.ts,
// src/views/home.ts, src/views/board.ts) — safe now that this function
// itself lives in the bundle too, so it's always defined before any of
// them run.
export function onPanelResize(panelId: string, renderFn: () => void, debounceMs: number): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', function() {
    const panel = document.getElementById(panelId);
    const fire = function() { if (panel && panel.classList.contains('active')) renderFn(); };
    if (!debounceMs) { fire(); return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  });
}
