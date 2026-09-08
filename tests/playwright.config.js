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
});
