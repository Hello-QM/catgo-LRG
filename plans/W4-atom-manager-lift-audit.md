# W4 — atom_manager Lift + X5/X6 Hook Audit

**Branch:** atom-soa-refactor @ bd0da10f
**Audited:** 2026-04-26
**Purpose:** Input to W6 architecture decision (snapshot vs position-only-write).

---

## 1. atom_manager — What It Is

**File:** `/Users/jenedithpascasio/CatGO/src/lib/structure/atoms/atom-manager.svelte.ts`

**Current location:** Instantiated as a local constant at `StructureScene.svelte:2218` — `const atom_manager = new AtomManager()`. It is not a prop, not passed down, not lifted. It lives entirely inside StructureScene.

**Public surface:**

Read-only getters (properties):
- `version: number` — the single reactive surface (`#version = $state(0)`). Every mutating method bumps this exactly once per logical mutation.
- `count: number`, `capacity: number`
- Buffer accessors (raw typed-array refs, NOT wrapped in `$state`):
  - `site_ids_buffer: Uint32Array` — slot → `structure.sites[i]` index
  - `positions_buffer: Float32Array` — interleaved xyz, length = capacity * 3
  - `radii_buffer: Float32Array`
  - `elements_buffer: Uint8Array` — atomic number 1..118
  - `colors_buffer: Float32Array | null` (lazy, 3 floats/atom)
  - `opacities_buffer: Float32Array | null` (lazy, 1 float/atom)
  - `saturations_buffer: Float32Array | null` (lazy, 1 float/atom)
- Boolean flags: `has_colors`, `has_opacities`, `has_saturations`
- Per-attribute dirty tracking (all ReadonlySet or boolean):
  - `dirty_positions / dirty_all_positions`
  - `dirty_radii / dirty_all_radii`
  - `dirty_elements / dirty_all_elements`
  - `dirty_colors / dirty_all_colors`
  - `dirty_opacities / dirty_all_opacities`
  - `dirty_saturations / dirty_all_saturations`

Mutating methods (all bump `#version` once):
- `add_atom(site_id, x, y, z, atomic_number, radius): number`
- `add_atoms(site_ids_src, positions_src, atomic_numbers_src, radii_src): number`
- `remove_atom(slot)`, `remove_atoms(slots)`, `remove_where(pred)`
- `apply_atom_delete(deleted_site_ids)` — the X5-specific compaction + reindex
- `set_position(slot, x, y, z)` — no-op on Math.fround-equal values
- `set_radius(slot, radius)`, `set_element(slot, atomic_number)`
- `set_color(slot, r, g, b)`, `begin_colors_batch()`, `commit_colors_batch()`
- `set_opacity(slot, value)`, `begin_opacity_batch()`, `commit_opacity_batch()`
- `set_saturation(slot, value)`, `begin_saturation_batch()`, `commit_saturation_batch()`
- `ensure_colors()`, `ensure_opacities()`, `ensure_saturations()`
- `reserve(n)`, `shrink_to_fit(slack)`, `clear()`

Query methods (non-mutating):
- `find_slot_by_site_id(site_id): number` — O(1) via `#site_id_to_slot` Map
- `find_slots_by_site_ids(site_ids): Int32Array`
- `get_site_id(slot)`, `get_x(slot)`, `get_y(slot)`, `get_z(slot)`, `get_radius(slot)`, `get_element(slot)`
- `clear_dirty()` — called by renderers after GPU upload

**The design-intent comment (verbatim, lines 38–50):**

> Specs passed to the X6 mutation fast-paths. The callsite supplies only what it already has in scope (site_id + element symbol/atomic_number + the new position). The hook inside `StructureScene` resolves radius + color from its own scene state (atom_radius, element_radius_overrides, colors.element, property_colors) — keeping the callsite free of GPU-visual concerns.
>
> NOTE: for add/replace the initial color is an "element color fallback" — the X2 shadow sync will overwrite with the full priority chain (site_color_override > plugin > property_color > element) on the next tick. `set_color` no-ops on unchanged values, so this costs a single branch, no extra GPU upload. See plan X6 "Color/radius resolution at callsite".

---

## 2. AtomFastOps Interface

**File:** `/Users/jenedithpascasio/CatGO/src/lib/structure/atoms/atom-manager.svelte.ts:80–121`

The interface is published by StructureScene via `bind:atom_fast_ops` to its parent. The implementations live inside a `$effect` at `StructureScene.svelte:2627–2751`.

### Scene-local state captured by each hook

All four hooks are closures defined inside the same `$effect` body at `StructureScene.svelte:2627`. They close over `StructureScene`-local variables.

| Method | Signature | Scene-local state captured | Callers |
|---|---|---|---|
| `try_delete` | `(deleted_site_ids: readonly number[], new_sites: readonly Site[]) => boolean` | `atom_manager` (local const), `bond_state` (local from `create_bond_state()`), `bond_manager` (prop) | `Structure.svelte:411` (`delete_selected()`), `context-menu-actions.ts:237` (`handle_edit_atoms`), `Structure.svelte` keyboard delete path via `interaction.setup_global_listeners` |
| `try_add` | `(added: readonly AtomAddSpec[], new_sites: readonly Site[]) => boolean` | `atom_manager`, `bond_state`, `bond_manager`, `structure` (prop), `bonding_strategy` (prop), `bonding_options` (prop), `__resolve_radius_for_element` closure which captures `site_radius_overrides` (prop), `same_size_atoms` (prop), `element_radius_overrides` (prop), `atom_radius` (prop); `__resolve_color_for_element` closure which captures `colors.element` (module-level reactive state from `$lib/state.svelte`) | `context-menu-actions.ts:221`, `pencil-mode.svelte.ts:381` (single atom), `pencil-mode.svelte.ts:443` (fragment bulk-add) |
| `try_replace` | `(replacements: readonly AtomReplaceSpec[], new_sites: readonly Site[]) => boolean` | `atom_manager`, `bond_state`, `bond_manager`, `structure` (prop), `bonding_strategy` (prop), `bonding_options` (prop), `__resolve_radius_for_element` (captures `site_radius_overrides`, `same_size_atoms`, `element_radius_overrides`, `atom_radius`), `__resolve_color_for_element` (captures `colors.element`) | `context-menu-actions.ts:268` |
| `try_move` | `(moved: readonly AtomMoveSpec[], new_sites: readonly Site[]) => boolean` | `atom_manager`, `bond_state`, `bond_manager`, `structure` (prop), `bonding_strategy` (prop), `bonding_options` (prop) | `interaction.svelte.ts:445` (`apply_overrides_to_structure`, called at drag-commit and keyboard-arrow-move) |

### Helper functions used by hooks (also closures over scene-local state):

`__resolve_radius_for_element(element, site_id)` at `StructureScene.svelte:2612–2621` — closes over:
- `site_radius_overrides` (prop, SvelteMap)
- `atom_radius` (prop, number scale factor)
- `same_size_atoms` (prop, boolean)
- `element_radius_overrides` (prop, `Partial<Record<ElementSymbol, number>>`)

`__resolve_color_for_element(element)` at `StructureScene.svelte:2622–2625` — closes over:
- `colors.element` (module-level `$state` object from `$lib/state.svelte`, reactive to color scheme changes)
- `__hex_to_linear_rgb` (pure, cached converter)

---

## 3. Reactive Surface — Readers of atom_manager

There are exactly two readers of `atom_manager` in the codebase.

### Reader 1: X2 Shadow Sync `$effect` — `StructureScene.svelte:2263`

- **What reads:** `atom_manager` (the local instance — not a reactive read of `version`)
- **Trigger:** Structure prop change, trajectory_frame_positions change, property_colors change, site_radius_overrides / site_color_overrides / element_radius_overrides change, atom_radius change, same_size_atoms change, plugin hook count change. The effect has its own memoization layer (`__x2_prev_*`) to skip no-op fires.
- **Per-frame intent:** Yes during trajectory playback — the trajectory fast-path branch (`trajectory_only`, line ~2348) runs per frame. The positions-only branch also runs when supercell/PBC cascades trigger a fresh structure ref.
- **Work done:** Reads `mgr.site_ids_buffer`, calls `mgr.set_position(slot, ...)` per atom (trajectory_only/positions_only fast-paths), or does a full diff → `mgr.remove_atoms()` + `mgr.add_atoms()` + per-slot `set_position/set_radius/set_element/set_color` (slow path).
- **Critical note:** The comment at line 2240–2244 explicitly states: "DO NOT read `atom_manager.version` here — mutations on the manager bump it and would re-fire this $effect in an infinite loop."

### Reader 2: `AtomManagerInstances.svelte` main sync `$effect` — line 361

- **What reads:** `atom_manager.version` (reactive — the `$state` counter)
- **Trigger:** Every time `atom_manager.version` increments (i.e., every mutation to the manager). Also re-fires when modulation inputs (hidden_site_ids, cutting_visibility_map, atom_opacity_overrides, image atom params) change.
- **Per-frame intent:** Yes — this is the GPU upload path. It calls `opaque_renderer.sync()` or `force_full_resync()` then `mark_dirty()` (→ `threlte.invalidate()`).
- **Work done:** Calls `AtomInstancedRenderer.sync()` which walks dirty slots and uploads changed attribute buffers to the GPU.

### Reader 3: Drag fast-path `$effect` — `AtomManagerInstances.svelte:432`

- **What reads:** `realtime_position_overrides` (prop, not `atom_manager.version` directly)
- **Trigger:** When parent sets `realtime_position_overrides` with `size > 0`
- **Per-frame intent:** Yes during drag — fires each frame the drag map is updated
- **Work done:** Calls `manager.find_slot_by_site_id` + `manager.set_position` for each override entry. The resulting version bump wakes Reader 2.

### Reader 4: GPU picker dirty flag — `StructureScene.svelte:2025`

Not a reader of atom_manager directly — reads `atom_data.length`, `bond_pairs.length`, `cutting_visibility_map.size`. Included for completeness.

---

## 4. Reactive Surface — Writers

### Today (X2 shadow sync — the only writer):

The X2 shadow sync `$effect` at `StructureScene.svelte:2263` is the sole authoritative writer. It builds a full desired-state map from `structure.sites` + visual overrides and diff-applies to the manager. It calls:
- `mgr.clear()` when structure becomes null
- `mgr.set_position / set_radius / set_element / set_color` per kept slot
- `mgr.remove_atoms(slots_to_remove)` for deletions
- `mgr.add_atoms(...)` + `begin/commit_colors_batch` for additions

### Phase X5/X6 fast-path writers (via hooks):

The try_* hooks are additional writers, calling:
- `atom_manager.apply_atom_delete(deleted_site_ids)` in `try_delete`
- `atom_manager.add_atoms(...) + begin/commit_colors_batch` in `try_add`
- `atom_manager.set_element/set_radius/set_color` in `try_replace`
- `atom_manager.set_position` in `try_move`

These hooks fire BEFORE the canonical `structure = ...` mutation, so that when the X2 shadow sync fires on the next tick, it sees no diff (fingerprints already match post-mutation state).

### After bypass refactor (planned — writer 3):

Under the T3 plan, `Trajectory.svelte` would become a second position-only writer, calling `atom_manager.set_position(slot, x, y, z)` per slot per frame. This is what triggers W4 — the manager would need to be accessible from Trajectory.svelte, which is currently impossible since it is local to StructureScene.

---

## 5. The GPU/Scene Separation Invariant

The invariant stated in `atom-manager.svelte.ts:41–43` is:

> The callsite [of a fast-path hook] supplies only what it already has in scope (site_id + element symbol/atomic_number + the new position). The hook inside `StructureScene` resolves radius + color from its own scene state — keeping the callsite free of GPU-visual concerns.

**Precise formulation:** Any code outside StructureScene that calls into atom_manager MUST NOT need to know or supply GPU-visual attributes (atom_radius, element_radius_overrides, colors.element, property_colors). The resolution of those attributes into concrete radius floats and linear-RGB triples is StructureScene's private responsibility.

**What the invariant allows:**
- Position-only writes (trajectory bypass, drag commit) from outside StructureScene — these only need `site_id → slot` lookup and xyz values.
- The X2 shadow sync copying positions from `structure.sites` — this is an internal StructureScene operation, so it is allowed to access all scene-local state.

**What the invariant forbids:**
- Lifting `atom_manager` to Structure.svelte and having Structure.svelte call `set_color(slot, r, g, b)` directly — that would require Structure.svelte to duplicate the color resolution chain.
- Lifting `atom_manager` to Structure.svelte and having Structure.svelte call `try_add` with a fully-resolved color — that would require piping `atom_radius`, `element_radius_overrides`, `colors.element`, and `property_colors` up to Structure.svelte as props or context, breaking the layer boundary.
- Trajectory.svelte calling `set_color`, `set_radius`, or `set_element` on the manager — trajectory only knows positions.

**Implication for the bypass refactor:** Position-only writes (T3's `set_position` loop) do NOT violate the invariant. Trajectory.svelte writing positions via `mgr.set_position(slot, x, y, z)` is safe — it supplies only what it has in scope (slot from `site_ids_buffer` and xyz from `trajectory_frame_positions`). The radius/color/element never change during playback. This is the key observation for evaluating Option A.

---

## 6. Lift Options Analysis

### Option A — Manager lifted via `bind:atom_manager` ref; hooks stay in StructureScene

**What changes:**

- `StructureScene.svelte:2218` — `const atom_manager = new AtomManager()` becomes a prop: `atom_manager = $bindable(new AtomManager())`.
- `Structure.svelte` gains `let scene_atom_manager = $state<AtomManager | null>(null)` and passes `bind:atom_manager={scene_atom_manager}` to `<StructureScene>`.
- Trajectory.svelte receives `atom_manager` as a prop from Structure.svelte and calls `set_position` per frame.
- The X5/X6 hook closures (`try_delete`, `try_add`, `try_replace`, `try_move`) remain unchanged — they still close over `atom_radius`, `element_radius_overrides`, `colors.element`, `property_colors` from StructureScene scope.
- `atom_fast_ops` binding mechanism stays identical.

**What breaks:**

- `bond_state` is local to StructureScene and the hooks use it (`apply_atom_delete_incremental(bond_state, ...)`). Under Option A, bond_state stays local, so the hooks stay local, and this is fine. However, `atom_manager` is now owned externally (Structure.svelte), which means if Structure.svelte resets it or if the manager is shared across the trajectory and scene write paths, version bumps from Trajectory.svelte's `set_position` calls will fire AtomManagerInstances.svelte's sync effect per frame — which is exactly the desired behavior (GPU upload per frame).
- **Risk:** The X2 shadow sync (`StructureScene.svelte:2263`) currently reads `atom_manager` (a local const). Under Option A, `atom_manager` becomes a prop, so the $effect must be re-evaluated when the prop ref changes (Svelte 5 tracks this). No circular issue since the effect does not read `atom_manager.version`. However, if the manager instance is re-created by Structure.svelte (e.g., on structure swap), AtomManagerInstances.svelte would recreate the renderer too — that is existing behaviour via the mount `$effect` at `AtomManagerInstances.svelte:323`.
- **Svelte 5 `$bindable` semantics:** StructureScene declares `atom_manager = $bindable(new AtomManager())`. Structure.svelte binds `bind:atom_manager={scene_atom_manager}`. When StructureScene's `$effect` at line 2627 runs (populating atom_fast_ops), it captures the current `atom_manager` value in its closure — this is safe. When Trajectory.svelte calls `scene_atom_manager?.set_position(...)`, the manager's `#version` increments, and AtomManagerInstances.svelte's sync effect (which reads `atom_manager.version`) re-fires. This works because `scene_atom_manager` and `atom_manager` are the same object reference after the bind.
- **UNCLEAR:** Whether Svelte 5 `$bindable` with a default value triggers an extra version bump when StructureScene first mounts. If it does, AtomManagerInstances.svelte would fire `force_full_resync` at mount — already the intended behaviour per the mount `$effect` at line 323.

**What has to be invented:**
- A null guard in Trajectory.svelte's position-write loop: `if (!atom_manager || !trajectory_frame_positions) return`.
- A slot-lookup pattern in Trajectory.svelte: iterate `atom_manager.site_ids_buffer` to get slot → sid mapping, then read `trajectory_frame_positions[sid * 3]`. This duplicates what the X2 shadow sync's `trajectory_only` branch does at `StructureScene.svelte:2349–2353` — but that branch still fires as an empty no-op (or can be gated off when `trajectory_active`).
- Consider whether the X2 shadow sync's `trajectory_only` branch should be deleted under T3 or left as a guard. If Trajectory writes directly, the X2 effect should no longer fire (T2 snapshot freezes StructureScene's `structure` prop). So the X2 trajectory_only branch becomes dead code.

**Interaction with snapshot architecture:**
- Snapshot freezes `structure` prop to StructureScene during playback. The X2 shadow sync fires on structure prop changes — with the snapshot, it doesn't fire per frame. Trajectory.svelte writes positions directly to `atom_manager` via `set_position`. This is coherent: snapshot handles topology freeze, direct writes handle position updates. No conflict.
- The X5/X6 hooks still use `structure` (StructureScene's prop) — which under snapshot is the frozen topology snapshot, not the live frame. For `try_add`/`try_replace`/`try_move` during playback (edge case: user editing while trajectory is paused), the snapshot would need to be cleared first. T5's pause-and-edit handler does this.

**Interaction with position-only-write architecture:**
- Under position-only-write, Trajectory.svelte would write to `atom_manager` directly (exactly what Option A provides), and NOT write `current_structure` per frame. Option A is the mechanism that enables position-only-write. The two are not alternatives — Option A IS the position-only-write mechanism for atom positions.

---

### Option B — Manager AND hooks both lifted to Structure.svelte

**What changes:**

- `atom_manager` moves from StructureScene to Structure.svelte.
- The hook closures (`try_add`, `try_replace`, `try_move`, `try_delete`) move to Structure.svelte.
- `atom_radius`, `element_radius_overrides`, `colors.element`, `property_colors` must become accessible from Structure.svelte scope so the hooks can call `__resolve_radius_for_element` and `__resolve_color_for_element`.
- `bond_state` (which `try_delete`/`try_add`/`try_replace`/`try_move` all use via `apply_atom_delete_incremental` etc.) must either be lifted or exposed.

**What breaks:**

This directly violates the GPU/scene separation invariant. `atom_radius`, `element_radius_overrides`, `colors.element` are all rendering parameters that belong in StructureScene. Lifting them to Structure.svelte would mean Structure.svelte must know about GPU-visual concerns (element color schemes, radius overrides) that it currently correctly delegates.

Additionally, `bond_state` is created by `create_bond_state()` inside StructureScene and includes `bond_connectivity`, `last_bond_fingerprint`, etc. — all deeply StructureScene-local. `apply_atom_delete_incremental` / `apply_atom_add_incremental` etc. (from `bond-computation-controller.svelte.ts`) need these. Lifting bond_state to Structure.svelte would mean the bond computation pipeline must also be lifted, which is the bond_manager lift problem (acknowledged in the v2 plan as a separate issue).

**What has to be invented:**
- A controller interface that exposes `atom_radius`, `element_radius_overrides`, `property_colors`, `same_size_atoms`, `site_radius_overrides` from StructureScene back to Structure.svelte. This is a props/context plumbing surface of 5+ values, all of which currently flow DOWN from Structure.svelte to StructureScene. Making them flow back up (or sharing via context) creates a bidirectional dependency.
- A way to get `bond_state` out of StructureScene — this is even harder since bond_state is tightly coupled to the bond computation effects inside StructureScene.

**Is this feasible?** The radius and color params already flow from Structure.svelte → StructureScene as props (e.g. `{atom_radius}`, `{element_radius_overrides}`, `{property_colors}`). They are already in Structure.svelte's scope. So `__resolve_radius_for_element` and `__resolve_color_for_element` could be computed in Structure.svelte using these props. The violation of the invariant is a design concern, not a hard technical blocker. However, `bond_state` is not a prop and would require a substantial new interface.

**Interaction with snapshot architecture:**
- The snapshot mechanism stores `displayed_structure` in `__topology_snapshot`. The hooks need `new_sites` (the post-mutation sites array) to pre-bump bond fingerprints. Under snapshot, the base `structure` in Structure.svelte is the live one, so `new_sites` is derived from the live structure — no conflict.

**Interaction with position-only-write architecture:**
- If position-only-write means Trajectory.svelte writes atom_manager positions directly and bypasses structure entirely, lifting hooks to Structure.svelte doesn't help Trajectory.svelte — Trajectory.svelte just needs `atom_manager` accessible. Option B doesn't simplify the position-only-write problem; it adds complexity by moving hooks away from their natural home.

---

### Option C — Hybrid: thin hooks in Structure.svelte delegating via callback props

**What changes:**

- Structure.svelte defines a lightweight `atom_fast_ops_wrapper` that delegates to StructureScene-provided callbacks.
- StructureScene exposes callbacks (e.g., `on_fast_delete`, `on_fast_add`, etc.) via bindable props, or expands `AtomFastOps` to include a `resolve_add_spec` helper that StructureScene provides.
- The thin wrapper in Structure.svelte can be invoked by Trajectory.svelte or other callers, who call the wrapper, which routes to the scene-internal implementation.

**What breaks:**

This is architecturally equivalent to what already exists. `atom_fast_ops` IS already the callback surface — StructureScene populates it via `$effect` and Structure.svelte binds to it via `bind:atom_fast_ops`. The "thin wrapper" pattern is already implemented. The only gap is that `atom_fast_ops` is null until StructureScene mounts and its `$effect` runs — Trajectory.svelte would need to handle this null case.

**What has to be invented:**
- Nothing new compared to Option A. Trajectory.svelte calls `scene_atom_manager?.set_position(...)` (position writes) and the existing `scene_atom_fast_ops` handles topology-altering mutations. No extra callback props needed.
- The number of new callback props for trajectory specifically: zero. Trajectory only needs position writes.

**Interaction with snapshot architecture:**
- Identical to Option A.

**Interaction with position-only-write architecture:**
- Identical to Option A.

---

## 7. Open Questions for W6

### Q1: Does position-only-write make the hook lift question moot?

For the trajectory bypass specifically: **yes, almost entirely**. Trajectory.svelte under position-only-write only ever calls `set_position` — it never calls `try_add`, `try_replace`, `try_replace`, or `try_delete`. Those hooks are invoked only by user edits (pencil, context menu, drag-commit). Trajectory playback is a read-only position override; topology never changes during playback.

Therefore: for the trajectory bypass refactor, the only lift needed is `atom_manager` (not the hooks). Option A (manager lifted via `$bindable`, hooks stay in StructureScene as closures) is sufficient and does not violate the invariant.

### Q2: When would the hook lift question become live again?

If a future feature requires modifying atom topology (add/delete/replace) from outside StructureScene during trajectory playback — e.g., live MD where atoms are added/removed mid-trajectory. This is explicitly out of scope for the current bypass refactor.

### Q3: How does Trajectory.svelte get the `atom_manager` reference?

Under Option A, Structure.svelte binds `bind:atom_manager={scene_atom_manager}` on `<StructureScene>` and passes `{scene_atom_manager}` (or the reference) to `<Trajectory>`. Trajectory.svelte accepts it as an optional prop. When the manager is null (not yet populated by StructureScene mount), Trajectory.svelte's write loop no-ops. The manager becomes non-null when StructureScene's $effect runs after mount.

### Q4: Does `set_position` per frame (from Trajectory) conflict with the X2 shadow sync's `trajectory_only` branch?

Under the bypass refactor, the T2 snapshot freezes the `structure` prop to StructureScene during playback. The X2 shadow sync fires only when its inputs change — and with a frozen `structure` prop, the `trajectory_only` fast-path can never fire (because `structure !== __x2_prev_struct` would only be true if `structure` changed, which it doesn't under snapshot). So: no conflict. Trajectory.svelte writes positions; the X2 shadow sync is dormant during playback. This is the intended design.

### Q5: Does `set_position` per frame cause an excessive version bump cascade?

Each `set_position` call that changes a value bumps `atom_manager.version`. AtomManagerInstances.svelte's main sync `$effect` reads `atom_manager.version` and fires per version bump — uploading only the position attribute (the dirty set contains only the changed slots). This is the intended GPU path. The concern from T3.1 in the plan is: **are there any other readers of `atom_manager.version` that are NOT render-only?**

Investigation result: There are exactly two readers of `atom_manager` in the codebase:
1. `AtomManagerInstances.svelte:361` — renders to GPU. Intentionally per-frame.
2. `StructureScene.svelte:2263` (X2 shadow sync) — explicitly does NOT read `atom_manager.version` (documented at line 2240). This effect will not fire on `set_position` calls from Trajectory.svelte.

**Answer to T3.1:** No non-render readers of `atom_manager.version` exist. The position-write loop is safe.

### Q6: Is USE_NEW_ATOM_SYSTEM true in the current branch?

**Yes.** `feature-flag.ts:28` — `export const USE_NEW_ATOM_SYSTEM = true`. All X5/X6 fast paths are live. The try_* hooks do real work (they do not short-circuit). AtomManagerInstances is the active renderer.

### Q7: For the T5 pause-and-edit handler, does reading `atom_manager.positions_buffer` from Structure.svelte work under Option A?

Under Option A, Structure.svelte has `scene_atom_manager` (the manager reference). The T5 handler reads `mgr.get_x/y/z(slot)` or iterates `mgr.positions_buffer` to write back to `structure.sites[i].xyz`. `positions_buffer` is a raw getter returning the typed array reference — no `$state` wrapping, so reading it from Structure.svelte does not create reactive dependencies. This is safe.

However: `positions_buffer` is indexed by **slot**, not `site_id`. Structure.svelte must use `site_ids_buffer` to map slot → site_id before writing back to `structure.sites`. The loop is: `for (let slot = 0; slot < mgr.count; slot++) { const sid = mgr.site_ids_buffer[slot]; structure.sites[sid].xyz = [mgr.get_x(slot), mgr.get_y(slot), mgr.get_z(slot)] }`.

### Q8: What is the minimal change set for Option A?

1. `StructureScene.svelte:2218` — change `const atom_manager = new AtomManager()` to `let { ..., atom_manager = $bindable(new AtomManager()) } = $props()` (adding it to the props destructure).
2. `Structure.svelte` — add `let scene_atom_manager = $state<AtomManager>(new AtomManager())` and pass `bind:atom_manager={scene_atom_manager}` to `<StructureScene>`.
3. `Trajectory.svelte` — accept `atom_manager: AtomManager | null` as optional prop; add position-write effect that fires when `trajectory_frame_positions` changes.
4. `Structure.svelte` template — pass `{scene_atom_manager}` (or the ref) to `<Trajectory>`.
5. Gate the X2 shadow sync's `trajectory_only` branch behind `!trajectory_active` (since T2's snapshot means it can never legitimately fire during playback anyway — this is a cleanup, not a correctness fix).

No changes to the hook closures, `AtomFastOps`, or bond state plumbing are required.

---

## Files Essential to Understanding This Topic

- `/Users/jenedithpascasio/CatGO/src/lib/structure/atoms/atom-manager.svelte.ts` — full AtomManager class + AtomFastOps interface definition
- `/Users/jenedithpascasio/CatGO/src/lib/structure/StructureScene.svelte` — lines 2218 (instantiation), 2263–2590 (X2 shadow sync), 2592–2751 (X5/X6 hook $effect + helper functions), 2756–2767 (atom_positions_buffer)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/atoms/AtomManagerInstances.svelte` — lines 361–417 (main sync $effect reading atom_manager.version), 432–443 (drag fast-path)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/Structure.svelte` — lines 161–169 (scene_atom_fast_ops declaration), 3360 (bind:atom_fast_ops in template), 385–412 (delete_selected try_delete call)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/interaction.svelte.ts` — lines 36 (AtomFastOps import), 163 (get_atom_fast_ops in deps), 430–452 (try_move call in apply_overrides_to_structure)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/pencil-mode.svelte.ts` — lines 76 (get_atom_fast_ops in deps), 370–381 (try_add single atom), 435–444 (try_add fragment)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/context-menu-actions.ts` — lines 26–29 (AtomFastOps imports), 212–222 (try_add), 232–241 (try_delete), 263–269 (try_replace)
- `/Users/jenedithpascasio/CatGO/src/lib/structure/atoms/feature-flag.ts` — USE_NEW_ATOM_SYSTEM = true
- `/Users/jenedithpascasio/CatGO/plans/trajectory-bypass-refactor-todo.md` — W4 work item definition
- `/Users/jenedithpascasio/CatGO/plans/trajectory-bypass-refactor.md` — T3 design, T3.1 cascade audit, outstanding issue #5
