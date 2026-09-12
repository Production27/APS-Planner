// Home dashboard: core tab-switching/navigation (getActiveTab/
// switchTabMorphed/homeWidgetGoTo/clearHomeTabMorphNames/switchTab/
// toggleJobRail/setMobileView — genuinely app-shell infrastructure,
// since switchTab() is what every other view's tab button ultimately
// calls, living here because Home is the hub every "morph" transition
// grows out of or shrinks back into), widget expand/collapse mechanics
// (HOME_EXPAND_WIDGET_ID/HOME_REFLOW_TRACK/applyHomeReflowTracks/
// toggleHomeWidgetExpand, plus the window resize listener that keeps the
// grid's reflow in sync), the widget DATA builders (pure functions,
// jobs/cards in and row arrays out, with no rendering —
// buildHomeOverdueRows/buildHomeStalledRows/buildHomeStageSummary/
// buildHomeTodayScheduleRows/buildHomeUpcomingScheduleRows/
// buildHomeGanttUnclosedRows), the widget RENDERERS plus the
// dismissible-alert system (renderHomeGreeting/
// renderHomeChecklistWidget(+Expanded)/getDismissedHomeWidgetAlerts/
// isHomeWidgetAlertDismissed/dismissHomeWidgetAlert/
// renderHomeWidgetAlert/renderHomeOverdueWidget/
// renderHomeCalendarExpanded(+MiniMonth)/renderHomeWorkflowMiniBoard/
// renderHomeWorkflowExpandedBoard/renderHomeTodayScheduleWidget), the
// Home Job Chat widget (buildHomeJobChatFeed/
// renderHomeJobChatComposeOptions/renderHomeJobChatItem/
// renderHomeJobChat/postHomeJobChatComment/toggleHomeReplyBox/
// addHomeJobReply/handleHomeReplyKey), and renderHomeDashboard() itself,
// the dispatcher tying every widget together.
//
// homeExpandedWidgetId and DEFAULT_STALLED_AFTER_DAYS stay `var`s in
// index.html rather than moving here: esbuild bundles every source file
// into ONE shared IIFE scope, so a `var` moved into a .ts module would
// become private to that module's own closure inside the bundle, not a
// real `window` property other bundled files could still see — unlike a
// genuinely object-typed global (a Map, an array), reassigning a bare
// string/null/number primitive needs the real declaration to stay
// wherever every reader/writer can see it as an actual global.
// src/views/board.ts reads homeExpandedWidgetId directly (it re-renders
// the workflow mini-board when it's the one expanded) and its bundled
// setColumnStalledThreshold() reads DEFAULT_STALLED_AFTER_DAYS directly;
// both are declared ambient below and must stay structurally identical
// to board.ts's own matching declarations.
//
// The onPanelResize('panel-home', renderHomeWorkflowMiniBoard, 200)
// registration call deliberately stays a top-level statement in
// index.html instead — see the comment above renderHomeWorkflowMiniBoard()
// below for why.
//
// Several functions here reuse Calendar's own privately-typed shapes
// (CalJob/CalRow/CalSeg, none exported) to lay out real job/event bars;
// rather than exporting those types just for this one cross-file reuse,
// the objects built here to feed buildCalBarHtml()/buildCalendarJobRows()
// are typed `any` at the boundary. `job.comments` is similarly typed
// loosely (`any[]`) rather than adding a real Comment interface to
// core/types.ts just for the Job Chat widget.
//
// buildMyChecklistRows is a real import from checklist.ts (no
// circularity: checklist.ts doesn't import from home.ts).
import type { BoardCard, BoardColumn, Job, WorkflowItem } from '../core/types';
import { findJob, getJobPhases, getPhaseSubUnits } from '../core/models';
import { escapeHtml } from '../utils/html';
import { toIsoDate, getDaysDiff } from '../utils/date';
import { darkenColor, softenColor } from '../utils/color';
import { renderGantt, setupScrollSync } from './gantt';
import { onPanelResize } from '../utils/ui';
import { getStoredDisplayName } from '../auth/session';
import {
  renderCalendar, initCalendarDragHandlers, buildCalBarHtml, flattenCalendarEventsForRange,
  isCalendarEventTaskId, parseCalendarEventTaskId, openEditCalendarEvent, calendarOpenJob,
} from './calendar';
import { renderBoard, isCardFromArchivedJob, isCardVisibleToMe, buildCardEl, isDarkColor, buildWorkflowStageData } from './board';
import { renderMyChecklist, buildMyChecklistRows } from './checklist';
import { sendPresenceUpdate } from '../sync/presence';
import { formatCommentWhen, postJobComment, postJobReply } from './job-comments';

// Ambient globals this file shares verbatim with other src/ files
// (BOARD_COLUMNS, jobs, activeProjectId, applyPermissionGating(), etc.)
// are declared once in src/shared-globals.d.ts, not repeated here.
declare global {
  function cancelEdit(): void;
  // getVisibleJobs/buildCalendarJobRows/jumpToLinkedJobReference are
  // declared here (rather than in shared-globals.d.ts) with loose `any`
  // shapes, used to lay out real job/event bars the same way the real
  // Calendar tab does — src/views/calendar.ts declares the same
  // index.html functions with its own stricter CalJob/CalRow types.
  // TypeScript allows an ambient `function` (unlike `var`) to be
  // re-declared with a different signature per file.
  function getVisibleJobs(): any[];
  function buildCalendarJobRows(jobsArr: any[]): any[];
  function jumpToLinkedJobReference(job: any): void;
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

// ===== HOME DASHBOARD =====
// Personal landing-tab dashboard, always the default tab (no per-user
// preference) — a greeting banner, a stat-tile row, then four widgets
// summarizing the active
// project: my open checklist items, overdue/due-soon jobs, a per-stage
// board bar chart, and (Project Admin+ only) recent activity. Everything
// here reads data other tabs already own; the only mutation reused is
// toggleMyChecklistItemDone() itself, so checking an item off from Home
// behaves identically to doing it from My Checklist.

const HOME_DUE_SOON_DAYS = 7;

interface HomeOverdueRow {
  job: Job;
  card: BoardCard;
  label: string;
  dueDate: Date;
  isOverdue: boolean;
  isToday: boolean;
}

// Same visibility/archived gate buildMyChecklistRows() uses, deliberately
// WITHOUT its isChecklistStageVisibleToMe() check — that's a checklist-
// privacy control, unrelated to a job's due date. Excludes cards already
// in a finished-trigger column (isFinishedColumnId()), same columns
// buildCardEl()'s own overdue badge excludes.
function buildHomeOverdueRows(): HomeOverdueRow[] {
  const todayMidnight = new Date(new Date().toDateString());
  const dueSoonCutoff = new Date(todayMidnight.getTime() + HOME_DUE_SOON_DAYS * 86400000);
  const rows: HomeOverdueRow[] = [];
  boardCards.forEach(function (card) {
    if (!card.column || !card.due) return;
    if (isFinishedColumnId(card.column)) return;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return;
    const job = found.job;
    if (!isJobVisibleToMe(job)) return;
    const dueDate = new Date(card.due as string + 'T00:00:00');
    const isOverdue = dueDate < todayMidnight;
    const isDueSoon = !isOverdue && dueDate <= dueSoonCutoff;
    if (!isOverdue && !isDueSoon) return;
    // Splits the "due soon" half into its own today/later tiers for the
    // widget's own alert (see renderHomeOverdueWidget(), a later phase) —
    // unused by anything that only cared about isOverdue before this, so
    // adding it here is additive, not a shape change.
    const isToday = !isOverdue && dueDate.getTime() === todayMidnight.getTime();
    const phases = getJobPhases(job);
    const phase = phases.find(function (p) { return (p.id || null) === (card.phaseId || null); });
    const label = job.name + (phases.length > 1 && phase && !phase.isDefault ? ' — ' + phase.name : '');
    rows.push({ job: job, card: card, label: label, dueDate: dueDate, isOverdue: isOverdue, isToday: isToday });
  });
  rows.sort(function (a, b) {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    return a.dueDate.getTime() - b.dueDate.getTime();
  });
  return rows;
}

interface HomeStalledRow {
  job: Job;
  card: BoardCard;
  label: string;
  daysInStage: number;
  columnLabel: string;
}

// A genuinely different signal from buildHomeOverdueRows() above — time
// spent in the CURRENT stage (card.columnEnteredAt, stamped by
// setCardColumn()) rather than a due date. A card with no
// columnEnteredAt yet (predates that field, hasn't changed columns
// since) is treated as "unknown, not stalled" rather than backfilled —
// it'll get a real timestamp the next time it actually moves. Same
// finished-trigger/archived/visibility gates as buildHomeOverdueRows().
function buildHomeStalledRows(): HomeStalledRow[] {
  const now = Date.now();
  const rows: HomeStalledRow[] = [];
  boardCards.forEach(function (card) {
    if (!card.column || !card.columnEnteredAt) return;
    if (isFinishedColumnId(card.column)) return;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return;
    const job = found.job;
    if (!isJobVisibleToMe(job)) return;
    const col = BOARD_COLUMNS.find(function (c) { return c.id === card.column; });
    const thresholdDays = (col && col.stalledAfterDays as number) || DEFAULT_STALLED_AFTER_DAYS;
    const daysInStage = Math.floor((now - (card.columnEnteredAt as number)) / 86400000);
    if (daysInStage < thresholdDays) return;
    const phases = getJobPhases(job);
    const phase = phases.find(function (p) { return (p.id || null) === (card.phaseId || null); });
    const label = job.name + (phases.length > 1 && phase && !phase.isDefault ? ' — ' + phase.name : '');
    rows.push({ job: job, card: card, label: label, daysInStage: daysInStage, columnLabel: col ? col.label : card.column });
  });
  rows.sort(function (a, b) { return b.daysInStage - a.daysInStage; });
  return rows;
}

interface HomeStageSummaryRow {
  id: string;
  label: string;
  count: number;
}

// Counts visible boardCards per stage, mapped onto BOARD_COLUMNS in board
// order so every stage shows (including zero-count ones) rather than only
// stages that happen to have a card right now.
function buildHomeStageSummary(): HomeStageSummaryRow[] {
  const counts: Record<string, number> = {};
  boardCards.forEach(function (card) {
    if (!card.column) return;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return;
    if (!isJobVisibleToMe(found.job)) return;
    counts[card.column] = (counts[card.column] || 0) + 1;
  });
  return BOARD_COLUMNS.map(function (col) {
    return { id: col.id, label: col.label, count: counts[col.id] || 0 };
  });
}

interface HomeScheduleRow {
  job: Job;
  phaseId: string | null;
  subPhaseId: string | null;
  taskName: string;
  label: string;
  phaseName: string;
  start: Date;
  finish: Date;
  taskColor: string;
}

// Every Gantt task from a visible job whose date range includes today —
// replaces the old admin-gated activity feed with something everyone can
// see (Gantt itself carries no tier restriction, same as Board/Calendar)
// and that's forward-looking ("what should be happening today") rather
// than a log of what already happened. pct is how far today falls
// through the task's start->finish window, for the mini progress bar.
function buildHomeTodayScheduleRows(): HomeScheduleRow[] {
  const todayMidnight = new Date(new Date().toDateString());
  const rows: HomeScheduleRow[] = [];
  jobs.forEach(function (job) {
    if (job.archived) return;
    if (!isJobVisibleToMe(job)) return;
    const phases = getJobPhases(job);
    phases.forEach(function (phase) {
      // getPhaseSubUnits(), not phase.tasks directly — once a phase is
      // split into sub-phases, its real tasks live in
      // phase.subPhases[i].tasks and phase.tasks itself goes stale/empty
      // (see getPhaseSubUnits()'s own comment: every Gantt/Calendar
      // render path already goes through this same seam instead of
      // reading phase.tasks directly). Reading phase.tasks here meant
      // any task inside an actual sub-phase silently never showed up in
      // this widget at all, regardless of its dates.
      getPhaseSubUnits(phase).forEach(function (subUnit) {
        (subUnit.tasks || []).forEach(function (task) {
          if (!task.start || !task.finish) return;
          const start = new Date(task.start + 'T00:00:00');
          const finish = new Date(task.finish + 'T00:00:00');
          if (isNaN(start.getTime()) || isNaN(finish.getTime())) return;
          if (todayMidnight < start || todayMidnight > finish) return;
          const phaseName = phases.length > 1 && !phase.isDefault ? phase.name : '';
          const subPhaseName = !subUnit.isDefault ? subUnit.name : '';
          const nameParts = [phaseName, subPhaseName].filter(Boolean);
          const label = job.name + (nameParts.length ? ' — ' + nameParts.join(' — ') : '');
          rows.push({
            job: job, phaseId: phase.id, subPhaseId: subUnit.id, taskName: task.name || 'Untitled task',
            label: label, phaseName: nameParts.join(' — '), start: start, finish: finish,
            // Same fallback chain the Gantt bars themselves use (task's
            // own color, else its job's, else the app default).
            taskColor: task.color || job.color || '#3949ab'
          });
        });
      });
    });
  });
  rows.sort(function (a, b) { return a.label.localeCompare(b.label); });
  return rows;
}

// Same shape/traversal as buildHomeTodayScheduleRows() above, but for the
// expanded-in-place widget's wider window (see toggleHomeWidgetExpand()):
// any task whose span overlaps [windowStart, windowEnd) at all, not just
// ones covering today specifically — the compact widget's narrower
// "must include today" filter would otherwise leave the wider strip
// mostly empty on either side of the middle column.
function buildHomeUpcomingScheduleRows(windowStart: Date, windowEnd: Date): HomeScheduleRow[] {
  const rows: HomeScheduleRow[] = [];
  jobs.forEach(function (job) {
    if (job.archived) return;
    if (!isJobVisibleToMe(job)) return;
    const phases = getJobPhases(job);
    phases.forEach(function (phase) {
      getPhaseSubUnits(phase).forEach(function (subUnit) {
        (subUnit.tasks || []).forEach(function (task) {
          if (!task.start || !task.finish) return;
          const start = new Date(task.start + 'T00:00:00');
          const finish = new Date(task.finish + 'T00:00:00');
          if (isNaN(start.getTime()) || isNaN(finish.getTime())) return;
          if (finish < windowStart || start >= windowEnd) return;
          const phaseName = phases.length > 1 && !phase.isDefault ? phase.name : '';
          const subPhaseName = !subUnit.isDefault ? subUnit.name : '';
          const nameParts = [phaseName, subPhaseName].filter(Boolean);
          const label = job.name + (nameParts.length ? ' — ' + nameParts.join(' — ') : '');
          rows.push({
            job: job, phaseId: phase.id, subPhaseId: subUnit.id, taskName: task.name || 'Untitled task',
            label: label, phaseName: nameParts.join(' — '), start: start, finish: finish,
            taskColor: task.color || job.color || '#3949ab'
          });
        });
      });
    });
  });
  rows.sort(function (a, b) { return a.start.getTime() - b.start.getTime() || a.label.localeCompare(b.label); });
  return rows;
}

interface HomeGanttUnclosedRow {
  job: Job;
  card: BoardCard;
  label: string;
}

// Feeds the Gantt widget's own "needs attention" alert (see
// renderHomeTodayScheduleWidget(), a later phase) — NOT "any task is
// behind schedule" (that read as noisy — a single slipped task is normal
// mid-job), but Karl's own, narrower bar: the entire phase's schedule has
// finished (every one of its tasks' effective due dates has already
// passed) and its board card STILL hasn't been moved into a
// finished-trigger column (see isFinishedColumnId() /
// toggleColumnFinishedTrigger()) — the schedule says done, the board
// disagrees. Same per-card loop buildHomeOverdueRows()/
// buildHomeStalledRows() already use, not a per-job/per-task one, so a
// job with several phases/cards is judged phase by phase — one phase
// finishing without its card moving is already worth flagging on its
// own, it doesn't need to wait for every other phase in the job to also
// finish first.
function buildHomeGanttUnclosedRows(): HomeGanttUnclosedRow[] {
  const todayMidnight = new Date(new Date().toDateString());
  const rows: HomeGanttUnclosedRow[] = [];
  boardCards.forEach(function (card) {
    if (!card.column) return;
    if (isFinishedColumnId(card.column)) return;
    const found = findJob(card.jobId as string);
    if (!found || found.job.archived) return;
    const job = found.job;
    if (!isJobVisibleToMe(job)) return;
    const phases = getJobPhases(job);
    const phase = phases.find(function (p) { return (p.id || null) === (card.phaseId || null); });
    if (!phase) return;
    // Effective due date per task — finish, falling back to start when a
    // task never got one (same fallback the original per-task version
    // used, Karl's own call). A task with neither, or any task still due
    // today or later, means this phase isn't confirmed done yet — bails
    // out (allDone = false) rather than guessing.
    let taskCount = 0;
    let allDone = true;
    getPhaseSubUnits(phase).forEach(function (subUnit) {
      (subUnit.tasks || []).forEach(function (task) {
        const dueStr = task.finish || task.start;
        const dueDate = dueStr ? new Date(dueStr + 'T00:00:00') : null;
        if (!dueDate || isNaN(dueDate.getTime())) { allDone = false; return; }
        taskCount++;
        if (dueDate >= todayMidnight) allDone = false;
      });
    });
    // No tasks at all isn't "done" — there was nothing to schedule
    // against, so there's nothing to say finished.
    if (!taskCount || !allDone) return;
    const label = job.name + (phases.length > 1 && !phase.isDefault ? ' — ' + phase.name : '');
    rows.push({ job: job, card: card, label: label });
  });
  rows.sort(function (a, b) { return a.label.localeCompare(b.label); });
  return rows;
}

function homeGreetingPhrase(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderHomeGreeting(): string {
  const name = getStoredDisplayName() || 'there';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return '<div class="home-greeting-text">' + homeGreetingPhrase() + ', ' + escapeHtml(name) + '</div>' +
    '<div class="home-greeting-date">' + dateStr + '</div>';
}

function renderHomeChecklistWidget(rows: any[]): string {
  if (!rows.length) return '<div class="home-widget-empty"><svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="3" fill="#28a745"/><path d="M7 12l3 3 7-7" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Nothing assigned to you right now.</div></div>';
  const shown = rows.slice(0, 6);
  const html = shown.map(function (row) {
    const item = row.item;
    return '<div class="home-row">' +
      '<input type="checkbox" onchange="toggleMyChecklistItemDone(\'' + activeProjectId + '\', \'' + row.card.id + '\', \'' + row.columnId + '\', \'' + item.id + '\')">' +
      '<span class="home-row-text" onclick="openMyChecklistItem(\'' + activeProjectId + '\', \'' + row.card.id + '\')">' + escapeHtml(item.text) + '</span>' +
      '<span class="my-checklist-job-bubble" style="background:' + (row.job.color || '#3949ab') + ';">' + escapeHtml(row.job.name) + '</span>' +
    '</div>';
  }).join('');
  const more = rows.length > shown.length ? '<div class="home-more-link" onclick="switchTabMorphed(\'checklist\')">+' + (rows.length - shown.length) + ' more — go to Checklist</div>' : '';
  return html + more;
}

// Expanded-in-place version of the widget above (see
// toggleHomeWidgetExpand()) — every row instead of 6, grouped by job like
// the real Checklist tab's own renderMyChecklistList(groupByJob=true).
// Deliberately NOT a call to renderMyChecklistList() itself: that
// function's per-item assignee dropdown (myChecklistMsDropdownHtml())
// stamps DOM ids keyed only by card+item id, and the real Checklist tab's
// panel can still be sitting in the DOM (just display:none — .tab-panel
// content isn't torn down on switch) with that same row already rendered
// there from an earlier visit. Reusing it here would risk two elements
// sharing one id. So: real data, real grouping, real primary actions
// (check off, open), just without that one sub-widget.
function renderHomeChecklistWidgetExpanded(rows: any[]): string {
  if (!rows.length) return renderHomeChecklistWidget(rows);
  let lastJobId: string | null = null;
  return rows.map(function (row) {
    let groupHeader = '';
    if (row.job.id !== lastJobId) {
      lastJobId = row.job.id;
      groupHeader = '<div class="my-checklist-group-header"><span class="home-row-dot" style="background:' + (row.job.color || '#3949ab') + ';"></span>' + escapeHtml(row.job.name) + '</div>';
    }
    const item = row.item;
    return groupHeader + '<div class="checklist-item my-checklist-item">' +
      '<input type="checkbox" onchange="toggleMyChecklistItemDone(\'' + activeProjectId + '\', \'' + row.card.id + '\', \'' + row.columnId + '\', \'' + item.id + '\')">' +
      (item.required ? '<span class="ci-required is-required" title="Required">★</span>' : '') +
      '<span class="ci-text" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="openMyChecklistItem(\'' + activeProjectId + '\', \'' + row.card.id + '\')">' + escapeHtml(item.text) + '</span>' +
      '<span class="my-checklist-job-bubble" style="background:' + (row.job.color || '#3949ab') + ';" onclick="openMyChecklistItem(\'' + activeProjectId + '\', \'' + row.card.id + '\')">' + escapeHtml(row.job.name) + '</span>' +
      '<span class="my-checklist-stage-tag">' + escapeHtml(row.columnLabel) + '</span>' +
    '</div>';
  }).join('');
}

// ===== HOME WIDGET ALERTS =====
// A dismissible "this needs you" strip inside a widget's own body — only
// ever built for a widget where something is ALREADY tracked as genuinely
// urgent (Calendar's overdue jobs, Board's stalled cards), never invented
// just because a widget has content, since every one of these widgets
// always shows something whenever there's anything to show at all.
// Dismissal is keyed to the exact SET of items behind the alert (job/card
// ids, not just a count) so it behaves the way "get rid of it" should:
// dismissing "3 overdue" silences those specific 3 jobs; the moment even
// one of them changes — resolved, or a different job goes overdue instead
// — the signature changes and the alert reads as new again, even if the
// count happens to land back on 3. Persisted to localStorage (not just
// this session) since a dismissal that came back on next reload would
// defeat the point of dismissing it.
const HOME_ALERT_DISMISS_KEY = 'gantt_home_widget_alerts_dismissed_v1';
function getDismissedHomeWidgetAlerts(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(HOME_ALERT_DISMISS_KEY) || '{}'); } catch (e) { return {}; }
}
function isHomeWidgetAlertDismissed(alertId: string, signature: string): boolean {
  return getDismissedHomeWidgetAlerts()[alertId] === signature;
}
function dismissHomeWidgetAlert(event: Event, alertId: string, signature: string): void {
  event.stopPropagation();
  const dismissed = getDismissedHomeWidgetAlerts();
  dismissed[alertId] = signature;
  localStorage.setItem(HOME_ALERT_DISMISS_KEY, JSON.stringify(dismissed));
  const el = document.getElementById('homeAlert-' + alertId);
  if (el) el.remove();
}
// ids: the real job/card ids behind this alert, used ONLY to build its
// dismiss signature (see the block comment above) — never rendered.
// tier: 'overdue' (default, red), 'today' (amber), or 'soon' (blue) — see
// the .tier-today/.tier-soon CSS. Severity color, not urgency filtering;
// whether something qualifies at all is still entirely up to the caller.
function renderHomeWidgetAlert(alertId: string, ids: string[], text: string, tier?: string): string {
  if (!ids.length) return '';
  const signature = ids.slice().sort().join(',');
  if (isHomeWidgetAlertDismissed(alertId, signature)) return '';
  const tierClass = tier && tier !== 'overdue' ? ' tier-' + tier : '';
  return '<div class="home-widget-alert' + tierClass + '" id="homeAlert-' + alertId + '">' +
    '<span class="home-widget-alert-text">' + escapeHtml(text) + '</span>' +
    '<button type="button" class="home-widget-alert-dismiss" onclick="dismissHomeWidgetAlert(event, \'' + alertId + '\', \'' + signature.replace(/'/g, "\\'") + '\')" title="Dismiss">&times;</button>' +
  '</div>';
}

// Row click reuses openMyChecklistItem() directly — despite the name,
// that function is already generic (cross-project switch +
// openEditCard()), nothing checklist-item-specific about it.
function renderHomeOverdueWidget(rows: HomeOverdueRow[]): string {
  // Three severity tiers, worst first — same split the very first "Needs
  // Attention" mockup used (overdue red / today amber / later-this-week
  // blue), just as three independently-dismissible alerts on Calendar's
  // own widget instead of one merged cross-widget panel.
  const overdueRows = rows.filter(function (r) { return r.isOverdue; });
  const todayRows = rows.filter(function (r) { return !r.isOverdue && r.isToday; });
  const soonRows = rows.filter(function (r) { return !r.isOverdue && !r.isToday; });
  const alertHtml =
    renderHomeWidgetAlert('calendar-overdue', overdueRows.map(function (r) { return r.card.id; }),
      overdueRows.length + (overdueRows.length === 1 ? ' job overdue' : ' jobs overdue')) +
    renderHomeWidgetAlert('calendar-today', todayRows.map(function (r) { return r.card.id; }),
      todayRows.length + (todayRows.length === 1 ? ' job due today' : ' jobs due today'), 'today') +
    renderHomeWidgetAlert('calendar-soon', soonRows.map(function (r) { return r.card.id; }),
      soonRows.length + (soonRows.length === 1 ? ' job due soon' : ' jobs due soon'), 'soon');
  if (!rows.length) return alertHtml + '<div class="home-widget-empty"><svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5"/><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935"/><rect x="6" y="13" width="3" height="3" fill="#e53935"/><rect x="10.5" y="13" width="3" height="3" fill="#e53935"/><rect x="15" y="13" width="3" height="3" fill="#e53935"/></svg><div>No overdue or upcoming jobs.</div></div>';
  return alertHtml + renderHomeCalendarMiniMonth(rows);
}

// Expanded-in-place Calendar (see toggleHomeWidgetExpand()) — a real
// month grid with real job bars, NOT the compact widget above at a
// bigger size: renderHomeCalendarMiniMonth() only marks due dates (a
// thin strip per day), it has no bar layout to just give more room to.
// This instead ports renderMonthCalendar()'s own data/lane-packing (the
// real Calendar tab, month view) — buildCalendarJobRows(getVisibleJobs())
// for job task spans plus flattenCalendarEventsForRange() for standalone
// events, laid out with the identical per-week lane-packing pass — so a
// job's actual scheduled date range shows as a real multi-day bar, same
// as the real page. Reuses buildCalBarHtml() itself for the bar markup
// (identical visual fidelity: softened fill, job-color border, cluster
// hatching), but NOT the real Calendar tab's #calendarDays element or
// its delegated mousedown/drag listener (attached only to that specific
// element — see renderCalendar()'s own "daysEl.addEventListener"), so
// reusing the bar HTML alone would leave every bar inert here. Click-to-
// open is wired directly per bar below instead, and drag handles (which
// come along in buildCalBarHtml()'s markup for free but have nothing
// listening for them in this context) are stripped so they don't sit
// there as dead affordances.
function renderHomeCalendarExpanded(rows: HomeOverdueRow[], containerEl: HTMLElement): void {
  const overdueRows = rows.filter(function (r) { return r.isOverdue; });
  const todayRows = rows.filter(function (r) { return !r.isOverdue && r.isToday; });
  const soonRows = rows.filter(function (r) { return !r.isOverdue && !r.isToday; });
  const alertHtml =
    renderHomeWidgetAlert('calendar-overdue', overdueRows.map(function (r) { return r.card.id; }),
      overdueRows.length + (overdueRows.length === 1 ? ' job overdue' : ' jobs overdue')) +
    renderHomeWidgetAlert('calendar-today', todayRows.map(function (r) { return r.card.id; }),
      todayRows.length + (todayRows.length === 1 ? ' job due today' : ' jobs due today'), 'today') +
    renderHomeWidgetAlert('calendar-soon', soonRows.map(function (r) { return r.card.id; }),
      soonRows.length + (soonRows.length === 1 ? ' job due soon' : ' jobs due soon'), 'soon');

  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const year = today.getFullYear(), month = today.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());
  const cellDates: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    d.setHours(0, 0, 0, 0);
    cellDates.push(d);
  }

  const flatRows = buildCalendarJobRows(getVisibleJobs());
  const allJobs: any[] = flatRows.map(function (row: any, flatIdx: number) {
    return {
      flatIdx: flatIdx, job: row.job, task: row.task,
      start: new Date(row.task.start + 'T00:00:00'), finish: new Date(row.task.finish + 'T00:00:00'),
      phaseId: row.phaseId, phaseName: row.phaseName, subPhaseId: row.subPhaseId, subPhaseName: row.subPhaseName
    };
  });
  flattenCalendarEventsForRange(cellDates[0], cellDates[41]).forEach(function (row: any, i: number) {
    allJobs.push({ flatIdx: 'ce-' + i, job: row.job, task: row.task, start: row.start, finish: row.finish });
  });

  const numRows = 6;
  const rowLanes: number[] = [], rowSegments: any[][] = [];
  for (let row = 0; row < numRows; row++) {
    const rowStart = cellDates[row * 7], rowEnd = cellDates[row * 7 + 6];
    const segs = allJobs.filter(function (j) { return j.finish >= rowStart && j.start <= rowEnd; })
      .map(function (j) {
        const clampedStart = j.start < rowStart ? rowStart : j.start;
        const clampedFinish = j.finish > rowEnd ? rowEnd : j.finish;
        return {
          job: j.job, task: j.task, phaseId: j.phaseId, phaseName: j.phaseName, subPhaseId: j.subPhaseId, subPhaseName: j.subPhaseName,
          colStart: Math.round((clampedStart.getTime() - rowStart.getTime()) / 86400000),
          colEnd: Math.round((clampedFinish.getTime() - rowStart.getTime()) / 86400000),
          isTrueStart: j.start.getTime() === clampedStart.getTime(),
          isTrueEnd: j.finish.getTime() === clampedFinish.getTime(),
          spanWindowOffset: Math.round((clampedStart.getTime() - j.start.getTime()) / 86400000),
          lane: 0
        };
      })
      .sort(function (a, b) { return a.colStart - b.colStart || (a.colEnd - a.colStart) - (b.colEnd - b.colStart); });
    const laneEndCols: number[] = [];
    segs.forEach(function (seg) {
      let lane = laneEndCols.findIndex(function (endCol) { return endCol < seg.colStart; });
      if (lane === -1) { lane = laneEndCols.length; laneEndCols.push(seg.colEnd); }
      else { laneEndCols[lane] = seg.colEnd; }
      seg.lane = lane;
    });
    rowLanes.push(laneEndCols.length);
    rowSegments.push(segs);
  }

  let daysHtml = '';
  for (let row = 0; row < numRows; row++) {
    const minH = CAL_DAYNUM_H + Math.max(rowLanes[row], 1) * (CAL_BAR_H + CAL_BAR_GAP) + 10;
    for (let col = 0; col < 7; col++) {
      const cellDate = cellDates[row * 7 + col];
      const isOutside = cellDate.getMonth() !== month;
      const isToday = cellDate.getTime() === today.getTime();
      daysHtml += '<div class="cal-day' + (isOutside ? ' cal-outside' : '') + (isToday ? ' cal-today' : '') +
        '" style="min-height:' + minH + 'px;"><div class="cal-day-num">' + cellDate.getDate() + '</div></div>';
    }
  }

  containerEl.innerHTML = alertHtml +
    '<div class="calendar-grid home-cal-weekday-row">' + WEEKDAY_NAMES.map(function (d) { return '<div class="home-cal-weekday">' + d + '</div>'; }).join('') + '</div>' +
    '<div class="calendar-grid calendar-days" id="homeCalDaysGrid">' + daysHtml + '</div>';

  const daysGrid = containerEl.querySelector('#homeCalDaysGrid') as HTMLElement;
  const cellEls = daysGrid.querySelectorAll('.cal-day');
  const getCell = function (row: number, col: number) { return cellEls[row * 7 + col] as HTMLElement; };

  const barsLayer = document.createElement('div');
  barsLayer.className = 'cal-bars-layer';
  daysGrid.appendChild(barsLayer);
  // Just a scratch value to feed buildCalBarHtml()'s own internal pixel
  // math (a multi-segment cluster bar divides this width to place its
  // inner stripe blocks) — never used as the bar's actual on-screen
  // size. Whatever it is at this exact instant is fine, stale or not,
  // since every value derived from it below gets turned back into a
  // percentage of this SAME number, which cancels out.
  const dayColPxEstimate = Math.max(1, daysGrid.getBoundingClientRect().width / 7);

  for (let row = 0; row < numRows; row++) {
    rowSegments[row].forEach(function (seg) {
      const startCell = getCell(row, seg.colStart);
      // Percent-of-row, not startCell.offsetLeft/offsetWidth — this
      // widget's own column is what .home-grid's expand transition is
      // actually resizing (see toggleHomeWidgetExpand()'s own comment on
      // this exact spot), so a pixel measurement taken before that
      // finishes is stale and the bar visibly snaps once it catches up.
      // A day is always exactly 1/7 of the row regardless of the row's
      // current pixel width, so this stays correct at every frame of the
      // animation instead of needing a second pass once it settles.
      const leftPct = (seg.colStart / 7) * 100;
      const widthPct = ((seg.colEnd - seg.colStart + 1) / 7) * 100;
      // Vertical position, unlike horizontal, isn't in the middle of an
      // animating dimension here — .home-cal-weekday-row/#homeCalDaysGrid
      // give each row a fixed content height (see their own CSS), not a
      // share of the widget's own (also-animating) available height, so
      // offsetTop is already stable and safe to read synchronously.
      const top = startCell.offsetTop + CAL_DAYNUM_H + seg.lane * (CAL_BAR_H + CAL_BAR_GAP);
      const widthPxEstimate = dayColPxEstimate * (seg.colEnd - seg.colStart + 1);
      const wrap = document.createElement('div');
      wrap.innerHTML = buildCalBarHtml(seg, 0, top, widthPxEstimate);
      const barEl = wrap.firstElementChild as HTMLElement;
      barEl.style.left = leftPct + '%';
      barEl.style.width = widthPct + '%';
      barEl.style.cursor = 'pointer';
      // A multi-segment cluster's own inner stripe blocks (see
      // buildCalBarHtml()'s innerBlocksHtml) come back positioned in
      // pixels against widthPxEstimate above — convert those to percent
      // of that same estimate too, so they stay proportionally correct
      // inside the bar regardless of what its own width later animates
      // to (a plain single-fill bar has none of these; the loop is a
      // no-op for it).
      barEl.querySelectorAll('.cal-bar-segment').forEach(function (segEl) {
        const segLeftPx = parseFloat((segEl as HTMLElement).style.left) || 0;
        const segWidthPx = parseFloat((segEl as HTMLElement).style.width) || 0;
        (segEl as HTMLElement).style.left = (segLeftPx / widthPxEstimate * 100) + '%';
        (segEl as HTMLElement).style.width = (segWidthPx / widthPxEstimate * 100) + '%';
      });
      barEl.querySelectorAll('[data-drag]').forEach(function (h) { h.remove(); });
      barEl.addEventListener('click', function () {
        if (isCalendarEventTaskId(seg.task.id)) {
          const parsed = parseCalendarEventTaskId(seg.task.id);
          openEditCalendarEvent(parsed.eventId, parsed.sourceDate);
        } else if (seg.job.isLinkedReference) {
          jumpToLinkedJobReference(seg.job);
        } else {
          calendarOpenJob(seg.job.id, seg.task.id, seg.phaseId);
        }
      });
      barsLayer.appendChild(barEl);
    });
  }
}

// A real (tiny) month grid — today's month, leading/trailing days from
// the adjacent months filled in to complete each week row, same shape
// the real Calendar's own month view uses. Each day that has an overdue
// or due-soon job gets a thin bar in that job's own color (deduped —
// two cards for the same job on the same day still draw just one bar),
// capped at 3 so a genuinely packed day doesn't blow out the cell. A day
// with an actual overdue job also gets a thin red top edge, so severity
// and job identity stay two separate signals instead of the bar color
// having to carry both. Every cell is clickable — jumps the real
// Calendar to that day's month, not just switching tabs blind.
function renderHomeCalendarMiniMonth(rows: HomeOverdueRow[]): string {
  const today = new Date(new Date().toDateString());
  const year = today.getFullYear(), month = today.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const totalCells = Math.ceil((firstOfMonth.getDay() + daysInMonth) / 7) * 7;

  const byDate: Record<string, HomeOverdueRow[]> = {};
  rows.forEach(function (row) {
    const key = toIsoDate(row.dueDate);
    (byDate[key] || (byDate[key] = [])).push(row);
  });

  let html = '<div class="home-mini-cal-head">' + firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</div>';
  html += '<div class="home-mini-cal-grid">';
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { html += '<div class="home-mini-cal-dow">' + d + '</div>'; });
  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(gridStart.getTime() + i * 86400000);
    const dayRows = byDate[toIsoDate(cellDate)] || [];
    const hasOverdue = dayRows.some(function (r) { return r.isOverdue; });
    const seenJobIds: Record<string, boolean> = {};
    const barColors: string[] = [];
    dayRows.forEach(function (r) {
      if (seenJobIds[r.job.id]) return;
      seenJobIds[r.job.id] = true;
      barColors.push(r.job.color || '#3949ab');
    });
    const barsHtml = barColors.slice(0, 3).map(function (c) {
      return '<span class="home-mini-cal-bar" style="background:' + c + ';"></span>';
    }).join('');
    const onclick = 'calendarViewDate=new Date(' + cellDate.getFullYear() + ',' + cellDate.getMonth() + ',' + cellDate.getDate() + ');calendarViewMode=\'month\';switchTabMorphed(\'calendar\')';
    html += '<div class="home-mini-cal-day' +
      (cellDate.getMonth() !== month ? ' other-month' : '') +
      (cellDate.getTime() === today.getTime() ? ' today' : '') +
      (hasOverdue ? ' has-overdue' : '') +
      '" onclick="' + onclick + '">' +
      '<span class="home-mini-cal-num">' + cellDate.getDate() + '</span>' +
      (barsHtml ? '<span class="home-mini-cal-bars">' + barsHtml + '</span>' : '') +
    '</div>';
  }
  html += '</div>';
  return html;
}

// A mini version of the real Board Workflow Strip: one vertical bar per
// BOARD_COLUMNS entry (not merged by item — Karl's ask, "have the bars
// be vertical underneath them to represent the boards"), height scaled
// to its card count, with the same bracket-over-columns band on top
// (buildWorkflowStageData()'s grouping — an item spanning several
// adjacent boards still stretches its bracket across their bars).
// Called from renderHomeDashboard(); unlike the real strip it isn't
// re-triggered on window resize — this widget's own width is stable
// once Home is on screen, no board-column drag/reorder to react to.
function renderHomeWorkflowMiniBoard(): void {
  const barsWrap = document.getElementById('wsmBarsWrap');
  const track = document.getElementById('wsmBracketTrack');
  if (!barsWrap || !track) return;

  const alertEl = document.getElementById('homeStageAlert');
  if (alertEl) {
    const stalledRows = buildHomeStalledRows();
    alertEl.innerHTML = renderHomeWidgetAlert('board', stalledRows.map(function (r) { return r.card.id; }),
      stalledRows.length + (stalledRows.length === 1 ? ' card stalled' : ' cards stalled'));
  }

  const perColumnCounts: Record<string, number> = {};
  buildHomeStageSummary().forEach(function (s) { perColumnCounts[s.id] = s.count; });
  const total = Object.keys(perColumnCounts).reduce(function (n, id) { return n + perColumnCounts[id]; }, 0);

  if (!total) {
    barsWrap.innerHTML = '<div class="home-widget-empty" style="width:100%;"><svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" fill="#f0ad4e"/></svg><div>No cards on the board yet.</div></div>';
    track.innerHTML = '';
    return;
  }

  const MAX_BAR_H = 80;
  const max = Math.max.apply(null, BOARD_COLUMNS.map(function (c) { return perColumnCounts[c.id] || 0; }).concat([1]));

  barsWrap.innerHTML = BOARD_COLUMNS.map(function (col) {
    const count = perColumnCounts[col.id] || 0;
    // Bar color: same logic as the real bracket — the board's own
    // workflow item color if it has one, else the neutral fallback —
    // so a bar always matches the bracket segment sitting above it.
    const item = col.workflowItemId ? WORKFLOW_ITEMS.find(function (i) { return i.id === col.workflowItemId; }) : null;
    const color = item ? item.color : 'var(--text-light)';
    const h = Math.max(4, Math.round((count / max) * MAX_BAR_H));
    const title = count + ' job' + (count === 1 ? '' : 's') + ' in ' + col.label;
    return '<div class="wsm-bar-col" data-column="' + col.id + '" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="switchTabMorphed(\'board\'); scrollToBoardColumn(\'' + col.id + '\');" title="' + escapeHtml(title) + '">' +
      '<span class="wsm-bar-label">' + escapeHtml(col.label) + '</span>' +
      '<span class="wsm-bar-count">' + count + '</span>' +
      '<span class="wsm-bar" style="height:' + h + 'px; background:' + color + ';"></span>' +
    '</div>';
  }).join('');

  // Bracket band — same grouping (buildWorkflowStageData()) and same
  // measure-the-real-elements technique renderBoardWorkflowStrip() uses,
  // just measured against these .wsm-bar-col elements instead of real
  // .board-column ones, and scaled down.
  const wrapperRect = barsWrap.getBoundingClientRect();
  const measured = buildWorkflowStageData().map(function (g) {
    const firstEl = barsWrap.querySelector('.wsm-bar-col[data-column="' + g.firstColId + '"]') as HTMLElement | null;
    const lastEl = barsWrap.querySelector('.wsm-bar-col[data-column="' + g.lastColId + '"]') as HTMLElement | null;
    if (!firstEl || !lastEl) return null;
    const left = firstEl.getBoundingClientRect().left - wrapperRect.left + barsWrap.scrollLeft;
    const right = lastEl.getBoundingClientRect().right - wrapperRect.left + barsWrap.scrollLeft;
    return Object.assign({}, g, { left: left, right: right });
  }).filter(Boolean) as { firstColId: string; lastColId: string; label: string; color?: string; left: number; right: number }[];

  track.innerHTML = measured.map(function (g) {
    const width = g.right - g.left;
    const bw = Math.max(width - 10, 16);
    const inset = 2, flare = 5;
    const path = 'M' + inset + ',8 L' + (inset + flare) + ',2 L' + (bw - inset - flare) + ',2 L' + (bw - inset) + ',8';
    const bracketStyle = g.color ? ('color:' + g.color + ';') : 'color:var(--text-light);opacity:0.6;';
    return '<div class="wsm-seg" style="left:' + g.left + 'px; width:' + width + 'px;">' +
      '<div class="wsm-seg-label">' + escapeHtml(g.label) + '</div>' +
      '<div class="wsm-bracket-wrap" style="' + bracketStyle + '"><svg width="' + bw + '" height="8" viewBox="0 0 ' + bw + ' 8">' +
        '<path d="' + path + '" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></div>' +
    '</div>';
  }).join('');

  barsWrap.onscroll = function () {
    track.style.transform = 'translateX(-' + barsWrap.scrollLeft + 'px)';
  };
}

// Recomputes the bracket band on resize — its segment positions are
// measured in real pixels (see above), so a window drag leaves them
// stale relative to the bars underneath unless re-measured, same
// reasoning as renderBoardWorkflowStrip()'s own resize listener below.
// Debounced like the Calendar's own resize listener above, since a drag
// fires 'resize' many times in quick succession and this does a full
// innerHTML rebuild, not just a style write (unlike applyHomeReflowTracks()'s
// own undebounced resize listener, which only writes inline styles).
//
// The onPanelResize() REGISTRATION call itself deliberately stays a
// top-level statement in index.html, not here — dist/app.bundle.js (an
// IIFE) loads and runs to completion BEFORE index.html's own remaining
// inline <script> even begins, so a top-level call to the still-ambient
// onPanelResize() from inside this bundled module would throw
// "onPanelResize is not defined" immediately, aborting the WHOLE
// bundle's execution before any of main.ts's window.x = x assignments
// ever ran, failing the whole test suite including unrelated tests.
// index.html's own two sibling onPanelResize() calls (for
// panel-calendar/panel-board) already prove this exact pattern is safe
// once the call is a plain index.html statement: by the time index.html's
// script reaches it, the bundle has already finished and
// window.renderHomeWorkflowMiniBoard already exists.

// Expanded-in-place Board (see toggleHomeWidgetExpand()) — real kanban
// columns built from the exact same buildCardEl() the real Board tab
// uses, so cards here are fully real: click opens the real edit modal
// (openEditCard()), badges/checklist-progress/due-date all match. Safe
// to reuse directly (unlike the Checklist expansion's own reuse
// decision, see renderHomeChecklistWidgetExpanded()'s comment) because
// buildCardEl() keys everything off el.dataset.id, never a DOM id, so
// two copies of the same card existing at once (one here, one on the
// real Board tab's own possibly-still-rendered-but-hidden panel) can't
// collide. Column order/labels come straight from BOARD_COLUMNS, same
// as the real board and the mini bar-chart summary above.
function renderHomeWorkflowExpandedBoard(): void {
  const container = document.getElementById('homeBoardExpanded');
  if (!container) return;
  container.innerHTML = '';
  BOARD_COLUMNS.forEach(function (col) {
    const cards = boardCards.filter(function (c) { return c.column === col.id && !isCardFromArchivedJob(c) && isCardVisibleToMe(c); });
    const colEl = document.createElement('div');
    colEl.className = 'home-board-col';
    colEl.innerHTML = '<div class="home-board-col-head"><span>' + escapeHtml(col.label) + '</span><span class="home-board-col-count">' + cards.length + '</span></div>';
    // Same treatment renderBoard() gives the real .board-column when a
    // board has its own color set (BOARD_COLOR_PRESETS, via ⋮ Settings →
    // Color) — the whole column, not just its header, so it reads the
    // same way here as it does on the real Board tab.
    if (col.color) {
      colEl.style.background = col.color as string;
      const dark = isDarkColor(col.color as string);
      const head = colEl.querySelector('.home-board-col-head') as HTMLElement;
      head.style.color = dark ? '#fff' : darkenColor(col.color as string, 0.6);
    }
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'home-board-cards';
    if (!cards.length) {
      cardsWrap.innerHTML = '<div class="home-board-col-empty">No cards</div>';
    } else {
      cards.forEach(function (card) { cardsWrap.appendChild(buildCardEl(card)); });
    }
    colEl.appendChild(cardsWrap);
    container.appendChild(colEl);
  });
}

// Click reuses editJob() directly — the same handler Calendar's own job
// clicks forward to, so this behaves exactly like clicking that task
// anywhere else in the app.
// Window width for the mini-Gantt strip below (compact default; the
// expanded-in-place widget passes a wider windowDays instead — see
// toggleHomeWidgetExpand()) — the CSS itself reads this count from
// --home-gantt-days (default 7, see .home-mini-gantt-days/-row/-track),
// which renderHomeDashboard() sets to match whatever's passed here. Odd
// on purpose so today lands exactly in the middle column rather than
// off-center.
//
// A genuinely local `const` (not an index.html `var`) — renderHomeDashboard(),
// its only other reader, lives in this same module, so nothing outside
// home.ts needs to see this.
const HOME_MINI_GANTT_WINDOW_DAYS = 7;
function renderHomeTodayScheduleWidget(rows: HomeScheduleRow[], windowDays?: number, emptyLabel?: string): string {
  windowDays = windowDays || HOME_MINI_GANTT_WINDOW_DAYS;
  const unclosedRows = buildHomeGanttUnclosedRows();
  const alertHtml = renderHomeWidgetAlert('gantt-unclosed', unclosedRows.map(function (r) { return r.card.id; }),
    unclosedRows.length + (unclosedRows.length === 1 ? ' job finished, not closed out' : ' jobs finished, not closed out'));
  if (!rows.length) return alertHtml + '<div class="home-widget-empty"><svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="10" height="3.5" rx="1" fill="#3949ab"/><rect x="3" y="10.2" width="16" height="3.5" rx="1" fill="#3949ab" opacity="0.75"/><rect x="3" y="16.5" width="7" height="3.5" rx="1" fill="#3949ab" opacity="0.5"/></svg><div>' + (emptyLabel || 'Nothing scheduled today.') + '</div></div>';

  // A real (tiny) week strip — today ± a few days, positioned/sized bars
  // like the actual Gantt uses, rather than each task's own isolated 0-100%
  // fill — see .home-mini-gantt's own CSS comment for the full rationale.
  const todayMidnight = new Date(new Date().toDateString());
  const halfWindow = Math.floor(windowDays / 2);
  const windowStart = new Date(todayMidnight.getTime() - halfWindow * 86400000);
  const windowEnd = new Date(windowStart.getTime() + windowDays * 86400000);
  const todayLeftPct = (halfWindow / windowDays) * 100;

  const dayCellsHtml: string[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(windowStart.getTime() + i * 86400000);
    dayCellsHtml.push('<div class="home-mini-gantt-day' + (i === halfWindow ? ' today' : '') + '">' +
      '<span class="home-mini-gantt-dow">' + d.toLocaleDateString('en-US', { weekday: 'short' }) + '</span>' +
      '<span class="home-mini-gantt-num">' + d.getDate() + '</span>' +
    '</div>');
  }

  const rowsHtml = rows.map(function (row) {
    // Clip each bar to the visible window, same as the real Gantt's own
    // bars do at the scrolled-off edges of its timeline — a task that
    // started before the window or finishes after it still shows, just
    // flush against that edge instead of vanishing or overflowing.
    const clippedStart = row.start < windowStart ? windowStart : row.start;
    const clippedFinishExclusive = row.finish >= windowEnd ? windowEnd : new Date(row.finish.getTime() + 86400000);
    const leftPct = (getDaysDiff(windowStart, clippedStart) / (windowDays as number)) * 100;
    const widthPct = Math.max((getDaysDiff(clippedStart, clippedFinishExclusive) / (windowDays as number)) * 100, 6);
    const jobColor = row.job.color || '#3949ab';
    // subPhaseId only ever shows up alongside a real phaseId (sub-phases
    // can only exist on a real phase, never on the synthetic no-phases
    // default — see getJobPhases()/getPhaseSubUnits()), so there's no
    // "subPhaseId but no phaseId" case to special-case here.
    const editArgs = ["'" + row.job.id + "'"];
    if (row.phaseId) editArgs.push("'" + row.phaseId + "'");
    if (row.subPhaseId) editArgs.push("'" + row.subPhaseId + "'");
    const titleText = row.label + (row.phaseName ? ' — ' + row.phaseName : '');
    return '<div class="home-mini-gantt-row" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="editJob(' + editArgs.join(', ') + ')" title="' + escapeHtml(titleText) + '">' +
      '<div class="home-mini-gantt-label">' + escapeHtml(row.taskName) + '</div>' +
      '<div class="home-mini-gantt-track">' +
        '<div class="home-mini-gantt-bar" style="left:' + leftPct + '%; width:' + widthPct + '%; background:' + softenColor(row.taskColor) + '; border-color:' + jobColor + ';">' +
          '<span class="home-mini-gantt-pill" style="background:' + jobColor + ';">' + escapeHtml(row.job.name) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  return alertHtml +
    '<div class="home-mini-gantt">' +
      '<div class="home-mini-gantt-days">' + dayCellsHtml.join('') + '</div>' +
      '<div class="home-mini-gantt-today-line" style="left:calc(56px + (100% - 56px) * ' + (todayLeftPct / 100) + ');"></div>' +
      rowsHtml +
    '</div>';
}

// ===== HOME JOB CHAT WIDGET =====
// Aggregates every visible, non-archived job's own comments (the exact
// array the job drawer's Comments panel already reads and writes — no
// separate data model, no new sync path) into one combined, newest-first
// feed. "Visible" reuses isJobVisibleToMe() — the same Members-based rule
// governing everything else, so this never shows a comment on a job
// someone isn't otherwise allowed to see. Archived jobs drop out
// entirely (not just capped/hidden-by-default) per Karl's own call —
// same lifecycle boundary "archived" already means everywhere else in
// this app.
interface HomeJobChatRow {
  job: Job;
  comment: any;
}
function buildHomeJobChatFeed(): HomeJobChatRow[] {
  const rows: HomeJobChatRow[] = [];
  jobs.forEach(function (job) {
    if (job.archived) return;
    if (!isJobVisibleToMe(job)) return;
    ((job.comments as any[]) || []).forEach(function (c) { rows.push({ job: job, comment: c }); });
  });
  rows.sort(function (a, b) { return (b.comment.when || 0) - (a.comment.when || 0); });
  return rows;
}

function renderHomeJobChatComposeOptions(): void {
  const select = document.getElementById('homeJobChatJobPicker') as HTMLSelectElement | null;
  if (!select) return;
  const prevValue = select.value;
  const visibleJobs = jobs.filter(function (j) { return !j.archived && isJobVisibleToMe(j); })
    .slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  select.innerHTML = visibleJobs.map(function (j) {
    return '<option value="' + j.id + '">' + escapeHtml(j.name) + '</option>';
  }).join('');
  // Re-selects whatever was picked before this refresh (a new comment
  // arriving elsewhere shouldn't reset who you're about to message) —
  // falls back to the list's own first option otherwise.
  if (visibleJobs.some(function (j) { return j.id === prevValue; })) select.value = prevValue;
}

// Same shape as renderJobCommentItem() (the drawer's own per-comment
// markup) plus one addition — a .job-chat-source chip naming which job
// this is, since a single job's own comment thread never needed to say
// that before. Reply UI uses its own "home-" id prefix
// (toggleHomeReplyBox()/addHomeJobReply(), not toggleReplyBox()/
// addJobReply()) because the drawer's comment list and this feed can
// both be present in the DOM at once (tab panels stay mounted, just
// hidden) — sharing ids would mean duplicate ids on the page and
// document.getElementById() picking whichever one happened to come
// first, not necessarily the one actually clicked.
function renderHomeJobChatItem(job: Job, c: any): string {
  const replies = (c.replies || []).slice().sort(function (a: any, b: any) { return (a.when || 0) - (b.when || 0); });
  const repliesHtml = replies.map(function (r: any) {
    return '<div class="job-comment-reply-item">' +
      '<div class="job-comment-meta">' +
        '<span class="job-comment-author" title="' + escapeHtml(r.author || 'Someone') + '">' + escapeHtml(r.author || 'Someone') + '</span>' +
        '<span style="display:flex;align-items:center;gap:4px;">' +
          '<span class="job-comment-when">' + formatCommentWhen(r.when) + '</span>' +
          '<button class="job-comment-delete" data-min-tier="commenter" onclick="deleteJobReply(\'' + job.id + '\', \'' + c.id + '\', \'' + r.id + '\')" title="Delete reply">×</button>' +
        '</span>' +
      '</div>' +
      '<div class="job-comment-text">' + escapeHtml(r.text) + '</div>' +
    '</div>';
  }).join('');

  return '<div class="job-comment-item">' +
    '<div class="job-comment-meta">' +
      '<span style="display:flex;align-items:center;">' +
        '<span class="job-chat-source" tabindex="0" role="button" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}" onclick="editJob(\'' + job.id + '\')" title="Open ' + escapeHtml(job.name) + '"><span class="job-chat-source-dot" style="background:' + (job.color || '#3949ab') + ';"></span>' + escapeHtml(job.name) + '</span>' +
        (c.important ? '<span class="job-comment-important-badge" title="Marked important">●</span>' : '') +
        '<span class="job-comment-author" title="' + escapeHtml(c.author || 'Someone') + '">' + escapeHtml(c.author || 'Someone') + '</span>' +
      '</span>' +
      '<span style="display:flex;align-items:center;gap:4px;">' +
        '<span class="job-comment-when">' + formatCommentWhen(c.when) + '</span>' +
        '<button class="job-comment-delete" data-min-tier="commenter" onclick="deleteJobComment(\'' + job.id + '\', \'' + c.id + '\')" title="Delete comment">×</button>' +
      '</span>' +
    '</div>' +
    '<div class="job-comment-text">' + escapeHtml(c.text) + '</div>' +
    (replies.length ? '<div class="job-comment-replies">' + repliesHtml + '</div>' : '') +
    '<button class="job-comment-reply-btn" onclick="toggleHomeReplyBox(\'' + c.id + '\', event)">Reply' + (replies.length ? ' (' + replies.length + ')' : '') + '</button>' +
    '<div class="job-comment-reply-input-row" id="home-reply-row-' + c.id + '">' +
      '<textarea id="home-reply-ta-' + c.id + '" data-min-tier="commenter" placeholder="Write a reply..." onkeydown="handleHomeReplyKey(event, \'' + job.id + '\', \'' + c.id + '\')"></textarea>' +
      '<button class="btn btn-primary" data-min-tier="commenter" style="align-self:flex-end;padding:4px 10px;font-size:12px;" onclick="addHomeJobReply(\'' + job.id + '\', \'' + c.id + '\')">Post Reply</button>' +
    '</div>' +
  '</div>';
}

function renderHomeJobChat(): void {
  const listEl = document.getElementById('homeJobChatList');
  if (!listEl) return;
  renderHomeJobChatComposeOptions();
  const rows = buildHomeJobChatFeed();
  listEl.innerHTML = rows.length
    ? rows.map(function (row) { return renderHomeJobChatItem(row.job, row.comment); }).join('')
    : '<div class="job-comments-empty">No comments yet.</div>';
  applyPermissionGating(); // rebuilt on every feed refresh, outside renderAll()'s own sweep
}

function postHomeJobChatComment(): void {
  const select = document.getElementById('homeJobChatJobPicker') as HTMLSelectElement | null;
  const input = document.getElementById('homeJobChatInput') as HTMLTextAreaElement | null;
  if (!select || !input || !select.value) return;
  const posted = postJobComment(select.value, input.value, false);
  if (posted) input.value = '';
}

// home-reply-row-/home-reply-ta- prefixed variants of toggleReplyBox()/
// addJobReply() above — see renderHomeJobChatItem()'s own comment for
// why this feed can't just reuse those ids directly. The actual "post a
// reply" logic is still the one shared postJobReply() helper.
function toggleHomeReplyBox(commentId: string, event?: Event): void {
  if (event) event.stopPropagation();
  const row = document.getElementById('home-reply-row-' + commentId) as HTMLElement | null;
  if (!row) return;
  const isOpen = row.style.display === 'flex';
  document.querySelectorAll('#homeJobChatList .job-comment-reply-input-row').forEach(function (r) { (r as HTMLElement).style.display = 'none'; });
  if (!isOpen) {
    row.style.display = 'flex';
    const ta = document.getElementById('home-reply-ta-' + commentId);
    if (ta) ta.focus();
  }
}

function addHomeJobReply(jobId: string, commentId: string): void {
  const ta = document.getElementById('home-reply-ta-' + commentId) as HTMLTextAreaElement | null;
  const posted = postJobReply(jobId, commentId, ta ? ta.value : false);
  if (posted && ta) ta.value = '';
}

function handleHomeReplyKey(event: KeyboardEvent, jobId: string, commentId: string): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addHomeJobReply(jobId, commentId);
  }
}

function renderHomeDashboard(): void {
  const panel = document.getElementById('panel-home');
  if (!panel) return;
  // Keeps .home-grid's own inline column widths (see
  // applyHomeReflowTracks()) in sync on every Home render, not just when
  // actually expanding/collapsing a widget — critically including the
  // very FIRST render, before any expand click has ever happened. Without
  // this, that first click transitions from the plain CSS default
  // (1fr 0.8fr 1fr, a stylesheet rule, not an inline style) straight to
  // the computed pixel widths applyHomeReflowTracks() uses — grid track
  // lists can only animate smoothly between two values of the SAME kind
  // (fr<->fr or px<->px), so that fr->px jump has no valid interpolation
  // path and Chrome falls back to snapping partway through the duration
  // instead of animating (verified against an isolated repro — Karl's
  // own "I just lost the transition" report). Establishing a pixel
  // baseline here means every later transition, including that first
  // one, is px->px.
  applyHomeReflowTracks();
  const checklistRows = buildMyChecklistRows();
  const overdueRows = buildHomeOverdueRows();
  const greetingEl = document.getElementById('homeGreeting');
  if (greetingEl) greetingEl.innerHTML = renderHomeGreeting();
  const checklistBody = document.getElementById('homeChecklistBody');
  if (checklistBody) checklistBody.innerHTML = homeExpandedWidgetId === 'checklist' ? renderHomeChecklistWidgetExpanded(checklistRows) : renderHomeChecklistWidget(checklistRows);
  const overdueBody = document.getElementById('homeOverdueBody');
  if (overdueBody) {
    if (homeExpandedWidgetId === 'calendar') renderHomeCalendarExpanded(overdueRows, overdueBody);
    else overdueBody.innerHTML = renderHomeOverdueWidget(overdueRows);
  }
  if (document.getElementById('homeStageBody')) {
    renderHomeWorkflowMiniBoard();
    if (homeExpandedWidgetId === 'board') renderHomeWorkflowExpandedBoard();
  }
  const todayBody = document.getElementById('homeTodayBody');
  const todayWidgetEl = document.getElementById('homeWidgetToday');
  if (todayBody) {
    const ganttExpanded = homeExpandedWidgetId === 'gantt';
    const windowDays = ganttExpanded ? 13 : HOME_MINI_GANTT_WINDOW_DAYS;
    if (todayWidgetEl) todayWidgetEl.style.setProperty('--home-gantt-days', String(windowDays));
    let rows: HomeScheduleRow[];
    if (ganttExpanded) {
      const todayMidnight = new Date(new Date().toDateString());
      const half = Math.floor(windowDays / 2);
      const windowStart = new Date(todayMidnight.getTime() - half * 86400000);
      const windowEnd = new Date(windowStart.getTime() + windowDays * 86400000);
      rows = buildHomeUpcomingScheduleRows(windowStart, windowEnd);
    } else {
      rows = buildHomeTodayScheduleRows();
    }
    todayBody.innerHTML = renderHomeTodayScheduleWidget(rows, windowDays, ganttExpanded ? 'Nothing scheduled in this window.' : undefined);
  }
  renderHomeJobChat();
  applyPermissionGating();
}

// A top-level call, run once when this module loads (see
// onPanelResize()'s own comment in src/utils/ui.ts).
onPanelResize('panel-home', renderHomeWorkflowMiniBoard, 200);

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
  buildHomeOverdueRows,
  buildHomeStalledRows,
  buildHomeStageSummary,
  buildHomeTodayScheduleRows,
  buildHomeUpcomingScheduleRows,
  buildHomeGanttUnclosedRows,
  renderHomeGreeting,
  renderHomeChecklistWidget,
  renderHomeChecklistWidgetExpanded,
  getDismissedHomeWidgetAlerts,
  isHomeWidgetAlertDismissed,
  dismissHomeWidgetAlert,
  renderHomeWidgetAlert,
  renderHomeOverdueWidget,
  renderHomeCalendarExpanded,
  renderHomeCalendarMiniMonth,
  renderHomeWorkflowMiniBoard,
  renderHomeWorkflowExpandedBoard,
  renderHomeTodayScheduleWidget,
  buildHomeJobChatFeed,
  renderHomeJobChatComposeOptions,
  renderHomeJobChatItem,
  renderHomeJobChat,
  postHomeJobChatComment,
  toggleHomeReplyBox,
  addHomeJobReply,
  handleHomeReplyKey,
  renderHomeDashboard,
};
