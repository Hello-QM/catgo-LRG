# Trajectory Bypass Refactor (T-series) — v2 (SUPERSEDED)

**Status:** SUPERSEDED by `plans/trajectory-bypass-refactor-v3.md` (2026-04-26)
**Branch:** `atom-soa-refactor` (commit `29420f91` is the patch-baseline; this refactor would unwind the patches as it lands)
**Owner:** Jenedith
**Created:** 2026-04-25
**Revised:** 2026-04-25 — v2 addressed 10 findings from v1 review; v2 itself then surfaced 8 new findings via second review (see § "Why this plan is paused")
**Superseded:** 2026-04-26 — v3 adopts Architecture P (position-only-write) per `plans/W6-architecture-decision.md`. v3 integrates W1-W8 outputs and resolves all 8 v2 outstanding findings. This v2 document is preserved for historical reference; do NOT implement from it.
**Companion:** see `plans/trajectory-bypass-refactor-todo.md` for the W-item resumption checklist (now complete) and `plans/trajectory-bypass-refactor-v3.md` for the canonical implementation plan.

---

## Why this plan is paused

Two thorough review rounds (v1 → v2 → second review of v2) surfaced architectural-level issues that exceed what can responsibly be designed and implemented in a single session:

**v2 has 5 high-severity unresolved issues** identified by the second reviewer (full list in § "Outstanding v2 issues" below):

1. **T2.3 dev-mode assertion is unimplementable as described.** The proposed mechanism — adding a `console.warn` inside the `atom_data $derived` body when `trajectory_active === true` — doesn't work because `$derived` is a pure function with no access to parent state, and after T3 lifts atom_manager out, StructureScene may not even receive `trajectory_frame_positions` as a prop. The safety gate for T6 (delete patches) needs a fundamentally different design.

2. **T5 writeback to `structure.sites[i].xyz` is a deep mutation that won't propagate** through `$bindable` props in Svelte 5. Need full structure object reassignment instead. As written, the pause-and-edit handler would silently fail to write back trajectory positions.

3. **`displayed_structure` is consumed by sibling components** (charge labels, bond edit cleanup, possibly export pane), not just StructureScene. The snapshot mechanism only freezes what StructureScene sees — siblings still cascade per frame. Asymmetric reactive state = bugs.

4. **T0 LB1 hotfix proposed in v2 is wrong.** The `0..min(mgr.count, len/3)` truncation doesn't fix the bug because slots aren't ordered by site_id. (Investigation in this session showed LB1 is actually NOT shipping — the existing length check already guards it. But the v2 plan would have led to a non-fix.)

5. **Lifting atom_manager breaks X5/X6 incremental fast-path hooks** (`try_delete`, `try_add`, `try_replace`, `try_move`) that capture StructureScene-local state (radii, colors, property_colors). Either lift the hooks too (breaks the GPU/scene separation) or atom_manager lift is incomplete. T3 (D1) is at least 2× the work originally scoped.

The implication: the snapshot-based bypass design (v2's core mechanism) has correctness gaps. A simpler position-only-write pivot was sketched as plan v3 but never fully validated.

**Decision (this session):** stop iterating in-session. The patches in commit `29420f91` ship the perf gain (340ms → 18ms per frame for trajectory). The proper refactor is moved to a longer working window with multi-session design iteration. See `plans/trajectory-bypass-refactor-todo.md` for the work breakdown to resume this plan responsibly.

---

## Outstanding v2 issues (reviewer findings, full list)

From second review of plan v2:

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | HIGH | T2.3 dev-mode assertion is unimplementable as described — `$derived` can't observe parent state | Unaddressed |
| 2 | HIGH | T5 writeback to `structure.sites[i].xyz` won't propagate through `$bindable` deep mutation | Unaddressed |
| 3 | HIGH | `displayed_structure` consumed by sibling components — snapshot only freezes StructureScene | Unaddressed |
| 4 | HIGH | T0 LB1 fix is wrong (slots not ordered by site_id); investigation shows LB1 not shipping (existing length check guards it) | Investigated this session — see § LB1 below |
| 5 | HIGH | Lifting atom_manager breaks X5/X6 incremental fast-path hooks | Unaddressed |
| 6 | MED | T5 "disable resume after edits" has no wire-up path in Trajectory.svelte | Unaddressed |
| 7 | MED | T5 writeback inherits T3.1 cascade risk via `atom_manager.version++` | Unaddressed |
| 8 | LOW | `align_on_load` $effect fires per trajectory frame; not idempotent | Unaddressed |

From first review of plan v1 (status from v2):

| # | Severity | Finding | v2 Status |
|---|---|---|---|
| v1.1 | HIGH | Async supercell race in T2 snapshot | Addressed in T2.1 |
| v1.2 | MED | Missing `undefined` guard in T2 | Addressed in T2.2 |
| v1.3 | HIGH | Pause-and-edit case has no implementation path | T5 created — but T5 itself has issues 2/6/7 above |
| v1.4 | MED | D1 premise wrong (bond_manager not lifted) | Acknowledged in revised D1 — but issue 5 exposes deeper problem |
| v1.5 | HIGH | LB1 supercell index-space mismatch | T0 created — but T0 fix wrong (issue 4); investigation shows guard exists |
| v1.6 | LOW | AtomImpostors still in plan | Resolved (deleted from plan) |
| v1.7 | MED | Drag-during-playback overlap | Addressed in T3 + T4 signature change |
| v1.8 | HIGH | Over-fire source not proven eliminated | T2.3 added but issue 1 makes it unimplementable |
| v1.9 | LOW | Stale `Structure.svelte:6928` reference | Removed |
| v1.10 | MED | Hidden subscribers (hbond, align_on_load, vibration, exit flash) | Listed in T1 audit — issue 8 exposes one of these is real shipping cost |

## LB1 investigation (this session)

The reviewer flagged LB1 as a shipping bug: the X2 trajectory fast-path indexes `traj_positions[sid * 3]` where `sid` can exceed `traj_positions.length / 3` for supercell or PBC-expanded structures.

**Investigation result:** the bug is GUARDED in shipped code by the existing length check at `StructureScene.svelte:2335`:

```ts
&& traj_positions.length >= sites.length * 3
```

For supercell 2×1×1 on 439-atom base: `sites.length === 878` (displayed), `traj_positions.length === 1317` (base × 3). Check: `1317 >= 2634` → FALSE → trajectory_only skipped → falls through to `positions_only` path which reads from `sites[sid].xyz` (supercell-correct because upstream pipeline propagates trajectory positions through supercell expansion).

**Action taken:** added an explanatory comment at the X2 fast-path call site documenting the guard's purpose so future maintainers don't accidentally remove it. No functional code change required.

**Note:** the dead `build_trajectory_bond_pairs` function in `bond-computation-controller.svelte.ts` DOES have the index-space bug (uses `conn.site_idx_1 * 3` from displayed-structure-indexed connectivity against base-structure-indexed positions). It is never called, so no shipping bug. But if the bypass refactor wires it in (T4), the bug becomes live. Future plan must either fix the function signature (accept a base→displayed index map) or restrict its use to non-supercell, non-PBC-image cases.

---

## Problem

Trajectory playback on 878-atom structures was running at 3-5 fps before patches; ~40-75 fps after a stack of memos and fast-paths. The patches work but they're papering over a fundamental design issue: **trajectory positions flow through the same code path as a structure edit**, which means every frame triggers:

```
Trajectory.svelte: current_structure = frame.structure
                   trajectory_frame_positions = position_cache[i]
        ↓ (Svelte propagates new structure ref)
Structure.svelte: cell_transformed_structure $derived re-runs       (~0.5ms)
                  supercell $effect re-runs (async, even when no-op) (~ms wasted)
                  PBC $effect re-runs                                (allocates new sites)
                  displayed_structure = ...                          (new ref)
        ↓ (StructureScene's `structure` prop changes)
StructureScene: atom_data $derived re-runs                          (~6-15ms)
                compute_bond_connectivity $effect.pre re-runs       (~6-13ms)
                build_bond_pairs $effect.pre re-runs (40+× via cascade) (~250ms)
                X2 shadow sync $effect re-runs (×2, slow + fast path) (~14-22ms)
```

Each step is repeating work that doesn't change frame-to-frame: topology, colors, radii, plugins, bond connectivity. **Only positions change.** The current architecture has no concept of a "position-only update" — everything is modeled as a structure swap.

## Architectural Goal

Treat trajectory positions as a **position override channel** parallel to `realtime_position_overrides` (the existing drag-override pattern). The base `structure` stays frozen during playback; positions stream into `atom_manager` via `set_position` and into bond geometry via the already-existing-but-unused `build_trajectory_bond_pairs`. Downstream effects (`atom_data`, `compute_bond_connectivity`, `build_bond_pairs`, X2 shadow sync) **do not fire during playback** — there's nothing for them to recompute.

## Pre-existing latent bug discovered during review

**LB1 (high severity):** `position_cache[i]` in `Trajectory.svelte` is indexed by **base structure** `site_idx`, but `bond_connectivity` is built from `displayed_structure` (which has supercell + PBC image atoms with their own indices). The current X2 trajectory fast-path (commit `29420f91`) does `mgr.site_ids_buffer[slot] * 3` — which is wrong when the user plays a trajectory on a non-trivial supercell or with PBC images visible. The atoms snap to garbage positions for indices ≥ base structure length.

This bug exists in the patches we just shipped. It needs a hotfix or scope-clarification (do we support trajectory + supercell at all?) BEFORE the bypass refactor, since the refactor inherits the same index space.

**Action:** T0 (new phase, below) audits LB1 and either fixes it or documents the supported scope.

## Success Criteria

1. **Per-frame cost during 878-atom trajectory playback: ≤2ms of JS** (excluding GPU buffer upload). Today's patched cost is 13-25ms.
2. **`atom_data`, `build_bond_pairs`, `X2 shadow sync` fire 0× per trajectory frame**, verified via dev-mode `console.assert` instrumentation that survives until T6.
3. **All patches deleted in T6**: bond freeze flag, build_bond_pairs memo, X2 trajectory fast-path, X2 positions-only fast-path, atom_data fast-clone cache. **Pre-condition for T6:** the dev-mode assertions in T2/T3/T4 have been silent across the verification matrix.
4. **No visual regression**: trajectory feels identical, pause-and-edit works, exit returns to fully interactive state, camera/orbit unchanged.
5. **No stale-state bugs**: paused frame N's positions match interactive-mode positions exactly. Exit transition does not flash empty bonds (mitigates exit-recompute regression).
6. **Worker bond detection prewarms during initial load** so the first user-triggered structure edit doesn't pay 100-300ms of WASM init.
7. **LB1 resolved**: trajectory + supercell either works correctly OR is explicitly disabled with a user-facing message.

## Non-Goals

- WASM-Worker-based per-frame bond *connectivity* re-detection for reactive MD. (Future work; today bonds are frozen during playback, which is correct for normal NVT/NPT MD.)
- Retiring `AtomImpostors` (the legacy renderer). The X3 plan covers retirement separately. **Confirmed by review: `USE_NEW_ATOM_SYSTEM = true` already gates AtomImpostors off in normal use.** T5 in v1 of this plan is now deleted.
- Trajectory force-vector rendering changes.
- Refactoring the cell_transform / supercell / PBC pipeline itself. We bypass it during playback; we don't change it.

## Phase Plan

Each phase is independently testable and reversible. T0 audits the supercell bug; T1 audits remaining open questions; T2 lands the snapshot; T3 wires positions; T4 wires bond geometry; T5 handles pause/edit; T6 unwinds the patches; T7 prewarms the Worker.

### T0. Supercell index-space audit (LB1) — 1-2 hours

**What:** Determine whether trajectory + supercell currently produces correct positions, or wrong positions, or is somehow protected.

- (a) Read `Trajectory.svelte:340-440` (position_cache build). Confirm `position_cache[i]` is indexed by frame.structure.sites order. Capture the actual expression that writes it.
- (b) Read `Structure.svelte` to see whether `current_structure` from Trajectory bypasses or includes the supercell+PBC pipeline. If trajectory's frame.structure is the BASE (single cell) and supercell expansion happens downstream per-frame, then the supercell expansion creates extra sites whose positions are NOT in `position_cache[i]`. If trajectory's frame.structure is ALREADY supercell-expanded by the trajectory loader, then `position_cache[i].length / 3 === displayed_structure.sites.length` and we're fine.
- (c) Inspect the X2 fast-path loop in StructureScene (line ~2338): `const sid = site_ids[slot]; mgr.set_position(slot, traj[sid*3], ...)`. With supercell on, `site_ids[slot]` reaches values beyond `position_cache[i].length / 3`. Add a one-shot console.warn behind DEV that logs the max sid and the position_cache length on the first trajectory frame — confirm or refute the bug empirically.
- (d) Test on a real supercell + trajectory (load any MD trajectory, set supercell to 2×1×1, play one frame). Document what happens.

**Decision tree:**
- If trajectory + supercell was never supported (no UI path to enable both): document this restriction in CLAUDE.md and the trajectory UI; the bypass refactor inherits the same restriction.
- If trajectory + supercell IS reachable today and the bug bites: fix the X2 fast-path indexing first (separate commit, before T2). Probably the right fix is iterating `0..min(mgr.count, position_cache_length / 3)` and falling through to slow path for the rest, OR throwing an explicit error so the bug isn't silent.
- If somehow it works (e.g., position_cache is sized to displayed_structure): document why and proceed.

**Output:** A subsection in this plan (§T0 Findings) before T1 starts. T2-T6 must reference T0 findings when designing index-space-sensitive code (T3 set_position loop, T4 build_trajectory_bond_pairs).

### T1. Audit remaining open questions (1 hour, zero code changes)

**What:** Confirm assumptions before T2 wiring.

- (a) ✅ **Resolved by review:** `USE_NEW_ATOM_SYSTEM = true` (feature-flag.ts line 28) gates the renderer. AtomImpostors is in the `{:else}` branch and not active. T5 from v1 is deleted.
- (b) Drag-during-playback: search for `external_dragging` and `realtime_position_overrides` usage in Trajectory.svelte and Structure.svelte. Determine if there's an existing gate that disables one when the other is active. Document the actual UX intent.
- (c) Vibration-during-playback: same audit for `vibration_data`. Probably nobody enables both, but confirm.
- (d) `compute_hbond_connectivity` (StructureScene line ~1594) reads `structure` and `bond_pairs` — confirm what its position source becomes after T2's snapshot. H-bond geometry will freeze at frame-0 if not addressed; decide whether to (i) accept that for v1 of bypass, (ii) extend `build_trajectory_bond_pairs` to also rebuild h_bond_pairs, or (iii) leave hbonds disabled during playback with a UI note.
- (e) `align_on_load` $effect in Structure.svelte — confirm the `structure_aligned_id` guard prevents re-fires during trajectory. If not, the $effect itself is a hidden cost during playback.
- (f) `position_cache` indexing — already covered by T0.
- (g) Buffer-size assumptions — search StructureScene for uses of `displayed_structure.sites.length` or `structure.sites.length` to size buffers. Confirm none assume per-frame growth (i.e., no buffer is reallocated as a function of trajectory frame data, only as a function of topology).

**Output:** A subsection in this plan (§T1 Findings).

### T2. Add `trajectory_active` signal + topology snapshot — 3-4 hours

**What:** Single source of truth for "is trajectory playing", and a frozen structure prop downstream.

- Add `let trajectory_active = $derived(trajectory_frame_positions != null)` to Structure.svelte (single source of truth, addresses D4).
- Add `let __topology_snapshot: AnyStructure | null = $state(null)`.
- Add `$effect`: when `trajectory_active` flips false→true AND `displayed_structure` is non-null AND any in-flight async supercell has resolved (use the existing `supercell_generation` counter to confirm the latest write has landed — see T2.1 below), snapshot `displayed_structure` into `__topology_snapshot`. When it flips true→false, defer to T5's pause-and-edit handler.
- Pass `__topology_snapshot ?? displayed_structure` as the `structure` prop to `<StructureScene>`. Important: also handle `__topology_snapshot === undefined` AND `displayed_structure === undefined` → don't crash.
- During trajectory, `current_structure` writes from Trajectory.svelte still propagate through `cell_transformed_structure → supercell → PBC → displayed_structure` (their effects fire). But StructureScene only sees the frozen snapshot, so its downstream effects don't re-fire.

**Open work item T2.1: gate the snapshot on a settled async supercell.** The supercell `$effect` (~Structure.svelte line 2300) is async with a generation counter — `supercell_generation`. The snapshot effect must wait until `supercell_generation === last_committed_generation`. Concretely: read both inside the snapshot effect, only proceed when they match. If they don't, set a one-shot retry (e.g., `requestAnimationFrame(retry)`) until they do. This prevents capturing a stale pre-WASM state when trajectory_active flips during a supercell rebuild.

**Open work item T2.2: undefined guard.** The snapshot effect must not write `__topology_snapshot = undefined`. If `displayed_structure` is undefined at the moment trajectory_active flips true, set a one-shot retry (same as T2.1). Until the snapshot is set, downstream still sees `displayed_structure ?? __topology_snapshot` (note: order swapped — fall back to live structure if snapshot is null). Once snapshot lands, swap the precedence.

**Open work item T2.3: dev-mode assertion.** Add behind `import.meta.env?.DEV` a `console.warn` that fires if `atom_data $derived` or `build_bond_pairs $effect.pre` re-runs while `trajectory_active === true`. This is the regression detector — if it stays silent across the verification matrix, T6 is safe. If it fires, the cascade source isn't actually eliminated and the patches we want to delete are still load-bearing.

**Exit criteria:** With T2 alone (no T3/T4), atoms freeze in place during trajectory playback. The dev-mode assertion stays silent. **Note on intermediate state:** T2 ships a partial regression (frozen atoms during playback). To avoid leaving the branch in a broken state across sessions, T2 and T3 land in a single commit (or T2 lands behind a feature flag that defaults off until T3 is also in).

### T3. Direct trajectory → atom_manager position writes — 3-4 hours

**What:** Trajectory positions flow directly into the atom_manager's position buffer, bypassing structure entirely.

**Decision D1 revised:** Lift `atom_manager` from StructureScene to Structure.svelte.
- Note from review: `bond_manager` is currently NOT lifted to Structure.svelte; it's local to StructureScene. So this IS a new pattern, not a mirror. But it's the right call because Trajectory.svelte (a sibling of StructureScene under Structure.svelte) needs to write to it.
- **Coordinated change:** the X2 shadow sync `$effect` (currently in StructureScene line ~2280) stays where it is, but receives `atom_manager` as a prop instead of constructing it locally. The X2 effect remains the sole writer for full topology changes; T3 adds Trajectory as a position-only writer.
- Pass `atom_manager` to BOTH `<StructureScene>` (existing consumer) AND `<Trajectory>` (new consumer).

**Wire-up:**
- New `$effect` in Trajectory.svelte (or in Structure.svelte triggered by trajectory positions): when `trajectory_frame_positions` changes, iterate `atom_manager.site_ids_buffer` and call `set_position(slot, x, y, z)` from the Float32Array.
- **Index-space safety per T0:** the loop must respect `min(mgr.count, traj_positions.length / 3)`. Slots beyond the position cache length keep their last position (or are flagged as supercell-extra-atoms — T0 decides).
- **Drag precedence (addresses critique #5/#7):** before `set_position(slot, x, y, z)`, check if `realtime_position_overrides.has(site_id)`. If so, skip the trajectory write for that slot — drag wins. Document this precedence in a comment.
- Consider adding a `bulk_set_positions(positions: Float32Array, site_id_offset: number)` method to AtomManager if per-call overhead measurably matters; otherwise keep the per-slot loop.

**Open work item T3.1: atom_manager.version cascade.** Per review, `set_position` increments `atom_manager.version` and bumps a per-slot dirty mask. If any `$effect` or `$derived` in StructureScene reads `atom_manager.version` (intended for AtomManagerInstances render path), that effect fires per-frame. **Action:** grep for `atom_manager.version` and confirm all readers are render-only (and intentionally per-frame). Any non-render reader is a hidden cascade source.

**Exit criteria:** Atoms move smoothly per frame in `AtomManagerInstances`. Dev-mode assertion from T2 stays silent (no atom_data / build_bond_pairs re-fires). T2 + T3 commit together to avoid broken intermediate state.

### T4. Bond geometry fast-path — 2-3 hours

**What:** Wire the dead `build_trajectory_bond_pairs` function into the bond render path so bond_pairs update per frame from the Float32Array, not from the (frozen) structure.

- In Structure.svelte (or wherever `bond_pairs` is computed), add a branch: when `trajectory_active`, call `build_trajectory_bond_pairs(bond_state.bond_connectivity, trajectory_frame_positions, realtime_position_overrides)`. Otherwise call the existing `build_bond_pairs`.
- **Extend `build_trajectory_bond_pairs` signature** (currently `(connectivity, positions) → BondPair[]`) to accept `realtime_position_overrides: Map<number, Vec3> | null` so drag-during-playback works. Per-bond endpoint position lookup: `realtime_position_overrides?.get(idx) ?? trajectory_frame_positions[idx*3..idx*3+3]`. Mirrors the existing `build_bond_pairs` precedence chain (line ~233).
- Bond connectivity stays frozen (already correct via current freeze flag — but the freeze flag becomes redundant once T3+T4 are in place because `compute_bond_connectivity` won't fire at all during playback).
- Make sure `BondManagerInstances` consumes the new `bond_pairs` reactively. **Likely no change required** since the bond_pairs $state is the same — only the producer changes.
- **Index-space safety per T0:** if T0 confirms position_cache is base-structure-indexed but bond_connectivity is displayed-structure-indexed, this function ALREADY contains the bug. T4 must include a fix or explicit fail-fast.

**H-bond handling per T1.d:** if T1.d decides H-bonds should also follow trajectory positions, replicate the pattern with `build_trajectory_hbond_pairs` (new function) and wire it for `h_bond_pairs`.

**Exit criteria:** Bonds stretch/contract correctly per trajectory frame. Drag during playback produces visually consistent atom + bond positions. Dev-mode assertion stays silent.

### T5. Pause-and-edit handler — 2 hours

**What:** When the user pauses trajectory and starts editing (drag, atom move, element swap), the current trajectory frame's positions must become the "live" structure positions so edits land on the right base state.

- New `$effect` in Structure.svelte: when `trajectory_active` flips true→false AND `__topology_snapshot !== null`, perform a one-time sync:
  - Read current positions from `atom_manager` (via `mgr.get_x/y/z(slot)` or `mgr.positions_buffer`).
  - For each base structure site, write the corresponding atom_manager position back into `structure.sites[i].xyz`. (Must respect supercell+PBC: only write back to base sites; supercell-derived positions get re-derived through the pipeline normally.)
  - Clear `__topology_snapshot`.
  - Don't fire `compute_bond_connectivity` here — let the next reactive cycle handle it naturally.
- **Edge case:** if user resumes playback without editing, the next `trajectory_active` true triggers a fresh snapshot of `displayed_structure` (which now reflects the paused frame). Frame 0 of resumed playback writes the same positions as the paused state — no jump.
- **Edge case:** if user adds/deletes atoms during pause, `structure.sites.length` changes. `position_cache` is sized for the original sites count. On resume, `trajectory_frame_positions` won't match the new structure size. **Decision:** disable resume-after-add/delete (clear trajectory) OR rebuild position_cache lazily (slow). v1: disable resume after structure-altering edits, surface a UI message. v2: TBD.

**Exit criteria:** Pause → drag → resume works smoothly. Pause → edit element → playback disables with a clear message. No silent stale-state bugs.

### T6. Delete the patches — 1 hour

**Pre-condition (hard requirement):** the dev-mode assertion from T2.3 has stayed silent across the full verification matrix (§ Verification Plan). If it has fired even once, T6 is unsafe — investigate and fix the cascade source before deleting.

**What:** Remove every defensive memo and fast-path now made unnecessary. The reactive graph either does work or doesn't — no in-betweens.

Files & lines to delete (from commit `29420f91`):

- `bond-computation-controller.svelte.ts`:
  - Delete the `freeze_connectivity_on_position_change` parameter (T3+T4 mean compute_bond_connectivity won't fire at all during playback)
  - Delete the entire trajectory-fast-path block (the `|TRAJ` sentinel)
  - Restore `compute_bond_connectivity` signature to its pre-patch shape
  - Delete the `[probe]` debug logs
- `StructureScene.svelte`:
  - Delete `build_bond_pairs` memo guard (the `__bbp_prev_*` lets and the stable-input early return)
  - Delete `X2 shadow sync` memo + trajectory-fast-path + positions-only-fast-path (the `__x2_*` lets and both fast-path branches)
  - Delete `atom_data` fast-clone cache (the `__atom_data_cache_*` lets and the fast-path block)
  - Delete the `[probe]` debug logs (or keep ONE behind a single env flag for ongoing perf monitoring)
  - Update the trajectory_frame_positions prop forwarding if needed
- `viewer-controller.svelte.ts`:
  - Delete the `[probe]` debug logs in property_colors $effect
- `bond-worker-api.ts`:
  - Keep `is_bond_worker_ready()` and `prewarm_bond_worker()` — used by T7

**Exit criteria:** No patch-shaped code remains. `git log -p` shows net negative LOC vs commit `29420f91`. Trajectory playback still hits ≤2ms/frame.

### T7. Worker bond prewarm — 30 min

**What:** Call `prewarm_bond_worker()` once at app startup so the first structure edit (post-trajectory or otherwise) doesn't pay the 100-300ms WASM Worker init cost.

- Add `prewarm_bond_worker()` call in Structure.svelte's onMount or equivalent.
- Verify no regression on first bond compute (worker is ready by the time it's needed).

**Exit criteria:** First bond compute on a fresh tab is instant via the Worker, not via fallback paths.

## Risks & Mitigations (revised)

| Risk | Mitigation |
|---|---|
| Trajectory snapshot freezes wrong topology (mid-async-supercell capture) | T2.1: gate snapshot on `supercell_generation === last_committed_generation`. Use rAF retry until settled. |
| Snapshot or displayed_structure undefined at flip moment | T2.2: rAF retry until both non-null. Until snapshot lands, fall back to live structure (precedence reversed). |
| Pause-and-edit shows stale topology | T5: explicit pause→sync handler writes atom_manager positions back into structure.sites and clears the snapshot. |
| Add/delete atoms during pause breaks resume | T5 v1: disable resume after structure-altering edits, with UI message. |
| Drag-during-playback: atom and bond positions disagree | T3: drag override > trajectory positions for atom_manager writes. T4: extend `build_trajectory_bond_pairs` signature with overrides. |
| `atom_manager.version++` triggers cascade we didn't account for | T3.1: grep all readers; ensure they're render-only (intentional per-frame). |
| Removing the bond freeze flag in T6 reintroduces 150ms recompute on stop/start of playback | After T3+T4, `compute_bond_connectivity` doesn't see structure changes during playback. On exit, ONE recompute fires (worker, not sync JS, after T7). Acceptable. |
| Hidden state still triggers cascades (Map mutations, version bumps) | T2.3: dev-mode assertion catches `atom_data` / `build_bond_pairs` re-fires during playback. T6 is gated on assertion silence across full verification matrix. |
| H-bond pairs freeze at frame-0 during playback | T1.d decides: accept frozen, extend with `build_trajectory_hbond_pairs`, or disable hbonds during playback. |
| Vibration-during-playback overlap | T1.c audits. Likely never simultaneous; if so, document and skip. |
| `align_on_load` $effect re-fires per trajectory frame | T1.e audits. If `structure_aligned_id` guard prevents the actual write, accept the cheap $effect re-fire. If not, add a `trajectory_active` gate. |
| Exit transition: bond_state goes to [] during async recompute, brief bond flash | Post-T7 the worker is fast (~5ms). Verify the flash is imperceptible. If not, hold last bond_pairs until new ones arrive. |
| Trajectory + supercell index-space mismatch (LB1) | T0 audits and fixes/documents BEFORE T2 starts. |
| Renderer dual-path: AtomImpostors trajectory regression | Resolved by review: `USE_NEW_ATOM_SYSTEM = true` makes AtomImpostors inactive. T5 in v1 is deleted. |

## Verification Plan

After T1-T7 land, manually verify in browser dev:

1. Load 878-atom MD trajectory → play → CPU graph during playback should show <5% main thread JS.
2. **Dev assertion silence**: console contains no "atom_data fired during trajectory" or "build_bond_pairs fired during trajectory" warnings across the entire test matrix below.
3. Pause mid-playback → click an atom → context menu shows correct atom (not stale frame-0).
4. Pause mid-playback → drag an atom → atom moves smoothly. Resume playback → atom returns to trajectory path (drag override cleared).
5. During playback → toggle hide-element → atoms hide correctly, no crash.
6. During playback → change coloring mode (element → coordination) → colors update, no crash.
7. Pause mid-playback → change element → resume disabled with clear UI message.
8. Stop playback → bonds re-detect once via Worker (not 150ms sync JS), no visible flash.
9. Repeat playback start/stop 10× → no memory growth (snapshot doesn't leak).
10. **Trajectory + supercell**: per T0 outcome, either it works (verified visually) or it's blocked by an explicit error.
11. Trajectory with H-bonds enabled: per T1.d outcome, either H-bonds follow positions or are disabled-with-message.

## Decision Points (resolve before T2 starts)

- [ ] **D1**: Lift `atom_manager` from StructureScene to Structure.svelte? **Recommendation: yes** (T3 needs it). Note: this is a NEW pattern, not a mirror of bond_manager (which stays local to StructureScene).
- [ ] **D2**: Snapshot `displayed_structure` at playback start, OR snapshot at trajectory load? **Recommendation: at playback start** with the T2.1/T2.2 settled-state gates.
- [ ] **D3**: Drag override > trajectory positions? **Recommendation: yes** (covered in T3 + T4).
- [ ] **D4**: Single boolean `trajectory_active` lives in Structure.svelte. ✅ (resolved in revised T2).
- [ ] **D5**: Delete `build_trajectory_bond_pairs` after refactor? **Recommendation: keep** — small, useful, will be wired in T4.
- [ ] **D6** (NEW): Trajectory + supercell scope? Resolved in T0.
- [ ] **D7** (NEW): H-bonds during playback? Resolved in T1.d.

## T0 Findings

*Filled in during T0, before T1 starts.*

## T1 Findings

*Filled in during T1, before T2 starts.*

---

**Estimated total effort:** 13-17 hours across 2-3 working sessions.
**Net LOC change:** Negative — patches deleted in T6 outweigh new wire-up code.
**Reversibility:** Each phase is independently revertable. Worst case: revert to commit `29420f91`. T2+T3 land together to avoid broken intermediate state.

## Changes from v1

- Added §"Pre-existing latent bug discovered during review" (LB1) and new T0 phase
- T2 split into T2 (snapshot) + T2.1 (settled-state gate) + T2.2 (undefined guard) + T2.3 (dev-mode assertion)
- New T5 phase for pause-and-edit handling
- Old T5 (AtomImpostors trajectory) deleted — confirmed gated off by `USE_NEW_ATOM_SYSTEM`
- D1 corrected: bond_manager is NOT lifted; atom_manager lifting is a new pattern
- T3 adds T3.1 (atom_manager.version cascade audit) + drag-precedence requirement
- T4 extends `build_trajectory_bond_pairs` signature with overrides parameter
- T6 hard-gated on T2.3 dev-mode assertion silence
- New decision points D6 (supercell scope) and D7 (H-bonds)
- Stale `Structure.svelte:6928` reference removed
- Risks table expanded with all critique findings
