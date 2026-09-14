// @ts-check
const { defineConfig } = require('@playwright/test');

// The app is served directly via file:// (index.html + the already-built
// dist/app.bundle.js) rather than through a dev server — no webServer
// needed here, just `npm run build` beforehand so dist/ is current.
module.exports = defineConfig({
  testDir: '.',
  fullyParallel: true,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  // A byte-perfect screenshot match is unrealistic even on the SAME OS/
  // browser build — font hinting and anti-aliasing jitter a small number
  // of pixels frame to frame regardless of any real content change (seen
  // directly: a Home-dashboard screenshot failed at a 1% pixel diff, then
  // passed on an identical re-run of the same commit). 2% absorbs that
  // noise while still catching an actual visible change, which produces
  // a far larger diff than rendering jitter ever does.
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
