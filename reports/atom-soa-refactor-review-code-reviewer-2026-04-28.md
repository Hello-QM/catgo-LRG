# Code Review — `split-files...atom-soa-refactor` (W7 Milestone 5)

**Reviewer:** `pr-review-toolkit:code-reviewer`
**Date:** 2026-04-28
**Branch HEAD:** `358f50a5` (75 commits ahead of `split-files`)
**Scope:** Project-conventions / convention-adherence pass. Reviewed against `CLAUDE.md`, `src/lib/structure/CLAUDE.md`, `src/lib/workflow/CLAUDE.md`, `src/lib/api/CLAUDE.md`, `src-tauri/CLAUDE.md`. Focus: `Trajectory.svelte` `$bindable` / pause writeback / supercell warning, the test pages, the W7 Playwright suite, the `StructureScene` probe extensions.

---

## Critical (confidence 90–100)

### 1. `resume_disabled` is silently re-enabled by the cross-frame edit spread reassignment — **MUST FIX before merge** (confidence 95)

**File:** `src/lib/trajectory/Trajectory.svelte`
**Lines:** reset effect at 253–256, handlers at 1385–1430, eager spread at 1288

The W5 contract — and the inline comment at line 251 — explicitly state: *"Resets only on new trajectory load. Stop, pause, and undo do NOT reset."* The reset is implemented as:

```js
$effect(() => { trajectory; resume_disabled = false })
```

`handle_atom_added` (1385–1392) and `handle_atom_replaced` (1417–1430) set `resume_disabled = true` on entry, then call `_chunked_cross_frame_edit(...)`. That function ends every successful run with `trajectory = { ...trajectory }` (line 1288), which retriggers the W5 reset effect within ~0–4 ms (1 setTimeout for the H2O fixture's 10 frames; longer for larger fixtures).

**Net effect:** an add/replace during pause sets `resume_disabled = true` for the duration of two macrotasks, then it flips back to `false` and the play button is re-enabled. The user can resume after a topology edit — exactly the failure mode W5 was designed to prevent.

`flush_pending_ops()` at line 1224 has the same problem — it also does `trajectory = { ...trajectory }`, so any subsequent eager edit after a queued delete will reset.

`handle_atoms_deleted` (1396–1414) avoids this only because it is purely lazy enqueue with no spread.

**Test gap:** W7 Test 6.4 catches the delete case (which works) but never exercises `trigger_atom_added` / `trigger_atom_replaced`, so the bug is invisible to CI even though those handlers are exposed on `__catgo_traj_test`.

**Suggested fix:** track new-trajectory-load via a stable identity rather than the trajectory ref itself — for example a `traj_load_seq` counter incremented only in `load_trajectory()` and the file-drop path, with the reset effect tracking that counter instead of `trajectory`. Or guard the reset on a sentinel like `trajectory.metadata?.source_format` identity.

---

## Important (confidence 80–89)

### 2. Test page `current_step_idx` reset interacts fragilely with two-way bind (confidence 80)

**File:** `src/routes/test/structure-trajectory/+page.svelte`
**Lines:** 137–142 (`use_h4` toggle + `current_step_idx = 0`)

The page resets `current_step_idx = 0` in `swap_structure`, but `bind:current_step_idx` is two-way. Trajectory's auto-play `$effect` at 391–400 also reads `current_step_idx` during the next reactive flush. When swapping H2O (10 frames, idx=5) → H4 (5 frames), the assertion `current_step_idx >= 0 && current_step_idx < total_frames` may briefly be true at idx=5 with a 5-frame fixture (5 < 5 is false, but if the swap order is reversed the read may see the old length first). The test's 1-second polling absorbs this, but the reactive flush order is fragile.

**Cross-issue:** with the W5 reset bug above (#1), swapping triggers a new trajectory load, and `resume_disabled` would be reset. Tests 6.4 / 6.5 do not swap, so they don't hit it. Test 5.4 followed by Test 6.4 in the same browser context would observe inconsistent `resume_disabled` state if they didn't navigate fresh — which they do (each test calls `page.goto`), so this is mitigated by the test-isolation pattern. Worth noting in the W7 design doc.

### 3. `show_hydrogen_bonds` two-way bridge has an undefined-vs-false initial-mount asymmetry (confidence 82)

**File:** `src/lib/trajectory/Trajectory.svelte`
**Lines:** 112 (prop default `undefined`), 285–297 (the two effects)

Prop default is `$bindable<boolean | undefined>(undefined)`, but the test page initializes the bound state to `false` (line 142 of `+page.svelte`). That works for the test page. However:

- The first `$effect` short-circuits when `show_hydrogen_bonds === undefined`
- Any consumer that does NOT bind `show_hydrogen_bonds` and instead expects the default from `scene_props` will see the second `$effect` overwrite their `undefined` prop with whatever `scene_props` had at mount

This is documented via the comment at 281–284, but the `undefined as any` cast at line 280 (initializing `trajectory_scene_props`) papers over a real type bug — `ComponentProps<typeof Structure>['scene_props']` is not nullable in the type definition. Either:
- (a) fix the type to allow undefined, or
- (b) initialize with a proper sentinel object

Future Svelte 5 strict-mode warnings will surface this.

### 4. Phase 5.5 gate condition can briefly mismatch during structure swaps with active trajectory (confidence 80)

**File:** `src/lib/structure/StructureScene.svelte`
**Lines:** 504–508 (gate: `if (__ph55_gate_traj != null && __ph55_gate_sites != null && atom_manager.count === __ph55_gate_sites.length) return`)

The gate is correct in steady state. But during a structure swap (Test 5.4) with a paused trajectory present, `displayed_structure.sites.length` can change BEFORE `atom_manager.count` catches up via the X2 sync's slow path. The gate then evaluates false, X2 runs the full diff, atom_manager rebuilds — this is the intended fallthrough.

**However:** if the swap leaves `trajectory_frame_positions` populated with the OLD (pre-swap) Float32Array and the new structure has a different atom count, the position-write loop in `Structure.svelte` (lines 1146–1183 of the diff) clamps to `Math.min(mgr.count, traj/3)` — the Float32Array is sized for the OLD structure's atom count, so positions for the NEW structure's atoms beyond the old count are skipped (good), but positions for slots `0..min` are overwritten with stale OLD positions, then immediately overwritten by X2's slow-path full-rebuild. **Visible symptom:** a 1-frame flicker of stale positions on swap. Test 5.4 doesn't catch this because it pauses+swaps with no active `trajectory_frame_positions`.

**Suggested fix:** position-write loop should also check `atom_manager.count === sites.length` before writing.

---

## Notes (not reported as issues, but flagged)

- `undefined as any` type cast at `Trajectory.svelte:280` — minor type safety regression, see #3.
- **`structures_compatible` skipped in lazy delete path** — `handle_atoms_deleted` no longer calls the compatibility check that `_chunked_cross_frame_edit` does, so `enqueue_pending_op` accepts deletes against trajectories whose other frames have different atom counts. `materialize_frame` will then crash on `delete_atoms(structure, [bad_idx])`. Out of W7 Milestone 5 scope but worth a follow-up bug-report; not raised as a high-confidence finding because the lazy path was likely intentionally chosen to defer compatibility errors.
- Test 8.4's 192-atom fixture page doesn't expose any UI controls, so it can only be exercised via the play button. Matches the comment ("too small for stable timing measurements" → use this fixture only for cascade silence). OK.
- The new `__catgo_traj_test` and probe surfaces are correctly DEV-gated via `import.meta.env?.DEV` — compatible with the production tree-shaking expectations from the parent `CLAUDE.md`.

---

## Files of interest

- `src/lib/trajectory/Trajectory.svelte` — `resume_disabled` reset bug, `scene_props` two-way bridge
- `src/lib/structure/Structure.svelte` — Phase 5.5 position-write loop and gate interaction
- `src/lib/structure/StructureScene.svelte` — Phase 5.5 gate, probe surface
- `src/routes/test/structure-trajectory/+page.svelte` — test page swap and bindings
- `tests/playwright/structure-trajectory.test.ts` — Test 6.4 covers delete; add/replace cases not asserted

---

## Bottom line

**Finding #1 is the only must-fix before this PR ships:** the W5 resume-disable contract is broken for `add` and `replace` because `_chunked_cross_frame_edit` reassigns `trajectory` and the W5 reset effect tracks `trajectory`. The fix is small (replace the tracked dep with a load-counter) and the existing test surface (`__catgo_traj_test.trigger_atom_added`, `trigger_atom_replaced`) makes it trivial to add the missing regression tests. Findings #2–#4 are real but low-blast-radius and can land in a follow-up.
