import { render } from 'preact';
import { AlertBar, type HomeAlertProps } from './home-widget-alert';

// Home dashboard's Today-schedule widget (#homeTodayBody) — a static,
// empty element from index.html exclusively written to by
// renderHomeDashboard() (see home.ts) and nothing else, same "safe to
// hand over directly, no wrapper needed" case as every other Home widget
// body. No real-DOM measurement pass needed here (unlike Overdue's
// expanded grid or the Workflow mini-board's bracket) — every bar's
// position is a plain percentage of the visible date window, computed
// straight from dates with nothing to measure.

export interface HomeMiniGanttDayProps {
  dayKey: string;
  dow: string;
  dayNum: number;
  isToday: boolean;
}

export interface HomeMiniGanttRowProps {
  rowKey: string;
  taskName: string;
  title: string;
  leftPct: number;
  widthPct: number;
  barColor: string;
  jobColor: string;
  jobName: string;
  onClick: () => void;
}

export interface HomeTodayWidgetProps {
  alert: HomeAlertProps | null;
  empty: boolean;
  emptyLabel: string;
  days: HomeMiniGanttDayProps[];
  // Fraction (0-1) of the way across the window the today-line sits —
  // NOT a percent, despite the CSS calc() below multiplying a percent by
  // it (that's the original code's own math: halfWindow/windowDays*100,
  // then divided back by 100 in the calc string — kept as a fraction here
  // rather than re-introducing that round trip).
  todayLeftFraction: number;
  rows: HomeMiniGanttRowProps[];
}

function onEnterOrSpace(fn: () => void) {
  return (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
}

function MiniGanttDay(p: HomeMiniGanttDayProps) {
  return (
    <div class={'home-mini-gantt-day' + (p.isToday ? ' today' : '')}>
      <span class="home-mini-gantt-dow">{p.dow}</span>
      <span class="home-mini-gantt-num">{p.dayNum}</span>
    </div>
  );
}

function MiniGanttRow(p: HomeMiniGanttRowProps) {
  return (
    <div class="home-mini-gantt-row" tabIndex={0} role="button" onKeyDown={onEnterOrSpace(p.onClick)} onClick={p.onClick} title={p.title}>
      <div class="home-mini-gantt-label">{p.taskName}</div>
      <div class="home-mini-gantt-track">
        <div class="home-mini-gantt-bar" style={{ left: p.leftPct + '%', width: p.widthPct + '%', background: p.barColor, borderColor: p.jobColor }}>
          <span class="home-mini-gantt-pill" style={{ background: p.jobColor }}>{p.jobName}</span>
        </div>
      </div>
    </div>
  );
}

function TodayEmpty({ label }: { label: string }) {
  return (
    <div class="home-widget-empty">
      <svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="10" height="3.5" rx="1" fill="#3949ab" /><rect x="3" y="10.2" width="16" height="3.5" rx="1" fill="#3949ab" opacity="0.75" /><rect x="3" y="16.5" width="7" height="3.5" rx="1" fill="#3949ab" opacity="0.5" /></svg>
      <div>{label}</div>
    </div>
  );
}

function HomeTodayWidget(p: HomeTodayWidgetProps) {
  return (
    <>
      {p.alert ? <AlertBar {...p.alert} /> : null}
      {p.empty ? <TodayEmpty label={p.emptyLabel} /> : (
        <div class="home-mini-gantt">
          <div class="home-mini-gantt-days">
            {p.days.map((d) => <MiniGanttDay key={d.dayKey} {...d} />)}
          </div>
          <div class="home-mini-gantt-today-line" style={{ left: 'calc(56px + (100% - 56px) * ' + p.todayLeftFraction + ')' }} />
          {p.rows.map((r) => <MiniGanttRow key={r.rowKey} {...r} />)}
        </div>
      )}
    </>
  );
}

export function renderHomeTodayWidgetInto(container: HTMLElement, props: HomeTodayWidgetProps): void {
  render(<HomeTodayWidget {...props} />, container);
}
