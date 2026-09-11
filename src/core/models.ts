// The shared job/task/phase/card LOOKUP layer. Deliberately scoped to
// read-only accessors only — nothing here ever mutates `jobs`/
// `boardCards`. The functions that WRITE to this data (ensureJobAndTaskIds,
// setCardColumn, migration/normalization helpers, etc.) stay in
// index.html; every function below is pure with respect to its own
// arguments once `jobs`/`boardCards` are read.
//
// `jobs`/`boardCards` are declared `var` (not `let`/`const`) in
// index.html specifically so they exist as real `window` properties —
// see that file's own note next to each declaration. Every call site
// across the app (500+ of them) calls findJob(jobId) etc. exactly as
// before.
import type { Job, Phase, SubPhase, BoardCard, FoundJob, FoundTask } from './types';

// `jobs`/`boardCards` (used throughout this file) are declared once,
// ambiently, in src/shared-globals.d.ts.

export function findJob(jobId: string): FoundJob | null {
  for (let i = 0; i < jobs.length; i++) {
    if (jobs[i].id === jobId) return { job: jobs[i], idx: i };
  }
  return null;
}

export function findTask(jobId: string, taskId: string): FoundTask | null {
  const j = findJob(jobId);
  if (!j) return null;
  const phases = getJobPhases(j.job);
  for (let p = 0; p < phases.length; p++) {
    const subUnits = getPhaseSubUnits(phases[p]);
    for (let u = 0; u < subUnits.length; u++) {
      const tasks = subUnits[u].tasks || [];
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].id === taskId) {
          return {
            job: j.job,
            jobIdx: j.idx,
            task: tasks[i],
            taskIdx: i,
            phaseId: phases[p].id,
            subPhaseId: subUnits[u].id,
          };
        }
      }
    }
  }
  return null;
}

// ===== Phases =====
// A job is phase-less by default (job.phases absent/empty) — the vast
// majority of jobs, unchanged from before phases existed: one task list,
// one card, one Gantt bar. Opting a job into phases (Job Manager's "Split
// into phases") replaces that single task list with job.phases, an array
// of independently-tracked units — each with its own tasks (one per
// BOARD_COLUMNS entry, same shape as job.tasks always had), its own card
// (boardCards entry with phaseId set), its own board stage, and its own
// Gantt bar. getJobPhases() is the one seam every board/Gantt consumer
// goes through so they never need to know which case they're in: it
// returns job.phases when present, otherwise a synthetic single-entry
// array wrapping job.tasks itself (id: null — matches the phaseId a
// legacy job's one card already has, since it predates this field).
export function getJobPhases(job: Job): Phase[] {
  if (job.phases && job.phases.length) return job.phases;
  return [{ id: null, name: job.name, order: 0, tasks: job.tasks || [], isDefault: true }];
}

// ===== Sub-phases =====
// Same pattern one level deeper: a phase is sub-phase-less by default
// (phase.subPhases absent/empty), and getPhaseSubUnits() is the seam every
// Gantt/Calendar render path goes through instead of reading phase.tasks
// directly — mirrors getJobPhases() exactly, including the synthetic
// single-entry wrap for the common (not split) case. Sub-phases
// deliberately do NOT get their own board card (unlike phases) — the
// parent phase keeps its single card regardless, so ensureJobHasCards()/
// getPhaseCard()/renderBoard() never need to know sub-phases exist at
// all; only rendering goes one level deeper.
export function getPhaseSubUnits(phase: Phase): SubPhase[] {
  if (phase.subPhases && phase.subPhases.length) return phase.subPhases;
  return [{ id: null, name: phase.name, order: 0, tasks: phase.tasks || [], isDefault: true }];
}

// Every card belongs to exactly one (job, phase) pair — phaseId is null
// for a legacy/unphased job's single card, matching getJobPhases()'s
// synthetic default phase id above. Replaces the old
// `boardCards.find(c => c.jobId === job.id)` pattern that assumed one
// card per job everywhere.
export function getPhaseCard(job: Job, phaseId: string | null | undefined): BoardCard | undefined {
  const pid = phaseId || null;
  return boardCards.find((c) => c.jobId === job.id && (c.phaseId || null) === pid);
}

export function getJobCards(job: Job): BoardCard[] {
  return boardCards.filter((c) => c.jobId === job.id);
}

// PM/Foreman/PO#/location/etc. (CUSTOM_FIELD_DEFS) are job-wide info, not
// per-phase — they're stored on a card's customFields (the only place that
// data has ever lived), so for a phased job they live specifically on the
// first phase's card, read/written from there regardless of which phase
// tab is selected in the Job Manager. An unphased job's one card already
// is that "first phase" card, so this is a no-op change for it.
export function getPrimaryPhaseCard(job: Job): BoardCard | undefined {
  const phases = getJobPhases(job);
  return getPhaseCard(job, phases[0] ? phases[0].id : null);
}
