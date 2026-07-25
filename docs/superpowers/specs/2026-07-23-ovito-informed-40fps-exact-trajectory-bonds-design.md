# OVITO-Informed 40 FPS Exact Trajectory Bonds — Design

**Date:** 2026-07-23
**Branch:** `feat/impostor-bond-mvp`
**Status:** Direction approved in conversation; committed design pending review
**Extends:** `2026-07-23-exact-smooth-trajectory-bond-pipeline-design.md`

## 1. Objective

The completed exact prepared-frame pipeline displays all 100 frames of the
reference trajectory with byte-for-byte exact bond graphs and exceeds the
original 24 unique-presented-FPS acceptance floor. Its measured performance on
the established RTX 4060 Laptop GPU environment is:

- first four-second unique-presented FPS: 28.49;
- steady unique-presented FPS: 25.72;
- exact bond compute median / p95: 11.41 / 41.92 ms;
- frame-time p95: 50.66 ms;
- renderer-scheduled topology uploads: 322 calls and 449,757,306 bytes;
- position uploads: 322 calls and 105,512,960 bytes;
- exact displayed graphs: 100/100;
- WebGL context losses and GL errors: zero.

This follow-up raises both first-segment and steady playback to at least 40
unique presented FPS without changing scientific bond semantics, dropping
frames, hiding bonds, or pairing one frame's positions with another frame's
graph. Sixty FPS remains a stretch target, not the first acceptance threshold.

The reference remains:

```text
/home/james0001/Downloads/dump.traj
SHA-256: 38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c
100 frames × 19,968 atoms
```

## 2. Source and trajectory audit

### 2.1 Pinned OVITO Basic source

The audit used OVITO Basic commit:

```text
0b2cdccef7452bf28212e15daf9df2dc7a545bcc
OVITO Basic 3.15.5
```

Relevant upstream files:

- `src/ovito/particles/modifier/modify/CreateBondsModifier.cpp`
- `src/ovito/particles/util/CutoffNeighborFinder.{h,cpp}`
- `src/ovito/particles/objects/BondsVis.cpp`
- `src/ovito/core/rendering/CylinderPrimitive.h`
- `src/ovito/opengl/OpenGLCylinderPrimitive.cpp`
- `src/ovito/opengl/OpenGLShaderHelper.{h,cpp}`
- `src/ovito/core/dataset/pipeline/PipelineCache.{h,cpp}`
- `src/ovito/core/dataset/scene/SceneAnimationPlayback.cpp`

OVITO's repository-level `LICENSE.txt` states that each implementation source
file may be redistributed and modified under GPLv3 or, at the recipient's
option, the MIT License. Each audited implementation file repeats that
dual-license notice. Any code adapted into CatGo must use the MIT option,
retain the OVITO copyright and permission notice, identify the pinned source
commit, and record material changes.

### 2.2 What OVITO actually does

The audit does not show a persistent cross-frame Verlet neighbor list in the
Create Bonds modifier:

- each modifier evaluation constructs a fresh `CutoffNeighborFinder`;
- the finder builds a spatial bin grid and deterministic per-bin linked lists;
- particles are evaluated in parallel and partial bond vectors are flattened;
- the visual layer prepares geometry in a background thread;
- an ordinary bond is expanded into two half-cylinder instances;
- the OpenGL renderer draws instanced boxes or geometry-shader points and
  performs analytic ray-cylinder intersection in the fragment shader;
- immutable data-buffer identity is part of renderer cache keys, avoiding
  redundant CPU geometry generation and GPU upload when inputs are unchanged;
- animation playback waits for every visible viewport to report completion
  before scheduling the next frame;
- optional all-frame pipeline precomputation exists but is disabled by default.

OVITO's advantage is therefore not a hidden approximate topology shortcut. It
comes from native contiguous buffers, background preparation, parallel native
work, immutable resource identity, and direct OpenGL resource caching.

CatGo already has the corresponding high-level rendering ideas: one shared
position texture, instanced half-bond impostors, analytic fragment depth, a
prepared-frame queue, and truthful unique-frame presentation. Copying the
OVITO renderer wholesale would not remove CatGo's remaining per-frame WASM
construction and browser topology-expansion costs.

### 2.3 Reference trajectory characteristics

ASE inspection of the real file shows:

- arrays: `numbers`, `positions`;
- no explicit bond topology;
- no atom/site identifier array;
- three-axis periodic boundaries;
- the same 19,968 atomic-number entries in every frame;
- an exactly unchanged lattice across the 100 frames;
- no observed change of integer fractional wrap bins between adjacent frames.

However, the maximum minimum-image displacement of any atom between adjacent
frames is large:

```text
median of per-step maxima: 13.43 Å
p95 of per-step maxima:    16.88 Å
maximum:                    19.12 Å
```

A globally exact Verlet candidate list with a useful skin would therefore be
invalidated on every frame. Increasing the skin enough to retain the list
would make the candidate set too large to be useful. Persistent Verlet reuse
is rejected as the primary optimization for this trajectory.

The absence of atom IDs also means that a file which silently permutes
same-element atoms cannot have the original cross-frame identities recovered
from this format. Exact per-frame bond detection remains well-defined because
it uses only the current frame. The optimized path must not depend on
cross-frame atom identity.

## 3. Decisions

The selected design has two mandatory implementation stages:

1. a persistent, allocation-reusing exact Rust/WASM cell-list session;
2. a compact per-bond WebGL2 topology layout shared by visible rendering and
   picking.

After both stages, the real gate runs. If either measured segment is below 40
unique presented FPS, implementation continues through the measured
contingency path in section 10 rather than declaring completion.

The following are explicitly rejected for the first implementation:

- **Persistent global Verlet candidates:** every-frame invalidation on the
  reference trajectory.
- **Port OVITO's pointer-linked cell list verbatim:** CatGo's current CSR/SoA
  cell list is better suited to WASM linear memory, deterministic traversal,
  SIMD, and reduced pointer chasing.
- **Cache all 100 prepared frames:** unnecessary memory growth and poor
  behavior for longer trajectories.
- **Make WebGPU mandatory:** the exact WebGL2 path must remain complete on
  systems without a usable adapter.
- **Relax exactness:** no refresh cadence, distance-only stale filtering,
  topology budget, truncation, or skipped presented frames.

## 4. Persistent exact trajectory bond session

### 4.1 Ownership

The bond worker owns one live Rust/WASM trajectory bond session for its current
trajectory topology fingerprint. The JavaScript worker session and Rust
session have the same lifetime:

```text
trajectory load / topology segment
  -> initialize worker session
  -> initialize Rust TrajectoryBondSession
  -> compute zero or more exact frames
  -> invalidate on topology/rules change or worker death
```

Ordinary frame computation calls the session directly. It must not reconstruct
the static topology and chemistry for every frame.

### 4.2 Topology fingerprint

The session fingerprint contains:

- atom count;
- the complete atomic-number sequence;
- the complete stable site-ID sequence when the input format supplies one;
- PBC flags;
- bonding strategy and option values;
- bonding-rules version;
- site-radius and element-radius override versions.

The lattice matrix is dynamic frame geometry rather than atom topology. For a
fully periodic system, an exactly unchanged lattice can reuse cached grid
geometry and stencil data. A changed lattice invalidates those
geometry-dependent caches before computing the frame, but need not rebuild
immutable element properties. Mixed or non-periodic systems also derive bin
domains from the current coordinate extents; those extents and the resulting
grid geometry must be recomputed whenever positions change.

A changed atom count, atomic-number sequence, available site-ID sequence, PBC
flags, strategy, or rule version closes the old session. The coordinator
creates a new session before accepting frames from the new topology segment.

### 4.3 Strict input validation

For a session containing `N` atoms, every frame must satisfy:

```text
positions.length === 3 × N
```

The check exists at both the JavaScript worker boundary and the Rust session
boundary. A mismatch raises a typed internal error containing:

- session ID;
- expected atom count and float count;
- actual float count;
- requested frame index when available.

The worker must not truncate, pad, partially compute, or publish the frame.
The last complete frame remains visible and playback pauses through the
existing trajectory error path.

Recognized topology changes are not errors. They establish a new topology
segment and session. The mismatch error is for a malformed or internally mixed
request that escaped the normal topology transition.

### 4.4 Cached immutable state

The Rust session precomputes and retains:

- per-atom atomic numbers and effective radii;
- element property lookup results;
- parsed bond options and pairwise distance rules;
- PBC flags;
- deterministic ordering configuration;
- capacity-owned scratch and result vectors.

It does not retain old displayed graphs or old frame positions beyond what is
needed for buffer reuse.

### 4.5 Reused frame-dependent storage

Each exact frame still rebuilds occupancy and evaluates current distances. The
session reuses capacities for:

- converted Cartesian positions;
- fractional or wrapped coordinates;
- cell counts and offsets;
- stable sorted particle indices;
- SoA coordinate arrays;
- center-range partial bond vectors;
- flattened pairs, jimages, lengths, and strengths.

For a fully periodic frame with unchanged lattice, PBC, atom count, and cutoff,
grid dimensions, reciprocal transforms, and neighbor-cell stencil metadata are
reused. For any non-periodic axis, current coordinate extents remain part of
the grid-plan calculation and are not reused merely because the lattice is
unchanged. Counts, offsets, sorted indices, coordinates, distances, and exact
graph membership are always recomputed.

No output may reference a scratch vector after a later session call. Prepared
frames continue to own immutable typed arrays suitable for the bounded queue.

### 4.6 Direct exact kernel

The session calls a direct atom-radii kernel over typed positions and cached
chemistry. It bypasses per-frame construction of generic `SiteOccupancy` and
`Structure` objects.

The scientific predicate remains byte-compatible with the existing exact
reference:

- same minimum and maximum distance comparisons;
- same effective radii;
- same pairwise rules;
- same lattice and per-axis PBC handling;
- same periodic image convention;
- same self-image behavior;
- same canonical pair and jimage ordering;
- same lengths and strengths;
- same duplicate suppression.

Rust scalar and Rayon results must remain byte-identical.

### 4.7 Backend observability

Diagnostics add:

- active backend: threaded or scalar;
- Rayon thread count;
- Rust session initialization count;
- session frame count;
- static-grid cache hits and rebuilds;
- scratch capacity growth count;
- per-frame compute duration.

The real gate records these values. If the environment supports cross-origin
isolation, SharedArrayBuffer, WASM atomics, and at least two logical cores, a
silent fallback to scalar must be diagnosed rather than hidden.

## 5. Compact WebGL2 bond topology

### 5.1 Current cost

The main bond replica renderer currently expands each logical bond into two
CPU-side half entries. Each half schedules:

```text
site pair:       2 × Float32 = 8 bytes
jimage:          3 × Int8   = 3 bytes
half selector:   1 × Float32 = 4 bytes
anchor RGB:      3 × Float32 = 12 bytes
total per half:                27 bytes
total per bond:                54 bytes
```

For about 26,000 bonds this is approximately 1.4 MB and a full JavaScript
expansion loop on every exact graph update.

### 5.2 Per-bond attributes

The compact main draw stores one attribute record per logical bond:

```text
a_site:     2 × Float32 = 8 bytes
a_jimage:   3 × Int8   = 3 bytes
total per bond:          11 bytes
```

Float32 site indices remain exact up to 2²⁴ atoms, well above the viewer's
supported scale. The signed-byte jimage range retains the current contract.

The renderer installs both attributes with:

```text
meshPerAttribute = 2 × cell_count
instanceCount = bond_count × 2 × cell_count
```

Thus one per-bond record serves both halves in every visual replica cell.

### 5.3 Shader instance decoding

The main vertex shader derives replica and half state from `gl_InstanceID`:

```text
group_size  = 2 × cell_count
bond_index  = gl_InstanceID / group_size
within_bond = gl_InstanceID % group_size
half        = within_bond / cell_count
cell_index  = within_bond % cell_count
```

The attribute divisor supplies the same `a_site` and `a_jimage` values for the
whole group. Half A and half B preserve the existing periodic probe, boundary
policy, endpoint anchor, midpoint, and sparse ghost-side behavior.

### 5.4 Static atom-color texture

Per-half RGB attributes are removed from the main draw. A shared RGBA32F atom
color texture contains one texel per base atom and is keyed by topology/color
version. The shader fetches the anchor atom's color:

```text
half A -> color(site A)
half B -> color(site B)
```

RGBA32F is selected initially to preserve the current float color values
without quantization. It uploads only when atom colors or topology change, not
merely because positions or the exact bond graph changed.

The position and color textures are distinct resources: positions update every
displayed frame, while colors are normally static.

### 5.5 Capacity and upload behavior

Per-bond CPU mirrors and WebGL attributes remain grow-only and identity-stable.
Graph changes rewrite only the live prefix. Replica-count changes update
attribute divisors, instance count, and uniforms without expanding topology
arrays.

The real trajectory target is:

```text
main topology payload ≤ 11 bytes × bond_count per graph update
```

Sparse ghost-side pages remain unchanged in the first pass because their
contract is boundary-policy-specific and they are not the real 1×1×1 playback
hot path. Their correctness tests remain mandatory.

### 5.6 Picking parity

The WebGL2 replica ID picker adopts the same per-bond attributes, divisor, and
instance decoding. Both halves and all replica instances of one logical bond
must encode the same bond graph ID:

```text
picked_bond_id = bond_index
```

Visible rendering and picking must not maintain different topology
expansions. Existing request-generation checks still discard obsolete picks.

## 6. Frame flow

The optimized flow is:

```text
indexed ASE frame
  -> positions + lattice + topology fingerprint
  -> selected exact bond worker
  -> persistent Rust TrajectoryBondSession
       reuse chemistry/grid metadata/capacity
       rebuild current occupancy
       evaluate every exact candidate
       emit deterministic exact graph
  -> immutable PreparedTrajectoryFrame
  -> bounded prepared-frame queue
  -> atomic presentation
       one shared RGBA32F position upload
       compact per-bond topology upload
       static atom-color texture reuse
       visible and picker resources share the same graph
  -> presented-frame acknowledgement
```

The queue remains ordered for normal playback even if later contingency work
uses more than one preparation worker.

## 7. Variable atoms and topology segments

### 7.1 Supported changes

A trajectory may contain topology segments with different atom counts,
elements, IDs, PBC, or rules. Each segment has its own fingerprint and worker
session. Prepared-cache keys include that fingerprint, preventing a frame from
one segment from being consumed under another segment's renderer topology.

Presentation of a normal topology transition is:

```text
finish or retain last complete old-segment frame
  -> initialize new session
  -> prepare complete new-segment frame
  -> atomically publish new positions, colors, and exact graph
```

No intermediate mixed frame is visible.

### 7.2 Same-count permutations without IDs

When stable site IDs are present, their complete ordered sequence is part of
the fingerprint. When they are absent, the ordered atomic-number sequence is
the strongest available identity signal.

A same-count, same-element permutation cannot be distinguished from large
motion using only `numbers` and `positions`. The session therefore makes no
cross-frame neighbor-list or atom-identity assumption. It computes the exact
current graph from current indices. Features that semantically track a
particular physical atom across frames require an input format with stable IDs
and are outside this optimization.

## 8. Failure and recovery

- **Positions length mismatch:** reject the request at both worker and Rust
  boundaries; publish nothing; keep the last complete frame visible; pause and
  surface the typed error.
- **Recognized topology change:** create a new session and topology segment;
  this is normal control flow, not truncation recovery.
- **Worker crash or timeout:** discard the Rust session with the worker;
  recreate it through the existing runtime on the next request; stale
  generations cannot publish.
- **Threaded initialization failure:** use the existing one-time scalar retry
  and report the actual backend in diagnostics.
- **Variable lattice:** invalidate cached grid geometry/stencil, then compute
  the frame exactly with the new lattice.
- **Renderer feature incompatibility:** retain the existing complete legacy
  WebGL2 path; never approximate the graph.
- **WebGL context loss:** retain the current prepared frame, recreate compact
  resources, and upload that frame once after restoration.
- **Capacity growth failure:** retain the previous visible graph and surface a
  bounded allocation error; never clamp pair count.
- **Obsolete result:** discard by owner, generation, fingerprint, rule version,
  and frame index without mutating visible state.

## 9. TDD and verification

Implementation follows strict red-green-refactor TDD. Every production change
starts with a failing focused test, and every plan task ends with its stated
verification gate and a commit.

### 9.1 Rust session tests

- session output is byte-identical to the legacy exact entry point;
- scalar and Rayon session results are byte-identical and deterministic;
- fixed-cell repeated frames reuse grid metadata and scratch capacity;
- changed lattice rebuilds only geometry-dependent caches;
- changed rules require a new fingerprint/session;
- zero atoms, one atom, self-image bonds, thin periodic cells, and mixed PBC;
- `positions.length != 3 × atom_count` returns the typed mismatch error;
- no truncated or partial graph is returned after any error.

### 9.2 Worker and coordinator tests

- JavaScript rejects mismatched position lengths before calling WASM;
- Rust remains the final defense if the JavaScript guard is bypassed;
- changed atom count and atomic-number sequence create a new session;
- stable site-ID sequence participates in the fingerprint when present;
- an obsolete old-session result cannot publish after a topology transition;
- same-count frames without IDs do not attempt Verlet reuse;
- worker restart creates exactly one replacement Rust session;
- diagnostics report backend, thread count, cache reuse, and capacity growth.

### 9.3 Renderer and picker tests

- one bond record produces exactly `2 × cell_count` visible instances;
- shader instance decoding maps every instance to the correct bond, half, and
  replica cell;
- main topology accounting is exactly 11 bytes per logical bond;
- graph updates do not allocate half-expanded pair, jimage, half, or RGB arrays;
- atom colors are fetched from the correct static color texel;
- color-only changes upload the color texture without recomputing bonds;
- replica-only changes do not upload bond topology;
- visible and picking instance decoding are identical;
- both halves and every replica map to one logical pick ID;
- periodic self-images and all boundary policies retain current behavior;
- context restoration recreates compact resources without a hidden legacy
  `instanceMatrix`.

### 9.4 Real-file gate

Use the existing real Playwright acceptance path with the pinned trajectory and
headed hardware WebGL. The optimized acceptance gate requires:

- file hash and shape match the pinned reference;
- 100/100 displayed graph hashes and bond counts match the independent exact
  reference;
- first four-second unique-presented FPS ≥ 40;
- steady unique-presented FPS ≥ 40;
- no failed, stale, approximate, truncated, or skipped presented frames;
- position uploads equal unique presented frames;
- picker position uploads during passive playback remain zero;
- main topology payload ≤ 11 bytes per logical bond update;
- prepared cache remains at most eight frames and total retained prepared state
  remains below 96 MiB;
- random-seek application acknowledgement remains below 100 ms;
- WebGL context remains intact and `gl.getError()` is zero;
- backend/session/cache diagnostics are printed with the final result.

The full focused trajectory/render set, full frontend test suite, type check,
`git diff --check`, and the documented Python baseline command also run before
completion.

## 10. Measured contingency path

The first implementation ends only when the real gate reaches 40 FPS. If the
mandatory session and compact-layout stages are still below that floor, the
next action is selected from fresh diagnostics:

1. **Threaded backend expected but scalar active:** fix cross-origin isolation,
   worker-module loading, WASM atomics, or Rayon initialization and rerun the
   same exact gate.
2. **Compute p95 remains above the 25 ms frame budget:** profile the session for
   remaining allocation/conversion hot spots. Remove those first. If scalar is
   the only supported backend, use a bounded pool of independent scalar
   preparation workers to compute different queued frames concurrently while
   publishing strictly in order.
3. **Main-thread topology preparation or upload dominates:** combine compact
   topology stores into one stable interleaved buffer only if measurement shows
   fewer WebGL update calls improve the gate; keep the 11-byte logical payload
   and exact picker mapping.
4. **GPU fragment time dominates:** profile the existing analytic impostor at
   the exact bond count and viewport. Apply an OVITO-derived MIT-licensed shader
   optimization only if it preserves pixels, depth, caps, selection, and
   context stability.
5. **CPU exact compute remains the hard limit after genuine threaded WASM:**
   evaluate the existing exact WebGPU grid compute as an optional preparation
   backend. It must publish through the same immutable graph contract and keep
   WebGL2/scalar WASM as complete fallbacks.

Each contingency is its own measured TDD task and commit. The implementation
must not choose a contingency merely because it has a higher theoretical
ceiling.

## 11. OVITO attribution

The audit found that CatGo's existing ray-cylinder intersection code is
structurally close enough to OVITO's implementation that license provenance
should be made explicit even before further shader adaptation.

Implementation therefore adds:

- a third-party notice naming OVITO GmbH, the pinned commit, and the MIT option;
- source comments on materially adapted ray-cylinder code;
- the OVITO MIT copyright and permission notice;
- a short record of CatGo-specific changes such as WebGL2 GLSL syntax,
  half-bond replica decoding, analytic coverage, color lookup, and picking.

Attribution changes do not alter rendering behavior and receive their own
focused verification and commit.

## 12. Completion definition

This follow-up is complete only when:

1. all planned TDD tasks are committed individually;
2. protected local paths remain unmodified and unstaged;
3. the real reference passes 100/100 exactness;
4. both measured playback segments reach at least 40 unique presented FPS;
5. variable-count and malformed-length behavior is explicit and tested;
6. compact visible and picker topology share one per-bond contract;
7. OVITO-derived code has correct MIT attribution;
8. every verification gate has fresh recorded evidence.
