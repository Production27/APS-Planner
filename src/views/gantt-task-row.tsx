// Gantt's left-panel task rows (#leftBody) — the third Preact-rendered
// piece, and the first one that shares its animation identity with the
// hand-rolled reorder-animation system (captureBarTopsByRowKey()/
// animateReorderedBars() in gantt.ts — see rowKey's own comment there).
//
// Deliberately a PURE presentational component with no ambient-global
// reads of its own (no ganttViewMode/collapsedPhaseIds/ganttFocusedJobId/
// etc.) — every per-row decision that depends on that state is resolved
// in gantt.ts's buildTaskRowProps() into a plain props object first, kept
// there because gantt.ts already owns all of that state. This file only
// ever answers "given these exact props, what does the row look like" —
// easier to reason about, and it means a future test of this component
// never needs the rest of the app's ambient globals wired up.
//
// Rows are keyed by their EXACT SAME rowKey the animation system already
// used (see animateReorderedBars()'s own comment on Preact reuse: this
// gives Preact a real, permanent DOM node per row across renders instead
// of the old "torn down and rebuilt fresh every time" model — the
// animation code lives outside Preact's own model of the world (it
// writes style.transform/transition directly, on whatever node currently
// has the matching data-row-key), and it's KEPT that way rather than
// rewritten into Preact refs/effects. Preact never declares a `style`
// prop on this row's own element, or on anything animateReorderedBars()
// targets by data-row-key, and it only ever manages transform/transition
// on those elements from OUTSIDE any props Preact was told about — so
// Preact's diffing has no property overlap to fight over, and reusing
// the same node across renders only helps (no more detach/reattach for a
// row that didn't structurally change, and a genuinely reordered row
// still animates via the exact same before/after position-diff technique
// as before, since that technique only depends on data-row-key matching,
// never on whether the underlying DOM node happens to be new or reused).
import { render } from 'preact';

export interface TaskRowPillProps {
  label: string;
  title: string;
  background: string;
  focused?: boolean;
  // Absent in Jobs/Leads view for a non-collapsible phase — the pill is
  // inert decoration there, same as the original's own onclick attribute
  // only ever getting attached when entry.collapsible was true. Leaving
  // this unset (rather than a no-op stopPropagation) lets the click
  // bubble up to the row's own onOpen, exactly like clicking anywhere
  // else on the row.
  onClick?: (e: MouseEvent) => void;
}

export interface TaskRowProps {
  rowKey: string;
  jobId: string;
  taskId: string;
  className: string;
  title: string;
  startStr: string;
  finishStr: string;
  mainLabel: string;
  // Set only for a real leaf task (never a job-span/due-marker pseudo-row)
  // — clicking it isolates the Gantt to just that task's BOARD_COLUMNS
  // stage across every job, mirroring jobPill's click-to-focus below but
  // on the other axis. See ganttFocusedTaskColumnId/toggleGanttTaskFocus()
  // in gantt.ts.
  mainLabelClickable?: boolean;
  mainLabelFocused?: boolean;
  onMainLabelClick?: () => void;
  hasNote: boolean;
  jobPill: TaskRowPillProps | null;
  phasePill: TaskRowPillProps | null;
  subPill: TaskRowPillProps | null;
  onOpen: () => void;
}

function TaskRowPill({ pill, extraClass }: { pill: TaskRowPillProps; extraClass: string }) {
  return (
    <span
      class={extraClass + ' collapsible' + (pill.focused ? ' focused' : '')}
      title={pill.title}
      style={{ background: pill.background }}
      onClick={pill.onClick}
    >
      {pill.label}
    </span>
  );
}

function TaskRow(props: TaskRowProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpen(); }
  };
  return (
    <div
      class={props.className}
      data-row-key={props.rowKey}
      data-job-id={props.jobId}
      data-task-id={props.taskId}
      title={props.title}
      tabIndex={0}
      role="button"
      onClick={props.onOpen}
      onKeyDown={onKeyDown}
    >
      <div class="col col-start">{props.startStr}</div>
      <div class="col col-finish">{props.finishStr}</div>
      <div class="col col-jobs">
        {props.mainLabel ? (
          <>
            <span
              class={'task-row-name' + (props.mainLabelClickable ? ' clickable' : '') + (props.mainLabelFocused ? ' focused' : '')}
              title={props.mainLabelClickable ? (props.mainLabelFocused ? 'Click to show every task again' : 'Click to show only ' + props.mainLabel + ' — every job') : undefined}
              onClick={props.onMainLabelClick ? (e) => { e.stopPropagation(); props.onMainLabelClick!(); } : undefined}
            >
              {props.mainLabel}
            </span>
            {' '}
          </>
        ) : null}
        {props.jobPill ? <TaskRowPill pill={props.jobPill} extraClass="task-row-jobname" /> : null}
        {props.phasePill ? <TaskRowPill pill={props.phasePill} extraClass="task-row-phasename" /> : null}
        {props.subPill ? <TaskRowPill pill={props.subPill} extraClass="task-row-subphasename" /> : null}
        {props.hasNote ? <span class="note-dot" title="Has notes"></span> : null}
      </div>
    </div>
  );
}

function TaskRowList({ rows, spacerHeight }: { rows: TaskRowProps[]; spacerHeight: number }) {
  return (
    <>
      {rows.map((r) => <TaskRow key={r.rowKey} {...r} />)}
      <div style={{ height: spacerHeight + 'px' }} />
    </>
  );
}

export function renderTaskRowsInto(container: HTMLElement, rows: TaskRowProps[], spacerHeight: number): void {
  render(<TaskRowList rows={rows} spacerHeight={spacerHeight} />, container);
}
