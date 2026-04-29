# Render-Loop Architecture Refactor — StructureScene

Branch: `atom-soa-refactor` (continuing on it; rebasing a render-loop fix
onto a 4577-line diff is conflict-hell). Atom SoA work freezes during this
refactor; resumes after.

Started: 2026-04-25
Revised after two-agent plan review.

## Goal

Eliminate the "everything looks like it works because something is invalidating
the canvas constantly" failure mode in `src/lib/structure/StructureScene.svelte`
and make the per-frame render-cost a function of *actual scene change*, not of
ambient timer/effect chatter.

Concrete success criteria, measured in Safari Web Inspector under no user
input on a static 878-atom structure with `USE_NEW_ATOM_SYSTEM = true`:

- **0 onAnimationFrame fires/second** when the user is not interacting.
- **`window.__invalidate_count` increments exactly once per scene-mutating
  user event** (verified in a Playwright test, not just by eye).
- **No `setInterval` registered for view-state polling** in the render path.
- **Energy Impact reading drops below 10% CPU** at idle on the same machine
  the user reported 71.4% on (the lag report from this session).

## The actual root cause (revised AGAIN after R1 audit)

The plan's previous "10 useTasks default to autoInvalidate=true" diagnosis
was WRONG. R1's audit (`plans/render-loop-audit.md`) found:

- StructureScene has **3** `useTask` calls, not 14.
- **All 3 already pass `{ autoInvalidate: false }`.**
- The Playwright baseline test at `tests/playwright/structure/render-loop.test.ts`
  reproduces **240 rAF callbacks/second at idle** — confirming the user's
  71% CPU report quantitatively.

So flipping autoInvalidate isn't the fix; there's nothing to flip.

The actual ambient-render sources are:

1. **Dead pulse rAF** (`StructureScene.svelte:333-345`) — runs at ~60fps the
   moment any atom is selected. Mutates `pulse_time` ($state). Has **no
   live consumer**: `pulse_opacity` is a `$derived` whose only readers were
   the `opacity` field on highlight entries, but commit `c4155f44` deleted
   the highlight rendering block that consumed those entries. Pure dead
   code that pumps the frame loop. **Delete in R3.**
2. **Polyhedra useTask** (`StructureScene.svelte:2689`) — writes
   `_polyhedra_camera_pos` and `_polyhedra_depth_range` to $state every
   frame *unconditionally*, no equality guard. Even though the useTask has
   `autoInvalidate: false`, the $state writes flow into Threlte prop
   bindings that DO auto-invalidate via the prop chain
   (`useProps.js:117`). So this useTask still pumps frames. **Add
   equality guard in R3.**
3. **Dynamic near/far useTask** (`StructureScene.svelte:1279`) — has
   equality guards on `near`/`far` but the `pixels_per_angstrom` write
   at the end is unconditional. Same prop-chain issue as #2.
   **Add equality guard in R3.**
4. **`start_ring_update_cycle` setInterval leak** — already known. Same
   class as #1: `frozen_ring_rotation` is a $state written by the timer;
   if `frozen_ring_rotation` flows to a `<T.>` prop, the prop chain
   auto-invalidates on every interval tick. **Replace in R3 with a
   `useTask({ autoInvalidate: false })` gated on `pencil_mode_active`,
   with the same equality-guard pattern as #2 and #3.**

The downstream "missing invalidate at writers" model is also real, and
R1 found it's BIGGER than the plan's previous draft assumed. **10
CORRECTNESS sites** where imperative Three.js mutations bypass the
`<T.>` prop chain and only repaint today because the ambient frame-pump
covers them. R4 wires these.

`<T.>` props DO auto-invalidate via `useProps.js:117 → invalidate()`,
which is the lever both for the ambient-pump bug (state writes flow
through the chain and invalidate every frame) AND for the missing-
invalidate fix (writes that go through props don't need explicit help).

## What `<T.>` props already do (also from plan review)

Threlte 8's `<T.>` component (`node_modules/@threlte/core/dist/components/T/utils/useProps.js`)
calls `invalidate()` on every prop update. So a Svelte template binding like
`<T.Mesh position={xyz}>` invalidates automatically when `xyz` changes.

This means the "writer must invalidate" rule applies only to:
- DOM event handlers that update `$state` consumed by `<T.>` props (the
  reactivity goes Svelte → template → Threlte's prop-watcher → invalidate;
  no additional call needed there either, *if* the `$state` write actually
  flows to a `<T.>` prop).
- Imperative Three.js mutations: direct camera writes, manual
  `instanceMatrix` writes, `ShaderMaterial` uniform updates outside Svelte
  reactivity. These bypass the prop chain and need explicit invalidate.
- `useTask` callbacks doing imperative writes (e.g. shader-uniform pulse
  animation) that should drive their own invalidate ONLY when the feature
  is active.

The `toggle_selection` and `set_hovered_idx` invalidate calls we added in
the lag-investigation patches are mostly redundant — once R3 lands, the
`<T.Mesh>` props for the new wireframe will invalidate via the
auto-invalidate prop watcher. **Plan to revert those patches in R5 once
their necessity is disproven.**

## Phases (revised)

Strict ordering: each phase is independently testable and reversible.
Skipping the wrong phase order recreates the regression we just hit.

### R1 — Targeted audit + Playwright baseline test

Files: none modified. Output: `plans/render-loop-audit.md` + one new test.

**Scope (narrowed from prior version):**
- `src/lib/structure/StructureScene.svelte`
- `src/lib/structure/AtomImpostors.svelte`
- `src/lib/structure/atoms/AtomManagerInstances.svelte`
- `src/lib/structure/bonding/BondManagerInstances.svelte`
- `src/lib/structure/controllers/*.svelte.ts`

Explicitly excluded: `Structure.svelte`, HPC panes, build-tool panes,
workflow files. Their `setInterval`/`$effect` usage doesn't drive the
canvas paint loop.

**Audit checklist per file:**
- Every `useTask` — does it pass `{ autoInvalidate: false }`? If not,
  flag CRITICAL.
- Every `requestAnimationFrame` — what does it write? If it writes
  `$state`, does the read side genuinely need 60fps? Flag CRITICAL if not.
- Every `$effect` that writes scene state (positions, materials,
  uniforms) — does it short-circuit on stable inputs?
- Every `threlte.invalidate()` call — is it paired with a real mutation,
  or is it a band-aid?

**Add the baseline test now (so R3-R6 can re-run it):**
- New file `tests/playwright/structure/render-loop.test.ts`
- Loads a structure (existing fixture)
- Asserts `window.__invalidate_count` count after specific actions:
  - Page load → some bounded count, then no growth in 1s of idle
  - Click an atom → +1
  - Hover an atom → +1
  - 1s of no input → 0 increment

Test will FAIL initially (because of the autoInvalidate defaults) — that
documents the bug. R3 makes it pass.

### R2 — Add invalidate counter (DEV only) + helper

Files modified: `StructureScene.svelte` only.

- Add at the top of the script:
  ```ts
  // DEV-only invalidate counter for the render-loop refactor. Tests assert
  // on globalThis.__invalidate_count to verify exact paint-per-mutation.
  // Wraps threlte.invalidate so every callsite goes through one place.
  function mark_dirty() {
    threlte.invalidate()
    if (import.meta.env?.DEV) {
      ;(globalThis as any).__invalidate_count = ((globalThis as any).__invalidate_count ?? 0) + 1
    }
  }
  ```
- No microtask coalescer — `invalidate()` is already idempotent within a
  frame (`scheduler.svelte.js:17-19`). Coalescer was overkill in v1 of
  this plan.
- Replace existing `threlte.invalidate()` calls in StructureScene.svelte
  with `mark_dirty()` — there are 8 of them. **This is a mechanical
  replacement; no behavior change yet.**
- Reset helper for tests: `;(globalThis as any).__reset_invalidate_count = () => { (globalThis as any).__invalidate_count = 0 }`.

Zero behavior change. Trivial review.

### R3 — Kill ambient render loops (revised after R1 audit)

Files modified: `StructureScene.svelte` only.

Four targeted changes — no broad "flip booleans" pass. Order within R3
doesn't matter; each is independent.

**3.1 Delete the dead pulse rAF** (`StructureScene.svelte:333-345`).
- Delete `pulse_time` $state, `pulse_opacity` $derived, and the rAF loop.
- Also delete the dead `opacity: pulse_opacity` field on the highlight
  entries in the `{#each}` block (they're never bound to a material).
- The `build_highlight_entries` import at L38 is also dead per the audit;
  delete that too.
- Visual effect: no change. The pulse never actually pulsed after
  c4155f44; we're just stopping the frame-pumping side effect.

**3.2 Add equality guard to polyhedra useTask** (`StructureScene.svelte:2689`).
- Wrap the writes to `_polyhedra_camera_pos` and `_polyhedra_depth_range`
  in checks: only write if values changed beyond an epsilon.
- Reuse the pattern from the dynamic-near-far useTask above it.
- Avoid per-frame allocations: compute new values into reusable scratch
  vars, compare, write only on change.

**3.3 Add equality guard to `pixels_per_angstrom` write** (`StructureScene.svelte:1279`).
- The near/far computation already has guards. Extend the same pattern
  to the `pixels_per_angstrom` assignment at the end of the same useTask.
- Skip the write when the new value equals the old to within a small
  tolerance (e.g. <0.01 px/Å).

**3.4 Replace `start_ring_update_cycle` setInterval with gated useTask**
(`StructureScene.svelte:1058,1083`).
- Delete the `setInterval`, the `update_ring_rotation` function as a
  separate symbol, and the `$effect` at L1102 that drove it.
- Add a `useTask({ autoInvalidate: false })` body that:
  - Returns early if `!pencil_mode_active`.
  - Computes the camera-facing rotation into reusable scratch
    `Quaternion`/`Vector3`/`Euler`.
  - Skips the `frozen_ring_rotation = [...]` write if all three Euler
    components are unchanged (use Math.fround equality or epsilon).
- Gate is essential: rings only render in pencil mode, so the useTask
  body should be a no-op the rest of the time.

**Test gate:** after R3 lands, R1's Playwright test must show idle
`requestAnimationFrame` count drops from 240/s to ≤2/s (compositor
warmup; 0 is ideal but a few may slip through). If not, R3 missed a
source — re-run the audit before continuing.

### R4 — Wire mark_dirty into 10 CORRECTNESS sites

Files modified: `StructureScene.svelte`, controllers under
`src/lib/structure/controllers/`, `AtomImpostors.svelte`,
`atoms/AtomManagerInstances.svelte`,
`bonding/BondManagerInstances.svelte`.

R1 named **10 CORRECTNESS sites** (read the audit doc for the table).
Each is an imperative Three.js mutation that bypasses the `<T.>` prop
chain — they appear to "work" today only because the ambient frame-pump
covers them. Once R3 lands, they'd visibly regress without R4.

Three commits, by category:

**4a — DOM event handlers in StructureScene** (`R4a`):
- Lattice-align rAF, orbit-target apply, reset-camera-up, auto-rotate
  rAF, atom interaction mesh, bond hitbox mesh — all the audit's
  CORRECTNESS sites that live in StructureScene's event handlers /
  $effects.
- Add `mark_dirty()` at each writer.

**4b — Controllers** (`R4b`):
- `controllers/interaction.svelte.ts` (the biggest controller) and any
  others with audit-flagged CORRECTNESS sites.
- Same pattern: `mark_dirty()` at the writer.

**4c — Manager components + impostor uniform updates** (`R4c`):
- AtomImpostors uIsOrthographic + light intensity uniform writes.
- AtomManagerInstances uniform sync.
- BondManagerInstances uniform sync.
- These are imperative `material.uniforms.X.value = ...` writes that
  bypass props entirely. Add `mark_dirty()` at each.

**Phase ordering: R4 lands BEFORE R3 in the commit graph.** This is
load-bearing — doing R3 first removes the ambient pump that's currently
masking the missing invalidates, and the app visibly regresses (selection
highlight invisible, hover ball missing) until R4 lands. R4 first means
R4's commits are no-ops behavior-wise (the ambient pump is doing the
work), then R3 strips the pump and R4's invalidates take over cleanly.

After R4: Playwright test passes the click/hover assertions but probably
still fails idle (the pump is still running). After R3: idle assertion
passes too.

### R5 — Audit and prune redundant invalidates

Files modified: `StructureScene.svelte`, controllers.

- For every `mark_dirty()` call added in R4 and every retained one from
  band-aids: check if the mutation it follows already flows to a `<T.>`
  prop binding. If yes, the prop chain auto-invalidates and our manual
  call is redundant — delete it.
- Likely candidates for deletion: `toggle_selection`'s
  `mark_dirty()` (the wireframe mesh below `{#each selected_sites}` is a
  `<T.Mesh>`, so its mount auto-invalidates via prop chain).
- Re-run the Playwright test after each deletion. The post-R3 baseline
  asserts +1 per click; deletion must keep that.

### R6 — Reintroduce the dropped highlight pulse animation

Files modified: `StructureScene.svelte`, possibly a new fragment shader.

**Scope correction (from plan review):** the pulse animation was
*originally connected* (commit `c4155f44` extracted
`build_highlight_entries` to `scene/picking.ts`, but the call site that
consumed it in StructureScene was deleted at the same time). The
imports at `StructureScene.svelte:38` (`build_highlight_entries`) are
dead. R6 is "restore the deleted highlight rendering block, with the
pulse driven by a shader uniform instead of `$state`".

- Read commit `c4155f44` to recover the deleted block's shape.
- Restore the `<T.Mesh>` / `<T.MeshBasicMaterial>` (or `ShaderMaterial`,
  see below) entries. The wireframe mesh stays; only the pulse mechanism
  changes.
- For the pulse: switch the highlight material from `MeshBasicMaterial`
  to `ShaderMaterial` (or use `onBeforeCompile` to inject `uTime` —
  precedent at `StructureScene.svelte:1332`). Add a single
  `useTask({ autoInvalidate: false })` that:
  - Returns early if `selected_sites.length === 0 && active_sites.length === 0`.
  - Reads `performance.now() / 1000` into the shader uniform.
  - Calls `mark_dirty()` (the one legit "animate while feature is on"
    case in this whole refactor).
- Verify the Playwright baseline still passes when no atoms are
  selected (idle = 0 increments). When atoms ARE selected, increments
  match frame rate — that's intended for an active animation.

### R7 — (Optional, deferred) Instanced highlight mesh

Files modified: `StructureScene.svelte`, possibly new
`src/lib/structure/SelectionHighlights.svelte`.

**Trigger condition (from plan review):** R7 happens **only if** R3-R6
leaves `select_all` on a 100+-atom structure above 30% CPU during orbit.
Measured against the user's actual workflow, not anticipated.

- Replace per-atom `<T.Mesh>` highlight with a single `InstancedMesh`,
  same pattern as `AtomManagerInstances`.
- File this as a follow-up issue if not triggered.

## Testing cadence

| Phase | Test                                                                                          |
| ----- | --------------------------------------------------------------------------------------------- |
| R1    | New Playwright test asserts the bug (idle invalidate count grows). Test fails — proves bug.   |
| R2    | Test still fails identically (no behavior change). Mechanical refactor only.                  |
| R3    | Test passes idle assertion (0 growth in 1s). Click/hover assertions may fail temporarily.     |
| R4    | Test passes all assertions: idle = 0, click = +1, hover = +1.                                 |
| R5    | Test still passes after each deletion. Any failure = the deletion was wrong, revert it.       |
| R6    | Test idle = 0 with no selection; idle = ~60/s with selection (intended).                      |
| R7    | Manual: select 100 atoms, orbit, confirm <30% CPU. Skip if R3-R6 already meets target.        |

## Risks and mitigations

| Risk                                                                       | Mitigation                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R3's autoInvalidate flips break a `useTask` that genuinely needed the auto-render | R1 audit names each affected task. R3 adds explicit `mark_dirty()` inside the body where needed. Playwright catches regressions. |
| R4's mark_dirty calls land in the wrong order vs R3 (visible regression repeats) | Plan explicitly orders R4 before R3 in the commit graph. Reviewers must verify this on PR.                  |
| `mark_dirty()` doesn't get used universally — future contributors call `threlte.invalidate()` directly | A grep check in CI: any non-test file under `src/lib/structure/` containing `threlte.invalidate(` outside `mark_dirty`'s definition fails CI. Cheaper than an eslint custom rule. |
| atom-soa-refactor branch's 4577-line diff causes R4 conflicts                | Refactor commits to single-shot, no rebases. Single PR for the whole render-loop work, atomic land/revert. |
| R6's shader integration is bigger than 0.5d (the `MeshBasicMaterial` swap) | R6 budget revised to 1d. If `onBeforeCompile` works, half-day; if full ShaderMaterial swap, full day.       |

## Non-goals

- Not migrating away from Threlte. The model works fine when used correctly.
- Not changing the X1-X7 atom refactor surface, except to route any
  existing `threlte.invalidate()` calls in
  `atoms/AtomManagerInstances.svelte:323,406` and
  `bonding/BondManagerInstances.svelte` through `mark_dirty()` in R2.
- Not fixing the partial-occupancy wedge / polyhedra clipping / image-atom
  opacity gaps from the atom refactor's PoC list. Those are separate.
- Not auditing `useTask` patterns in `Structure.svelte` or panes — out
  of scope.

## Commit strategy

| Commit | Phase              | Reviewable?                                                |
| ------ | ------------------ | ---------------------------------------------------------- |
| 1      | R1 audit doc + Playwright test | Yes — single markdown + single test file.        |
| 2      | R2 helper + mechanical replace of 8 invalidates | Yes — small mechanical diff.    |
| 3      | R4a event handlers in StructureScene.svelte | Yes — bounded.                       |
| 4      | R4b controllers (interaction.svelte.ts mainly) | Yes — bounded per controller.     |
| 5      | R4c template/derived bindings | Yes — bounded.                                |
| 6      | R3 autoInvalidate flips | Yes — exactly 10 boolean changes + per-task verification. |
| 7      | R5 prune redundant invalidates | Yes — each deletion guarded by re-running test.    |
| 8      | R6 shader-uniform pulse | Yes — restoration of c4155f44's deleted block + uniform.  |
| 9      | R7 (if triggered)  | Separate PR if at all.                                     |

## Timeline estimate (revised)

- R1 (audit + Playwright baseline): 1 day (revised from 0.5 — 14 useTasks
  to audit + a real test to write).
- R2 (helper + mechanical replace): 0.25 day.
- R4a/b/c (mark_dirty wiring): 1 day total across the three commits.
- R3 (autoInvalidate flips): 0.5 day. The boolean flips are fast; the
  per-task verification is the real cost.
- R5 (prune): 0.5 day.
- R6 (shader pulse, restoration): 1 day (revised from 0.5 — block
  restoration + shader uniform integration).
- R7 (instanced highlights, if triggered): 1 day, optional.

**Total: 4-5 days, sequential, single agent at a time per phase.**

## Deferred work

- Audit `useTask` and `$effect` patterns in *other* `src/lib/structure/`
  components beyond the audit scope. Same smells likely exist; file as
  follow-up.
- Codify the invalidation model as a `CLAUDE.md` section under
  `src/lib/structure/` so future contributors learn the rule.
- Migrate atom-soa-refactor's direct `invalidate()` calls to `mark_dirty`
  during R2; ensure the atom refactor's hot paths still work without
  added latency.
