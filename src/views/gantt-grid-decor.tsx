import { Fragment, render } from 'preact';
import type { GanttDayCell } from './gantt-date-header';

// Three small, purely decorative pieces of the Gantt's #timelineGrid,
// each already living in its own dedicated sub-container (see
// setupDateRangeAndGrid()'s own comment): the background grid-lines +
// today-column tint, the per-row zebra-stripe backgrounds, and the
// today-line + its floating date label. None of these are interactive —
// converting them isn't about fixing any bug the way the task rows/bars
// conversions were, it's just the last bit of #timelineGrid's content
// still built with document.createElement() once everything riskier
// already had to move for barsLayer's sake (see gantt-task-bar.tsx).

function GridLines({ days }: { days: GanttDayCell[] }) {
  return (
    <>
      {days.map((d) => (
        <Fragment key={d.key}>
          <div class={'grid-line' + (d.isWeekend ? ' weekend-line' : '')} style={{ left: d.left + 'px' }} />
          {d.isToday ? (
            // No width set here — .today-line-bg's own CSS spans it from
            // `left` to the grid's real right edge via right:0.
            <div class="grid-line today-line-bg" style={{ left: d.left + 'px' }} />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

export function renderGridLinesInto(container: HTMLElement, days: GanttDayCell[]): void {
  render(<GridLines days={days} />, container);
}

export interface RowBgEntry {
  top: number;
}

function RowBgList({ rows, width }: { rows: RowBgEntry[]; width: number }) {
  return (
    <>
      {rows.map((r, i) => (
        // Keyed by POSITION (list index), not by row identity — this is
        // the one thing that actually matters here, not a style choice.
        // Row-bg is deliberately never given the row's own key: it's
        // pure decoration, full page width, a full 40px row tall, and
        // solidly opaque, so if it were reused/animated by ROW identity
        // the way the row/bar it sits behind is, a multi-row reorder
        // would show two of these bands sliding across the same stretch
        // of screen at once — an obvious gray "ghost" bar (this was a
        // real, reported bug — see tests/gantt-rowbg-no-ghost.spec.js).
        // A positional key means "whichever row now sits at slot N" reuses
        // slot N's own div and just gets restyled in place, never moved —
        // exactly the old imperative behavior (full rebuild, always at
        // its own final position, never animated) — and keeps the CSS
        // :nth-child zebra striping correct, since DOM order stays
        // strictly position order too.
        <div key={i} class="row-bg" style={{ top: r.top + 'px', width: width + 'px' }} />
      ))}
    </>
  );
}

export function renderRowBgInto(container: HTMLElement, rows: RowBgEntry[], width: number): void {
  render(<RowBgList rows={rows} width={width} />, container);
}

export interface TodayLineData {
  left: number;
  label: string;
}

function TodayLine({ data }: { data: TodayLineData | null }) {
  if (!data) return null;
  return (
    <>
      <div class="today-line" style={{ left: data.left + 'px' }} />
      <div class="today-label" style={{ left: (data.left + 6) + 'px' }}>{data.label}</div>
    </>
  );
}

export function renderTodayLineInto(container: HTMLElement, data: TodayLineData | null): void {
  render(<TodayLine data={data} />, container);
}
