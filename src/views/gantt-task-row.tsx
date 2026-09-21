// Gantt's left-panel task rows (#leftBody) — the third Preact-rendered
// piece, and the first one that shares its animation identity with the
// hand-rolled reorder-animation system (captureBarTopsByRowKey()/
// animateReorderedBars() in gantt.ts — see rowKey's own comment there).
//
// Deliberately a PURE presentational component with no ambient-global
// reads of its own (no ganttViewMode/collapsedPhaseIds/ganttFocusedJobId/
// etc.) — every per-row decision that depends on that state is resolved
// in gantt.ts's renderLeftPanelRows() into a plain props object first, kept
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
  // Leading chevron character (▸ folded / ▾ expanded) — plain text, never
  // its own click target, so the two-hotspot leaf case (below) still
  // reads left-to-right as one pill.
  glyph: string;
  label: string;
  title: string;
  background: string;
  focused?: boolean;
  onClick?: (e: MouseEvent) => void;
  // Leaf-task pill only: `label` (the task's own name) is a second,
  // independent hotspot from onClick (which folds this row back into its
  // sub-phase) — clicking it isolates the Gantt to this task's own
  // BOARD_COLUMNS stage across every job, same feature the row's main
  // label used to carry back when it showed the task name instead of the
  // job name. See gantt.ts's ganttFocusedTaskColumnId/toggleGanttTaskFocus().
  labelClickable?: boolean;
  labelFocused?: boolean;
  labelTitle?: string;
  onLabelClick?: () => void;
}

export interface TaskRowProps {
  rowKey: string;
  jobId: string;
  taskId: string;
  className: string;
  title: string;
  // Merged "Mar 3–7" range — a single column now, not separate start/finish.
  dateStr: string;
  // Always the job's own name now, on every row regardless of fold state —
  // a stable anchor since rows from different jobs interleave by date
  // (Tasks view sorts purely by start date, not grouped by job/phase). The
  // phase/sub-phase/task specifics that used to share this label instead
  // live in `pill` below.
  mainLabel: string;
  mainLabelClickable?: boolean;
  mainLabelFocused?: boolean;
  onMainLabelClick?: () => void;
  hasNote: boolean;
  // Exactly one pill per row, always — never stacked. Whatever's specific
  // to this row (phase name, sub-phase name, or the task's own name once
  // fully expanded) lives here instead of stacking alongside a job pill.
  pill: TaskRowPillProps | null;
  onOpen: () => void;
}

function TaskRowPill({ pill }: { pill: TaskRowPillProps }) {
  const label = pill.labelClickable ? (
    <span
      class={'pill-label' + (pill.labelFocused ? ' focused' : '')}
      title={pill.labelTitle}
      onClick={(e: MouseEvent) => { e.stopPropagation(); pill.onLabelClick!(); }}
    >
      {pill.label}
    </span>
  ) : pill.label;
  return (
    <span
      class={'task-row-lane-pill' + (pill.onClick ? ' collapsible' : '') + (pill.focused ? ' focused' : '')}
      title={pill.title}
      style={{ background: pill.background }}
      onClick={pill.onClick}
    >
      {pill.glyph}{pill.glyph ? ' ' : ''}{label}
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
      <div class="col col-date">{props.dateStr}</div>
      <div class="col col-jobs">
        {props.mainLabel ? (
          <span
            class={'task-row-name' + (props.mainLabelClickable ? ' clickable' : '') + (props.mainLabelFocused ? ' focused' : '')}
            title={props.mainLabelClickable ? (props.mainLabelFocused ? 'Click to show every job again' : 'Click to show only ' + props.mainLabel + ' — every task') : undefined}
            onClick={props.onMainLabelClick ? (e) => { e.stopPropagation(); props.onMainLabelClick!(); } : undefined}
          >
            {props.mainLabel}
          </span>
        ) : null}
        {props.hasNote ? <span class="note-dot" title="Has notes"></span> : null}
      </div>
      <div class="lane">
        {props.pill ? <TaskRowPill pill={props.pill} /> : null}
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
