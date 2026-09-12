// Small, generic UI helpers with no shared-app-state reads/writes of
// their own — used across every view. Moved verbatim from index.html.

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
export function openModal(id: string): void {
  document.getElementById(id)!.classList.add('show');
}
export function closeModal(id: string, onClose?: () => void): void {
  document.getElementById(id)!.classList.remove('show');
  if (onClose) onClose();
}

export function showToast(msg: string, type?: string): void {
  const container = document.getElementById('toastContainer')!;
  const toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
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
