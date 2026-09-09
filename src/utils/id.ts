// Moved verbatim from index.html as part of Phase 2 of the architecture
// roadmap (see project memory / the published "TeamSync Blueprint" plan)
// — the first extraction out of the single inline <script> block, chosen
// because neither function touches the DOM or any shared app state.

export function genId(): string {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// A handful of top-level `let`s in index.html parse straight out of
// localStorage as the script itself loads — before init() even runs —
// with no try/catch (unlike loadLinkEnabledPref()/etc, which correctly
// guard the identical localStorage-get→JSON.parse pattern elsewhere).
// Any manual edit, extension interference, or partial write leaving one
// of those keys as invalid JSON would throw uncaught at parse time and
// halt the whole script before it ever reaches init() — a blank,
// non-functional page with no error shown.
export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(str as string);
  } catch (e) {
    return fallback;
  }
}
