// Gantt's "Showing only <job/task> — Show all" focus banner
// (#ganttJobFocusBanner) — the second Preact-rendered piece of the app
// (see src/views/gantt-date-header.tsx for the first one and the general
// "is this element's DOM exclusively ours" safety criterion). Confirmed
// nothing else in src/ ever reads or writes #ganttJobFocusBanner's
// content, so it's safe the same way #timelineHeader was.
//
// Covers BOTH focus axes gantt.ts supports (ganttFocusedJobId and
// ganttFocusedTaskColumnId) with the same one banner slot — they're kept
// mutually exclusive (see setGanttTaskFocus()'s own comment), so at most
// one of jobName/taskLabel is ever non-null at a time.
import { render } from 'preact';

interface GanttFocusBannerProps {
  visible: boolean;
  jobName: string | null;
  taskLabel: string | null;
  onShowAll: () => void;
}

function GanttFocusBanner({ visible, jobName, taskLabel, onShowAll }: GanttFocusBannerProps) {
  if (!visible) return null;
  if (jobName) {
    return (
      <>
        Showing only <b>{jobName}</b> <button type="button" onClick={onShowAll}>Show all</button>
      </>
    );
  }
  if (taskLabel) {
    return (
      <>
        Showing only <b>{taskLabel}</b> — every job <button type="button" onClick={onShowAll}>Show all</button>
      </>
    );
  }
  return <span class="gantt-job-focus-hint">Click a job or task name to isolate it</span>;
}

export function renderFocusBannerInto(container: HTMLElement, visible: boolean, jobName: string | null, taskLabel: string | null, onShowAll: () => void): void {
  container.style.display = visible ? 'flex' : 'none';
  render(<GanttFocusBanner visible={visible} jobName={jobName} taskLabel={taskLabel} onShowAll={onShowAll} />, container);
}
