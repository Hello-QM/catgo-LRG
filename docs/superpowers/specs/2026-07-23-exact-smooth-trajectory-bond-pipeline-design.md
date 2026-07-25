# Exact Smooth Trajectory Bond Pipeline — Design

**Date:** 2026-07-23
**Branch:** `feat/impostor-bond-mvp`
**Status:** Direction approved in conversation; written specification pending review

## 1. Problem

CatGo can now play the real `/home/james0001/Downloads/dump.traj`
regression much faster than the original implementation, but the remaining
path does not satisfy the user's final requirement:

- 100 trajectory frames;
- 19,968 atoms per frame;
- approximately 26,000 visible bonds;
- every displayed frame must use a complete, exact bond graph;
- playback must be smooth enough for interactive inspection.

The source ASE trajectory contains atomic numbers, positions, lattice/PBC,
time, energy, stress, and virial data, but no explicit bond topology. CatGo
must therefore infer connectivity from the current frame's coordinates and
bonding rules.

The current checkpoint reaches about 15.5 FPS during the first four seconds
and about 17 FPS at steady state on the real trajectory, compared with roughly
2.85 FPS before the trajectory work. It obtains part of that improvement by
running a complete large-frame bond refresh every eight frames and filtering
the cached graph between refreshes. That is a useful performance diagnostic,
but it is an approximation and must not become the final behavior.

The current visible path is WebGL2. It also performs redundant frame work:

1. `AtomManagerInstances.svelte` mounts a `WebGLReplicaLayer` for atoms.
2. `BondManagerInstances.svelte` mounts a second `WebGLReplicaLayer` for bonds.
3. The visible atom pass uploads current positions.
4. The visible bond pass repacks the same RGB positions into an RGBA32F
   texture and uploads them.
5. The picker maintains another atom-position buffer and another bond-position
   texture, including another RGB-to-RGBA packing loop.
6. Separate Svelte effects consume and invalidate the same render packet.

The bond impostor shader already computes exact endpoints from site indices,
current positions, lattice, and periodic-image offsets. Replacing cylinders
with another drawing primitive is therefore not the primary remaining
opportunity. The bottlenecks are exact per-frame bond inference, duplicated
position preparation/upload, and main-thread scheduling.

As a reference check, the trajectory was converted losslessly to a 103 MB
ExtXYZ file and opened in OVITO. OVITO remained responsive with its dynamic
Create Bonds modifier enabled. This demonstrates that the trajectory and bond
count are tractable, while also highlighting OVITO's architectural advantages:
native contiguous data, asynchronous preparation, bounded caching, and a
unified hardware renderer.

## 2. Goals

1. Recompute an exact bond graph for every displayed trajectory frame.
2. Display all bonds selected by the active CatGo bonding rules; do not
   decimate, hide, or silently cap the graph.
3. Never pair one frame's positions with another frame's bond graph.
4. Keep bond computation off the browser main thread during ordinary playback.
5. Upload the current frame's position data to the visible WebGL2 context once.
6. Let atom, bond, and picking passes consume one immutable displayed-frame
   snapshot.
7. Preserve bond styles, periodic-image behavior, atom selection, bond
   selection, picking, camera controls, and visual supercell semantics.
8. Keep WebGL2 as a complete default path on systems without a usable WebGPU
   adapter.
9. Reach at least 24 FPS steady playback on the established RTX 4060
   regression environment, with 30 FPS as the target.
10. Keep play, pause, and scrub responsive and recoverable under load.

## 3. Non-goals

- This design does not make WebGPU mandatory.
- It does not promise 60 FPS.
- It does not change the scientific definition of a CatGo bond.
- It does not infer or persist chemical bond orders that are absent from the
  input trajectory.
- It does not approximate topology by refreshing every N frames, applying a
  visibility budget, or skipping bonds.
- It does not eagerly retain every decoded frame and bond graph without a
  memory bound.
- It does not replace the existing ray-cylinder bond impostor merely for
  novelty.
- It does not optimize true structural edits or trajectory export.

## 4. Approaches considered

### 4.1 WebGPU-only compute and rendering

Compute the uniform-grid bond search and render atoms, bonds, and picking in
one WebGPU pipeline. This has the highest performance ceiling and can leave
connectivity on the GPU.

It is not selected for this round because WebGPU is still an experimental,
default-off overlay in CatGo, and the established browser environment did not
return a usable adapter. Making it the only route would either exclude current
users or require a second full implementation before this regression improves.

The unified frame contract in this design must remain suitable for a later
WebGPU adapter.

### 4.2 Rust/C++ WebAssembly bond engine only

Replace the current bond computation with a SIMD or threaded native-language
WebAssembly implementation while leaving the render components unchanged.
This could reduce connectivity time, especially on large cells.

It is not sufficient by itself. Atom, bond, and picking paths would still
prepare and upload the same coordinates independently, and separate reactive
effects would still compete on the main thread. WASM remains a valid second
stage if profiling shows that the asynchronous exact worker is compute-bound.

### 4.3 OVITO-style prepared-frame pipeline with one WebGL2 owner

Precompute exact graphs ahead of playback in a worker, retain a small bounded
window of complete frames, and render atoms, bonds, and picking through one
WebGL2 owner with one shared position resource.

This is the selected approach. It addresses both remaining bottlenecks, works
on the current environment, preserves exactness, and creates a clean contract
that a later WebGPU renderer can consume.

## 5. Exactness contract

A displayed trajectory frame is an atomic immutable snapshot:

```ts
type PreparedTrajectoryFrame = {
  owner: object
  generation: number
  frame_idx: number
  positions_version: number
  positions: Float32Array
  lattice: Float32Array
  bond_graph: {
    pairs: Uint32Array
    jimages: Int8Array
    kinds?: Uint8Array
    strengths?: Float32Array
  }
  bonding_rules_version: number
}
```

The concrete implementation may reuse existing render-packet types instead of
introducing this exact interface, but it must preserve these invariants:

- `positions`, `lattice`, and `bond_graph` belong to the same `frame_idx`.
- `bond_graph` was computed using the recorded `bonding_rules_version`.
- Every pair contains two valid base-site indices.
- Every periodic edge includes its exact integer `jimage`.
- A frame is not displayable until all required fields are ready.
- A changed lattice or bonding rule invalidates affected prepared graphs.
- Results from an obsolete trajectory owner or seek generation are ignored.

“All bonds” means every edge returned by the current exact CatGo CPU reference
for the same positions, lattice, PBC flags, element/site radii, and pairwise
distance rules. No display-count threshold may alter that result.

## 6. Prepared-frame pipeline

```text
indexed frame source
       |
       v
bounded decode/prefetch scheduler
       |
       v
exact bond worker
  positions + lattice + immutable atom/rule tables
       |
       v
prepared-frame queue (positions and exact graph are one unit)
       |
       v
single WebGL2 frame owner
       +--> atom pass
       +--> bond impostor pass
       +--> on-demand ID-picking pass
```

### 6.1 Worker ownership

The worker receives immutable atom/radius/rule tables once per topology or rule
version. Per frame it receives positions and lattice, computes exact
connectivity with the existing spatial-grid semantics, and returns the
positions together with compact pair and `jimage` arrays.

Transferable `ArrayBuffer` ownership is preferred over structured cloning:

1. A prefetched frame buffer moves to the worker before display.
2. The worker computes its graph while the main thread displays an earlier
   prepared frame.
3. The complete snapshot moves back to the main thread.
4. Evicted buffers return to a bounded pool where practical.

The design must not require `SharedArrayBuffer` or cross-origin isolation.
Threaded WASM may use them later as an optional capability.

### 6.2 Playback warmup and lookahead

Playback starts or resumes after a small configurable warmup window is ready.
The initial window is three frames and may adapt up to eight under measured
load. The queue remains bounded by both frame count and byte size.

During sequential playback, the scheduler always prioritizes the next missing
frame. At the end of the trajectory it respects the existing repeat behavior
without retaining an unbounded history.

If the next frame misses its presentation deadline, the player keeps the
current complete frame and its current time index visible. It does not advance
positions with stale bonds and does not silently skip a trajectory frame.

### 6.3 Seeking

A seek increments a generation token and prioritizes the requested frame.
Queued results from older seeks may finish in the worker but are discarded
when their generation no longer matches.

The last complete frame remains visible while the requested frame is prepared.
Once ready, its positions and graph become visible atomically.

Nearby prepared frames may remain in the bounded cache when their owner,
positions version, lattice, and rule version are still valid.

### 6.4 Bond algorithm

The exact worker uses a spatial cell list/uniform grid rather than an
all-pairs search for large frames. It must preserve the current reference
semantics:

- element and site radius overrides;
- pairwise bond-distance rules;
- lattice and per-axis PBC;
- minimum-image candidate discovery;
- integer periodic-image offsets;
- deterministic pair ordering and duplicate suppression.

The current eight-frame refresh cadence and intermediate stale-edge filtering
are removed from final playback.

## 7. Unified WebGL2 frame owner

The packet path must have one visible `WebGLReplicaLayer` or equivalent
coordinator per viewer, not one independently owned layer for atoms and
another for bonds.

The coordinator owns:

- one WebGL2 context;
- one current prepared-frame snapshot;
- one packed GPU position texture/resource;
- the atom pass;
- the bond pass;
- the ID-picking framebuffer/pass;
- one render invalidation per displayed packet.

### 7.1 Position resource

The existing RGBA32F position texture is the initial compatibility choice
because bond shaders already use indexed `texelFetch`. RGB positions are
packed at most once per displayed frame and uploaded once.

The atom vertex shader reads its base-site position from the same resource
instead of maintaining another per-frame instance-position upload. The bond
shader continues fetching both indexed endpoints and applying lattice and
`jimage` offsets on the GPU.

Bond topology arrays are still uploaded when the exact graph changes. “One
upload” in this design refers specifically to the duplicated position payload,
not to topology or the small lattice/camera uniforms.

### 7.2 Picking

Picking uses the same context, displayed-frame snapshot, positions, topology,
replica layout, and camera snapshot as visible rendering.

The ID pass runs on demand for pointer selection or when an already requested
pick becomes dirty. Merely playing a trajectory without pointer activity must
not repack or upload a second copy of positions for the picker.

Pick results retain the existing request-time generation checks so an async
result cannot select an atom or bond from a newer displayed frame.

### 7.3 Render invalidation

One coordinator effect consumes a new prepared frame and schedules one render.
Camera, lighting, style, selection, and replica-layout changes update only
their respective resources. They must not trigger connectivity recomputation
when positions, lattice, and bonding rules are unchanged.

## 8. Cache and memory policy

The cache is explicitly bounded. Its byte accounting includes:

- frame positions;
- lattice;
- bond pairs and `jimages`;
- optional bond attributes;
- worker in-flight buffers;
- pooled GPU-packing scratch arrays.

The currently displayed frame and the highest-priority requested frame are
protected from eviction. Other entries use a nearest-to-playhead/LRU policy.

The default three-to-eight-frame window is intentionally small. For the real
trajectory, it hides worker latency without turning a 100-frame indexed source
into an accidental eager in-memory trajectory.

## 9. Failure and recovery

- **Worker failure:** keep the last complete frame, pause playback, report the
  error, and retry through the existing exact synchronous backend when safe.
  Never fall back to an approximate graph.
- **Frame decode failure:** keep the last complete frame and surface the
  requested index through the existing trajectory error path.
- **Obsolete result:** discard it by owner/generation/version without mutating
  visible state.
- **WebGL context loss:** retain the CPU-side prepared snapshot, recreate the
  unified resources, and upload that snapshot once after restoration.
- **Memory pressure:** reduce lookahead before evicting the displayed frame.
- **Unsupported renderer feature:** stay on the complete WebGL2 path; WebGPU
  selection remains optional and atomic.

## 10. Testing

Implementation follows red-green TDD.

### 10.1 Pure and worker tests

1. Exact worker output matches the reference bond graph, including `jimage`,
   for orthogonal, triclinic, partial-PBC, and rule-override fixtures.
2. Every one of the 100 real trajectory frames matches the exact reference
   edge set and order-independent edge hash.
3. A frame cannot enter the ready queue with mismatched frame/rule versions.
4. Seek generation discards obsolete worker completions.
5. A missed deadline holds the complete current frame and time index.
6. Cache byte and frame limits are enforced under playback and repeated seeks.
7. Worker failure never installs an approximate or partial graph.

### 10.2 Renderer tests

1. The packet path mounts one coordinated WebGL2 owner.
2. One frame transition performs one position packing operation and one
   visible-context position upload.
3. Atom and bond passes reference the same GPU position resource.
4. Playback without pointer activity performs no picker position upload.
5. An on-demand atom or bond pick uses the current prepared-frame generation.
6. Styles, selection, PBC bonds, visual replicas, and context restoration
   retain current behavior.

### 10.3 Browser regression

Use the exact 100 × 19,968-atom `dump.traj` and the established browser/GPU
environment. Record:

- cold first-frame time;
- warmup time;
- first-four-second FPS;
- steady FPS;
- main-thread long tasks and frame-time percentiles;
- worker compute-time percentiles;
- position and topology upload counts/bytes;
- bond count and edge hash per frame;
- WebGL errors and context-loss events.

Compare the result with both the original roughly 2.85 FPS trace and the
current roughly 15.5/17 FPS checkpoint.

## 11. Acceptance criteria

- All 100 displayed frames have an exact bond graph matching the reference.
- No frame uses the old every-eight-frame refresh approximation.
- All selected bonds remain visible; there is no bond display budget.
- Positions and bond topology always share the same frame and rule versions.
- The visible WebGL2 context receives one position upload per displayed frame.
- The picker performs no duplicate position upload during playback without a
  pick request.
- Steady playback is at least 24 FPS, with 30 FPS as the target, on the
  established RTX 4060 regression setup.
- Playback completes the full trajectory without WebGL context loss, blank
  frames, stale bonds, or unbounded memory growth.
- Scrubbing prioritizes the requested frame and keeps the last complete scene
  visible while waiting.
- Existing targeted tests, the full frontend test suite, Python tests,
  `svelte-check`, and the real browser regression pass.

## 12. Rollout

1. Add measurement hooks and exactness tests before changing behavior.
2. Introduce the prepared-frame worker and bounded lookahead behind an internal
   feature flag.
3. Restore per-frame exact topology and validate every real frame.
4. Consolidate atom and bond passes under one WebGL2 coordinator.
5. Move picking into the same owner and make its ID pass on demand.
6. Run correctness, memory, and browser performance gates.
7. Remove the eight-frame approximation only after the exact pipeline passes.
8. Keep the prior path available for one release as a diagnostic rollback.
9. Profile the accepted result before deciding whether threaded WASM or a
   WebGPU-first follow-up is justified.
