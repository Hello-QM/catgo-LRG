# Trajectory Supercell GPU Impostor and Fast Bonding Design

**Date:** 2026-07-16  
**Branch:** `feat/impostor-bond-mvp`  
**Status:** Approved in conversation, including the WebGPU-first and threaded
Rust-WASM fallback amendments.

## 1. Problem

CatGo currently exposes two operations that users correctly understand as
different:

1. The bottom-right cell selector is a **visual replication**. It should draw
   more cells without changing any trajectory frame, atom count, or lattice.
2. Build → Lattice → Supercell is a **true structure edit**. It changes atom
   count and lattice and must obey trajectory edit scope (`view`,
   `edit-current`, or `edit-all`).

The current implementation mixes these semantics:

- On the WebGL trajectory path, only the first N base positions move each
  frame. CPU-materialized replicas and appended image atoms keep their
  topology-load positions. Bonds are then computed over a mixture of moving
  base atoms and frozen replicas.
- On the WebGPU large-system path, visual atom and bond instancing is already
  mostly correct, but it is a separate renderer with separate inputs and
  incomplete failure handling.
- Build supercell bypasses the trajectory scope callbacks. `view` can mutate,
  `edit-current` is not persistent, and `edit-all` does not propagate.
- Enabling large-system mode can silently turn Build supercell into visual
  replication, so a renderer choice changes edit semantics.
- Indexed trajectories can overwrite a transient expanded structure when a
  new frame is decoded.
- A true or CPU visual expansion can make the trajectory position count differ
  from the displayed atom count. This disables the typed bond worker and GPU
  impostor path, causing wrong bonds and a much slower object/cylinder path.

The exact regression file is `/home/james0001/Downloads/dump.traj`: 100 frames,
19,968 atoms per frame. A visual 2×2×2 replication should display 159,744 atom
instances without creating 159,744 JavaScript site objects or recomputing
bonds over 159,744 atoms.

## 2. Goals

1. Make visual replication view-only and correct for every trajectory frame.
2. Keep visual atom and bond replication on a GPU impostor fast path in both
   supported render backends.
3. Make WebGPU compute the primary large-system bond backend.
4. Make the non-WebGPU large-system fallback genuinely multi-threaded Rust
   WASM, not merely single-threaded WASM inside one Worker.
5. Compute visual-supercell connectivity only over the base cell. Replication
   must not multiply bond-detection work.
6. Make true Build supercell obey `view`, `edit-current`, and `edit-all`,
   including indexed trajectories, variable lattice, and variable atom count.
7. Preserve the last complete scene on load, compute, device, or transform
   failure.
8. Keep undo, export, selection, picking, and bond endpoints consistent.

## 3. Non-goals

- This round does not promise 60 FPS. It removes structural bottlenecks so a
  later profiling round can pursue 60 FPS honestly.
- It does not make WebGPU mandatory. Unsupported devices retain a correct
  WebGL2 renderer and Rust-WASM bond backend.
- It does not silently approximate a failed true structure edit.
- It does not eagerly materialize every frame of a large indexed trajectory.
- It does not preserve the existing behavior where a performance toggle
  changes Build semantics.

## 4. Approaches considered

### 4.1 Force all replication through the existing WebGPU overlay

This reuses the most mature GPU replication implementation, but WebGPU is not
universal and the overlay still lacks parity for some advanced WebGL features.
It cannot be the only path.

### 4.2 Expand replicas on the CPU, then render them with GPU impostors

This fixes only the final drawing primitive. Per-frame CPU work, memory, bond
input size, picking objects, and Svelte reactivity still grow as N×cell-count.
It does not solve the reported bug or its performance cause.

### 4.3 Shared render contract with WebGPU-first dual adapters

This is the selected design. A single immutable base topology, mutable frame
geometry, and immutable replica layout feed both backends. WebGPU is selected
for eligible large systems. WebGL2 remains a full rendering fallback, backed
by threaded Rust WASM for large bond detection. Both adapters implement the
same position, periodic-edge, picking, and export semantics.

## 5. Core render contract

New pure types live outside Svelte components so their invariants can be unit
tested.

```ts
type BaseTopology = {
  version: number
  atom_count: number
  site_ids: Uint32Array
  atomic_numbers: Uint8Array
  radii: Float32Array
  colors: Float32Array
  bond_graph?: BaseBondGraph
}

type BaseBondGraph = {
  version: number
  pairs: Uint32Array
  jimages: Int8Array
  kinds: Uint8Array
  strengths: Float32Array
}

type FrameGeometry = {
  owner: object
  frame_idx: number
  positions_version: number
  positions: Float32Array
  lattice: Float32Array
}

type ReplicaLayout = {
  version: number
  dims: readonly [number, number, number]
  boundary_policy: 'stub' | 'hide' | 'ghost-images'
  semantics: 'visual-shared-base' | 'physical-distinct-sites'
  physical_site_map?: Uint32Array
}

type RenderPacket = {
  topology: BaseTopology
  frame: FrameGeometry
  replicas: ReplicaLayout
}
```

Invariants:

- `FrameGeometry.positions.length === 3 × BaseTopology.atom_count`.
- Visual replication never changes `BaseTopology.atom_count`.
- Topology, frame geometry, and replica layout have independent versions.
- A plain frame advance uploads positions and, for variable-cell trajectories,
  nine lattice floats. It does not rebuild geometry or materials.
- A replica-factor change changes draw instance counts and uniforms. It does
  not invalidate or rerun base-cell bond detection.
- Both renderers consume the same packet. The WebGPU overlay must no longer
  reverse-read a WebGL-derived displayed-position array.

## 6. Backend selection

Backend choice is automatic and visible in diagnostics.

### 6.1 Capability order

1. **WebGPU compute + WebGPU impostor rendering** for eligible large systems.
2. **WebGL2 impostor rendering + threaded Rust WASM** when WebGPU is not
   available or an unsupported feature requires the WebGL adapter.
3. **WebGL2 impostor rendering + scalar SIMD Rust WASM** only when the browser
   cannot create a WASM thread pool.

Large systems must never fall back to main-thread JavaScript bond detection.

### 6.2 WebGPU capability probe

The probe checks all of the following before switching the visible renderer:

- `navigator.gpu` exists.
- `requestAdapter()` and `requestDevice()` succeed.
- Required storage-buffer, workgroup, texture, and instance limits satisfy the
  packet's predicted sizes.
- A small compute-and-render self-test completes without validation errors.
- No requested viewer feature would be silently lost.

The old renderer remains visible until the candidate backend has rendered a
complete frame. A switch is atomic: there must never be two visible canvases or
an empty interval between them.

`device.lost` triggers the same atomic fallback using the last valid
`RenderPacket`. It must not discard the scene owner or current frame.

### 6.3 Threaded-WASM capability probe

The threaded artifact is selected only when all of these hold:

- `crossOriginIsolated === true`.
- `SharedArrayBuffer` is available.
- WebAssembly threads/atomics are supported.
- The Rayon thread-pool initializer succeeds.
- At least two useful logical cores are available.

Otherwise CatGo loads the scalar SIMD artifact. The UI reports the active bond
backend: `WebGPU`, `Rust WASM threads`, or `Rust WASM scalar`.

## 7. Visual supercell rendering

### 7.1 Atom instancing

Visual replication keeps only base atom attributes and base positions.

- WebGPU retains its existing `instance_index → base atom + cell` decode.
- WebGL2 uses an `InstancedBufferGeometry` without an unused N×cell-count
  `instanceMatrix`. Base attributes use an appropriate divisor, while
  `gl_InstanceID` decodes the replica cell.
- The shader computes
  `position = base_position + ix·a + iy·b + iz·c` from the current frame's
  lattice.
- `instance_count = N × nx × ny × nz`; uploaded position/radius/color buffers
  remain base-sized.
- Play, pause, and scrub use the same impostor geometry and material. They do
  not reconstruct a mesh or switch between spheres/cylinders.

### 7.2 Bond instancing

Bond detection produces one `BaseBondGraph`. A bond records base endpoint
indices and the periodic image offset applied to endpoint B.

For each replica cell, the shader evaluates `cell + jimage`:

- If the neighbor is inside the visual supercell, render the complete bond to
  that real replica.
- If it is outside and the policy is `stub`, render the configured incomplete
  edge.
- If it is outside and the policy is `hide`, omit it.
- If image atoms are enabled, render a sparse ghost instance and the complete
  bond to that ghost.

Periodic self-image edges (`a === b` with non-zero `jimage`) are valid and must
not be filtered. They are required for single-atom primitive cells. Existing
filters in the object and typed conversion paths must be removed or made
policy-driven.

Image atoms are no longer appended to `displayed_structure.sites`. Both GPU
adapters consume a sparse `ImageInstanceTable(base_site, jimage)`. Ghost picks
map back to the base site.

### 7.3 Selection and picking

- WebGPU keeps its ID-buffer picker but returns `{base_site, cell, ghost}`.
- WebGL2 gains an equivalent GPU ID pass. It must not build N×cell-count
  invisible CPU sphere hitboxes.
- Selection state stores base-site IDs for visual replication. Selecting any
  replica highlights all visual replicas of that logical atom.
- Editing a visual replica edits the base atom exactly once; all its replicas
  move together.
- True Build supercells use distinct physical site IDs after materialization.

### 7.4 Export

- POSCAR/CIF/XYZ and structure bridge export ignore visual replication and
  export the base frame and base cell.
- PNG/video capture the visible replicated scene.
- A future explicit “materialize visual supercell” command may convert the
  view into a true edit, but implicit materialization is forbidden.

## 8. Fast bond computation

### 8.1 Current baseline

The current large WebGL trajectory path normally uses
`detect_bonds_radii_typed` inside one browser Worker. The implementation is
Rust WASM with a spatial cell list and typed-array transfer, but the canonical
WASM build uses `--features wasm --no-default-features`, so Rayon is disabled.
It is off the UI thread but internally single-threaded.

The checked-in 19,683-atom benchmark on the current machine measured:

```text
PBC TTT: median 24.1 ms
PBC FFF: median 16.2 ms
```

This is a useful fallback baseline, but 24.1 ms already exceeds a 16.7 ms
60-FPS frame budget before rendering and UI work.

### 8.2 WebGPU primary path

WebGPU runs clear-grid, bin-atoms, detect-bonds, indirect-count, and bond draw
on one command encoder. The pair buffer stays on the GPU; there is no
per-frame CPU readback before drawing.

Required corrections to the existing path:

1. Replace the current large-N small/thin-cell O(N²) fallback. Periodic grid
   dimensions 1 or 2 must use modulo-neighbor-cell deduplication and the
   necessary image span, or route to threaded WASM. N≈20k may never enter an
   all-pairs × 27-images shader.
2. Detect `MAX_PER_CELL` overflow. Grow/replan and rerun, or fail explicitly;
   never silently drop atoms and bonds.
3. Detect pair-buffer overflow. Grow and rerun within a bounded limit, or fail
   explicitly; never silently clamp a chemically incomplete graph.
4. A replica-only factor change updates indirect draw counts but does not rerun
   base bond detection.
5. Camera, background, selection, and hover changes never rerun detection.
6. Positions, lattice, topology, strategy, distance rules, or bond options do
   invalidate the appropriate base graph.

### 8.3 Genuine multi-threaded Rust-WASM fallback

CatGo ships two ferrox WASM artifacts:

- `ferrox-threaded`: WASM threads + SIMD + Rayon, initialized through
  `wasm-bindgen-rayon` inside one coordinating Worker.
- `ferrox-scalar`: the current portable SIMD, single-thread build.

The threaded build activates the existing Rayon cell-list branch in
`neighbors.rs` and also parallelizes the bond predicate/collection stage in
deterministic chunks. Results merge in stable center-index order so bond IDs,
selection, and snapshots remain deterministic.

Thread count is bounded to leave one logical core for the UI and is capped to
avoid oversubscription. Small structures remain scalar when thread scheduling
would cost more than the calculation.

Both variants use the typed interface:

- input: transferred/shared positions, atomic numbers, lattice, PBC, options;
- output: pairs, images, lengths, and strengths typed arrays;
- no structure JSON or per-bond JavaScript object creation on the hot path.

For large N, failure of both threaded and scalar Rust backends disables bonds
with an actionable error. It does not execute the existing main-thread JS
fallback.

All production build workflows must use the same explicit feature set. A
workflow that accidentally compiles default Rayon without atomics and thread
pool initialization is invalid and must fail CI.

### 8.4 Scheduling and cache

The cache key includes frame owner, frame index, position revision, lattice
revision, topology version, strategy, options, and distance-rule revision.

- Cache hits are O(1).
- Playback keeps at most one active request plus one latest pending request per
  backend, with bounded neighbor prefetch.
- Stale generation results populate only the correct cache entry and never
  replace a newer displayed frame.
- A visual replica-factor change reuses the same base graph.
- A newly created true supercell with intact replication provenance lifts the
  base graph across cells without rerunning distance detection. An edit that
  breaks translational equivalence invalidates that fast path.

## 9. True Build supercell

### 9.1 Explicit operation channel

Build no longer infers a supercell from an arbitrary structure replacement.

```ts
type IntMatrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
]

type SupercellOp = {
  kind: 'supercell'
  matrix: IntMatrix3
  reorient: boolean
}

type SupercellRequestResult =
  | { status: 'applied'; history_token: string }
  | { status: 'rejected'; message: string }
  | { status: 'stale' }
```

`LatticePane` delegates to `on_supercell_request` before local mutation,
`on_push_undo`, or any renderer-specific shortcut. `Structure` passes the
request to `Trajectory`. Standalone `Structure` keeps a local executor through
the same operation type.

### 9.2 Scope semantics

- `view`: reject true supercell without changing structure or history. Explain
  that the bottom-right control is available for view-only replication.
- `edit-current`: capture the owner and frame index at request time, then apply
  only to that frame. Scrubbing during async work cannot retarget the result.
  Continuous play and interpolation are disabled because topology differs.
- `edit-all`: apply immediately to the current frame and lazily to other
  frames. Every frame uses its own positions, species, atom count, and lattice.
  Uniform topology may resume playback once caches are ready. Variable N uses
  discrete scrub only.

`large_system_mode` selects a renderer only. It never changes these rules.

### 9.3 Ordered scoped ledger

Each pane owns an ordered operation ledger over an immutable base source.

```ts
type OpScope = { kind: 'all' } | { kind: 'frame'; frame_idx: number }

type LedgerEntry = {
  id: string
  seq: number
  scope: OpScope
  op: TrajectoryEditOp
  active: boolean
}
```

The loader clones a decoded base frame once, applies active matching entries in
sequence order, and caches the effective frame by `(frame_idx, ledger_revision)`.
This preserves operation order: current-only A followed by all-frame B applies
A→B to the target frame and B to every other frame.

All frame consumers use one `resolve_effective_frame()` API. Viewer, warmup,
bonding, save, and export must not mix raw loader frames with already transformed
`trajectory.frames`, which would risk missing or double-applying an operation.

### 9.4 Executor and transaction

The canonical executor validates:

- 3×3 finite integer matrix;
- non-zero determinant;
- source frame has a lattice;
- predicted output count is within an explicit limit;
- output count equals `N × abs(det(matrix))`.

Large transforms run in a Worker and publish atomically. Each frame uses its own
lattice. Reorientation transforms Cartesian vectors such as forces consistently
with positions and lattice.

Every successful operation also records immutable `SupercellProvenance`:
source frame identity, source atom count, matrix, cell ordering, and the
`(base_site, cell) → physical_site` map. While that provenance remains valid,
the scientific structure is fully materialized for editing/export, but its
render packet keeps the pre-operation base topology plus a
`physical-distinct-sites` replica layout. The renderer therefore derives
positions and lifts base bonds on the GPU while picking still returns unique
physical site IDs.

Moving, deleting, replacing, or adding an individual physical replica breaks
translational equivalence. That edit invalidates the provenance before it is
committed; the frame then publishes its fully materialized topology and runs
normal WebGPU or threaded-WASM bond detection over the edited physical sites.
There is no stale base-graph reuse after symmetry-breaking edits.

On commit, CatGo invalidates:

- position and force caches;
- effective-frame LRU;
- current typed frame buffers;
- topology initialization;
- all affected bond caches;
- warmup generation.

It then republishes the captured effective frame and bumps the trajectory
position/topology version.

### 9.5 Undo and redo

Visual replication has view-state history only and does not enter structure
undo.

Each true supercell is one external history transaction:

- Indexed trajectories toggle a ledger entry active/inactive and bump revision.
- In-memory current scope stores the replaced frame reference.
- In-memory all scope stores immutable pre-operation frame references for
  materialized frames; untouched frames require no restoration.
- Undo/redo clears the same derived caches as commit.

## 10. Error handling

Every async operation captures trajectory owner, frame index, mode, and ledger
revision. Before publication it verifies that token against current state.

On frame decode, transform, bond compute, GPU allocation, or device failure:

- preserve the last fully rendered scene;
- stop playback if correctness cannot be maintained;
- do not advance frame owner, operation cursor, or ledger revision;
- keep the operation undoable;
- report the backend and exact failing frame;
- never publish an untransformed raw frame as if the operation succeeded.

Backend fallback is transactional: prepare from the same `RenderPacket`, render
one complete candidate frame, then swap visibility and dispose the old backend.

## 11. Export semantics

- Visual replication never changes scientific structure export.
- True current-scope Build export reflects only that frame.
- True all-scope export resolves every requested frame through the ledger.
- Indexed XYZ export becomes an async effective-frame iterator rather than
  slicing only preloaded `trajectory.frames`.
- Video/PNG exports drive the normal effective-frame display path and therefore
  inherit the same owner, lattice, replica, and bond correctness.

## 12. Verification

### 12.1 Pure and component tests

Unit tests cover:

- `base_position + ix·a + iy·b + iz·c` for fixed and variable cells;
- base/display ID mapping;
- periodic self-image edges;
- internal, stub, hidden, and ghost boundary bonds;
- no bond-detector invalidation on a replica-only change;
- WebGPU grid dimensions 1/2 without O(N²);
- cell and pair overflow handling;
- backend capability decisions;
- threaded/scalar WASM deterministic equality;
- scoped ledger order, undo, variable cell/N, and stale owner rejection;
- base versus true-supercell export.

Component tests cover:

- `view`, `edit-current`, and `edit-all` Build behavior;
- atomic WebGPU/WebGL backend switching;
- device-loss and worker-failure scene retention;
- visual selection/picking and factor reset;
- indexed frame races and lazy operation replay.

### 12.2 Exact trajectory browser matrix

Use `/home/james0001/Downloads/dump.traj` and verify:

- user-visible frames 5 and 99;
- 5→99→5 rapid seek;
- play, pause, and scrub;
- 1×1×1, 2×1×1, and 2×2×2;
- WebGPU primary and forced WebGL2/WASM fallback;
- replica displacement equals base displacement;
- bond endpoints remain attached to their corresponding atom instances;
- exactly one visible canvas, no context loss, no stale owner, no NaN, and no
  out-of-range bond endpoint.

### 12.3 Performance and resource gates

- Visual per-frame CPU upload remains O(N+B), not O((N+B)×cell-count).
- Visual bond detection runs over N base atoms for every replica factor.
- Switching 1×→2×→8× changes draw instances but leaves detector workgroups,
  pair/grid buffer sizes, and compute dispatch count unchanged.
- N≈20k must never enter a WebGPU O(N²) path.
- All overflow flags are zero or trigger a visible retry/failure; none are
  ignored.
- No 159,744-site JavaScript/Three/Svelte object graph is built for visual
  2×2×2.
- No 100×N×cell-count frame cache is allocated.
- Visual factor switches and random seeks create no main-thread task longer
  than 500 ms.
- Three cycles of 1×→2×→8×→1× and 5↔99 do not monotonically grow canvas,
  device, buffer, Worker, listener, or timer counts.
- On a cross-origin-isolated machine with at least four logical cores, the
  warmed threaded-WASM 19.7k PBC benchmark median must be no more than 75% of
  the scalar-WASM median. Both outputs must be byte-for-byte equivalent after
  deterministic normalization.
- WebGPU timestamps record clear/bin/detect separately from bond draw. Same-
  device performance regressions above 20% fail the performance suite.
- 60 FPS is measured and reported but is not a completion gate for this round.

## 13. Implementation boundaries

The work is split into independently testable units:

1. Pure `RenderPacket`, replica math, periodic-edge reference, and backend
   capability policy.
2. WebGPU bond-compute correctness: thin cells, overflow, dirty flags, device
   loss, and diagnostics.
3. Threaded/scalar ferrox WASM builds, worker orchestration, typed API, and
   benchmarks.
4. WebGL2 atom/bond replica impostors and GPU picking.
5. Visual-supercell integration and removal of CPU replica/image-site
   materialization from trajectory rendering.
6. Explicit `SupercellOp`, scope callback, ledger resolver, transactions, and
   export iterator.
7. Cross-backend component tests and exact `dump.traj` browser verification.

No unit may change the semantic meaning of another unit's operation. In
particular, renderer selection cannot change edit scope, and trajectory scope
cannot select a chemically different bond predicate without an explicit,
reported policy.

## 14. Acceptance summary

The work is complete only when:

1. Visual expansion never mutates frames or cell and never freezes replicas.
2. Visual atoms and bonds stay on GPU impostors through play, pause, and scrub.
3. Visual replication does not multiply bond-detection work.
4. WebGPU is the primary eligible large-system backend.
5. The non-WebGPU large-system fallback uses a real Rayon WASM thread pool when
   the platform supports it; scalar WASM is the explicit last compatibility
   tier.
6. Build supercell strictly follows `view/current/all` and survives indexed
   scrubbing, undo, and export.
7. Variable cell, variable N, periodic self-edges, image ghosts, and bond
   endpoints are correct.
8. Failures retain the last complete scene and never silently publish partial
   data.
9. The exact 100×19,968 trajectory passes the browser matrix with no context
   loss or blank frame.
