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
//   Phase HD-b (this addition) — widget expand/collapse mechanics:
//     HOME_EXPAND_WIDGET_ID/HOME_REFLOW_TRACK/applyHomeReflowTracks/
//     toggleHomeWidgetExpand, plus the window resize listener that keeps
//     the grid's reflow in sync. homeExpandedWidgetId itself stays a
//     `var` in index.html (same as every other cross-script mutable
//     PRIMITIVE this whole project has hit) — src/views/board.ts already
//     ambiently declares it (several of its own functions re-render the
//     workflow mini-board when it's the one expanded), and this file's
//     own ambient declaration below must stay structurally identical to
//     that one, not become a real local declaration: esbuild bundles
//     every source file into ONE shared IIFE scope, so a `var` moved
//     INTO a .ts module would just become private to that module's own
//     closure inside the bundle, not a real `window` property board.ts's
//     bundled code could still see — unlike a genuinely object-typed
//     global (a Map, an array), reassigning a bare string/null primitive
//     needs the real declaration to stay wherever every reader/writer can
//     see it as an actual global, which for a cross-file primitive still
//     means index.html's own top-level classic-script scope.
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
  function renderHomeWorkflowMiniBoard(): void;
  // Shared verbatim with src/views/board.ts's identical ambient
  // declaration for this same global.
  // eslint-disable-next-line no-var
  var homeExpandedWidgetId: string | null;
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

// ===== HOME WIDGET "EXPAND IN PLACE" =====
// A widget's own ⤢ button (separate from its header's homeWidgetGoTo()
// click, which still navigates away) grows it right there on the Home
// grid instead — see .home-grid's own CSS comment for the mechanism.
// Includes Job Chat (jobchat), which has no tab of its own and so isn't
// in HOME_WIDGET_FOR_TAB above.
const HOME_EXPAND_WIDGET_ID: Record<string, string> = {
  checklist: 'homeWidgetChecklist',
  calendar: 'homeWidgetCalendar',
  jobchat: 'homeWidgetJobChat',
  board: 'homeWidgetWorkflow',
  gantt: 'homeWidgetToday'
};
// Which of the 3 outer columns a widget lives in, and (for the two
// side groups) which row within its own .home-grid-left/-right — see
// those elements' own CSS comment for why each side tracks its row
// split independently instead of both columns sharing one grid-template-
// rows list the way an earlier version of this did. Job Chat's row is
// null: it's the center group's only widget, so expanding it never
// needs a row change.
const HOME_REFLOW_TRACK: Record<string, { col: string; row: number | null }> = {
  checklist: { col: 'left', row: 0 }, board: { col: 'left', row: 1 },
  jobchat: { col: 'center', row: null },
  calendar: { col: 'right', row: 0 }, gantt: { col: 'right', row: 1 }
};

function applyHomeReflowTracks(): void {
  const grid = document.querySelector('#panel-home .home-grid') as HTMLElement | null;
  const leftGroup = document.querySelector('#panel-home .home-grid-left') as HTMLElement | null;
  const rightGroup = document.querySelector('#panel-home .home-grid-right') as HTMLElement | null;
  if (!grid || !leftGroup || !rightGroup) return;
  const track = homeExpandedWidgetId ? HOME_REFLOW_TRACK[homeExpandedWidgetId] : null;

  // Always computed as real pixel widths for all 3 columns, never mixed
  // with fr — a CSS transition can only animate a grid track between two
  // values of the SAME kind (px<->px or fr<->fr); a version of this that
  // pinned only the hero's column to a measured px width while the other
  // two stayed fr silently killed the animation for every track whose
  // kind changed between states, which was most of them (Karl noticed:
  // "I just lost the transition to expand a window"). Job Chat's own
  // column collapses to a fixed 52px whenever a CORNER widget is the
  // one expanded (it closes up into an icon + expand-button strip, see
  // the matching .is-collapsed-thin CSS) — the hero's own px width is
  // pinned to what it would already be under the normal
  // 3fr/0.55fr/0.55fr ratio with Job Chat at its usual size, so closing
  // Job Chat up doesn't also grow the hero; the freed space goes to the
  // opposite (already-smaller) side instead.
  const totalW = grid.getBoundingClientRect().width;
  const gapPx = 16;
  const trackSpace = Math.max(0, totalW - gapPx * 2);
  function weightedPx(weights: number[]): number[] {
    const sum = weights[0] + weights[1] + weights[2];
    return weights.map(function (w) { return Math.round(trackSpace * w / sum); });
  }
  let colPx: number[];
  if (!track) colPx = weightedPx([1, 0.8, 1]);
  else if (track.col === 'center') colPx = weightedPx([0.55, 3, 0.55]);
  else {
    const heroPx = Math.round(trackSpace * (3 / 4.1));
    const otherPx = Math.max(0, trackSpace - heroPx - 52);
    colPx = track.col === 'left' ? [heroPx, 52, otherPx] : [otherPx, 52, heroPx];
  }
  grid.style.gridTemplateColumns = colPx.map(function (v) { return v + 'px'; }).join(' ');

  const jobChatWidget = document.getElementById(HOME_EXPAND_WIDGET_ID.jobchat);
  if (jobChatWidget) jobChatWidget.classList.toggle('is-collapsed-thin', !!track && track.col !== 'center');

  // A side's own two rows split evenly UNLESS the expanded widget is
  // actually on that side — only then does its own row grow at the
  // other row's expense. Keeps the side that has nothing to do with
  // whichever widget expanded from getting dragged along uneven.
  function sideRows(side: string): number[] {
    if (track && track.col === side && track.row !== null) {
      const rows = [0.55, 0.55];
      rows[track.row] = 3;
      return rows;
    }
    return [1, 1];
  }
  leftGroup.style.gridTemplateRows = sideRows('left').map(function (v) { return v + 'fr'; }).join(' ');
  rightGroup.style.gridTemplateRows = sideRows('right').map(function (v) { return v + 'fr'; }).join(' ');
}

// Desktop-only (see .home-widget-expand-btn's own max-width:900px rule
// hiding the button itself) — .home-grid collapses to a single stacked
// column below that width via its own media query, and an inline
// grid-template-columns/rows here would silently outrank that rule
// (inline style beats a stylesheet media query regardless of specificity),
// wrecking the mobile layout. Guarded again on resize below.
function toggleHomeWidgetExpand(key: string, event?: Event): void {
  if (event) event.stopPropagation();
  if (window.innerWidth <= 900) return;
  homeExpandedWidgetId = (homeExpandedWidgetId === key) ? null : key;
  applyHomeReflowTracks();
  Object.keys(HOME_EXPAND_WIDGET_ID).forEach(function (k) {
    const el = document.getElementById(HOME_EXPAND_WIDGET_ID[k]);
    if (el) el.classList.toggle('is-expanded', k === homeExpandedWidgetId);
  });
  const stageBody = document.getElementById('homeStageBody');
  if (stageBody) stageBody.classList.toggle('is-expanded-view', homeExpandedWidgetId === 'board');
  renderHomeDashboard();
  // renderHomeWorkflowMiniBoard()'s bracket band measures real
  // .wsm-bar-col elements via getBoundingClientRect() — correct for the
  // FINAL layout, but Board's own column is one of the ones .home-grid's
  // .45s width transition is actively animating right in this same
  // tick, so that first measurement lands mid-flight and the bracket
  // ends up misaligned with the bars underneath it (Karl's own report:
  // "the workflow summary gets screwed up"). This isn't just Board's own
  // toggle either — Checklist shares its column, so expanding/collapsing
  // Checklist resizes Board's width too. Re-measure once the transition
  // actually settles, whichever widget triggered it.
  const gridEl = document.querySelector('#panel-home .home-grid');
  if (gridEl) {
    const onSettled = function (e: Event) {
      if (e.target !== gridEl) return;
      gridEl.removeEventListener('transitionend', onSettled);
      renderHomeWorkflowMiniBoard();
    };
    gridEl.addEventListener('transitionend', onSettled);
  }
}

// Same .is-resizing-live class for both branches below — even the
// mobile-collapse branch calls applyHomeReflowTracks() (to reset back to
// idle ratios) and shouldn't animate that either mid-drag.
let homeGridResizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', function () {
  const grid = document.querySelector('#panel-home .home-grid');
  if (grid) grid.classList.add('is-resizing-live');
  clearTimeout(homeGridResizeSettleTimer as ReturnType<typeof setTimeout>);
  homeGridResizeSettleTimer = setTimeout(function () {
    if (grid) grid.classList.remove('is-resizing-live');
  }, 200);

  if (homeExpandedWidgetId && window.innerWidth <= 900) {
    homeExpandedWidgetId = null;
    applyHomeReflowTracks();
    document.querySelectorAll('.home-widget.is-expanded').forEach(function (el) { el.classList.remove('is-expanded'); });
    const stageBody = document.getElementById('homeStageBody');
    if (stageBody) stageBody.classList.remove('is-expanded-view');
    renderHomeDashboard();
  } else if (window.innerWidth > 900) {
    // Column widths are real pixel values (see applyHomeReflowTracks()'s
    // own comment), not self-adjusting fr units — recompute them against
    // the new window width on EVERY resize, expanded or idle. Previously
    // this only ran while a widget was expanded, so the idle grid (primed
    // to fixed px on its first render, to keep the very first expand
    // transition animatable) just froze at whatever width the page
    // happened to load at and never tracked the window afterward (Karl:
    // "the workflow summary doesn't move very smoothly when the window
    // expands and contracts" — it wasn't moving at all until some other
    // action, like expanding a widget, forced a recompute). The
    // .is-resizing-live class above keeps this snapping to the live
    // window width instead of chasing it through a freshly-restarted
    // .45s animation on every tick.
    applyHomeReflowTracks();
  }
});

export {
  getActiveTab,
  switchTabMorphed,
  homeWidgetGoTo,
  clearHomeTabMorphNames,
  switchTab,
  toggleJobRail,
  setMobileView,
  applyHomeReflowTracks,
  toggleHomeWidgetExpand,
};
