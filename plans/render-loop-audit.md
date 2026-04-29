# Render-Loop Audit (Phase R1)

Snapshot of every render-loop driver in the StructureScene paint chain, taken
at branch `atom-soa-refactor` HEAD (commit 006c290d). Scope is exactly the
five files named in `plans/render-loop-architecture.md` R1 — no production
code changed in this phase.

---

## Verification of plan claims against `node_modules/@threlte/core`

| Claim from plan | File | Line | Verdict |
| --- | --- | --- | --- |
| `useTask`'s `autoInvalidate` defaults to `true` | `node_modules/@threlte/core/dist/hooks/useTask.js` | `76` (`if (opts?.autoInvalidate ?? true)`) and `83` (`if (opts?.autoInvalidate ?? true)`) | **TRUE** — coalesced default truthy via `??`. |
| `<T.>` props auto-invalidate on every change | `node_modules/@threlte/core/dist/components/T/utils/useProps.js` | `117` (`invalidate()`) inside `updateProp` | **TRUE** — every prop write calls invalidate, even ignored ones (the `if` only gates the actual setter). |
| `invalidate()` is idempotent within a frame | `node_modules/@threlte/core/dist/context/fragments/scheduler.svelte.js` | `17–19` (`invalidate() { context.frameInvalidated = true }`) | **TRUE** — it's a single boolean assignment; calling it 1000 times costs the same as 1. The `frameInvalidated` flag is reset in `resetFrameInvalidation()` (line 35). |

All three plan claims hold. **However the plan's quantitative claim that
"`StructureScene.svelte` has 14 `useTask` calls. 10 of them omit
`{ autoInvalidate: false }`" is FALSE.** See "Plan-vs-reality reconciliation"
below — there are 3 `useTask` call sites in scope, all already pass
`{ autoInvalidate: false }`. R3 as currently written is a no-op.

---

## Findings table

Severity legend (from plan): `CRITICAL` / `CORRECTNESS` / `REDUNDANT` / `OK`.
Categories: `useTask` / `requestAnimationFrame` / `setInterval` / `$effect` /
`threlte.invalidate()` / `event-handler` / `<T.> prop binding`.

| file:line | symbol | category | current behavior | required behavior | severity | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `StructureScene.svelte:333–345` | pulse animation `$effect` + rAF | `requestAnimationFrame` | When `selected_sites.length > 0 OR active_sites.length > 0`, runs a self-rescheduling rAF that does `pulse_time += 0.015` every frame. `pulse_time` is `$state`. | The rAF must die. `pulse_time` is dead state — see dead-code section. The rAF itself doesn't call `invalidate()`, but `pulse_time` is `$state`, so each write schedules a Svelte microtask; through `$derived` that's read into the (now-deleted) highlight render block, this *used to* invalidate transitively. With the consumer gone, this loop runs 60fps writing to a value nothing reads. **Even when nothing reads the state, Svelte's reactivity tick fires, and Threlte's per-frame effect ordering can pump a paint anyway** — pending verification by R2's counter, but symptomatically this is consistent with the user's "lag the moment I select an atom" report. | **CRITICAL** | The plan's R6 says "restore the deleted highlight pulse via shader uniform". Until R6 lands, **delete this `$effect` entirely**, OR gate the rAF on `selected_sites.length > 0 && pulse_consumer_alive` (currently no consumer, so it's dead). Belongs to R3's "kill ambient render loops" pass, not R6 (R6 reintroduces a *correct* pulse). |
| `StructureScene.svelte:1058,1083–1099,1102–1110` | `start_ring_update_cycle` + `setInterval` | `setInterval` | When `camera_is_moving` becomes false, starts a 1-second interval that runs 5 times. Each tick reads camera/structure rotation and writes `frozen_ring_rotation` (`$state`). | This is a 5-second polling burst after every camera-stop — for atoms with frozen indicators only. The plan's "dead code / dropped features" section calls this out as a leak we deleted in this session and that R0 reverted. | **CORRECTNESS** (the rotation update is correct) but **REDUNDANT** in pattern (polling vs reactive). | The cleanup function in the `$effect` at L1102 only fires on effect re-run / unmount, NOT when `camera_is_moving` flips back to true. So a quick stop-start-stop pattern can leave **multiple** intervals racing. Replace with a single `useTask({ autoInvalidate: false })` that bails when `camera_is_moving` OR no frozen atoms exist; that's R3's job per the dead-code section. |
| `StructureScene.svelte:1279–1312` | dynamic near/far + scale-bar useTask | `useTask` | Per-frame: reads camera position, computes new near/far, writes camera (imperative Three.js mutation), updates depth-cue uniforms, computes `pixels_per_angstrom = $state` (consumed by ScaleBar). `{ autoInvalidate: false }` ✓. | The body is correct in spirit. But it runs every frame regardless of whether camera moved. Net per-frame cost: ~10 ALU + a `$state` write. `pixels_per_angstrom` writes feed a `<ScaleBar>` prop chain → auto-invalidate fires per frame when ScaleBar is mounted. **The write itself can be the invalidate driver** when the value changed; coupled with the per-frame setter unconditionally writing the same value (Svelte 5 `$state` does NOT memoize equal writes by default), this can pump invalidates. | **CORRECTNESS** (the camera near/far update is needed for depth precision) + **possible CRITICAL** (the unconditional `pixels_per_angstrom` write needs an equality guard). | Recommended R3 follow-up: only assign `pixels_per_angstrom` when the value actually changed (`if (Math.abs(new - old) > eps)`), and only call `update_depth_cue_uniforms()` when camera moved meaningfully. The early-return on identical near/far at L1296 is the right pattern; extend to the other writes. |
| `StructureScene.svelte:2676–2685` | site-label projection useTask | `useTask` | Per-frame: when `show_site_labels OR show_site_indices`, projects each visible site's xyz into screen-space and writes DOM transforms. `{ autoInvalidate: false }` ✓. | Correct: directly mutates DOM `transform` on overlay `<div>`s. DOM mutation does NOT touch Three.js, so no Threlte invalidate is needed (and none is called). Safe. | **OK** | Cost is O(N) DOM writes per frame when labels visible; users expect that. No render-loop concern. |
| `StructureScene.svelte:2689–2707` | polyhedra camera-pos useTask | `useTask` | Per-frame: when polyhedra visible, reads camera world-pos, walks every face position, writes `_polyhedra_camera_pos` and `_polyhedra_depth_range` (`$state`). `{ autoInvalidate: false }` ✓. | These `$state` values feed `<CoordinationPolyhedra>` props, so prop-watcher invalidates when they change. **Per-frame writes always trigger invalidate** — this useTask paints every frame whenever polyhedra are shown. Polyhedra's depth-gradient *needs* per-frame updates while orbiting, but not while idle. | **CORRECTNESS** + **CRITICAL when polyhedra visible at idle** | Add an early-return: if `cam_pos === last_cam_pos`, don't reassign the state. Or move the depth-range computation into a "did camera move" gate. R3 follow-up. |
| `StructureScene.svelte:11` | `useTask` import | — | Imported. | OK — used by the 3 useTasks above. | **OK** | — |
| `StructureScene.svelte:341–343, 343` | pulse rAF inner | `requestAnimationFrame` | (See L333 row) | (See L333 row) | **CRITICAL** | Same as L333. |
| `StructureScene.svelte:858` | `sync_clear_color` deferred | `requestAnimationFrame` | `MutationObserver` callback re-runs `sync_clear_color()` on next frame. Fires only on `<html>` / `<body>` class/style mutations (theme switches). | Defers a one-shot DOM read to next frame — correct pattern. Calls `threlte.invalidate()` inside `sync_clear_color()` (L834, L841). | **OK** | Single rAF, not a loop. |
| `StructureScene.svelte:937–966` | lattice-align rAF | `requestAnimationFrame` | One-shot rAF on `lattice_align_trigger` change. Imperatively writes `camera`, `orbit_controls`. | One-shot, no loop. After camera mutation the next prop read on `<T.PerspectiveCamera>` would *not* fire (we wrote directly to the Three.js camera, bypassing props). **Needs explicit `invalidate()` after the imperative write — currently missing.** | **CORRECTNESS** | Add `mark_dirty()` at the end of the rAF (R4). Symptom: after `lattice_align_trigger` increments, view orientation only updates on next mouse move. |
| `StructureScene.svelte:1317` | `auto_focus_charge` rAF | `requestAnimationFrame` | One-shot rAF to focus an `<input>`. | DOM-only, no Three.js. | **OK** | — |
| `StructureScene.svelte:1489–1523` | vibration mode rAF loop | `requestAnimationFrame` | When `vibration_data.playing`, runs a self-rescheduling rAF that writes `realtime_position_overrides` (`$state`) every frame from a sine wave. | The state write feeds atom positions via `<AtomImpostors>` / `<AtomManagerInstances>` props → auto-invalidate fires per frame. This is the **legit "feature is on, so animate" case**. Idle: `vib?.playing` early-return, no loop. | **OK** when vibration playing; **OK** when not. | Cost is intrinsic to the feature. |
| `StructureScene.svelte:2606–2607` | label-visibility invalidate burst | `threlte.invalidate()` + `requestAnimationFrame` | When `show_site_labels OR show_site_indices` toggles on, calls `threlte.invalidate()` then schedules a second invalidate via rAF "to let Svelte create the overlay DOM, second to project". | Two invalidates per toggle. The rAF's only job is to invalidate again. The site-label useTask at L2676 needs the overlay DOM to exist before it can project — fine, but the *first* invalidate is redundant: the next paint will run the useTask anyway. | **REDUNDANT** | R5 deletion candidate after the useTask at L2676 is verified to handle the bootstrap correctly. |
| `StructureScene.svelte:2932–2935` | auto-rotate rAF loop | `requestAnimationFrame` | When `auto_rotate > 0`, runs a self-rescheduling rAF that writes `camera.position` and calls `orbit_controls.update()` (imperative Three.js, bypasses prop chain). | **Imperative camera write — no auto-invalidate.** The `orbit_controls.update()` *might* trigger a `change` event subscriber, but currently no such handler invalidates. Result: auto-rotate may pump frames via the now-CRITICAL `pulse_time` accidental invalidate, but if pulse fix lands first this becomes silent (rotation visible only on mouse move). | **CORRECTNESS** | Add `mark_dirty()` after `orbit_controls.update()` at L2930. R4. |
| `StructureScene.svelte:821, 834, 841` | `sync_clear_color` invalidates | `threlte.invalidate()` | Three call sites inside `sync_clear_color()`, each immediately after `r.setClearColor(...)`. | `setClearColor` is an imperative Three.js mutation — needs explicit invalidate. Three calls because there are three return paths. | **OK** (correct), candidate to consolidate via `mark_dirty()` in R2. | — |
| `StructureScene.svelte:1403` | depth-cue invalidate | `threlte.invalidate()` | Inside `$effect` that tracks `depth_cueing/start/end/background_color`. Calls `update_depth_cue_uniforms()` (imperative mutation of shared uniform objects) then `invalidate()`. | Correct: shared uniform `.value` writes don't go through Threlte's prop chain. | **OK** | — |
| `StructureScene.svelte:2606` | label-visibility invalidate | `threlte.invalidate()` | (See above row 2606–2607.) | (See above.) | **REDUNDANT** | R5. |
| `StructureScene.svelte:265 (handle_atom_interaction_click → toggle_selection)` | atom click → `toggle_selection` | `event-handler` | `toggle_selection` updates `selected_sites` (`$bindable`). | `selected_sites` flows back into atom_data / wireframe rendering. The downstream consumer is partially dead (the wireframe block was deleted with the highlight pulse). For the parts that still flow into `<T.>` props (e.g. cursor / outline overlays), Threlte prop-watch handles invalidate. **The R0 revert may have re-added a `mark_dirty()`/`invalidate()` here as a band-aid — to be confirmed and removed in R5.** | **CORRECTNESS** if the wireframe restoration in R6 lands; **OK** today. | Plan calls this out: "`toggle_selection` — already has `mark_dirty()` from a band-aid. Keep until proven redundant in R5." |
| `StructureScene.svelte:2032–2234` | atom shadow-sync `$effect` | `$effect` | Diffs `desired` map against `atom_manager` and applies add / remove / update calls. **Does not call invalidate** — relies on `atom_manager.version` bump being read elsewhere. | The version bump triggers `AtomManagerInstances`'s sync `$effect` at L351, which calls `threlte.invalidate()` at L406. Chain is correct. | **OK** | — |
| `StructureScene.svelte:1812–1817` | picker dirty `$effect` | `$effect` | Reads `atom_data.length`, `bond_pairs.length`, `cutting_visibility_map.size`; writes `picker.picker_dirty = true`. | Sets a flag for the GPU picker; not a render path. | **OK** | — |
| `StructureScene.svelte:1936–1996` | bond shadow-sync `$effect` | `$effect` | Diffs `filtered_bond_pairs` against `bond_manager`. Calls `mgr.add_bonds`/`remove_bonds`/`set_kind`. | No direct invalidate. `bond_manager.version` bumps wake `BondManagerInstances`'s `$effect` at L339, which calls `threlte.invalidate()` at L344. | **OK** | — |
| `StructureScene.svelte:2442–2460` | bond hitbox matrix `$effect` | `$effect` | Writes `bond_hitbox_mesh.setMatrixAt(...)` and `instanceMatrix.needsUpdate = true`. | Imperative GPU buffer write — needs invalidate. **Currently missing.** | **CORRECTNESS** | Add `mark_dirty()` at end (R4). Symptom: bond hitboxes don't update click hit-targets until next mouse move after a bond change. |
| `StructureScene.svelte:220–243` | atom interaction mesh `$effect` | `$effect` | Writes `mesh.setMatrixAt(...)` and `instanceMatrix.needsUpdate = true`. | Same as bond hitbox — imperative GPU buffer write. **Missing invalidate.** | **CORRECTNESS** | Add `mark_dirty()` at end (R4). Same symptom class. |
| `StructureScene.svelte:1456–1462` | bond connectivity `$effect.pre` | `$effect.pre` | Writes `bond_pairs = pairs`. | `bond_pairs` is `$state` consumed via `<T.>` prop chain. Auto-invalidates. | **OK** | — |
| `StructureScene.svelte:898–905` | initial Z-up | `$effect` | Imperative `camera.up.set(...)`. | Camera is owned via `<T.PerspectiveCamera up={...}>` template — but the imperative `set(0,0,1)` here bypasses the template path. **Missing invalidate** — but only fires once on mount, so the initial paint is happening anyway from the first prop pass. Borderline OK. | **OK** | Single-shot. |
| `StructureScene.svelte:910–929` | orbit-target apply | `$effect` | Calls `apply_orbit_target` → `orbit_controls.update()`. Imperative. | **Missing invalidate.** Symptom: after `center_camera_trigger` increments programmatically, target doesn't visually settle until next mouse move. | **CORRECTNESS** | Add `mark_dirty()` after `apply_orbit_target` (R4). |
| `StructureScene.svelte:1020–1031` | reset camera up | `$effect` | Imperative camera writes. | **Missing invalidate.** Same symptom class as orbit-target. | **CORRECTNESS** | Add `mark_dirty()` (R4). |
| `StructureScene.svelte:2806–2876, 2843–2876, 2883–2896` | TrackballControls config / Ctrl-disable / wheel-stop | `$effect` | Imperative writes to `orbit_controls.mouseButtons`, `orbit_controls.enabled`, etc. | These don't change visible scene state directly — they configure interactivity. No invalidate needed. | **OK** | — |
| `AtomImpostors.svelte:267–272` | ortho/perspective uniform | `$effect` | Writes `material.uniforms.uIsOrthographic.value`. **No invalidate.** | Shared uniform write — needs invalidate. Symptom: switching projection doesn't update lighting until next mouse move. | **CORRECTNESS** | Add `mark_dirty()` (R4). |
| `AtomImpostors.svelte:274–279` | light intensity uniforms | `$effect` | Writes `material.uniforms.uAmbientIntensity/uDirectionalIntensity.value`. **No invalidate.** | Same — uniform write needs invalidate. | **CORRECTNESS** | Add `mark_dirty()` (R4). |
| `AtomImpostors.svelte:349–430` | full buffer rebuild `$effect` | `$effect` + `threlte.invalidate()` | Rewrites all 5 instance attribute arrays then calls `threlte.invalidate()` at L429. | Correct: instanced-buffer-attribute writes don't go through prop chain. | **OK** | Route through `mark_dirty()` in R2. |
| `AtomImpostors.svelte:435–475` | drag fast-path `$effect` | `$effect` + `threlte.invalidate()` | Writes only positions on `realtime_position_overrides` change, calls `threlte.invalidate()` at L474 if dirty. | Correct. | **OK** | Route through `mark_dirty()` in R2. |
| `AtomManagerInstances.svelte:313–328` | renderer mount `$effect` | `$effect` + `threlte.invalidate()` | On mount, force-resyncs and invalidates. | Correct. | **OK** | Route through `mark_dirty()` in R2. |
| `AtomManagerInstances.svelte:351–407` | main sync `$effect` | `$effect` + `threlte.invalidate()` | Each version bump or modulation change → renderer.sync() / force_full_resync(); calls `invalidate()` at L406. | Correct: renderer writes go to instanced buffers, not props. | **OK** | Route through `mark_dirty()` in R2. |
| `AtomManagerInstances.svelte:422–433` | drag fast-path `$effect` | `$effect` | Writes positions to manager (which bumps version, which wakes the L351 effect, which invalidates). **Comment at L431 explicitly says "no direct invalidate() here to avoid double-scheduling".** | Correct deliberate omission. The comment is the documentation of the chain. | **OK** | — |
| `AtomManagerInstances.svelte:437–446` | uniform sync `$effect`s | `$effect` | Writes `material.uniforms.*.value`. **No invalidate.** | Same hazard as AtomImpostors:267 — uniform write bypasses prop chain. | **CORRECTNESS** | Add `mark_dirty()` (R4). |
| `BondManagerInstances.svelte:188–196` | shader uniform sync `$effect` | `$effect` | Writes uniform values + material flags. **No invalidate.** | Same hazard. | **CORRECTNESS** | Add `mark_dirty()` (R4). |
| `BondManagerInstances.svelte:204–218` | renderer mount | `$effect` + `threlte.invalidate()` | Mounts and calls `invalidate()` at L213. | Correct. | **OK** | Route through `mark_dirty()` in R2. |
| `BondManagerInstances.svelte:221–253` | color sync `$effect` | `$effect` | Writes per-slot colors via `mgr.set_colors`. No invalidate. | The version bump from `mgr.set_colors` wakes the L339 sync effect which invalidates. Chain intact. | **OK** | — |
| `BondManagerInstances.svelte:277–319` | opacity sync `$effect` | `$effect` | Writes per-slot opacities via `mgr.set_opacity`. No invalidate. | Same — version bump → L339 effect → invalidate. | **OK** | — |
| `BondManagerInstances.svelte:339–345` | main sync `$effect` | `$effect` + `threlte.invalidate()` | Reads version, calls `renderer.sync()`, then `threlte.invalidate()` at L344. | Correct. | **OK** | Route through `mark_dirty()` in R2. |
| `BondManagerInstances.svelte:347–353` | positions resync `$effect` | `$effect` + `threlte.invalidate()` | On `positions_version` / `atom_positions` change, force_full_resync + invalidate at L352. | Correct. | **OK** | Route through `mark_dirty()` in R2. |
| `controllers/interaction.svelte.ts:1339, 1423` | drag/rotation rAF batching | `requestAnimationFrame` | Both rAFs apply pending position updates by writing `realtime_position_overrides` (`$state`) once per frame during a drag/rotation. Single in-flight rAF guarded by boolean. | The `$state` write feeds `<AtomImpostors>` / `<AtomManagerInstances>` props → auto-invalidate. Correct, intentional batching for big structures. | **OK** | — |
| `controllers/*.svelte.ts` `$effect`s | various | `$effect` | Property colors, supercell, persistence, force-vector auto-enable, sphere-segment perf-mode, background-color CSS var. None mutate scene state imperatively — all flow through Svelte `$state` → props → auto-invalidate. | OK chain. | **OK** | — |

### Summary counts

- `useTask` rows: **3** (all in StructureScene; all already `{ autoInvalidate: false }`).
- `requestAnimationFrame` rows: **8** (1 CRITICAL pulse loop, 1 OK vibration loop, 1 CORRECTNESS lattice-align, 1 CORRECTNESS auto-rotate, 4 incidental one-shots / DOM-only).
- `setInterval` rows: **1** (frozen-ring update, CORRECTNESS leak risk).
- `$effect` rows touching scene state: ~30 across all files; categorized inline.
- CRITICAL: **2** (pulse loop L333, polyhedra-pos useTask L2689 when polyhedra visible).
- CORRECTNESS: **9** (lattice-align rAF, auto-rotate rAF, bond hitbox matrix, atom interaction mesh, orbit-target apply, reset-camera-up, AtomImpostors uIsOrthographic, AtomImpostors light intensities, AtomManagerInstances uniform sync, BondManagerInstances shader uniform sync — yes, that's 10; the lattice-align one is the L937 row).
- REDUNDANT: **2** (label-visibility double-invalidate L2606–2607, possible band-aids in `toggle_selection` / `set_hovered_idx` per R0 revert).
- OK (confirmations): the rest.

---

## Plan-vs-reality reconciliation

The plan's diagnosis is partially wrong. **`StructureScene.svelte` does not
have 14 `useTask` calls; it has 3, and all 3 already pass
`{ autoInvalidate: false }`.** Confirmed via `grep -nE 'useTask\(' src/lib/structure/`:

```
src/lib/structure/StructureScene.svelte:1279:  useTask(() => {
src/lib/structure/StructureScene.svelte:2676:  useTask(() => {
src/lib/structure/StructureScene.svelte:2689:  useTask(() => {
```

R3 as written ("flip 10 booleans") is a no-op against the actual code. The
**real** 71% CPU / 18 fps culprit is most likely the rAF loop at L333–345
(the dead pulse animation), because:

1. It runs at 60fps the moment `selected_sites.length > 0`.
2. It writes to a `$state` (`pulse_time`) that has no live consumer (the
   `pulse_opacity` derived chain feeds nothing — see "Dead code" below).
3. Even with no consumer, Svelte's reactivity machine still does work per
   write; combined with Threlte's `useTask` ordering and our overall
   component re-evaluation cost, this is consistent with the user's "lag the
   moment I select an atom" reading.

**Recommend revising the plan before R2/R3:**

- R3's title and scope must change from "flip 10 autoInvalidate flags" to
  "kill ambient render loops": the pulse rAF, the polyhedra-pos useTask
  unconditional state write, the per-frame `pixels_per_angstrom` write
  without equality guard, and the `start_ring_update_cycle` setInterval
  leak.
- R6's "restore the deleted highlight pulse" is unaffected — the pulse rAF
  needs deletion regardless; R6 reintroduces it driven by a shader uniform
  with proper gating.
- R4's CORRECTNESS list grows by 6 sites (see below). They were not in the
  plan's draft because the plan assumed the autoInvalidate defaults were
  hiding all imperative writes "for free".

R0's revert reportedly re-added a `mark_dirty()` / `invalidate()` band-aid
for `toggle_selection` and `set_hovered_idx`. Those are not visible in the
current source under the audit scope (the `toggle_selection` definition is
in `./scene/picking.ts`, not in the StructureScene module itself); the
band-aid would land at the call sites in StructureScene event handlers.
Plan's R5 still applies — confirm and prune those after R3/R4.

---

## The 10 useTask defaults to flip in R3

**The plan's premise here is incorrect.** There are only 3 useTask sites in
scope, and all 3 already pass `{ autoInvalidate: false }`. Listed for
completeness so R3's reviewer can verify:

| file:line | body summary | `autoInvalidate: false`? | needs explicit `mark_dirty()` after the (already-flipped) flag? |
| --- | --- | --- | --- |
| `StructureScene.svelte:1279` | dynamic camera near/far + scale-bar projection. Imperative camera mutations (`cam.near = …`, `cam.updateProjectionMatrix()`); writes `pixels_per_angstrom` (`$state`). | **already false** | Per-frame imperative camera writes need `mark_dirty()` only when the value actually changes — the code already has equality guards at L1296. The `pixels_per_angstrom` write currently has no guard; recommend adding one. After that, no `mark_dirty()` needed: the camera projection matrix update will be picked up on the next paint *if* something else triggers it. **R3 should add `mark_dirty()` after the `cam.updateProjectionMatrix()` call**, gated on the same equality guard, otherwise zooming in/out only redraws on mouse move. |
| `StructureScene.svelte:2676` | DOM site-label projection. Mutates `<div>.style.transform`. No Three.js writes, no `$state` writes. | **already false** | No `mark_dirty()` needed — DOM writes are independent of the canvas paint loop. |
| `StructureScene.svelte:2689` | Polyhedra camera-pos & depth range. Writes `_polyhedra_camera_pos` and `_polyhedra_depth_range` (`$state`) every frame *unconditionally* when polyhedra visible. | **already false** | These `$state` writes feed `<CoordinationPolyhedra>` props → auto-invalidate. Currently the writes happen every frame even when the camera hasn't moved. **R3 should add an equality guard** (e.g. compare `cam_pos` with `last_cam_pos` before assigning) to stop the per-frame paint chain when the user is idle. |

R3 in its current shape (mechanical autoInvalidate flip) cannot land. R3
must be re-scoped to the four real ambient-render-loop sources called out
in "Plan-vs-reality reconciliation" above.

---

## CORRECTNESS sites for R4

These are mutations that bypass `<T.>` prop chain and never call
`invalidate()`. R4 wires `mark_dirty()` at each writer.

| # | site | mutation type | symptom if not fixed |
| --- | --- | --- | --- |
| 1 | `StructureScene.svelte:937–966` (lattice-align rAF) | imperative `camera.position.copy / camera.lookAt / orbit_controls.update` | After `lattice_align_trigger` increments, view doesn't reorient until next mouse move. |
| 2 | `StructureScene.svelte:910–929` (orbit-target apply) | `orbit_controls.target.set / orbit_controls.update` | Programmatic recenter doesn't visually settle until next mouse move. |
| 3 | `StructureScene.svelte:1020–1031` (reset camera up) | imperative camera.up + orbit_controls.update | Same. |
| 4 | `StructureScene.svelte:2932` (auto-rotate rAF) | imperative camera.position + orbit_controls.update inside the rAF | Auto-rotate freezes between user mouse moves. |
| 5 | `StructureScene.svelte:220–243` (atom interaction mesh) | `mesh.setMatrixAt` + `instanceMatrix.needsUpdate = true` | Click hit-targets stale until next mouse move after structure change. |
| 6 | `StructureScene.svelte:2442–2460` (bond hitbox mesh) | same pattern | Bond click hit-targets stale. |
| 7 | `AtomImpostors.svelte:267–272` (ortho uniform) | `material.uniforms.uIsOrthographic.value = …` | Switching projection doesn't update fragment lighting until mouse move. |
| 8 | `AtomImpostors.svelte:274–279` (light uniforms) | shared uniform writes | Light intensity sliders don't update view until mouse move. |
| 9 | `AtomManagerInstances.svelte:437–446` (uniform sync) | shared uniform writes | Same hazard for the new atom path. |
| 10 | `BondManagerInstances.svelte:188–196` (shader uniform sync) | shared uniform writes + material flag flips | Bond opacity / brightness sliders don't update view until mouse move. |

Plus the soft-flagged R4 items the plan already mentions:

- `toggle_selection` band-aid (per R0 revert) — verify and keep until R5.
- `set_hovered_idx` band-aid — same.
- Drag-commit / gizmo-end / axis-snap — re-verify post-R3.

---

## Notes on dead code / dropped features

- **`pulse_time` / `pulse_opacity` (`StructureScene.svelte:112, 114`)** —
  declared and updated by the rAF at L333–345; consumed nowhere else in
  the file (verified: `grep -n 'pulse_time\|pulse_opacity'` returns only
  the declarations and the rAF). The plan's "highlight pulse" block was
  deleted in commit `c4155f44` along with the wireframe consumer. Until R6
  restores a shader-uniform-driven pulse, this `$state` and its rAF are
  pure overhead — and almost certainly the dominant lag source per the
  reasoning in "Plan-vs-reality reconciliation". **R3 should delete L112,
  L114, and the `$effect` at L333–345 entirely.**
- **`build_highlight_entries` import (`StructureScene.svelte:38`)** —
  imported but unused after the deletion at `c4155f44`. R6 restores the
  consumer. Safe to keep the import (unused imports are tree-shaken by
  Vite); plan calls it out.
- **`start_ring_update_cycle` (`StructureScene.svelte:1083–1099`)** — the
  `setInterval(…, 1000)` polling loop. We deleted this in this session;
  R0's revert restored it. The plan's R3 (re-scoped per above) is where
  the deletion belongs — the frozen-ring rotation should be a
  `useTask({ autoInvalidate: false })` that early-returns when no frozen
  atoms exist OR `camera_is_moving === true`, rather than burst-polling
  for 5 seconds after each camera-stop.
