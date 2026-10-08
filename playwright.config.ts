import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app (npm run build) through Playwright's Electron support.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
});
