import { render } from 'preact';

// Timeline-bar content for the Gantt's barsLayer sub-container (see
// gantt.ts's setupDateRangeAndGrid()). This is the highest-interactivity
// piece Preact-ized so far: bars/segments/due-markers are individually
// draggable and resizable via a hand-rolled mousedown/mousemove system
// (startBarMove/startBarResizeLeft/startBarResizeRight/startTickResize in
// gantt.ts) that mutates `.style.left/width` directly on the real DOM node
// for the whole duration of a gesture, and a separate FLIP-style reorder
// animation (captureBarTopsByRowKey/animateReorderedBars) that reads/writes
// `.style.transform` on every element carrying a `data-row-key`.
//
// Both of those systems are safe to hand these nodes to Preact for the
// same two reasons already proven out for the task rows (see
// gantt-task-row.tsx):
//   1. They match elements by CSS class + `data-*` attributes (rowKey,
//      origLeft, jobId/phaseId/subPhaseId), never by DOM node identity —
//      so it doesn't matter which system created the node.
//   2. isBusyEditing() (src/sync/connection.ts) blocks every render — local
//      or remote-triggered — for as long as any drag/resize is in
//      progress, so Preact's diff never runs while a gesture is live-
//      mutating an element's style. The mutated value is simply stale to
//      Preact's own bookkeeping until the NEXT real render (on drop),
//      which already recomputes left/width from the authoritative,
//      just-updated task dates and corrects it — exactly what the old
//      full-rebuild-every-render code already did, node reuse or not.
//
// Every class name and data-* attribute below is copied verbatim from the
// pre-Preact imperative version so those two systems, plus jobBarMap/
// drawConnectorLines/redrawConnectorLinesLive, keep working unchanged.

export interface BarTagData {
  label: string;
  title: string;
  background: string;
  focused: boolean;
  // Mirrors the original's `isTasksMode || entry.collapsible` / `entry.collapsible`
  // gate: when true, the tag is clickable (gets the 'collapsible' class,
  // stopPropagation on mousedown, and its own click handler); when false
  // it's a plain inert label, exactly like the original's un-wired branch.
  onClick?: () => void;
}

function BarTag({ tag }: { tag: BarTagData }) {
  const interactive = !!tag.onClick;
  return (
    <span
      class={'task-bar-job-tag' + (interactive ? ' collapsible' : '') + (tag.focused ? ' focused' : '')}
      style={{ background: tag.background }}
      title={tag.title}
      onMouseDown={interactive ? (e: MouseEvent) => e.stopPropagation() : undefined}
      onClick={interactive ? (e: MouseEvent) => { e.stopPropagation(); tag.onClick!(); } : undefined}
    >{tag.label}</span>
  );
}

export interface ResizeHandles {
  onLeftDown: (e: MouseEvent) => void;
  onRightDown: (e: MouseEvent) => void;
}

export interface PlainBarProps {
  kind: 'plain';
  rowKey: string;
  className: string;
  left: number;
  width: number;
  top: number;
  background?: string;
  border?: string;
  isFlag: boolean;
  jobTag?: BarTagData;
  subTags?: BarTagData[];
  onMouseEnter: (e: MouseEvent) => void;
  onMouseLeave: () => void;
  onMouseMove: (e: MouseEvent) => void;
  // Takes the triggering event (mouse OR keyboard) so the "was this a
  // drag, not a click" check can read `.dataset.dragged` off
  // `e.currentTarget` — always the exact element the listener is bound
  // to, per native DOM semantics, regardless of which system (Preact or
  // the old imperative code) created it. See startBarMove()'s own
  // `dataset.dragged` handling in gantt.ts for the other half of this.
  onOpen: (e: MouseEvent | KeyboardEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  resizeHandles?: ResizeHandles;
  barRef: (el: HTMLDivElement | null) => void;
}

function PlainTaskBar(p: PlainBarProps) {
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(e); } };
  return (
    <div
      ref={p.barRef}
      class={p.className}
      data-row-key={p.rowKey}
      data-dragged="false"
      style={{ left: p.left + 'px', width: p.width + 'px', top: p.top + 'px', background: p.background, border: p.border }}
      tabIndex={0}
      role="button"
      onMouseEnter={p.onMouseEnter}
      onMouseLeave={p.onMouseLeave}
      onMouseMove={p.onMouseMove}
      onClick={p.onOpen}
      onKeyDown={onKeyDown}
      onMouseDown={p.onMouseDown}
    >
      {p.isFlag ? '🚩' : null}
      {p.jobTag ? <BarTag tag={p.jobTag} /> : null}
      {p.subTags ? p.subTags.map((t, i) => <BarTag key={i} tag={t} />) : null}
      {p.resizeHandles ? (
        <>
          <div class="task-bar-resize-handle task-bar-resize-handle-left" title="Drag to change start date"
            onMouseDown={p.resizeHandles.onLeftDown} onClick={(e: MouseEvent) => e.stopPropagation()} />
          <div class="task-bar-resize-handle task-bar-resize-handle-right" title="Drag to change finish date"
            onMouseDown={p.resizeHandles.onRightDown} onClick={(e: MouseEvent) => e.stopPropagation()} />
        </>
      ) : null}
    </div>
  );
}

export interface JobSpanTickData {
  domKey: string;
  jobId: string;
  phaseId: string;
  subPhaseId: string;
  taskId: string;
  rowKey: string;
  origLeft: number;
  left: number;
  top: number;
  title: string;
  cursorDefault: boolean;
  onMouseDown?: (e: MouseEvent) => void;
}

function JobSpanTick(t: JobSpanTickData) {
  return (
    <div
      class="job-span-task-tick"
      data-job-id={t.jobId}
      data-phase-id={t.phaseId}
      data-sub-phase-id={t.subPhaseId}
      data-task-id={t.taskId}
      data-row-key={t.rowKey}
      data-orig-left={t.origLeft}
      style={{ left: t.left + 'px', top: t.top + 'px', cursor: t.cursorDefault ? 'default' : undefined }}
      title={t.title}
      onMouseDown={t.onMouseDown}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    />
  );
}

export interface JobSpanSegmentData {
  domKey: string;
  kind: 'hash' | 'solid' | 'hatch';
  jobId: string;
  phaseId: string;
  subPhaseId: string;
  rowKey: string;
  origLeft: number;
  left: number;
  width: number;
  top: number;
  title: string;
  background?: string;
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: () => void;
  onMouseMove?: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  onOpen?: (e: MouseEvent | KeyboardEvent) => void;
}

function JobSpanSegment(s: JobSpanSegmentData) {
  const cls = s.kind === 'hash' ? 'job-span-gap-hash' : s.kind === 'solid' ? 'job-span-task-solid' : 'job-span-task-hatch';
  const isSolid = s.kind === 'solid';
  const onKeyDown = isSolid
    ? (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.onOpen && s.onOpen(e); } }
    : undefined;
  return (
    <div
      class={cls}
      data-job-id={s.jobId}
      data-phase-id={s.phaseId}
      data-sub-phase-id={s.subPhaseId}
      data-row-key={s.rowKey}
      data-orig-left={s.origLeft}
      data-dragged={isSolid ? 'false' : undefined}
      style={{ left: s.left + 'px', width: s.width + 'px', top: s.top + 'px', background: s.background }}
      title={s.title}
      tabIndex={isSolid ? 0 : undefined}
      role={isSolid ? 'button' : undefined}
      onMouseEnter={s.onMouseEnter}
      onMouseLeave={s.onMouseLeave}
      onMouseMove={s.onMouseMove}
      onMouseDown={s.onMouseDown}
      onClick={s.onOpen}
      onKeyDown={onKeyDown}
    />
  );
}

export interface JobSpanDueData {
  left: number;
  top: number;
  background: string;
  title: string;
  onMouseEnter: (e: MouseEvent) => void;
  onMouseLeave: () => void;
  onMouseMove: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  onClick: (e: MouseEvent | KeyboardEvent) => void;
  line?: { left: number; width: number; top: number; background: string };
}

export interface JobSpanBarProps {
  kind: 'jobspan';
  rowKey: string;
  jobId: string;
  phaseId: string;
  subPhaseId: string;
  linkedRef: boolean;
  finished: boolean;
  milestone: boolean;
  left: number;
  width: number;
  top: number;
  labelWrap: { jobTag: BarTagData; subTags: BarTagData[] };
  borderColor: string;
  due?: JobSpanDueData;
  onOpen: (e: MouseEvent | KeyboardEvent) => void;
  onMouseEnter: (e: MouseEvent) => void;
  onMouseLeave: () => void;
  onMouseMove: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
  barRef: (el: HTMLDivElement | null) => void;
  ticks: JobSpanTickData[];
  segments: JobSpanSegmentData[];
}

function JobSpanBarGroup(p: JobSpanBarProps) {
  const onBarKeyDown = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(e); } };
  const onDueKeyDown = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.due!.onClick(e); } };
  return (
    <>
      <div
        class={'job-span-name-wrap' + (p.linkedRef ? ' linked-ref' : '')}
        data-job-id={p.jobId} data-phase-id={p.phaseId} data-sub-phase-id={p.subPhaseId}
        data-row-key={p.rowKey} data-orig-left={p.left}
        style={{ left: p.left + 'px', width: p.width + 'px', top: p.top + 'px' }}
      >
        <BarTag tag={p.labelWrap.jobTag} />
        {p.labelWrap.subTags.map((t, i) => <BarTag key={i} tag={t} />)}
      </div>
      <div
        class={'job-span-border' + (p.linkedRef ? ' linked-ref' : '')}
        data-job-id={p.jobId} data-phase-id={p.phaseId} data-sub-phase-id={p.subPhaseId}
        data-row-key={p.rowKey} data-orig-left={p.left}
        style={{ left: p.left + 'px', width: p.width + 'px', top: p.top + 'px', borderColor: p.borderColor }}
      />
      {p.due ? (
        <div
          class={'job-span-due-marker' + (p.linkedRef ? ' linked-ref' : '')}
          data-job-id={p.jobId} data-dragged="false" data-row-key={p.rowKey}
          style={{ left: p.due.left + 'px', top: p.due.top + 'px', background: p.due.background }}
          title={p.due.title} tabIndex={0} role="button"
          onMouseEnter={p.due.onMouseEnter} onMouseLeave={p.due.onMouseLeave} onMouseMove={p.due.onMouseMove}
          onMouseDown={p.due.onMouseDown} onClick={p.due.onClick} onKeyDown={onDueKeyDown}
        >🚩</div>
      ) : null}
      {p.due && p.due.line ? (
        <div
          class="job-span-due-line" data-job-id={p.jobId} data-row-key={p.rowKey + '::centerline'}
          style={{ left: p.due.line.left + 'px', width: p.due.line.width + 'px', top: p.due.line.top + 'px', background: p.due.line.background }}
        />
      ) : null}
      <div
        ref={p.barRef}
        class={'task-bar job-span-bar' + (p.finished ? ' finished' : '') + (p.milestone ? ' milestone' : '') + (p.linkedRef ? ' linked-ref' : '')}
        data-dragged="false" data-row-key={p.rowKey}
        style={{ left: p.left + 'px', width: p.width + 'px', top: p.top + 'px' }}
        tabIndex={0} role="button"
        onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave} onMouseMove={p.onMouseMove}
        onClick={p.onOpen} onKeyDown={onBarKeyDown} onMouseDown={p.onMouseDown}
      />
      {p.ticks.map((t) => <JobSpanTick key={t.domKey} {...t} />)}
      {p.segments.map((s) => <JobSpanSegment key={s.domKey} {...s} />)}
    </>
  );
}

export type TaskBarEntryProps = PlainBarProps | JobSpanBarProps;

function TaskBarsList({ entries }: { entries: TaskBarEntryProps[] }) {
  return (
    <>
      {entries.map((e) => e.kind === 'plain' ? <PlainTaskBar key={e.rowKey} {...e} /> : <JobSpanBarGroup key={e.rowKey} {...e} />)}
    </>
  );
}

export function renderTimelineBarsInto(container: HTMLElement, entries: TaskBarEntryProps[]): void {
  render(<TaskBarsList entries={entries} />, container);
}
