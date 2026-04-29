# Comment Analyzer Review — `split-files...atom-soa-refactor`

**Reviewer:** `pr-review-toolkit:comment-analyzer`
**Date:** 2026-04-28
**Scope:** Comments added in this branch in `src/lib/structure/Structure.svelte` and `src/lib/trajectory/Trajectory.svelte`.

> **Path correction:** The W7 milestone doc and the original review prompt say the trajectory file is at `src/lib/structure/Trajectory.svelte`. It is actually at **`src/lib/trajectory/Trajectory.svelte`**. The W7 doc itself contains this misdirection. Worth flagging in the W7 doc cleanup.
>
> **Line-number correction:** The prompt says the dead-effect stub is at `Structure.svelte:1142`. The stub is actually at lines **1125–1131**. The prompt's reference is itself an example of the line-number rot pattern this audit catches.

---

## Summary

The two load-bearing comments are **substantively good** — they name the right identifiers (`trajectory_active`, `current_structure`, `pause_playback`, `trajectory_frame_positions`, "W2 Option 1", "T5 writeback"), and the Trajectory-side comment is largely self-contained for a maintainer who knows runes / `$bindable`.

But there are **four concrete comment-rot defects already at HEAD before merge**:

1. The Structure.svelte stub (1125–1131) says "**structure** is already null" — the actually-nulled identifier is `current_structure`.
2. Trajectory.svelte:213 says `Mirrors __catgo_align_on_load_fires pattern at Structure.svelte:1238`. Line 1238 is `let md_layout = $state(...)`. The actual writes are at lines **1209–1210**.
3. Trajectory.svelte:740 says `The original Phase 5 implementation lived in Structure.svelte at line 1143`. Line 1143 is in the middle of the *Phase 2* comment block; the dead-effect stub starts at 1125.
4. Trajectory.svelte:606–609 contains a stale "Phase A note: NO callsite enqueues anything yet". Phase D *does* enqueue at HEAD (the `handle_atoms_deleted` hunk in this same diff).

---

## Critical Issues

### 1. Structure.svelte:1125–1131 — stub says "structure" instead of "current_structure"

**Current text:**
```
// Plan v3 Phase 5 (T5 pause writeback): historically lived here but the
// edge-trigger semantics (trajectory_active true→false) only fire on
// trajectory unload, at which point structure is already null and the
// writeback short-circuits. Refined 2026-04-27 to live in Trajectory.svelte's
// pause_playback() instead — co-located with the pause event, uses
// trajectory_frame_positions as the source of truth, propagates through
// $bindable per W2 Option 1.
```

**Issue:** "at which point **structure** is already null". The identifier nulled atomically with the unload is `current_structure` in `Trajectory.svelte` (`current_structure = undefined` at Trajectory.svelte:564 in the !frame branch), not `structure` in this file. A future reader greps `structure` here, finds the prop declaration, sees no synchronous null-set on unload, and concludes "the comment is wrong, let me restore the effect."

**Suggested rewrite:**
```
// Plan v3 Phase 5 (T5 pause writeback): a $effect lived here that watched
// `trajectory_active` (= `trajectory_frame_positions != null`) crossing
// true→false and wrote frame positions back into `current_structure`.
// It NEVER fired correctly: that edge fires only on trajectory unload,
// and Trajectory.svelte's frame $effect (search "current_structure = undefined"
// in src/lib/trajectory/Trajectory.svelte) nulls current_structure in the
// SAME atomic update — so the inner `if (current_structure?.sites)` block
// short-circuited every time.
//
// Refined 2026-04-27 (commit 931e79c7) to the T5 pause writeback in
// Trajectory.svelte (search "T5 pause writeback" in that file).
//
// DO NOT restore this $effect — it cannot work for the structural reason
// above. If pause_playback is renamed, the grep anchor `T5 pause writeback`
// is the rename-survival path.
```

### 2. Trajectory.svelte:213 — line-number lie ("Structure.svelte:1238")

**Issue:** Line 1238 of Structure.svelte is `let md_layout = $state(...)`. The actual `__catgo_align_on_load_fires` writes are at **1209–1210**.

**Suggested rewrite:** replace the line-number reference with a grep anchor on the stable identifier `__catgo_align_on_load_fires`.

### 3. Trajectory.svelte:739–740 — cross-file line-number lie

**Issue:** Line 1143 in Structure.svelte today is inside the *Phase 2* comment block. The dead stub starts at 1125. Already drifted in this same branch.

**Suggested rewrite:** anchor on the stable phrase `T5 pause writeback` (which #1's rewrite plants in Structure.svelte) and on the local identifier `current_structure = undefined`.

### 4. Trajectory.svelte:606–609 — "Phase A note" is false at HEAD

**Issue:** The same diff hunk introduces `handle_atoms_deleted` with `// Phase D: lazy delete. O(1) at the edit site. Record the op once...`. The queue does NOT stay empty after a delete.

**Recommendation — delete the Phase A note and replace with current state:**
```
// Producers (handle_atoms_deleted enqueues at HEAD; add/replace/manipulate
// remain eager and call flush_pending_ops first) push ops via
// `enqueue_pending_op`. Consumers (materialize_frame on read,
// flush_pending_ops on save/export, _chunked_cross_frame_edit's flush
// pre-pass, drag's flush pre-pass) drain. Search "enqueue_pending_op" for
// the live producer set.
```

---

## Improvement Opportunities

### 5. Trajectory.svelte:731–748 — pause_playback writeback rationale (the marquee comment)

**Lies of omission:**
- (a) **What "W2 Option 1" actually means** — add a parenthetical: `per the W2 Option 1 contract (reassign $bindable rather than mutate sites in place — reactivity must propagate through the parent)`.
- (b) **Drag-precedence interaction.** Structure.svelte's Phase 2 loop skips slots in `realtime_position_overrides` ("drag wins"). This pause writeback does **not** — it overwrites all sites. Worth documenting.
- (c) **Supercell scope.** Different bounds than Phase 2 loop. Worth documenting that supercell-extra sites pass through unchanged.

**Survives rename of `pause_playback`?** This comment lives inside the function and doesn't name it — survives. **But Structure.svelte's stub at 1125–1131 *does* name `pause_playback()` as its only cross-ref.** Add as the first line of the writeback comment: `// T5 pause writeback (search "T5 pause writeback" in this file or src/lib/structure/Structure.svelte).`

### 6. Trajectory.svelte:223–227 — `__catgo_traj_test` probe rationale
References `plans/W5-resume-disable-design.md` by relative path. If that doc is moved/archived, the reference rots silently. Anchor on the local identifier `resume_disabled` and the stable URL fragment `/test/structure-trajectory`.

### 7. Structure.svelte:158–164 — Phase X5 fast-path delete
Comment is excellent. One nit: "Phase X5" becomes opaque once the plan doc is gone. Add one self-contained phrase: `// Phase X5 atom-delete fast-path (avoids O(N) full WASM bond recompute on each delete), bound from <StructureScene>.`

### 8. Structure.svelte:1133–1152 — Phase 2 position-write loop
Long block, mostly excellent. One sentence of expansion would help the closing line: `"Silence" here = if this loop runs without atom_data_fires also exceeding 10 in Test 5.3, Phase 4's silenced cascade has been accidentally gated on by Phase 2's writes — defeating the bypass refactor's reason for existing.`

### 9. Trajectory.svelte:540–558 — topology_initialized gate
The acronym list `bbp, apb, acb, nhsi` is unexpanded anywhere in this file. Replace with a phrase: `the per-frame structure cascade (atom_data, bond_pairs, atom_property_bindings, all_charge_bindings, h_bond_pairs)`.

---

## Recommended Removals / Consolidations

### 10. Trajectory.svelte:1033 — duplicate "synchronously reset" comment
Two consecutive callsites with the same reset pattern is a maintenance hazard. Factor both into a `reset_pending_ops_for_new_trajectory()` helper.

---

## Other Comments Added in This Branch (spot checks)

| Location | Verdict |
|---|---|
| Trajectory.svelte:104–110 | **Good.** Names `structure_props`, `$bindable`. |
| Trajectory.svelte:191–196 | **Good.** "existing behavior" hint preserved. |
| Trajectory.svelte:275–284 | Mostly good. Add sentinel: `// If show_hydrogen_bonds is later promoted to a top-level Structure prop, this bridge can be deleted.` |
| Trajectory.svelte:1119–1126 | **Excellent** invariants block — only the Phase A tail is bad. |
| Structure.svelte:74–82 | **Excellent.** Names every load-bearing identifier. Model comment. |
| Structure.svelte:1996–2007 | **Excellent.** Worked example `[1,3,5] removed from [a,b,c,d,e,f,g] restores cleanly via ascending inserts`. Gold standard. |

---

## Survives-Rename Audit

If `pause_playback` → `on_pause`:
- Trajectory.svelte:731–748 — survives.
- Structure.svelte:1129 — orphans. Currently the only cross-file anchor. Fix per #1.

If `current_structure` is renamed: at least 7 comments break silently across both files. Compiler catches the code; comments rot.

If `trajectory_frame_positions` is renamed: at least 5 comments break.

---

## Comment-Rot Risk Table

| File:Line | Risk | Severity |
|---|---|---|
| Structure.svelte:1127 | "structure is already null" — should be `current_structure` | **High** (already wrong) |
| Trajectory.svelte:213 | "Structure.svelte:1238" — actual line is 1209 | **High** (already wrong) |
| Trajectory.svelte:740 | "Structure.svelte at line 1143" — drifted to 1125 | **High** (already wrong, in same branch) |
| Trajectory.svelte:606–609 | "Phase A note: NO callsite enqueues anything" — Phase D enqueues at HEAD | **High** (already wrong) |
| Structure.svelte:1131 | Names `pause_playback()` as cross-ref with no rename hint | Medium |
| Trajectory.svelte:1033 | Comment will silently drift from sibling at line ~990 | Low |

---

## Actionable Recommendations (priority order)

1. **Fix Structure.svelte:1127** — change `structure` to `current_structure`, add the "DO NOT restore" sentinel, add grep anchor `T5 pause writeback`. (Critical #1)
2. **Fix Trajectory.svelte:213** — replace `Structure.svelte:1238` with grep anchor on `__catgo_align_on_load_fires`. (Critical #2)
3. **Fix Trajectory.svelte:740** — replace `Structure.svelte at line 1143` with grep anchor `T5 pause writeback`. (Critical #3)
4. **Delete Trajectory.svelte:606–609** ("Phase A note") and replace with current-state description. (Critical #4)
5. Plant the phrase `T5 pause writeback` as the first line of the writeback comment in Trajectory.svelte:731.
6. (Polish) Improvements #5b/c (drag-precedence + supercell-scope omissions), #6, #8, #9, #10.

The two load-bearing comments **will** make sense in 6 months once items 1–4 are applied. As written today, items 2, 3, and 4 are already wrong on HEAD.
