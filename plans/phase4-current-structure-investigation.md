# Phase 4 — current_structure Removal Scope Investigation

**Branch:** atom-soa-refactor @ 54705594
**Resolves:** W6 Open Question #2 (HIGH-severity plan v3 blocker)

---

## TL;DR

There is exactly **one write site** for `current_structure` in `src/lib/trajectory/Trajectory.svelte`. It lives in a single `$effect` (lines 448–468) that fires on every `current_frame` change — meaning first-frame load and all subsequent frame-advances travel through **the same code path**. The write at line 459 (`current_structure = frame.structure`) is unconditional for any frame that has a structure. There is no distinct "topology-initialization-only" write. Phase 4, as originally described in W6, is therefore **not** a one-line deletion that can distinguish "load-once" from "per-frame" writes, because no such distinction exists in the current code. The entire `$effect` does both jobs simultaneously. Architecture P's Phase 4 must either (a) replace the structure assignment with a position-only fast path and add a separate first-frame guard, or (b) as W6-Reviewer-2 concluded, move the write loop into `Structure.svelte` itself.

---

## Every `current_structure` Write Site

**Declaration:** `Trajectory.svelte:278`
```ts
let current_structure = $state<AnyStructure | undefined>(undefined)
```

### Write Site 1 — Line 451 (clear/reset)

- **File:line:** `Trajectory.svelte:451`
- **Trigger:** The `$effect` (lines 448–468) fires whenever `current_frame` changes. This branch fires when `current_frame` is null or when `current_frame.structure` is falsy — covers trajectory not loaded, step-out-of-range, and load errors.
- **Code:** `current_structure = undefined`
- **Purpose:** State reset / clear. Sets structure to undefined so `<Structure>` renders nothing.
- **Classification:** KEEP under Architecture P — this is the "no active frame" state clear.

### Write Site 2 — Line 459 (per-frame + first-frame combined)

- **File:line:** `Trajectory.svelte:459`
- **Trigger:** Same `$effect` as above. Fires for every frame advance (`current_step_idx` changes → `current_frame` changes → effect fires). Also fires for the first frame when a trajectory is loaded.
- **Code:** `current_structure = frame.structure`
- **Purpose:** DUAL USE.
  1. **Topology initialization** — first time a trajectory is loaded, `frame.structure` is `frames[0].structure`, which contains element identities, species, lattice, and all topology. Writing this triggers Structure.svelte's full reactive pipeline: `cell_transformed_structure → supercell → PBC → displayed_structure`. This is how the trajectory's base topology reaches the renderer on load.
  2. **Per-frame position delivery** — every subsequent frame advance writes a new `frame.structure` which has new `.sites[i].xyz` values. This again triggers Structure.svelte's pipeline.
- **Classification:** GATED under Architecture P — this is the write that Phase 4 must surgically change.

**No other writes exist.** There are no load-once-only write paths, no init effects, and no separate "first frame" special case in the current code.

---

## How Trajectory Advance Works

**Mechanism:** `setInterval`-based, NOT `requestAnimationFrame`.

**Location:** `Trajectory.svelte:616–652`

When the user clicks Play, `start_playback()` sets `is_playing = true`. The `$effect` at line 616 watches `is_playing` and `fps`. When `is_playing` is true, it calls `setInterval(() => { ... next_step() ... }, 1000 / fps)`. Each tick calls `next_step()` at line 536, which increments `current_step_idx`.

**Per-tick write chain:**
1. `next_step()` → `current_step_idx++`
2. The `$effect` at lines 296–312 fires (reads `current_step_idx`, `trajectory`) → sets `current_frame = trajectory.frames[current_step_idx]` (or calls `load_frame_on_demand` for indexed trajectories)
3. The `$effect` at lines 448–468 fires (reads `current_frame`) → writes `current_structure = frame.structure` AND sets `trajectory_frame_positions = position_cache[current_step_idx]`
4. Both `current_structure` (via `bind:structure`) and `trajectory_frame_positions` (via prop) flow into `<Structure>` at line 1599–1620

The interval is cleared in the same `$effect` when `is_playing` becomes false, and cleaned up on component destroy at lines 654–658.

---

## First-Frame Load Path

When a user drags in a trajectory file or selects one via browse:

1. **File content arrives** → `load_trajectory_data(data, filename)` (line 803)
2. **Parsing** → `trajectory = await parse_trajectory_async(...)` (line 826) or `load_with_indexing` (line 872)
3. **Reset** → `pending_ops = []`, `frame_op_cursor = ...`, `current_step_idx = 0` (line 838)
4. Setting `current_step_idx = 0` triggers the frame-change `$effect` at lines 296–312
5. For in-memory trajectories: `materialize_frame(0)` + `current_frame = trajectory.frames[0]`
6. For indexed trajectories: `load_frame_on_demand(0)` → async load → `current_frame = frame`
7. `current_frame` changing triggers the `$effect` at lines 448–468
8. This effect writes **both** `current_structure = frame.structure` (line 459) AND `trajectory_frame_positions` (lines 461–466)

**Critical observation:** The position cache (`position_cache`) is built asynchronously by the `$effect` at lines 346–441. On the very first frame after load, `position_cache` may not yet be built (the initial build uses `setTimeout(build_chunk, 0)` chunks). The `$effect` at 448–468 correctly handles this: `if (position_cache) { trajectory_frame_positions = ... } else { trajectory_frame_positions = null }`. So on the first frame, `trajectory_frame_positions` may be null, but `current_structure = frame.structure` is always written regardless.

This means the first frame ALWAYS writes `current_structure`, which triggers Structure.svelte's full `cell_transformed_structure → supercell → PBC → displayed_structure` pipeline to establish topology. The `trajectory_frame_positions` fast path is additive — it only engages once the cache is built.

**There is no separate "topology-only" initialization path.** The first frame goes through the same write as all subsequent frames.

---

## Other Consumers of `current_structure`

**1. `<Structure bind:structure={current_structure}>` — line 1600**
This is the primary consumer. The `$bindable` binding goes in both directions: Trajectory.svelte writes `current_structure` and Structure.svelte reads it as `structure` (its own `$bindable` prop). Structure.svelte can also write back through this binding (e.g., when the user edits atoms, Structure.svelte writes the modified structure back to `current_structure` in Trajectory.svelte). This bidirectional contract is the W2 issue.

**2. `push_back_current_frame()` — lines 226, 236**
Reads `current_structure` as a guard (`if (!current_structure) return`) and then calls `structure_to_poscar_str(current_structure)` to serialize the current frame's structure for HPC push-back. This is a read-only use in an async function triggered by user action.

**3. `can_push_back` derived — lines 284–286**
`let can_push_back = $derived(!!remote_origin && !!current_frame_source && !!current_structure)` — used to show/hide the push-back button. Read-only derived.

**No frame-count display or plot series reads `current_structure`.** Plot data comes from `trajectory.frames` via `generate_plot_series`, not from `current_structure`.

---

## Component Topology

Trajectory.svelte is the **PARENT** of Structure.svelte. The relationship is:

```
Trajectory.svelte
  ↓ renders
  <Structure bind:structure={current_structure}
             trajectory_frame_positions={trajectory_frame_positions}
             trajectory_frame_forces={trajectory_frame_forces}
             ... >
```

Structure.svelte does NOT render a `<Trajectory>` component. Structure.svelte receives `trajectory_frame_positions` as an incoming prop (declared at `Structure.svelte:791`) and passes it down to `<StructureScene>`.

**Call sites for `<Trajectory>` in the codebase:**
- `desktop/App.svelte:1149` — renders `<Trajectory trajectory={pane.trajectory}>` with no `bind:current_structure`. Trajectory manages `current_structure` entirely internally and exposes the structure to the user via the embedded `<Structure>` child.
- `src/routes/+page.svelte:2` — imports Trajectory from `$lib` (SvelteKit web demo page)
- `desktop/App.svelte:3` — imports Trajectory from `$lib`

None of the call sites bind to `current_structure` — it is internal state of Trajectory.svelte, not a public `$bindable` prop. The parent (App.svelte) does not declare `current_structure` as `$state`.

---

## `trajectory_frame_positions` Flow

**Where set:**
1. `Trajectory.svelte:444` — `let trajectory_frame_positions = $state<Float32Array | null>(null)` (local state)
2. `Trajectory.svelte:462` — `trajectory_frame_positions = position_cache[current_step_idx] ?? null` (set per-frame in the frame-advance `$effect`, when position_cache exists)
3. `Trajectory.svelte:452, 465` — `trajectory_frame_positions = null` (cleared when no frame or no cache)

**Where read / passed:**
1. `Trajectory.svelte:1601` — passed as prop to `<Structure {trajectory_frame_positions}>` (template)
2. `Structure.svelte:791` — declared as incoming prop `trajectory_frame_positions = null`
3. `Structure.svelte:1114` — `let trajectory_active = $derived(trajectory_frame_positions != null)` — gates align-on-load effect
4. `Structure.svelte` passes `trajectory_frame_positions` down to `<StructureScene>`
5. `StructureScene.svelte:470` — declared as prop `trajectory_frame_positions = null`
6. `StructureScene.svelte:2347` — read inside the X2 shadow sync `$effect` as `const traj_positions = trajectory_frame_positions`
7. `StructureScene.svelte:2406–2422` — the `trajectory_only` fast path: bulk-copy positions into `atom_manager` slots, skipping the full diff

**The full path:**
```
position_cache[frame_idx]  (pre-built Float32Array in Trajectory.svelte)
  → trajectory_frame_positions ($state in Trajectory.svelte:444)
    → <Structure {trajectory_frame_positions}> (Trajectory.svelte:1601)
      → Structure.svelte:791 (incoming prop)
        → <StructureScene {trajectory_frame_positions}> (Structure.svelte template)
          → StructureScene.svelte:470 (incoming prop)
            → X2 shadow sync $effect (StructureScene.svelte:2320)
              → trajectory_only branch: mgr.set_position() (StructureScene.svelte:2406–2412)
```

---

## Phase 4 Deliverable Specification

**Background:** Phase 4 aims to stop writing `current_structure = frame.structure` per frame during playback, because doing so triggers Structure.svelte's full reactive pipeline (~13–25ms/frame). Instead, Architecture P wants position updates to flow only through `trajectory_frame_positions` (~1–2ms/frame).

**The fundamental constraint discovered:**

The current code uses ONE `$effect` (Trajectory.svelte:448–468) that does both jobs — first-frame topology init AND per-frame position delivery — via the same `current_structure = frame.structure` assignment. There is no separate "load-once" path. Removing the assignment entirely would break first-frame topology initialization (Structure.svelte's pipeline would never run with the trajectory's base topology; `displayed_structure` would be stale or undefined).

**Concrete Phase 4 change:**

Gate the assignment behind a first-frame condition:

```ts
// Track whether topology has been initialized for the current trajectory.
// Reset when trajectory changes (new file loaded).
let topology_initialized = $state(false)
$effect(() => { trajectory; topology_initialized = false })  // reset on new trajectory

$effect(() => {
  const frame = current_frame
  if (!frame?.structure) {
    current_structure = undefined
    trajectory_frame_positions = null
    trajectory_frame_forces = null
    topology_initialized = false
    return
  }
  // First-frame topology initialization: always write structure
  // so Structure.svelte's reactive pipeline runs once to establish
  // element identities, lattice, and displayed_structure.
  if (!topology_initialized) {
    current_structure = frame.structure
    topology_initialized = true
  }
  // Per-frame: only update Float32Array, NOT current_structure.
  if (position_cache) {
    trajectory_frame_positions = position_cache[current_step_idx] ?? null
    trajectory_frame_forces = force_cache?.[current_step_idx] ?? null
  } else {
    // No position cache: fall back to full structure write (indexed/streaming traj)
    current_structure = frame.structure
    trajectory_frame_positions = null
    trajectory_frame_forces = null
  }
})
```

**Lines to modify:** `Trajectory.svelte:448–468` (the entire `$effect` block). No other lines need to change in this file for Phase 4.

**Coupling requirement:** Phase 4 cannot safely land without Phase 5 (pause-and-edit handler) in the same commit. With `current_structure` frozen at topology, a user who pauses and drags an atom will commit the drag to `frame[0]`'s positions, not the currently displayed frame's positions.

---

## Risks / Open Follow-Ups

**1. The `topology_initialized` guard interacts with trajectory reload.** The reset effect must fire before the frame-advance effect when `trajectory` changes and `current_step_idx = 0` is set. Verify at implementation time.

**2. Indexed/streaming trajectories have no `position_cache`.** For large files loaded via `load_with_indexing`, `position_cache` is null. The fallback branch correctly handles this — they still use full structure writes per frame. This is acceptable since indexed trajectories are the "large file" slow path and the performance improvement is only needed for in-memory trajectories.

**3. The `push_back_current_frame()` function reads `current_structure`.** If Phase 4 freezes `current_structure` at frame 0, pushing back frame N (where N ≠ 0) would serialize the frame-0 structure instead of the current frame's positions. This is a bug. Fix: `push_back_current_frame` should use `current_frame.structure` directly instead of `current_structure`.

**4. `can_push_back` derived (line 284) reads `current_structure`.** After Phase 4, `can_push_back` will be `true` even when displaying frame 50. The guard inside `push_back_current_frame` should switch to checking `!!current_frame?.structure` instead.

**5. Phase 4 + Phase 5 coupling.** If a user pauses at frame 50 and drags atom 3, Structure.svelte's drag-commit writes `structure = { ...structure, sites: new_sites }` where `structure` is the frozen topology frame's positions, not frame 50's. The atom snaps to frame-0 coordinates after commit. Phase 5 (which writes frame-50 positions back into `current_structure` on pause) must land in the same commit as Phase 4.

---

## 6-Line Summary

1. **Number of `current_structure` write sites:** 2 (line 451: clear to undefined; line 459: assign frame.structure — but both live in the same single `$effect` block).

2. **Are first-frame-load writes distinct from per-frame writes?** No. The first-frame write and all per-frame writes go through the identical code path (`current_structure = frame.structure` at line 459).

3. **Phase 4's correct scope:** Gate the `current_structure = frame.structure` assignment (Trajectory.svelte:459) behind a `!topology_initialized` condition so it fires only on the first frame of each newly loaded trajectory, while per-frame position updates flow exclusively through `trajectory_frame_positions`; additionally fix `push_back_current_frame` to read `current_frame.structure` instead of `current_structure`.

4. **Most surprising finding:** The position cache is built asynchronously via `setTimeout` chunks, which means on the very first frame after load `trajectory_frame_positions` is null even though `current_structure` was written. The Architecture P "fast path" only engages on frames 2+. The first render of every trajectory always uses the full Structure.svelte pipeline.

5. **Trajectory.svelte is the PARENT of Structure.svelte.** Trajectory.svelte renders `<Structure bind:structure={current_structure}>` in its template at line 1600. Structure.svelte does not know about Trajectory.svelte.

6. **Concrete recommended Phase 4 change:** At `Trajectory.svelte:459`, replace the unconditional `current_structure = frame.structure` with a `if (!topology_initialized) { current_structure = frame.structure; topology_initialized = true }` guard, add a separate `$effect(() => { trajectory; topology_initialized = false })` to reset on new trajectory load, and update `push_back_current_frame` (line 236) and `can_push_back` (line 285) to reference `current_frame.structure` instead of `current_structure`.
