// Home dashboard, moved out of index.html starting here — the last
// remaining piece of the original index.html view layer (Board/Calendar/
// Gantt/Sync/Checklist are all already extracted). Phased the same
// narrowest/lowest-risk-first way as every other multi-phase extraction
// this project has done, surveyed and agreed with Karl before starting:
//
//   Phase HD-a (this file's initial content) — core tab-switching/
//     navigation: getActiveTab/switchTabMorphed/homeWidgetGoTo/
//     clearHomeTabMorphNames/switchTab/toggleJobRail/setMobileView.
//     Genuinely app-shell infrastructure (switchTab() is what every
//     other view's tab button ultimately calls) that happens to live
//     here because Home is the hub every "morph" transition grows out
//     of or shrinks back into — chosen as the safest first slice, same
//     "smallest/safest first" logic as every other multi-phase
//     extraction, and it's what every later Home-specific phase
//     (widget expand mechanics, the actual dashboard content,
//     renderHomeDashboard() itself) builds on.
import { renderGantt } from './gantt';
import { renderCalendar, initCalendarDragHandlers } from './calendar';
import { renderBoard } from './board';
import { renderMyChecklist } from './checklist';
import { sendPresenceUpdate } from '../sync/presence';

declare global {
  // Shared verbatim with src/views/gantt.ts's identical ambient
  // declaration for this same function.
  function setupScrollSync(): void;
  // Shared verbatim with src/views/calendar.ts's identical ambient
  // declaration for this same global.
  // eslint-disable-next-line no-var
  var calendarViewMode: string;
  function cancelEdit(): void;
  // Shared verbatim with src/sync/inbound.ts's identical ambient
  // declaration for this same function — this file's own Phase HD-f
  // (a later phase) will replace this with a real local implementation.
  function renderHomeDashboard(): void;
}

// Which Home widget represents each tab — Home widget headers (icon +
// title) jump to their tab via homeWidgetGoTo() below; this is the same
// 4 pairings, centralized so switchTabMorphed() can look up the widget
// to grow from / shrink back into for either direction of a Home <-> tab
// switch. Job Chat has no corresponding tab, so it's not here.
const HOME_WIDGET_FOR_TAB: Record<string, string> = {
  checklist: 'homeWidgetChecklist',
  calendar: 'homeWidgetCalendar',
  board: 'homeWidgetWorkflow',
  gantt: 'homeWidgetToday'
};

// Reads whichever tab is currently showing straight off the DOM (the one
// source of truth switchTab() itself already maintains via
// .tab-panel.active) instead of tracking a second copy of that state.
function getActiveTab(): string {
  const active = document.querySelector('.tab-panel.active');
  return active ? active.id.replace('panel-', '') : 'home';
}

// Only one shared-element morph is ever in flight at a time, so a single
// hardcoded name is enough — but it still has to be actively cleared
// after every transition (see switchTabMorphed()), not just left on
// whatever last carried it: two elements can never carry the same
// view-transition-name at once, and a stale name left over from the
// previous switch would silently break the NEXT one instead of this one.
const HOME_TAB_MORPH_NAME = 'aps-home-tab-morph';
function clearHomeTabMorphNames(): void {
  document.querySelectorAll('.home-widget, .tab-panel').forEach(function (el) {
    if ((el as HTMLElement).style.viewTransitionName === HOME_TAB_MORPH_NAME) (el as HTMLElement).style.viewTransitionName = '';
  });
}

// Home widget headers (icon + title) and the sidebar's own rail tabs both
// route through this now (see their onclick markup) — switchTab() itself
// still does the actual panel swap, this just wraps it in the
// shared-element morph when the switch is Home <-> a tab: the
// transitioning element visibly grows out of (or shrinks back into)
// whichever widget represents that tab, using the View Transitions API
// (::view-transition-group(aps-home-tab-morph) above handles the timing;
// the browser interpolates the actual geometry on its own). Clicking the
// tab you're already ON acts as "go home" instead of a no-op — this is
// the ONLY way back to Home now (there's no dedicated Home button/rail-
// tab — Karl's own call: "turn off the tab you're in"). Switching
// directly between two non-Home tabs (Gantt -> Board, say) stays a
// plain, instant switchTab() — there's no widget to morph from/to when
// neither side is Home. Falls
// back to a plain switchTab() on a browser without the View Transitions
// API (Firefox, older Safari) — same end state either way, just no
// animation.
function switchTabMorphed(targetTab: string): void {
  const fromTab = getActiveTab();
  if (fromTab === targetTab) {
    if (targetTab !== 'home') switchTabMorphed('home');
    return;
  }

  const heroTab = fromTab === 'home' ? targetTab : (targetTab === 'home' ? fromTab : null);
  const heroWidgetId = heroTab ? HOME_WIDGET_FOR_TAB[heroTab] : null;
  const widgetEl = heroWidgetId ? document.getElementById(heroWidgetId) : null;

  if (!widgetEl || !(document as any).startViewTransition) {
    switchTab(targetTab);
    return;
  }

  clearHomeTabMorphNames();
  const oldHeroEl = fromTab === 'home' ? widgetEl : document.getElementById('panel-' + fromTab);
  if (oldHeroEl) oldHeroEl.style.viewTransitionName = HOME_TAB_MORPH_NAME;

  const transition = (document as any).startViewTransition(function () {
    switchTab(targetTab);
    // Move the name off the old hero onto the new one — both still
    // within this same synchronous callback, so by the time it returns
    // (and the API captures the "new" state) only the new hero carries
    // it, never both at once.
    if (oldHeroEl) oldHeroEl.style.viewTransitionName = '';
    const newHeroEl = targetTab === 'home' ? widgetEl : document.getElementById('panel-' + targetTab);
    if (newHeroEl) newHeroEl.style.viewTransitionName = HOME_TAB_MORPH_NAME;
  });
  transition.finished.then(clearHomeTabMorphNames).catch(function () {});
}

// Home widget headers (icon + title) jump to that widget's corresponding
// tab — see homeWidgetGoTo() call sites in #panel-home's markup.
function homeWidgetGoTo(tab: string): void {
  switchTabMorphed(tab);
}

function switchTab(tab: string): void {
  // Switching to a different view closes the job drawer if it's open —
  // cancelEdit() also flushes any debounced edit first, same safety net
  // switchTab() always had. Harmless no-op if nothing was open.
  cancelEdit();
  document.querySelectorAll('.rail-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  // No rail-tab represents Home any more (see its own removal note in
  // the markup) — every OTHER tab still has one, so this just skips the
  // (now-nonexistent) #tab-home lookup rather than needing a whole
  // separate branch for it.
  const tabBtn = document.getElementById('tab-' + tab);
  if (tabBtn) tabBtn.classList.add('active');
  document.getElementById('panel-' + tab)!.classList.add('active');
  if (tab === 'home') { renderHomeDashboard(); }
  else if (tab === 'gantt') { setTimeout(() => { renderGantt(); setupScrollSync(); }, 50); }
  else if (tab === 'board') { renderBoard(); }
  else if (tab === 'calendar') { renderCalendar(); setTimeout(initCalendarDragHandlers, 100); }
  else if (tab === 'checklist') { renderMyChecklist(); }
  sendPresenceUpdate();
}

// The sidebar defaults to closed (a narrow icon rail, Jobs search/list
// hidden — see the body:not(.job-rail-open) CSS rules) on every view now,
// not just Home. #jobRailToggleBtn is the header's own Jobs icon — the
// one manual override, independent of which tab is active (switching
// tabs while it's open leaves it open, same as any persistent panel
// toggle; it isn't a .rail-tab, so switchTab()'s active-class sweep
// never touches it).
function toggleJobRail(): void {
  const open = document.body.classList.toggle('job-rail-open');
  const btn = document.getElementById('jobRailToggleBtn');
  if (btn) {
    btn.classList.toggle('active', open);
    btn.title = open ? 'Hide Jobs list' : 'Show Jobs list';
  }
}

// Mobile-only Jobs/Checklist/Calendar/Gantt/Board toggle (Home has no
// button of its own — see .mobile-view-switcher's own markup comment) —
// see .mobile-view-switcher and the body[data-mobile-view] rules under
// @media (max-width:480px).
// Each of these takes the full screen on a phone, so there's no "both
// visible" state to preserve here the way switchTab() does on desktop.
// Tapping whichever view is ALREADY active goes to Home instead of
// re-selecting it — same "turn off the tab you're in" gesture
// switchTabMorphed() uses on desktop, just without that function's
// shared-element morph (mobile never had that animation to begin with).
function setMobileView(view: string): void {
  if (view === document.body.dataset.mobileView && view !== 'home') view = 'home';
  document.body.dataset.mobileView = view;
  document.querySelectorAll('.mobile-view-btn').forEach(function (b) {
    (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.view === view);
  });
  if (view === 'home') {
    switchTab('home');
  } else if (view === 'checklist') {
    switchTab('checklist');
  } else if (view === 'board') {
    switchTab('board');
  } else if (view === 'gantt') {
    switchTab('gantt');
  } else if (view === 'calendar') {
    // Week view's 7-day hourly grid is a wide multi-column timeline, the
    // same category of problem the Gantt chart has — not mobile-ready, so
    // month/day are the only views offered here (the toggle to reach week
    // is hidden too, see .calendar-view-toggle-wrap). Guarded here (not
    // just hidden) in case a prior desktop session in this same page load
    // left calendarViewMode on 'week'. Day mode is fine on mobile, so it's
    // left alone if that's already where the user was — switching to
    // another mobile tab and back shouldn't lose their place.
    if (calendarViewMode === 'week') calendarViewMode = 'month';
    switchTab('calendar');
  }
}

export {
  getActiveTab,
  switchTabMorphed,
  homeWidgetGoTo,
  clearHomeTabMorphNames,
  switchTab,
  toggleJobRail,
  setMobileView,
};
