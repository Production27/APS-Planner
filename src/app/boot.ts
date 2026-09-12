// Boot glue: init() (the app's own startup sequence, once a session
// token is available), the fresh-device loading overlay, the global
// Escape-key and click-outside handlers, and the two small boot-only
// fragments that used to sit under the stale "Room Sync"/"Presence"
// banners in index.html (mergeTombstones() and the boot() IIFE itself,
// which awaits a session token then calls init()). This is Phase 11 of
// the extraction plan — last by necessity, same as the original
// architecture roadmap's own boot()/init(): nothing here can be
// meaningfully extracted until everything it wires together already has
// been, which by this phase, it finally has.
import { loadDarkModePref, closeThemeModal } from './theme';
import { maybeShowTutorialPrompt } from './onboarding';
import { getSessionToken } from '../auth/login';
import { decodeSessionTokenPayload } from '../auth/session';
import { applyIdentityFromTokenPayload } from '../auth/permissions';
import { pruneStrayEmptyProjects } from '../sync/outbound';
import { isBusyEditing, setupLiveblocksSync } from '../sync/connection';
import { refreshActiveProjectFromShared } from '../sync/inbound';
import { renderGantt, hideDatePopover, setupScrollSync } from '../views/gantt';
import { initCalendarDragHandlers, buildCalendarEventColorPresets, closeCalendarEventModal } from '../views/calendar';
import { closeAllColSettings, initCardFormAutosaveListeners, closeManageFields, closeCardModal } from '../views/board';
import { closeAllMsDropdowns } from '../utils/ui';
import { closeSettingsMenu } from './settings-menu';
import { loadLinkEnabledPref, loadProjects, enforceFixedProjectSet, loadActiveProjectData, autoArchiveJobs, renderAll } from './project';
import { syncCardColumns } from '../core/jobs';
import { closeDeleteJobModal } from '../views/job-list';
import { cancelEdit, initJobFormAutosaveListeners } from '../views/job-form';

declare global {
  function buildColorPresets(): void;
}

// How long a delete tombstone (see recordTombstone()/deleteFromSharedMap(),
// both still in index.html) sticks around before it's pruned locally.
// Needs to outlast any realistically-stale tab/device so its eventual
// reconnect-replay still gets blocked from resurrecting whatever it
// deleted (the server enforces this too — see worker/src/room-state.ts —
// this is just the client's own mirror of the same rule, used when
// merging a snapshot).
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function mergeTombstones(a: Record<string, number> | undefined, b: Record<string, number>): Record<string, number> {
  const merged = Object.assign({}, a || {}, b || {});
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  Object.keys(merged).forEach(function (id) {
    if (!merged[id] || merged[id] < cutoff) delete merged[id];
  });
  return merged;
}

// Only for a device with zero locally-cached project data (see
// freshLocalSeed, set by migrateFromLegacy()) — covers the fabricated
// placeholder projects init() still creates internally (other code
// relies on projects/activeProjectId always being populated) so the user
// sees a loading screen instead of a flash of fake project names, until
// the real snapshot arrives and replaces them. Safety-net timeout in case
// the connection never completes, so a bad network doesn't strand the
// user on a blank spinner forever — falls back to showing whatever
// loaded (same as pre-loading-screen behavior).
let freshLoadOverlayTimer: ReturnType<typeof setTimeout> | null = null;
export function showFreshLoadOverlay(): void {
  const el = document.getElementById('freshLoadOverlay');
  if (el) el.classList.add('show');
  if (freshLoadOverlayTimer) clearTimeout(freshLoadOverlayTimer);
  freshLoadOverlayTimer = setTimeout(hideFreshLoadOverlay, 20000);
}
export function hideFreshLoadOverlay(): void {
  if (freshLoadOverlayTimer) clearTimeout(freshLoadOverlayTimer);
  freshLoadOverlayTimer = null;
  const el = document.getElementById('freshLoadOverlay');
  if (el) el.classList.remove('show');
}

export function init(): void {
  loadProjects();
  enforceFixedProjectSet();
  // Catches a stray empty "Untitled Project" already sitting in this
  // browser's own local data (from before a fresh snapshot even arrives) —
  // see pruneStrayEmptyProjects(). Safe to call this early: sendRoomMessage()
  // queues the removal and replays it once the socket actually connects.
  pruneStrayEmptyProjects();
  if (freshLocalSeed) showFreshLoadOverlay();
  loadLinkEnabledPref();
  loadDarkModePref();
  loadActiveProjectData();
  buildColorPresets();
  autoArchiveJobs();
  renderAll();
  setupScrollSync();
  buildCalendarEventColorPresets();
  initJobFormAutosaveListeners();
  initCardFormAutosaveListeners();
  maybeShowTutorialPrompt();
  setInterval(() => {
    if (document.getElementById('panel-gantt')!.classList.contains('active') && !barMoveState) renderGantt();
    syncCardColumns();
    // Safety net: a remote update deferred while isBusyEditing() was true
    // is normally caught up on the next focusout, but that relies on focus
    // actually shifting somewhere afterward — e.g. closing a modal by
    // clicking a button with nothing else focused might not fire one. This
    // guarantees it's never stuck for more than a minute regardless.
    if (pendingRemoteRefresh && !isBusyEditing()) {
      pendingRemoteRefresh = false;
      refreshActiveProjectFromShared();
    }
  }, 60000);
}

// Snapshot before the click's own handlers run (mousedown fires first),
// so the outside-click-closes-the-drawer check below can tell "this click
// opened/switched to a different job" apart from "this click was genuinely
// outside and nothing else touched editingJobId."
let editingJobIdAtMouseDown: string | null = null;
document.addEventListener('mousedown', function () {
  editingJobIdAtMouseDown = editingJobId;
});

document.addEventListener('click', function (e) {
  const target = e.target as HTMLElement;
  // Two possible triggers now (desktop rail-tab-row's, mobile
  // view-switcher's own — see positionSettingsMenu()'s own comment), and
  // the dropdown itself is a separate top-level element rather than a
  // child of either — .closest() against both independently (instead of
  // querying a single wrap and checking .contains()) is what makes this
  // correct regardless of which trigger opened it.
  if (!target.closest('.settings-menu-wrap') && !target.closest('#settingsDropdown')) closeSettingsMenu();

  // Close column settings dropdowns
  if (!target.closest('.board-col-settings-wrap')) closeAllColSettings();

  // Close member multi-select dropdowns (Members custom field, calendar
  // event "Visible to")
  if (!target.closest('.ms-dropdown')) closeAllMsDropdowns();

  // Close the job drawer on a click outside it — but not for a click that
  // opened/switched it in the first place (a Gantt bar or Calendar entry
  // for a different job also opens the drawer; without this check, this
  // same click closing it right back would make those unusable while the
  // drawer was already open). editingJobIdAtMouseDown lets us tell the two
  // apart: if the job actually being edited changed during this click,
  // something else already handled it deliberately.
  //
  // e.target.isConnected guards a second case: the "+ Add Job" button at
  // the bottom of the list opens the drawer and then calls renderJobList(),
  // which rebuilds the list and destroys that very button — all inside
  // this same click, before it finishes bubbling here. A detached node
  // isn't "contained" by anything, so without this check the click looked
  // like it came from outside both the rail and the drawer and closed it
  // right back. If the target's been removed from the document by its own
  // click handler, we can't trust the containment check either way, so
  // just leave the drawer alone.
  const formArea = document.getElementById('formArea');
  if (formArea && formArea.classList.contains('open') && target.isConnected &&
      !formArea.contains(target) && !document.getElementById('jobRail')!.contains(target) &&
      !target.closest('.modal-overlay') && editingJobId === editingJobIdAtMouseDown) {
    cancelEdit();
  }
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    closeDeleteJobModal();
    closeCardModal();
    const calendarEventModalEl = document.getElementById('calendarEventModal');
    if (calendarEventModalEl && calendarEventModalEl.classList.contains('show')) closeCalendarEventModal();
    closeSettingsMenu();
    const manageFieldsModalEl = document.getElementById('manageFieldsModal');
    if (manageFieldsModalEl && manageFieldsModalEl.classList.contains('show')) closeManageFields();
    const themeModalEl = document.getElementById('themeModal');
    if (themeModalEl && themeModalEl.classList.contains('show')) closeThemeModal();
    closeAllMsDropdowns();
    hideDatePopover();
    const jobFormEl = document.getElementById('jobForm');
    if (jobFormEl && jobFormEl.style.display !== 'none') cancelEdit();
  }
});

// Every getElementById(...) below is guarded — none of these elements
// should ever be missing from the markup, but an unguarded
// getElementById('x').addEventListener(...) throws immediately if one
// ever is, and inside the shared Escape-key handler above that used to
// silently kill every close-call listed AFTER the missing one in the
// same keypress, not just the one for the missing element.
{
  const deleteModal = document.getElementById('deleteModal');
  if (deleteModal) deleteModal.addEventListener('click', function (e) { if (e.target === this) closeDeleteJobModal(); });
}
{
  const cardModal = document.getElementById('cardModal');
  if (cardModal) cardModal.addEventListener('click', function (e) { if (e.target === this) closeCardModal(); });
}
{
  const calendarEventModalEl = document.getElementById('calendarEventModal');
  if (calendarEventModalEl) calendarEventModalEl.addEventListener('click', function (e) { if (e.target === this) closeCalendarEventModal(); });
}
{
  const manageFieldsModalEl = document.getElementById('manageFieldsModal');
  if (manageFieldsModalEl) manageFieldsModalEl.addEventListener('click', function (e) { if (e.target === this) closeManageFields(); });
}
{
  const themeModalEl = document.getElementById('themeModal');
  if (themeModalEl) themeModalEl.addEventListener('click', function (e) { if (e.target === this) closeThemeModal(); });
}

{
  const headerSubtitle = document.getElementById('headerSubtitle');
  if (headerSubtitle) {
    headerSubtitle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); (this as HTMLElement).blur(); }
    });
    headerSubtitle.addEventListener('paste', function (e) {
      e.preventDefault();
      const text = ((e as ClipboardEvent).clipboardData || (window as any).clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
  }
}

// Initialize — gated behind a valid session first. Previously the app
// rendered immediately from whatever project data was cached locally while
// auth happened lazily in the background (the login prompt only appeared
// once something, usually the WebSocket connect, actually needed a token),
// so a logged-out visitor briefly saw the full app shell before ever being
// asked to sign in. getSessionToken() returns instantly if a still-valid
// token is already cached (no visible interruption for a returning,
// already-logged-in user) or awaits the login overlay otherwise.
export async function boot(): Promise<void> {
  const token = await getSessionToken();
  applyIdentityFromTokenPayload(decodeSessionTokenPayload(token));
  init();
  initCalendarDragHandlers();
  setupLiveblocksSync();
}
