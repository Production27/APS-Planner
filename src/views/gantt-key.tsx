// Gantt "Key" panel (#ganttKeyPanel, opened by #ganttKeyBtn in the
// toolbar) — explains what each color, pattern and marker on the timeline
// means. Built fresh on every open so the stage swatches always match the
// Board's current columns and colors (a task's color always mirrors its
// board column — see normalizeTasksToColumns() in src/core/jobs.ts — and a
// column with no color of its own falls back to the job's color).
//
// Every swatch reuses the exact recipe the timeline itself draws with
// (softenColor() fills, the 45° two-color overlap hatch, the accent-ringed
// due circle) so the key can't drift into describing a different look.
import { render } from 'preact';
import { softenColor } from '../utils/color';

const HATCH_A = '#4dd0e1';
const HATCH_B = '#ffb74d';

function hatch(a: string, b: string): string {
  const s = 6;
  return 'repeating-linear-gradient(45deg, ' + a + ' 0px, ' + a + ' ' + s + 'px, ' + b + ' ' + s + 'px, ' + b + ' ' + (2 * s) + 'px)';
}

interface KeyRow {
  swatch: preact.JSX.Element;
  label: preact.JSX.Element | string;
}

function Row({ swatch, label }: KeyRow) {
  return (
    <li class="gantt-key-row">
      <span class="gantt-key-swatch-cell" aria-hidden="true">{swatch}</span>
      <span class="gantt-key-label">{label}</span>
    </li>
  );
}

function GanttKey({ onClose }: { onClose: () => void }) {
  const cols = (typeof BOARD_COLUMNS !== 'undefined' && BOARD_COLUMNS) || [];
  const colored = cols.filter((c) => !!c.color);
  const uncolored = cols.filter((c) => !c.color);

  const barRows: KeyRow[] = [
    {
      swatch: <span class="gantt-key-sw gantt-key-sw-outline" />,
      label: <>An <b>outline</b> in the job's color marks a job or phase shown as one bar. Click ▸ next to its name, or Expand All, to see its tasks one per row.</>,
    },
    {
      swatch: <span class="gantt-key-sw" style={{ background: hatch(softenColor(HATCH_A), softenColor(HATCH_B)) }} />,
      label: <><b>Stripes</b> mean two or more tasks are scheduled on the same days.</>,
    },
    {
      swatch: (
        <span class="gantt-key-sw gantt-key-sw-outline gantt-key-sw-gap">
          <span style={{ background: softenColor(HATCH_A) }} />
          <span />
          <span style={{ background: softenColor(HATCH_B) }} />
        </span>
      ),
      label: <>An <b>empty stretch</b> inside an outline means no task is scheduled on those days.</>,
    },
    {
      swatch: <span class="gantt-key-sw gantt-key-sw-tick" style={{ background: softenColor(HATCH_A) }}><span /></span>,
      label: <>A <b>white tick</b> is where one task ends. Drag it to change that task's finish date.</>,
    },
    {
      swatch: <span class="gantt-key-sw-due">🚩</span>,
      label: <>A <b>circle with a red ring</b> is the job's due date. Drag it to move the date.</>,
    },
    {
      swatch: <span class="gantt-key-sw-connector" />,
      label: <>A <b>line between bars</b>, in the job's color, joins bars that belong to the same job.</>,
    },
    {
      swatch: <span class="gantt-key-sw gantt-key-sw-linked" style={{ background: softenColor(HATCH_A) }}>🔗</span>,
      label: <>A <b>faded, dashed bar</b> with 🔗 is a job linked from another project. It's read-only; click it to go there.</>,
    },
    {
      swatch: <span class="gantt-key-sw-focus">Job</span>,
      label: <>A <b>dashed box</b> around a name means only that job or task is shown. Click it again to show everything.</>,
    },
  ];

  const timelineRows: KeyRow[] = [
    {
      swatch: <span class="gantt-key-sw-today" />,
      label: <>The <b>red line</b> is today. Days after today have a light red tint.</>,
    },
    {
      swatch: <span class="gantt-key-sw gantt-key-sw-weekend" />,
      label: <><b>Gray dates</b> in the header are Saturdays and Sundays.</>,
    },
  ];

  return (
    <>
      <div class="gantt-key-head">
        <h3 id="ganttKeyTitle">Key</h3>
        <button type="button" class="gantt-key-close" aria-label="Close key" title="Close" onClick={onClose}>×</button>
      </div>

      <h4>Task colors</h4>
      <p class="gantt-key-note">Each task takes the color of its Board stage.</p>
      {colored.length ? (
        <ul class="gantt-key-stages">
          {colored.map((c) => (
            <li key={c.id}>
              <span class="gantt-key-sw gantt-key-sw-stage" style={{ background: softenColor(c.color) }} aria-hidden="true" />
              {c.label}
            </li>
          ))}
        </ul>
      ) : null}
      {uncolored.length ? (
        <p class="gantt-key-note">
          {colored.length ? <>{uncolored.map((c) => c.label).join(', ')} {uncolored.length === 1 ? 'has' : 'have'} no color set, so {uncolored.length === 1 ? 'it uses' : 'they use'} the job's color.</> : <>No stage has a color set, so tasks use the job's color.</>}
          {' '}Set a stage's color from its menu on the Board.
        </p>
      ) : null}

      <h4>On the bars</h4>
      <ul class="gantt-key-list">{barRows.map((r, i) => <Row key={i} {...r} />)}</ul>

      <h4>Timeline</h4>
      <ul class="gantt-key-list">{timelineRows.map((r, i) => <Row key={i} {...r} />)}</ul>
    </>
  );
}

function panel(): HTMLElement { return document.getElementById('ganttKeyPanel')!; }
function button(): HTMLElement { return document.getElementById('ganttKeyBtn')!; }

export function isGanttKeyOpen(): boolean {
  return !panel().hidden;
}

export function closeGanttKey(returnFocus?: boolean): void {
  const p = panel();
  if (p.hidden) return;
  p.hidden = true;
  button().setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onOutsidePointer, true);
  document.removeEventListener('keydown', onKeyDown, true);
  if (returnFocus) button().focus();
}

export function openGanttKey(): void {
  const p = panel();
  render(<GanttKey onClose={() => closeGanttKey(true)} />, p);
  p.hidden = false;
  button().setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', onOutsidePointer, true);
  document.addEventListener('keydown', onKeyDown, true);
  (p.querySelector('.gantt-key-close') as HTMLElement | null)?.focus();
}

export function toggleGanttKey(): void {
  if (isGanttKeyOpen()) closeGanttKey(); else openGanttKey();
}

function onOutsidePointer(e: MouseEvent): void {
  const t = e.target as Node;
  if (panel().contains(t) || button().contains(t)) return;
  closeGanttKey();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeGanttKey(true); }
}
