# W6 Review — Recommendation Soundness (Reviewer 1)

**Reviewing:** `plans/W6-architecture-decision.md`
**Branch:** atom-soa-refactor @ bd0da10f
**Reviewer angle:** Adversarial bug-hunt of the Architecture-P recommendation.

---

## Verdict: SHIP-WITH-CHANGES

Architecture P is directionally correct. The asymmetric-state argument is sound, the "5 of 5 patches deleted" advantage is real, and avoiding the async settled-state gate (T2.1) is a legitimate risk reduction. However, the recommendation rests on a W3 audit that missed two significant `structure`-reading deriveds in StructureScene, and Phase 3's bond fast-path proposal is wired to the wrong bond rendering system. These are fixable, but they must be addressed before plan v3 can be implemented as written.

---

## HIGH — Issues that could block or break the implementation

### H1. W3 missed `atom_positions_buffer` and `atom_colors_buffer` — two unlisted O(N) per-frame consumers

**W3's summary table claims "Total consumers: 20."** This is incomplete.

At `StructureScene.svelte:2756` (`atom_positions_buffer`) and `StructureScene.svelte:2771` (`atom_colors_buffer`):
- Both `$derived.by(() => { const sites = structure?.sites; ... new Float32Array(sites.length * 3) ... })`
- Both read `structure?.sites` directly (not through `atom_data`)
- Both allocate a new `Float32Array` on every derivation
- Both feed `BondManagerInstances` at line 3595
- Neither appears in W3's 20-consumer table

**Impact on the recommendation:**
- Both go quiescent under Architecture P (`structure` doesn't change per frame). So neither finding undermines P's superiority.
- BUT W6's claim "W3 found 0 CRITICAL-LIVE consumers, so nothing genuinely needs live `displayed_structure`" is cited as primary evidence. If the audit missed 2 consumers, confidence in that claim must be reduced. Were there more?
- The W1 regression detector proposed in Phase 0 instruments only `atom_data $derived.by()` and `build_bond_pairs $effect.pre`. It would NOT catch unexpected per-frame re-derives of `atom_positions_buffer` or `atom_colors_buffer`.
- W3's scope note ("does not cover extensions/") doesn't mention `structure?.sites` reads that bypass `displayed_structure` entirely. Audit pattern was too narrow.

**Action for plan v3:** Re-run audit for any `$derived.by()` reading `structure?.sites` directly. Extend W1 detector to track `atom_positions_buffer` identity changes during trajectory.

---

### H2. Phase 3's `build_trajectory_bond_pairs` wiring targets the wrong bond renderer (CRITICAL plan gap)

W6 Phase 3 proposes:
> Add branch in `build_bond_pairs $effect.pre` at `StructureScene.svelte:1552`: `if (trajectory_active && trajectory_frame_positions) { bond_pairs = build_trajectory_bond_pairs(...); return }`

This writes to `bond_pairs` state. Tracing through the codebase:
- `bond_pairs` → `filtered_bond_pairs` (`StructureScene.svelte:2035`) → bond HITBOX InstancedMesh (line 3612) and `BondEditingIndicators`
- `bond_pairs` does NOT feed `BondManagerInstances`

The actual visual bond renderer is at `StructureScene.svelte:3593-3601`:
```svelte
<BondManagerInstances
  {bond_manager}
  atom_positions={atom_positions_buffer}   ← positions source
  atom_colors={atom_colors_buffer}
  ...
/>
```

`BondInstancedRenderer.#write_slot()` at `bond-instanced-renderer.ts:280-285` reads positions from the `atom_positions_buffer` (= structure-derived). Under Architecture P after Phase 4:
- `atom_positions_buffer` is frozen (derived from stable `structure.sites`)
- `bond_manager.version` doesn't change per frame (trajectory doesn't mutate topology)
- `BondManagerInstances.$effect` never fires
- **Bonds visually freeze at trajectory-start positions while atoms animate**

**Phase 3's `bond_pairs` update only affects bond hitbox click accuracy, NOT visual rendering.**

**The fix:** After Phase 1 (atom_manager lift), change `atom_positions_buffer` (`StructureScene.svelte:2756`) to read from `atom_manager.positions_buffer` instead of `structure?.sites`. This makes `BondManagerInstances` automatically follow per-frame writes from Phase 2's loop. `build_trajectory_bond_pairs` can still be wired separately for hitbox accuracy.

Without this fix, Architecture P produces correct atom animation and frozen bond animation — a visible regression.

---

### H3. Phase 2 double-write timing hazard

W6 Phase 2 framing: "additive — atoms animate via both old path and new path until Phase 4."

Under Phase 2, two writers call `atom_manager.set_position` per frame:
1. Trajectory.svelte's new position-write loop
2. X2 shadow sync's `trajectory_only` branch (`StructureScene.svelte:2339-2363`)

**Whether this is safe depends on $effect ordering.** Svelte 5 doesn't guarantee ordering between effects in different components. If X2 fires first → 878 version bumps + 878 GPU uploads. Then Trajectory's loop fires → no-ops. **GPU upload count doubles for that frame.**

If Trajectory fires first → its values are written → X2 sees no `set_position` changes (Math.fround equal) → no extra version bumps. Clean.

W6 claims "consistent GPU output" but doesn't acknowledge the cache-warming/upload-doubling failure mode under unfavorable ordering. **W1 (which measures `atom_data` and `build_bond_pairs`) cannot detect this.**

---

## MED — Issues worth fixing in plan v3

### M1. Phase 4 `current_structure` removal scope is unresolved (load-bearing open question)

W6 Phase 4 says "remove `current_structure = frame.structure`" but parenthetically: "or gate behind `!trajectory_active` if current_structure is needed for pause-state logic — **confirm via T5 analysis**". W6 Open Question #2 explicitly asks this without answering. If `current_structure` is also the trajectory-load topology initialization path, removing the per-frame write also breaks initialization. The "1h" estimate may be wrong.

### M2. "5 of 5 T6 patches deleted" overstated for `build_bond_pairs` memo

Decision Log #5 admits this can't be fully deleted: "keep the memo structure." But the T6 deletion table says "DELETE trajectory-specific path; simplify memo." The `__bbp_prev_*` state vars at `StructureScene.svelte:1544-1551` track non-trajectory inputs (drag, topology, selection) — none are exclusively trajectory-specific. Phase 6's deletion for this category is "remove some trajectory-specific comments." Side-by-side comparison oversells this.

### M3. X2 slow-path fallback during Phase 2

`StructureScene.svelte:2339-2346` shows the `trajectory_only` condition requires `!struct_changed`. During Phase 2, `current_structure` is still being written, so `struct_changed = true` AND `traj_changed = true` simultaneously. The `trajectory_only` branch fails, X2 falls through to the slow path (~15-30ms full diff). W6 doesn't acknowledge this regression.

### M4. W1 doesn't cover `atom_positions_buffer` + `atom_colors_buffer` (per H1)

---

## What I tried to break and couldn't (author should be confident)

1. **Zero-CRITICAL-LIVE-consumers finding** — even with H1's missing two consumers, both go quiescent under P. Core W3 finding survives.
2. **Supercell + trajectory trade-off** — no evidence of current test coverage or user workflows. The current `StructureScene.svelte:2346` guard already silently freezes; Architecture P's explicit UI message is strictly better.
3. **`$bindable` semantics under Option A** — W4 flagged uncertainty about $bindable default version bumps; no concrete problem found in practice.

---

## Unverifiable

**W1 feasibility.** Can W1 be designed in a way that compiles cleanly in Svelte 5's `$derived.by()` purity model AND reliably catches regressions? Cannot be verified without implementation attempt.

---

## One Specific Recommendation for Plan v3

After Phase 1 (atom_manager lift), change `atom_positions_buffer` at `StructureScene.svelte:2756` to read from `atom_manager.positions_buffer` instead of `structure?.sites`. This single line makes `BondManagerInstances` automatically follow Trajectory.svelte's per-frame position writes — without requiring `build_trajectory_bond_pairs` for visual rendering. The bond hitbox path can be handled separately. Without this, Architecture P ships with frozen-bonds regression.

---

## Findings Table

| Finding | Severity | File:line | Category |
|---|---|---|---|
| H1: W3 missed `atom_positions_buffer` + `atom_colors_buffer` | HIGH | `StructureScene.svelte:2756, 2771` | Incomplete audit |
| H2: Phase 3 targets wrong bond renderer | HIGH | `StructureScene.svelte:3593-3601`, `bond-instanced-renderer.ts:99` | Plan gap — blocks implementation |
| H3: Phase 2 double-write version bomb | HIGH | `AtomManagerInstances.svelte:361`, `StructureScene.svelte:2339-2363` | Sequencing risk |
| M1: Phase 4 `current_structure` removal scope unresolved | MED | W6 Open Question #2 | Effort underestimate |
| M2: "5 of 5 T6 patches deleted" overstated | MED | `StructureScene.svelte:1544-1551` | Oversell |
| M3: X2 slow-path fallback during Phase 2 | MED | `StructureScene.svelte:2339-2395` | Unanalyzed regression |
| M4: W1 coverage gap | MED | Phase 0 description | Verification gap |
