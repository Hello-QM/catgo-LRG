import type { PlaywrightTestConfig } from '@playwright/test'

const CI = !!process.env.CI

export default {
  webServer: {
    command: `vite dev --port 3005`,
    port: 3005,
    // In CI always start a fresh server (never silently attach to a stale one);
    // locally reuse an already-running dev server for fast iteration.
    reuseExistingServer: !CI,
    // Bound startup so a server that never becomes ready fails fast instead of
    // stalling (paired with the job-level timeout-minutes in CI).
    timeout: 120_000,
  },
  workers: CI ? 4 : 8,
  timeout: 15_000, // Global timeout per test
  // Cap whole-run wall time so a hung navigation can't run to the job ceiling.
  globalTimeout: CI ? 15 * 60_000 : undefined,
  testDir: `tests/playwright`,
  maxFailures: 1,
} satisfies PlaywrightTestConfig
