# W6 Review — Phase Sequencing (Reviewer 2)

**Reviewing:** `plans/W6-architecture-decision.md` § "What plan v3 looks like under the recommendation"
**Branch:** atom-soa-refactor @ bd0da10f
**Reviewer angle:** Reconstruct codebase state at each phase boundary; find sequencing bugs.

---

## Verdict: SEQUENCING-NEEDS-RESHUFFLING

The plan has one critical two-writer conflict at the Phase 2 boundary, three design gaps in Phases 3-6, and one missing preparatory step before Phase 6. The Architecture P direction is sound, but specific phase boundaries leave the codebase in inconsistent states without addressing them.

---

## Per-Phase Boundary Analysis

| Phase | Valid post-state? | Trajectory? | Edits? | Compiles? | Notes |
|---|---|---|---|---|---|
| 0 (W1) | Y | Y | Y | Y | W1 mechanism design unresolved (LOW) |
| 1 (atom_manager lift) | Y | Y | Y | Y | $bindable default causes 2× allocation at mount (LOW) |
| 2 (Trajectory writes) | N | Y (dual-write safe via Math.fround no-op) | Y | Y | "W1 silent" claim incorrect; component topology ambiguity (HIGH) |
| 3 (bond fast-path) | N | Atoms Y, **bonds freeze** | Y | Y | `stable` memo guard missing `trajectory_frame_positions` (HIGH) |
| 4 (stop current_structure) | N | Y | **N (drag-commit stale-position bug)** | Y | Open Q2 unresolved; Phase 5 must land simultaneously (HIGH) |
| 5 (pause-and-edit) | Y (caveats) | Y | Y | Y | Supercell OOB in writeback; `resume_disabled` threading unclear (MED) |
| 6 (delete patches) | **N — REGRESSION** | Slow-path fallthrough | Y | Y | X2 trajectory_only deletion without prior gate causes 15-30ms/frame (CRITICAL) |
| 7 (worker prewarm) | Y | Y | Y | Y | No issues |

---

## CRITICAL — Phase 6 X2 deletion causes severe regression without preparatory gate

**Confidence: 95.**

After Phase 5, the X2 shadow sync at `StructureScene.svelte:2263` STILL fires per frame (it reads `trajectory_frame_positions` at line 2289). Under P after Phase 4: `struct_changed = false`, `traj_changed = true` → matches `trajectory_only` branch (line 2339) → loops 878 atoms calling `set_position` (Math.fround no-ops since Phase 2 already wrote them) → cost ~1-2ms/frame.

**At Phase 6**, the plan deletes the `trajectory_only` branch. After deletion:
- X2 still fires per frame (still reads `trajectory_frame_positions`)
- `trajectory_only` branch is gone → falls through to `positions_only` check (requires `struct_changed = true`, which is false) → falls through to full diff slow-path
- Full diff path: ~15-30ms per frame (878-atom diff comparing positions)
- Result: **per-frame cost climbs from ~1-2ms to ~15-30ms → severe performance regression**

**The fix:** Insert a Phase 5.5 (or extend Phase 5) that gates the entire X2 effect on `!trajectory_active`. Concretely add `if (trajectory_frame_positions != null) return` as the first statement inside the X2 `$effect`. This makes X2 a no-op during playback (~0.01ms per frame). Phase 6 can then safely delete the trajectory_only branch because the effect never reaches it during playback.

This change is ~1 LOC, independently revertable, and its correctness can be verified by W1.

---

## HIGH — Phase 3 bond freeze due to missing `stable` memo guard update

**Confidence: 88.**

The `stable` check at `StructureScene.svelte:1563-1577` tracks: `__bbp_prev_conn`, `__bbp_prev_lbs`, `__bbp_prev_struct`, `__bbp_prev_overrides`, `__bbp_prev_drag`, `__bbp_prev_sel`, `__bbp_prev_overrides_size`. **It does NOT track `trajectory_frame_positions`.**

After Phase 3 adds `trajectory_frame_positions` as a reactive dep (by reading it in the new branch), Svelte will re-fire `build_bond_pairs $effect.pre` per frame. But the `stable` check returns true (all other inputs unchanged) → effect returns early → `bond_pairs` not updated. **Bonds freeze.**

**Fix:** Add `__bbp_prev_traj` tracking and include in `stable` check. Phase 3 deliverable does not mention this. Critical sequencing bug as written.

---

## HIGH — Phase 4 + 5 must land in the same commit (drag-commit stale-position bug)

**Confidence: 85.**

Between Phase 4 commit and Phase 5 commit:
- Phase 4 stops writing `current_structure` per frame → `structure` is frozen at trajectory-load state
- Phase 5 (pause-and-edit handler) is not yet implemented
- User pauses, drags an atom: `interaction.svelte.ts:445` calls `apply_overrides_to_structure` → `try_move` writes `structure = ...`
- `structure.sites` positions reflect the trajectory-LOAD frame, not the current frame
- After drag-commit: atom snaps back to start-frame position

**This is a silent stale-position bug.** Phase 4 cannot ship without Phase 5 in the same commit, OR Phase 4 must add a guard like `if (trajectory_active) return // block drag-commit during playback`.

Per-frame cost claim of ≤2ms in the success criteria is also wrong at Phase 4 boundary: Phase 2 write loop (~1-2ms) + X2 trajectory_only no-op loop (~1-2ms) = ~2-4ms, not ≤2ms. Only after Phase 6's X2 deletion (with the preparatory gate from above) does cost drop to ≤2ms.

---

## HIGH — Component topology error in Phase 2 deliverable

**Confidence: 90.**

W6 Phase 2 says the position-write loop lives in "Trajectory.svelte". But `Structure.svelte:791` declares `trajectory_frame_positions = null` as an INCOMING prop. This means the Trajectory player is the PARENT of Structure.svelte, not a child.

Structure.svelte does NOT render a `<Trajectory>` component. Trajectory.svelte cannot receive `atom_manager` from Structure.svelte via normal prop-down passing.

**Implication for Phase 1:** "Structure.svelte template — `{scene_atom_manager}` passed to `<Trajectory>`" — Structure.svelte does not render `<Trajectory>` so this prop pass cannot exist as described.

**Implication for Phase 2:** The position-write loop must live in **Structure.svelte** (reacting to its own `trajectory_frame_positions` prop), not in Trajectory.svelte. Structure.svelte already has `scene_atom_manager` after Phase 1 and can directly write to it.

This is a documentation/wiring error, not a fundamental architectural problem. But the deliverable description must be corrected before implementation.

---

## HIGH — Phase 2 "W1 must remain silent" claim is incorrect

**Confidence: 95.**

W6 Phase 2 verification: "W1 detector must remain silent (current `current_structure` write still runs; this is additive)."

W1 by design fires when `atom_data` and `build_bond_pairs` re-run during trajectory. At Phase 2, `current_structure` is still being written per frame → `displayed_structure` cascade still fires per frame → `atom_data` re-runs → **W1 fires by design**.

W1 is NOT silent at Phase 2. It will fire at ~60Hz throughout Phase 2. The verification criterion as written is a calibration error. The correct criterion: "W1 is expected to fire at ~60Hz at Phase 2; W1 silence is the Phase 4 verification."

If W1 is calibrated to assert silence at Phase 2, the calibration is wrong and Phase 2 will appear as a "regression" when it's actually correct.

---

## MED — Phase 5 supercell OOB in writeback

**Confidence: 85.**

T5 writeback iterates atom_manager slots and writes `structure.sites[sid].xyz = ...` where `sid = mgr.site_ids_buffer[slot]`.

For supercell structures, `sid` can exceed `structure.sites.length` (base) since `displayed_structure` has supercell-expanded indices. **Writing `structure.sites[sid]` for `sid >= structure.sites.length` is an OOB write.**

The plan acknowledges supercell + trajectory is unsupported (LB1) but doesn't mention this guard for the writeback specifically. The Phase 5 deliverable must guard `if (sid < structure.sites.length)` or only iterate base-structure slots.

---

## MED — Phase 5 `resume_disabled` threading depends on component topology

**Confidence: 85.**

If Trajectory.svelte is the parent (per H above), passing `resume_disabled` from Structure.svelte requires either `$bindable` or a callback prop. The W6 deliverable says "add a `resume_disabled: boolean` prop on Trajectory.svelte" — as a regular prop this is a parent-to-child flow, but Structure.svelte is the child. Need `$bindable` or callback.

---

## LOW — Phase 0 W1 mechanism design unresolved

W6 Open Question #3 acknowledges side effects in `$derived.by()` are technically valid but may confuse future readers. Mechanism choice is deferred. Becomes HIGH at Phase 6 because Phase 6's pre-condition is "W1 has been silent" — if the detector mechanism is unreliable, Phase 6 could proceed on a false negative.

---

## LOW — Phase 1 $bindable double allocation

`StructureScene.svelte:atom_manager = $bindable(new AtomManager())` + `Structure.svelte:scene_atom_manager = $state(new AtomManager())` creates TWO `AtomManager` instances at mount. The parent's wins (Svelte 5 $bindable semantics). Wasteful but not broken.

---

## Top Phase Boundary Needing More Design

**Phase 6** (X2 trajectory_only deletion). The plan as written causes a critical performance regression (~15-30ms/frame) unless a preparatory X2-gate step is inserted between Phase 5 and Phase 6.

Close second: **Phase 4** (`current_structure` removal scope unresolved + Phase 5 coupling required).

---

## One Sequencing Change to Recommend

**Insert a preparatory phase between Phase 5 and Phase 6** that gates the X2 shadow sync on `!trajectory_active`. This is a 1-LOC change (`if (trajectory_frame_positions != null) return` at the top of the X2 `$effect`) that makes Phase 6's X2 trajectory_only branch deletion safe.
