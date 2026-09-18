// Gantt toolbar's "Focus a task…" picker (#ganttTaskFocusPicker) — Option
// B alongside clicking a task's own name (see gantt-task-row.tsx's
// mainLabelClickable): jump straight to isolating one BOARD_COLUMNS stage
// across every job without needing a job already expanded to click on.
// Another Preact-rendered piece of the app, same "exclusively ours" DOM
// safety criterion as gantt-focus-banner.tsx.
import { render } from 'preact';

export interface TaskFocusOption {
  id: string;
  label: string;
}

interface GanttTaskFocusPickerProps {
  options: TaskFocusOption[];
  value: string | null;
  onChange: (columnId: string | null) => void;
}

function GanttTaskFocusPicker({ options, value, onChange }: GanttTaskFocusPickerProps) {
  // Nothing to pick from (every column hidden from the schedule, or none
  // defined yet) — no point showing an empty picker.
  if (!options.length) return null;
  return (
    <select
      class="gantt-task-focus-select"
      title="Show one task's bar across every job"
      value={value || ''}
      onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value || null)}
    >
      <option value="">Focus a task…</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

export function renderTaskFocusPickerInto(container: HTMLElement, options: TaskFocusOption[], value: string | null, onChange: (columnId: string | null) => void): void {
  render(<GanttTaskFocusPicker options={options} value={value} onChange={onChange} />, container);
}
