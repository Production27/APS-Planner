import { render } from 'preact';

// Week/day view's hourly grid (Google-Calendar style) — #weekHourLabels
// and #weekHourCols, both static, empty elements from index.html
// exclusively written to by renderWeekHourGrid() (see calendar.ts) and
// nothing else — same "safe to hand over directly, no wrapper needed"
// case as #timelineHeader was for Gantt's date header (see
// gantt-date-header.tsx's own comment), simpler even than the event bars
// (calendar-bar.tsx) since there's no shared container and no drag
// system here at all: a timed event block only ever gets opened (click
// or Enter/Space), never dragged.

export interface HourLabel {
  key: string;
  text: string;
}

function HourLabels({ labels }: { labels: HourLabel[] }) {
  return <>{labels.map((l) => <div key={l.key} class="week-hour-label"><span>{l.text}</span></div>)}</>;
}

export function renderWeekHourLabelsInto(container: HTMLElement, labels: HourLabel[]): void {
  render(<HourLabels labels={labels} />, container);
}

export interface WeekTimedEvent {
  eventKey: string;
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
  background: string;
  title: string;
  timeLabel: string | null;
  text: string;
  onOpen: (e: MouseEvent | KeyboardEvent) => void;
}

function TimedEventBlock(p: WeekTimedEvent) {
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onOpen(e); } };
  return (
    <div
      class="week-timed-event"
      style={{ top: p.top + 'px', height: p.height + 'px', left: 'calc(' + p.leftPct + '% + 2px)', width: 'calc(' + p.widthPct + '% - 4px)', background: p.background }}
      tabIndex={0}
      role="button"
      title={p.title}
      onClick={(e: MouseEvent) => { e.stopPropagation(); p.onOpen(e); }}
      onKeyDown={onKeyDown}
    >
      {p.timeLabel ? <span class="wte-time">{p.timeLabel}</span> : null}
      {p.text}
    </div>
  );
}

export interface WeekHourColumn {
  colIndex: number;
  date: string;
  nowLineTop: number | null;
  events: WeekTimedEvent[];
  onColClick: (e: MouseEvent) => void;
}

// 24 empty hour-row-lines never vary by column/date — pure decoration,
// same array reused for every column.
const HOUR_INDICES = Array.from({ length: 24 }, (_, i) => i);

function WeekHourCol(p: WeekHourColumn) {
  return (
    <div class="week-hour-col" data-col={p.colIndex} data-date={p.date} onClick={p.onColClick}>
      {HOUR_INDICES.map((h) => <div key={h} class="week-hour-row-line" />)}
      {p.events.map((ev) => <TimedEventBlock key={ev.eventKey} {...ev} />)}
      {p.nowLineTop !== null ? <div class="week-current-time-line" style={{ top: p.nowLineTop + 'px' }} /> : null}
    </div>
  );
}

function WeekHourCols({ cols }: { cols: WeekHourColumn[] }) {
  return <>{cols.map((c) => <WeekHourCol key={c.date} {...c} />)}</>;
}

export function renderWeekHourColsInto(container: HTMLElement, cols: WeekHourColumn[]): void {
  render(<WeekHourCols cols={cols} />, container);
}
