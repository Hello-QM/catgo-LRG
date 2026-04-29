# Type-Design Analyzer Review — `__catgo_probe` & `__catgo_traj_test`

**Reviewer:** `pr-review-toolkit:type-design-analyzer`
**Branch:** `atom-soa-refactor` (vs `split-files` baseline)
**Date:** 2026-04-28
**Scope:** the DEV-only Playwright probe surface added in W7 Milestone 5

Files inspected:
- `src/lib/structure/StructureScene.svelte` (probe `$effect` at L3431-3559)
- `src/lib/structure/Structure.svelte` (`__catgo_align_on_load_fires` increment at L1208-1211)
- `src/lib/trajectory/Trajectory.svelte` (`__catgo_traj_is_playing` at L215-221, `__catgo_traj_test` at L228-243)
- `src/lib/structure/atoms/atom-manager.svelte.ts` (`AtomManager` API at L160-228)
- `tests/playwright/structure-trajectory.test.ts` (probe consumer)
- `tests/playwright/helpers/project_to_pixel.ts`

## Executive summary

The probe surface is **mostly well-designed for its purpose**. All probes are correctly DEV-gated via `import.meta.env?.DEV` plus `$effect` cleanup. Main weaknesses:

1. **Three globalThis back-channels** (`__catgo_traj_is_playing`, `__catgo_align_on_load_fires`, `__catgo_traj_test`) act as unstructured cross-component state with hidden coupling.
2. **`atom_manager_capacity`** leaks a renderer-implementation invariant (the SOA grow-only buffer) directly into the test contract — couples Test 5.2 to the current storage strategy.
3. **`is_playing` and `align_on_load_fires`** require a running `StructureScene` `$effect` to fetch values placed on `globalThis` by other components — a TOCTOU-ish reactivity dance.
4. **`get_camera_matrices()`** exposes Three.js matrix internals as raw `number[]` and pushes the projection math out into `tests/playwright/helpers/project_to_pixel.ts`, which has to stay in lockstep with Three.js's column-major convention.
5. **`selected_site_id` is correctly typed (`number | null`)** but its semantics ("LAST element of selected_sites") are misleading — the underlying `selected_sites` is a list, not a singleton, and the model supports multi-select.

None blocking — but several should be addressed before this surface accumulates more clients.

## Probe-by-probe analysis

### 1. `get_structure_site_x(site_idx: number) => number | null`
- **Verdict:** **Keep as-is.** Canonical example of a well-designed probe. Distinguished from `get_atom_x` (GPU SOA) by name. The `typeof x === 'number'` check is *better* than `?? null`.

### 2. `atom_manager_capacity: number`
- **Concerning:** `capacity` is an internal SOA-buffer grow-only invariant. Test 5.2 ("no GPU buffer growth across 10 trajectory loads") asserts on this number across reloads. If renderer migrated to chunk pools or WebGPU storage buffers, the test would falsely fail.
- What Test 5.2 *actually* wants is "we don't leak GPU memory."
- **Verdict:** **Rename to `gpu_atom_buffer_capacity`** OR expose as method `get_gpu_buffer_high_water() => number`. If kept, add comment: `// COUPLED to AtomManager.capacity. Update if SOA storage strategy changes.`

### 3. `align_on_load_fires: number`
- Counter stored on `globalThis.__catgo_align_on_load_fires` so `Structure.svelte` can write and `StructureScene.svelte` can read.
- **Symmetry:** **Inconsistent.** Plan doc calls it `align_on_load_fire_count`; implementation is `align_on_load_fires`. Compare to `bond_pairs_count`, `charge_label_entries_count`.
- **Verdict:** **Rename to `align_on_load_fire_count`** to match the rest of the surface and the plan doc.

### 4. `charge_label_entries_count: number` and `h_bond_pairs_count: number`
- All four axes good. **Keep.**

### 5. `override_size: number`
- The `?? 0` collapses null and empty Map to one absorbing value — deliberate and correct.
- Uses `_size` because the underlying type is a `Map` whose native API uses `.size`.
- **Verdict:** **Keep, add comment**: `// 0 means either no override map OR an empty one — tests treat them as equivalent.`

### 6. `vibration_active: boolean`
- Strict equality `=== true` is the right choice (collapses `undefined` to `false`).
- **Verdict:** **Keep as-is.**

### 7. `is_playing: boolean`
- **Encapsulation issue.** Pattern: Trajectory writes `globalThis` → StructureScene's probe reads. **Asymmetric** with `__catgo_traj_test.resume_disabled` which exposes Trajectory state directly.
- **Verdict:** Either:
  - (a) **Move `is_playing` to `__catgo_traj_test.is_playing`** (canonical "trajectory state lives on the trajectory probe"). Eliminates one globalThis back-channel.
  - (b) **Document a clear rule**: "GPU-derived state on `__catgo_probe`, Trajectory-control state on `__catgo_traj_test`."
  
  Option (a) is cleaner.

### 8. `get_camera_matrices(): { projection, view, width, height } | null`
- **The biggest design concern.** The probe exposes raw `Matrix4.elements` arrays. The actual test contract is "given an xyz, where on the canvas should I click?" — matrices are an implementation vehicle.
- The matrix-multiply at `project_to_pixel.ts:32-43` is load-bearing test infrastructure that has to stay in lockstep with Three.js's column-major convention.
- **Better design:** expose `project_xyz_to_pixel: (xyz: [number,number,number]) => { x: number; y: number } | null` on the probe, implemented in StructureScene where Three.js's `Vector3.project(camera)` is available — guarantees projection matches what's rendered.
- If kept as-is: at minimum **rename `view` to `view_matrix`, `projection` to `projection_matrix`** so consumers don't confuse `view` (the matrix) with `viewport` (the canvas dims).

### 9. `selected_site_id: number | null` — DEDICATED ANALYSIS

The user's question: should this be a read-only number or surface the underlying Set?

(Note: the underlying state at `StructureScene.svelte:660` is `selected_sites?: number[]`, not a `Set`.)

**Pros of current "scalar last-selected" shape:** test code is one line; captures "what did the user just click"; `null` is a clean sentinel.

**Cons:**
- **The name lies.** `selected_site_id` reads like "the (singular) currently selected atom" — but the underlying model supports multi-select. A test that toggles two atoms and reads `selected_site_id` gets the wrong answer if it expects "the only selected atom."
- **Unstable under multi-select.** If selection later becomes a Set or sorted, `selected_sites[selected_sites.length - 1]` becomes meaningless.
- **Hides the actual test invariant.** Test 2.1 wants "did clicking at (px,py) select atom 0?" — i.e. "is 0 in the selection?" The current assertion is a stronger contract than needed.

**Recommendation: surface the list, not the last entry.**

```ts
get selected_site_ids(): readonly number[] { return selected_sites ?? [] }
```

This:
- Reflects the actual data shape.
- Lets tests assert `selected_site_ids.includes(0)` (the actual invariant) OR `.at(-1) === 0`.
- Survives a future Set migration trivially.
- Removes the `null` case (empty array is more honest).

**If keeping the scalar shape**, at minimum **rename to `last_selected_site_id`** so the multi-select trap is in the name.

**Verdict:** **Prefer `selected_site_ids: readonly number[]`. Second-best: `last_selected_site_id: number | null`. Avoid: the current name as written.**

### 10. `__catgo_traj_test`
- The four `trigger_*` functions take **no arguments** but synthesize hardcoded payloads. Effectively a parameterless test fixture.
- No return value means tests can't observe whether handlers accepted or rejected.
- **Verdict:** Keep structure, but consider parameterizing with defaults: `trigger_atom_added: (event?: { element?: ElementSymbol; position?: Vec3 }) => void`. Add return values (`() => boolean`) so tests don't need to infer state via polling.

## Cross-cutting concerns

### A. The four globalThis channels

| Channel | Writer | Reader | Purpose |
|---|---|---|---|
| `__catgo_probe` | StructureScene `$effect` | tests directly | main probe |
| `__catgo_traj_test` | Trajectory `$effect` | tests directly | trajectory triggers |
| `__catgo_traj_is_playing` | Trajectory `$effect` | StructureScene probe getter | cross-component is_playing |
| `__catgo_align_on_load_fires` | Structure `$effect` (align) | StructureScene probe getter | counter |

The first two are appropriate. The bottom two are **internal cross-component shared state via globalThis**.

**Recommendation:** Add a section in `src/lib/structure/CLAUDE.md` (or `tests/playwright/PROBES.md`) listing all four channels with writer/reader/purpose.

### B. DEV-gating: correct everywhere
Every probe block is wrapped in `if (!import.meta.env?.DEV) return` AND the `$effect` returns cleanup that deletes the global. **No findings.**

### C. Naming consistency

| Probe | Pattern | Consistent? |
|---|---|---|
| `*_count` family | `*_count` | yes |
| `align_on_load_fires` | bare noun | **NO** — should be `align_on_load_fire_count` |
| `atom_manager_capacity` | `*_capacity` | sole instance |
| `override_size` | `*_size` | justified (Map) |
| `selected_site_id` | singular id | **misleading; not a singular entity** |
| `get_*` family | `get_*` | yes |

## Quantitative ratings (1-5)

| Dimension | Rating | Notes |
|---|---|---|
| **Encapsulation** | 3/5 | DEV gating solid. Concerns: `atom_manager_capacity` couples to SOA implementation; `get_camera_matrices` couples to Three.js conventions; two undocumented globalThis cross-component channels. |
| **Invariant Expression** | 3/5 | Most return types correctly express their domain. `selected_site_id` lies about cardinality; `atom_manager_capacity` exposes "allocated" when the test cares about "used." `override_size` collapses two states cleanly. |
| **Usefulness** | 4/5 | Probes successfully unblocked 18 deferred tests. The W7 suite is now a real regression gate. |
| **Enforcement** | 4/5 | DEV-only enforcement correct, tree-shakes from prod. `$effect` cleanup deletes globals on unmount. |

## Concrete recommendations (priority-ordered)

**P1 — Before next major refactor:**
1. **Rename `align_on_load_fires` → `align_on_load_fire_count`**.
2. **Change `selected_site_id: number | null` → `selected_site_ids: readonly number[]`**.

**P2 — When Test 5.2 needs revisiting:**
3. **Replace `atom_manager_capacity` with `gpu_atom_buffer_capacity`**.

**P3 — When Three.js dependency in test helper becomes painful:**
4. **Replace `get_camera_matrices()` with `project_xyz_to_pixel(xyz) => {x,y} | null`**.

**P4 — Documentation hygiene:**
5. **Add a CLAUDE.md section** listing all four `globalThis.__catgo_*` channels.
6. **Standardize on a writer policy**: move `is_playing` to `__catgo_traj_test.is_playing` and delete `__catgo_traj_is_playing` global.

**P5 — Optional ergonomics:**
7. Parameterize `__catgo_traj_test.trigger_*`.
8. Triggers return `boolean` so tests don't poll.

**Items to NOT change** (already good): `get_structure_site_x`, `get_atom_x`, `get_atom_xyz`, the DEV-gating + `$effect` cleanup pattern, `vibration_active`'s strict-equality check, `override_size`'s collapse of null/empty Map to 0, the `count`-suffix convention.
