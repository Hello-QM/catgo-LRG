# PR 531 real-trajectory performance handoff

Date: 2026-07-22 PDT
Worktree: `/home/james0001/project/catgo-LRG/.claude/worktrees/traj-round4`
Branch: `feat/impostor-bond-mvp`
Performance checkpoint: `11e0c63c` (`fix(trajectory): stream compact positions for smooth playback`)

## Outcome

The original PR 531/537 rendering fix removed per-frame WebGL buffer allocation, but it did
not fix real playback speed. On the user's exact 100-frame, 19,968-atom trajectory, the
branch still ran at about 2.85 FPS with a requested 20 FPS and could grow beyond 2 GB of JS
heap.

The performance checkpoint moves streamed playback onto compact Float32 position
packets, keeps topology static, limits bond-cache memory and bond refresh cadence, avoids
hidden UI/map work, lazy-loads plot metadata, and rate-limits viewer manifests.

On a clean isolated Chrome context with the same file:

- First 4-second pass: 62 frames, 15.49 FPS actual at a requested 20 FPS.
- Steady 3-second pass: 51 frames, 17.00 FPS actual.
- WebGL: `isContextLost=false`, `gl.getError()=0`.
- GL churn over the first pass: 4 `createBuffer`, 4 `bufferData`, 0 `deleteBuffer`,
  348 `bufferSubData`; buffer creation is startup-only, not per frame.
- Playback heap in the first pass: 701 MB → 834 MB; a later steady pass included GC and
  decreased by 108 MB. No repeat of the prior multi-GB monotonic growth was observed.
- Viewer manifest traffic fell from roughly one or more POSTs per frame to 6 POSTs over
  the 4-second playback plus pause.
- A paused jump to frame 80 completed with the WebGL context intact and GL error 0.

This is a real improvement of about 6×, but it is not a locked 20 FPS. The remaining cost is
mostly updating and drawing 19,968 atoms plus roughly 26,000 live bonds; pause writeback is
still about 80 ms.

## Exact real test input

- File: `/home/james0001/Downloads/dump.traj`
- Size: 48,149,637 bytes
- SHA-256: `38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c`
- Frames: 100
- Atoms/frame: 19,968
- Composition: Si6144 Pt256 O13568
- Typical detected bonds/frame: about 26,000
- Test GPU: NVIDIA GeForce RTX 4060 Laptop GPU through ANGLE/OpenGL 4.5
- Viewer setting: 1×1×1, structure view, requested 20 FPS

## PR synchronization and merge recommendation

| PR | Remote state | Synced commit | Recommendation |
|---|---|---|---|
| #537 | MERGED into `feat/impostor-bond-mvp` | `b247708a` | Done; no separate merge action remains. |
| #538 | MERGED into `main` | `27e6c786` | Done; local `main` and `origin/main` both point here. |
| #531 | OPEN against `main` | performance checkpoint `11e0c63c` | Keep open after push. Wait for CI and the planned GPU-side bond endpoint/update follow-up before final merge evaluation. |

`git fetch --prune origin` was run. The root worktree was fast-forwarded earlier and remains
at `main == origin/main == 27e6c786`. Its pre-existing dirty files were preserved.

## Why PR 537 alone was insufficient

PR 537 correctly stopped repeated WebGL object creation. The remaining bottlenecks were
above the GL allocation layer:

1. Every streamed frame expanded 59,904 coordinates into nested JSON, site, species, and
   xyz objects on the server and browser.
2. Svelte deep-proxied the large current frame and rebuilt 19,968-entry UI position maps.
3. Plot metadata scanning started even when only the structure viewer was visible.
4. A 512-frame bond-connectivity cache could retain approximately gigabytes for frames
   with about 26,000 bonds.
5. Bond detection ran for every displayed frame.
6. Viewer manifest publication performed network/JSON work on every playback frame.

Zero GL allocation churn therefore did not imply a smooth trajectory hot path.

## Implemented patch

### Streamed frame transport

- `server/catgo/routers/trajectory_stream.py`
  - Adds `GET /api/trajectory/positions`.
  - Returns a versioned `CGTP` binary packet containing frame number, flags, 3×3 lattice,
    and raw little-endian Float32 positions.
  - Marks element/topology changes so the client can fall back to a full frame.
- `src/lib/trajectory/remote-frame-loader.ts`
  - Parses position packets without constructing site objects.
  - Uses approximately 4 MiB request batches and a 64 MiB compact-position cache budget.
  - The real input uses 16-frame batches; all 100 compact frames fit comfortably.
  - Keeps full JSON frame loading for edit/export/topology fallback paths.
- `src/lib/trajectory/index.ts`
  - Adds `FramePositionData`, `load_frame_positions`, and lazy plot-metadata contracts.
- `src/lib/trajectory/frame-loading.ts`
  - Reuses the initial topology structure with compact positions when the operation ledger
    has no matching structural edit.
  - Falls back to fully materialized frames for changed topology or loader failure.

### Playback hot path

- `src/lib/trajectory/Trajectory.svelte`
  - Stores `current_frame` with `$state.raw`.
  - Publishes compact position/force/lattice arrays directly.
  - Skips full-frame warmup for packet loaders.
  - Starts plot metadata only when a plot display mode is actually opened.
  - Writes compact variable-cell lattice parameters back correctly on pause.
  - Publishes remote viewer manifests in 10-frame buckets while playing and immediately
    publishes the exact frame on pause.
- `src/lib/structure/StructureScene.svelte`
  - Separates static atom maps from live positions.
  - Builds the large live position map only while selection/hover/interaction needs it.
- `src/lib/structure/bond-computation-controller.svelte.ts`
  - Caps cached connectivity by 100,000 retained bonds in addition to frame count.
  - For large trajectories, recomputes connectivity every 8 displayed frames and reuses
    compatible connectivity between refreshes.
  - Existing stale-distance filtering removes visibly stretched bonds between refreshes.
  - Small structures retain their existing exact refresh behavior.

## Verification

Fresh verification after the implementation:

- Full frontend Vitest suite: 1,076/1,076 suites passed; 4,932 tests passed,
  53 skipped, 0 failed.
- Focused trajectory/performance/viewer tests: 53/53 passed.
- PR 537 WebGL replica/manager/picking/layout suite: 103/103 passed.
- Python trajectory binary/lattice tests: 4/4 passed.
- `svelte-check`: 0 errors, 304 pre-existing warnings.
- `git diff --check`: passed.
- Real browser playback: context stable, GL error 0, steady 17.00 FPS.

Commands:

```bash
pnpm exec vitest run

pnpm exec vitest run \
  tests/vitest/trajectory/frame-loading.test.ts \
  tests/vitest/trajectory/remote-frame-cache-budget.test.ts \
  tests/vitest/structure/trajectory-ui-position-map.test.ts \
  tests/vitest/structure/trajectory-bond-refresh-budget.test.ts \
  tests/vitest/structure/trajectory-bond-pairs.test.ts \
  tests/vitest/trajectory/traj-bond-scheduling.test.ts \
  tests/vitest/viewer-registry.test.ts

pnpm exec vitest run \
  tests/vitest/structure/gpu/webgl2-replica-atom-resize.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-managers.test.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/scene/replica-layout.test.ts

python -m pytest -q \
  server/tests/test_trajectory_stream_binary.py \
  server/tests/test_trajectory_stream_lattice.py

pnpm exec svelte-check --tsconfig ./tsconfig.json
git diff --check
```

## Commit scope and pickup instructions

The source, tests, and `AGENTS.md` discovery note are committed in `11e0c63c`. This handoff
is a documentation-only follow-up. The commits intentionally exclude local harness artifacts:

- `.claude/tmp-dump.traj`
- `.claude/gate-approvals/`
- `.superpowers/`

After pushing:

1. Wait for PR 531 CI and review.
2. Repeat one clean-browser real-file run on the normal full backend, not only the isolated
   trajectory-router backend.
3. Implement the GPU-side bond endpoint/update path as a separate commit so its performance
   and visual correctness can be compared directly with `11e0c63c`.
4. Keep PR 531 open until the real-file acceptance run is satisfactory.

## Known trade-off / next optimization

Large-trajectory bond connectivity is exact on refresh frames and reused for up to seven
intermediate frames. The stale-distance filter prevents obviously invalid cylinders, but
very fast bond formation can appear a few frames late. If a locked 20 FPS is required,
the next highest-value step is a GPU-side bond endpoint/update path or an explicit
"performance playback" option that lowers bond refresh frequency without changing atom
motion.
