# Broad Bug + Security Pass — `split-files...atom-soa-refactor`

**Reviewer:** `feature-dev:code-reviewer`
**Date:** 2026-04-28
**Branch:** `atom-soa-refactor` (`358f50a5`, 75 commits ahead of `split-files`)
**Scope:** Broader bugs, security issues, performance cliffs, race conditions, memory leaks, and breaking changes not covered by the narrow-lane reviewers.

---

## CRITICAL — Fix Before Merge

### C1 — `atom_positions_buffer` allocates a new `Float32Array` on every trajectory frame

**File:** `src/lib/structure/StructureScene.svelte` lines 2791–2836
**Confidence:** 95

`atom_positions_buffer` (line 2791) is a `$derived.by()` block that subscribes to `atom_manager.version` via `void mgr.version`. The Phase 2 position-write loop in `Structure.svelte` calls `mgr.set_position()` once per atom per frame. Each call that changes a value bumps `#version` (`$state`). This wakes `atom_positions_buffer`, which then allocates a fresh `Float32Array(sites.length * 3)` and does a full copy from `structure.sites` plus an overlay pass from the manager.

The baseline comment in StructureScene (lines 1565–1590) explicitly acknowledges `apb_fires: 15 / meaningful: 15` for a 15-frame window, labelling it as a "real regression indicator" and calling for Plan v3 Phase 4 to drop it to zero. The branch's own inline baseline confirms the regression is still present.

For a 878-site trajectory at 30fps over 10 seconds: ~30 × 878 × 3 × 4 = ~316 KB of GC pressure per second, plus a full memcpy overlay pass.

`atom_colors_buffer` (line 2822) has the same pattern but does NOT subscribe to `atom_manager.version` — only to `structure.sites`. Since Phase 4 freezes `structure.sites` after load, `atom_colors_buffer` should be silent during playback.

**Fix:** Replace `void mgr.version` with a separate `$state` counter that increments only when `set_position` calls cross a meaningful threshold (e.g., on trajectory frame change, not per-atom). Or make `atom_positions_buffer` a `$state` buffer that the Phase 2 loop writes into directly.

---

### C2 — Race between async position-cache build and trajectory swap: stale slot leak in fast-update path

**File:** `src/lib/trajectory/Trajectory.svelte` lines 470–532
**Confidence:** 85

The position cache build effect uses a `cancelled` flag to guard async writes. The cleanup function flips the flag on effect teardown. The guard looks correct.

**However:** the `existing_forces` path in the fast cache-update branch (lines 470–492) reads `force_cache ?? new Array(frames.length)` but writes back `position_cache = existing` (line 490) and `force_cache = existing_forces` (line 491). If `force_cache` was null before and `has_forces` is true, it allocates `new Array(frames.length)` as `existing_forces`, then creates per-frame sub-arrays only for indices that exist in the loop. Frames not yet populated remain as `undefined` slots in a sparse array. A stale trajectory swap that then reads `force_cache?.[current_step_idx]` on the new trajectory might pick up a populated slot from the old array if its index happens to match. **Silent data hazard** — wrong forces would appear briefly.

**Fix:** When the `trajectory` `$effect` triggers `topology_initialized = false` (line 556-558), also synchronously null out `position_cache` and `force_cache`.

---

### C3 — T5 writeback creates ordering hazard with Phase 5.5 gate

**File:** `src/lib/trajectory/Trajectory.svelte` lines 729–773
**Confidence:** 82

`pause_playback()` synchronously assigns `current_structure = { ...current_structure, sites: new_sites }`. The T5 writeback creates a brand new sites array which changes `current_structure`'s identity. This fires the X2 shadow sync, which will run the full diff. The Phase 5.5 gate (line 2353-2359) checks `trajectory_frame_positions != null` — at this point `trajectory_frame_positions` is still the current frame's Float32Array (it isn't cleared by pause). The gate suppresses X2.

Ordering appears safe but is fragile: any future change that clears `trajectory_frame_positions` on pause would break the gate.

**Recommended fix:** Document the invariant explicitly: "Phase 5.5 gate relies on `trajectory_frame_positions` being non-null during and immediately after `pause_playback()`. Do not clear `trajectory_frame_positions` in `pause_playback()`." Defer-with-rationale.

---

## IMPORTANT — Fix Before Merge

### I1 — DEV gating verified correct (no actual violation)
All `globalThis.*` writes are wrapped in `if (import.meta.env?.DEV)` checks with `$effect` cleanup teardown. Tree-shakes from prod. **No findings.**

### I2 — Test routes ship in production static build

**Files:** `src/routes/test/structure-trajectory/+page.svelte`, `src/routes/test/structure-trajectory-1f/+page.svelte`
**Confidence:** 88

The root layout sets `prerender = true` and `ssr = false`. Adapter is `@sveltejs/adapter-static`. There is no `+layout.ts` under `/src/routes/test/` blocking these routes. Since `prerender = true` is set globally with no route-level override, SvelteKit will prerender these test pages and include them in the production static output.

The pages serve a fully functional interactive trajectory viewer with hardcoded H2O and H4 fixture data, exposing `data-testid` attributes. In a production web deployment, any user navigating to `/test/structure-trajectory` gets a working feature page.

**Fix:** Add `/src/routes/test/+layout.ts` with:
```ts
import { dev } from '$app/environment'
import { error } from '@sveltejs/kit'
export function load() { if (!dev) error(404, 'Not found') }
```

---

### I3 — `atom_positions_buffer` per-frame allocation (overlap with C1)

**File:** `src/lib/structure/StructureScene.svelte` lines 2791–2818
**Confidence:** 96

The self-reported baseline data marks `apb_fires: 15 / meaningful: 15` as an open regression. The fix to prevent per-frame cascade existed in earlier plans but was not fully implemented here. The correct fix is to subscribe to `trajectory_frame_positions` (frame advance) AND keep the overlay loop, but drop the `mgr.version` subscription.

---

### I4 — `play_interval` declared as `$state` creates spurious reactive wakeups

**File:** `src/lib/trajectory/Trajectory.svelte` line 257
**Confidence:** 81

```ts
let play_interval: ReturnType<typeof setInterval> | undefined = $state(undefined)
```

The interval handle is an implementation detail with no business being reactive. The cleanup `$effect` doesn't establish a reactive dependency, but the pattern is fragile.

**Fix:** Change to plain `let play_interval: ReturnType<typeof setInterval> | undefined = undefined`. Use `untrack` where needed.

---

### I5 — `on_frame_rate_change` fires on trajectory load, not just fps changes

**File:** `src/lib/trajectory/Trajectory.svelte` lines 957–959
**Confidence:** 80

```ts
$effect(() => { on_frame_rate_change?.({ trajectory, fps: fps }) })
```

Subscribes to both `trajectory` and `fps`. The name suggests a rate-change callback, not a general state callback. Contract surprise.

**Fix:**
```ts
$effect(() => {
  const current_fps = fps
  on_frame_rate_change?.({ trajectory: untrack(() => trajectory), fps: current_fps })
})
```

---

### I6 — `position_cache` / `force_cache` not nulled synchronously on trajectory load

**File:** `src/lib/trajectory/Trajectory.svelte` lines 988–993
**Confidence:** 80

`load_trajectory_data()` resets `pending_ops`, `frame_op_cursor`, `current_step_idx` but does NOT reset `position_cache` or `force_cache`. The `current_frame $effect` reads `position_cache` and could briefly pick up old-trajectory data on fast swap.

**Fix:** Inside `load_trajectory_data`, immediately after `trajectory = ...`:
```ts
position_cache = null
force_cache = null
```

---

## DEFERRED — Acceptable for This PR, Track as Follow-Up

### D1 — `atom_positions_buffer` per-frame allocation is a known open regression (self-documented)
The baseline readings at StructureScene.svelte lines 1565–1590 are accurate and self-aware. Plan v3 addresses it. Track as follow-up.

### D2 — `AtomManagerInstances.svelte` `max_capacity = 200_000` fixed cap
For realistic chemistry trajectories (typically <10,000 atoms), 200,000 is a safe ceiling. Comment at line 84 acknowledges as "static cap for X3 PoC."

### D3 — `show_hydrogen_bonds` two-way sync pattern has loop potential
Identity guards prevent infinite loops in steady state. Risk is one-frame oscillation if both write simultaneously. Defer.

### D4 — Position-cache chunk build `setTimeout` yielding
`setTimeout(fn, 0)` yields to macrotask level, microtask flush runs first. Cancellation flag visible before next build. Intentional and safe.

---

## CODE QUALITY — Drive-By Observations

### Q1 — `// eslint-disable-next-line no-console` suppression comments
DEV-gated `console.log` calls bypass the linter via disable comments rather than using a proper dev-only logging helper. Minor code-quality issue.

### Q2 — `W1.2 BASELINE READING` comment block documents a KNOWN FAILURE
The 25-line comment block explicitly documents that `bbp_fires/meaningful = 17/15` and `nhsi_fires/meaningful = 15/15` during playback. If the test suite asserts `bbp_meaningful === 0` as the Phase 6 success criterion, the branch may be shipping with failing assertions. **Verify the Playwright suite passes before merge.**

### Q3 — `__x2_traj_fast_path_fires` counter declared but never incremented

**File:** `src/lib/structure/StructureScene.svelte` line 1599, 3448

The counter appears in `snapshot()` (3448) and `reset()` (3543) but no increment site is visible. If the Phase 5.5 gate replaced the old `trajectory_only` fast-path branch, the counter became orphaned. Tests asserting `x2_traj_fast_path_fires > 0` would fail silently.

---

## SUMMARY

| # | Severity | Description | File | Action |
|---|----------|-------------|------|--------|
| C1 | CRITICAL | `atom_positions_buffer` allocates new Float32Array every frame | StructureScene.svelte:2791 | Fix before merge |
| C2 | CRITICAL | Force-cache fast-update path creates sparse array with stale slots on trajectory swap | Trajectory.svelte:470-492 | Fix before merge |
| C3 | IMPORTANT | T5 pause writeback ordering hazard with Phase 5.5 gate — document invariant | Trajectory.svelte:729-764 | Defer with rationale |
| I2 | IMPORTANT | Test routes ship in production static build | src/routes/test/ | Fix before merge |
| I4 | IMPORTANT | `play_interval` stored in `$state` adds unnecessary reactive surface | Trajectory.svelte:257 | Fix before merge |
| I5 | IMPORTANT | `on_frame_rate_change` fires on trajectory load not just fps change | Trajectory.svelte:957 | Fix before merge |
| I6 | IMPORTANT | `position_cache`/`force_cache` not nulled synchronously on trajectory load | Trajectory.svelte:988 | Fix before merge |
| D1 | DEFERRED | Per-frame Float32Array in `atom_positions_buffer` — known open gap | StructureScene.svelte | Track follow-up |
| D2 | DEFERRED | Fixed 200k atom cap in AtomManagerInstances | AtomManagerInstances.svelte | Track follow-up |
| Q3 | QUALITY | `__probe_x2_traj_fast_path_fires` counter is orphaned | StructureScene.svelte:1599 | Fix counter or remove |

**Security pass result:** All `globalThis.*` writes are correctly DEV-gated with `import.meta.env?.DEV` checks and `$effect` cleanup teardown. **The only security-adjacent issue is the test routes shipping in the static build (I2).**
