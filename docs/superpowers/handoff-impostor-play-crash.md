# Handoff — Impostor Bond PLAY-Crash (2026-07-15)

> Historical crash-analysis handoff. Current execution state moved to
> `docs/superpowers/handoff-traj-round4-review-gate-a.md`.

Branch: `feat/impostor-bond-mvp` (worktree `.claude/worktrees/traj-round4`).
Written by the previous session, which made real mistakes — read the "what I got
wrong" section so you don't repeat the dead ends.

## TL;DR — the ONE unsolved bug

**Impostor bonds crash the WebGL context (gl error 37442 = CONTEXT_LOST_WEBGL)
when the trajectory is PLAYED (the Play button / interval playback) — for ANY
system size, small or large. Scrubbing the slider works fine; pressing Play
crashes.**

The whole impostor Phase 1 was validated with **programmatic scrub** (setting
`slider.value` + dispatching `input` frame by frame). That path works. The
**interval-driven Play path was never cleanly tested** — that is the gap, and
that is where the bug lives.

## Current state

- Impostor Phase 1 (ray-cylinder impostor for `gpu_active` trajectory playback)
  is implemented across 8 code commits on this branch + a final-review fix
  commit + a `gl_FragColor -> out fragColor` GLSL3 fix. `pnpm check` = 0 errors;
  bonding vitest 30 passed.
- A whole-branch opus review said "Ready to merge" — **that verdict is WRONG /
  premature**: it was a diff review, and NOBODY tested Play. Do not trust it.
- Impostor renders CORRECTLY on scrub: verified on 64-atom NaCl variable-cell
  traj — `bond mesh geometry === 'BoxGeometry'` (impostor OBB active), `gl_error
  0`, smooth cylinders + per-half colour + studio_env lighting + alphaToCoverage
  AA + variable cell. Screenshot: `scratchpad/impostor-integrated.png`. So the
  impostor shaders + geometry + material integration are fundamentally sound.
- Play crashes: user reproduced on their OWN fresh GPU (not the previous
  session's trashed GPU state), small AND large systems. So it is a real
  impostor-play bug, NOT a GPU-pressure or environment artifact.

## What the previous session got WRONG (do not repeat)

1. **Task 7 verification only ever scrubbed, never pressed Play.** The entire
   "it works" conclusion rests on scrub. Play was never exercised until the user
   did. THE FIX STARTS HERE: reproduce Play, cleanly.
2. **Misdiagnosed the crash as "environment / GPU-pressure artifact"**, then as
   "big-system fill blow-up (gl_FragDepth kills early-z)". The user's
   small-system-also-crashes report **refuted the fill theory**. It is not fill,
   not size, not environment.
3. **Trashed the test GPU by repeatedly dropping the 48MB traj + scrubbing until
   CONTEXT_LOST accumulated** — once a chrome GPU process eats repeated context
   losses it stays broken and every fresh page inherits it. So mid-session "it
   crashes" readings became unreliable. **Do NOT reload+drop the big traj over
   and over. Test Play ONCE on a clean GPU, capture the error, then reason.**
4. Chased backend/forward red herrings (`Failed to list ~` is just the frontend
   hitting `http://localhost:8000` — API_BASE is direct, config.ts:20 — and is
   UNRELATED to the viewer going blank; STATIC_ONLY build silences it).

## The actual next step (what I'd do)

1. **Get the exact Play-crash error first.** F12 Console, press Play, read the
   RED line that appears at crash — is it `CONTEXT_LOST_WEBGL` / a `THREE.*`
   WebGL warning / a `drawElementsInstanced` invalid-op / a shader runtime? The
   `Failed to list ~` line is noise; ignore it. This one error picks the branch:
   - context lost with no GL error → GPU hang/OOM from a per-frame leak (mesh
     rebuild loop? attr re-alloc per frame? position-texture re-alloc?)
   - `INVALID_OPERATION` on draw → the impostor mesh/attrs are in an illegal
     state only reachable via the interval path
2. **Reproduce Play on a CLEAN GPU** (fresh chrome; do not pre-trash it). Load a
   SMALL system first (`scratchpad/npt-varcell.extxyz`, 64 atoms). Press Play (or
   drive the interval, not scrub). If it crashes on 64 atoms → pure logic bug,
   size-independent, easiest to chase.
3. **Diff the Play path against the scrub path.** Both set `current_step_idx` and
   flip `gpu_active`/`typed_direct_active`. What does interval Play do that a
   single scrub doesn't? Suspects, in order:
   - **The Finding-#1 fix** I added: the `geometry` `$derived` now tracks
     `gpu_transform_active` (as `const playing`). VERIFY this doesn't cause a
     per-frame geometry rebuild during Play (if `gpu_transform_active`/
     `typed_direct_active` identity bumps each frame under interval playback, the
     derived rebuilds the InstancedMesh every frame → GPU death). Scrub is slow
     enough to survive one rebuild; Play's continuous frames would accumulate.
     This is my #1 suspect because it's the code I touched last and Play is
     continuous where scrub is not.
   - `active_material` + `geometry` double-switch coherence under rapid frames.
   - The per-frame impostor uniform sync (`uInvProjection`/`uViewport`) timing vs
     Threlte's render loop when `is_playing`.
   - Any `is_playing`-gated effect (tail-sync, sync_structure_sites) that only
     runs during real Play, interacting with the impostor material.

## Code locations

- `src/lib/structure/bonding/BondManagerInstances.svelte`:
  - `impostor_vertex_shader` / `impostor_fragment_shader` (the shader consts)
  - `impostor_material` (glslVersion '300 es', shares 19 uniforms by ref,
    alphaToCoverage)
  - `geometry` `$derived` (returns `_unit_obb` BoxGeometry when `gpu_active`) —
    **the Finding-#1 `const playing = gpu_transform_active` tracked read is here**
  - `active_material` `$derived` (`gpu_active ? impostor_material : shader_material`)
  - the positions-sync `$effect` with the per-frame `uInvProjection`/`uViewport`
    copy (inside the untracked `gpu_active` branch)
- `src/lib/structure/bonding/bond-instanced-renderer.ts`: `sync_gpu_topology`
  (writes a_site/a_jimage/a_half/color attrs to `mesh.geometry`) and
  `#ensure_gpu_attrs` (attr alloc). Check whether the geometry swap to `_unit_obb`
  + attr re-add happens per Play frame.
- `src/lib/trajectory/Trajectory.svelte`: Play/pause (`is_playing`, the
  `setInterval` play loop ~line 1027, `go_to_step`, `pause_playback` +
  `sync_structure_sites_to_frame_positions`).

## Environment notes (avoid the traps)

- Frontend API_BASE = `http://localhost:8000` direct (config.ts:20 default,
  unless `__CATGO_RUNTIME_SERVER__` injected). A backend-fetch failure (`list ~`)
  unmounts the viewer → blank; this is SEPARATE from the Play crash.
- **STATIC_ONLY build** (`VITE_STATIC_ONLY=true pnpm exec vite build --config
  vite.desktop.config.ts`) intercepts backend fetches (returns 503, no unmount) —
  good for isolating the Play crash from backend noise. Served at `:3450` from
  `build-desktop` (may be dead by the time you read this — rebuild + serve).
- **Do not repeatedly drop the big traj / scrub-to-context-loss.** It trashes the
  chrome GPU process and poisons all later readings. One clean Play test per
  fresh GPU.

## Test assets

- `.claude/tmp-dump.traj` — 20k-atom / 52k-bond / 100-frame big traj.
- `scratchpad/npt-varcell.extxyz` — 64-atom NaCl variable-cell (small; also
  `build-desktop/small.extxyz`).
- `scratchpad/mid-traj.extxyz` — 2744-atom (medium; also `build-desktop/mid.extxyz`).
- `scratchpad/gen-{npt-traj,mid-traj}.py` — regenerate them.

## Spec / plan / ledger

- Spec: `docs/superpowers/specs/2026-07-15-impostor-bond-mvp-design.md`
- Plan: `docs/superpowers/plans/2026-07-15-impostor-bond-phase1.md`
- Progress ledger (all 7 tasks + reviews): `.superpowers/sdd/progress.md`
- Memory: `[[project_traj_round4]]` (round-4 + impostor Phase 1 summary; note the
  "Ready to merge" there is now known-premature — Play was never tested).

## Bottom line for the next session

Impostor rendering is correct (scrub proves it). The bug is specific to
**interval Play**, size-independent, crashes the GL context. Get the exact
Play-crash error, reproduce on a clean GPU with a small system, and check the
per-frame geometry-rebuild suspicion (the Finding-#1 tracked `gpu_transform_active`
read) first. Do not re-run the environment/GPU-pressure dead ends.
