# Indexed Trajectory Frame-Source Contract — Design

Date: 2026-07-15
Status: approach approved; written-spec review pending

## Problem

The desktop/browser import path calls `parse_trajectory_async()` for local
ASE `.traj` files. Indexed parsing reports the full frame count but
materializes only the first four frames. The returned trajectory currently
carries neither the loader nor the original binary source required to read
later frames.

The player therefore treats the indexed result as an in-memory trajectory.
For a 100-frame file, indices 0–3 work and index 4 resolves to `null`.
`Trajectory.svelte` then clears `current_structure`; `Structure.svelte`
unmounts its Canvas, and `StructureScene.svelte` deliberately loses the WebGL
context during cleanup. The observed `CONTEXT_LOST_WEBGL` is a teardown effect,
not a shader or GPU failure.

## Goal

Restore the indexed-trajectory data contract so every reported frame remains
loadable after the trajectory passes through the library and pane-cloning
paths. A missing or failed frame must leave the last valid structure visible
instead of destroying the 3D scene.

## Non-goals

- No 60 FPS work, renderer redesign, or impostor changes.
- No eager materialization of all frames.
- No base64 copy of large trajectory files.
- No unbounded decoded-frame cache.

## Chosen design

### 1. Make the indexed source explicit

Extend the runtime `TrajectoryType` contract with two optional, documented
fields:

- `frame_loader?: FrameLoader`
- `frame_source_data?: string | ArrayBuffer`

For a local indexed trajectory these fields are an atomic pair: the loader
reads from `frame_source_data`. Remote loaders may continue using an empty
string sentinel because their implementation fetches by path and ignores the
data argument.

`parse_with_unified_loader()` publishes both fields together with the four
eager frames. The `ArrayBuffer` is immutable after parsing and is retained by
reference; it is never sliced, structured-cloned, or converted to base64.

### 2. Preserve the source through pane isolation

`clone_trajectory_for_pane()` keeps the same immutable
`frame_source_data` reference while forking the mutable loader. Pane-local
transformations remain isolated exactly as today.

`TrajFrameReader.fork()` preserves the cached ASE atomic-number table. This
allows the forked loader to random-access a later ASE frame whose record omits
the unchanged `numbers` array.

### 3. Use the trajectory-owned source in the player

`Trajectory.svelte` resolves loader input in this order:

1. the trajectory's `frame_source_data`;
2. the component's existing `orig_data` compatibility state;
3. the empty-string sentinel used by remote loaders.

Both direct frame loads and idle warmup use the same resolver. The existing
component-local indexed-load path remains compatible, but it no longer owns a
separate hidden source-data contract.

### 4. Never clear a valid scene for one missing frame

On an indexed-frame `null` result or exception, the player:

1. ignores stale async completions from older frame requests;
2. keeps the last valid `current_frame` and `current_structure`;
3. pauses playback;
4. emits the existing `on_error` callback with the requested frame index.

The ordinary in-memory branch receives the same guard if a reported index is
missing. Explicit trajectory unload may still clear the structure.

## Data flow

```text
File ArrayBuffer
  -> parse_trajectory_async
  -> { eager frames 0..3, total_frames, frame_loader, frame_source_data }
  -> library entry
  -> clone_trajectory_for_pane
       shared immutable source data + forked loader
  -> Trajectory.svelte
       load_frame(frame_source_data, requested_index)
  -> keep last valid frame on failure
```

## Tests

The implementation follows red-green TDD.

1. Parser contract: a synthetic five-frame ASE trajectory is indexed to four
   eager frames, exposes loader + source data, and can load frame index 4 from
   that returned contract.
2. Pane clone: cloned trajectories share the immutable source reference but
   have distinct forked loaders; a clone can load index 4.
3. ASE fork: a fork retains enough atomic-number state to load a later frame
   that omits its own `numbers` array.
4. Missing-frame guard: a failed/null request keeps the previous valid frame,
   pauses playback, and reports an error.
5. Regression: the exact `dump.traj` displays index 4 and plays beyond the
   four-frame boundary without Canvas removal or WebGL context loss.

## Acceptance criteria

- `dump.traj` indices 0–99 are reachable; index 4 no longer blanks the viewer.
- Play crosses index 3 → 4 without removing the Canvas.
- No extra full-file copy or base64 representation is created.
- A failed frame leaves the previous structure visible and reports the error.
- Targeted trajectory tests, project checks, desktop static build, and the
  browser regression all pass.

