// The Activity Log sidebar (projectAdmin+ only) — a running feed of who did
// what, merging logActivity()'s local fallback entries (src/sync/outbound.ts,
// which owns localActivityLog — pushed immediately so an offline/not-yet-
// synced action shows up right away) with the project's synced log
// (populated from the room's snapshot by applyRoomSnapshot()).
import { escapeHtml } from '../utils/html';
import { hasMinTier } from '../auth/permissions';
import { getActiveProject } from './project';
import { applyHomeReflowTracks, renderHomeWorkflowMiniBoard } from '../views/home';

export function toggleActivitySidebar(): void {
  const sidebar = document.getElementById('activitySidebar')!;
  const btn = document.getElementById('activityToggleBtn')!;
  // Defense-in-depth for OPENING only — the trigger button is already
  // data-min-tier gated, but this is also reachable from the sidebar's own
  // close button, which must always be allowed to close it regardless of
  // tier (e.g. if it was left open across a mid-session downgrade — see
  // renderActivityLogSidebar()'s own force-close for that same case).
  const wasOpen = !sidebar.classList.contains('collapsed');
  if (!wasOpen && !hasMinTier('projectAdmin')) return;
  sidebar.classList.toggle('collapsed');
  const isOpen = !sidebar.classList.contains('collapsed');
  btn.classList.toggle('active', isOpen);
  if (isOpen) renderActivityLogSidebar();

  // This sidebar's own width transition resizes .panels-container (a flex
  // sibling), which in turn resizes the Home dashboard's grid — but that
  // grid's column widths are pinned to real pixel values (see
  // applyHomeReflowTracks()) that don't self-adjust the way fr units
  // would, and opening/closing this sidebar never fires a real `window`
  // resize event to trigger the recompute a widget-expand click or an
  // actual window resize would (Karl's report: the layout correctly
  // shifts on open, once something else happens to re-render Home, but
  // never shifts back on close). Re-measure once THIS transition settles,
  // same "wait for transitionend, not the synchronous class toggle"
  // pattern toggleHomeWidgetExpand() uses for its own layout-affecting
  // transition — only while Home is actually the visible tab, since
  // measuring a hidden #panel-home would read a zero width.
  const homePanel = document.getElementById('panel-home');
  if (homePanel && homePanel.classList.contains('active')) {
    const onSettled = function (e: Event) {
      if (e.target !== sidebar || (e as TransitionEvent).propertyName !== 'width') return;
      sidebar.removeEventListener('transitionend', onSettled);
      applyHomeReflowTracks();
      renderHomeWorkflowMiniBoard();
    };
    sidebar.addEventListener('transitionend', onSettled);
  }
}

export function timeAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.round(hr / 24);
  return day + 'd ago';
}

// LiveList items stored via push() come back as LiveObject instances.
export function getLogProp(item: any, key: string): any {
  if (item && typeof item.get === 'function') return item.get(key);
  return item ? item[key] : undefined;
}

export function renderActivityLogSidebar(): void {
  const bodyEl = document.getElementById('activitySidebarBody');
  // Defense-in-depth, and the actual fix for the case that matters: this
  // gets called from several places whenever the room data changes (not
  // just from toggleActivitySidebar() opening it), so if the sidebar was
  // already open when a tier downgrade landed mid-session, those refreshes
  // would otherwise keep quietly re-populating it — the trigger button
  // being hidden doesn't un-open an already-open sidebar. Force it closed
  // and blank here instead.
  if (!hasMinTier('projectAdmin')) {
    const sidebar = document.getElementById('activitySidebar');
    if (sidebar) sidebar.classList.add('collapsed');
    const btn = document.getElementById('activityToggleBtn');
    if (btn) btn.classList.remove('active');
    if (bodyEl) bodyEl.innerHTML = '';
    return;
  }
  const p = getActiveProject();
  const items: any[] = [];

  localActivityLog.forEach(function (item) { items.push(item); });

  if (p && Array.isArray(p.activityLog)) {
    p.activityLog.forEach(function (item: any) { items.push(item); });
  }

  // Deduplicate by exact who+what+when match
  const seen = new Set<string>();
  const unique: any[] = [];
  items.forEach(function (item) {
    const key = (getLogProp(item, 'who') || '') + '|' + (getLogProp(item, 'what') || '') + '|' + (getLogProp(item, 'when') || 0);
    if (!seen.has(key)) { seen.add(key); unique.push(item); }
  });

  if (!unique.length) {
    bodyEl!.innerHTML = '<div class="activity-log-empty">No activity yet.</div>';
    return;
  }

  // Sort by time descending
  unique.sort(function (a, b) { return (getLogProp(b, 'when') || 0) - (getLogProp(a, 'when') || 0); });

  const html = unique.slice(0, 50).map(function (item) {
    const when = getLogProp(item, 'when') || Date.now();
    const who = escapeHtml(getLogProp(item, 'who') || 'Someone');
    const what = escapeHtml(getLogProp(item, 'what') || '');
    return '<div class="activity-log-item">' +
      '<div class="activity-log-time">' + timeAgo(when) + '</div>' +
      '<div><span class="activity-log-who">' + who + '</span> <span class="activity-log-what">' + what + '</span></div>' +
    '</div>';
  }).join('');
  bodyEl!.innerHTML = html;
}
