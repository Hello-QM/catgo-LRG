import type { PlaywrightTestConfig } from '@playwright/test'

const CI = !!process.env.CI

export default {
  webServer: {
    // Serve the real app: the desktop config is what users run. A bare
    // `vite dev` (no config) was a plain static server — every page 404'd and
    // the whole legacy suite died on its first visibility assert (#310).
    command: `PORT=3005 pnpm desktop:dev`,
    port: 3005,
    // In CI always start a fresh server (never silently attach to a stale one);
    // locally reuse an already-running dev server for fast iteration.
    reuseExistingServer: !CI,
    // Bound startup so a server that never becomes ready fails fast instead of
    // stalling (paired with the job-level timeout-minutes in CI). predev may
    // build doc chunks on a cold checkout, so allow extra headroom.
    timeout: 180_000,
  },
  workers: CI ? 4 : 8,
  timeout: 30_000, // Global timeout per test
  // Cap whole-run wall time so a hung navigation can't run to the job ceiling.
  globalTimeout: CI ? 15 * 60_000 : undefined,
  // tests/playwright is the legacy matterviz demo-site suite — it targets
  // routes (/test/*, /periodic-table, ...) that do not exist in this repo and
  // can never pass. Only the smoke suite against the real app runs (#310).
  testDir: `tests/e2e`,
  // One flaky test must not zero out the rest of the run's coverage.
  maxFailures: CI ? 10 : 1,
} satisfies PlaywrightTestConfig
