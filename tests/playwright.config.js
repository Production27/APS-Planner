// @ts-check
const { defineConfig } = require('@playwright/test');

// index.html is a single static file with no build step — tested directly
// via file://, same as every past manual verification pass documented in
// SESSION_HANDOFF.md. No webServer needed.
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
