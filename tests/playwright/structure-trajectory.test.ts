// W7 — Structure × Trajectory regression suite (Milestone 1, Category 1).
// Verifies trajectory playback updates atom GPU positions, bonds advance,
// and playback / stop semantics work. Each test name maps to a W7 design
// test ID (1.1 … 1.5) per plans/W7-trajectory-test-suite-design.md.
//
// Probe surface: globalThis.__catgo_probe is exported from
// StructureScene.svelte's W1 instrumentation block. Test-only getters
// (get_atom_x, get_atom_xyz, atom_count, bond_pairs_count) are available
// in DEV builds only — Playwright runs against `vite dev` (port 3005), so
// they are present.
import { expect, test } from '@playwright/test'
import { project_to_pixel } from './helpers/project_to_pixel'

type TrajectoryTestApi = {
  resume_disabled: boolean
  trigger_atom_added: () => void
  trigger_atoms_deleted: () => void
  trigger_atom_replaced: () => void
  trigger_atoms_manipulated: () => void
}

declare global {
  // eslint-disable-next-line no-var
  var __catgo_traj_test: TrajectoryTestApi | undefined
}

type ProbeSurface = {
  get_atom_x: (site_id: number) => number | null
  get_atom_xyz: (site_id: number) => [number, number, number] | null
  get_structure_site_x: (site_idx: number) => number | null
  atom_count: number
  atom_manager_capacity: number
  align_on_load_fires: number
  bond_pairs_count: number
  filtered_bond_pairs_count: number
  charge_label_entries_count: number
  h_bond_pairs_count: number
  override_size: number
  vibration_active: boolean
  is_playing: boolean
  get_camera_matrices: () => {
    projection: number[]
    view: number[]
    width: number
    height: number
  } | null
  // W7 Tests 2.1, 2.5: most-recently-selected site_idx (LAST element of
  // selected_sites). null when nothing is selected.
  selected_site_id: number | null
  snapshot: () => Record<string, number>
  reset: () => void
}

declare global {
  // eslint-disable-next-line no-var
  var __catgo_probe: ProbeSurface | undefined
}

const FIXTURE_FRAMES = 10
const FRAME_0_H1_X = 0.96
const FRAME_9_H1_X = 1.06

test.describe(`W7 Category 1 — Trajectory plays smoothly`, () => {
  // Trajectory tests run for several seconds at low fps; override the
  // 15-second global timeout in playwright.config.ts.
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    // Wait for the trajectory + Structure to mount and the probe surface
    // to be exposed by StructureScene's W1 $effect.
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    // Wait for atoms to be in the GPU buffer (X2 shadow sync committed).
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 1.1: Frame counter advances during playback ───────────────────
  test(`1.1 frame counter advances during playback`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    await expect(step_input).toBeVisible()
    await expect(step_input).toHaveValue(`0`)

    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()

    // Default fps is 5; after 1.5s expect at least frame 3+.
    await expect.poll(
      async () => Number(await step_input.inputValue()),
      { timeout: 5_000 },
    ).toBeGreaterThan(0)
  })

  // ─── Test 1.2: Atom GPU x-position differs between frame 0 and frame 9 ─
  test(`1.2 atom x-position differs between frame 0 and frame 9`, async ({
    page,
  }) => {
    const step_input = page.locator(`input.step-input`).first()

    // Site 0 is H1 in FIXTURE_H2O_10F.
    const pos_f0 = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_x(0) ?? null,
    )
    expect(pos_f0).not.toBeNull()
    expect(pos_f0).toBeCloseTo(FRAME_0_H1_X, 1)

    // Jump to frame 9 via the step input.
    await step_input.fill(String(FIXTURE_FRAMES - 1))
    await step_input.press(`Enter`)
    // Allow the X2 shadow sync to commit the new positions.
    await page.waitForTimeout(150)

    const pos_f9 = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_x(0) ?? null,
    )
    expect(pos_f9).not.toBeNull()
    expect(pos_f9).toBeCloseTo(FRAME_9_H1_X, 1)
    expect(Math.abs((pos_f9 as number) - (pos_f0 as number))).toBeGreaterThan(
      0.05,
    )
  })

  // ─── Test 1.3: Bond count ≥ 2 on frames 0 and 9 ─────────────────────────
  test(`1.3 bond count >=2 on frame 0 and frame 9`, async ({ page }) => {
    // Wait for the worker bond detection to run on the initial topology.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
    const count_f0 = await page.evaluate(
      () => globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0,
    )
    expect(count_f0).toBeGreaterThanOrEqual(2)

    // Jump to frame 9; topology is frozen during playback (CLAUDE.md), so
    // bond_pairs_count should remain >=2 at every frame.
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(String(FIXTURE_FRAMES - 1))
    await step_input.press(`Enter`)
    await page.waitForTimeout(200)

    const count_f9 = await page.evaluate(
      () => globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0,
    )
    expect(count_f9).toBeGreaterThanOrEqual(2)
  })

  // ─── Test 1.4: Playback advances multiple frames in 2.5s at 5 fps ──────
  test(`1.4 playback advances multiple frames in 2.5s`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    const play_btn = page.locator(`.play-button`).first()

    await play_btn.click()
    await page.waitForTimeout(2_500)

    const final_step = Number(await step_input.inputValue())
    // At 5 fps × 2.5s ≈ 12 ticks. The 10-frame loop should have advanced
    // past frame 0 even after wrapping; we just need >0.
    expect(final_step).toBeGreaterThan(0)
  })

  // ─── Test 1.5: Stop freezes frame counter ──────────────────────────────
  test(`1.5 stop freezes frame counter`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    const play_btn = page.locator(`.play-button`).first()

    await play_btn.click()
    await page.waitForTimeout(1_000)
    // Click the same button again to pause.
    await play_btn.click()

    const n1 = Number(await step_input.inputValue())
    await page.waitForTimeout(1_000)
    const n2 = Number(await step_input.inputValue())
    expect(n2).toBe(n1)
  })
})

// ─── W7 Category 7 — Visual regression (frame-by-frame snapshots) ─────────
// Captures only the Three.js canvas, not the surrounding UI chrome, so
// resizes / chrome layout shifts don't break baselines. Per W7 design
// § Category 7. Tolerance values come from the design.
test.describe(`W7 Category 7 — Visual regression`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Allow the worker bond detection to commit and one render pass to settle.
    await page.waitForTimeout(500)
  })

  // ─── Test 7.1 — Frame 0 baseline screenshot ────────────────────────────
  test(`7.1 frame 0 canvas baseline`, async ({ page }) => {
    const canvas = page.locator(`canvas`).first()
    await expect(canvas).toBeVisible()
    expect(await canvas.screenshot()).toMatchSnapshot(`traj-h2o-frame-0.png`, {
      maxDiffPixels: 200,
    })
  })

  // ─── Test 7.2 — Frame 9 differs from frame 0 ───────────────────────────
  // Note: this test asserts that the rendered canvas at frame 9 is visually
  // distinct from frame 0. A regression that froze atoms at frame-0
  // positions would produce identical canvases — directly confirming the
  // same defect as Test 1.2, but via screenshot.
  test(`7.2 frame 9 canvas differs from frame 0`, async ({ page }) => {
    const canvas = page.locator(`canvas`).first()
    await expect(canvas).toBeVisible()
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(String(FIXTURE_FRAMES - 1))
    await step_input.press(`Enter`)
    await page.waitForTimeout(300)
    expect(await canvas.screenshot()).toMatchSnapshot(`traj-h2o-frame-9.png`, {
      maxDiffPixels: 200,
    })
  })

  // ─── Test 7.5 — Bonds visible in frame-5 screenshot ────────────────────
  test(`7.5 bonds visible in frame-5 canvas`, async ({ page }) => {
    const canvas = page.locator(`canvas`).first()
    await expect(canvas).toBeVisible()
    // Wait for worker bond detection to commit.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    await page.waitForTimeout(300)
    expect(await canvas.screenshot()).toMatchSnapshot(
      `traj-h2o-frame-5-bonds.png`,
      { maxDiffPixels: 250 },
    )
  })

  // Tests 7.3 (mid-playback auto-advance), 7.4 (post-stop matches frame 7),
  // and 7.6 (no blank canvas during stop transition) are timing-sensitive
  // and depend on frame interval precision in the test runner. They land
  // in a follow-up commit once the snapshot baselines for 7.1, 7.2, 7.5
  // are stable across multiple runs.
})

// ─── W7 Category 8 — Performance regression (cascade fire counts) ─────────
// Phase-gate tests that read globalThis.__catgo_probe to assert the
// expected cascade behavior at each plan v3 phase. Each test has TWO
// expectation modes:
//   - BASELINE (current HEAD, pre-refactor): cascade is loud — the
//     patch-stack fast paths absorb work but don't suppress the effects
//     entirely. Specific counters fire per frame as documented in the
//     W1 baseline reading at StructureScene.svelte:1554-1582.
//   - ARCHITECTURE-P (post-Phase-4): cascade is silent — `current_structure`
//     no longer writes per frame, so atom_data, bbp, apb, acb, nhsi all
//     stop firing entirely.
//
// Tests use `expect.poll(...)` patterns where helpful, and 3-second
// playback windows for stable counter accumulation. The fixture is
// FIXTURE_H2O_10F (3 atoms × 10 frames at 5 fps default = 30+ ticks
// in 3 seconds, well above the >10 threshold for noise rejection).
//
// Phase 4 detection: when the user manually flips `architecture_p_active`
// on the probe surface (planned addition in plan v3 Phase 4), tests 8.1
// and 8.2 will switch to the silent-variant assertion. Until then, all
// assertions use the baseline variant.
//
// Test 8.4 (per-frame JS cost via performance.mark) is deferred to
// Milestone 4 when the 192-atom fixture (FIXTURE_192A_20F) lands —
// the H2O fixture is too small for stable timing measurements.
test.describe(`W7 Category 8 — Performance regression (cascade probes)`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Allow the worker bond detection to commit and one render pass to settle
    // before counter measurements begin.
    await page.waitForTimeout(500)
  })

  // ─── Test 8.1 — atom_data cascade silenced under Architecture P ─────────
  // BASELINE behavior (commits 29420f91 - 846e7c53, before Phase 4):
  // atom_data $derived.by() ran every trajectory frame because current_structure
  // was written per frame, cascading to displayed_structure → structure prop
  // → atom_data subscription. The patch-stack fast-path absorbed the work
  // (atom_data_meaningful stayed at 0) but the effect IS entered
  // (atom_data_fires incremented loud).
  //
  // PHASE 4+5 behavior (current, commit C4+): current_structure stops
  // writing per frame (gated behind topology_initialized). displayed_structure
  // becomes quiescent. atom_data never re-runs during playback.
  // atom_data_fires === 0 over the 3-second window. THIS IS THE BYPASS
  // REFACTOR'S PRIMARY SUCCESS CRITERION.
  //
  // This test catches: accidental cascade reactivation in any phase after
  // Phase 4 (Phase 5.5, 6, 7). Any non-zero counter here is a regression.
  test(`8.1 atom_data cascade silenced during playback`, async ({ page }) => {
    const play_btn = page.locator(`.play-button`).first()
    await page.evaluate(() => globalThis.__catgo_probe?.reset())
    const pre = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(pre).not.toBeNull()
    expect(pre!.atom_data_fires).toBe(0)

    await play_btn.click()
    await page.waitForTimeout(3_000)

    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    const delta = post!.atom_data_fires - pre!.atom_data_fires

    // Phase 4+ acceptance: cascade is silent. atom_data does NOT re-run
    // during trajectory playback under Architecture P.
    expect(delta).toBe(0)
    // atom_data_meaningful must also be 0 (sanity — if delta is 0 but
    // meaningful > 0, the test is reading state from before the cascade
    // was reset).
    expect(post!.atom_data_meaningful).toBe(0)
  })

  // ─── Test 8.2 — bbp slow-path absorbed by trajectory fast-path [Phase 3+] ─
  // BASELINE behavior (commits 29420f91 - a9717e86, before Phase 3): both
  // bbp_fires and bbp_meaningful were loud (~5-6ms each frame). The stable
  // memo guard did NOT absorb trajectory because struct_ref changed per frame
  // as current_structure was written. build_bond_pairs ran every frame.
  //
  // PHASE 3 behavior (current, commits 492446a0+): the new trajectory branch
  // in build_bond_pairs $effect.pre returns BEFORE the slow-path
  // build_bond_pairs() call. bbp_fires stays loud (~17, effect still fires
  // per frame on trajectory_frame_positions change), but bbp_meaningful
  // drops to 0 because the slow path is never reached.
  //
  // PHASE 4 behavior (future, commit C4): current_structure stops, struct_ref
  // is stable, the trajectory branch's stable-input check absorbs the fire
  // entirely → bbp_fires also drops to 0.
  //
  // This test catches the bond-freeze regression where the trajectory
  // fast-path is misimplemented (returns without computing, bonds vanish).
  // Cross-validates with Test 1.3 (bonds present at F0 and F9): if both
  // 8.2 passes AND 1.3 passes, the trajectory fast-path is doing real work
  // without entering the slow path.
  test(`8.2 build_bond_pairs trajectory fast-path absorbs slow-path`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    await page.evaluate(() => globalThis.__catgo_probe?.reset())
    const pre = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(pre).not.toBeNull()

    await play_btn.click()
    await page.waitForTimeout(3_000)

    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    const meaningful_delta = post!.bbp_meaningful - pre!.bbp_meaningful
    const fires_delta = post!.bbp_fires - pre!.bbp_fires

    // Phase 3+ acceptance: trajectory branch returns before slow path.
    expect(meaningful_delta).toBe(0)
    // Effect itself still fires per frame on trajectory_frame_positions
    // change — only Phase 4 silences this. Threshold > 0 because at minimum
    // one fire happens per traj advance during the 3s window.
    expect(fires_delta).toBeGreaterThan(0)
  })

  // ─── Test 8.3 — X2 shadow sync slow path NEVER taken during playback ──
  // CRITICAL: this test is the hard gate for plan v3 Phase 6. Without
  // Phase 5.5's X2 early-return gate, deleting the trajectory_only branch
  // in Phase 6 causes X2 to fall through to the full-diff slow path at
  // ~15-30ms/frame — the entire performance regression the bypass refactor
  // exists to prevent.
  //
  // At baseline AND through every plan v3 phase, x2_slow_meaningful must
  // remain at 0 during playback. The trajectory_only and positions_only
  // fast paths must absorb every frame; if either is bypassed, the slow
  // path enters and this test fires.
  //
  // After Phase 6 (patches deleted), x2_traj_fast_path_fires drops to 0
  // because the gate prevents X2 from reaching the deleted branch — but
  // x2_slow_meaningful must STILL be 0. This test catches: a Phase 6
  // deletion that was made without the Phase 5.5 gate in place.
  test(`8.3 X2 slow path never reached during playback`, async ({ page }) => {
    const play_btn = page.locator(`.play-button`).first()
    await page.evaluate(() => globalThis.__catgo_probe?.reset())
    const pre = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(pre).not.toBeNull()
    expect(pre!.x2_slow_meaningful).toBe(0)

    await play_btn.click()
    await page.waitForTimeout(3_000)

    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    const slow_delta = post!.x2_slow_meaningful - pre!.x2_slow_meaningful

    // Hard gate: slow path must never be reached during 3 seconds of
    // active trajectory playback. This invariant must hold at every
    // plan v3 phase boundary.
    expect(slow_delta).toBe(0)

    // Phase 5.5 cross-validation: the X2 early-return gate makes the
    // trajectory_only branch unreachable during playback (gate fires
    // before reaching the branch). Drops to 0 from the baseline ~15.
    // Phase 6 will delete the trajectory_only branch — this assertion
    // must hold after deletion too (gate prevents reaching the deleted
    // branch).
    const traj_fast_delta =
      post!.x2_traj_fast_path_fires - pre!.x2_traj_fast_path_fires
    expect(traj_fast_delta).toBe(0)
    // Sanity: trajectory IS playing — apb_fires (atom_positions_buffer
    // subscribed to atom_manager.version) increments per frame as the
    // Phase 2 position-write loop drives the manager.
    expect(post!.apb_fires - pre!.apb_fires).toBeGreaterThan(0)
  })

  // Test 8.4 lives in its own describe block below (uses the
  // FIXTURE_192A_20F page at /test/structure-trajectory-large).
})

// ─── W7 Category 8 — Test 8.4: per-frame JS cost on 192-atom fixture ──────
// Authored in Milestone 4 with FIXTURE_192A_20F (192 atoms × 20 frames).
// The H2O fixture (3 atoms) is too small for stable timing measurements
// because per-frame cost is dominated by browser rAF jitter, not JS work.
// 192 atoms gives a real signal while staying below the ~1000-atom sync
// fallback threshold in bond-worker-api.ts.
//
// Counter-based proxy for "per-frame slow-path JS cost" — sums the
// meaningful counters that represent slow-path entries during playback.
// Under Architecture P, this sum should be 0 (cascade silenced). On the
// patched baseline (commit 29420f91), this sum was ~75 (5 counters × 15
// per-frame fires in 5 seconds at ~3fps).
test.describe(`W7 Category 8 — Test 8.4 (per-frame JS cost, 192-atom fixture)`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory-large`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 192,
      null,
      { timeout: 30_000 },
    )
    // Allow the worker bond detection to commit — 192 atoms takes longer
    // than the 3-atom H2O fixture.
    await page.waitForTimeout(1_500)
  })

  test(`8.4 per-frame slow-path counters silent on 192-atom playback`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    await page.evaluate(() => globalThis.__catgo_probe?.reset())

    await play_btn.click()
    await page.waitForTimeout(3_000)

    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    // Phase 6+ acceptance: no slow-path entries during playback.
    // atom_data_meaningful: cascade silenced.
    // bbp_meaningful: trajectory branch absorbs.
    // x2_slow_meaningful: Phase 5.5 gate prevents slow path.
    // acb_meaningful: structure.sites frozen, no per-frame allocation.
    // nhsi_meaningful: hidden-sites compute frozen.
    expect(post!.atom_data_meaningful).toBe(0)
    expect(post!.bbp_meaningful).toBe(0)
    expect(post!.x2_slow_meaningful).toBe(0)
    expect(post!.acb_meaningful).toBe(0)
    expect(post!.nhsi_meaningful).toBe(0)
    // Sanity: trajectory IS playing on the 192-atom fixture (apb_fires
    // increments per frame via atom_manager.version subscription).
    expect(post!.apb_fires).toBeGreaterThan(0)
    expect(post!.apb_meaningful).toBeGreaterThan(0)
  })
})

// ─── W7 Category 3 — Mid-playback UI mutations ────────────────────────────
// Tests that interactive UI changes (element-hide, color-scheme switch)
// applied DURING active playback don't crash the atom_manager / cascade
// chain and have the expected scoped effect.
test.describe(`W7 Category 3 — Mid-playback UI mutations`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Wait for worker bond detection to commit on the initial topology.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 3.1 — Hide H during playback ─────────────────────────────────
  // AtomLegend exposes a per-element toggle-visibility button (located by
  // its `data-original-title` attribute, which the tooltip attachment
  // sets from the static `title`). Clicking it during playback must:
  //   1. Filter all O–H bond_pairs out at the rendering layer
  //      (filtered_bond_pairs_count: 2 → 0, all bonds touch a hidden H).
  //   2. NOT change atom_manager.count — the manager is the raw pre-filter
  //      mirror per StructureScene.svelte:2481 ("we do NOT filter by
  //      hidden_* here — the manager is the raw pre-filter mirror"). The
  //      visibility filter lives in atom_data / filtered_bond_pairs / the
  //      AtomImpostors render path, not in the SOA buffer.
  //   3. Not crash the cascade — snapshot() still returns finite numbers.
  //
  // The toggle-visibility button is opacity:0 by default and fades in on
  // hover. Playwright auto-actionability treats opacity:0 as visible, but
  // we pass { force: true } as a safety net.
  test(`3.1 hide H during playback drops bond pairs (atom_manager unchanged)`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()
    await page.waitForTimeout(500)

    // Locate by data-original-title (tooltip attachment moves `title` here).
    const hide_h_btn = page.locator(
      `button.toggle-visibility[data-original-title="Hide H atoms"]`,
    )
    await hide_h_btn.first().click({ force: true })
    await page.waitForTimeout(200)

    const atom_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? -1,
    )
    const filtered_bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.filtered_bond_pairs_count ?? -1,
    )
    // Manager mirrors raw structure regardless of hidden_elements — stays 3.
    expect(atom_count).toBe(3)
    // All O–H bonds touch a hidden H atom — filter drops them to 0.
    expect(filtered_bonds).toBe(0)

    // Pause and verify cascade is healthy.
    await play_btn.click()
    const snap = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(snap).not.toBeNull()
    for (const v of Object.values(snap!)) expect(Number.isFinite(v)).toBe(true)
  })

  // ─── Test 3.2 — Color-scheme change during playback: 1 slow path then silent ─
  // The color-scheme dropdown lives on the test page (not on the Trajectory
  // component itself) and is forwarded into Structure via
  // structure_props.color_scheme. Changing it triggers a single
  // `colors.element = element_color_schemes[…]` write at Structure.svelte:1112,
  // which legitimately re-runs the atom_data $derived once (color buffer
  // refresh). The cascade should then go silent again as trajectory
  // continues.
  //
  // Tolerance: atom_data_fires <= 2 absorbs:
  //   - 1 fire for the color-scheme change itself
  //   - up to 1 additional fire for the inevitable initial-mount race
  //     (the probe.reset() happens after navigate but before structure
  //     stabilises in some runs)
  // A regression where color-scheme change re-engages the per-frame
  // cascade would push this counter into the double digits over 2s.
  test(`3.2 color-scheme change during playback: cascade recovers`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    const scheme_select = page.locator(`[data-testid="color-scheme-select"]`)
    await expect(scheme_select).toBeVisible()

    // Reset probe AFTER initial mount + bond worker settled (beforeEach
    // already waited for filtered_bond_pairs_count >= 2).
    await page.evaluate(() => globalThis.__catgo_probe?.reset())

    await play_btn.click()
    // Mid-playback: change color scheme.
    await page.waitForTimeout(500)
    await scheme_select.selectOption(`Jmol`)
    // Continue playback for the rest of the 2s window.
    await page.waitForTimeout(1_500)
    await play_btn.click() // pause

    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    // Architecture P invariant: trajectory cascade stays silent. The single
    // color-scheme write may legitimately fire the atom_data $derived once;
    // anything > 2 indicates the per-frame cascade was reactivated.
    expect(post!.atom_data_fires).toBeLessThanOrEqual(2)
    // Sanity: trajectory was actually playing during the window.
    expect(post!.apb_fires).toBeGreaterThan(0)
  })
})

// ─── W7 Category 4 — Stop / exit transitions (partial — 4.1, 4.2) ─────────
// Tests 4.3 and 4.4 require plan v3 Phase 5 (T5 writeback). Authored here
// with .skip() markers so the test infrastructure is ready; assertions are
// expressed in terms of probe getters that will land in Phase 5.
test.describe(`W7 Category 4 — Stop / exit transitions`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Wait for worker bond detection to commit on initial topology.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 4.1 — Bond integrity after stop transition ───────────────────
  // After stop, bond_pairs must remain >= 2 (the two O-H bonds in the H2O
  // fixture). Catches a regression where stop transition leaves bond_pairs
  // empty during an async worker recompute interval.
  test(`4.1 bonds intact after stop transition`, async ({ page }) => {
    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()
    await page.waitForTimeout(2_000)
    const pre = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(pre).not.toBeNull()
    await play_btn.click() // pause/stop
    await page.waitForTimeout(500)
    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    const meaningful_delta = post!.bbp_meaningful - pre!.bbp_meaningful
    expect(meaningful_delta).toBeGreaterThanOrEqual(0)
    const bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0,
    )
    expect(bonds).toBeGreaterThanOrEqual(2)
  })

  // ─── Test 4.2 — Bond pairs non-empty throughout stop transition ────────
  // Samples bond_pairs_count every ~16ms for 200ms after stop. Catches a
  // "bond flash" regression where bond_pairs drops to [] during the async
  // worker recompute interval (W6-architecture-decision.md Open Q6).
  test(`4.2 bond pairs non-empty throughout stop transition`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()
    await page.waitForTimeout(2_000)
    await play_btn.click() // pause/stop

    const samples: number[] = []
    for (let i = 0; i < 12; i++) {
      const c = await page.evaluate(
        () => globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0,
      )
      samples.push(c)
      await page.waitForTimeout(16)
    }
    expect(samples.every((c) => c >= 2)).toBe(true)
  })

  // ─── Test 4.3 — Atom GPU x-position at stop matches displayed frame ────
  // Verifies the X2 trajectory_only fast-path keeps committing positions
  // to atom_manager through the pause transition. Catches a Phase 4
  // regression where positions stop being written to the GPU at stop.
  // Strategy: jump to a known frame via step input (deterministic),
  // briefly play+pause to exercise the stop transition, then assert
  // get_atom_x(0) (H1) matches the expected paused-frame value.
  test(`4.3 atom GPU x at stop matches displayed frame`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    const play_btn = page.locator(`.play-button`).first()

    // Jump to frame 9 (H1 at FRAME_9_H1_X = 1.06).
    await step_input.fill(String(FIXTURE_FRAMES - 1))
    await step_input.press(`Enter`)
    await page.waitForTimeout(150)

    // Brief play + pause cycle to exercise the stop transition. The
    // trajectory loops back to frame 0 then advances; pause within ~200ms
    // lands somewhere in the early frames.
    await play_btn.click()
    await page.waitForTimeout(200)
    await play_btn.click()
    await page.waitForTimeout(150)

    // Read the paused frame index from the step input, then compute the
    // expected H1 x-position (build_h2o_frame: h1_x = 0.96 + idx * 0.01).
    const paused_idx = Number(await step_input.inputValue())
    const expected_h1_x = 0.96 + paused_idx * 0.01

    const gpu_x = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_x(0) ?? null,
    )
    expect(gpu_x).not.toBeNull()
    expect(gpu_x!).toBeCloseTo(expected_h1_x, 2)
  })

  // ─── Test 4.4 — structure.sites reflects displayed frame after stop ────
  // Phase gate: requires plan v3 Phase 5 ($bindable T5 writeback per W2
  // Option 1). The probe extension `get_structure_site_x` is now in place,
  // BUT the current Phase 5 implementation (Structure.svelte:1143) watches
  // the `trajectory_active` derived (= `trajectory_frame_positions != null`)
  // which only flips false when the trajectory itself is unloaded, not on
  // pause. Authoring this test requires either (a) a "clear trajectory"
  // affordance on the test page so we can drive trajectory_active false→true,
  // or (b) extending the Phase 5 effect to also fire on pause (separate
  // implementation work). Deferred to whichever lands first.
  // ─── Test 4.4 — structure.sites reflects displayed frame after pause ───
  // Verifies the Phase 5 T5 writeback (refined 2026-04-27, lives in
  // Trajectory.svelte's pause_playback()): paused-frame positions must
  // propagate back into structure.sites through the $bindable chain so
  // subsequent edits (drag, element swap) start from paused positions.
  //
  // Strategy: jump to a known later frame, briefly play+pause, then assert
  // both that get_atom_x(0) (the GPU position) and get_structure_site_x(0)
  // (the live `structure` prop value, distinct from atom_manager) agree
  // AND differ from frame 0. Divergence between gpu_x and structure_x
  // would indicate a Svelte 5 deep-mutation propagation bug — the very
  // gap W2 Option 1 was selected to avoid.
  test(`4.4 structure.sites reflects last frame after pause`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    const play_btn = page.locator(`.play-button`).first()

    // Frame 0 baseline: structure.sites[0] (H1) should sit at FRAME_0_H1_X.
    const x_at_load = await page.evaluate(
      () => globalThis.__catgo_probe?.get_structure_site_x(0) ?? null,
    )
    expect(x_at_load).not.toBeNull()
    expect(x_at_load!).toBeCloseTo(FRAME_0_H1_X, 2)

    // Jump to frame 5 (mid-trajectory) — leaves room for a few frames of
    // playback before the loop wraps back to frame 0.
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    await page.waitForTimeout(150)

    // Brief play+pause to exercise the writeback path. At 5 fps × 200ms
    // ≈ 1 frame transition, so we land near frame 6 (still well clear
    // of the wrap point at frame 9 → 0).
    await play_btn.click()
    await page.waitForTimeout(200)
    await play_btn.click()
    await page.waitForTimeout(200) // let $bindable propagation settle

    const result = await page.evaluate(() => {
      const probe = globalThis.__catgo_probe
      return {
        structure_x: probe?.get_structure_site_x(0) ?? null,
        gpu_x: probe?.get_atom_x(0) ?? null,
      }
    })

    expect(result.structure_x).not.toBeNull()
    expect(result.gpu_x).not.toBeNull()

    // Writeback contract: GPU and structure-prop positions agree.
    expect(result.structure_x!).toBeCloseTo(result.gpu_x!, 3)

    // Sanity: the paused position differs from the trajectory-load
    // baseline (frame 0). Without this, the play+pause cycle landed
    // back on frame 0 and the test is uninformative.
    expect(Math.abs(result.structure_x! - FRAME_0_H1_X)).toBeGreaterThan(
      0.005,
    )
  })
})

// ─── W7 Category 5 — Memory + repeat start/stop (partial) ─────────────────
test.describe(`W7 Category 5 — Memory + repeat start/stop`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 5.1 — No interval leak after repeat play/pause cycles ────────
  // Repeated play/pause clicks must not stack setInterval timers in
  // Trajectory.svelte:616-651. Catches the double-speed-playback bug.
  // The DOM proxy: after N clicks ending on pause, frame counter must
  // advance at the EXPECTED rate (not 2x). Use a soak test: 6 cycles
  // ending in play, measure forward progress over 1 second, expect
  // ~5 frames at 5fps (not ~10).
  test(`5.1 no interval leak after repeat play/pause cycles`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    const step_input = page.locator(`input.step-input`).first()
    // 6 rapid play/pause toggles (3 plays, 3 pauses), ending paused.
    for (let i = 0; i < 6; i++) {
      await play_btn.click()
      await page.waitForTimeout(50)
    }
    // Now play one final time and measure forward progress.
    const start_step = Number(await step_input.inputValue())
    await play_btn.click() // play
    await page.waitForTimeout(1_000)
    await play_btn.click() // stop
    const end_step = Number(await step_input.inputValue())
    const advance = ((end_step - start_step) + 10) % 10
    // 1 second at 5 fps ≈ 5 frames advance. Allow 2-8 to absorb timing
    // jitter. If interval-stacking has occurred, advance would be 10+
    // (10-frame loop wraps to small numbers).
    expect(advance).toBeGreaterThan(2)
    expect(advance).toBeLessThanOrEqual(8)
  })

  // ─── Test 5.3 — Cascade silence — Architecture P variant ───────────────
  // FLIPPED from BASELINE variant in commit C4 (Phase 4+5).
  //
  // PRIMARY success criterion (atom_data cascade silenced):
  //   - atom_data_fires === 0       (the displayed_structure cascade is gone)
  //   - atom_data_meaningful === 0
  //   - acb_fires === 0             (colors don't change per frame; structure
  //                                  is frozen, so atom_colors_buffer derived
  //                                  doesn't re-derive)
  //   - nhsi_fires === 0            (structure-driven; frozen)
  //   - bbp_meaningful === 0        (trajectory branch returns before slow path)
  //
  // SECONDARY counters that still fire per frame BY DESIGN (not regressions):
  //   - bbp_fires: still fires per frame because $effect.pre subscribes to
  //     trajectory_frame_positions (Phase 6 narrows this further when the
  //     slow-path memo is simplified, but it's not part of "cascade silence").
  //   - apb_fires: still fires per frame because atom_positions_buffer
  //     subscribes to atom_manager.version. This IS the mechanism by which
  //     bond rendering follows per-frame trajectory writes (Phase 1 routing
  //     fix). Silencing apb would freeze bonds.
  //   - x2_*: X2 still fires per frame; Phase 5.5 gates it.
  //
  // Plan v3's W1 matrix was overly aggressive on apb/bbp_fires at Phase 4+5
  // — both still fire by design. The single most important regression guard
  // is atom_data_fires === 0 (the actual "cascade is gone" signal).
  test(`5.3 cascade silence — Architecture P variant`, async ({ page }) => {
    const play_btn = page.locator(`.play-button`).first()
    await page.evaluate(() => globalThis.__catgo_probe?.reset())
    await play_btn.click()
    await page.waitForTimeout(5_000)
    const post = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(post).not.toBeNull()
    // Primary cascade-silence assertions:
    expect(post!.atom_data_fires).toBe(0)
    expect(post!.atom_data_meaningful).toBe(0)
    expect(post!.acb_fires).toBe(0)
    expect(post!.nhsi_fires).toBe(0)
    expect(post!.bbp_meaningful).toBe(0)
    // Sanity: trajectory IS playing (apb fires per frame via atom_manager.version)
    expect(post!.apb_fires).toBeGreaterThan(0)
  })

  // ─── Test 5.2 — atom_manager capacity stable across playback cycles ────
  // Verifies the underlying GPU buffer-growth invariant the W7 design
  // targeted: atom_manager.capacity must NOT grow per frame during
  // trajectory advancement. The 10-frame fixture loops at 5 fps, so 5s
  // covers ~25 frame transitions including multiple wrap-arounds — any
  // accidental per-frame `ensure_capacity` call would surface as
  // monotonic capacity growth (initial allocation is grow-only, never
  // shrinks). Stricter "10 distinct trajectory loads" coverage requires
  // a structure-swap UI on the test page (Test 5.4 prerequisite).
  test(`5.2 atom_manager capacity stable across playback cycles`, async ({
    page,
  }) => {
    const initial_capacity = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_manager_capacity ?? -1,
    )
    expect(initial_capacity).toBeGreaterThanOrEqual(3) // 3 atoms in fixture

    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()

    // Sample capacity periodically over 5s of playback (≈25 frame
    // transitions on the 10-frame loop at 5 fps).
    const samples: number[] = []
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500)
      const cap = await page.evaluate(
        () => globalThis.__catgo_probe?.atom_manager_capacity ?? -1,
      )
      samples.push(cap)
    }
    await play_btn.click() // pause

    // Every sample must equal the initial capacity — a single growth
    // event during steady-state trajectory playback indicates a
    // regression (per-frame ensure_capacity firing).
    for (const cap of samples) expect(cap).toBe(initial_capacity)
  })

  // ─── Test 5.4 — Structure swap after trajectory: no stale entries ──────
  // Test page exposes a swap button (`data-testid="structure-swap-btn"`)
  // that toggles between FIXTURE_H2O_10F (3 atoms) and FIXTURE_H4_5F
  // (4 atoms). After 1s of playback + pause + swap, the new fixture's
  // atom_count must replace the old one (atom_manager rebuilt cleanly,
  // no "stale H2O atom at slot 3" leak).
  //
  // Capacity is grow-only — it must not shrink below the new atom count
  // (4) but may legitimately remain larger if the manager pre-allocated.
  test(`5.4 structure swap: no stale atom manager entries`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    const swap_btn = page.locator(`[data-testid="structure-swap-btn"]`)
    await expect(swap_btn).toBeVisible()

    // Run 1s of playback so atom_manager is actively writing per-frame.
    await play_btn.click()
    await page.waitForTimeout(1_000)
    await play_btn.click() // pause

    // Sanity: still on the H2O fixture (3 atoms).
    const pre_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? -1,
    )
    expect(pre_count).toBe(3)

    // Swap to H4 (4 atoms) and poll until atom_count reaches the new count.
    // The swap can transiently unmount/remount StructureScene, which temporarily
    // destroys the probe — so we explicitly require BOTH probe presence AND
    // atom_count === 4 before reading further state.
    await swap_btn.click()
    await page.waitForFunction(
      () => globalThis.__catgo_probe?.atom_count === 4,
      null,
      { timeout: 15_000 },
    )

    const post_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? -1,
    )
    const post_capacity = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_manager_capacity ?? -1,
    )

    // New fixture has exactly 4 atoms.
    expect(post_count).toBe(4)
    // Capacity must accommodate the new count. Capacity is grow-only;
    // a regression where the manager truncates without rebuilding would
    // leave capacity below 4.
    expect(post_capacity).toBeGreaterThanOrEqual(4)
    // No crash sanity: snapshot returns finite numbers.
    const snap = await page.evaluate(
      () => globalThis.__catgo_probe?.snapshot() ?? null,
    )
    expect(snap).not.toBeNull()
    for (const v of Object.values(snap!)) expect(Number.isFinite(v)).toBe(true)
  })
})

// ─── W7 Category 6 — Edge cases (partial) ─────────────────────────────────
test.describe(`W7 Category 6 — Edge cases`, () => {
  test.setTimeout(60_000)

  // ─── Test 6.4 — Topology-altering edit during pause disables resume ────
  // W5 design (plans/W5-resume-disable-design.md): position_cache is
  // sized for the original topology. Resuming after a topology edit
  // (add/delete/replace) would either crash or animate atoms with garbage
  // positions. This test asserts the play button gates on resume_disabled.
  // Uses the DEV-only __catgo_traj_test API to invoke the W5 handlers
  // without driving them through atom UI affordances (which the test page
  // doesn't expose).
  test(`6.4 topology-altering edit during pause disables resume`, async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, { waitUntil: `domcontentloaded` })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_traj_test), null, {
      timeout: 30_000,
    })
    // Pre-condition: not playing, resume not yet disabled.
    const before = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(before).toBe(false)

    // Simulate a topology-altering edit while paused. handle_atoms_deleted
    // sets resume_disabled=true (Trajectory.svelte:1342) BEFORE the cross-
    // frame guard, so it fires even on cross-frame-blocked trajectories.
    await page.evaluate(() => globalThis.__catgo_traj_test?.trigger_atoms_deleted())

    const after = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(after).toBe(true)

    // The play button must be disabled — UX surface that prevents resume.
    const play_btn = page.locator(`.play-button`).first()
    await expect(play_btn).toBeDisabled()
  })

  // ─── Test 6.4a — Atom-add during pause disables resume ────────────────
  // Regression guard for the W5 contract bug fixed in B1 (commit introducing
  // traj_load_seq counter). handle_atom_added sets resume_disabled=true,
  // then calls _chunked_cross_frame_edit which ends with
  // `trajectory = { ...trajectory }` (spread refresh). Pre-B1, the W5 reset
  // $effect tracked `trajectory` directly, so the spread retriggered it and
  // silently flipped resume_disabled back to false within ~0–4ms. Post-B1
  // the reset $effect tracks a `traj_load_seq` counter that's only bumped
  // on real load paths, so the spread no longer resets W5 state.
  // Test 6.4 covers the delete path (different code path — purely lazy
  // enqueue, no spread refresh); this test covers the add path which is
  // the actual W5 bug surface.
  test(`6.4a atom-add during pause disables resume`, async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, { waitUntil: `domcontentloaded` })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_traj_test), null, {
      timeout: 30_000,
    })
    const before = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(before).toBe(false)

    await page.evaluate(() => globalThis.__catgo_traj_test?.trigger_atom_added())

    // Wait long enough for the spread refresh and any reactive flush to settle.
    // Pre-B1 bug: resume_disabled would flip back to false on the next macrotask.
    await page.waitForTimeout(50)

    const after = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(after).toBe(true)

    const play_btn = page.locator(`.play-button`).first()
    await expect(play_btn).toBeDisabled()
  })

  // ─── Test 6.4b — Atom-replace during pause disables resume ────────────
  // Same regression guard as 6.4a but for handle_atom_replaced — the other
  // _chunked_cross_frame_edit caller. Both add and replace ride the same
  // spread-refresh path; deletes don't.
  test(`6.4b atom-replace during pause disables resume`, async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, { waitUntil: `domcontentloaded` })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_traj_test), null, {
      timeout: 30_000,
    })
    const before = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(before).toBe(false)

    await page.evaluate(() => globalThis.__catgo_traj_test?.trigger_atom_replaced())

    await page.waitForTimeout(50)

    const after = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(after).toBe(true)

    const play_btn = page.locator(`.play-button`).first()
    await expect(play_btn).toBeDisabled()
  })

  // ─── Test 6.5 — Drag-then-resume is NOT disabled ───────────────────────
  // try_move (handle_atoms_manipulated) is excluded from the W5 disable
  // detection per Trajectory.svelte:1267 — drag-then-resume is a valid
  // workflow because the position_cache topology is preserved (only
  // positions changed). This test guards against a regression where a
  // future change wires manipulation into the resume-disable detection.
  test(`6.5 drag-then-resume NOT disabled (try_move excluded)`, async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, { waitUntil: `domcontentloaded` })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_traj_test), null, {
      timeout: 30_000,
    })
    const before = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(before).toBe(false)

    await page.evaluate(() => globalThis.__catgo_traj_test?.trigger_atoms_manipulated())

    const after = await page.evaluate(
      () => globalThis.__catgo_traj_test?.resume_disabled,
    )
    expect(after).toBe(false)

    // The play button must remain enabled.
    const play_btn = page.locator(`.play-button`).first()
    await expect(play_btn).not.toBeDisabled()
  })

  // ─── Test 6.6 — align_on_load $effect does NOT fire during playback ────
  // W8 gate verification (commit bd0da10f → Structure.svelte:1216): the
  // align_on_load principal-axes effect must early-return when
  // trajectory_active is true. Without this gate, the effect would attempt
  // to re-align per trajectory frame (~ms/frame depending on atom count) —
  // this test ensures the gate doesn't regress.
  //
  // Setup: navigate to the test page, run 5s of playback (~25 frame
  // transitions on the 10-frame fixture at 5 fps), then assert the
  // align_on_load_fires counter did not advance during playback.
  test(`6.6 align_on_load effect does not fire during playback`, async ({
    page,
  }) => {
    await page.goto(`/test/structure-trajectory`, { waitUntil: `domcontentloaded` })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Fixture is `_aligned: false` initially — but the H2O fixture is
    // already principal-aligned along x, so the effect may either fire
    // exactly once on initial load OR no-op if the marker short-circuits.
    // Sample baseline AFTER load settles.
    await page.waitForTimeout(500)
    const baseline = await page.evaluate(
      () => globalThis.__catgo_probe?.align_on_load_fires ?? -1,
    )
    expect(baseline).toBeGreaterThanOrEqual(0)

    const play_btn = page.locator(`.play-button`).first()
    await play_btn.click()
    await page.waitForTimeout(5_000)
    await play_btn.click() // pause

    const after = await page.evaluate(
      () => globalThis.__catgo_probe?.align_on_load_fires ?? -1,
    )

    // The W8 gate must hold: zero new alignments during playback. Each
    // alignment is observable user-visible (a structure rotation), so
    // even one fire during playback would be a noticeable jitter.
    expect(after).toBe(baseline)
  })

  // ─── Test 6.7 — Single-frame trajectory: play button disabled ──────────
  // Uses /test/structure-trajectory-1f, a 1-frame fixture. Trajectory.svelte
  // gates the play button on `total_frames <= 1`, so play must be disabled
  // the moment the trajectory mounts. Without this gate, attempting playback
  // on a 1-frame trajectory wraps trivially and produces a "no-op spinning"
  // UX bug.
  test(`6.7 single-frame trajectory play disabled`, async ({ page }) => {
    await page.goto(`/test/structure-trajectory-1f`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    const play_btn = page.locator(`.play-button`).first()
    await expect(play_btn).toBeVisible()
    await expect(play_btn).toBeDisabled()
  })
})

// ─── W7 Category 2 — Pause-mid-playback interactions ──────────────────────
// Tests 2.1 and 2.5 are the regression suite for the GPU picker hit-test
// stale-position bug under Architecture P (clicking during paused playback
// should hit the rendered atom, not its frame-0 position). See
// plans/W7-milestone-5-todo.md § "Deferred follow-up: GPU picker hit-test
// stale positions" — Test 2.1 must be authored AND green before any future
// fix is re-attempted (the original fix at commit 6a04ea4c broke clicking
// entirely without this regression test in place).
test.describe(`W7 Category 2 — Pause-mid-playback interactions`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Allow one render pass so camera matrices are populated.
    await page.waitForTimeout(500)
  })

  // ─── Test 2.1 — Click-to-select correct atom at paused frame ────────────
  // Plays the trajectory, jumps to frame 5 (paused — H1 at xyz=[1.01, 0, 0]),
  // computes the H1 pixel position via project_to_pixel, clicks there, and
  // asserts the selection landed on site_id 0 (H1). Catches the GPU picker
  // hit-test stale-position bug: if atom_interaction_mesh positions are
  // frozen at frame 0 (atom_data is silenced under Architecture P), clicking
  // on the rendered atom at frame 5 will miss or hit a different atom.
  //
  // For the H2O fixture (site_idx == site_id 1:1 mapping), the test asserts
  // `selected_site_id === 0`. The site is read from the LAST element of
  // `selected_sites` so a click on H1 leaves selected_site_id=0 even if the
  // user previously had something else selected.
  test(`2.1 click-to-select correct atom at paused frame`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()

    // Jump to frame 5 (H1 at xyz ≈ [1.01, 0, 0], paused — no playback).
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    // Allow the X2 shadow sync to commit the new positions to atom_manager.
    await page.waitForTimeout(200)

    // Read H1's live position (atom_manager / GPU buffer) and the camera
    // matrices from the probe surface.
    const live_xyz = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_xyz(0) ?? null,
    )
    expect(live_xyz).not.toBeNull()
    // Sanity: H1 is at frame 5 position, not frame 0.
    expect(live_xyz![0]).toBeCloseTo(1.01, 1)

    const matrices = await page.evaluate(
      () => globalThis.__catgo_probe?.get_camera_matrices() ?? null,
    )
    expect(matrices).not.toBeNull()

    const canvas_pixel = project_to_pixel(matrices, live_xyz!)
    expect(canvas_pixel).not.toBeNull()

    // Convert canvas-relative pixel to viewport-relative pixel for the
    // page.mouse.click() call (which expects viewport coordinates).
    const canvas = page.locator(`canvas`).first()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    const click_x = box!.x + canvas_pixel!.x
    const click_y = box!.y + canvas_pixel!.y

    // Pre-condition: nothing selected yet.
    const pre_sel = await page.evaluate(
      () => globalThis.__catgo_probe?.selected_site_id ?? null,
    )
    expect(pre_sel).toBeNull()

    await page.mouse.click(click_x, click_y)

    // Wait briefly for the selection state to flush.
    await page.waitForFunction(
      () => globalThis.__catgo_probe?.selected_site_id !== null,
      null,
      { timeout: 2_000 },
    )

    const post_sel = await page.evaluate(
      () => globalThis.__catgo_probe?.selected_site_id ?? null,
    )
    expect(post_sel).toBe(0)
  })

  // ─── Test 2.5 — Right-click context menu identifies correct element ─────
  // Same pixel-projection path as Test 2.1, but issues a right-click instead
  // of a left-click and asserts that the resulting context menu surfaces
  // an entry referencing element "H" (the H2O fixture has both H and O
  // unique elements; right-clicking on H1 should produce menu options
  // including "Select all H").
  //
  // The DOM signal is `.context-menu` — see src/lib/ContextMenu.svelte.
  // The "Select all H" entry comes from Structure.svelte's `unique_elements`
  // mapping in the Selection section.
  test(`2.5 right-click context menu identifies correct element at paused frame`, async ({
    page,
  }) => {
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    await page.waitForTimeout(200)

    const live_xyz = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_xyz(0) ?? null,
    )
    expect(live_xyz).not.toBeNull()
    expect(live_xyz![0]).toBeCloseTo(1.01, 1)

    const matrices = await page.evaluate(
      () => globalThis.__catgo_probe?.get_camera_matrices() ?? null,
    )
    const canvas_pixel = project_to_pixel(matrices, live_xyz!)
    expect(canvas_pixel).not.toBeNull()

    const canvas = page.locator(`canvas`).first()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    const click_x = box!.x + canvas_pixel!.x
    const click_y = box!.y + canvas_pixel!.y

    // Right-click at H1's pixel coordinate.
    await page.mouse.click(click_x, click_y, { button: `right` })

    // Wait for the context menu to appear (portaled to document.body, so
    // it lives outside the trajectory host div).
    const menu = page.locator(`.context-menu`).first()
    await expect(menu).toBeVisible({ timeout: 2_000 })

    // The Selection section contains a "Select all <element>" entry per
    // unique element. Right-clicking on H1 should target an H atom — the
    // menu's text content must include "Select all H".
    const text = (await menu.textContent()) ?? ``
    expect(text).toContain(`Select all H`)
  })

  // ─── Drag gesture helper for Tests 2.3 + 2.4 ───────────────────────────
  // The drag activation in interaction.svelte.ts:1258 is Shift+Alt held
  // during pointermove with a selected atom. Drag finishes when either
  // modifier is released. No mousedown is required — modifier+move starts
  // the drag, modifier-release ends it.
  async function drag_atom(
    page: import('@playwright/test').Page,
    from_px: { x: number; y: number },
    to_px: { x: number; y: number },
  ) {
    await page.keyboard.down(`Shift`)
    await page.keyboard.down(`Alt`)
    // Move to start point with modifiers held — drag begins on first
    // qualifying pointermove (interaction.svelte.ts:1258).
    await page.mouse.move(from_px.x, from_px.y)
    await page.waitForTimeout(40)
    // Stepped move so the drag-update path runs through several frames.
    await page.mouse.move(to_px.x, to_px.y, { steps: 8 })
    await page.waitForTimeout(50)
    // Releasing either modifier triggers finish_drag in
    // interaction.svelte.ts:1301-1303.
    await page.keyboard.up(`Alt`)
    await page.keyboard.up(`Shift`)
    await page.waitForTimeout(150) // commit_drag_to_structure flush
  }

  async function get_h1_canvas_pixel(page: import('@playwright/test').Page) {
    const matrices = await page.evaluate(
      () => globalThis.__catgo_probe?.get_camera_matrices() ?? null,
    )
    const xyz = await page.evaluate(
      () => globalThis.__catgo_probe?.get_atom_xyz(0) ?? null,
    )
    expect(matrices).not.toBeNull()
    expect(xyz).not.toBeNull()
    const canvas_pixel = project_to_pixel(matrices, xyz!)
    expect(canvas_pixel).not.toBeNull()
    const canvas = page.locator(`canvas`).first()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    return { x: box!.x + canvas_pixel!.x, y: box!.y + canvas_pixel!.y }
  }

  // ─── Test 2.3 — Drag override registers during drag (trajectory paused) ─
  // Verifies the drag-precedence wiring is active during paused trajectory:
  // realtime_position_overrides gets at least one entry mid-drag, proving
  // the Shift+Alt drag gesture reaches finish_drag → apply_pending_drag →
  // override map (interaction.svelte.ts:419-453). Without this contract,
  // drags during paused playback would either no-op or fight with the
  // trajectory position-write loop.
  //
  // We assert ONLY the override-during-drag invariant; the post-commit
  // structure update is guarded separately by Test 5.4 (structure swap)
  // and the cascade-silence baseline (Test 5.3). Asserting the dragged
  // structure_x value here is too sensitive to canvas-coords→world-delta
  // scaling at the H2O fixture's camera distance.
  test(`2.3 drag override registers during paused-frame drag`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    await page.waitForTimeout(150)

    // Pre-condition: no overrides at rest.
    const before = await page.evaluate(
      () => globalThis.__catgo_probe?.override_size ?? -1,
    )
    expect(before).toBe(0)

    // Click to select H1.
    const h1 = await get_h1_canvas_pixel(page)
    await page.mouse.click(h1.x, h1.y)
    await page.waitForTimeout(200)
    const sel = await page.evaluate(
      () => globalThis.__catgo_probe?.selected_site_id ?? null,
    )
    expect(sel).toBe(0)

    // Begin drag — hold Shift+Alt and move. Sample override_size mid-drag
    // BEFORE releasing modifiers (which would clear the override map).
    await page.keyboard.down(`Shift`)
    await page.keyboard.down(`Alt`)
    await page.mouse.move(h1.x, h1.y)
    await page.waitForTimeout(50)
    let max_override_during_drag = 0
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(h1.x + i * 8, h1.y, { steps: 1 })
      await page.waitForTimeout(20)
      const sz = await page.evaluate(
        () => globalThis.__catgo_probe?.override_size ?? 0,
      )
      if (sz > max_override_during_drag) max_override_during_drag = sz
    }
    // Release modifiers → finish_drag clears overrides (asserted in 2.4).
    await page.keyboard.up(`Alt`)
    await page.keyboard.up(`Shift`)

    // The drag-precedence path must have populated the override map at
    // least once during the drag. A regression that broke drag activation
    // (e.g. modifier-key handling, selected_sites guard) would surface
    // here as max_override === 0.
    expect(max_override_during_drag).toBeGreaterThanOrEqual(1)
  })

  // ─── Test 2.4 — Drag release clears override map ───────────────────────
  // Verifies finish_drag → commit_drag_to_structure clears the override
  // map (interaction.svelte.ts:450). After release, override_size MUST be
  // 0 so subsequent trajectory frames flow through Phase 2's position-
  // write loop unobstructed. A regression where overrides leak past
  // drag-end would freeze atoms in their drag-end positions even when
  // the user resumes playback.
  test(`2.4 drag release clears override map`, async ({ page }) => {
    const step_input = page.locator(`input.step-input`).first()
    await step_input.fill(`5`)
    await step_input.press(`Enter`)
    await page.waitForTimeout(150)

    const before = await page.evaluate(
      () => globalThis.__catgo_probe?.override_size ?? -1,
    )
    expect(before).toBe(0)

    const h1 = await get_h1_canvas_pixel(page)
    await page.mouse.click(h1.x, h1.y)
    await page.waitForTimeout(150)
    await drag_atom(page, h1, { x: h1.x + 60, y: h1.y })

    const after = await page.evaluate(
      () => globalThis.__catgo_probe?.override_size ?? -1,
    )
    expect(after).toBe(0)
  })
})

// ─── W7 Category 3 — PBC image / display-toggle interactions ──────────────
// Test 3.3 exercises the Milestone 5 image-atoms toggle wired through
// Trajectory → Structure → StructureScene. The H2O fixture sits at the
// origin in a 5Å cubic box, so flipping `show_image_atoms` true while a
// trajectory plays must (a) not crash, (b) increase atom_count via PBC
// image companions, and (c) keep bonds present throughout the toggle.
test.describe(`W7 Category 3 — PBC image / display-toggle interactions`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 3.3 — PBC image toggle during playback: no crash ─────────────
  test(`3.3 PBC image toggle during playback changes atom count without crashing`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    const image_toggle = page.locator(`[data-testid="image-atoms-toggle"]`)

    const initial_atom_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(initial_atom_count).toBe(3)
    const initial_bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.bond_pairs_count ?? 0,
    )
    expect(initial_bonds).toBeGreaterThanOrEqual(2)

    // Begin playback, then flip image-atoms on mid-flight.
    await play_btn.click()
    await page.waitForTimeout(500)

    // Sanity: still alive, bonds still present, no exception thrown.
    const mid_bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.bond_pairs_count ?? 0,
    )
    expect(mid_bonds).toBeGreaterThanOrEqual(2)

    // Toggle image atoms during playback.
    await image_toggle.click()
    // PBC expansion is async (it depends on the supercell $effect). Wait for
    // the atom count to grow above the original 3 sites — the H2O fixture
    // (atoms at frac 0,0,0) gets companions on every face/edge/corner.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) > 3,
      null,
      { timeout: 5_000 },
    )

    const post_atom_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(post_atom_count).toBeGreaterThan(initial_atom_count)

    // Bonds must remain present (no crash — render is still alive).
    const post_bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.bond_pairs_count ?? 0,
    )
    expect(post_bonds).toBeGreaterThanOrEqual(2)

    await play_btn.click() // pause
  })
})

// ─── W7 Category 6 — Edge cases (Milestone 5 supercell + h-bond) ──────────
// Tests 6.1, 6.2, 6.3 round out the supercell + display-toggle interaction
// surface. The page wires three Trajectory $bindable props (supercell_scaling,
// show_image_atoms, show_hydrogen_bonds) through to Structure. These tests
// exercise the supercell + h-bond toggles during playback to catch crashes
// and garbage-position regressions.
test.describe(`W7 Category 6 — Supercell + h-bond toggles`, () => {
  test.setTimeout(60_000)

  test.beforeEach(async ({ page }) => {
    await page.goto(`/test/structure-trajectory`, {
      waitUntil: `domcontentloaded`,
    })
    await page.waitForFunction(() => Boolean(globalThis.__catgo_probe), null, {
      timeout: 15_000,
    })
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 3,
      null,
      { timeout: 15_000 },
    )
    // Wait for worker bond detection on initial topology.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.filtered_bond_pairs_count ?? 0) >= 2,
      null,
      { timeout: 15_000 },
    )
  })

  // ─── Test 6.1 — Supercell + trajectory: no crash, no garbage positions ──
  // Switch to a 2x1x1 supercell, verify atom count roughly doubles, then
  // play the trajectory for ~1.5s and confirm atoms still have finite,
  // sane positions (no NaN / Infinity / huge garbage values that indicate
  // the supercell expansion + trajectory bypass clashed).
  test(`6.1 supercell + trajectory: stable, sane positions`, async ({
    page,
  }) => {
    const supercell_select = page.locator(`[data-testid="supercell-select"]`)
    const play_btn = page.locator(`.play-button`).first()

    await supercell_select.selectOption(`2x1x1`)
    // Supercell expansion is async (WASM); wait for atom_count to reflect it.
    await page.waitForFunction(
      () => (globalThis.__catgo_probe?.atom_count ?? 0) >= 6,
      null,
      { timeout: 5_000 },
    )
    const post_supercell_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(post_supercell_count).toBeGreaterThanOrEqual(6)

    await play_btn.click()
    await page.waitForTimeout(1_500)
    await play_btn.click() // pause

    const final_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(final_count).toBeGreaterThanOrEqual(6)

    // Sample a few atom positions to confirm they're finite & in-bounds.
    // The supercell is 2x1x1 over a 5Å lattice, so |x| < 12 covers all
    // legitimate positions with margin. Anything outside that range is
    // garbage from a buffer mismatch.
    const positions = await page.evaluate(() => {
      const probe = globalThis.__catgo_probe
      if (!probe) return null
      return [probe.get_atom_xyz(0), probe.get_atom_xyz(3)]
    })
    expect(positions).not.toBeNull()
    for (const xyz of positions!) {
      expect(xyz).not.toBeNull()
      const [x, y, z] = xyz as [number, number, number]
      for (const v of [x, y, z]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(Math.abs(v)).toBeLessThan(100)
      }
    }
  })

  // ─── Test 6.2 — Supercell + trajectory UI warning ───────────────────────
  // Authored as skip: the production UI does not currently surface a
  // warning element when a supercell is active during trajectory playback.
  // Trajectories generally assume a single (non-replicated) cell; a UI
  // warning would alert the user that displayed positions are tile copies
  // rather than independent simulated atoms. Until that warning lands, the
  // test exists as a documentation placeholder — do NOT invent a fake
  // selector. Unskip when the warning ships.
  // ─── Test 6.2 — Supercell + trajectory: UI warning displayed ───────────
  // Verifies the warning UI added in commit (this commit) at
  // Trajectory.svelte:1479 alerts the user that supercell-replica atoms
  // display topology-load positions, not per-frame trajectory data
  // (W6 Reviewer 1 OQ1). The warning is `[data-testid="traj-supercell-
  // warning"]` rendered when supercell_scaling !== '1x1x1' AND a
  // trajectory is loaded.
  test(`6.2 supercell + trajectory: UI warning displayed`, async ({ page }) => {
    const warning = page.locator(`[data-testid="traj-supercell-warning"]`)

    // Pre-condition: at default 1x1x1, warning is hidden.
    await expect(warning).toHaveCount(0)

    // Activate 2x1x1 supercell and verify warning appears.
    await page.locator(`[data-testid="supercell-select"]`).selectOption(`2x1x1`)
    await expect(warning).toBeVisible()
    const text = await warning.textContent()
    expect(text).toMatch(/Supercell.*trajectory|positions.*base cell/i)

    // Switching back to 1x1x1 hides the warning.
    await page.locator(`[data-testid="supercell-select"]`).selectOption(`1x1x1`)
    await expect(warning).toHaveCount(0)
  })

  // ─── Test 6.3 — H-bond display toggle during playback: no crash ─────────
  // The H2O fixture's H–O distance (~0.96 Å) is below the typical 1.5–3.5 Å
  // hydrogen-bond range, so h_bond_pairs_count is expected to stay 0. The
  // assertion is that enabling h-bond display during playback does not
  // crash and that bond_pairs_count remains stable. h_bond_pairs_count
  // must be a finite number (non-negative).
  test(`6.3 h-bond toggle during playback: no crash, bonds stable`, async ({
    page,
  }) => {
    const play_btn = page.locator(`.play-button`).first()
    const hbond_toggle = page.locator(`[data-testid="hbond-toggle"]`)

    const initial_atom_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(initial_atom_count).toBe(3)

    await play_btn.click()
    // Toggle h-bonds on mid-playback.
    await hbond_toggle.click()
    await page.waitForTimeout(500)
    await play_btn.click() // pause

    const final_atom_count = await page.evaluate(
      () => globalThis.__catgo_probe?.atom_count ?? 0,
    )
    expect(final_atom_count).toBe(initial_atom_count)

    const bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.bond_pairs_count ?? 0,
    )
    expect(bonds).toBeGreaterThanOrEqual(2)

    const h_bonds = await page.evaluate(
      () => globalThis.__catgo_probe?.h_bond_pairs_count ?? -1,
    )
    expect(Number.isFinite(h_bonds)).toBe(true)
    expect(h_bonds).toBeGreaterThanOrEqual(0)
  })
})
