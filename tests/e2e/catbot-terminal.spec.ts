import { test, expect } from '@playwright/test'

/**
 * Integration test for CatBot terminal control.
 *
 * Exercises the real chain: TerminalPanel registers a handle → run_command wraps
 * the command with BEGIN/END markers, writes it to the PTY, and captures the
 * output. This needs the FULL dev stack (vite + Python backend, so the PTY can
 * spawn) — set CATGO_E2E_URL to it (default http://localhost:3186, the
 * `pnpm desktop:serve` port). The CatBot tool layer itself is unit-tested in
 * tests/vitest/terminal-tools.test.ts; here we prove the PTY capture end to end.
 *
 * If no terminal registers within the timeout (e.g. running against a
 * frontend-only server with no backend), the test skips rather than failing.
 */
const BASE = process.env.CATGO_E2E_URL ?? 'http://localhost:3186'
const REGISTRY_URL = '/src/lib/structure/terminal-registry.svelte.ts'

test('run_command captures real terminal output via the registry', async ({ page }) => {
  // page.goto (cold app + WASM init) plus the 20s registration wait can exceed
  // the default 30s per-test budget, which made the test TIME OUT (fail) instead
  // of reaching the graceful `test.skip` below when no backend/PTY is present
  // (the CI e2e job runs the frontend dev server only). Give it room to skip.
  test.setTimeout(60_000)
  await page.goto(BASE)

  // Open a local terminal from the landing grid.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      x.textContent?.includes('Terminal') && x.textContent?.includes('Local shell'))
    ;(b as HTMLButtonElement | undefined)?.click()
  })

  // Wait (bounded) for a terminal handle to register; skip if the backend/PTY
  // isn't available in this environment.
  const registered = await page.evaluate(async (url) => {
    for (let i = 0; i < 80; i++) {
      try {
        const reg: any = await import(/* @vite-ignore */ url)
        if (reg.has_active_terminal && reg.has_active_terminal()) return true
      } catch { /* module not served yet */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }, REGISTRY_URL)

  test.skip(!registered, 'No PTY-backed terminal registered (frontend-only server?)')

  const result = await page.evaluate(async (url) => {
    const reg: any = await import(/* @vite-ignore */ url)
    const h = reg.get_active_terminal()
    const token = 'catgo_e2e_' + Math.floor(Math.random() * 1e6)
    const r = await h.run_command('echo ' + token)
    return { token, output: r.output as string, exit_code: r.exit_code as number | null, running: r.running as boolean }
  }, REGISTRY_URL)

  expect(result.output).toContain(result.token)
  expect(result.exit_code).toBe(0)
  expect(result.running).toBe(false)
})
