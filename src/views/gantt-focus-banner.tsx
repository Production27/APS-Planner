// Gantt's "Showing only <job> — Show all" focus banner (#ganttJobFocusBanner)
// — the second Preact-rendered piece of the app (see
// src/views/gantt-date-header.tsx for the first one and the general
// "is this element's DOM exclusively ours" safety criterion). Confirmed
// nothing else in src/ ever reads or writes #ganttJobFocusBanner's
// content, so it's safe the same way #timelineHeader was.
import { render } from 'preact';

interface GanttFocusBannerProps {
  visible: boolean;
  jobName: string | null;
  onShowAll: () => void;
}

function GanttFocusBanner({ visible, jobName, onShowAll }: GanttFocusBannerProps) {
  if (!visible) return null;
  if (jobName) {
    return (
      <>
        Showing only <b>{jobName}</b> <button type="button" onClick={onShowAll}>Show all</button>
      </>
    );
  }
  return <span class="gantt-job-focus-hint">Click a job name to isolate it</span>;
}

export function renderFocusBannerInto(container: HTMLElement, visible: boolean, jobName: string | null, onShowAll: () => void): void {
  container.style.display = visible ? 'flex' : 'none';
  render(<GanttFocusBanner visible={visible} jobName={jobName} onShowAll={onShowAll} />, container);
}
