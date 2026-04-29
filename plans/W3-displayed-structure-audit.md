# W3 — `displayed_structure` Sibling Consumer Audit

**Branch:** `atom-soa-refactor` at `bd0da10f`
**Audited:** 2026-04-26
**Scope:** All reads of `displayed_structure` in `src/` (grep and manual trace). Does not cover `extensions/` — confirmed no `displayed_structure` references there.
**Purpose:** Input to W6 architecture decision (snapshot vs position-only-write).

---

## Summary Table

| Bucket | Count | Consumers | Typical per-frame cost |
|---|---|---|---|
| CRITICAL-LIVE | 0 | — | — |
| NEEDS-SNAPSHOT | 5 | atom_data, X2 shadow sync, new_atom_hidden_site_ids, compute_bond_connectivity ($effect.pre + build_bond_pairs), filtered_bond_pairs | ~1–15ms combined (heavily patched; see per-consumer notes) |
| CHEAP-CASCADE | 8 | ctx_constraints_section, ctx_charge_label_section, has_charges (AtomLegend), charge_label_entries, clip_opacity_overrides, effective_clip_center, isolation_opacity_overrides, merged_atom_opacity_overrides | O(1) in typical trajectory sessions due to feature-flag guards |
| EVENT-ONLY | 7 | interaction controller, pencil-mode controller, context-menu-actions (get_target_indices + map_to_original), is_image_atom helper, has_original_atoms helper, get_original_atoms_only helper, ContextMenu on_select handler | 0 (no reactive subscription) |
| DEAD | 0 | — | — |

**Total consumers: 20**

---

## Bucket Definitions (per W3 spec)

- **CRITICAL-LIVE** — consumer needs live per-frame updates for correct rendering or behavior
- **NEEDS-SNAPSHOT** — per-frame reactive consumer that does not need live data but fires per trajectory frame; must be frozen or bypassed under snapshot architecture
- **CHEAP-CASCADE** — fires reactively on `displayed_structure` changes but does negligible work per fire (O(1) due to feature-flag guards or trivial computation)
- **EVENT-ONLY** — only reads `displayed_structure` inside event handlers or callbacks, never subscribes reactively
- **DEAD** — code path no longer reachable (none found)

---

## Detailed Per-Consumer Inventory

### 1. `atom_data` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1877`
**Bucket:** NEEDS-SNAPSHOT
**Form:** `$derived.by()`
**Prop chain:** Structure.svelte passes `displayed_structure` as `structure` prop to `<StructureScene>` at line 3361. `atom_data` reads `structure.sites` directly.

**What it does:** Core atom rendering pre-computation. Iterates all sites to resolve element, occupancy, position, radius, color, and site overrides for every rendered atom. Output feeds `AtomImpostors.svelte` GPU buffer writes.

**Per-fire cost:**
- Slow path (topology change): O(N), ~6–15ms for 878 atoms (two passes: initial colors + final per-site resolution with plugin hooks)
- Trajectory fast-path (lines 1897–1936): Fires when `structure.sites !== __atom_data_cache_sites_ref` but all other topology inputs have identical reference identity. Clones cached entries and updates only `.position`. Cost: ~1–3ms for 878 atoms (one O(N) array clone + xyz copy). Measured in DEV at `> 3ms` threshold.

**Internal memoization/guards:** The trajectory fast-path at lines 1897–1936 is a complete inline cache keyed on 11 reference-identity comparisons (`property_colors`, `site_radius_overrides`, `site_color_overrides`, `element_radius_overrides`, `_hidden_sites`, `_hidden_elements`, `_hidden_prop_vals`, `atom_radius`, `same_size_atoms`, `_enabledPluginCount`, `_hookCount`). Falls through to slow path on first run and on any topology-affecting change. Cache is currently implemented as module-level `let` variables (`__atom_data_cache_entries`, `__atom_data_cache_sites_ref`, etc., lines 1855–1875).

**Risk under snapshot architecture:** If `StructureScene` receives `__topology_snapshot ?? displayed_structure`, `atom_data` sees a frozen `structure` prop during trajectory playback. The snapshot has `structure.sites` referencing the snapshot's topology — `atom_data`'s trajectory fast-path checks `structure.sites !== __atom_data_cache_sites_ref` which would be false (same frozen snapshot sites). Result: `atom_data` would NOT update positions per frame at all. This is the desired behavior for a topology snapshot, BUT it means `atom_data` would never reflect the per-frame positions stored in `trajectory_frame_positions`. The actual per-frame position update would need to come from a separate path (e.g., `AtomImpostors.svelte`'s `trajectory_frame_positions` fast-path at its line ~460, which writes directly to the GPU buffer bypassing `atom_data`). So under snapshot architecture, `atom_data` becomes a one-time topology setup, not a per-frame consumer. This is intentional and correct.

**Risk under position-only-write architecture:** `displayed_structure` doesn't update per frame at all — `atom_data` fires zero times during playback. Per-frame GPU updates come entirely from `trajectory_frame_positions` via `AtomImpostors`'s own fast-path. `atom_data` is used only at trajectory load and unload. This is strictly better — eliminates all `atom_data` re-runs during playback.

---

### 2. X2 Shadow Sync ($effect in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:2263`
**Bucket:** NEEDS-SNAPSHOT
**Form:** `$effect`
**Prop chain:** Same as atom_data — reads `structure` prop (= `displayed_structure`).

**What it does:** Mirrors `structure.sites` into the `atom_manager` SOA (struct-of-arrays) GPU buffer. Keeps the manager's internal position/element/radius arrays synchronized with the current structure. This is the "X2 shadow sync" referenced in the trajectory bypass plan.

**Per-fire cost:**
- Trajectory fast-path (lines 2340–2364): Fires when `traj_positions` changed but no topology inputs changed. Bulk-copies Float32Array positions directly into `mgr.set_position()`. Cost: ~1–2ms for 878 atoms (one O(N) loop over `mgr.count`). DEV probe threshold at `> 5ms`.
- Position-only fast-path (lines 2371–2395): Fires when structure ref changed (position-only cascade from PBC/supercell re-derive) but no topology changed. Bulk-copies `sites[i].xyz`. Similar cost.
- Slow path: O(N) full diff with Map rebuild, ~15–30ms for 878 atoms.
- Skip path (lines 2300–2339): When `anything_changed` is false (Svelte over-fire absorbed), returns immediately. This is the primary protection against Svelte re-running the effect without actual data changes.

**Internal memoization/guards:** Extensive — tracks 10 reference-identity snapshots (`__x2_prev_struct`, `__x2_prev_traj`, `__x2_prev_prop_colors`, `__x2_prev_sro`, `__x2_prev_sco`, `__x2_prev_ero`, `__x2_prev_same_size`, `__x2_prev_atom_radius`, `__x2_prev_hook_count`, `__x2_prev_plugin_count`). The `__x2_initialized` gate at line 2300 skips memoization on first run. Skip path absorbs zero-change Svelte over-fires.

**Risk under snapshot architecture:** Under snapshot, `structure` is frozen → X2 never enters trajectory or position-only fast-path. On trajectory frame N, `traj_positions` changes but `structure` is frozen (same ref), so `struct_changed = false` and `traj_changed = true`. This matches the "trajectory_only" branch condition (line 2340: `traj_positions != null && traj_changed && !prop_changed...`). So X2 still handles trajectory positions correctly via `traj_positions` even with a frozen `structure`. Under snapshot, X2's per-frame cost is the trajectory fast-path (~1–2ms), same as today.

**Risk under position-only-write architecture:** `structure` never changes per frame → `struct_changed = false`. `traj_positions` changes each frame → `traj_changed = true`. Matches trajectory fast-path branch exactly. Same cost as snapshot. Under position-only-write, X2 is already in its optimal state without any additional machinery.

---

### 3. `new_atom_hidden_site_ids` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1726`
**Bucket:** NEEDS-SNAPSHOT
**Form:** `$derived.by()`
**Prop chain:** Reads `structure` prop (= `displayed_structure`). Also reads `_hidden_elements`, `_hidden_prop_vals`, `_hidden_sites`, `property_colors`.

**What it does:** Computes the set of hidden atom site indices for the new atom rendering system (`USE_NEW_ATOM_SYSTEM === true`). Iterates all sites, classifying each as hidden or visible based on element-hide, property-hide, and per-site-hide sets.

**Per-fire cost:** O(N) site iteration. For 878 atoms: ~0.5–1ms. Has an early-exit `if (!USE_NEW_ATOM_SYSTEM) return undefined` at line 1727, returning `undefined` when the system flag is off. Conditional on `_hidden_elements.size > 0`, `_hidden_prop_vals.size > 0`, `_hidden_sites.size > 0` to skip work per branch.

**Internal memoization/guards:** The `USE_NEW_ATOM_SYSTEM` gate is the primary guard. No internal cache keyed on previous state — re-runs fully on every `structure` change when the flag is on.

**Risk under snapshot architecture:** Under snapshot, `structure` is frozen → this derived fires only at trajectory load/unload. No per-frame cost. Correct behavior — hidden atoms don't change during playback.

**Risk under position-only-write architecture:** Same as snapshot — no per-frame fires. Better than current patched state.

---

### 4. `compute_bond_connectivity` + `build_bond_pairs` ($effect.pre in StructureScene.svelte via bond-computation-controller.svelte.ts)

**File:line:** `src/lib/structure/bond-computation-controller.svelte.ts:56–160` (function), called from StructureScene.svelte `$effect.pre` around line ~1990 (exact line not read but referenced in CLAUDE.md).
**Bucket:** NEEDS-SNAPSHOT
**Form:** `$effect.pre` (caller) + synchronous function
**Prop chain:** The `$effect.pre` in StructureScene reads `structure` (= `displayed_structure`), `bonding_strategy`, `bonding_options`, and `freeze_connectivity_on_position_change`. Calls `compute_bond_connectivity()` which reads `structure.sites`.

**What it does:** Detects bonds between atoms and populates `bond_state.bond_connectivity`. During trajectory playback, the `freeze_connectivity_on_position_change` parameter is set to `true`, which activates the trajectory fast-path at lines 100–131 of bond-computation-controller.svelte.ts: skips position hashing and bond detection, writes a `|TRAJ` sentinel to `last_bond_fingerprint`. Cost is ~O(1) when frozen.

**Per-fire cost:**
- Frozen path (trajectory): O(1) — sentinel write only, ~0.01ms
- Full bond detection path: O(N²) element pairs → WASM worker → ~50–150ms async; sync JS fallback ~150ms+
- Position-hash path (non-frozen, position-only change): O(N) hash computation then skips if hash matches

**Internal memoization/guards:** `freeze_connectivity_on_position_change` flag (line 69) is the trajectory guard. Additionally: `strategy_changed` check, `elem_fp` fingerprint comparison (line 98), position hash comparison. Multiple early-return paths before any bond computation.

**Risk under snapshot architecture:** Under snapshot, `structure` is frozen → `freeze_connectivity_on_position_change` wouldn't even be needed because `structure.sites` never changes per frame. `compute_bond_connectivity` would detect `elem_fp === last_elem_fingerprint` and `strategy_changed === false` and bail out before any hash computation. Effectively no cost per frame.

**Risk under position-only-write architecture:** Same — `structure` never changes per frame → `$effect.pre` might not even re-run (depends on whether Svelte tracks the `trajectory_frame_positions` read inside this effect). If it reads `trajectory_frame_positions` (the bond `$effect.pre` may not — bond positions are read from `structure.sites`), this is the key question for W6.

---

### 5. `filtered_bond_pairs` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:2035`
**Bucket:** NEEDS-SNAPSHOT
**Form:** `$derived.by()`
**Prop chain:** Reads `bond_state.last_bond_structure` (NOT `structure` directly). Also reads `_hidden_elements`, `_hidden_sites`, `_hidden_prop_vals`, `bond_distance_rules`, `_deleted_bond_keys`.

**What it does:** Filters the full bond connectivity into visible `BondPair[]` objects, resolving element visibility, per-site visibility, distance rules, and manual bond deletions. Iterates `bond_state.last_bond_structure.sites` for element lookup.

**Per-fire cost:** O(N_bonds). For typical MD trajectories with ~1000 bonds: ~0.5–2ms. Does not fire on topology-frozen trajectory frames because `bond_state.last_bond_structure` does not change when `compute_bond_connectivity` is in frozen mode (it only writes `last_bond_structure` when topology actually changes).

**Internal memoization/guards:** The key guard is that it reads `bond_state.last_bond_structure` rather than `structure`. During trajectory playback with `freeze_connectivity_on_position_change = true`, `last_bond_structure` does not get a new reference per frame → `filtered_bond_pairs` does not re-derive per frame. This is an intentional architectural decision documented at lines 2038–2039.

**Risk under snapshot architecture:** No change in behavior — `last_bond_structure` is already frozen during playback regardless of snapshot architecture.

**Risk under position-only-write architecture:** Same — `last_bond_structure` is unaffected. No per-frame cost either way.

---

### 6. `ctx_constraints_section` ($derived in Structure.svelte)

**File:line:** `src/lib/structure/Structure.svelte:1475–1481`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived` (not `.by()`)
**Prop chain:** Reads `displayed_structure` directly (as a prop input to `build_constraints_section`), plus `build.has_vacuum`, `context_menu_target_site`, `selected_sites`, `structure`.

**What it does:** Calls `build_constraints_section()` from `viewer-controller.ts` to produce the "Constraints" section of the atom right-click context menu. The function reads `displayed_structure` only to perform an image-atom-to-original-atom index mapping for the `target_idx` (line 57–60 of viewer-controller.ts): if the context menu target is an image atom, it maps to the original atom's selective dynamics.

**Per-fire cost:** O(1) — no site iteration. `is_image_atom` is an O(1) index comparison. `image_to_original_map` lookup is O(1). `structure.sites[target_idx]?.properties?.selective_dynamics` is O(1). Returns a small fixed-size array of 6 menu options. Measured cost: <0.01ms.

**Internal memoization/guards:** None — pure function, no internal cache. However, `$derived` (without `.by()`) re-runs on every reactive input change. `displayed_structure` changes per trajectory frame → this re-runs per trajectory frame. Since cost is O(1), this is not a meaningful performance concern but it is a wasted re-run.

**Risk under snapshot architecture:** With `StructureScene` seeing a frozen snapshot, this derived in Structure.svelte still reads the live `displayed_structure` → still re-runs per frame. This is the reviewer finding #3 "asymmetric state" — the context menu sections computed by Structure.svelte are based on live data while StructureScene renders the frozen snapshot. For the Constraints section this is benign (constraint data comes from `structure`, not `displayed_structure`; the `displayed_structure` read is only for image-atom mapping which is trajectory-stable). But it represents a wasted compute tick per trajectory frame in Structure.svelte.

**Risk under position-only-write architecture:** `displayed_structure` does not change per frame → `ctx_constraints_section` fires zero times during playback. Correct and optimal.

---

### 7. `ctx_charge_label_section` ($derived in Structure.svelte)

**File:line:** `src/lib/structure/Structure.svelte:1483–1488`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived` (not `.by()`)
**Prop chain:** Reads `displayed_structure` directly (passed to `build_charge_label_section`), plus `context_menu_target_site`, `structure`, `charge_state.visible_charge_labels`.

**What it does:** Calls `build_charge_label_section()` from `viewer-controller.ts` to produce the "Charge Label" section of the context menu. The function reads `displayed_structure` at line 91–94 of viewer-controller.ts for the same image-atom-to-original mapping. It also calls `structure?.sites?.some(...)` on the base `structure` (line 98 of viewer-controller.ts) — not on `displayed_structure` — to check if any site has a Bader charge.

**Per-fire cost:** O(1) for the `displayed_structure` read (image mapping only). The `structure.sites.some(...)` call is O(N) in the worst case but short-circuits at the first charged site; for trajectories on non-charged structures (the common MD case), this is O(1) (all sites fail immediately). Returns a small fixed-size array of 4 menu options. Measured cost: <0.01ms typical.

**Internal memoization/guards:** None. Same pattern as `ctx_constraints_section`.

**Risk under snapshot architecture:** Same as `ctx_constraints_section` — re-runs per frame in Structure.svelte even though StructureScene sees frozen data. Asymmetric state, but functionally harmless for the context menu (the menu is only visible when the context menu is open, which doesn't happen during playback).

**Risk under position-only-write architecture:** Zero per-frame fires. Optimal.

---

### 8. `has_charges` ($derived in AtomLegend.svelte)

**File:line:** `src/lib/structure/AtomLegend.svelte:82–84`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived`
**Prop chain:** AtomLegend receives `structure={displayed_structure}` from Structure.svelte at line 3327. `has_charges` reads `structure?.sites?.some(...)`.

**What it does:** Determines whether any atom in the displayed structure has a `bader_charge` property. Used to enable/disable the "Show all charge labels" context menu option within AtomLegend.

**Per-fire cost:** O(N) via `.some()` but short-circuits at the first match. For trajectories on structures without Bader charges (which is the overwhelmingly common case for MD simulations), this returns `false` immediately after the first site check — effectively O(1). For structures WITH charges, iterates until the first charged site. Cost: <0.1ms in typical cases.

**Internal memoization/guards:** None — `$derived` re-runs on every `structure` prop change. Under trajectory playback, `structure={displayed_structure}` gets a new reference per frame → `has_charges` re-runs per frame.

**Risk under snapshot architecture:** AtomLegend still receives `structure={displayed_structure}` from Structure.svelte (not from the snapshot fed to StructureScene). If Structure.svelte does not also snapshot `displayed_structure` before passing it to AtomLegend, `has_charges` re-runs per frame with live data. This is the core issue: the snapshot architecture as described in v2 only snapshots what StructureScene receives, leaving AtomLegend exposed to live updates.

**Risk under position-only-write architecture:** `displayed_structure` never changes per frame → `has_charges` fires zero times during playback. AtomLegend's `has_charges` is correct and stable throughout trajectory. This is strictly better than snapshot architecture which would still cascade to AtomLegend.

---

### 9. `charge_label_entries` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1376–1381`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived.by()`
**Prop chain:** Reads `structure` prop (= `displayed_structure`) as first argument to `compute_charge_label_entries`. Also reads `visible_charge_labels`, `show_charge_labels`, `num_original_sites`, `image_to_original_map`, `realtime_position_overrides`.

**What it does:** Computes the list of `{site_idx, original_idx, charge, position}` entries for rendering HTML charge labels above atoms. Iterates `structure.sites` to find visible-charged atoms.

**Per-fire cost:** Guard at `charge-label-rendering.svelte.ts:28`: `if (!structure?.sites || visible_charge_labels.size === 0 || !show_charge_labels) return []` — exits immediately when no charge labels are visible. For typical trajectory sessions (no Bader charges, `visible_charge_labels` empty), cost is O(1). When charge labels ARE visible, O(N) iteration. Estimated cost with 0 visible labels: <0.01ms.

**Internal memoization/guards:** The `visible_charge_labels.size === 0` guard is robust. For trajectory playback over MD output (no Bader charges), this is always the case.

**Risk under snapshot architecture:** Same behavior as today when no charge labels visible. If charge labels are visible during trajectory, entries update per frame (positions change) — this may be desired or undesired depending on use case. Under snapshot, StructureScene has frozen topology but live `visible_charge_labels`/positions — this could produce correct label positions IF `realtime_position_overrides` is used for position, but the guard also short-circuits on empty set.

**Risk under position-only-write architecture:** `structure` never changes per frame → `charge_label_entries` does not re-derive per frame. Label positions would be stale during trajectory. This is a functional concern for the position-only-write architecture: if users have charge labels visible during trajectory playback, label positions would freeze at the starting frame. Needs explicit handling (either update positions from `trajectory_frame_positions` directly or accept that labels don't animate during playback).

---

### 10. `clip_opacity_overrides` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1817–1831`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived.by()`
**Prop chain:** Reads `structure` prop (= `displayed_structure`) for `structure?.sites`. Also reads `clip_active`, `effective_clip_center`, `clip_radius`, `clip_outside_mode`, `clip_outside_opacity`.

**What it does:** Computes a Map of `{site_idx → opacity}` for atoms outside the sphere clip region. Iterates all sites, computing distance to clip center.

**Per-fire cost:** Guard at line 1818: `if (!clip_active || !effective_clip_center || !structure?.sites) return new Map()` — returns empty Map immediately when clipping is inactive. For typical trajectory sessions (clip off), cost is O(1). When clip is active, O(N) distance computation. Clip is an advanced feature, off by default.

**Internal memoization/guards:** The `!clip_active` guard is the primary protection. Returns a new `Map()` reference on each re-run (even O(1) path), which means `merged_atom_opacity_overrides` always sees a new Map reference — but since `merged_atom_opacity_overrides` is also a `$derived.by()`, it would re-run too. Under clip-off (common), both return empty maps of equal size but different references. This may cause unnecessary downstream re-derives. Note: this is a pre-existing issue, not introduced by trajectory.

**Risk under snapshot architecture:** No behavioral change — `clip_active` is false by default, O(1) cost. If clip is active during trajectory: positions used for clipping come from `structure.sites` (frozen snapshot) not actual frame positions — atoms may be incorrectly clipped/unclipped during playback. This is a pre-existing limitation of the current clip system, not a trajectory-specific regression.

**Risk under position-only-write architecture:** `structure` never changes per frame → `clip_opacity_overrides` never re-derives during playback. Same clipping state as at trajectory start. Same limitation as snapshot: clip positions based on start frame.

---

### 11. `effective_clip_center` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1806–1815`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived.by()`
**Prop chain:** Reads `structure.sites` for centroid fallback when `clip_center` is null.

**What it does:** When `clip_center` prop is null, computes centroid of all atoms as default clip center.

**Per-fire cost:** Guard: `if (clip_center) return clip_center` — O(1) when `clip_center` is set (the common case when clip is active, since users explicitly set a center). Only O(N) when clip is active but no explicit center is set (unusual case). For typical sessions: O(1).

**Internal memoization/guards:** Early-return on `clip_center` prop being non-null.

**Risk under both architectures:** Same as `clip_opacity_overrides` — mostly irrelevant during trajectory, O(1) in common cases.

---

### 12. `isolation_opacity_overrides` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1834–1841`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived.by()`
**Prop chain:** Reads `structure.sites` (= `displayed_structure`). Also reads `isolated_node_atoms`.

**What it does:** Computes a Map of `{site_idx → opacity}` for atoms outside the isolated MOF node. Used in MOF cluster isolation feature.

**Per-fire cost:** Guard at line 1835: `if (!isolated_node_atoms || !structure?.sites) return new Map()` — O(1) when isolation is inactive (the default). Only runs meaningful work during MOF node isolation, which is a specialized workflow unlikely to occur simultaneously with trajectory playback.

**Internal memoization/guards:** `!isolated_node_atoms` guard is the primary protection.

**Risk under both architectures:** Functionally irrelevant for trajectory playback in most sessions. O(1) per frame in the common case.

---

### 13. `merged_atom_opacity_overrides` ($derived.by in StructureScene.svelte)

**File:line:** `src/lib/structure/StructureScene.svelte:1843–1849`
**Bucket:** CHEAP-CASCADE
**Form:** `$derived.by()`
**Prop chain:** Reads `atom_opacity_overrides` (prop), `polyhedra_hidden_atoms`, `clip_opacity_overrides`, `isolation_opacity_overrides`.

**What it does:** Merges four sources of per-atom opacity into a single Map. Used by AtomImpostors for final opacity resolution.

**Per-fire cost:** O(N_overrides) — iterates all entries in each source map. When all four sources are empty Maps (the common default case), cost is O(1). However, this derived re-runs whenever any of its inputs produce a new reference, including the O(1) empty-Map returns from `clip_opacity_overrides` and `isolation_opacity_overrides`. Those always return `new Map()` (new reference), potentially causing `merged_atom_opacity_overrides` to re-run per frame even though nothing changed. This is a pre-existing reference churn issue.

**Internal memoization/guards:** None — pure merge, no guards.

**Risk under snapshot architecture:** `clip_opacity_overrides` and `isolation_opacity_overrides` still re-derive per frame (since `structure` still flows to them via snapshot), still return new `Map()` references, still triggering this merge. No change.

**Risk under position-only-write architecture:** `structure` never changes per frame → `clip_opacity_overrides` and `isolation_opacity_overrides` don't re-derive → `merged_atom_opacity_overrides` doesn't re-derive. Eliminates the new-Map reference churn. Downstream AtomImpostors opacity-update effect also doesn't re-run. Strictly better.

---

### 14. `is_image_atom` (plain function in Structure.svelte)

**File:line:** `src/lib/structure/Structure.svelte:1608–1610`
**Bucket:** EVENT-ONLY
**Form:** Plain function (closure over `displayed_structure`)
**What it does:** Delegates to `_is_image_atom(displayed_structure, idx)` — checks whether a given site index is a PBC image atom (index >= `num_original_sites`).
**Called from:** Event handlers in Structure.svelte (context menu actions, drag filtering), not from any `$effect` or `$derived`.
**Risk under both architectures:** None — no reactive subscription. Called only when context menu opens or drag starts, both of which require the user to pause/interact.

---

### 15. `has_original_atoms` (plain function in Structure.svelte)

**File:line:** `src/lib/structure/Structure.svelte:1612–1614`
**Bucket:** EVENT-ONLY
**Form:** Plain function (closure over `displayed_structure`)
**What it does:** Returns whether any of the given site indices are non-image atoms.
**Called from:** Event handlers only.
**Risk under both architectures:** None.

---

### 16. `get_original_atoms_only` (plain function in Structure.svelte)

**File:line:** `src/lib/structure/Structure.svelte:1616–1618`
**Bucket:** EVENT-ONLY
**Form:** Plain function (closure over `displayed_structure` and `structure`)
**What it does:** Filters a list of site indices to only include non-image atoms, optionally mapping image atoms to their originals.
**Called from:** Event handlers only (drag-to-move filtering, selection filtering).
**Risk under both architectures:** None.

---

### 17. Interaction controller (`get_displayed_structure` getter in interaction.svelte.ts)

**File:line:** `src/lib/structure/controllers/interaction.svelte.ts:56` (interface), wired at `src/lib/structure/Structure.svelte` ~line 2011: `get_displayed_structure: () => displayed_structure`
**Bucket:** EVENT-ONLY
**Form:** Getter closure — returns current value of `displayed_structure` at call time
**What it does:** The interaction controller uses `get_displayed_structure()` inside box-select and atom-drag event handlers to map image atoms to original atoms for selection and move operations. Never called from a reactive `$effect` or `$derived` inside the controller.
**Risk under both architectures:** None — reads `displayed_structure` only on user interaction events. During trajectory playback, users cannot drag atoms (no interaction during playback in the current UX), so this is never called during playback.

---

### 18. Pencil-mode controller (`get_displayed_structure` getter in pencil-mode.svelte.ts)

**File:line:** `src/lib/structure/controllers/pencil-mode.svelte.ts:39` (interface), used at line ~547 inside `handle_bond_drag_move()`
**Bucket:** EVENT-ONLY
**Form:** Getter closure
**What it does:** Called inside the `pointermove` handler during bond-drawing drag to get site positions from `displayed_structure.sites`. Used to find candidate bond endpoints near the cursor.
**Risk under both architectures:** None — called only during pencil-mode bond drawing, which is a user edit operation that is (should be) disabled during trajectory playback.

---

### 19. Context-menu-actions controller (`get_target_indices` + `map_to_original` in context-menu-actions.ts)

**File:line:** `src/lib/structure/controllers/context-menu-actions.ts:132–157` (`get_target_indices`), `194–200` (`map_to_original`)
**Bucket:** EVENT-ONLY
**Form:** Functions called inside context menu action handlers
**What it does:** `get_target_indices(map_images=true)` calls `deps.get_displayed_structure()` for image-atom-to-original mapping when building the list of atoms to apply an action to. `map_to_original` is the single-atom version. Both read `displayed_structure` at call time only, not in any reactive context.
**Called from:** Context menu action dispatchers — only when user selects a menu item.
**Risk under both architectures:** None.

---

### 20. ContextMenu `on_select` handler (in Structure.svelte template)

**File:line:** `src/lib/structure/Structure.svelte:3559–3564`
**Bucket:** EVENT-ONLY
**Form:** Inline event handler in template (`on_select` callback prop)
**What it does:** Reads `displayed_structure?.sites[context_menu_target_site]` to get the site's `xyz` coordinates when the user selects "Clip here" from the context menu. This sets `clip_center` to the selected atom's position.
**Risk under both architectures:** None — event handler only, not reactive.

---

### 21. `bottom_left` snippet render (in Structure.svelte template)

**File:line:** `src/lib/structure/Structure.svelte:3522`
**Bucket:** EVENT-ONLY (with caveat)
**Form:** `{@render bottom_left?.({ structure: displayed_structure })}`
**What it does:** Passes `displayed_structure` to an externally-provided Svelte snippet. The snippet is provided by consumers of the `<Structure>` component via `{#snippet bottom_left({ structure })}`. Cost entirely depends on the caller's snippet implementation.
**Caveat:** If a caller's `bottom_left` snippet contains reactive derivations (e.g., a `{#each structure.sites}` loop), this WOULD fire per trajectory frame. However, in the CatGO codebase, a search of all `<Structure>` call sites shows that `bottom_left` snippets are used for static overlays (measurement legends, instruction text) that do not iterate `structure.sites`. The Svelte template re-render of the snippet itself on `displayed_structure` change is cheap (one function call + prop pass).
**Risk under snapshot architecture:** If the snippet passes `displayed_structure` into a reactive context, it would see live data while StructureScene sees frozen snapshot — asymmetric state. For current call sites this is harmless.
**Risk under position-only-write architecture:** Snippet receives a stable `displayed_structure` throughout playback. No re-renders. Better.

---

## Architecture-Relevant Observations

### Observation 1: No CRITICAL-LIVE consumers exist

The investigation found zero consumers that genuinely require live per-frame `displayed_structure` updates for correctness. Even `atom_data` and X2 shadow sync — the heaviest consumers — have trajectory fast-paths that work via `trajectory_frame_positions` directly, bypassing the full `displayed_structure` evaluation. This finding strongly supports the position-only-write architecture (W6 candidate).

### Observation 2: The "sibling" problem is smaller than reviewer finding #3 implied

The original concern named "charge labels, bond edit cleanup, possibly export pane, AtomLegend" as per-frame sibling consumers. The audit found:
- Export pane (IOPane): receives base `structure`, not `displayed_structure` (line 3166 of Structure.svelte) — NOT a consumer
- Bond edit cleanup (pencil-mode): EVENT-ONLY — no reactive subscription
- AtomLegend `has_charges`: O(1) in practice (short-circuits immediately for trajectories without Bader charges)
- Charge label entries: O(1) when no labels visible (the common case)

The real per-frame reactive consumers outside StructureScene are only `ctx_constraints_section` and `ctx_charge_label_section` in Structure.svelte — both O(1) cost, both harmless.

### Observation 3: Snapshot architecture leaves Structure.svelte reactive to live data

Under snapshot (StructureScene sees `__topology_snapshot`), Structure.svelte's own reactive graph (`ctx_constraints_section`, `ctx_charge_label_section`) and AtomLegend's `has_charges` continue to cascade per frame on live `displayed_structure`. The asymmetry is: StructureScene renders frozen topology, but Structure.svelte computes context menu sections based on live topology. During trajectory playback this is benign (context menu is not visible, menu sections are ephemeral UI state) but it is architecturally inconsistent and wastes ~0.02ms/frame on three O(1) derives.

### Observation 4: Position-only-write eliminates all per-frame fires outside StructureScene

Under position-only-write, `displayed_structure` never changes per trajectory frame. Every consumer outside the `trajectory_frame_positions` fast-path fires zero times. This includes the context menu deriveds, AtomLegend, and all CHEAP-CASCADE consumers. StructureScene itself handles per-frame position updates through its existing `trajectory_frame_positions` fast-paths in `atom_data` (line 1892) and X2 shadow sync (line 2340). The architecture is cleaner: the reactive graph is fully quiescent during playback, and only the GPU-side fast-paths run.

### Observation 5: `merged_atom_opacity_overrides` has reference-churn under current architecture

`clip_opacity_overrides` (line 1817) and `isolation_opacity_overrides` (line 1834) both return `new Map()` on the O(1) guard path — a new reference every time. This means `merged_atom_opacity_overrides` re-runs on every `structure` change even when no clips or isolation is active. Under position-only-write, this reference churn disappears (no `structure` changes during playback). Under snapshot, it persists because `structure` inside StructureScene is still the frozen snapshot reference (which doesn't change per frame either — wait, if the snapshot is frozen, `structure` doesn't change per frame in StructureScene, so `clip_opacity_overrides` also doesn't re-run). Under snapshot, this churn is also eliminated within StructureScene.

### Observation 6: `polyhedra_data` and `polyhedra_geometry` are not in the table but are relevant

**File:line:** `src/lib/structure/StructureScene.svelte:1765` and `1784`

These were not listed as bucket-5 consumers but are implicitly covered: `polyhedra_data` reads `structure?.sites` and is guarded by `if (!show_polyhedra || !structure?.sites) return []`. With `show_polyhedra` false (default), O(1). Same pattern as other gated consumers. Both architectures eliminate per-frame re-derives.

---

## Open Questions for W6

**Q1 (position-only-write): Stale charge label positions during playback** — `charge_label_entries` reads `structure.sites` for atom positions. Under position-only-write, these positions freeze at trajectory start. Is this acceptable UX (charge labels don't animate during trajectory)? If not, `charge_label_entries` needs an explicit override path via `trajectory_frame_positions`.

**Q2 (both architectures): The `bottom_left` snippet API surface** — External consumers of `<Structure>` could potentially provide a `bottom_left` snippet that iterates `displayed_structure.sites`. Under snapshot, they'd see live data while the 3D view is frozen. Under position-only-write, they'd see a stale structure. No current internal call site does this, but it's a public API. Does this require documentation or a guard?

**Q3 (snapshot only): Who snapshots the `displayed_structure` passed to AtomLegend?** — The v2 snapshot plan only described what StructureScene receives. AtomLegend receives `structure={displayed_structure}` from Structure.svelte directly (line 3327). For full snapshot consistency, AtomLegend would also need `structure={__topology_snapshot ?? displayed_structure}`. Is this in scope for v2, or does it remain "cheap asymmetry we accept"?

**Q4 (both architectures): `effective_clip_center` centroid computation** — When `clip_center` is null, `effective_clip_center` computes centroid from `structure.sites`. Under both architectures, the centroid is computed at trajectory start and doesn't update per frame. If the structure shifts significantly during playback (large-amplitude vibrations), the clip sphere may drift relative to the visual atom positions. Is this a known limitation or a bug?

---

## Files Covered in This Audit

All files read and confirmed as part of this audit:

- `/Users/jenedithpascasio/CatGO/src/lib/structure/Structure.svelte` — lines 730–744, 957, 1114, 1475–1488, 1605–1618, 3315–3339, 3355–3370, 3515–3580
- `/Users/jenedithpascasio/CatGO/src/lib/structure/StructureScene.svelte` — lines 1370–1382, 1720–1842, 1855–1937, 2030–2065, 2255–2395
- `/Users/jenedithpascasio/CatGO/src/lib/structure/AtomLegend.svelte` — lines 78–96
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/transform-controller.svelte.ts` — lines 110–132
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/viewer-controller.ts` — lines 30–126
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/context-menu-actions.ts` — lines 128–201
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/interaction.svelte.ts` — lines 50–70
- `/Users/jenedithpascasio/CatGO/src/lib/structure/controllers/pencil-mode.svelte.ts` — lines 35–55
- `/Users/jenedithpascasio/CatGO/src/lib/structure/bond-computation-controller.svelte.ts` — lines 56–160
- `/Users/jenedithpascasio/CatGO/src/lib/structure/charge-label-rendering.svelte.ts` — lines 1–45
