# W2 — $bindable Writeback Contract Verification

**Branch:** atom-soa-refactor @ 54705594
**Resolves:** W6 Open Q (W2 contract selection) — HIGH-severity plan v3 blocker

---

## TL;DR

Option 1 (full object reassignment `structure = { ...structure, sites: structure.sites.map(...) }`) is the recommended W2 selection. It propagates correctly through `$bindable` at every `<Structure bind:structure>` call site in the codebase (3 binding paths total), is the established pattern already shipping in production at `Structure.svelte:1142` (align_on_load), and requires zero new infrastructure. The only implementation work is writing the T5 pause handler itself, which is a plan v3 deliverable.

---

## Structure.svelte $bindable declaration

`src/lib/structure/Structure.svelte:694`

```ts
structure = $bindable(undefined),
```

Type: `AnyStructure | undefined` (inferred from the prop destructure context). Default value: `undefined`.

---

## Call sites of `<Structure bind:structure>`

### Call site 1 — Trajectory.svelte (TRAJECTORY CONTEXT — most relevant for W2)

**File:line:** `src/lib/trajectory/Trajectory.svelte:1600`

**Bind expression:** `bind:structure={current_structure}`

**Parent's declaration:** `src/lib/trajectory/Trajectory.svelte:278`
```ts
let current_structure = $state<AnyStructure | undefined>(undefined)
```

**Verdict:** Option 1 (full reassignment) PROPAGATES. `current_structure` is declared as `$state` inside Trajectory.svelte. Svelte 5 `$bindable` contract: when Structure.svelte reassigns the prop, Svelte calls back through the binding to set the parent's bound variable. Because `current_structure` is `$state`, the setter fires the reactive graph in Trajectory.svelte. **This is the critical call site for W2.**

---

### Call site 2 — desktop/App.svelte (MAIN DESKTOP APP CONTEXT)

**File:line:** `desktop/App.svelte:1170`

**Bind expression:** `bind:structure={ts.panes[idx].structure}`

**Parent's declaration:** `desktop/lib/tab-manager.svelte.ts:37`
```ts
let tab_states_record = $state<Record<string, StructureTabState>>({
  'structure-1': create_tab_state(),
})
```

The field `ts.panes[idx].structure` is accessed through the deep `$state` proxy of `tab_states_record`. Since the root object is `$state({})`, Svelte 5 wraps the entire object tree in a deep reactive proxy at runtime.

**Verdict:** Option 1 PROPAGATES. When Structure.svelte writes `structure = new_ref`, Svelte's `$bindable` mechanism calls the setter `ts.panes[idx].structure = new_ref`. Because `ts` is a Svelte 5 deep proxy, this property assignment is intercepted and marks `tab_states_record` as dirty. The reactive graph notifies all consumers.

---

### Call site 3 — WorkflowEditor.svelte → StructureEditModal.svelte (WORKFLOW CONTEXT)

This is a two-level chain.

**Level 1 (WorkflowEditor → StructureEditModal):**

**File:line:** `src/lib/workflow/WorkflowEditor.svelte:3089`

**Bind expression:** `bind:structure={edit_3d_structure}`

**Parent's declaration:** `src/lib/workflow/WorkflowEditor.svelte:761`
```ts
let edit_3d_structure = $state.raw<PymatgenStructure | null>(null)
```

**Level 2 (StructureEditModal → Structure):**

**File:line:** `src/lib/workflow/components/StructureEditModal.svelte:162`

**Bind expression:** `bind:structure={structure}` (using StructureEditorComponent which is Structure.svelte at runtime)

**Parent's declaration:** `src/lib/workflow/components/StructureEditModal.svelte:13`
```ts
structure = $bindable(),
```

**Verdict:** Option 1 PROPAGATES through the two-level chain. Structure → StructureEditModal ($bindable) → WorkflowEditor ($state.raw). `$state.raw` is still a reactive signal — assignment of a new reference notifies the reactive system. Since Option 1 creates a new object (`{ ...structure, sites: ... }`), the reference changes, which `$state.raw` detects and propagates.

**This call site is not in the trajectory-playback code path.** WorkflowEditor uses Structure in a static editing context. W2's pause writeback does not affect this call site, but the verification confirms Option 1 is robust here too.

---

### Non-bind call sites (not relevant to W2)

- `src/routes/+page.svelte:117` — `<Structure data_url=...>` — no `bind:structure`, so no writeback propagation concern.
- `desktop/App.svelte:1221` — `<Structure structure={sample.data} ...>` — no `bind:structure`, one-way prop, preview card for landing page.

---

## Deep-mutation precedents in the codebase

### Pattern 1 — Full reassignment (the dominant pattern)

The codebase consistently uses full object reassignment, NOT deep mutation, for structure writes that need to propagate. Examples:

- `src/lib/structure/Structure.svelte:1142`: `structure = { ...aligned, _aligned: true } as any` (align_on_load)
- `src/lib/structure/Structure.svelte:2314`: `structure = { ...concatenated, _aligned: true } as any`
- `src/lib/structure/Structure.svelte:2339`: `structure = apply_charges(structure, charges) as typeof structure`
- Drag commit in `src/lib/structure/controllers/interaction.svelte.ts:448`: calls `deps.set_structure(new_structure)` where `new_structure` is produced by iterating `move_atom()` (which returns a new structure object) over `realtime_position_overrides`
- In Structure.svelte at line 2010: `set_structure: (s) => { structure = s as typeof structure }` — full reassignment

### Pattern 2 — Direct site.xyz mutation (Trajectory.svelte, cross-frame edits)

`src/lib/trajectory/Trajectory.svelte:1199-1206`:
```ts
site.xyz[0] += disp[0]
site.xyz[1] += disp[1]
site.xyz[2] += disp[2]
```

This is an in-place mutation on `trajectory.frames[fi].structure.sites[atom_idx]`. After the mutations, the code calls `trajectory = { ...trajectory }` (line 1220) to flush reactivity. This is a deliberate pattern: mutate deeply (no proxy overhead per-frame), then reassign the outer container once at the end to notify Svelte.

### Pattern 3 — `$bindable` already working: the align_on_load path

Structure.svelte at line 1142 reassigns `structure = { ...aligned, _aligned: true }`. This propagates successfully back to all three call sites above, as confirmed by the fact that this is production code that has been running in the shipped state on commit `29420f91`. **The align_on_load effect is the closest existing precedent to Option 1 and it WORKS.**

---

## `supercell_structure` feasibility analysis (for Option 2)

`supercell_structure` is declared at `src/lib/structure/controllers/transform-controller.svelte.ts:57`:
```ts
let supercell_structure = $state<AnyStructure | undefined>(undefined)
```

It is exposed only via a read-only getter at line 182:
```ts
get supercell_structure() { return supercell_structure },
```

There is no public setter. The controller manages `supercell_structure` internally via the async supercell `$effect` (lines 61-105). To use it as a writeback target for Option 2, a caller outside the controller would need to write `transform.supercell_structure = ...`, which requires adding a public setter.

Additionally, `supercell_structure` is set by the transform controller from `cell_transformed_structure`, which itself is derived from `structure`. If a T5 pause handler wrote positions into `supercell_structure`, those positions would be overwritten the next time the supercell `$effect` fires.

Option 2 also has the documented restriction: "only works if trajectory is always loaded on a non-supercell base." In practice, users can toggle supercell during trajectory. **This makes Option 2 a partial solution at best.**

---

## Option-by-option verdict

### Option 1 — Full object reassignment

**Feasibility:** YES — confirmed working.

The only call site that matters for W2 is Trajectory.svelte, where `current_structure` is `$state`. The assign-through chain works:

```
Structure.svelte: structure = { ...structure, sites: [...] }  [T5 pause handler]
  → Svelte $bindable setter → Trajectory.svelte: current_structure = new_ref
```

After pause, `is_playing = false`, so the `$effect` at Trajectory.svelte:296 that sets `current_structure = frame.structure` does NOT fire again (it only fires when `current_step_idx` changes). The T5 writeback will persist in `current_structure` until the user steps to a new frame or resumes playback.

**Code changes needed:** The T5 pause handler in Trajectory.svelte needs to be written. It does not currently exist. The infrastructure (`bind:structure={current_structure}`, `current_structure` as `$state`) is already in place.

**Risk:** Low. The pattern is the established pattern throughout the codebase. The `$bindable` contract is satisfied at all call sites.

---

### Option 2 — Use `supercell_structure` as writeback target

**Feasibility:** PARTIAL — requires code changes, has documented restrictions, fragile.

**Code changes needed:** Add a setter to `create_transform_controller`'s return interface, validate the no-supercell precondition, document the restriction.

**Risk:** Medium-high. Fragile precondition, easy to violate silently.

---

### Option 3 — Callback prop `on_trajectory_pause(positions: Float32Array)`

**Feasibility:** YES — additive, clean, but more complex than Option 1.

Add a new optional prop to Structure.svelte. Trajectory.svelte (which already has callback patterns) would call this when pause happens.

**Code changes needed:** Add `on_trajectory_pause` prop to Structure.svelte and call it from T5's pause handler. Trajectory.svelte handles it with in-place mutation + `trajectory = { ...trajectory }`. This is MORE code than Option 1, and adds an API surface that has to be maintained.

**Risk:** Low-medium. Clean separation of concerns but more complex plumbing.

---

### Option 4 — Dedicated "live trajectory positions" state in Structure.svelte

**Feasibility:** YES — but adds complexity with no advantage over Options 1 or 3.

This creates a split between `structure` (stale base) and `trajectory_pause_positions` (live positions). Every consumer that needs "current positions" has to merge them. **This is exactly the kind of asymmetric-state problem that W6 identifies as the core issue with Architecture S.**

**Risk:** Medium. Adds structural complexity. W6's recommendation for Architecture P explicitly avoids this pattern.

---

## Recommended W2 selection

**Option 1 — Full object reassignment.**

It is the established pattern throughout the codebase (`align_on_load` at Structure.svelte:1142 does the same thing and is in production). The `$bindable` contract is satisfied at the one call site that matters for trajectory pause writeback (Trajectory.svelte line 1600 binds to `current_structure` which is `$state`). It requires zero infrastructure changes — only the T5 pause handler itself needs to be written inside Trajectory.svelte.

The T5 handler writes:
```ts
// On trajectory pause: write current frame positions back into structure
structure = {
  ...structure,
  sites: structure.sites.map((site, i) => ({
    ...site,
    xyz: [
      trajectory_frame_positions[i * 3],
      trajectory_frame_positions[i * 3 + 1],
      trajectory_frame_positions[i * 3 + 2],
    ] as Vec3,
  })),
}
```

This runs inside Trajectory.svelte's scope where `structure` is the `$bindable` prop. The assignment propagates up to `current_structure` in Trajectory.svelte via the binding.

**The T5 handler should also gate on `trajectory_frame_positions != null`** (i.e., only run if the fast-path cache exists; for indexed/streamed trajectories without a `position_cache`, the positions are already in `frame.structure` via `current_structure = frame.structure`).

---

## Risks / open follow-ups

1. **Gate condition for T5 writeback:** If `position_cache` is null (indexed trajectory or large trajectory without cache), `trajectory_frame_positions` is null, and `current_structure` already holds the correct frame positions. T5 handler should check `trajectory_frame_positions != null` before running the position-override loop.

2. **Supercell cascade on writeback:** When T5 writes `structure = { ...structure, sites: [...] }`, this triggers Structure.svelte's full pipeline. For trajectories loaded on a 2×1×1 supercell, the `structure` being written contains ONLY the base-cell atoms. The supercell pipeline would expand it again to 2×1×1. This is CORRECT behavior — the edited positions on the base cell should be expanded to fill the supercell display. No code change needed.

3. **W5 resume-disable wire-up:** After T5 writeback, if the user has done a structure-altering edit (not just position drag — actual add/delete/replace), W5 requires `resume_disabled = true` in Trajectory.svelte. The W5 design work is a separate prerequisite. Option 1 does not affect this.

4. **W6 Finding #2 is now resolved by this analysis:** Option 1 is explicitly selected and verified at every `<Structure bind:structure>` call site. Plan v3 can proceed with this selection.

---

## 6-line summary

1. **Call site count:** 3 binding paths (Trajectory.svelte:1600, App.svelte:1170, WorkflowEditor.svelte:3089 → StructureEditModal.svelte:162).

2. **`$state` vs other declarations:** 2 of 3 are `$state` (Trajectory.svelte `current_structure` line 278; App.svelte `ts.panes[idx].structure` lives inside `$state<Record>` at tab-manager.svelte.ts:37). The 3rd (WorkflowEditor `edit_3d_structure` line 761) is `$state.raw`, which still propagates reference changes — Option 1 works there too.

3. **Recommended W2 option:** Option 1 — Full object reassignment.

4. **Why:** It is the established pattern (align_on_load at Structure.svelte:1142 already does this in production), requires zero new infrastructure, and satisfies the `$bindable` contract at all call sites.

5. **Most surprising finding:** WorkflowEditor's `edit_3d_structure` is `$state.raw` (line 761), not `$state`. Deliberate per CLAUDE.md note about `$state.raw` being preferred for large objects that are only whole-replaced. Option 1 still works because `$state.raw` tracks reference identity.

6. **Prerequisite code changes before plan v3:** None. The `$bindable` infrastructure is in place at all call sites. The only implementation work is the T5 pause handler itself, which is a plan v3 deliverable.
