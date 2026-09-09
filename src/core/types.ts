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
  // A "linked reference" is a read-only copy of a job from the OTHER
  // fixed project, shown inline for visibility (see getLinkedReferenceJobs()
  // in index.html) — link points back at its real counterpart.
  isLinkedReference?: boolean;
  linkedFromProjectName?: string;
  link?: { jobId: string } | null;
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
  color?: string;
  attachments?: unknown[];
  customFields?: Record<string, unknown>;
  checklists?: Record<string, unknown[]>;
  checklistAssignees?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BoardColumn {
  id: string;
  label: string;
  hideFromSchedule?: boolean;
  defaultChecklist?: unknown[];
  workflowItemId?: string | null;
  color?: string;
  scheduleDisconnected?: boolean;
  autoAssignChecklist?: boolean;
  checklistAssigneeOverride?: string;
  defaultDuration?: number;
  stalledAfterDays?: number;
  [key: string]: unknown;
}

export interface CalendarEventException {
  skip?: boolean;
  start?: string;
  time?: string;
  duration?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  time?: string;
  duration?: number;
  repeat?: string;
  repeatUntil?: string | null;
  color?: string;
  exceptions?: Record<string, CalendarEventException>;
  visibility?: string;
  visibleMembers?: string[];
  createdBy?: string;
  [key: string]: unknown;
}

export interface CalendarEventOccurrence {
  sourceDate: string;
  start: Date;
  finish: Date;
  time: string;
  duration: number;
}

export interface CustomFieldDef {
  key: string;
  label: string;
  type: string;
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
