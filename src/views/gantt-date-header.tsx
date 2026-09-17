// Gantt timeline header — the day-number/day-name cells plus the
// "Week of ..." bar above them. The FIRST Preact-rendered piece of the
// app (see the comment on renderDateHeaderInto() below for why this one,
// specifically, was safe to start with).
//
// buildDateHeaderCells() is the pure data half — the exact same
// day-by-day/week-boundary math renderGantt()'s old imperative loop did,
// just producing plain data instead of DOM nodes directly. Kept here
// (not in gantt.ts) so this file has no dependency on gantt.ts at all —
// gantt.ts imports FROM here instead, passing its own showDatePopover/
// hideDatePopover/week-scroll handlers in as plain callback props, so
// there's no import cycle between the two.
import { render } from 'preact';
import { toIsoDate, getDaysDiff } from '../utils/date';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface GanttDayCell {
  key: string;
  left: number;
  width: number;
  isWeekend: boolean;
  isToday: boolean;
  dayNum: number;
  dayName: string;
  date: Date;
}

export interface GanttWeekCell {
  key: string;
  left: number;
  width: number;
  label: string;
}

export interface GanttDateHeaderCells {
  days: GanttDayCell[];
  weeks: GanttWeekCell[];
  today: Date;
}

export function buildDateHeaderCells(startDate: Date, totalDays: number, dayWidth: number): GanttDateHeaderCells {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: GanttDayCell[] = [];
  const weeks: GanttWeekCell[] = [];
  const current = new Date(startDate);
  let weekStart = new Date(current);

  for (let i = 0; i < totalDays; i++) {
    const dayLeft = i * dayWidth;
    const isWeekend = current.getDay() === 0 || current.getDay() === 6;
    const isToday = current.getTime() === today.getTime();

    days.push({
      key: toIsoDate(current),
      left: dayLeft,
      width: dayWidth,
      isWeekend,
      isToday,
      dayNum: current.getDate(),
      dayName: DAY_NAMES[current.getDay()],
      date: new Date(current),
    });

    if (current.getDay() === 6 || i === totalDays - 1) {
      const wDays = getDaysDiff(weekStart, current) + 1;
      const wLeft = getDaysDiff(startDate, weekStart) * dayWidth;
      weeks.push({
        key: toIsoDate(weekStart),
        left: wLeft,
        width: wDays * dayWidth,
        label: 'Week of ' + weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      });
      weekStart = new Date(current);
      weekStart.setDate(weekStart.getDate() + 1);
    }

    current.setDate(current.getDate() + 1);
  }

  return { days, weeks, today };
}

interface GanttDateHeaderProps {
  days: GanttDayCell[];
  weeks: GanttWeekCell[];
  onDayHover: (e: MouseEvent, date: Date) => void;
  onDayLeave: () => void;
  onWeekClick: (weekLeft: number) => void;
}

function GanttDateHeader({ days, weeks, onDayHover, onDayLeave, onWeekClick }: GanttDateHeaderProps) {
  return (
    <>
      {days.map((d) => (
        <div
          key={d.key}
          class={'day-header' + (d.isWeekend ? ' weekend' : '') + (d.isToday ? ' today-header' : '')}
          style={{ left: d.left + 'px', width: d.width + 'px' }}
          data-date={d.key}
          onClick={(e: MouseEvent) => onDayHover(e, d.date)}
          onMouseEnter={(e: MouseEvent) => onDayHover(e, d.date)}
          onMouseLeave={onDayLeave}
        >
          <span class="day-num">{d.dayNum}</span>
          <span class="day-name">{d.dayName}</span>
        </div>
      ))}
      {weeks.map((w) => (
        <div
          key={w.key}
          class="week-header"
          style={{ left: w.left + 'px', width: w.width + 'px' }}
          data-week-start={w.key}
          onClick={() => onWeekClick(w.left)}
        >
          {w.label}
        </div>
      ))}
    </>
  );
}

// header is #timelineHeader — never written to by any OTHER function
// (setHeaderScroll() only ever touches its own style.transform, not its
// children) — the one part of the Gantt rendering pipeline with no other
// imperative code sharing ownership of its children, which is exactly
// what made it safe to hand the whole subtree to Preact FIRST, before
// anything else. Everything else Preact now owns (#leftBody's task rows,
// #timelineGrid's grid-lines/row-bg/today-line/bars — see
// gantt-task-row.tsx/gantt-grid-decor.tsx/gantt-task-bar.tsx) followed the
// same rule once it got its own dedicated, exclusively-Preact-owned
// sub-container (see getOrCreateGanttGridLayers() in gantt.ts). Only the
// connector-line SVG stays fully imperative — it needs direct rAF
// mutation to track the live reorder animation, which isn't a fit for
// Preact's diff-per-render model.
export function renderDateHeaderInto(
  container: HTMLElement,
  cells: GanttDateHeaderCells,
  onDayHover: (e: MouseEvent, date: Date) => void,
  onDayLeave: () => void,
  onWeekClick: (weekLeft: number) => void
): void {
  render(
    <GanttDateHeader days={cells.days} weeks={cells.weeks} onDayHover={onDayHover} onDayLeave={onDayLeave} onWeekClick={onWeekClick} />,
    container
  );
}
