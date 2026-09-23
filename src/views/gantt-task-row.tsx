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
import { readableTextColor } from '../utils/color';

export interface TaskRowPillProps {
  label: string;
  // A leading fold-state glyph ('▸'/'▾'), rendered bigger than `label` (see
  // .task-row-pill-chev) — only the Job column's phase/sub-phase toggle
  // pills carry one.
  chevron?: string;
  title: string;
  // Two mutually exclusive looks:
  //  - Chip (Task column's own pill, matches its Board column color — see
  //    taskPillColors() in gantt.ts): set `background` (+ optional
  //    `color`, else picked for contrast against it).
  //  - Bare (Job column's job-name/phase/sub-phase labels): leave
  //    `background` unset, set `colorLight`/`colorDark` instead (exact
  //    per-theme answers from rowLabelColors() in gantt.ts — a plain
  //    `body.dark-mode` CSS rule picks the right one, since toggling dark
  //    mode doesn't re-render an already-open row).
  background?: string;
  color?: string;
  colorLight?: string;
  colorDark?: string;
  focused?: boolean;
  onClick?: (e: MouseEvent) => void;
}

export interface TaskRowProps {
  rowKey: string;
  jobId: string;
  taskId: string;
  className: string;
  title: string;
  // Merged "Mar 3–7" range — a single column now, not separate start/finish.
  dateStr: string;
  // Between Date and Job: a pill (same look as the phase/sub-phase pills
  // below) carrying a real leaf row's own task name, or — on a
  // folded/merged row, which spans many real tasks at once — gantt.ts's
  // best guess at "which task this job is currently in" (see
  // findCurrentTask()). Always clickable when non-null: isolates the
  // Gantt to that task's own board-column stage across every job (see
  // ganttFocusedTaskColumnId/toggleGanttTaskFocus()). null when there's
  // no dated task to point at (e.g. an empty phase).
  taskPill: TaskRowPillProps | null;
  // Always the job's own name now, on every row regardless of fold state —
  // a stable anchor since rows from different jobs interleave by date
  // (Tasks view sorts purely by start date, not grouped by job/phase).
  // Plain text in the job's own (contrast-adjusted) color, same treatment
  // as the on-bar job tag (.task-bar-job-tag) — see mainLabelColorLight/
  // Dark's own comment on TaskRowPillProps.colorLight for why there are
  // two.
  mainLabel: string;
  mainLabelColorLight: string;
  mainLabelColorDark: string;
  mainLabelClickable?: boolean;
  mainLabelFocused?: boolean;
  onMainLabelClick?: () => void;
  hasNote: boolean;
  // Trailing inline after the job name, left to right: a phase pill (only
  // when the phase has 2+ real sub-phases) and a sub-phase pill (unless
  // this row is itself a whole-phase-collapsed row). Empty array when
  // neither applies. Same trailing-pill placement the original design
  // used, before a detour through a separate right-hand lane.
  pills: TaskRowPillProps[];
  onOpen: () => void;
}

function TaskRowPill({ pill }: { pill: TaskRowPillProps }) {
  const chip = pill.background !== undefined;
  const style = chip
    ? { background: pill.background, color: pill.color || readableTextColor(pill.background as string) }
    : { '--rp-light': pill.colorLight, '--rp-dark': pill.colorDark } as Record<string, string | undefined>;
  return (
    <span
      class={'task-row-pill' + (chip ? '' : ' bare') + (pill.onClick ? ' collapsible' : '') + (pill.focused ? ' focused' : '')}
      title={pill.title}
      style={style}
      onClick={pill.onClick}
    >
      {pill.chevron ? <span class="task-row-pill-chev">{pill.chevron}</span> : null}{pill.label}
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
      <div class="col col-task">
        {props.taskPill ? <TaskRowPill pill={props.taskPill} /> : null}
      </div>
      <div class="col col-jobs">
        {props.mainLabel ? (
          <span
            class={'task-row-name' + (props.mainLabelClickable ? ' clickable' : '') + (props.mainLabelFocused ? ' focused' : '')}
            style={{ '--jn-light': props.mainLabelColorLight, '--jn-dark': props.mainLabelColorDark } as Record<string, string>}
            title={props.mainLabel + (props.mainLabelClickable ? (props.mainLabelFocused ? '\nClick to show every job again' : '\nClick to show only this job — every task') : '')}
            onClick={props.onMainLabelClick ? (e) => { e.stopPropagation(); props.onMainLabelClick!(); } : undefined}
          >
            {props.mainLabel}
          </span>
        ) : null}
        {' '}
        {props.pills.map((p, i) => <TaskRowPill key={i} pill={p} />)}
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
