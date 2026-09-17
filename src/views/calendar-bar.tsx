import { render } from 'preact';

// Calendar event bars — month view's #calendarDays > .cal-bars-layer (see
// renderMonthCalendar() in calendar.ts), the most complex/interactive
// piece of the Calendar, same role Gantt's task bars and Board's cards
// played for their own views.
//
// Unlike Gantt/Board, this one needed NO handler-rewiring at all: every
// bar interaction (click, mousedown-drag, keyboard activation) is wired
// via true event delegation — initCalendarDragHandlers() (calendar.ts)
// attaches mousedown/keydown ONCE on the persistent #calendarDays, and
// resolveCalBarTarget()/handleCalBarMouseDown() find their target via
// e.target.closest('.cal-event-bar')/.dataset, never a per-element
// listener or a captured DOM reference. As long as this component's
// markup carries the exact same classes and data-cal-* attributes the
// pre-Preact version did, that whole delegated system keeps working
// completely unchanged — this file only had to reproduce the STATIC
// markup, not any event wiring.
//
// The live mousedown-drag itself (applyCalBarMouseMove, in calendar.ts)
// still mutates a found bar's style.left/width directly, exactly like
// Gantt's bars — safe under Preact for the same reason: calDragState is
// one of the state vars isBusyEditing() (src/sync/connection.ts) checks,
// so no render ever runs while a drag is in progress, and the next real
// render (on drop) recomputes left/width from the just-updated
// task.start/finish anyway.

export interface CalBarSegmentBlock {
  key: string;
  left: number;
  width: number;
  background: string;
}

export interface CalBarContent {
  kind: 'flag' | 'timed' | 'plain';
  timeLabel: string | null;
  linkGlyph: boolean;
  text: string;
  tagLabel: string | null;
  tagBackground: string;
}

export interface CalBarProps {
  barKey: string;
  className: string;
  left: number;
  top: number;
  width: number;
  height: number;
  dotColor: string | null;
  background: string | null;
  color: string | null;
  border: string | null;
  title: string;
  jobId: string;
  taskId: string;
  phaseId: string;
  subPhaseId: string;
  linked: boolean;
  segStart: boolean;
  segEnd: boolean;
  taskStart: string;
  taskFinish: string;
  dragHandles: boolean;
  segments: CalBarSegmentBlock[];
  content: CalBarContent;
}

function CalBarContentView({ c }: { c: CalBarContent }) {
  if (c.kind === 'flag') return <>🚩</>;
  if (c.kind === 'timed') {
    return <>{c.timeLabel ? <span class="cal-event-time">{c.timeLabel}</span> : null}{c.text}</>;
  }
  return (
    <>
      {c.linkGlyph ? '🔗 ' : ''}{c.text}
      {c.tagLabel ? <span class="cal-jobname-tag" style={{ background: c.tagBackground }}>{c.tagLabel}</span> : null}
    </>
  );
}

function CalBar(p: CalBarProps) {
  const hasBlocks = p.segments.length > 0;
  const style: Record<string, string> = {
    left: p.left + 'px', top: p.top + 'px', width: p.width + 'px', height: p.height + 'px',
  };
  if (p.dotColor) style['--dot-color'] = p.dotColor;
  if (p.background) style.background = p.background;
  if (p.color) style.color = p.color;
  if (p.border) style.border = p.border;
  return (
    <div
      class={p.className}
      style={style}
      tabIndex={0}
      role="button"
      title={p.title}
      data-cal-job-id={p.jobId}
      data-cal-task-id={p.taskId}
      data-cal-phase-id={p.phaseId}
      data-cal-sub-phase-id={p.subPhaseId}
      data-cal-linked={p.linked ? '1' : ''}
      data-cal-seg-start={String(p.segStart)}
      data-cal-seg-end={String(p.segEnd)}
      data-cal-task-start={p.taskStart}
      data-cal-task-finish={p.taskFinish}
    >
      {p.dragHandles ? (
        <>
          <div class="cal-bar-drag-left" data-drag="left" />
          <div class="cal-bar-drag-body" data-drag="move" />
          <div class="cal-bar-drag-right" data-drag="right" />
        </>
      ) : null}
      {p.segments.map((s) => <div key={s.key} class="cal-bar-segment" style={{ left: s.left + 'px', width: s.width + 'px', background: s.background }} />)}
      {hasBlocks ? <span class="cal-bar-content"><CalBarContentView c={p.content} /></span> : <CalBarContentView c={p.content} />}
    </div>
  );
}

function CalBarsList({ bars }: { bars: CalBarProps[] }) {
  return <>{bars.map((b) => <CalBar key={b.barKey} {...b} />)}</>;
}

export function renderCalBarsInto(container: HTMLElement, bars: CalBarProps[]): void {
  render(<CalBarsList bars={bars} />, container);
}
