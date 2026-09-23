// Export to spreadsheet (roadmap item A3, part 1). Builds a CSV from the
// same jobs the current user can see (getVisibleJobs(), so project-scoped
// and lead-restricted accounts only ever export what they're shown) and
// hands it to the browser as a download. CSV rather than .xlsx: Excel,
// Numbers and Google Sheets all open it directly, and it needs no library.
// A UTF-8 byte-order mark is prepended so Excel on Windows reads accented
// characters and em dashes correctly instead of as mojibake.
import type { Job, Task, BoardCard } from '../core/types';
import { getJobPhases, getPhaseSubUnits, getPhaseCard, getPrimaryPhaseCard } from '../core/models';
import { getVisibleJobs, syncCardColumns } from '../core/jobs';
import { displayNameForUsername } from './user-roster';
import { getActiveProject } from './project';
import { openModal, closeModal, showToast } from '../utils/ui';
import { toIsoDate } from '../utils/date';

type Cell = string | number | null | undefined;

// RFC 4180 quoting. Also neutralizes spreadsheet formula injection: a cell
// that starts with = + - @ (or a tab/CR) is prefixed with an apostrophe so
// Excel shows it as text instead of evaluating it — job names and notes are
// free text anyone with edit access can type.
function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: Cell[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function realTasks(tasks: Task[] | undefined): Task[] {
  return (tasks || []).filter((t) => !t.isDueMarker && !t.isJobSpan);
}

function allJobTasks(job: Job): Task[] {
  const out: Task[] = [];
  getJobPhases(job).forEach((phase) => getPhaseSubUnits(phase).forEach((sub) => out.push(...realTasks(sub.tasks))));
  return out;
}

export function validDate(s: unknown): string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Inclusive calendar days, matching how the job form's Days column counts
// a same-day task as 1.
function daysBetween(start: string, finish: string): number | '' {
  if (!start || !finish) return '';
  const ms = new Date(finish + 'T00:00:00').getTime() - new Date(start + 'T00:00:00').getTime();
  return isNaN(ms) ? '' : Math.round(ms / 86400000) + 1;
}

function stageLabel(card: BoardCard | undefined): string {
  if (!card || !card.column) return '';
  const col = BOARD_COLUMNS.find((c) => c.id === card.column);
  return col ? col.label : '';
}

function field(card: BoardCard | undefined, key: string): string {
  const v = card && card.customFields ? card.customFields[key] : undefined;
  if (Array.isArray(v)) return v.filter(Boolean).join('; ');
  return v === undefined || v === null ? '' : String(v);
}

function person(card: BoardCard | undefined, key: string): string {
  const u = field(card, key);
  return u ? displayNameForUsername(u) : '';
}

export function jobsToExport(includeArchived: boolean): Job[] {
  syncCardColumns(); // stage is date-derived; resolve it before reading card.column
  return getVisibleJobs().filter((j) => !j.isLinkedReference && (includeArchived || !j.archived));
}

// One row per job: dates span every task, stage is per phase when the job
// is split into phases (e.g. "North wing: Active; South wing: Bid").
export function buildJobRows(includeArchived: boolean): Cell[][] {
  const header = ['Job', 'Stage', 'Start', 'Finish', 'Days', 'Due date', 'Customer', 'Job / P.O. number', 'Location',
    'Job type', 'Timeframe', 'Project manager', 'Foreman', 'Members', 'Comments', 'Archived'];
  const rows: Cell[][] = [header];
  jobsToExport(includeArchived).forEach((job) => {
    const tasks = allJobTasks(job);
    const starts = tasks.map((t) => validDate(t.start)).filter(Boolean).sort();
    const finishes = tasks.map((t) => validDate(t.finish)).filter(Boolean).sort();
    const start = starts[0] || '';
    const finish = finishes[finishes.length - 1] || '';
    const phases = getJobPhases(job);
    const stage = phases.length > 1
      ? phases.map((p) => (p.name || 'Phase') + ': ' + (stageLabel(getPhaseCard(job, p.id)) || '—')).join('; ')
      : stageLabel(getPhaseCard(job, phases[0] ? phases[0].id : null));
    const card = getPrimaryPhaseCard(job);
    const comments = Array.isArray(job.comments) ? job.comments.length : 0;
    rows.push([job.name, stage, start, finish, daysBetween(start, finish), validDate(card && card.due),
      field(card, 'customer'), field(card, 'poNumber'), field(card, 'location'), field(card, 'jobType'),
      field(card, 'timeframe'), person(card, 'pm'), person(card, 'foreman'), field(card, 'members'),
      comments, job.archived ? 'Yes' : 'No']);
  });
  return rows;
}

// One row per task — the shape to paste into a schedule, pivot by crew,
// or import elsewhere.
export function buildTaskRows(includeArchived: boolean): Cell[][] {
  const header = ['Job', 'Phase', 'Sub-phase', 'Task', 'Start', 'Finish', 'Days', 'Stage', 'Customer',
    'Project manager', 'Foreman', 'Notes', 'Archived'];
  const rows: Cell[][] = [header];
  jobsToExport(includeArchived).forEach((job) => {
    const phases = getJobPhases(job);
    phases.forEach((phase) => {
      const card = getPhaseCard(job, phase.id) || getPrimaryPhaseCard(job);
      const phaseName = phases.length > 1 && !phase.isDefault ? phase.name : '';
      getPhaseSubUnits(phase).forEach((sub) => {
        const subName = sub.isDefault ? '' : sub.name;
        realTasks(sub.tasks).forEach((t) => {
          const s = validDate(t.start), f = validDate(t.finish);
          // Every job carries one task slot per board stage whether or not
          // it's scheduled; unscheduled slots are just noise in a sheet.
          if (!s && !f) return;
          rows.push([job.name, phaseName, subName, t.name, s, f, daysBetween(s, f), stageLabel(card),
            field(card, 'customer'), person(card, 'pm'), person(card, 'foreman'),
            typeof t.notes === 'string' ? t.notes : '', job.archived ? 'Yes' : 'No']);
        });
      });
    });
  });
  return rows;
}

function safeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
}

// withBom: a UTF-8 byte-order mark so Excel reads accented text correctly;
// leave it off for formats that must start with exact text (e.g. .ics).
export function downloadTextFile(filename: string, text: string, mime: string, withBom = true): void {
  const blob = new Blob([(withBom ? '\uFEFF' : '') + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ===== Export dialog (#exportModal in index.html) =====
export function openExportModal(): void {
  openModal('exportModal');
}
export function closeExportModal(): void {
  closeModal('exportModal');
}

export function runExport(): void {
  const kindEl = document.querySelector('input[name="exportKind"]:checked') as HTMLInputElement | null;
  const kind = kindEl ? kindEl.value : 'jobs';
  const includeArchived = (document.getElementById('exportIncludeArchived') as HTMLInputElement).checked;
  const rows = kind === 'tasks' ? buildTaskRows(includeArchived) : buildJobRows(includeArchived);
  if (rows.length <= 1) {
    showToast(kind === 'tasks' ? 'No tasks to export' : 'No jobs to export', 'info');
    return;
  }
  const project = getActiveProject();
  const projectName = project && project.name ? safeFilePart(String(project.name)) : 'TeamSync';
  const filename = projectName + ' - ' + (kind === 'tasks' ? 'Tasks' : 'Jobs') + ' - ' + toIsoDate(new Date()) + '.csv';
  downloadTextFile(filename, toCsv(rows), 'text/csv;charset=utf-8');
  closeExportModal();
  showToast('Exported ' + (rows.length - 1) + (kind === 'tasks' ? ' tasks' : ' jobs'), 'success');
}
