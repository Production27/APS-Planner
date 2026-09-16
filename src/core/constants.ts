// App-wide constants read by more than one src/ file. Real module-owned
// values now, moved out of index.html's inline script where they used to
// live as ambient `window` globals purely because that inline script and
// the bundled dist/app.bundle.js were two separate <script> tags — see
// src/shared-globals.d.ts for how these stay visible to every other file
// as bare ambient globals (unchanged by this move; only where the real
// value lives changed). None of these are ever reassigned anywhere in the
// app or its tests — only ever read.

// The Worker's base URL — every fetch()/fetchWithReauth() call in the app
// appends its own path onto this.
export const API_BASE_URL = 'https://aps-planner-staging.production-db3.workers.dev/';

export const COLOR_PRESETS = [
  '#1a237e', '#3949ab', '#5b7eb5', '#2c3e80', '#3498db', '#17a2b8',
  '#00bcd4', '#4dd0e1', '#80deea', '#7dd3c0', '#00897b', '#2e7d32',
  '#66bb6a', '#a4c639', '#28a745', '#fdd835', '#f0ad4e', '#ff9800',
  '#c62828', '#e53935', '#dc3545', '#f48fb1', '#d4a5d4', '#9b7edc',
  '#8e7cc3', '#c0c0c0', '#424242', '#6c757d',
];

export const DEFAULT_BOARD_COLUMNS = [
  { id: 'bid', label: 'Bid' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'active', label: 'Active' },
  { id: 'complete', label: 'Complete' },
  { id: 'invoiced', label: 'Invoiced' },
];

// Calendar's per-event-bar sizing (analogous to Gantt's own
// GANTT_ROW_H/GANTT_BAR_H/GANTT_BAR_PAD, which stayed local to
// src/views/gantt.ts since nothing else reads them — these three are
// read by more than one file, so they live here instead).
export const CAL_BAR_H = 20;
export const CAL_BAR_GAP = 3;
export const CAL_DAYNUM_H = 26;

// How many days a card can sit in a board column before Board/Home flag
// it as stalled — see computeColumnStalledFloors() in src/views/home.ts
// for how this floor now also gets raised per-column.
export const DEFAULT_STALLED_AFTER_DAYS = 14;

// How far back a job/task can be and still show up before being treated
// as archived — shared between src/views/gantt.ts's date-range clamp and
// autoArchiveJobs() (src/app/project.ts).
export const ARCHIVE_CUTOFF_DAYS = 90;
