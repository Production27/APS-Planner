// Catches a tab stuck on stale cached JS after a new version ships — the
// exact scenario that once caused sync to look broken: an old tab
// running outdated merge/autosave logic against teammates already on the
// current version. Fetches version.txt fresh (bypassing HTTP cache) and
// compares it to this tab's own APP_VERSION (still declared in
// index.html — the one constant a human bumps by hand on every deploy,
// alongside version.txt itself). On a mismatch, shows a persistent
// banner rather than force-reloading — an unprompted reload could drop
// in-progress typing, which would be a worse failure mode than a stale
// tab for a few extra minutes. Called on visibilitychange (the
// tab-left-open-in-the-background scenario) and on a periodic timer as a
// backstop.

declare global {
  // eslint-disable-next-line no-var
  const APP_VERSION: string;
}

export async function checkForNewerVersion(): Promise<void> {
  try {
    const res = await fetch('version.txt?_v=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const text = (await res.text()).trim();
    if (text && text !== APP_VERSION) {
      document.getElementById('newVersionBanner')!.classList.add('show');
    }
  } catch (err) {
    // Offline or a network hiccup — not worth surfacing; the next
    // periodic check (or the next tab-focus) will just try again.
  }
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') checkForNewerVersion();
});
setInterval(checkForNewerVersion, 5 * 60 * 1000);
