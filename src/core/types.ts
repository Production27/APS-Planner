// Deliberately loose in places (index signatures on Job/Task/BoardCard):
// this app's real objects carry many more fields (customFields,
// checklists, comments, header info, etc.) than the model-lookup
// functions in models.ts ever touch. Typing exactly the fields those
// functions read/return is enough to make THIS extraction type-safe
// without pretending to fully model shapes nothing here needs yet —
// tightening these is a fine follow-up whenever a later phase's
// functions actually need the rest typed too.

export interface Task {
  id: string;
  name: string;
  start: string;
  finish: string;
  notes?: string;
  order: number;
  color?: string;
  isDueMarker?: boolean;
  isJobSpan?: boolean;
  [key: string]: unknown;
}

export interface SubPhase {
  id: string | null;
  name: string;
  order: number;
  tasks: Task[];
  isDefault: boolean;
}

export interface Phase {
  id: string | null;
  name: string;
  order: number;
  tasks: Task[];
  isDefault: boolean;
  subPhases?: SubPhase[];
}

export interface Job {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  tasks?: Task[];
  phases?: Phase[];
  [key: string]: unknown;
}

export interface BoardCard {
  id: string;
  jobId?: string;
  phaseId?: string | null;
  column: string;
  columnEnteredAt?: number;
  manualColumn?: string | null;
  manualColumnUntil?: number | null;
  title?: string;
  due?: string;
  attachments?: unknown[];
  customFields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BoardColumn {
  id: string;
  label: string;
  hideFromSchedule?: boolean;
  defaultChecklist?: unknown[];
  workflowItemId?: string | null;
  [key: string]: unknown;
}

export interface WorkflowItem {
  id: string;
  label: string;
  color: string;
}

export interface FoundJob {
  job: Job;
  idx: number;
}

export interface FoundTask {
  job: Job;
  jobIdx: number;
  task: Task;
  taskIdx: number;
  phaseId: string | null;
  subPhaseId: string | null;
}
