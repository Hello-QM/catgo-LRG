# W1 — Cascade Regression Detector: Design + Validation Against Patched Baseline

**Branch baseline:** atom-soa-refactor @ 29420f91 (patch baseline) and bd0da10f (current HEAD).
**Status:** PROPOSED — must validate on patched code before plan v3 begins
**Inputs:** plans/W6-architecture-decision.md, plans/W6-review-recommendation.md, plans/W6-review-sequencing.md
**Estimated implementation effort:** 2–3 hours

## Purpose

W1 exists because plan v2's T6 (delete the patches) is gated on a hard pre-condition: "the dev-mode assertion from T2.3 has stayed silent across the full verification matrix." Without a working detector, that gate is meaningless — T6 could proceed on a false assumption that the cascades are eliminated.

### Why T2.3 failed

The v2 plan proposed adding `console.warn` inside the `atom_data $derived` body when `trajectory_active === true`. This fails for two distinct reasons:

1. **`$derived` has no access to parent-component state.** `trajectory_active` lives in `Structure.svelte:1114` (`$derived(trajectory_frame_positions != null)`). `atom_data` lives in `StructureScene.svelte:1877`. The only connection between the two components is the `structure` prop. After Architecture P's Phase 4, `trajectory_frame_positions` will not flow to StructureScene as a prop at all — the per-frame position write moves to the `atom_manager` path. So there is no surface inside `atom_data` that can observe "are we playing?" from the parent without threading a new prop.

2. **The postcondition is wrong anyway.** Under Architecture P, `atom_data` should fire ZERO times per frame during trajectory playback. The correct detector says: "count how many times this fires during a known-playback window; assert the count is zero." The T2.3 formulation ("warn if it fires during playback") would require knowing about trajectory_active inside the derived body — which is the exact mechanism that doesn't work.

### What this design must do that T2.3 didn't

1. Count fires without requiring access to parent-component state.
2. Distinguish "fired and did real work" from "fired and returned from a memo guard" — because `build_bond_pairs $effect.pre` fires per-frame on the patched baseline but returns early from the `stable` guard at `StructureScene.svelte:1572`.
3. Expose counts on a testable surface (`globalThis.__catgo_probe`) so validation can be read after N seconds of playback.
4. Be silenced or absent in production builds via `import.meta.env?.DEV` gating + Vite dead-code elimination.
5. Cover `atom_positions_buffer` (`StructureScene.svelte:2756`) and `atom_colors_buffer` (`StructureScene.svelte:2771`), the two consumers W3 missed per Reviewer 1 finding H1.

---

## Detector Mechanism Options

### Option 1: Module-level fire counters incremented inside the suspect `$derived`/`$effect` bodies

**How it works.** Declare `let __probe_XXX_fires = 0` and `let __probe_XXX_meaningful = 0` as plain (non-`$state`) `let` variables in the `<script>` block of `StructureScene.svelte`. Inside each instrumented body, before the first early-return, increment `__probe_XXX_fires`. After all memo/guard checks pass and real work begins, increment `__probe_XXX_meaningful`. At mount, expose all counters on `globalThis.__catgo_probe` via a separate `$effect`.

**Where it lives.** `src/lib/structure/StructureScene.svelte` — alongside the existing `__atom_data_cache_*` variables (lines 1855–1875), `__bbp_prev_*` variables (lines 1544–1551), and `__x2_prev_*` variables (lines 2249–2261). The probe export lives at the end of the `<script>` block.

**Pros.**
- The codebase ALREADY uses this exact pattern. `__atom_data_fast_count` at line 1875 is a non-reactive `let` counter incremented inside `atom_data $derived.by()` at line 1931. The `[probe]` console.log statements at lines 1933, 1590, 2361, 2392 are the prototype of this mechanism. Any maintainer who reads `__atom_data_fast_count` will immediately understand the new counters.
- Works identically in `$derived.by()`, `$effect`, and `$effect.pre`.
- Zero reactive side effects — the counters are plain `let`, not `$state`, so incrementing them does not invalidate any reactive subscriptions or trigger re-runs.
- Tree-shaken in production: `import.meta.env?.DEV` is replaced with `false` by Vite; dead-code elimination removes the entire `if (false)` branch.

**Cons.**
- Counter state is per-component-instance. If two StructureScene instances mount simultaneously, counters would double-count. This is an acceptable limitation for CatGo's single-viewer architecture.
- Counters accumulate across playback sessions and must be manually reset via `__catgo_probe.reset()` before timing a window.
- The probe surface `$effect` that wires `globalThis.__catgo_probe` must re-wire on component remount. The cleanup function (`return () => { delete globalThis.__catgo_probe }`) handles this.

**Reactive-safety analysis.** Svelte 5's `$derived` purity contract means: a derived computation must not write to reactive `$state` — doing so would create a reactive cycle (the derived writes, triggering its own dependency, re-running it). Writing to a plain `let` variable is NOT purity-violating because Svelte's reactive graph only tracks reads and writes to `$state`, rune-initialized values, and `$derived` outputs. Plain `let` variables are invisible to the reactive scheduler. The counter increment causes zero reactive side effects. Additionally, Svelte 5 does NOT batch or deduplicate `$derived` evaluations within a single reactive cycle — each invalidation causes exactly one synchronous re-run of the `$derived.by()` function. This is confirmed by the existing `__atom_data_fast_count` counter at line 1875 working correctly in production DEV builds (the counter accurately tracks per-frame fast-path calls, which would be wrong if Svelte batched or skipped evaluations).

---

### Option 2: Wrapping each suspect derivation in a separate `$effect` that watches identity changes

**How it works.** In `Structure.svelte`, add an effect that reads `trajectory_active` AND watches an exported "version" counter from `StructureScene` via a `$bindable` prop. When `trajectory_active` is true and the version advances, increment a probe counter.

**Where it lives.** `Structure.svelte` and `StructureScene.svelte` — requires threading new `$bindable` props across the component boundary.

**Cons.** Requires production-visible `$bindable` props that exist only for a DEV-time probe. Cannot detect "fires but does meaningful work" vs "fires and returns from memo" — only detects identity changes in the output, not internal execution paths. Does not work for `atom_positions_buffer` and `atom_colors_buffer` without the same threading complexity for each. More surface area than Option 1 for no benefit.

**Verdict.** Rejected.

---

### Option 3: Performance API markers + dev-mode aggregator

**How it works.** Call `performance.mark('catgo:atom_data_fire')` inside each suspect body. A polling `setInterval` reads `performance.getEntriesByName()` to count marks.

**Cons.** Allocates a `PerformanceEntry` object per call — GC pressure at 300+ calls/second during trajectory. Buffer overflow causes silent entry loss. Requires polling for aggregation. More awkward to read than integer counters. Worse in every dimension relevant to this use case.

**Verdict.** Rejected.

---

### Option 4: `globalThis.__catgo_probe` surface (the *exposure mechanism*, paired with Option 1)

**How it works.** This is the cross-component API layer, not a counting mechanism on its own. It exposes Option 1's counters as a structured API: `snapshot()`, `reset()`, `assert_silence(keys)`. Exported from a single `$effect` at the bottom of `StructureScene.svelte`'s `<script>` block, gated on `import.meta.env?.DEV`.

**Verdict.** Option 4 is the *export strategy* for Option 1's counters. These two are used together.

---

### Option 5: `$effect`-based periodic reporter

**How it works.** A single `$effect` in StructureScene reads `trajectory_frame_positions` (subscribes to frame advances) and every 60 frames logs the fire counters to console.

**Verdict.** Useful as supplementary passive reporting during manual testing. Does not produce machine-readable pass/fail for Playwright tests. Used in addition to Options 1+4, not instead.

---

## Recommendation

**Use Option 1 (module-level counters inside each suspect body) + Option 4 (`globalThis.__catgo_probe` exposure surface), with Option 5 as a supplementary periodic reporter.**

The v2 T2.3 purity concern is resolved: writing to a plain `let` variable inside `$derived.by()` does NOT violate Svelte 5's purity contract. The reactive scheduler is unaffected. The existing `__atom_data_fast_count` counter at `StructureScene.svelte:1875` proves this pattern works correctly in the current codebase. This design is an extension of an established pattern, not an invention.

All probe code is gated on `import.meta.env?.DEV`. In production, Vite replaces this with `false`, and dead-code elimination removes all probe logic. No production behavior change.

---

## Coverage Spec

| # | Observable | File:line | Type | Fires-during-trajectory meaning | Counter names | "Meaningful fire" definition |
|---|---|---|---|---|---|---|
| 1 | `atom_data` | `StructureScene.svelte:1877` | `$derived.by()` | **Regression at Phase 4+**: `structure` is changing per frame (old cascade still active). At baseline `29420f91`: fires per frame but takes the trajectory fast-path, so `meaningful = 0`. | `atom_data_fires`, `atom_data_meaningful` | Reaches the slow-path first-pass loop immediately after the comment `// First pass: compute initial colors for all sites` (~line 1939). Increment `meaningful` immediately before that comment. |
| 2 | `build_bond_pairs $effect.pre` | `StructureScene.svelte:1552` | `$effect.pre` | **Phase-dependent.** At baseline: fires per frame (`bbp_fires ~60/s`) but the `stable` memo guard at line 1572 returns early (`bbp_meaningful = 0`). At Phase 4+: neither fires. | `bbp_fires`, `bbp_meaningful` | Reaches `bond_pairs = build_bond_pairs(...)` at line 1587, past the `if (stable) { return }` block. |
| 3 | X2 shadow sync | `StructureScene.svelte:2263` | `$effect` | At baseline: fires per frame via the `trajectory_only` fast-path. At Phase 4+ (before Phase 5.5): fires per frame but returns via `!anything_changed` guard (struct_changed = false, traj_changed = true but effect is a no-op since Phase 2 already wrote positions). At Phase 5.5+: returns at the new `if (traj_positions != null) return` gate. | `x2_fires`, `x2_traj_fast_path_fires`, `x2_slow_meaningful` | `x2_slow_meaningful` increments only when reaching the slow path at line 2397 (after `__x2_initialized = true`). `x2_traj_fast_path_fires` increments at the `return` inside the `trajectory_only` branch (line 2363). |
| 4 | `atom_positions_buffer` | `StructureScene.svelte:2756` | `$derived.by()` | **Regression at Phase 4+**: reads `structure?.sites` directly; fires and allocates a new `Float32Array` whenever `structure` changes per frame. W3 missed this consumer. | `apb_fires`, `apb_meaningful` | Any execution that reaches `const buf = new Float32Array(sites.length * 3)` at line 2759. No inner memo — every fire past the null guard is meaningful. |
| 5 | `atom_colors_buffer` | `StructureScene.svelte:2771` | `$derived.by()` | **Regression at Phase 4+**: same as `atom_positions_buffer`. W3 missed this consumer. | `acb_fires`, `acb_meaningful` | Any execution that reaches `const out = new Float32Array(sites.length * 3)` at line 2774. No inner memo. |
| 6 | `new_atom_hidden_site_ids` | `StructureScene.svelte:1726` | `$derived.by()` | **Regression at Phase 4+**: reads `structure?.sites`; fires whenever `structure` changes per frame. At baseline: fires per frame. | `nhsi_fires`, `nhsi_meaningful` | Reaches the `for (let site_idx = 0; ...)` loop at line 1736. Guard at line 1727 (`if (!USE_NEW_ATOM_SYSTEM) return undefined`) skips meaningful work when the flag is off. |

**Note on omitted consumers.** `filtered_bond_pairs` at `StructureScene.svelte:2035` reads `bond_state.last_bond_structure` (not `structure`); it does NOT fire per trajectory frame on the patched baseline because `last_bond_structure` is frozen during playback. No probe needed. The CHEAP-CASCADE consumers (`ctx_constraints_section` at `Structure.svelte:1475`, `ctx_charge_label_section` at `Structure.svelte:1483`, `has_charges` at `AtomLegend.svelte:82`) fire per frame under the current architecture but are O(1) and do not cause visual regressions. They are not regression indicators for Architecture P. Omitted from required coverage; add if completeness is desired.

---

## Phase Calibration Matrix

This matrix corrects Reviewer 2's finding: "W1 must remain silent at Phase 2" is a calibration error. The correct interpretation is that W1 MUST fire at Phase 2 (old cascade still active). Silence is only required starting at Phase 4.

**Notation.** "~60" = approximately 60 per second (60fps playback). "0" = exactly zero. Phase numbers align with W6-architecture-decision.md § "What plan v3 looks like."

| Phase | `atom_data_fires`/s | `atom_data_meaningful`/s | `bbp_fires`/s | `bbp_meaningful`/s | `x2_traj_fast`/s | `x2_slow_meaningful`/s | `apb_fires`/s | `acb_fires`/s | W1 verdict |
|---|---|---|---|---|---|---|---|---|---|
| Baseline `29420f91` | ~60 | **0** (fast-path absorbs) | ~60 | **0** (stable guard) | ~60 | 0 | ~60 | ~60 | **LOUD — detector must show non-zero `apb_fires`, `atom_data_fires`** |
| Phase 0 (W1 added, no behavior change) | ~60 | 0 | ~60 | 0 | ~60 | 0 | ~60 | ~60 | LOUD — same as baseline |
| Phase 1 (atom_manager lift) | ~60 | 0 | ~60 | 0 | ~60 | 0 | ~60 | ~60 | LOUD — no behavior change |
| Phase 2 (position-write loop in Structure.svelte; old `current_structure` write still active) | ~60 | 0 | ~60 | 0 | ~60 | 0 | ~60 | ~60 | **LOUD — W1 MUST fire; detecting that it fires validates correct Phase 2 behavior** |
| Phase 3 (bond fast-path wired; old path still active) | ~60 | 0 | ~60 | 0 (if `__bbp_prev_traj` guard correct) or ~60 (if missing) | ~60 | 0 | ~60 | ~60 | LOUD |
| **Phase 4 (stop `current_structure` write — the pivot)** | **0** | **0** | **0** | **0** | 0 (X2 fires but returns at `!anything_changed`) | **0** | **0** | **0** | **SILENT on the critical counters — Phase 4 success criterion** |
| Phase 5 (pause-and-edit handler) | 0 during playback; 1 at pause-triggered writeback | 0 during playback | 0 | 0 | ~60 (X2 still fires, no-op) | 0 | 0 | 0 | **SILENT during playback** |
| Phase 5.5 (X2 gate: `if (traj_positions != null) return`) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | SILENT |
| Phase 6 (delete patches) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | SILENT — hard pre-condition |

**Pass/fail criteria:**

- **Phase 0 acceptance:** `atom_data_fires > 0` AND `apb_fires > 0` during 5s playback. If either is 0, the probe is mis-wired.
- **Phase 4 acceptance:** `atom_data_fires = 0` AND `atom_data_meaningful = 0` AND `apb_fires = 0` AND `acb_fires = 0` AND `bbp_fires = 0` AND `x2_slow_meaningful = 0` — all sustained across the full W7 test matrix.
- **Phase 6 pre-condition (hard):** The Phase 4 acceptance criteria have been true for one complete testing session with no exceptions. Any single unexpected fire during that session means Phase 6 is unsafe.

**Critical note on `bbp_fires` vs `bbp_meaningful` at baseline.** `bbp_fires ≈ 60/s` at baseline because `$effect.pre` fires per frame (Svelte fires it when `struct_ref` changes). `bbp_meaningful = 0` at baseline because the `stable` memo guard at line 1572 returns early every time — the guard IS working. Asserting `bbp_meaningful = 0` passes both at baseline AND after Phase 4. Asserting `bbp_fires = 0` only passes after Phase 4. Use `bbp_fires = 0` as the Phase 4 success criterion; use `bbp_meaningful = 0` as the baseline sanity check.

---

## Validation Plan Against the Current Patched Baseline

### Expected counter values at baseline (`29420f91`) for 5-second playback, 878-atom structure, ~60fps

| Counter | Expected value after 5s (300 frames) |
|---|---|
| `atom_data_fires` | ~300 |
| `atom_data_meaningful` | 0 |
| `bbp_fires` | ~300 |
| `bbp_meaningful` | 0 |
| `x2_fires` | ~300 |
| `x2_traj_fast_path_fires` | ~300 |
| `x2_slow_meaningful` | 0 |
| `apb_fires` | ~300 |
| `apb_meaningful` | ~300 |
| `acb_fires` | ~300 |
| `acb_meaningful` | ~300 |
| `nhsi_fires` | ~300 (if `USE_NEW_ATOM_SYSTEM = true`) or 0 (if false) |
| `nhsi_meaningful` | ~300 (if `USE_NEW_ATOM_SYSTEM = true` and atoms are not all hidden) or 0 |

**Note:** Actual fps depends on hardware. At 30fps: expect ~150 fires. At 120fps: expect ~600 fires. Counts should scale linearly with fps. The key signal is whether the counter is NON-ZERO during playback, not the exact value.

### Step-by-step validation procedure

**Step 1 — Prerequisites.**
- Current branch `atom-soa-refactor` at HEAD (`bd0da10f`). The patched `StructureScene.svelte` is present.
- Dev server running: `pnpm dev` (web mode) or `pnpm desktop:serve` (desktop mode).
- A trajectory file that produces visible animation. Any `.xyz` multi-frame trajectory for a 400–900 atom structure works. The test can be done with a 2-frame trajectory if needed — the counter just won't reach the 300-frame target.

**Step 2 — Implement W1.1 (the first milestone commit).**
Apply the counter declarations and body instrumentation described in Implementation Milestones § W1.1 to `src/lib/structure/StructureScene.svelte`. This is the only file modified.

**Step 3 — Confirm TypeScript compiles.**
```
pnpm check
```
The existing repo has pre-existing type errors (documented in MEMORY.md). Confirm no NEW errors are introduced by the probe additions.

**Step 4 — Start dev server, load a structure.**
Navigate to `http://localhost:3000`. Load any CIF or POSCAR for a medium-sized structure (100–878 atoms) using file drag-drop or the OPTIMADE search.

**Step 5 — Confirm probe is wired.**
Open browser DevTools console. Type:
```javascript
window.__catgo_probe
```
Expected: an object with `snapshot`, `reset`, `assert_silence` methods. If `undefined`: the probe export `$effect` has not mounted. Check console for Svelte errors. Confirm `StructureScene.svelte` is in the active component tree.

**Step 6 — Load a trajectory.**
Use the trajectory panel in the CatGo UI to load a multi-frame trajectory for the current structure. Confirm the playback controls appear (play/pause/stop buttons, frame slider).

**Step 7 — Set up timing.**
In the console:
```javascript
window.__catgo_probe.reset()
setTimeout(() => {
  const s = window.__catgo_probe.snapshot()
  console.log('5-second playback snapshot:', JSON.stringify(s, null, 2))
  window.__catgo_probe.reset()
}, 5000)
```

**Step 8 — Start playback immediately after Step 7.**
Press the trajectory play button within 1 second of running Step 7's `setTimeout`.

**Step 9 — After 5 seconds, read the logged snapshot.**
The console should print the snapshot. Compare against the expected values table.

**Step 10 — Acceptance check.**
The detector passes if:
- `atom_data_fires > 0` — proves `atom_data` IS firing during trajectory on the patched baseline. This is the primary signal.
- `apb_fires > 0` — proves the W3-missed `atom_positions_buffer` consumer IS firing.
- `acb_fires > 0` — proves the W3-missed `atom_colors_buffer` consumer IS firing.

If any of these are 0 during 5s of active playback, the probe counter is mis-wired — debug before proceeding with plan v3.

**Step 11 — Confirm no false positives during idle.**
Stop playback. Reset: `window.__catgo_probe.reset()`. Wait 5 seconds without playing. Run `window.__catgo_probe.snapshot()`. All counters should be 0 or at most 1–2 (from the stop-triggered one-time topology recompute). This proves the detector does not false-positive during normal interactive use.

**Step 12 — Record baseline.**
Write down the actual Step 9 counter values. Store them as a comment in the `$effect` that exports `__catgo_probe` in `StructureScene.svelte`, or in a `plans/W1-baseline-readings.md` file. These values become the "before" record for comparing against Phase 4 results.

**Step 13 — (Optional) Playwright automation.**
In the W7 test suite, add:
```javascript
test('W1: cascade detector fires loud on known-bad patched baseline', async ({ page }) => {
  await page.goto('/')
  // Load structure + trajectory via the test fixture path
  await page.evaluate(() => window.__catgo_probe.reset())
  // Start playback
  await page.click('[data-testid="trajectory-play"]')
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => window.__catgo_probe.snapshot())
  expect(s.atom_data_fires).toBeGreaterThan(100)
  expect(s.apb_fires).toBeGreaterThan(100)
  expect(s.acb_fires).toBeGreaterThan(100)
})

test('W1: cascade detector silent after Phase 4 pivot', async ({ page }) => {
  // Identical setup but run after Phase 4 is landed
  await page.evaluate(() => window.__catgo_probe.reset())
  await page.click('[data-testid="trajectory-play"]')
  await page.waitForTimeout(2000)
  const s = await page.evaluate(() => window.__catgo_probe.snapshot())
  expect(s.atom_data_fires).toBe(0)
  expect(s.apb_fires).toBe(0)
  expect(s.acb_fires).toBe(0)
  expect(s.bbp_fires).toBe(0)
  expect(s.x2_slow_meaningful).toBe(0)
})
```

---

## Implementation Milestones

### Milestone W1.1: Add counters + probe surface (2h, one commit)

**File: `src/lib/structure/StructureScene.svelte` only. No behavior changes.**

The implementation adds 13 counter variables (after line 1875), instruments 6 observable bodies, and adds one probe-surface `$effect` at the end of the `<script>` block. All additions are inside `if (import.meta.env?.DEV)` guards.

The counter block must be declared OUTSIDE any reactive context (at script scope level alongside `__atom_data_fast_count`) so they survive across reactive re-runs and are visible to the probe export `$effect`. Counter declarations are plain `let` — not `$state`, not `$derived`.

The probe export `$effect` reads the module-level counter variables directly (not via reactive subscription) inside the `snapshot()` closure. Since the counters are not `$state`, the closure captures a reference to the variable by name — in Svelte 5 compiled output, this works correctly because the variables are in the component instance scope.

### Milestone W1.2: Run validation, record baseline (0.5h, documentation only)

Execute the validation procedure from § Validation Plan. Record actual counter values for the patched baseline in a comment block inside `StructureScene.svelte` near the counter declarations:
```typescript
// W1 baseline reading (2026-04-26, commit 29420f91, 878-atom Al-MOF trajectory, ~60fps, 5s):
// atom_data_fires: 287, atom_data_meaningful: 0
// bbp_fires: 291, bbp_meaningful: 0
// x2_fires: 290, x2_traj_fast_path_fires: 290, x2_slow_meaningful: 0
// apb_fires: 289, apb_meaningful: 289
// acb_fires: 288, acb_meaningful: 288
// nhsi_fires: 290, nhsi_meaningful: 290  (USE_NEW_ATOM_SYSTEM = true)
```
(Exact values to be filled in after running Step 12.)

---

## Production Behavior

All 13 counter increment statements are wrapped in `if (import.meta.env?.DEV)`. Vite's build process replaces `import.meta.env.DEV` with `false` in production, making each guard equivalent to `if (false)`. Rollup/terser's dead-code elimination removes the `if (false) { counter++ }` branches entirely from the compiled bundle.

The probe surface export `$effect` starts with `if (!import.meta.env?.DEV) return`. In production, this compiles to `if (!false) return` → `if (true) return` → the entire effect body is never executed. The `globalThis.__catgo_probe` assignment never runs.

**Verification:** After `pnpm build`, search the `dist/` output:
```bash
grep -r '__catgo_probe\|__probe_atom_data' dist/ && echo "FAIL: probe in production" || echo "PASS: probe tree-shaken"
```
Expected: `PASS`.

---

## Open Questions for Plan v3

1. **Phase 5.5 necessity before Phase 6.** W6-review-sequencing.md (CRITICAL) identifies that deleting the X2 `trajectory_only` branch in Phase 6 without first adding `if (trajectory_frame_positions != null) return` at the top of the X2 `$effect` causes a 15–30ms/frame regression (X2 falls through to the slow path). Plan v3 must insert Phase 5.5 between Phase 5 and Phase 6. W1's `x2_slow_meaningful` counter will confirm whether Phase 5.5 is in place: at Phase 5.5, `x2_slow_meaningful = 0` even with `x2_fires > 0`.

2. **`x2_fires` behavior post-Phase 4.** After Phase 4, X2 still fires per frame because it subscribes to `trajectory_frame_positions` at line 2289. With `struct_changed = false` and `traj_changed = true`, X2 enters the `trajectory_only` branch — a no-op loop since Trajectory.svelte's position-write loop already wrote the same values. This means `x2_traj_fast_path_fires ≈ 60/s` at Phase 4, not 0. W1 should treat this as expected at Phase 4. Only after Phase 5.5 does `x2_traj_fast_path_fires` drop to 0. Plan v3 must document this in its success criteria per phase.

3. **Component topology correction for Phase 1/2 deliverables.** W6-review-sequencing.md (Phase 2 HIGH) establishes that `Structure.svelte` does not render `<Trajectory>` — Trajectory.svelte is Structure.svelte's PARENT. The position-write loop must live in `Structure.svelte` (which receives `trajectory_frame_positions` as an incoming prop) and write to `scene_atom_manager` (the local `$state` ref to the `$bindable` atom_manager after Phase 1). Plan v3 must correct W6's Phase 1 and Phase 2 deliverable descriptions to reflect this topology.

4. **Counter reset between playback sessions.** For Playwright automation, counters must be reset before each timed window. `window.__catgo_probe.reset()` provides this. For manual testing, the requirement is documented in the validation procedure. Consider adding auto-reset logic in a future W1.3 that resets counters when `trajectory_active` flips false → true — but this requires `trajectory_active` to be readable inside StructureScene (derivable from `trajectory_frame_positions != null`, which StructureScene already subscribes to via the X2 effect).

5. **`bbp_meaningful` split for Phase 3.** After Phase 3 adds the `if (trajectory_active && trajectory_frame_positions)` fast-path branch at the top of `build_bond_pairs $effect.pre`, that path calls `build_trajectory_bond_pairs` and returns. Is this a "meaningful fire"? Architecturally yes (bond pairs are being updated), but it is not the "slow path." The current counter design increments `bbp_meaningful` only at the slow-path call (`bond_pairs = build_bond_pairs(...)`). A separate `bbp_traj_fast_fires` counter should be added in W1.1 to track the Phase 3 fast-path. This is a minor addition that can land in the same commit or in a W1.3.

6. **`nhsi_fires` with `USE_NEW_ATOM_SYSTEM`.** The feature flag at `StructureScene.svelte:1727` (`if (!USE_NEW_ATOM_SYSTEM) return undefined`) makes `nhsi_meaningful` always 0 when the flag is false. Since `USE_NEW_ATOM_SYSTEM = true` is the active state (per MEMORY.md), this is not a concern for the primary validation. But the validation procedure should confirm `USE_NEW_ATOM_SYSTEM` is true before interpreting `nhsi_fires` values.
