# W6 — Architecture Decision: Snapshot vs Position-Only-Write

**Branch:** atom-soa-refactor @ bd0da10f
**Inputs:** plans/W3-displayed-structure-audit.md, plans/W4-atom-manager-lift-audit.md
**Decision status:** PROPOSED — awaiting reviewer signoff per resumption checklist

## TL;DR

Recommend Architecture P (Position-only-write). The W3 audit found zero consumers that need live per-frame `displayed_structure` updates — every reactive consumer either has a feature-flag guard that makes it O(1) during trajectory sessions, or is EVENT-ONLY and never fires during playback. Architecture S (Snapshot) solves the NEEDS-SNAPSHOT bucket inside StructureScene but leaves Structure.svelte's own reactive graph (`ctx_constraints_section`, `ctx_charge_label_section`) and AtomLegend's `has_charges` cascading per frame on live data — the asymmetric-state problem reviewer finding #3 identified. Architecture P eliminates that asymmetry completely by making `displayed_structure` quiescent throughout playback, and does so with a smaller implementation surface than S because the per-frame position path already exists in the X2 shadow sync's `trajectory_only` branch (`StructureScene.svelte:2339`) and needs only to be moved to the right caller.

## Why this decision matters

The choice between S and P is not a minor implementation detail. Architecture S solves the NEEDS-SNAPSHOT problem at the cost of creating an observable inconsistency: StructureScene renders a frozen topology snapshot while Structure.svelte computes context-menu sections and AtomLegend computes `has_charges` from live data that is updating every frame. Even if those consumers are O(1) today — W3 confirmed this for `ctx_constraints_section` (`Structure.svelte:1475`), `ctx_charge_label_section` (`Structure.svelte:1483`), and `AtomLegend.has_charges` (`AtomLegend.svelte:82`) — the architectural pattern is wrong. It trains future maintainers to treat "frozen StructureScene, live sibling components" as the correct invariant. When someone adds a component that reads `displayed_structure` for a non-trivial purpose during playback, the asymmetry silently produces stale data.

Architecture P's invariant is simpler: during playback, `displayed_structure` does not change; the reactive graph is fully quiescent outside two fast-paths. That invariant is easy to test (W1's regression detector can assert it with a single fire-counter check) and easy to delete patches against (all five T6 patch categories become unnecessary, not just one).

"Just pick the cheaper one" is insufficient because cheapness must be evaluated across the full cascade. W3 Observation 3 states: "Under snapshot...Structure.svelte's own reactive graph and AtomLegend's `has_charges` continue to cascade per frame on live `displayed_structure`. The asymmetry is: StructureScene renders frozen topology, but Structure.svelte computes context menu sections based on live topology." That is a correctness concern that Architecture S does not address.

---

## Architecture S (Snapshot) — Full Description

### Mechanism

When `trajectory_active` flips false → true, Structure.svelte captures a snapshot of `displayed_structure` into `let __topology_snapshot: AnyStructure | null = $state(null)`. The snapshot must be taken after the async supercell pipeline has settled — guarded by comparing the `supercell_generation` counter to a last-committed value (v2 T2.1). An undefined guard (v2 T2.2) retries via `requestAnimationFrame` if `displayed_structure` is null at flip time.

Structure.svelte passes `__topology_snapshot ?? displayed_structure` as the `structure` prop to `<StructureScene>` at line 3361 instead of `displayed_structure` directly.

During playback, Trajectory.svelte continues writing `current_structure` per frame. That write propagates through the full reactive cascade in Structure.svelte:

```
Trajectory.svelte: current_structure = frame.structure
                   trajectory_frame_positions = position_cache[i]
  → Structure.svelte: cell_transformed_structure $derived re-runs
    → supercell $effect re-runs (async, even as no-op)
      → PBC $effect re-runs → displayed_structure = new ref
```

StructureScene receives `__topology_snapshot` (frozen, same ref) as `structure` throughout playback. The X2 shadow sync at `StructureScene.svelte:2263` still fires — it reads both `structure` and `trajectory_frame_positions`. With a frozen `structure`, `struct_changed = false`; `trajectory_frame_positions` changes → `traj_changed = true`. The condition at line 2339 (`trajectory_only`) fires, bulk-copying positions from the Float32Array at ~1–2ms for 878 atoms.

When `trajectory_active` flips true → false, T5's pause-and-edit handler reads `atom_manager.positions_buffer`, writes back to `structure.sites[i].xyz` via full-object reassignment, and clears `__topology_snapshot`.

### Per-concern analysis

**Supercell index-space (LB1)**

The existing guard at `StructureScene.svelte:2346` — `traj_positions.length >= sites.length * 3` — is unchanged under Architecture S. `sites` comes from `__topology_snapshot.sites`. For a 2×1×1 supercell on a 439-atom base: `snapshot.sites.length = 878`, `traj_positions.length = 1317` (439 × 3). Check: `1317 >= 2634` → false → `trajectory_only` does not fire; falls through to `positions_only` at line 2371, which reads `snapshot.sites[sid].xyz`. Those xyz values are snapshot positions (trajectory start), not per-frame updated. Supercell atom positions are frozen during playback under Architecture S.

**PBC image atoms**

`__topology_snapshot.sites` contains PBC image atoms at indices ≥ `num_original_sites`. The `positions_only` fast-path (line 2371) reads their positions from `snapshot.sites[sid].xyz` — frozen at trajectory start. Image atom positions do not animate during playback. This is a pre-existing limitation of the current patched architecture; Architecture S does not worsen or improve it.

**Drag-during-playback**

`realtime_position_overrides` flows from `interaction.svelte.ts` as a live prop to StructureScene (not involved in the snapshot mechanism). The drag fast-path in `AtomManagerInstances.svelte:432` fires on override map changes and calls `manager.find_slot_by_site_id` + `manager.set_position` for each overridden slot. `atom_manager` has the snapshot topology (populated by the X2 slow path at trajectory start), so `find_slot_by_site_id` lookups are valid. Drag-during-playback is safe under Architecture S, with no additional mechanism required.

**Pause-and-edit (writeback contract — references W2)**

T5's pause handler reads `scene_atom_manager.positions_buffer` (position at the last trajectory frame) and writes back to `structure.sites[i].xyz`. Because `structure` is a `$bindable` prop, a deep mutation to `sites[i].xyz` may not propagate through Svelte 5's binding mechanism. W2 requires full object reassignment: `structure = { ...structure, sites: structure.sites.map((s, i) => ({ ...s, xyz: [mgr.get_x(slot_for_i), ...] })) }`. Under Option A (W4), Structure.svelte has `scene_atom_manager` accessible for this read. The writeback loop uses `site_ids_buffer` to map slot → site_id before writing. W4 Q7 confirms feasibility. This is a shared requirement between S and P.

**Vibration-during-playback**

The vibration `$effect` at `StructureScene.svelte:1611` reads `vibration_data` and writes `realtime_position_overrides`. Under Architecture S, StructureScene receives the frozen snapshot as `structure`; `vibration_data.base_positions` references positions from the snapshot frame. If trajectory and vibration are simultaneously active (not supported in current UX), positions from both paths would conflict in `atom_manager` — trajectory writes via the X2 `trajectory_only` branch, vibration via the drag fast-path. This is out of scope and identical in risk to Architecture P.

**H-bond geometry**

`compute_hbond_connectivity` at `StructureScene.svelte:1595` reads `structure` (= snapshot under S) and `bond_pairs`. `h_bond_pairs` at line 1603 is `$derived.by()` reading `hbond_state.h_bond_connectivity`, `bond_state.last_bond_structure`, `structure`, and `realtime_position_overrides`. All inputs are stable per frame under the snapshot → `h_bond_pairs` does not re-derive per frame. H-bond positions reference snapshot sites: frozen at trajectory start. Per v2 plan T1.d, this is acceptable for v1 of the bypass. Architecture S makes the behavior explicit but does not fix it.

**Charge label positions**

`charge_label_entries` at `StructureScene.svelte:1376` reads `structure` (= snapshot). The guard at `charge-label-rendering.svelte.ts:28` — `visible_charge_labels.size === 0 || !show_charge_labels` — exits immediately in the typical case (no Bader charges during MD). W3 Q1 identifies the issue: when charges ARE visible, `compute_charge_label_entries` uses `snapshot.sites` for positions, which are frozen. Architecture S does not fix stale charge label positions; a separate override path is needed.

**Exit transition**

On playback stop: `trajectory_active → false`, `__topology_snapshot` cleared, StructureScene's `structure` prop reverts to live `displayed_structure`. If T5 writeback has run, `displayed_structure.sites` reflects the final frame positions. One `compute_bond_connectivity` recompute fires (worker path, ~5ms after T7 prewarm). During the worker's async interval, `bond_pairs` is empty → brief bond flash. Architecture S does not address this flash; T7 mitigates duration. A "hold last bond_pairs" pattern would eliminate it.

### Patches it lets us delete

From the T6 deletion list in `trajectory-bypass-refactor.md`:

| Patch | Architecture S status |
|---|---|
| `freeze_connectivity_on_position_change` param + `\|TRAJ` sentinel (`bond-computation-controller.svelte.ts:69,115`) | DELETE — `structure` is frozen per frame; `compute_bond_connectivity` never sees position changes |
| `build_bond_pairs` memo guard (`__bbp_prev_*` vars, `StructureScene.svelte:1545–1551`) | RETAIN — still needed to absorb Svelte over-fires from non-structure inputs |
| X2 `trajectory_only` branch (`StructureScene.svelte:2339–2363`) | RETAIN — still the per-frame position update mechanism under Architecture S |
| X2 `positions_only` branch (`StructureScene.svelte:2371–2395`) | RETAIN — still needed for supercell/PBC cascade absorption |
| X2 memo state vars (`__x2_*`, lines 2249–2261) | RETAIN — identity tracking still needed for the X2 effect's fast-path branches |
| `atom_data` fast-clone cache (`__atom_data_cache_*`, lines 1855–1875) | RETAIN — `atom_data` doesn't fire per frame under snapshot, but cache guards against Svelte over-fires on other inputs |
| `[probe]` debug logs | DELETE |

Architecture S deletes **1 of the 5 substantive patch categories**: the `freeze_connectivity_on_position_change` flag.

### What this architecture leaves unfixed

The asymmetric-state problem from reviewer finding #3 persists under Architecture S. Specifically:

- `ctx_constraints_section` at `Structure.svelte:1475` — `$derived`, reads live `displayed_structure` → fires per frame (O(1) cost, but architecturally inconsistent)
- `ctx_charge_label_section` at `Structure.svelte:1483` — same
- `AtomLegend.has_charges` at `AtomLegend.svelte:82` — `$derived`, reads `structure` prop which is `displayed_structure` from `Structure.svelte:3327` — fires per frame (O(1) short-circuit for non-charged structures)

These three consumers see live `displayed_structure` while StructureScene sees frozen snapshot. W3 Observation 3: "The asymmetry is: StructureScene renders frozen topology, but Structure.svelte computes context menu sections based on live topology."

Additionally, Structure.svelte's upstream cascade (`cell_transformed_structure → supercell → PBC → displayed_structure`) still fires per frame, wasting async supercell `$effect` invocations even when they are no-ops.

### Implementation effort estimate

- T2 (snapshot state, settled-state gate T2.1, null guard T2.2): 4–6h
  - Async supercell `supercell_generation` gate is the risky element — requires understanding the Svelte 5 `$effect` micro-flush ordering with async effects. The CLAUDE.md warning: "Svelte 5 `$effect.pre` micro-flush behavior we still don't fully understand."
- T3 (atom_manager lift via Option A + position-write loop in Trajectory.svelte): 3–4h
- T4 (bond fast-path, `build_trajectory_bond_pairs` wiring): 2–3h
- T5 (pause-and-edit handler + W5 resume-disable): 2–3h
- T6 (delete 1 of 5 patch categories): 0.5h
- T7 (worker prewarm): 0.5h
- W1 (regression detector — must verify against asymmetric-state in Structure.svelte, harder because Structure.svelte's reactive graph is NOT frozen): 3–4h

**Total estimate under Architecture S: 15–21h**

### Reversibility

T2 (snapshot) is the critical step. Recommend T2 + T3 land in a single commit behind a `TRAJECTORY_BYPASS_REFACTOR` feature flag defaulting off until both phases pass verification. T4, T5, T6 are independently revertable. Worst-case revert: commit `29420f91`.

---

## Architecture P (Position-only-write) — Full Description

### Mechanism

Trajectory.svelte stops writing `current_structure` per frame. It writes ONLY `trajectory_frame_positions` (Float32Array). `displayed_structure` does not change per trajectory frame. The entire reactive cascade from `cell_transformed_structure → supercell → PBC → displayed_structure → StructureScene` is quiescent during playback.

Per-frame work happens in exactly two places:

**1. Atom positions.** A new `$effect` in Trajectory.svelte fires when `trajectory_frame_positions` changes. It iterates `0..min(atom_manager.count, traj_positions.length / 3)` slots. For each slot: `sid = atom_manager.site_ids_buffer[slot]`; if `realtime_position_overrides?.has(sid)`, skip (drag wins); else `atom_manager.set_position(slot, traj_positions[sid*3], traj_positions[sid*3+1], traj_positions[sid*3+2])`. Each `set_position` call that changes a value increments `atom_manager.version`, waking `AtomManagerInstances.svelte:361`'s sync `$effect` which uploads only the dirty position attribute to the GPU.

**2. Bond positions.** `build_trajectory_bond_pairs` (currently dead in `bond-computation-controller.svelte.ts`) is wired into the `build_bond_pairs $effect.pre` at `StructureScene.svelte:1552`. When `trajectory_active && trajectory_frame_positions`, call `build_trajectory_bond_pairs(bond_state.bond_connectivity, trajectory_frame_positions, realtime_position_overrides)` instead of `build_bond_pairs`. Bond connectivity is frozen (topology didn't change during playback).

`atom_manager` is lifted to Structure.svelte via `$bindable` per W4 Option A. This is the minimum change set (W4 Q8): 5 targeted edits, no hook movement, no GPU/scene separation invariant violation (W4 §5). The X5/X6 hook closures at `StructureScene.svelte:2627–2751` remain unchanged — they close over scene-local radius/color state and `bond_state`.

The X2 shadow sync's `trajectory_only` branch at `StructureScene.svelte:2339` becomes dead code under Architecture P (Structure prop doesn't change per frame → `struct_changed = false` AND `traj_changed = false` since `trajectory_frame_positions` is no longer an input to X2 if it's processed upstream by Trajectory). Dead code is deleted in T6.

### Per-concern analysis

**Supercell index-space (LB1)**

Under Architecture P, `atom_manager` is populated from `displayed_structure` at topology load (X2 slow path). `site_ids_buffer[slot]` maps to displayed-structure indices (0..N-1 for supercell-expanded structures). `trajectory_frame_positions` is indexed by base-structure site_id (0..M-1 where M < N for supercell). The position-write loop bound `min(mgr.count, traj_positions.length / 3)` prevents out-of-bounds reads. Slots beyond the bound (supercell-derived atoms) retain their last-set positions: initial positions from the X2 slow path at topology load.

The LB1 guard in the existing X2 shadow sync (`StructureScene.svelte:2346`) moves to the position-write loop and becomes explicit documentation rather than an implicit guard. The behavior (supercell-extra atoms frozen during playback) is identical to Architecture S.

When `displayed_structure.sites.length > traj_positions.length / 3`, the UI should surface a message: "Trajectory playback on supercell structures: cells beyond the base structure are frozen." This is strictly better than the current silent behavior.

**PBC image atoms**

Same constraint as LB1. Image atoms have site_ids ≥ `num_original_sites` in `site_ids_buffer`. `traj_positions` doesn't cover them. The loop bound ensures `set_position` is not called for these slots — they retain initial positions from X2 slow path. Same behavior as Architecture S. Architecture P makes this explicit in one place (the write loop), not implicit in the X2 snapshot guard.

**Drag-during-playback**

The position-write loop explicitly checks `realtime_position_overrides?.has(sid)` before calling `set_position`. Drag wins. Bond geometry: `build_trajectory_bond_pairs` must accept `realtime_position_overrides` as a parameter (v2 T4 already specifies this extension). Per-bond endpoint: `realtime_position_overrides?.get(idx) ?? traj_positions[idx*3..]`. W4 analysis (§Q4 and T3 drag-precedence requirement) confirm this is the correct pattern.

**Pause-and-edit (writeback contract — references W2)**

Under Architecture P, `displayed_structure` is the live structure throughout playback. When the user pauses and edits, they should edit from the trajectory's last frame position. T5 writeback: when `trajectory_active` flips true → false, read `scene_atom_manager.positions_buffer` + `site_ids_buffer` → full object reassignment on `structure` (W2 contract). Under Architecture P, there is no snapshot to clear — the writeback directly updates the live structure, the reactive pipeline re-derives once, and `displayed_structure` updates to the paused frame's geometry. This is cleaner than Architecture S because the state machine has one fewer object to track.

**Vibration-during-playback**

Identical to Architecture S. Out of scope, mutually exclusive in current UX.

**H-bond geometry**

`compute_hbond_connectivity` at `StructureScene.svelte:1595` reads `structure` (= `displayed_structure` — stable per frame under P). `h_bond_pairs` at line 1603 reads `hbond_state.h_bond_connectivity`, `bond_state.last_bond_structure`, `structure`, `realtime_position_overrides`. All stable per frame → `h_bond_pairs` doesn't re-derive. H-bond positions reference `bond_state.last_bond_structure` (frozen at topology load, which under P is before trajectory starts). Same result as Architecture S: h-bonds frozen during playback. Acceptable for v1.

**Charge label positions**

W3 Q1 applies to both architectures equally. Under Architecture P, `charge_label_entries` at `StructureScene.svelte:1376` reads `structure` (= stable `displayed_structure`). The guard at `charge-label-rendering.svelte.ts:28` exits immediately when `visible_charge_labels.size === 0`. When labels are visible, positions are from `displayed_structure.sites` (stable, not updated per frame). Stale positions during playback. The fix is targeted: extend `compute_charge_label_entries` to accept `trajectory_frame_positions` and `atom_manager.site_ids_buffer` as override inputs. This is O(N_visible_labels) and does not block the initial refactor.

**Exit transition**

Under Architecture P, when `trajectory_active → false`, the position-write loop stops. `atom_manager` retains the final frame's positions. T5 writeback writes those positions to `structure.sites`. The reactive pipeline re-derives `displayed_structure` once. `compute_bond_connectivity` fires once (worker path, ~5ms post T7). During the async interval, `bond_pairs` is momentarily empty — same brief flash concern as Architecture S. Architecture P's advantage: the exit is cleaner because there is no snapshot ref-swap in StructureScene's `structure` prop — `displayed_structure` was always flowing to StructureScene and continues to do so. There is no "swapping from snapshot back to live" moment where StructureScene's internal state might be stale.

### Patches it lets us delete

Under Architecture P, `displayed_structure` never changes per frame → all NEEDS-SNAPSHOT consumers see no changes per frame → their reactive effects do not re-fire during playback:

| Patch | Architecture P status |
|---|---|
| `freeze_connectivity_on_position_change` param + `\|TRAJ` sentinel (`bond-computation-controller.svelte.ts:69,115`) | DELETE — `compute_bond_connectivity $effect.pre` reads `structure` (stable) → never re-fires during playback |
| `build_bond_pairs` memo guard (`__bbp_prev_*` vars, `StructureScene.svelte:1545–1551`) | DELETE trajectory-specific path; simplify memo. `struct_ref === __bbp_prev_struct` is permanently true during playback; the `$effect.pre` only fires when `realtime_position_overrides` changes (drag) or `selected_sites` changes (selection) — both intentional. The memo's trajectory-specific reasoning disappears |
| X2 `trajectory_only` branch (`StructureScene.svelte:2339–2363`) | DELETE — Trajectory.svelte writes positions directly; X2 no longer needs a per-frame path |
| X2 `positions_only` branch (`StructureScene.svelte:2371–2395`) | DELETE — Structure.svelte's supercell/PBC pipeline doesn't run per frame → no position-only cascades to absorb |
| X2 memo state vars (`__x2_*`, lines 2249–2261) | DELETE trajectory-specific tracking (`__x2_prev_traj`, `traj_changed`); simplify remaining memo to track only topology changes |
| `atom_data` fast-clone cache (`__atom_data_cache_*`, lines 1855–1875) | DELETE — `atom_data $derived.by()` reads `structure` which never changes per frame → never re-runs during playback. No cache needed |
| `[probe]` debug logs | DELETE |

Architecture P deletes **all 5 substantive patch categories**. Net LOC change is negative, as intended.

### What this architecture leaves unfixed

1. **Stale charge label positions during playback (W3 Q1).** Charge label 3D positions freeze at trajectory start when `visible_charge_labels.size > 0`. Targeted fix available but not in initial scope.

2. **`bottom_left` snippet API surface (W3 Q2).** External consumers providing a `bottom_left` snippet that iterates `displayed_structure.sites` would see stable (non-updating) positions during playback. Documents as a known limitation of the public API. No internal call sites are affected.

3. **Supercell + trajectory position completeness.** Slots beyond `traj_positions.length / 3` freeze at initial positions. Documented, surfaced via UI message. Not a regression from current behavior (same freeze happens silently today).

4. **H-bond positions frozen during playback.** Acceptable for v1; extensible via `build_trajectory_hbond_pairs` in a future iteration.

5. **`atom_manager.set_position` precision.** `Math.fround`-equal values are no-ops in `set_position`. GPU positions carry Float32 precision. For MD trajectories this is appropriate.

### Implementation effort estimate

- Phase 0 — W1 regression detector: 2–3h
- Phase 1 — Option A atom_manager lift (`StructureScene.svelte:2218`, `Structure.svelte`, `Trajectory.svelte`): 2–3h
- Phase 2 — Position-write loop in Trajectory.svelte + LB1/drag-override guards: 2–3h
- Phase 3 — `build_trajectory_bond_pairs` wiring + signature extension + index-space fix: 2–3h
- Phase 4 — Remove `current_structure` per-frame write from Trajectory.svelte: 1h
- Phase 5 — T5 pause-and-edit writeback + W5 resume-disable prop: 2–3h
- Phase 6 — Delete all 5 patch categories: 1–1.5h
- Phase 7 — Worker prewarm: 0.5h

**Total estimate under Architecture P: 12–18h**

The lower bound reflects that Architecture P avoids the T2.1 settled-state async gate (the riskiest engineering task in Architecture S). The upper bound reflects that W1's regression detector and W7's test suite take real time to build correctly.

### Reversibility

Phase 1 (atom_manager lift) is independently revertable with no behavior change. Phase 2 (position-write loop) is additive — atoms animate via both the old path and the new path until Phase 4. Phase 4 (remove `current_structure` write) is the pivot — if there's a bug, revert to before Phase 4. Phase 6 (patch deletion) is the final irreversible step, gated on W1 silence. Worst-case revert: commit `29420f91`.

---

## Side-by-side comparison

| Concern | Architecture S | Architecture P |
|---|---|---|
| Supercell index-space (LB1) | Guard stays in X2 (StructureScene.svelte:2346); supercell-extra atoms frozen | Guard moves to position-write loop; same freeze; explicit + documented |
| PBC image atoms | Frozen at snapshot positions | Frozen at topology-load positions; same behavior |
| Drag-during-playback | Safe — `realtime_position_overrides` flows as live prop regardless of snapshot | Safe — position-write loop explicitly skips overridden slots |
| Pause-and-edit (W2) | T5 writeback required; no snapshot to clear | T5 writeback required; cleaner — no snapshot state machine |
| Vibration | Out of scope, mutually exclusive | Same |
| H-bond geometry | Frozen at snapshot; acceptable for v1 | Frozen at topology-load; identical outcome |
| Charge label positions | Frozen at snapshot (W3 Q1 unfixed) | Frozen at topology-load (W3 Q1 unfixed); targeted fix available |
| Exit transition | Snapshot clear → ref-swap in StructureScene → potential position jump | T5 writeback ensures continuity; cleaner exit |
| Asymmetric state (reviewer #3) | NOT FIXED — Structure.svelte + AtomLegend still cascade per frame | FIXED — entire reactive graph quiescent during playback |
| Upstream cascade still fires per frame | YES — supercell/PBC effects run each frame | NO — none of the cascade runs per frame |
| T6 patches deleted | 1 of 5 substantive categories | 5 of 5 substantive categories |
| New machinery added | `__topology_snapshot` + T2.1 settled-state gate (async, risky) + T2.2 null guard | LB1 guard in write loop; `build_trajectory_bond_pairs` sig extension |
| Implementation effort | 15–21h | 12–18h |
| Implementation risk | T2.1 async gate involves Svelte 5 micro-flush ordering (acknowledged unknown) | No async coordination; position-write loop is synchronous |
| Reversibility | T2+T3 must land together (broken intermediate state); feature flag recommended | Each phase independently revertable |

---

## Recommendation

**Recommend Architecture P (Position-only-write).**

**Reason 1 — Architecture S leaves the asymmetric-state problem unfixed, and the asymmetry is real.**

W3 Observation 3 is explicit: "Under snapshot...Structure.svelte computes context menu sections based on live topology...Asymmetric reactive state = bugs." The three per-frame cascades in Structure.svelte outside StructureScene are: `ctx_constraints_section` (`Structure.svelte:1475`, `$derived`), `ctx_charge_label_section` (`Structure.svelte:1483`, `$derived`), and `AtomLegend.has_charges` (`AtomLegend.svelte:82`, `$derived` reading `structure={displayed_structure}` from `Structure.svelte:3327`). All three are O(1) in typical trajectory sessions and functionally harmless today. But the architectural rule that "Architecture P's invariant provides" — `displayed_structure` is quiescent during playback — cannot be stated under Architecture S. Future contributors will add code that reads `displayed_structure` outside StructureScene and, without a clear invariant, some will build per-frame reactive subscriptions on it.

**Reason 2 — Architecture P removes all five T6 patch categories; Architecture S removes one.**

The patch stack at commit `29420f91` exists because trajectory playback drove per-frame re-runs of `atom_data`, `build_bond_pairs`, and the X2 shadow sync. Architecture S freezes what StructureScene sees but leaves the mechanisms that produced those re-runs intact as guards against the upstream cascade that still runs. Architecture P eliminates the upstream cascade entirely — the `$effect.pre` at `StructureScene.svelte:1552` never fires during playback (`struct_ref === __bbp_prev_struct` is permanently true); `atom_data $derived.by()` at line 1877 never fires during playback (`structure.sites` never changes); the X2 shadow sync at line 2263 never fires during playback (`structure !== __x2_prev_struct` is false). All three patches are eliminated at the root, not papered over.

**Reason 3 — Architecture P avoids the riskiest implementation task in Architecture S.**

T2.1 in the v2 plan — gating the snapshot on a settled async supercell — requires waiting until `supercell_generation === last_committed_generation` before snapshotting. The CLAUDE.md in `src/lib/structure/` documents the supercell `$effect` (~line 2300) as async with a generation counter to discard stale results. The trajectory-bypass-refactor-todo.md acknowledges: "Svelte 5 `$effect.pre` micro-flush behavior we still don't fully understand." Getting T2.1 wrong means snapshotting a mid-async topology — atoms at wrong positions, topology partially expanded — and that bug would be hard to reproduce (timing-dependent). Architecture P has no async coordination step. The position-write loop in Trajectory.svelte is synchronous and its correctness is local.

**Trade-offs accepted under Architecture P:**

- Supercell + trajectory playback is explicitly unsupported (LB1), where Architecture S would silently freeze supercell-extra atoms. Architecture P surfaces a UI message; S would silently display wrong positions. Architecture P is the correct trade-off.
- Charge label positions during trajectory are stale (W3 Q1) under both architectures, but Architecture P requires a targeted fix to `compute_charge_label_entries` that Architecture S does not (under S, StructureScene's `structure` prop is the snapshot which has correct topology; under P, it's the stable `displayed_structure` which also has correct topology — the fix is the same for both, but it's more visible under P since stale positions are more obviously wrong when nothing else is updating).

---

## What plan v3 looks like under the recommendation

This section replaces the T0–T7 phase sketch in `trajectory-bypass-refactor.md`. W1, W5, and W7 from the TODO doc are integration points.

---

### Phase 0 — Regression detector (W1)

**Description:** Build and validate the dev-mode regression detector before any structural changes. The detector must fire on the current patched code (commit `29420f91`) and go silent after Phase 4.

**Deliverable:**
- A `$effect` in Structure.svelte that watches `atom_data` identity (Svelte fires `$effect` when the `$derived`'s output changes — use a wrapper `$state` counter that the `$derived.by` increments via a side-effect-free mechanism in DEV). Alternative: a module-level `let __atom_data_fire_count = 0` incremented at the top of `atom_data $derived.by()` body, exposed on `globalThis.__catgo_probe` in DEV.
- Same counter for `build_bond_pairs $effect.pre` fires during playback.
- A probe function: `check_trajectory_cascade_silence()` that asserts both counters are zero after 5 seconds of playback.

**Verification:** Counters accumulate at ~60/sec during trajectory on `29420f91`. After Phase 4, counters are zero.

**Rollback condition:** If the detection mechanism causes false positives (firing during non-trajectory reactive updates), redesign before proceeding.

**Effort:** 2–3h

---

### Phase 1 — atom_manager lift (W4 Option A)

**Description:** Surface `atom_manager` from StructureScene to Structure.svelte as a `$bindable` prop. No behavior change.

**Deliverable:**
- `StructureScene.svelte:2218` — `const atom_manager = new AtomManager()` → `let { ..., atom_manager = $bindable(new AtomManager()) } = $props()` (add to props destructure at the component's props section)
- `Structure.svelte` — `let scene_atom_manager = $state<AtomManager>(new AtomManager())` (near line 169 where `scene_atom_fast_ops` is declared); `bind:atom_manager={scene_atom_manager}` added to `<StructureScene>` at line 3360
- `Trajectory.svelte` — `atom_manager: AtomManager | null = null` optional prop added
- `Structure.svelte` template — `{scene_atom_manager}` passed to `<Trajectory>` (wherever `<Trajectory>` is rendered)

**Verification (W7):** Trajectory playback unchanged on `29420f91` behavior baseline. W7 regression tests green. AtomManagerInstances behavior at mount unchanged.

**Rollback condition:** Any observable behavior change in AtomManagerInstances rendering, X5/X6 fast-path regressions, or TypeScript type errors in the `$bindable` prop signature.

**Effort:** 2–3h

---

### Phase 2 — Position-write loop in Trajectory.svelte

**Description:** Trajectory.svelte writes trajectory positions directly to `atom_manager.set_position` per frame, in addition to (not replacing yet) `current_structure` writes.

**Deliverable:**
- New `$effect` in Trajectory.svelte:
  ```
  $effect(() => {
    const mgr = atom_manager
    const traj = trajectory_frame_positions
    if (!mgr || !traj) return
    const overrides = realtime_position_overrides  // prop from Structure.svelte
    const max_slot = Math.min(mgr.count, traj.length / 3)
    for (let slot = 0; slot < max_slot; slot++) {
      const sid = mgr.site_ids_buffer[slot]
      if (overrides?.has(sid)) continue  // drag wins
      const base = sid * 3
      mgr.set_position(slot, traj[base], traj[base + 1], traj[base + 2])
    }
  })
  ```
- LB1 guard: `Math.min(mgr.count, traj.length / 3)` bound
- Drag-override guard: `if (overrides?.has(sid)) continue`
- Supercell detection: if `mgr.count > traj.length / 3` on first frame, emit a dev warning + set a UI message prop via callback

**Verification (W1 + W7):** W1 detector must remain silent (current `current_structure` write still runs; this is additive). W7 green. Both position update paths produce consistent GPU output.

**Rollback condition:** Position inconsistency between the new loop and the existing `current_structure` path, or W1 false positives.

**Effort:** 2–3h

---

### Phase 3 — Bond geometry fast-path

**Description:** Wire `build_trajectory_bond_pairs` for per-frame bond geometry from `trajectory_frame_positions`.

**Deliverable:**
- Extend `build_trajectory_bond_pairs` signature at `bond-computation-controller.svelte.ts` (the function body, currently dead): add `realtime_position_overrides: Map<number, Vec3> | null` parameter; for each bond endpoint, use `overrides?.get(idx) ?? [traj[idx*3], traj[idx*3+1], traj[idx*3+2]]`; guard `idx < traj.length / 3` to avoid supercell-index OOB
- Add branch in `build_bond_pairs $effect.pre` at `StructureScene.svelte:1552`: `if (trajectory_active && trajectory_frame_positions) { bond_pairs = build_trajectory_bond_pairs(bond_state.bond_connectivity, trajectory_frame_positions, realtime_position_overrides); return }`
- `trajectory_active` must be accessible to StructureScene — pass as a prop from Structure.svelte (it is already derived at `Structure.svelte:1114` as `$derived(trajectory_frame_positions != null)`)

**Verification (W1 + W7):** W1 detector silent. W7 bond-animation tests green. Bonds stretch/contract correctly per trajectory frame. Drag during playback produces consistent atom + bond positions.

**Rollback condition:** Bond geometry artifacts (elongated garbage bonds, bond flash on frame advance), W1 detector firing on bond-related effects.

**Effort:** 2–3h

---

### Phase 4 — Stop writing `current_structure` per frame (the pivot)

**Description:** Trajectory.svelte removes the `current_structure = frame.structure` write from the frame-advance loop. This is the architectural pivot: `displayed_structure` becomes quiescent during playback.

**Deliverable:**
- In Trajectory.svelte's frame-advance loop: remove `current_structure = frame.structure` (or gate behind `!trajectory_active` if current_structure is needed for pause-state logic — confirm via T5 analysis)
- After this change: the entire `cell_transformed_structure → supercell → PBC → displayed_structure` cascade stops running per frame

**Verification (W1):** W1 detector confirms `atom_data` and `build_bond_pairs` fire 0× during playback. CPU profiler shows ≤2ms/frame main thread JS. W7 regression tests green.

**Rollback condition:** W1 detector fires unexpected per-frame effects. W7 test failures.

**Effort:** 1h (change is small; verification via W1 is the substance)

---

### Phase 5 — Pause-and-edit handler (W2 + W5)

**Description:** When trajectory stops, write atom_manager positions back to structure so edits start from the correct frame. Implement resume-disable for structure-altering edits (W5).

**Deliverable:**
- `$effect` in Structure.svelte: when `trajectory_active` flips false (via `$effect(() => { if (trajectory_active) return; ... })`), read `scene_atom_manager.positions_buffer` + `site_ids_buffer` → build new `structure.sites` array → full object reassignment (`structure = { ...structure, sites: new_sites }`) per W2 contract
- `resume_disabled: boolean` prop on Trajectory.svelte (W5): Structure.svelte sets this true when a structure-altering edit occurs during pause; clear on new trajectory load
- UX: when `resume_disabled`, Trajectory.svelte's play button shows a tooltip: "Structure was edited — reload trajectory to resume"
- Resume path: on trajectory reload, clear `resume_disabled`

**Verification (W7):** "Pause → drag → resume" test green. "Pause → element-swap → resume-disabled message" test green. No stale-position silent bugs.

**Rollback condition:** W2 writeback failure (deep mutation doesn't propagate; symptom: atoms snap to pre-trajectory positions on edit), W7 failures.

**Effort:** 2–3h

---

### Phase 6 — Patch deletion (T6)

**Pre-condition (hard requirement):** W1 detector has been silent across the full W7 test matrix for at least one complete session. If the detector fired even once, Phase 6 is unsafe.

**Description:** Delete all five patch categories from the T6 list.

**Deliverable:**
- `bond-computation-controller.svelte.ts`: delete `freeze_connectivity_on_position_change` parameter (line 69) and the trajectory fast-path block (lines 100–117, the `|TRAJ` sentinel)
- `StructureScene.svelte`:
  - Delete `build_bond_pairs` memo state vars `__bbp_prev_*` (lines 1545–1551) — simplify memo comment to reflect only non-trajectory use
  - Delete X2 `trajectory_only` branch (lines 2339–2363) and `positions_only` branch (lines 2371–2395)
  - Delete trajectory-specific X2 memo vars (`__x2_prev_traj`, `traj_changed` logic) from lines 2249–2261
  - Delete `atom_data` fast-clone cache (`__atom_data_cache_*` vars, lines 1855–1875)
  - Delete all `[probe]` console.log statements, or consolidate behind a single `import.meta.env?.DEV && window.__catgo_debug_trajectory` flag
- `viewer-controller.svelte.ts`: delete `[probe]` debug logs in property_colors `$effect`
- `bond-worker-api.ts`: keep `is_bond_worker_ready()` and `prewarm_bond_worker()` (used by Phase 7)

**Verification (W1 + W7):** W1 detector still silent. W7 tests green. CPU profiler still ≤2ms/frame. `git diff --stat` vs `29420f91` shows net negative LOC.

**Rollback condition:** W1 detector fires after any deletion → immediately revert that specific deletion, not the whole phase. Investigate which patch was still load-bearing.

**Effort:** 1–1.5h

---

### Phase 7 — Worker prewarm (T7, I1)

**Description:** Prewarm bond Worker at app startup so first post-trajectory edit doesn't pay WASM init cost.

**Deliverable:** `prewarm_bond_worker()` call (already exported from `bond-worker-api.ts`) in Structure.svelte's `onMount` or equivalent early startup effect.

**Verification (W7):** First bond compute on fresh tab uses Worker path, not sync JS fallback. W7 "exit transition" test confirms no bond flash.

**Effort:** 0.5h

---

## Open questions for plan v3

1. **Supercell + trajectory scope decision.** The position-write loop restricts to `min(mgr.count, traj_positions.length / 3)` slots. For a 2×1×1 supercell, 50% of atoms freeze. Is the correct UX: (a) show a toast warning and play with frozen supercell-extra atoms, (b) disable trajectory play button entirely when supercell is active (`supercell_scaling !== '1x1x1'`), or (c) neither — accept frozen behavior silently? Option (b) is safest and most honest, but prevents a potentially valid use case (playing base-structure trajectories while a small supercell is enabled for visualization). Decision must be made before Phase 2 lands.

2. **`current_structure` write removal scope in Phase 4.** Does Trajectory.svelte use `current_structure` for anything other than the per-frame position update? Specifically: is `current_structure` used for trajectory load (first frame), for the frame-count display, or for pause-state determination? If `current_structure` is needed for non-performance-critical operations (e.g., one-time load of the trajectory's base topology into Structure.svelte's `structure` prop), the Phase 4 change must preserve those writes while eliminating only the per-frame position update.

3. **W1 regression detector mechanism.** The recommended approach is a module-level fire counter in `atom_data $derived.by()`. But `$derived.by()` is a pure computation — adding a side effect (incrementing `__atom_data_fire_count`) is technically valid in Svelte 5 (deriveds can read module-level non-reactive state) but may confuse future readers. Alternative: a wrapper `$effect` in Structure.svelte that watches `atom_data` identity via a `$state` version counter bumped by a separate tracking `$derived`. Decide the exact mechanism before Phase 0 is implemented; document the choice in the component.

4. **`build_trajectory_bond_pairs` index-space bug resolution.** The function at `bond-computation-controller.svelte.ts` currently uses `conn.site_idx_1 * 3` as an index into `trajectory_frame_positions`. `bond_state.bond_connectivity` entries have `site_idx_1` from the `displayed_structure` bond detection — for supercell structures, these can be up to 877 (2×1×1 of 439-atom base), but `traj_positions` only covers indices 0..438. For non-supercell structures, this is correct. The Phase 3 guard (`site_idx < traj_positions.length / 3`) would skip bonds between supercell atoms. Must decide: are bonds between supercell-extra atoms drawn at frozen initial positions, or skipped entirely during playback? The simplest answer is: use the initial position for out-of-range atoms (read from `atom_manager.get_x/y/z(slot)` instead of from `traj_positions`). This requires `build_trajectory_bond_pairs` to accept `atom_manager` as a parameter in addition to `traj_positions`.

5. **W2 `$bindable` writeback verification.** The T5 writeback performs full object reassignment: `structure = { ...structure, sites: structure.sites.map(...) }`. This is the correct pattern per CLAUDE.md for Svelte 5 `$bindable` propagation. But it must be verified in a minimal test: create a test component with `structure = $bindable()`, mutate via full reassignment, verify the parent's bound variable reflects the change. This test must pass before Phase 5 implementation begins. If it fails, the W2 alternative patterns (callback prop, dedicated "live trajectory positions" state) must be evaluated.

6. **Exit flash elimination.** After Phase 7 (worker prewarm), measure the duration of empty `bond_pairs` on trajectory exit. If the flash is perceptible (>1 render frame at 60fps ≈ 16ms), implement the "hold last bond_pairs until new ones arrive" pattern: save `const exit_bond_pairs = bond_pairs` before `trajectory_active → false`, continue passing `exit_bond_pairs` to the bond renderer until the worker callback provides new pairs. This is a small additive change to Phase 5 or Phase 7 but requires design before implementation.

7. **Charge label position fix scope (W3 Q1).** The v3 plan does not include a fix for stale charge label positions during trajectory. Should this be a separate work item (I5?), or must it land as part of Phase 3? The use case (Bader charge labels visible during MD trajectory playback) is valid for charge-density-based MD. Recommend: separate work item, not blocking Phase 3.

8. **`trajectory_active` prop threading.** Architecture P requires `trajectory_active` to be accessible inside StructureScene's `build_bond_pairs $effect.pre` (Phase 3). Currently `trajectory_active` is defined in Structure.svelte at line 1114 (`$derived(trajectory_frame_positions != null)`). StructureScene already receives `trajectory_frame_positions` as a prop (`Structure.svelte:3362`). Phase 3 can derive `trajectory_active` inside StructureScene from the existing `trajectory_frame_positions` prop rather than threading a new boolean prop: `const trajectory_active = $derived(trajectory_frame_positions != null)`. Confirm this is the preferred pattern.

---

## Decision log

1. **The W3 audit changed the framing of reviewer finding #3.** The original finding named "charge labels, bond edit cleanup, possibly export pane, AtomLegend" as the per-frame sibling consumers that Architecture S fails to freeze. W3 found the export pane reads base `structure` (not `displayed_structure`) at `Structure.svelte:3166`, pencil-mode is EVENT-ONLY, and AtomLegend `has_charges` short-circuits immediately for trajectories without Bader charges. The real per-frame cascade outside StructureScene is two O(1) `$derived` calls in Structure.svelte. This makes reviewer #3's concern less severe in practice — but it remains a pattern concern, and the pattern argument is the decisive one for recommending P over S.

2. **The X2 `trajectory_only` branch is a prototype of Architecture P's write loop, already in StructureScene.** The branch at `StructureScene.svelte:2339` does exactly: `for slot in 0..mgr.count { sid = site_ids[slot]; mgr.set_position(slot, traj[sid*3], ...) }`. Architecture P moves this loop to Trajectory.svelte and deletes the branch. The fact that this exact pattern already exists and is measured at ~1–2ms/frame for 878 atoms is strong evidence that Architecture P's per-frame cost is known-good.

3. **`align_on_load` (W8) appears already fixed.** `Structure.svelte:1119` shows `|| trajectory_active` in the `align_on_load $effect` guard, which was added in the current branch. The W8 work item in the TODO doc lists this as unaddressed, but the code suggests it was fixed as part of the atom-soa-refactor work. Phase 6 should verify this explicitly and close W8 as resolved.

4. **Architecture P's "stop writing `current_structure`" is Phase 4, not Phase 1.** The initial instinct was to make stopping `current_structure` writes the first step. But stopping it before the position-write loop (Phase 2) and bond fast-path (Phase 3) are in place would break trajectory playback entirely — atoms wouldn't move. The sequencing (Phase 2 and 3 first, then Phase 4 stops the old path) is critical. This is documented as "Phase 2 is additive" in the Phase 2 note.

5. **The `build_bond_pairs` memo cannot be fully deleted under Architecture P.** Under Architecture P, `build_bond_pairs $effect.pre` still fires during drag (`realtime_position_overrides` changes), selection changes (`selected_sites` changes), and topology changes. The memo's value is absorbing Svelte over-fires for all those cases, not just trajectory. The Phase 6 deletion scope is narrowed to: delete trajectory-specific reasoning from the memo comment; keep the memo structure. The net LOC reduction is smaller than initially estimated for this patch category.

---
