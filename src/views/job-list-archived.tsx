import { render } from 'preact';

// The Archived Jobs modal's row list (#archivedJobsList in index.html) —
// a static, empty container, opened/refreshed via openArchivedJobsModal()/
// refreshArchivedJobsListIfOpen() in job-list.ts, which only toggle the
// modal's own .show class (see openModal/closeModal in utils/ui.ts), so
// the container itself is never torn down — same "safe to hand over
// directly" case as every other converted list in this app. Lower
// frequency than the main job list (only rebuilds while the modal is
// open, via archiveJob()/restoreJob()), but the same fresh-container-
// every-render cost applied here too before this conversion.
//
// data-action="restore"/"delete" are kept on the buttons even though
// nothing in this file itself reads them (onClick wires the real
// handlers directly) — unit-job-list.spec.js's own archive/restore test
// selects `#archivedJobsList [data-action="restore"]` directly, so these
// stay as a stable test hook, matching the old string-built markup.

export interface ArchivedJobRowProps {
  jobKey: string;
  name: string;
  onRestore: () => void;
  onDelete: () => void;
}

export interface ArchivedJobsListProps {
  jobs: ArchivedJobRowProps[];
}

function ArchivedJobRow(p: ArchivedJobRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--s-2-5) var(--s-3)', borderBottom: '1px solid var(--border)', gap: 'var(--s-2)' }}>
      <div style={{ minWidth: 0, fontSize: 'var(--t-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
      <div style={{ display: 'flex', gap: 'var(--s-1-5)', flexShrink: 0 }}>
        <button class="btn btn-secondary" style={{ padding: 'var(--s-1) var(--s-2-5)', fontSize: 'var(--t-sm)' }} data-action="restore" data-min-tier="editor" onClick={p.onRestore}>
          <svg viewBox="0 0 24 24" width="15" height="15" style={{ verticalAlign: '-3px', marginRight: 'var(--s-0-75)' }} xmlns="http://www.w3.org/2000/svg"><path d="M6 8H3V5" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" /><path d="M3 8a9 9 0 1 1 2 8" stroke="#3949ab" stroke-width="2" fill="none" stroke-linecap="round" /></svg>
          {' '}Restore
        </button>
        <button class="btn btn-danger" style={{ padding: 'var(--s-1) var(--s-2-5)', fontSize: 'var(--t-sm)' }} data-action="delete" data-min-tier="projectAdmin" onClick={p.onDelete}>
          <svg viewBox="0 0 24 24" width="15" height="15" style={{ verticalAlign: '-3px', marginRight: 'var(--s-0-75)' }} xmlns="http://www.w3.org/2000/svg"><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2" stroke-linecap="round" /></svg>
          {' '}Delete
        </button>
      </div>
    </div>
  );
}

function ArchivedJobsList(p: ArchivedJobsListProps) {
  if (!p.jobs.length) {
    return <div style={{ padding: 'var(--s-3-5)', color: 'var(--text-secondary)' }}>No archived jobs.</div>;
  }
  return <>{p.jobs.map((j) => <ArchivedJobRow key={j.jobKey} {...j} />)}</>;
}

export function renderArchivedJobsListInto(container: HTMLElement, props: ArchivedJobsListProps): void {
  render(<ArchivedJobsList {...props} />, container);
}
