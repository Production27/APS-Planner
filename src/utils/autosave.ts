// A small generic debounce controller, shared by both the Job form's
// and the Card modal's autosave (each still has its own instance/state;
// this is just the factory). Pure, no DOM or app-state dependency.

export interface AutosaveController {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
}

export function createAutosaveController(saveFn: () => void, delayMs: number): AutosaveController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; saveFn(); }, delayMs);
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    saveFn();
  }
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }
  return { schedule: schedule, flush: flush, cancel: cancel };
}
