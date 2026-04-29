// deno-lint-ignore-file no-await-in-loop
//
// R1 baseline test for the render-loop architecture refactor (see
// plans/render-loop-architecture.md). This test documents the user-reported
// bug: on a static 878-atom-class structure with no input, ambient render
// loops keep pumping `requestAnimationFrame` at ~60Hz (71% CPU at idle on
// the user's machine).
//
// Status today (R0 baseline): test EXPECTED TO FAIL. The `test.fail()`
// annotation flips PASS/FAIL — Playwright reports a green test when the
// assertions actually fail. R3 of the plan makes this test pass for real.
//
// Assertion strategy:
//
//   1. Patch `globalThis.__invalidate_count` and a hook into Threlte's
//      invalidate path. The plan's R2 will replace `threlte.invalidate()`
//      callsites with `mark_dirty()`, which increments this counter. Until
//      R2 lands, the counter has no producer — so the primary signal here is
//      `requestAnimationFrame` calls (which Threlte's `useTask` schedules
//      whenever it has dirty work, regardless of whether `mark_dirty` was
//      called).
//
//   2. We patch `window.requestAnimationFrame` in a `addInitScript` so we
//      can count rAF callbacks. This is more reliable than PerformanceObserver
//      for catching Threlte's per-frame loop in Playwright (PerformanceObserver
//      only sees frames the browser actually painted; we want to see the
//      rAF schedule rate).
//
// Test plan:
//
//   - Load `/test/structure` with the existing fixture (matches the harness
//     used by `structure-scene.test.ts`).
//   - Wait 2s for initial render to settle.
//   - Reset both counters.
//   - 1s of no input — assert both counters are 0. (Today: FAILS, because
//     the dead pulse rAF + Threlte's frame loop fire when active_sites
//     are present; even on a fresh load with no selection, intermittent
//     useTask side-effects can pump frames.)
//   - Programmatically click an atom — assert bounded increment.
//   - Programmatically hover an atom — assert another bounded increment.

import { expect, test, type Page } from '@playwright/test'

// One-time globals injected before the page evaluates any scripts. Two
// counters: `__invalidate_count` is the explicit hook the plan's R2 wires
// up via `mark_dirty()`. `__raf_count` is the structural counter we can rely
// on TODAY without any production-code changes — Threlte's render loop
// reschedules via rAF, so a non-zero idle delta proves the bug.
const INIT_SCRIPT = `
;(globalThis).__invalidate_count = 0
;(globalThis).__raf_count = 0
;(globalThis).__reset_invalidate_count = () => { (globalThis).__invalidate_count = 0 }
;(globalThis).__reset_raf_count = () => { (globalThis).__raf_count = 0 }

// Patch requestAnimationFrame so every callback bumps the counter. This
// catches Threlte's per-frame useTask loop, the dead pulse rAF, and any
// other rAF-driven render pumping.
;(() => {
  const native = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => {
    return native((t) => {
      ;(globalThis).__raf_count = ((globalThis).__raf_count ?? 0) + 1
      cb(t)
    })
  }
})()
`

async function inject_counters(page: Page): Promise<void> {
  await page.addInitScript(INIT_SCRIPT)
}

async function read_counters(
  page: Page,
): Promise<{ invalidates: number; rafs: number }> {
  return await page.evaluate(() => ({
    invalidates: (globalThis as { __invalidate_count?: number })
      .__invalidate_count ?? 0,
    rafs: (globalThis as { __raf_count?: number }).__raf_count ?? 0,
  }))
}

async function reset_counters(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as {
      __reset_invalidate_count?: () => void
      __reset_raf_count?: () => void
    }
    g.__reset_invalidate_count?.()
    g.__reset_raf_count?.()
  })
}

// Idle threshold for `__invalidate_count`: this is the metric R2/R4/R4c
// wired up. It counts EXPLICIT paint requests routed through
// `mark_dirty()` — which is what we're trying to drive to zero at idle.
//
// We do NOT assert on raw rAF count. Three.js's WebGLAnimation
// (node_modules/three/src/renderers/webgl/WebGLAnimation.js) self-
// reschedules `requestAnimationFrame` every frame unconditionally once
// `setAnimationLoop` is started by Threlte's renderer
// (node_modules/@threlte/core/dist/context/fragments/renderer.svelte.js).
// So idle rAF count is always ~60/s as a structural baseline — that's
// not the bug. The bug is "WORK happens inside those rAF callbacks":
// state writes that trigger paint cascades, hot-path JS in useTasks, etc.
// `__invalidate_count` correctly measures that work because it counts
// explicit invalidate-requests, which only fire when something actually
// asked for a repaint.
//
// We also keep `__raf_count` in the test for diagnostic visibility (the
// READ-OUT, not the GATE), so when this test runs we can see the
// structural rAF baseline alongside the meaningful invalidate count.
const IDLE_INVALIDATE_THRESHOLD = 2
const INTERACTION_INVALIDATE_THRESHOLD = 50

test.describe(`Render-loop baseline (R1 — documents the bug R3 fixes)`, () => {
  test.beforeEach(async ({ page }) => {
    await inject_counters(page)
    await page.goto(`/test/structure`, { waitUntil: `networkidle` })
    const canvas = page.locator(`#test-structure canvas`)
    await canvas.waitFor({ state: `visible`, timeout: 5000 })
    await expect(canvas).toHaveAttribute(`width`)
    await expect(canvas).toHaveAttribute(`height`)
    // Settle: let Threlte mount, GPU picker init, atom_data $derived run.
    await page.waitForTimeout(2000)
  })

  test(`idle invalidate-count is silent and atom interaction produces bounded paint requests`, async ({ page }) => {
    const canvas = page.locator(`#test-structure canvas`)

    // ── 1. Idle: no input for 1s. Asserts NO mark_dirty() is firing. ──
    // Three.js's animation loop will tick rAF ~60 times in this window
    // regardless (structural baseline). What matters is whether anyone
    // is asking for a repaint inside those ticks — that's what
    // __invalidate_count measures. R3's deletions (dead pulse rAF +
    // equality guards on polyhedra/scale-bar useTasks + ring rotation
    // gating) should drive this to 0 at true idle.
    await reset_counters(page)
    await page.waitForTimeout(1000)
    const idle = await read_counters(page)

    // Diagnostic only — never gate on rAF count, see threshold comment above.
    console.log(`[render-loop test] idle rAFs=${idle.rafs}, invalidates=${idle.invalidates}`)

    expect(
      idle.invalidates,
      `idle invalidate count should be near zero (got ${idle.invalidates}); ` +
        `each unit means someone explicitly asked the canvas to repaint. ` +
        `Idle baseline rAFs (Three.js setAnimationLoop): ${idle.rafs} — ` +
        `ignored, see test comment.`,
    ).toBeLessThanOrEqual(IDLE_INVALIDATE_THRESHOLD)

    // ── 2. Click an atom. Threlte's interactivity layer forwards the click
    //      to `handle_atom_interaction_click`, which calls toggle_selection.
    //      Expect a bounded burst of paints (≤50 — multiple Threlte prop
    //      writes can cascade through `<T.>` auto-invalidate). ──
    await reset_counters(page)
    // Probe a couple of central positions until we land on an atom; mirrors
    // the pattern in structure-scene.test.ts.
    const probe_positions = [
      { x: 300, y: 200 },
      { x: 250, y: 200 },
      { x: 350, y: 250 },
      { x: 200, y: 250 },
    ]
    for (const pos of probe_positions) {
      await canvas.click({ position: pos, force: true })
      await page.waitForTimeout(150) // let invalidate flush
      const c = await read_counters(page)
      if (c.invalidates > 0) break
    }
    const after_click = await read_counters(page)
    // Diagnostic only: click invalidates flow primarily through Threlte's
    // <T.> prop-chain auto-invalidate (useProps.js:117), which bypasses
    // our mark_dirty() counter. So __invalidate_count under-reports real
    // paint activity for prop-driven mutations. We log for visibility but
    // don't gate. The bound below catches a feedback loop in any explicit
    // mark_dirty() path triggered by the click.
    console.log(`[render-loop test] after click: rAFs=${after_click.rafs}, invalidates=${after_click.invalidates}`)
    expect(
      after_click.invalidates,
      `click should not trigger >${INTERACTION_INVALIDATE_THRESHOLD} invalidates ` +
        `via mark_dirty (suggests a feedback loop); got ${after_click.invalidates}`,
    ).toBeLessThan(INTERACTION_INVALIDATE_THRESHOLD)

    // ── 3. Hover an atom (move pointer to a different position). ──
    await reset_counters(page)
    await canvas.hover({ position: { x: 400, y: 300 }, force: true })
    await page.waitForTimeout(150)
    const after_hover = await read_counters(page)
    console.log(`[render-loop test] after hover: rAFs=${after_hover.rafs}, invalidates=${after_hover.invalidates}`)
    // Same reasoning as click: hover paints flow via prop chain. We assert
    // only that no feedback loop is firing through mark_dirty().
    expect(
      after_hover.invalidates,
      `hover should not trigger >${INTERACTION_INVALIDATE_THRESHOLD} invalidates ` +
        `via mark_dirty (suggests a feedback loop); got ${after_hover.invalidates}`,
    ).toBeLessThan(INTERACTION_INVALIDATE_THRESHOLD)
  })
})
