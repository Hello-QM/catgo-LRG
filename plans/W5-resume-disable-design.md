# W5 — Trajectory Resume-Disable Wire-Up Design

**Branch:** atom-soa-refactor @ a1842479
**Resolves:** W6 Open Q (W5 detection mechanism) — MEDIUM-severity plan v3 blocker
**Inputs:** plans/W4-atom-manager-lift-audit.md, plans/W6-review-completeness.md, plans/phase4-current-structure-investigation.md

---

## TL;DR

Use detection Approach A: each topology-altering hook calls a new `on_topology_altered` callback in Structure.svelte, which Trajectory.svelte provides as a state-setter wrapper setting `resume_disabled = true` when `is_playing === false` (i.e., the trajectory is paused). The `try_move` hook does NOT call the callback. Approach B (topology fingerprint `$effect`) carries meaningful false-positive risk on initial trajectory load and the T5 writeback, and false-negative risk on build-pane ops; a hybrid approach (C) adds complexity with no benefit over A because A already covers all four interactive edit paths and those are the only paths active while trajectory is paused. The UX surface is a disabled play button with a `title` tooltip reading "Structure was edited — reload trajectory to resume." Resume-disabled state clears only on new trajectory load. It does NOT clear on trajectory stop.

**Refined recommendation (per Q3 below):** No new prop on Structure.svelte is needed. The existing `on_atoms_deleted`, `on_atom_added`, `on_atom_replaced` callbacks already fire at the right points. The detection lives in Trajectory.svelte's existing handlers — they each set `resume_disabled = true` when `!is_playing`. Total delta: 6 targeted edits in `Trajectory.svelte`, zero changes to `Structure.svelte`.

---

## Q1: Hook-type classification

### try_delete

**Signature (file:line):** `StructureScene.svelte:2689` (within the `$effect` starting at line 2687)
```ts
try_delete: (deleted_site_ids: readonly number[], new_sites: readonly Site[]): boolean
```
Defined in interface at `atom-manager.svelte.ts:90`.

**What it mutates:**
- `atom_manager.apply_atom_delete(deleted_site_ids)` — compact the manager's slot array; re-index site_id → slot mapping. Sites count decreases.
- `apply_atom_delete_incremental(bond_state, ...)` — drops bond connectivity entries for deleted atoms; pre-bumps bond fingerprints to the post-delete site count.

**Resume-disable verdict: YES.**
Sites count changes. `position_cache` is indexed by frame index and holds `Float32Array` of length `original_atom_count * 3`. After a delete, `atom_count` decreases by N. Every subsequent `position_cache[frame_idx]` has `length = original_N * 3`, but the manager now has `count = original_N - deleted`. The position-write loop (`min(mgr.count, traj.length / 3)` slots) would silently animate only the surviving atoms, but because `apply_atom_delete` does a compaction + reindex, the slot → site_id mapping no longer matches the position_cache's layout. The positions would be garbage for every slot at or after the first deleted site. Resume would display wrong atoms at wrong positions.

### try_add

**Signature (file:line):** `StructureScene.svelte:2707`
```ts
try_add: (added: readonly AtomAddSpec[], new_sites: readonly Site[]): boolean
```
Interface at `atom-manager.svelte.ts:99`.

**What it mutates:**
- `atom_manager.add_atoms(...)` — appends new slots at the tail; manager count increases.
- `apply_atom_add_incremental(bond_state, ...)` — delta-adds new bonds; pre-bumps fingerprints.

**Resume-disable verdict: YES.**
Sites count increases. The added atoms' slots never receive positions from the cache (write loop bound clamps to `original_N`) and remain at whatever position they were placed during the add. They do not animate at all. Additionally, if resume is attempted, frame advances will set `current_structure = frame.structure` — that structure does not contain the added atom, so Structure.svelte would reconstruct `displayed_structure` without the atom, and the X2 slow path would fire, removing the manager slot.

### try_replace

**Signature (file:line):** `StructureScene.svelte:2756`
```ts
try_replace: (replacements: readonly AtomReplaceSpec[], new_sites: readonly Site[]): boolean
```
Interface at `atom-manager.svelte.ts:110`.

**What it mutates:**
- `atom_manager.set_element(slot, atomic_number)` / `set_radius` / `set_color`
- `apply_atom_replace_incremental(bond_state, ...)`

**Resume-disable verdict: YES.**
Element identity changes. While the position_cache is technically still valid in raw coordinate sense, the trajectory was recorded for the original element identities. Bond detection during playback (`build_trajectory_bond_pairs`) was computed for the original elements — element Y may have different bonding radii than X.

### try_move

**Signature (file:line):** `StructureScene.svelte:2784`
```ts
try_move: (moved: readonly AtomMoveSpec[], new_sites: readonly Site[]): boolean
```
Interface at `atom-manager.svelte.ts:120`.

**What it mutates:**
- `atom_manager.set_position(slot, x, y, z)` per moved atom (no-op on `Math.fround`-equal values).
- `apply_atom_move_incremental(bond_state, ...)`

**Resume-disable verdict: NO.**
Sites count and element ordering are unchanged. The slot → site_id mapping is intact. When the user resumes, the position-write loop overwrites the manager's positions from the cache — the drag positions are discarded and the trajectory takes over from the next frame. This is the intended drag-then-resume workflow.

### Other paths that change topology

#### Build pane operations (slab cut, supercell, rotate, lattice transform)

**Classification: TOPOLOGY-ALTERING, but not reachable during pause in trajectory context.**

These operations replace `structure` directly via `deps.set_structure(...)`. They do NOT go through `AtomFastOps`. However, the `hide_extra_tools` prop passed from Trajectory.svelte at line 1618 (`hide_extra_tools={structure_props?.hide_extra_tools ?? true}`) hides the Build, Analysis, Workflow, IO, and Server toolbar buttons in trajectory context. So in normal trajectory usage, the build pane is NOT accessible during pause.

**Conclusion:** Build pane topology changes are NOT reachable in normal trajectory usage. Document this as an implicit invariant.

#### Cross-frame edits in Trajectory.svelte itself

`handle_atoms_deleted` (`Trajectory.svelte:1235`) and `handle_atom_replaced` (`Trajectory.svelte:1253`) apply the topology change to ALL frames via `_chunked_cross_frame_edit`. These handlers are downstream of the detection point — by the time they fire, `resume_disabled` is already set. Not an additional detection target.

#### Plugin-driven structure mutations

Out of scope per the W4 precedent. No shipped plugin performs topology mutations during trajectory playback.

---

## Q2: Detection mechanism — Options A, B, C

### Option A: Callback from each topology-altering hook

**Mechanism:** Each topology-altering callback in Structure.svelte (or its Trajectory.svelte handler) sets `resume_disabled = true`. `try_move`'s callback does NOT.

**False positive risk: LOW.** None of the existing callbacks fire on trajectory load or T5 writeback. T5 writeback writes `structure = { ...structure, sites: structure.sites.map(...) }` directly without going through any action handler.

**False negative risk: MEDIUM.** Build pane and plugin paths slip through, but both are mitigated.

**Plumbing complexity: MINIMAL.** ~6 lines in one file.

### Option B: Topology fingerprint `$effect` in Structure.svelte

**False positive risk: HIGH.** Initial trajectory load fires the fingerprint change. Frame navigation fires per advance. Requires careful gating on `trajectory_active` to suppress.

**False negative risk: HIGH for build pane** (would actually fire there if `hide_extra_tools: false`).

**Plumbing complexity: MEDIUM.** O(N) hash computation per topology change.

### Option C: Hybrid

Inherits B's false-positive risk plus A's plumbing. No advantage.

### Recommended: Option A

Zero false positives on the three events most likely to spuriously fire (T5 writeback, initial load, frame navigation). Minimal plumbing. Maps to existing callback pattern.

---

## Q3: Signal flow from Structure → Trajectory

### Existing callback patterns

All at `Trajectory.svelte:1599–1619` (the `<Structure ...>` element):

- `on_atoms_manipulated={handle_atoms_manipulated}` — drag-commit and keyboard arrows. Does NOT trigger resume_disabled.
- `on_atom_added={handle_atom_added}` (`Trajectory.svelte:1615`) — single-atom add.
- `on_atoms_deleted={handle_atoms_deleted}` (`Trajectory.svelte:1616`) — delete.
- `on_atom_replaced={handle_atom_replaced}` (`Trajectory.svelte:1617`) — replace.

### Recommended: NO new prop needed

The existing `on_atoms_deleted`, `on_atom_added`, `on_atom_replaced` callbacks already fire at the exact right points. Trajectory.svelte's existing handlers should each set `resume_disabled = true` when `!is_playing`.

Rationale: zero new props on Structure.svelte, zero new callsites, behavior localized entirely to Trajectory.svelte.

### resume_disabled state declaration

```ts
// In Trajectory.svelte, near line 197 with other $state flags
let resume_disabled = $state(false)
```

Local `$state`, not `$bindable`. It only gates the play button UI within Trajectory.svelte's template.

### Reception logic

```ts
function handle_atoms_deleted(event: { site_indices: number[] }) {
  if (!is_playing) resume_disabled = true  // NEW LINE — must come first
  if (!_can_cross_frame_edit()) return
  // ... existing body
}

function handle_atom_added(event: { element: ElementSymbol; position: Vec3 }) {
  if (!is_playing) resume_disabled = true  // NEW LINE
  // ... existing body
}

function handle_atom_replaced(event: { site_indices: number[]; new_element: ElementSymbol }) {
  if (!is_playing) resume_disabled = true  // NEW LINE
  // ... existing body
}
```

The flag-set must come BEFORE `_can_cross_frame_edit()` guards — even if cross-frame edit doesn't propagate (indexed trajectory), the topology is still altered locally.

### Reset trigger

```ts
$effect(() => {
  trajectory  // track
  resume_disabled = false
})
```

Fires on every trajectory load (and on `trajectory = undefined`). Does NOT reset on stop, undo, or pause — only on new trajectory load.

---

## UX surface specification

### Visual change

**Disabled button with tooltip.** Modify `Trajectory.svelte:1355–1363`:

```svelte
<button
  onclick={toggle_play}
  disabled={total_frames <= 1 || resume_disabled}
  title={resume_disabled
    ? `Structure was edited — reload trajectory to resume`
    : is_playing ? `Pause playback` : `Play trajectory`}
  class="play-button"
  class:playing={is_playing}
>
  {is_playing ? `⏸` : `▶`}
</button>
```

The button greys out via existing `button[disabled]` CSS.

### Text content

`"Structure was edited — reload trajectory to resume"`

Specific, actionable, no jargon.

### Interaction

- Cannot dismiss. Only clears on new trajectory load.
- Prev/next-step buttons are NOT disabled. User can still navigate frames manually.

### Accessibility

Optionally extend `aria-label`:
```svelte
aria-label={resume_disabled
  ? `Play (disabled — structure was edited, reload trajectory to resume)`
  : is_playing ? `Pause playback` : `Play trajectory`}
```

---

## Implementation specification

### File: `src/lib/trajectory/Trajectory.svelte`

**6 targeted edits, ~7 lines added total:**

| # | Line | Change |
|---|---|---|
| 1 | ~197 | Add `let resume_disabled = $state(false)` |
| 2 | ~289 (after trajectory $effect block) | Add `$effect(() => { trajectory; resume_disabled = false })` |
| 3 | ~1235 | First line of `handle_atoms_deleted`: `if (!is_playing) resume_disabled = true` |
| 4 | ~1227 | First line of `handle_atom_added`: `if (!is_playing) resume_disabled = true` |
| 5 | ~1253 | First line of `handle_atom_replaced`: `if (!is_playing) resume_disabled = true` |
| 6 | ~1357–1362 | `disabled` and `title` attributes on play button |

**Structure.svelte: no changes needed.**

---

## Risks / open follow-ups

1. **Flag-set guard order.** The `if (!is_playing) resume_disabled = true` line must come BEFORE `if (!_can_cross_frame_edit()) return` in each handler. If `_can_cross_frame_edit()` returns false, the topology is still altered locally even though cross-frame propagation doesn't happen.

2. **Undo does not clear resume_disabled.** After flag is set, `Ctrl+Z` undo restores the topology but the flag stays true. Acceptable for v1: "reload to resume" is always correct. v2 improvement: add `on_undo_topology_change` callback.

3. **Fragment add via pencil mode.** `pencil-mode.svelte.ts:443` bulk-adds via `try_add` but does NOT call `deps.get_on_atom_added()` (only single-atom path at line 383 does). False negative for fragment adds. Fix: add a callsite for the on_atom_added callback after the bulk add. Track as a separate follow-up commit.

4. **Cross-frame edit completing after resume.** `pending_ops` reset already exists at `load_trajectory_data:838`. Verified safe.

5. **The `!is_playing` guard is optional.** Defensive; could be removed for simpler code. Decision: keep for spec compliance.

---

## 6-Line Summary

1. **Recommended detection mechanism:** A — detection inside Trajectory.svelte's three existing topology-callback handlers; zero new props on Structure.svelte.

2. **Number of hooks/paths that trigger resume_disabled:** 3 hooks (`try_delete`, `try_add`, `try_replace`) plus pencil fragment-add (currently a false negative; separate fix needed). `try_move` does NOT trigger it.

3. **Recommended UX surface:** Disabled play button with `title` tooltip: "Structure was edited — reload trajectory to resume." No banner, no modal, no dismiss button.

4. **Most surprising finding:** `try_move` calls `apply_atom_move_incremental` which re-derives bonds from new positions — bond topology CAN change on a move. Despite this, resume is still ALLOWED: the `position_cache` encodes xyz positions, not bond topology. Drag-then-resume is safe.

5. **Estimated implementation effort:** 1 hour. Six lines in one file; no Structure.svelte changes.

6. **Concrete next step:** Add `let resume_disabled = $state(false)` to `Trajectory.svelte` at line 197; add the reset `$effect`; add three one-line guards in `handle_atoms_deleted`, `handle_atom_added`, `handle_atom_replaced`; gate the play button at lines 1357–1362.
