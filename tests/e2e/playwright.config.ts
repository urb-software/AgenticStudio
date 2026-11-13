import { defineConfig, devices } from '@playwright/test';

// Run through `pnpm e2e:smoke` (tests/e2e/run-smoke.mjs), which starts the built apps
// against throwaway PostgreSQL and Redis and sets E2E_BASE_URL and E2E_OPERATOR_PASSWORD.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  // A flaky smoke test is a bug to fix, never retried until green (quality.md §3).
  retries: 0,
  forbidOnly: true,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  // The same journey on the primary desktop width and on a phone (#43); both Chromium.
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
