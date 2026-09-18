import { render } from 'preact';
import { AlertBar, type HomeAlertProps } from './home-widget-alert';

// Home dashboard's Overdue widget (#homeOverdueBody) — a static, empty
// element from index.html exclusively written to by renderHomeDashboard()
// (see home.ts) and nothing else, same "safe to hand over directly, no
// wrapper needed" case as Checklist's own widget body (see
// home-checklist.tsx's own comment).
//
// Deliberately its OWN separate implementation, not a reuse of the real
// Calendar tab's own Preact bar component (calendar-bar.tsx) — an explicit
// choice Karl made when this came up (same fork as Board's own untouched
// mini-board widget). The bar MARKUP itself still comes from calendar.ts's
// buildCalBarHtml() (already kept around specifically for this cross-file
// reuse — see its own comment), rendered here via dangerouslySetInnerHTML
// on the bar's own real outer element (its class/style/title lifted
// straight off the DOM node buildCalBarHtml() built, not re-derived) —
// NOT a wrapper div. A `display:contents` wrapper was considered and
// rejected: index.html has an existing scar from that exact technique
// silently breaking `order` across its boundary elsewhere in this app, and
// using the bar's own element directly sidesteps the question entirely
// instead of gambling on a different display:contents edge case.
//
// The expanded month grid's day cells and bars-layer both get fresh props
// every render (this widget has no drag/resize gesture to preserve node
// identity through, unlike Gantt/Calendar's own bars), but the CONTAINER
// itself (#homeOverdueBody) is still Preact-owned end to end, so alert
// dismissal (see AlertBar) can trigger a clean re-render instead of the
// old code's raw `el.remove()` — see buildHomeAlertProps()'s own comment
// in home.ts for why that mattered once this became a Preact subtree.

export interface HomeCalMiniMonthCellProps {
  cellKey: string;
  dayNum: number;
  otherMonth: boolean;
  isToday: boolean;
  hasOverdue: boolean;
  barColors: string[];
  onClick: () => void;
}

export interface HomeCalExpandedCellProps {
  cellKey: string;
  dayNum: number;
  isOutside: boolean;
  isToday: boolean;
  minHeight: number;
}

export interface HomeCalExpandedBarProps {
  barKey: string;
  className: string;
  styleCssText: string;
  title: string;
  innerHtml: string;
  onClick: () => void;
}

export interface HomeOverdueWidgetProps {
  alerts: HomeAlertProps[];
  expanded: boolean;
  empty?: boolean;
  compactHeadLabel?: string;
  compactCells?: HomeCalMiniMonthCellProps[];
  expandedCells?: HomeCalExpandedCellProps[];
  expandedBars?: HomeCalExpandedBarProps[];
}

function EmptyOverdue() {
  return (
    <div class="home-widget-empty">
      <svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2" fill="#fff" stroke="#e53935" stroke-width="1.5" /><rect x="3" y="5" width="18" height="4" rx="2" fill="#e53935" /><rect x="6" y="13" width="3" height="3" fill="#e53935" /><rect x="10.5" y="13" width="3" height="3" fill="#e53935" /><rect x="15" y="13" width="3" height="3" fill="#e53935" /></svg>
      <div>No overdue or upcoming jobs.</div>
      <div class="home-widget-empty-caption">Anything overdue or due soon across every job will show up here.</div>
    </div>
  );
}

function MiniMonthDay(p: HomeCalMiniMonthCellProps) {
  return (
    <div
      class={'home-mini-cal-day' + (p.otherMonth ? ' other-month' : '') + (p.isToday ? ' today' : '') + (p.hasOverdue ? ' has-overdue' : '')}
      onClick={p.onClick}
    >
      <span class="home-mini-cal-num">{p.dayNum}</span>
      {p.barColors.length ? (
        <span class="home-mini-cal-bars">
          {p.barColors.map((c, i) => <span key={i} class="home-mini-cal-bar" style={{ background: c }} />)}
        </span>
      ) : null}
    </div>
  );
}

function CompactMiniMonth({ headLabel, cells }: { headLabel: string; cells: HomeCalMiniMonthCellProps[] }) {
  return (
    <>
      <div class="home-mini-cal-head">{headLabel}</div>
      <div class="home-mini-cal-grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} class="home-mini-cal-dow">{d}</div>)}
        {cells.map((c) => <MiniMonthDay key={c.cellKey} {...c} />)}
      </div>
    </>
  );
}

// Renders straight from styleCssText/className/innerHtml lifted off the
// real DOM node buildCalBarHtml() built (see home.ts's
// buildHomeCalExpandedBarProps()) rather than re-deriving them as JSX
// props — that function's fill-color/cluster-stripe/border math is
// substantial, and copying its OUTPUT instead of its LOGIC means a future
// change to buildCalBarHtml() flows through here automatically instead of
// needing a matching edit in a second place. tabIndex/role are hardcoded
// rather than lifted too, since buildCalBarHtml() sets tabindex="0"
// role="button" unconditionally for every bar it builds.
function ExpandedBar(p: HomeCalExpandedBarProps) {
  return (
    <div
      class={p.className}
      style={p.styleCssText}
      title={p.title}
      tabIndex={0}
      role="button"
      onClick={p.onClick}
      dangerouslySetInnerHTML={{ __html: p.innerHtml }}
    />
  );
}

function ExpandedMonthGrid({ cells, bars }: { cells: HomeCalExpandedCellProps[]; bars: HomeCalExpandedBarProps[] }) {
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <>
      <div class="calendar-grid home-cal-weekday-row">
        {WEEKDAY_NAMES.map((d) => <div key={d} class="home-cal-weekday">{d}</div>)}
      </div>
      <div class="calendar-grid calendar-days" id="homeCalDaysGrid">
        {cells.map((c) => (
          <div key={c.cellKey} class={'cal-day' + (c.isOutside ? ' cal-outside' : '') + (c.isToday ? ' cal-today' : '')} style={{ minHeight: c.minHeight + 'px' }}>
            <div class="cal-day-num">{c.dayNum}</div>
          </div>
        ))}
        <div class="cal-bars-layer">
          {bars.map((b) => <ExpandedBar key={b.barKey} {...b} />)}
        </div>
      </div>
    </>
  );
}

function HomeOverdueWidget(p: HomeOverdueWidgetProps) {
  return (
    <>
      {p.alerts.map((a) => <AlertBar key={a.alertId} {...a} />)}
      {!p.expanded && p.empty ? <EmptyOverdue /> : null}
      {!p.expanded && !p.empty ? <CompactMiniMonth headLabel={p.compactHeadLabel || ''} cells={p.compactCells || []} /> : null}
      {p.expanded ? <ExpandedMonthGrid cells={p.expandedCells || []} bars={p.expandedBars || []} /> : null}
    </>
  );
}

export function renderHomeOverdueWidgetInto(container: HTMLElement, props: HomeOverdueWidgetProps): void {
  render(<HomeOverdueWidget {...props} />, container);
}
