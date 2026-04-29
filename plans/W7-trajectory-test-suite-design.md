# W7 — Trajectory Regression Test Suite Design

**Branch baseline:** atom-soa-refactor @ 29420f91 (patch baseline) and bd0da10f (current HEAD).
**Status:** PROPOSED — needs implementation work before plan v3 can begin
**Inputs:** plans/W6-architecture-decision.md, plans/W6-review-sequencing.md, plans/W6-review-completeness.md
**Estimated implementation effort:** 14–18 hours across 4–5 sessions

## Purpose

W7 exists because the trajectory-bypass refactor's "no behavioral change" claim is otherwise unverifiable. The patch stack at commit 29420f91 delivered 340ms → 18ms/frame by adding five categories of fast-path memos and branch guards across `StructureScene.svelte`, `bond-computation-controller.svelte.ts`, and `src/lib/trajectory/Trajectory.svelte`. Plan v3 (Architecture P) will delete all five patch categories. Without a test suite that runs green on 29420f91 and specifies exactly what must remain green after each plan v3 phase, every phase is flying blind.

W7 protects:

1. **Trajectory playback correctness** — atoms advance to correct GPU positions per frame; bonds follow; frame counter increments; playback loops.
2. **Pause-mid-playback interactions** — click-to-select, atom drag, and context menu target the paused-frame atom positions, not frame-0 positions.
3. **During-playback interactions** — element hide, color-scheme change, and PBC-image toggle during active playback do not corrupt the atom manager or freeze bonds.
4. **Stop / exit transitions** — stopping triggers exactly one bond re-detect without a perceptible flash; atom GPU positions at stop match the last displayed frame.
5. **Memory stability** — repeated start/stop cycles do not leak intervals, GPU buffers, or version-bump cascades.
6. **Edge cases** — supercell + trajectory (LB1 guard), vibration/trajectory mutual exclusion, h-bond display, charge-label non-crash, resume-disable after topology edits.
7. **Visual regression** — per-frame screenshot diffs catch position artifacts, missing bonds, and render flicker.
8. **Performance regression** — cascade-fire-count probe asserts the fast-path is active, not the slow path.

W7 is a **pre-Phase-0 gate** per `plans/trajectory-bypass-refactor-todo.md` line 155. `plans/W6-review-completeness.md` Finding #4 (lines 66–72) states: "Each phase description must name the specific W7 test scenarios that must pass." The per-phase gate matrix in this document fulfills that requirement.

---

## Existing test infrastructure

### Playwright configuration

**File:** `/Users/jenedithpascasio/CatGo/playwright.config.ts` (lines 1–13)

```typescript
webServer: { command: `vite dev --port 3005`, port: 3005, reuseExistingServer: true }
workers: 8
timeout: 15_000   // 15s global per-test — INSUFFICIENT for trajectory playback tests
testDir: `tests/playwright`
maxFailures: 1
```

**Gap 1:** The 15-second global timeout will be exceeded by tests that wait 3–5 seconds for playback. The W7 test file must call `test.setTimeout(60_000)` inside the `describe` block.

**Gap 2:** No `use: { browserName }` is specified. Default is Chromium. Chromium is the correct and sufficient target — Tauri's WKWebView is covered by physical device testing, not this suite.

### Existing Playwright test files

**`tests/playwright/trajectory.test.ts`** (confirmed, ~700 lines) — tests `src/lib/trajectory/Trajectory.svelte` (the viewer component with scatter plot + step controls). The test page is `src/routes/test/trajectory/+page.svelte` (confirmed). Tests cover: step counter DOM, play button text, FPS slider attributes, info pane visibility, layout CSS class, keyboard shortcuts.

This file does **not** test:
- 3D atom positions in the Three.js canvas
- Bond rendering during playback
- `atom_manager` GPU buffer state
- `trajectory_frame_positions` fast-path activation or cascade silence
- Any interaction (drag, click-to-select, context menu, element hide) during trajectory

The existing `trajectory.test.ts` is entirely reusable and does not conflict with W7. W7 adds a separate file for the structure-3D + trajectory integration.

**`tests/playwright/structure.test.ts`** — does not exist (read attempt failed). The structure test page `src/routes/test/structure/+page.svelte` (confirmed, 268 lines) exposes `bind:supercell_scaling`, `bind:selected_sites`, `bind:show_image_atoms`, and `globalThis.event_calls` (`src/routes/test/structure/+page.svelte:130`).

**No existing test exercises the StructureScene.svelte + trajectory integration.** No test file:
- Loads a multi-frame trajectory into `Structure.svelte`
- Verifies 3D atom positions change between frames
- Tests drag-during-playback or pause-and-edit
- Asserts cascade silence via `globalThis.__catgo_probe`

### What is reusable

- `playwright.config.ts` as-is (with per-test timeout override in the new file)
- The inline fixture pattern from `src/routes/test/trajectory/+page.svelte:8–94` (structures defined as `$state` objects, no file dependency)
- The `globalThis.event_calls` probe pattern at `src/routes/test/structure/+page.svelte:130`
- The `data-testid` attribute convention

### What must be created

1. `tests/playwright/structure-trajectory.test.ts` — the W7 test file
2. `src/routes/test/structure-trajectory/+page.svelte` — the W7 test page
3. `globalThis.__catgo_probe` mechanism in `StructureScene.svelte` (W1 regression detector, Phase 0 deliverable)
4. The inline fixture `FIXTURE_H2O_10F` (10 frames × 3 atoms, defined in the test page)
5. The inline fixture `FIXTURE_192A_20F` (20 frames × 192 atoms, Milestone 4)
6. `tests/playwright/snapshots/` directory for Category 7 baseline screenshots

---

## Test fixture requirements

### Fixture 1: FIXTURE_H2O_10F (primary fixture)

**Format:** Array of `AnyStructure` objects defined inline in the test page's `<script>` block. No XYZ file dependency.

**Size:** 10 frames × 3 atoms = 30 `Site` objects. Negligible memory.

**Content spec:**
- Atoms: O at (0, 0, 0) in all frames; H1 at x = 0.96 + frame × 0.01 Å (x=0.96 at frame 0, x=1.06 at frame 9); H2 mirrors (x = −0.96 − frame × 0.01 Å).
- Lattice: 5×5×5 Å cubic, `pbc: [true, true, true]`.
- Both O–H bonds (≈0.96–1.06 Å) exist in every frame.
- Known constants for assertions: `FRAME_0_H1_X = 0.96`, `FRAME_5_H1_X = 1.01`, `FRAME_7_H1_X = 1.03`, `FRAME_9_H1_X = 1.06`.

**Rationale for inline:** Follows the established pattern at `src/routes/test/trajectory/+page.svelte:8–94`. Keeps the fixture co-located with the test page, readable, and independent of format parsers.

**Does the file exist?** No. Created in Milestone 1.

### Fixture 2: FIXTURE_192A_20F (performance fixture)

**Format:** Same — inline in the test page, generated by a deterministic loop.

**Size:** 20 frames × 192 atoms. Generate as 64 water molecules (3 atoms each) placed in a 4×4×4 grid. Per-frame position perturbation: `x += 0.05 × sin(frame × 0.3 + atom_idx × 0.7)`. This produces visually animated atom positions without needing a real MD trajectory.

**Purpose:** Category 8 performance tests only. 192 atoms is large enough to reveal O(N) cost differences between fast-path and slow-path while staying well below the ~1,000-atom sync-fallback threshold in `bond-worker-api.ts:29`.

**Does the file exist?** No. Created in Milestone 4.

### Fixture 3: supercell from mp-1.json

No new file. Use `src/site/structures/mp-1.json` (already confirmed in `src/routes/test/structure/+page.svelte:4`) via the `data_url` or direct import. Apply `supercell_scaling = '2x1x1'` via the test page's `supercell_scaling` state.

---

## Test categories

### Category 1: Trajectory plays smoothly (baseline)

**Coverage goal:** Verify atoms advance to correct GPU positions per frame; frame counter increments; bonds exist on each frame; playback loops; stop freezes the counter.

**Number of test cases:** 5

---

**Test 1.1 — Frame counter advances during playback**

Actions: Load `FIXTURE_H2O_10F`. Click `[data-testid="play-btn"]`. Wait 3 seconds at 5 fps.

Assertions: `[data-testid="traj-frame-counter"]` text is not `"0"` after 3 seconds.

Verification:
```typescript
await expect(page.locator('[data-testid="traj-frame-counter"]')).not.toHaveText('0', { timeout: 5000 })
```

Phase gate: pre-Phase-0 baseline.

---

**Test 1.2 — Atom GPU x-position differs between frame 0 and frame 9**

Actions: Navigate to frame 0. Read `globalThis.__catgo_probe.get_atom_x(0)`. Navigate to frame 9. Read again.

Assertions: `|pos_f9 − pos_f0| > 0.05` (H1 displaced by fixture design from 0.96 to 1.06 Å).

Verification:
```typescript
const pos_f0 = await page.evaluate(() => (globalThis as any).__catgo_probe?.get_atom_x(0))
await page.locator('[data-testid="step-input"]').fill('9')
await page.locator('[data-testid="step-input"]').press('Enter')
const pos_f9 = await page.evaluate(() => (globalThis as any).__catgo_probe?.get_atom_x(0))
expect(Math.abs(pos_f9 - pos_f0)).toBeGreaterThan(0.05)
```

W6 finding: confirms `trajectory_only` fast-path at `StructureScene.svelte:2348` is updating GPU positions.

Phase gate: Phase 2 (position-write loop active).

---

**Test 1.3 — Bond count ≥ 2 on both frame 0 and frame 9**

Actions: Navigate to frame 0, read `__catgo_probe.bond_pairs_count`. Navigate to frame 9, read again.

Assertions: `count >= 2` on both frames (two O–H bonds in the fixture).

Verification:
```typescript
const count_f0 = await page.evaluate(() => (globalThis as any).__catgo_probe?.bond_pairs_count)
// navigate to frame 9 ...
const count_f9 = await page.evaluate(() => (globalThis as any).__catgo_probe?.bond_pairs_count)
expect(count_f0).toBeGreaterThanOrEqual(2)
expect(count_f9).toBeGreaterThanOrEqual(2)
```

W6 finding: catches the Phase 3 bond-freeze regression from `plans/W6-review-sequencing.md` lines 49–56 — the `stable` memo missing `trajectory_frame_positions` tracking.

Phase gate: Phase 3.

---

**Test 1.4 — Playback loops at least once in 2.5 seconds at 5 fps**

Actions: Start playback. Wait 2.5 seconds (≥12 frames — enough to complete the 10-frame loop).

Assertions: `__catgo_probe.loop_count >= 1`.

Verification:
```typescript
await page.locator('[data-testid="play-btn"]').click()
await page.waitForTimeout(2500)
const loops = await page.evaluate(() => (globalThis as any).__catgo_probe?.loop_count)
expect(loops).toBeGreaterThanOrEqual(1)
```

Phase gate: Phase 2.

---

**Test 1.5 — Stop freezes frame counter**

Actions: Start playback. Wait 1 second. Stop. Record frame N. Wait 1 more second.

Assertions: Frame counter unchanged after stop.

Verification:
```typescript
// start, wait 1s, stop
const n1 = await page.evaluate(() => (globalThis as any).__catgo_probe?.current_step)
await page.waitForTimeout(1000)
const n2 = await page.evaluate(() => (globalThis as any).__catgo_probe?.current_step)
expect(n2).toBe(n1)
```

Phase gate: Phase 2.

---

### Category 2: Pause-mid-playback interactions

**Coverage goal:** Verify pause preserves paused-frame atom positions for selection, drag, and context menu.

**Number of test cases:** 5

---

**Test 2.1 — Click-to-select targets correct atom at paused frame**

Actions: Navigate to frame 5 (H1 at x=1.01, displaced from frame-0 position x=0.96). Compute H1's pixel coordinates from `__catgo_probe.camera_matrix` + known xyz. Click that pixel.

Assertions: `__catgo_probe.selected_sites` contains index 0 (H1), not index 2 (O at canvas center).

Verification:
```typescript
const cam = await page.evaluate(() => (globalThis as any).__catgo_probe?.get_camera_matrices())
const px = project_to_pixel(cam, [FRAME_5_H1_X, 0, 0])  // helper in test file
await page.mouse.click(px.x, px.y)
const sel = await page.evaluate(() => (globalThis as any).__catgo_probe?.selected_sites)
expect(sel).toContain(0)
```

W6 finding: catch stale hit-test that uses frame-0 positions.

Phase gate: Phase 2.

---

**Test 2.2 — Drag starts at paused frame (override map non-empty)**

Actions: Navigate to frame 5. Simulate `pointerdown` at H1's frame-5 pixel position. Simulate `pointermove` +10px.

Assertions: `__catgo_probe.override_size > 0` during drag.

Verification:
```typescript
await page.mouse.move(px.x, px.y)
await page.mouse.down()
await page.mouse.move(px.x + 10, px.y)
const sz = await page.evaluate(() => (globalThis as any).__catgo_probe?.override_size)
expect(sz).toBeGreaterThan(0)
await page.mouse.up()
```

W6 finding: `plans/W6-review-sequencing.md` lines 61–72 drag-commit stale-position bug.

Phase gate: Phase 2.

---

**Test 2.3 — Drag-commit position reflects paused frame, not frame 0** *(Phase 4+5 gate)*

Actions: Navigate to frame 5. Drag H1 by +0.5 Å in x (compute pixel offset from camera matrix). Pointerup (commit).

Assertions: `__catgo_probe.get_structure_site_x(0) ≈ FRAME_5_H1_X + 0.5` (tolerance 0.1 Å).

Verification:
```typescript
// drag and commit ...
const x = await page.evaluate(() => (globalThis as any).__catgo_probe?.get_structure_site_x(0))
expect(x).toBeCloseTo(FRAME_5_H1_X + 0.5, 0)
```

Note: This test is `.skip('requires plan v3 Phase 4+5: T5 writeback + Phase 4 pivot')` until those phases land in a single commit. It will fail in the window between Phase 4 and Phase 5 if they land separately — enforcing the combined-commit requirement from `plans/W6-review-sequencing.md` lines 61–72.

Phase gate: Phases 4+5 combined.

---

**Test 2.4 — Resume after drag: override clears, playback continues from paused frame**

Actions: Navigate to frame 5. Drag H1 +0.5 Å. Pointerup. Click play.

Assertions: (a) Frame counter > 5 after 0.5 seconds. (b) `__catgo_probe.override_size === 0` during playback.

Note: `.skip('requires plan v3 Phase 5')`.

Phase gate: Phase 5.

---

**Test 2.5 — Context menu identifies correct element at paused frame**

Actions: Navigate to frame 5. Right-click at H1's frame-5 pixel position.

Assertions: Context menu first item contains text "H", not "O".

Verification:
```typescript
await page.mouse.click(px.x, px.y, { button: 'right' })
await expect(page.locator('[data-testid="context-menu-atom-label"]')).toContainText('H')
```

Phase gate: Phase 2.

---

### Category 3: During-playback interactions

**Coverage goal:** Element hide, color-scheme change, PBC toggle, vibration mutex, charge-label non-crash during active playback.

**Number of test cases:** 5

---

**Test 3.1 — Hide H during playback: hidden atoms disappear, playback continues**

Actions: Start playback at 5 fps. After 1 second, click `[data-testid="legend-hide-H"]`. Wait 1 more second.

Assertions: (a) Frame counter > 5. (b) `__catgo_probe.hidden_site_ids_size === 2`. (c) No console errors.

Verification: `page.on('console', ...)` captures errors; check probe and frame counter after second wait.

W6 finding: W3 consumer #3 `new_atom_hidden_site_ids` at `StructureScene.svelte:1726` fires on `_hidden_elements` change — expected one O(N) re-derive on toggle, then silence.

Phase gate: Phase 2.

---

**Test 3.2 — Color-scheme change during playback: one slow-path atom_data fire, then silence**

Actions: Start playback. Record `__catgo_probe.atom_data_fire_count`. After 1 second, dispatch color-scheme change. Record again 1 second later.

Assertions after Phase 4: `delta === 1` (one full slow-path re-derive; then quiescent for subsequent frames).

Note: On baseline (29420f91), `delta ≈ 5` (per-frame). The test uses the `architecture_p_active` flag to select the correct assertion variant.

Verification:
```typescript
const arch_p = await page.evaluate(() => (globalThis as any).__catgo_probe?.architecture_p_active)
const pre = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
// change color scheme ...
await page.waitForTimeout(1000)
const post = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
if (arch_p) expect(post - pre).toBe(1)
else expect(post - pre).toBeGreaterThan(4)
```

Phase gate: Phase 3 (cache invalidation on topology change confirmed); Phase 6 (cache deleted under Architecture P).

---

**Test 3.3 — PBC image toggle during playback: atom count changes, no crash**

Actions: Load mp-1.json at 2×1×1 supercell (PBC images enabled). Start playback. Record `atom_manager_count`. Toggle `show_image_atoms` off. Wait 0.5 seconds. Toggle back on.

Assertions: Count is lower with images off, restored with images on. No errors.

Phase gate: Phase 2.

---

**Test 3.4 — Vibration and trajectory are mutually exclusive (never simultaneously active)**

Actions: Start trajectory playback. Call `globalThis.__catgo_test_set_vibration({ eigenvector: [...], base_positions: [...], amplitude: 0.1, playing: true })`.

Assertions: `!(vibration_active && is_playing)` — at most one active at any time.

Verification:
```typescript
const state = await page.evaluate(() => ({
  v: (globalThis as any).__catgo_probe?.vibration_active,
  p: (globalThis as any).__catgo_probe?.is_playing,
}))
expect(state.v && state.p).toBe(false)
```

W6 finding: `plans/W6-review-completeness.md` Finding #1 (HIGH). Under Architecture P, simultaneous vibration + trajectory is silent wrong behavior — the vibration effect at `StructureScene.svelte:1610` writes `realtime_position_overrides` for all atoms, causing the position-write loop's "drag wins" guard to skip ALL trajectory position updates.

Phase gate: Phase 0 (mutex must be confirmed before any implementation begins).

---

**Test 3.5 — Charge labels during playback: no crash; stale positions accepted**

Actions: Load a structure with `bader_charge` properties on sites. Start playback.

Assertions: (a) No JavaScript errors. (b) `__catgo_probe.charge_label_entries_count >= 0`. (c) Frame counter advances. Label position correctness is NOT asserted — stale positions are a documented known limitation (W3 Q1; W6 Architecture P item 1).

Phase gate: Phase 3.

---

### Category 4: Stop / exit transitions

**Coverage goal:** Stop triggers one bond re-detect cleanly; no bond flash >16ms; atom positions at stop match last frame; structure.sites reflects last frame (T5 writeback).

**Number of test cases:** 4

---

**Test 4.1 — Bond re-detect fires exactly once on stop**

Actions: Start playback for 2 seconds. Record `__catgo_probe.bbp_fire_count`. Stop. Wait 500ms. Record again.

Assertions: `1 ≤ delta ≤ 2`.

Verification:
```typescript
const pre = await page.evaluate(() => (globalThis as any).__catgo_probe?.bbp_fire_count)
await page.locator('[data-testid="stop-btn"]').click()
await page.waitForTimeout(500)
const post = await page.evaluate(() => (globalThis as any).__catgo_probe?.bbp_fire_count)
expect(post - pre).toBeGreaterThanOrEqual(1)
expect(post - pre).toBeLessThanOrEqual(2)
```

Phase gate: Phase 7 (worker prewarm, reduces flash gap duration).

---

**Test 4.2 — Bond pairs non-empty throughout stop transition (no perceptible flash)**

Actions: Start playback for 2 seconds. Stop. Sample `__catgo_probe.bond_pairs_count` every 16ms for 200ms.

Assertions: All samples `> 0`.

Verification:
```typescript
const samples: number[] = []
for (let i = 0; i < 12; i++) {
  samples.push(await page.evaluate(() => (globalThis as any).__catgo_probe?.bond_pairs_count))
  await page.waitForTimeout(16)
}
expect(samples.every(c => c > 0)).toBe(true)
```

W6 finding: exit flash concern in W6-architecture-decision.md Open Question #6.

Phase gate: Phase 7.

---

**Test 4.3 — Atom GPU x-position at stop matches last played frame** *(Phase 5 gate)*

Actions: Start playback at 5 fps. After exactly 1.4 seconds, stop (= ~7 frames advanced, landing near frame 7 in the 10-frame fixture). Read `__catgo_probe.get_atom_x(0)`.

Assertions: `get_atom_x(0) ≈ FRAME_7_H1_X` (= 1.03 Å, tolerance 0.01).

Note: `.skip('requires plan v3 Phase 5: T5 writeback')`.

Verification:
```typescript
const gpu_x = await page.evaluate(() => (globalThis as any).__catgo_probe?.get_atom_x(0))
expect(gpu_x).toBeCloseTo(FRAME_7_H1_X, 1)
```

Phase gate: Phase 5.

---

**Test 4.4 — structure.sites reflects last frame after stop ($bindable T5 writeback)**

Actions: Same setup as 4.3. Read `__catgo_probe.get_structure_site_x(0)` (reads `structure.sites[0].xyz[0]` from the live Svelte reactive graph via Structure.svelte).

Assertions: Same value as 4.3 (matches frame-7 H1 x-coordinate).

Note: `.skip('requires plan v3 Phase 5')`.

W6 finding: `plans/W6-review-completeness.md` Finding #2 (W2 writeback contract). Catches "$bindable deep mutation doesn't propagate."

Phase gate: Phase 5.

---

### Category 5: Memory + repeat start/stop

**Coverage goal:** Repeated start/stop cycles do not accumulate intervals, cascade fire counts, GPU allocations, or stale atom manager entries.

**Number of test cases:** 4

---

**Test 5.1 — No interval leak: 20 play/pause cycles**

Actions: Click play then pause 20 times in 50ms intervals.

Assertions: `__catgo_probe.active_interval_count === 0` after final pause.

W6 finding: Playback interval managed at `src/lib/trajectory/Trajectory.svelte:616–651`. Stacking intervals cause double-speed playback.

Phase gate: Phase 2.

---

**Test 5.2 — No GPU buffer growth across 10 trajectory loads**

Actions: Load `FIXTURE_H2O_10F` 10 times via `page.reload()`.

Assertions: `__catgo_probe.atom_manager_capacity` stable across all loads (≤ 4, no runaway growth above the 3-atom structure).

Verification:
```typescript
const capacities: number[] = []
for (let i = 0; i < 10; i++) {
  await page.reload()
  // wait for load ...
  capacities.push(await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_manager_capacity))
}
expect(Math.max(...capacities)).toBeLessThanOrEqual(4)
```

W6 finding: `plans/W6-review-completeness.md` Finding #11 (memory growth unanalyzed).

Phase gate: Phase 6.

---

**Test 5.3 — Cascade silence after 5 seconds of playback (W1 detector as Playwright assertion)**

Actions: Start playback for 5 seconds (25 frames at 5 fps). Record `atom_data_fire_count` and `bbp_fire_count` delta over that window.

Assertions (dual-variant):
- On baseline (29420f91, `architecture_p_active === false`): `atom_data_fire_count delta > 10` (fast-path fires per frame — confirms the fast-path is active).
- After Phase 4 (`architecture_p_active === true`): both deltas `=== 0` (cascade fully quiescent).

Verification:
```typescript
const arch_p = await page.evaluate(() => (globalThis as any).__catgo_probe?.architecture_p_active)
const pre_ad = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
// play 5 seconds ...
const post_ad = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
if (arch_p) expect(post_ad - pre_ad).toBe(0)
else expect(post_ad - pre_ad).toBeGreaterThan(10)
```

W6 finding: This IS the W1 regression detector expressed as a Playwright assertion. Phase 4's success condition is that this test switches from the baseline variant to the quiescent variant.

Phase gate: Phase 4 (cascade goes silent after this phase).

---

**Test 5.4 — Structure swap after trajectory: no stale atom manager entries**

Actions: Load `FIXTURE_H2O_10F` (3 atoms). Start/stop 5 times. Swap structure to a 4-atom molecule. Check atom count.

Assertions: `__catgo_probe.atom_manager_count === 4` (no stale 3-atom entries).

Phase gate: Phase 1 (atom_manager lift must not break count-reset on structure change).

---

### Category 6: Edge cases

**Coverage goal:** LB1 supercell guard, vibration mutex, h-bond non-crash, charge-label non-crash, resume-disable after topology edits, drag-then-resume allowed, align_on_load non-fire.

**Number of test cases:** 7

---

**Test 6.1 — Supercell 2×1×1 + trajectory: no crash, no garbage positions**

Actions: Apply 2×1×1 supercell to a structure. Load `FIXTURE_H2O_10F` as trajectory. Start playback.

Assertions: (a) No JavaScript errors. (b) `atom_manager_count > 0`. (c) Frame counter advances. No requirement that supercell-extra atoms animate — freeze is accepted.

W6 finding: LB1 analysis in W6-architecture-decision.md. The length-check guard at `StructureScene.svelte:2346`: `traj_positions.length >= sites.length * 3` — false for supercell case — prevents garbage writes.

Phase gate: Phase 2.

---

**Test 6.2 — Supercell + trajectory: UI warning displayed**

Actions: Same as 6.1.

Assertions: `[data-testid="traj-supercell-warning"]` visible.

Note: `.skip('requires plan v3 Phase 2: supercell-frozen-atoms warning UI per W6 Open Question #1')`.

Phase gate: Phase 2.

---

**Test 6.3 — H-bond display during playback: no crash**

Actions: Load `FIXTURE_H2O_10F` with `show_hydrogen_bonds = true` (H–O distance in fixture ~0.96–1.06 Å, within typical H-bond range). Start playback.

Assertions: (a) No errors. (b) `__catgo_probe.h_bond_pairs_count >= 0`. (c) Frame counter advances.

W6 finding: `h_bond_pairs $derived.by()` at `StructureScene.svelte:1603` reads `structure` (stable under Architecture P — no per-frame re-derive).

Phase gate: Phase 3.

---

**Test 6.4 — Topology-altering edit during pause disables resume**

Actions: Start playback. Pause at frame 5. Replace atom 0 (H) with O via context menu. Click play.

Assertions: Play button disabled; `__catgo_probe.resume_disabled === true`.

Note: `.skip('requires plan v3 Phase 5: W5 resume_disabled prop per plans/W6-review-completeness.md Finding #5')`.

Phase gate: Phase 5.

---

**Test 6.5 — Drag-then-resume is NOT disabled (valid workflow)**

Actions: Pause at frame 5. Drag atom 0. Attempt to click play without committing.

Assertions: Play button ENABLED; `__catgo_probe.resume_disabled === false`.

Note: `.skip('requires plan v3 Phase 5')`.

W6 finding: `plans/W6-review-completeness.md` Finding #5 — `try_move` must NOT trigger resume_disabled; only `try_add`/`try_delete`/`try_replace` should.

Phase gate: Phase 5.

---

**Test 6.6 — align_on_load effect does NOT fire during playback**

Actions: Start playback for 3 seconds. Record `__catgo_probe.align_on_load_fire_count` delta.

Assertions: `delta === 0`.

W6 finding: W8. `Structure.svelte:1119` already has `|| trajectory_active` in the align_on_load guard. W6 Decision Log #3 confirms this is "already fixed." This test confirms the fix does not regress.

Phase gate: pre-Phase-0 baseline (confirms existing fix).

---

**Test 6.7 — Single-frame trajectory: play button disabled**

Actions: Load a 1-frame `AnyStructure` array (no loop possible). Check play button.

Assertions: `[data-testid="play-btn"]` is disabled.

Phase gate: baseline sanity.

---

### Category 7: Visual regression (frame-by-frame snapshot diffs)

**Coverage goal:** Catch rendering artifacts — garbage positions, missing bonds, unexpected flicker — invisible to probe-based tests.

**Number of test cases:** 6

**Approach:** `page.locator('canvas').screenshot()` captures only the Three.js canvas. `expect(buf).toMatchSnapshot('name.png', { maxDiffPixels: 50 })`. Snapshots stored in `tests/playwright/snapshots/`. Generated on first run via `--update-snapshots`.

**Tolerance rationale:** 50 pixels absorbs anti-aliasing variation across runs. A displaced atom (wrong frame position) changes >500 pixels. A missing bond changes >200 pixels. These are well above the 50-pixel threshold.

---

**Test 7.1 — Frame 0 baseline screenshot**

Actions: Navigate to frame 0.
Assertion: `toMatchSnapshot('traj-h2o-frame-0.png', { maxDiffPixels: 50 })`

---

**Test 7.2 — Frame 9 screenshot (atoms displaced, differs from frame 0)**

Actions: Navigate to frame 9.
Assertion: `toMatchSnapshot('traj-h2o-frame-9.png', { maxDiffPixels: 50 })`

Note: The snapshot for frame 9 will visually differ from frame 0 (H atoms displaced 0.1 Å). If a regression causes both snapshots to be identical, it means atoms are frozen at frame-0 positions — directly confirming the same defect as Test 1.2, but via screenshot.

---

**Test 7.3 — Mid-playback frame via automatic advance**

Actions: Start playback, wait exactly 1,200ms (6 frames at 5 fps). Pause. Take screenshot.
Assertion: `toMatchSnapshot('traj-h2o-auto-frame-6.png', { maxDiffPixels: 150 })` (looser tolerance for timing imprecision — frame 5 or 6 are both acceptable).

---

**Test 7.4 — Post-stop screenshot matches pre-recorded frame**

Actions: Navigate to frame 7 manually (baseline screenshot for frame 7 already captured in 7.1 style). Start playback, advance to frame 7 via natural loop. Stop. Take screenshot.
Assertion: `toMatchSnapshot('traj-h2o-frame-7.png', { maxDiffPixels: 50 })`

Confirms T5 writeback did not alter atom positions from the known frame-7 layout.

---

**Test 7.5 — Bonds visible in frame-5 screenshot**

Actions: Navigate to frame 5. Ensure `show_bonds = 'yes'`. Take screenshot.
Assertion: `toMatchSnapshot('traj-h2o-frame-5-bonds.png', { maxDiffPixels: 200 })`

The bond cylinder color (gray, ~#808080) must appear between O and H atoms. A Phase 3 regression where bonds freeze at frame-0 positions would show bond cylinders at wrong pixel locations, differing from the baseline by >200 pixels.

---

**Test 7.6 — No blank canvas during stop transition**

Actions: Start playback for 1 second. Stop. Take canvas screenshot within 50ms of stop.
Assertion: `toMatchSnapshot('traj-h2o-stop-immediate.png', { maxDiffPixels: 300 })`

A bond-flash regression (bond_pairs → empty Map during async worker interval) would produce a screenshot with no bond cylinders — significantly different from baseline.

Phase gate: Phase 7 (worker prewarm eliminates the flash gap).

---

### Category 8: Performance regression (frame timing assertions)

**Coverage goal:** Assert fast-path is active (not slow-path) during playback via cascade-fire-count probe.

**Number of test cases:** 4

**Prerequisite:** W1 regression detector in `StructureScene.svelte` (Phase 0 deliverable). All Category 8 tests are marked `.skip('requires W1 probe: Phase 0 deliverable')` until the probe is wired.

**Required probe fields** (all exposed via `globalThis.__catgo_probe` in DEV mode):
- `atom_data_fire_count` — increments at entry of `atom_data $derived.by()` body at `StructureScene.svelte:1877`, gated on `import.meta.env?.DEV`
- `bbp_fire_count` — increments in `build_bond_pairs $effect.pre` at `StructureScene.svelte:1552` after the `stable` early-return check at line 1572 is passed
- `x2_slow_path_count` — increments at `StructureScene.svelte:2398` (past all fast-path branches, entering the full Map-diff slow path)
- `x2_fast_path_count` — increments inside the `trajectory_only` branch at `StructureScene.svelte:2359`
- `architecture_p_active` — `boolean`, false on baseline, set to `true` by Structure.svelte after Phase 4 lands

---

**Test 8.1 — atom_data fire count during playback (dual-assertion: baseline vs Architecture P)**

Actions: Start playback for 3 seconds at 5 fps (15 frames). Record `atom_data_fire_count` delta.

Baseline assertion (`architecture_p_active === false`): `delta > 10` — fast-path fires per frame. Confirms the fast-path IS being used, not the slow-path (which would be ~6× more expensive).

Phase 4 assertion (`architecture_p_active === true`): `delta === 0` — cascade is quiescent; `atom_data` never re-runs during playback.

Verification:
```typescript
const arch_p = await page.evaluate(() => (globalThis as any).__catgo_probe?.architecture_p_active ?? false)
const pre = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
await page.waitForTimeout(3000)
const post = await page.evaluate(() => (globalThis as any).__catgo_probe?.atom_data_fire_count)
if (arch_p) expect(post - pre).toBe(0)
else expect(post - pre).toBeGreaterThan(10)
```

Phase gate: Phase 4 (test switches from baseline variant to quiescent variant).

---

**Test 8.2 — build_bond_pairs does NOT fire per frame on either baseline or post-refactor**

Actions: Start playback for 3 seconds.

Assertions: `bbp_fire_count delta ≤ 2` (under both architectures). The `stable` memo at `StructureScene.svelte:1563` must prevent per-frame fires.

Cross-validation requirement: Test 1.3 must also be green (bonds ARE present). If 8.2 passes with `delta = 0` but 1.3 fails with `count = 0`, the `stable` memo is incorrectly returning early (wrong inputs tracked), not correctly absorbing Svelte over-fires.

W6 finding: Reviewer 2 Phase 3 finding in `plans/W6-review-sequencing.md` lines 49–56.

Phase gate: Phase 3.

---

**Test 8.3 — X2 shadow sync slow path never taken during playback**

Actions: Start playback for 3 seconds.

Assertions: `x2_slow_path_count delta === 0`.

Critical importance: The X2 shadow sync slow path at `StructureScene.svelte:2263` costs ~15–30ms for 878 atoms. One fire per frame at 60fps = 900–1800ms/second wasted — the entire performance regression the bypass refactor exists to prevent. This test is the definitive CI catch for that regression.

W6 finding: Reviewer 2 critical finding in `plans/W6-review-sequencing.md` lines 33–42. Phase 6 deletes the `trajectory_only` branch. Without Phase 5.5's X2 gate (`if (trajectory_frame_positions != null) return` at the top of the X2 `$effect`), X2 falls through to the slow-path after the deletion.

Phase gate: Phase 5.5 (X2 gate) must confirm this test passes BEFORE Phase 6 can proceed.

---

**Test 8.4 — Per-frame JS cost within budget via performance marks**

Actions: After enabling performance marks in the probe (`performance.mark('catgo_traj_frame_start/end')` inside the X2 `trajectory_only` branch, gated on DEV + `__catgo_probe` enabled), play for 3 seconds. Collect the last 10 pairs of marks.

Assertions: Average duration between pairs < 5ms for `FIXTURE_H2O_10F` (3 atoms). For `FIXTURE_192A_20F` (192 atoms, Milestone 4): average < 10ms.

Verification:
```typescript
const entries = await page.evaluate(() => {
  const ends = performance.getEntriesByName('catgo_traj_frame_end').slice(-10)
  const starts = performance.getEntriesByName('catgo_traj_frame_start').slice(-10)
  return ends.map((e, i) => e.startTime - starts[i].startTime)
})
const avg = entries.reduce((s, v) => s + v, 0) / entries.length
expect(avg).toBeLessThan(5)
```

Alternative if performance marks are too invasive: expose `__catgo_probe.last_frame_cost_ms` updated inside the X2 `trajectory_only` branch with `performance.now()` delta.

Phase gate: Phase 6 (all patches deleted; fast-path cost measured clean).

---

## Per-phase gate matrix

| Phase | Description | MUST be green | MAY skip | Key gating tests |
|---|---|---|---|---|
| Baseline 29420f91 | Patch baseline | 1.1–1.5, 6.6, 6.7, 7.1, 7.2, 8.1 (baseline variant), 8.2, 8.3 | All others not yet written | 1.2, 6.6, 8.3 |
| Phase 0 — W1 probe | Probe wired, no code change | 1.1–1.5, 6.6, 6.7, 8.1–8.4 baseline, 7.1–7.2 | 2–6 | 8.1 (baseline fires), 8.3 (slow=0) |
| Phase 1 — atom_manager lift | $bindable lift; behavior unchanged | 1.1–1.5, 5.4, 8.1–8.4 baseline | 2–4, 5.1–5.3, 6 | 1.2, 5.4 (count stable after swap) |
| Phase 2 — position-write loop | Additive; current_structure still flowing | 1.1–1.5, 2.1, 2.2, 3.1, 3.3, 5.1, 6.1, 6.3, 7.1–7.3, 8.1–8.4 baseline | 2.3–2.5, 4, 5.2, 6.2, 6.4, 6.5 | 1.2, 2.2, 6.1, 7.3 |
| Phase 3 — bond fast-path | build_trajectory_bond_pairs wired | All Phase 2 + 1.3, 2.1, 2.2, 3.2, 6.3, 7.5, 8.2 | 2.3–2.5, 4, 6.4, 6.5 | 1.3, 7.5, 8.2 |
| Phase 4 — stop current_structure writes (pivot) | Cascade quiescent | All Phase 3 + 3.1–3.3, 5.3 (now delta=0), 8.1 (now delta=0) | 2.3–2.5, 4, 6.4, 6.5 | 5.3 (delta=0), 8.1 (delta=0), 8.3 |
| **Phases 4+5 combined** | Pivot + T5 writeback + resume-disable | All Phase 4 + 2.3, 2.4, 4.3, 4.4, 6.4, 6.5 | 5.2 | 2.3, 4.3, 4.4 (writeback correct) |
| Phase 5.5 — X2 gate on !trajectory_active | 1-LOC preparatory change; gates Phase 6 | 8.3 (must confirm slow=0 AFTER X2 gated) | — | **8.3 is the hard gate for Phase 6** |
| Phase 6 — delete all 5 patch categories | Net-negative LOC | **ALL 8 categories** | None | ALL tests |
| Phase 7 — worker prewarm | Bond worker warm at startup | 4.1, 4.2, 7.6 | — | 4.2 (no flash), 7.6 |

**Notes:**

**Phase 4+5 must land in a single commit.** `plans/W6-review-sequencing.md` lines 61–72: the window between Phase 4 (remove `current_structure` per-frame write) and Phase 5 (T5 writeback) leaves a drag-commit stale-position bug. Test 2.3 will FAIL in that window. The gate matrix treats them as one phase.

**Phase 5.5 is a mandatory insertion.** `plans/W6-review-sequencing.md` lines 33–42 and 141–149: deleting the X2 `trajectory_only` branch (Phase 6) without first inserting `if (trajectory_frame_positions != null) return` at the top of the X2 `$effect` at `StructureScene.svelte:2263` causes X2 to fall through to the 15–30ms slow-path after the deletion. Test 8.3 is the gate: it must pass after Phase 5.5 lands and before Phase 6 proceeds.

**Category 7 baselines must be captured fresh on commit 29420f91.** Run `--update-snapshots` before any plan v3 code lands. Committing stale snapshots would make Phase 6 appear green even if rendering regressed.

---

## How to run on the baseline

```bash
# 1. Checkout patch baseline
git checkout 29420f91

# 2. Install dependencies
pnpm install

# 3. Start dev server (Playwright reuses it via reuseExistingServer: true)
pnpm dev --port 3005 &
# Wait for "Local: http://localhost:3005" before running tests

# 4. Generate Category 7 baseline screenshots (first run only)
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts --update-snapshots

# 5. Run the full suite
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts

# 6. Run with UI for debugging
pnpm exec playwright test tests/playwright/structure-trajectory.test.ts --ui
```

**Expected output on 29420f91 after all milestones are complete:**

- Categories 1, 6.6, 6.7: PASS
- Category 7 (7.1–7.6): PASS (after `--update-snapshots` generates baselines)
- Category 8 (8.1–8.4): PASS with baseline assertions (`atom_data_fire_count > 10`, `x2_slow_path_count = 0`)
- Category 5.3: PASS with baseline variant (`delta > 10`)
- Categories 2.3, 2.4, 4.3, 4.4, 6.2, 6.4, 6.5: SKIP (`.skip()` markers with phase notes)
- Categories 2.1, 2.2, 2.5, 3.1–3.5, 5.1, 5.2, 6.1, 6.3: PASS on baseline

**Cannot run today:** `tests/playwright/structure-trajectory.test.ts`, `src/routes/test/structure-trajectory/+page.svelte`, and the `__catgo_probe` mechanism do not exist. Time to runnable: Milestone 1 (~3h, Categories 1 + 7 without probe) + Milestone 2 (~3h, probe + Categories 5 + 8).

---

## Implementation milestones

### Milestone 1 — Infrastructure + Category 1 (~3 hours, 1 session)

**Goal:** Suite is runnable. Categories 1 and 7 (baselines generated) are green on 29420f91.

Tasks:
1. Create `src/routes/test/structure-trajectory/+page.svelte`:
   - Renders a `<Structure>` component receiving `trajectory_frame_positions` and `current_structure` from a setInterval-based playback loop defined in the test page (mirrors `Trajectory.svelte:616–651` without importing the full Trajectory viewer).
   - Exposes `[data-testid]` attributes for: `traj-frame-counter`, `play-btn`, `stop-btn`, `step-input`, `legend-hide-H`, `traj-supercell-warning`, `context-menu-atom-label`.
   - Stubs `globalThis.__catgo_probe = null` (replaced in Milestone 2).
   - Defines `FIXTURE_H2O_10F` inline as a `$state` array of 10 `AnyStructure` objects per the spec above.
2. Create `tests/playwright/structure-trajectory.test.ts` with `test.describe('Structure trajectory 3D', () => { test.setTimeout(60_000); ... })`.
3. Implement Category 1 (1.1–1.5) using DOM assertions only.
4. Run `--update-snapshots` to generate Category 7 (7.1–7.6) baselines.
5. Confirm all Category 1 tests pass on 29420f91.

**Deliverable:** `pnpm exec playwright test tests/playwright/structure-trajectory.test.ts` runs. Categories 1 and 7 pass.

---

### Milestone 2 — W1 probe + Categories 5 and 8 (~3 hours, 1 session)

**Goal:** `globalThis.__catgo_probe` is wired. Category 8 baseline assertions are green. Category 5 tests are implemented.

Tasks:
1. Add W1 regression detector to `StructureScene.svelte`:
   - Add module-level counters (gated on `import.meta.env?.DEV`):
     - `let __atom_data_fire_count = 0` — increment at `StructureScene.svelte:1880` (after the `!show_atoms` early-return, before the fast-path check)
     - `let __bbp_fire_count = 0` — increment at `StructureScene.svelte:1587` (after the `stable` early-return at 1572 is NOT taken, i.e., inside the `if (!stable)` implicit continuation)
     - `let __x2_fast_path_count = 0` — increment inside the `trajectory_only` block at `StructureScene.svelte:2359`
     - `let __x2_slow_path_count = 0` — increment at `StructureScene.svelte:2398`
     - `let __align_on_load_fire_count = 0` — increment in Structure.svelte inside the `align_on_load $effect` at `Structure.svelte:1118` (after the trajectory_active guard passes)
   - Add a mount `$effect` in `StructureScene.svelte` that exposes the probe (gated on `import.meta.env?.DEV`):
     ```typescript
     $effect(() => {
       if (!import.meta.env?.DEV) return
       ;(globalThis as any).__catgo_probe = {
         get atom_data_fire_count() { return __atom_data_fire_count },
         get bbp_fire_count() { return __bbp_fire_count },
         get x2_fast_path_count() { return __x2_fast_path_count },
         get x2_slow_path_count() { return __x2_slow_path_count },
         get atom_manager_count() { return atom_manager.count },
         get atom_manager_capacity() { return atom_manager.capacity },
         get_atom_x: (slot: number) => atom_manager.get_x(slot),
         get bond_pairs_count() { return bond_pairs.length },
         get h_bond_pairs_count() { return h_bond_pairs.length },
         get override_size() { return realtime_position_overrides?.size ?? 0 },
         get architecture_p_active() { return false },  // flipped true in Phase 4
         get loop_count() { return 0 },  // wired from test page
         get current_step() { return 0 },  // wired from test page
         get is_playing() { return false },  // wired from test page
         get vibration_active() { return vibration_data?.playing ?? false },
         get active_interval_count() { return 0 },  // wired from test page
       }
     })
     ```
   - `loop_count`, `current_step`, `is_playing`, `active_interval_count` are test-page-level state (not StructureScene state). Wire them via the test page overriding specific probe fields after mount.
   - `get_structure_site_x(sid)`: wire from Structure.svelte by reading `structure?.sites[sid]?.xyz[0]` — accessible since the probe mount effect runs in StructureScene which receives `structure` as a prop.
   - `get_camera_matrices()`: return `{ projection: camera.projectionMatrix.toArray(), world: camera.matrixWorldInverse.toArray() }` — used by Category 2 tests to compute pixel coordinates. `camera` is accessible via `useThrelte().camera.current` in StructureScene.
2. Implement Category 5 (5.1–5.4) and Category 8 (8.1–8.4) with baseline assertions.
3. Run full suite on 29420f91; confirm all implemented tests pass.

**Deliverable:** Full suite runs. Categories 1, 5, 7, 8 (baseline) are green.

---

### Milestone 3 — Interaction + exit tests (~3 hours, 1 session)

**Goal:** Categories 2, 3, and 4 are implemented. All non-phase-gated tests are green on 29420f91.

Tasks:
1. Implement a `project_to_pixel(camera_matrices, xyz)` helper in the test file that converts 3D world coordinates to canvas pixel coordinates using the camera projection and world matrices returned by `get_camera_matrices()`. This is pure linear algebra — no Playwright API needed.
2. Implement Category 2 tests (2.1–2.5). Tests 2.3, 2.4, 6.4, 6.5 marked `.skip('requires plan v3 Phase 4+5')`.
3. Add test page controls: `[data-testid="color-scheme-select"]` for Test 3.2; `[data-testid="image-atoms-toggle"]` for Test 3.3; `globalThis.__catgo_test_set_vibration()` hook for Test 3.4.
4. Implement Category 3 (3.1–3.5).
5. Implement Category 4 (4.1–4.4). Tests 4.3, 4.4 marked `.skip('requires plan v3 Phase 5')`.

**Deliverable:** All categories 1–8 have implementations. Non-skipped tests green on 29420f91.

---

### Milestone 4 — Edge cases + 192-atom fixture (~2 hours, 1 session)

**Goal:** Category 6 fully implemented. Category 8 has 192-atom performance variant.

Tasks:
1. Implement Category 6 tests (6.1–6.7). Mark 6.2 (`.skip Phase 2`), 6.4 (`.skip Phase 5`), 6.5 (`.skip Phase 5`).
2. Add `FIXTURE_192A_20F` inline generation to the test page (deterministic loop: 64 water molecules, 20 frames, `x_offset = 0.05 * Math.sin(frame * 0.3 + atom_idx * 0.7)`).
3. Add a `describe('192-atom performance')` block to the Category 8 tests using `FIXTURE_192A_20F`.

**Deliverable:** Category 6 implemented with correct skip markers. Full suite is green on 29420f91.

---

### Milestone 5 — Per-phase verification (ongoing, ~3 hours total across plan v3 phases)

After each plan v3 phase lands:

- **Phase 0:** Run suite. Confirm 8.1–8.4 are runnable (probe wired). Confirm 8.3 shows `x2_slow_path_count = 0` on baseline.
- **Phase 1:** Run suite. Confirm 5.4 passes (atom count stable after structure swap).
- **Phase 2:** Run suite. Confirm 1.2 (atoms move), 2.2 (drag starts), 6.1 (supercell no crash). Remove `.skip` from 6.2 (supercell warning UI). Snapshot 7.1–7.3 must still match.
- **Phase 3:** Confirm 1.3 (bonds animate), 7.5 (bonds in screenshot), 8.2 (bbp not per-frame). Remove `.skip` from 6.3.
- **Phase 4+5 combined:** Remove `.skip` from 2.3, 2.4, 4.3, 4.4, 6.4, 6.5. Confirm 5.3 switches to `delta === 0`. Confirm 8.1 switches to `delta === 0`.
- **Phase 5.5:** Confirm 8.3 still passes after X2 gate added. This is the hard gate for Phase 6.
- **Phase 6:** Run ALL categories. Zero skips. All must pass. `--update-snapshots` must NOT be needed (rendering unchanged).
- **Phase 7:** Confirm 4.2 (no flash), 7.6 (stop-transition screenshot stable).

---

## What this suite intentionally does NOT cover

**Cross-browser:** Tauri's WKWebView is the deployment target; Chromium is sufficient for CI. Safari-specific behavior (WKWebView 60fps cap, WebKit Bug #294338) is not tested here.

**Tauri IPC:** Tests run against the SvelteKit dev server (`pnpm dev`), not the Tauri bundle. Tauri file-open dialogs, local SQLite, and pointer-event WebView differences are not covered.

**Streaming / indexed trajectories:** Tests use in-memory `AnyStructure` arrays. Indexed file trajectories (`trajectory.frame_loader` path at `src/lib/trajectory/Trajectory.svelte:296–311`) and WebSocket streaming trajectories have different code paths and require separate test coverage.

**Mobile / touch events:** All drag simulations use pointer events (`page.mouse.*`). Touch gesture handling is not tested.

**HPC remote trajectories:** The push-back workflow at `src/lib/trajectory/Trajectory.svelte:225–257` is not tested.

**Multi-instance `<Structure>`:** Only one `<Structure>` instance per test. Comparison view and workflow preview multi-instance scenarios are not tested. `prewarm_bond_worker` is a global singleton — idempotent across instances per W6-review-completeness.md Finding #7.

**Production performance monitoring:** The W1 probe is DEV-only. `plans/W6-review-completeness.md` Finding #10 (no always-on production counter) is out of scope for this suite.

**Plugin hooks during trajectory:** If a plugin providing `atomColors` hooks is active during playback, the topology-change path is triggered (falls through to `atom_data` slow path). Not tested. The cascade-silence probe (5.3, 8.1) would catch regressions incidentally if plugins are installed in the test environment.

---

## Open questions for plan v3

**Q1 — Component topology: position-write loop placement.** `plans/W6-review-sequencing.md` lines 81–88 identifies a critical wiring error in W6: Phase 2 describes the position-write loop as living in "Trajectory.svelte" but `Structure.svelte:791` declares `trajectory_frame_positions` as an INCOMING prop — meaning the parent (wherever Trajectory.svelte lives in the consumer app) calls down into Structure.svelte, not vice versa. Structure.svelte does not render a `<Trajectory>` component. The position-write loop must live in `Structure.svelte`, reacting to its own `trajectory_frame_positions` prop. This affects where the W1 probe is placed and where `atom_manager` is accessible. Plan v3 must resolve this before Phase 2.

**Q2 — W1 detector mechanism for $derived.by().** W6 Open Question #3 defers the choice. This design recommends module-level `let` counters (not `$state`) incremented inside `atom_data $derived.by()` at `StructureScene.svelte:1877`. This is a side-effect in a pure derivation — technically valid in Svelte 5 (plain non-reactive mutation), but may confuse future readers. The alternative (wrapper `$effect` watching `atom_data` identity) undercounts: it only fires when the output reference changes, missing fast-path re-runs that return the same array reference. Module-level counters are the recommended mechanism.

**Q3 — Vibration-trajectory mutex: UI gate location.** Test 3.4 asserts the mutex. `plans/W6-review-completeness.md` Finding #1 states W6 does not verify the claim "mutually exclusive in current UX." Plan v3 must specify: is there an existing UI gate that prevents enabling vibration while trajectory is playing? If not, where is it added? The test cannot be written to assert specific UI elements until the gate's location is decided.

**Q4 — Drag simulation: pixel coordinate accuracy.** Tests 2.1–2.3 click at the atom's expected pixel position. This requires either (a) exposing `camera.projectionMatrix` and `camera.matrixWorldInverse` via the probe for a `project_to_pixel` helper, or (b) configuring the test page to use a fixed camera position (via `initial_camera_position` prop if one exists). If the camera isn't deterministic, pixel coordinates vary per test run and the hit-test may miss the atom. The test page must lock the camera via `scene_props.camera_position = [0, 0, 5]` or equivalent during test runs.

**Q5 — `architecture_p_active` flag: where is it set?** Tests 5.3, 8.1, and 3.2 use `__catgo_probe.architecture_p_active` to switch between baseline and post-Phase-4 assertion variants. This flag must be set to `true` by the code after Phase 4 lands (when `current_structure` per-frame writes are removed). The recommended location: a constant `const ARCHITECTURE_P = true` exported from a feature-flag module (similar to `feature-flag.ts:28` which exports `USE_NEW_ATOM_SYSTEM = true`), read by the probe mount effect. Plan v3 must specify the flag's home.

**Q6 — Phase 4 `current_structure` removal scope.** `plans/W6-review-completeness.md` Finding #3: W6 asks "Does Trajectory.svelte use `current_structure` for anything other than per-frame position update?" The first-frame write at trajectory load is what populates `displayed_structure` with the base topology BEFORE playback starts. Phase 4 must keep the load-time write while removing only per-frame writes. The test page's `$state` playback simulation must match this distinction: write `current_structure` once on trajectory load (to initialize Structure's reactive graph), then switch to `trajectory_frame_positions`-only writes for subsequent frames.

**Q7 — `get_structure_site_x` probe implementation.** Test 4.4 reads `structure.sites[0].xyz[0]` from the live Svelte reactive graph (the base structure, not `displayed_structure`). StructureScene receives `structure = displayed_structure` as a prop (`Structure.svelte:3361`), which is the post-PBC-expansion version. For `get_structure_site_x` to read the BASE structure's xyz (for T5 writeback verification), the probe needs access to the base `structure` prop in Structure.svelte, not StructureScene's `structure` prop. The probe mount point should be in Structure.svelte, not StructureScene.svelte, or Structure.svelte must thread `structure.sites[0].xyz[0]` into the probe via a separate `globalThis.__catgo_probe_base` object.
```

---