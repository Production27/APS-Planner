// Page controls in the top bar (Karl, 2026-09-29): on desktop, Calendar's
// and Reports' own toolbars sit in the navbar next to the page name —
// the period (Today ‹ › and the month) on the left, the view toggles and
// Filter on the right. Only controls that already existed moved; every
// other page shows just its name. Narrower screens and phones keep both
// toolbars on the page.
//
// Each page has its own slot in the navbar (#appNavCtlCalendar,
// #appNavCtlReports), shown only while that page is active (CSS, in the
// "PAGES COLUMN" block). Calendar's toolbar is plain markup wired by id,
// so the element itself moves between its page and its slot. Reports'
// toolbar is Preact, so ReportsView renders it into the slot through a
// portal instead (see reports.tsx).

// Wide screens only: below 1000px the controls don't fit next to the page
// name, so they stay on the page (the matching CSS uses the same query).
const DESKTOP = window.matchMedia('(min-width: 1000px) and (min-height: 481px)');

export function pageControlsInHeader(): boolean {
  return DESKTOP.matches;
}

function placeCalendarToolbar(): void {
  const toolbar = document.querySelector('.calendar-toolbar');
  const slot = document.getElementById('appNavCtlCalendar');
  const page = document.querySelector('#panel-calendar .calendar-wrapper');
  if (!toolbar || !slot || !page) return;
  if (DESKTOP.matches) {
    if (toolbar.parentElement !== slot) slot.appendChild(toolbar);
  } else if (toolbar.parentElement !== page) {
    page.insertBefore(toolbar, page.firstChild);
  }
}

let onChange: (() => void) | null = null;
// Reports re-renders on a breakpoint change so its toolbar moves too.
export function onPageControlsPlacementChange(fn: () => void): void {
  onChange = fn;
}

placeCalendarToolbar();
DESKTOP.addEventListener('change', function () {
  placeCalendarToolbar();
  if (onChange) onChange();
});
