# Exact Smooth Trajectory Bond Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real 100 × 19,968-atom `.traj` play and scrub with an exact bond graph for every displayed frame, no atom/bond/index mismatch, one WebGL2 position upload per presented frame, and at least 24 unique presented trajectory frames per second on the reference RTX 4060.

**Architecture:** Decode/request frames ahead of display, compute each frame's exact bond graph in the existing Rust-WASM worker, and commit a complete immutable snapshot only when positions, lattice, and bonds for the same frame are ready. Keep 3–8 completed snapshots in a byte-bounded cache, hold the last complete snapshot under backpressure or failure, and feed one WebGL2 layer plus its on-demand picker from one shared RGBA32F position texture.

**Tech Stack:** Svelte 5 runes, TypeScript, Three.js/Threlte WebGL2, Rust-WASM bond workers, Vitest, Playwright, existing `.traj` streaming/compact-frame loader.

## Global Constraints

- Scientific correctness is a release gate: every presented frame must use that frame's exact positions, lattice, and bond graph. Never display stale bonds, filter stale edges by current distance, or advance the visible time index before the complete frame commits.
- Preserve the current bonding strategy, tolerance, periodic-image rules, custom distance-rule semantics, manual/deleted/hidden bonds, hydrogen bonds, bond-order perception, clipping, and polyhedra behavior.
- The optimized path may be gated to the ordinary large-trajectory case. Any ineligible feature combination must use an exact fallback and hold the previous complete frame while it computes.
- WebGL2 is the default and complete renderer. WebGPU remains optional and disabled by default.
- The main thread must not run large-system bond detection. Position packing for the optimized trajectory path happens in the worker.
- The exact prepared path is production-default. The prior approximation may
  remain for one release only as an explicit development diagnostic selected
  by `?trajectory_pipeline=legacy`; it is never an automatic error fallback.
- Keep at most 8 prepared frames and enforce a byte budget. A full trajectory must never remain pinned in the prepared cache.
- Static structures, edit mode, visual supercells, variable-cell trajectories, context restore, and the legacy renderer remain functional.
- The reference input is `/home/james0001/Downloads/dump.traj`, SHA-256
  `38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c`,
  100 frames, 19,968 atoms, approximately 26,000 bonds. Do not add this 100+
  MB file to Git.
- Commit after every task. Do not stage `.claude/gate-approvals/`, `.claude/tmp-dump.traj`, or `.superpowers/`.

## File and Responsibility Map

### New production files

- `src/lib/structure/trajectory-bond-graph.ts`
  - Converts typed worker output and object `BondPair[]` output into the shared `BaseBondGraph` contract.
  - Provides deterministic graph hashing for exactness diagnostics and tests.
- `src/lib/structure/trajectory-prepared-frame.ts`
  - Owns the request queue, generation invalidation, in-flight deduplication, LRU/byte eviction, and completed-frame outcomes.
  - Contains no Svelte or Three.js imports.
- `src/lib/structure/trajectory-frame-preparer.ts`
  - Chooses the exact typed fast path or exact feature-compatible object path.
  - Produces `PreparedTrajectoryFrame` objects consumed by `StructureScene.svelte`.
- `src/lib/structure/gpu/webgl2/shared-position-texture.ts`
  - Owns the one RGBA32F position texture, upload counters, frame identity, and disposal.
- `src/lib/structure/gpu/position-texture-layout.ts`
  - Defines the pure, worker-safe 2D texture layout shared by the worker, renderers, and picker.
- `src/lib/structure/trajectory-render-diagnostics.ts`
  - Records requested/prepared/presented frames, graph hashes, compute latency, cache occupancy, position uploads, picker uploads, and unique-frame FPS.
- `src/lib/structure/trajectory-bond-legacy-diagnostic.ts`
  - Isolates the prior cadence path behind a development-only explicit query
    switch for one release; production never selects it.

### Modified production files

- `src/lib/structure/workers/bond-worker-runtime.ts`
  - Extends the typed result with worker-packed RGBA positions for trajectory requests.
- `src/lib/structure/workers/bond-worker-api.ts`
  - Adds the trajectory-specific typed request without changing existing callers.
- `src/lib/structure/workers/bond-worker.ts`
  - Packs the transferred RGB positions into RGBA in the worker and transfers the packed buffer back with the exact graph.
- `src/lib/structure/bond-computation-controller.svelte.ts`
  - Removes the eight-frame approximation and stale/latest-wins trajectory ownership after the prepared path is live.
  - Retains non-trajectory bond computation helpers.
- `src/lib/structure/StructureScene.svelte`
  - Requests exact prepared frames, retains the last complete packet, atomically publishes prepared snapshots, and mounts the unified packet layer.
- `src/lib/structure/Structure.svelte`
  - Forwards random-access trajectory geometry and the presentation acknowledgement callback.
- `src/lib/trajectory/Trajectory.svelte`
  - Separates requested and presented indices, exposes random-access frame geometry, applies playback backpressure, and keeps the visible time index on the presented frame.
- `src/lib/structure/gpu/WebGLReplicaLayer.svelte`
  - Owns both atom and bond renderers and injects the shared position texture into both.
- `src/lib/structure/gpu/webgl2/atom-replica-renderer.ts`
  - Fetches base positions by site index from the shared texture instead of uploading `instancePosition`.
- `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
  - Uses the injected shared texture and deletes its private position texture/packing loop.
- `src/lib/structure/atoms/AtomManagerInstances.svelte`
  - Suppresses its private packet layer when `StructureScene` owns the unified layer.
- `src/lib/structure/bonding/BondManagerInstances.svelte`
  - Suppresses its private packet layer when `StructureScene` owns the unified layer.
- `src/lib/structure/gpu/webgl2/replica-id-picker.ts`
  - Reads the same shared position texture and updates only topology/codec data on demand.
- `src/lib/structure/gpu-picker-integration.svelte.ts`
  - Injects the shared texture and never asks the picker to upload positions.

### New and replaced tests

- `tests/vitest/structure/trajectory-bond-graph.test.ts`
- `tests/vitest/structure/trajectory-prepared-frame.test.ts`
- `tests/vitest/structure/trajectory-frame-preparer.test.ts`
- `tests/vitest/trajectory/prepared-playback-backpressure.test.ts`
- `tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts`
- `tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts`
- `tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts`
- `tests/vitest/structure/trajectory-prepared-failure.test.ts`
- `tests/vitest/structure/trajectory-render-diagnostics.test.ts`
- `tests/playwright/trajectory-exact-smooth-real-file.spec.ts`
- Replace the approximation assertions in:
  - `tests/vitest/structure/trajectory-bond-refresh-budget.test.ts`
  - `tests/vitest/trajectory/traj-bond-scheduling.test.ts`

---

## Task 1: Establish the exact graph and prepared-frame contracts

**Consumes:** `TypedBondTable`, `BondPair[]`, `BaseBondGraph`, `FrameGeometry`.

**Produces:** Pure graph conversion/hashing and immutable prepared-frame types used by all later tasks.

**Files:**

- Create: `src/lib/structure/trajectory-bond-graph.ts`
- Create: `src/lib/structure/trajectory-prepared-frame.ts`
- Create: `tests/vitest/structure/trajectory-bond-graph.test.ts`
- Create: `tests/vitest/structure/trajectory-prepared-frame.test.ts`

- [ ] **Step 1: Write failing graph-contract tests**

Cover typed-table conversion, object conversion with periodic `jimage`, periodic self-image edges, deterministic hash equality, strength preservation, and rejection of malformed lengths.

The public graph API must be:

```ts
import type { BondPair } from '$lib'
import type { BaseBondGraph } from './scene/render-packet'
import type { TypedBondTable } from './workers/bond-worker-runtime'

export function typed_table_to_base_bond_graph(
  table: TypedBondTable,
  version: number,
): BaseBondGraph

export function bond_pairs_to_base_bond_graph(
  bonds: readonly BondPair[],
  version: number,
): BaseBondGraph

export function hash_base_bond_graph(graph: BaseBondGraph): string
```

The conversion must allocate `kinds = new Uint8Array(bond_count)` for auto bonds, preserve `table.strengths`, and map `BondPair.site_idx_1`, `site_idx_2`, `jimage`, and `strength` without re-running a distance filter.

- [ ] **Step 2: Run the graph test and verify it fails**

Run:

```bash
pnpm vitest run tests/vitest/structure/trajectory-bond-graph.test.ts
```

Expected: FAIL because `trajectory-bond-graph.ts` does not exist.

- [ ] **Step 3: Implement the graph conversion and deterministic hash**

Build an order-independent edge hash without sorting. Canonicalize each edge
as `(min_site, max_site, canonical_jimage, kind, strength)`; swapping endpoint
order negates `jimage`, and a self-image edge chooses the lexicographically
smaller of `jimage` and `-jimage`. Encode integers explicitly little-endian and
strength with `DataView.setFloat32(offset, value, true)`. Feed each canonical
record through two independent 32-bit `Math.imul` hashes, then combine the
per-edge values with unsigned xor and unsigned sum accumulators plus the edge
count. Concatenate the fixed-width hexadecimal accumulators. Tests must prove
that edge permutation and endpoint reversal retain the hash while a changed
edge, `jimage`, kind, or strength changes it. This diagnostic identity is
stable across browser/Node endianness and is not the render packet version.

- [ ] **Step 4: Write failing prepared-frame contract tests**

Define and test these exact exported types/helpers:

```ts
import type {
  BaseBondGraph,
  RenderPacket,
} from './scene/render-packet'

export type PreparedFrameKey = {
  owner: object
  frame_idx: number
  positions_version: number
  topology_version: number
  rules_version: string
}

export type PreparedTrajectoryFrame = {
  key: PreparedFrameKey
  packet: RenderPacket
  graph: BaseBondGraph
  gpu_positions_rgba: Float32Array
  forces: Float32Array | null
  graph_hash: string
  byte_size: number
  compute_ms: number
}

export type PreparedFrameOutcome =
  | { status: 'ready'; value: PreparedTrajectoryFrame; cache_hit: boolean }
  | { status: 'stale' }
  | { status: 'failed'; error: Error }

export function same_prepared_frame_key(
  a: PreparedFrameKey,
  b: PreparedFrameKey,
): boolean

export function prepared_frame_byte_size(
  packet: RenderPacket,
  rgba: Float32Array,
  forces: Float32Array | null,
): number
```

`prepared_frame_byte_size` must count the retained frame positions, optional
forces, RGBA upload buffer, graph arrays, topology arrays, and lattice. Tests
must assert exact byte totals for a small packet without double-counting the
same graph arrays. Assert
`prepared.graph === prepared.packet.topology.bond_graph`.

- [ ] **Step 5: Run the prepared-frame contract test and verify it fails**

Run:

```bash
pnpm vitest run tests/vitest/structure/trajectory-prepared-frame.test.ts
```

Expected: FAIL because the prepared-frame exports do not exist.

- [ ] **Step 6: Implement the contracts and rerun both tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-bond-graph.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  src/lib/structure/trajectory-bond-graph.ts \
  src/lib/structure/trajectory-prepared-frame.ts \
  tests/vitest/structure/trajectory-bond-graph.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts
git commit -m "feat: define exact prepared trajectory frames"
```

---

## Task 2: Return exact graph plus GPU-ready positions from the bond worker

**Consumes:** The existing typed Rust-WASM `atom_radii` worker path and Task 1 contracts.

**Produces:** One off-main-thread request whose result contains the exact graph table and RGBA positions derived from the same transferred RGB frame.

**Files:**

- Modify: `src/lib/structure/workers/bond-worker-runtime.ts`
- Modify: `src/lib/structure/workers/bond-worker-api.ts`
- Modify: `src/lib/structure/workers/bond-worker.ts`
- Create: `tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts`
- Modify: `tests/vitest/structure/workers/bond-worker-selection.test.ts`
- Create: `src/lib/structure/gpu/position-texture-layout.ts`

- [ ] **Step 1: Write failing typed-trajectory worker tests**

Add this result contract without changing `compute_bonds_typed`:

```ts
export interface ComputeTrajectoryFrameTypedResult
  extends ComputeBondsTypedResult {
  gpu_positions_rgba: Float32Array
}

export interface TrajectoryTypedBondInput {
  session: {
    id: number
    atomic_numbers: Uint8Array
    pbc: [boolean, boolean, boolean] | null
    options: Record<string, number>
  }
  positions: Float32Array
  lattice_matrix: number[][] | null
}
```

Add this API:

```ts
export async function compute_trajectory_frame_typed(
  input: TrajectoryTypedBondInput,
): Promise<ComputeTrajectoryFrameTypedResult>

export async function pack_trajectory_positions_worker(
  positions: Float32Array,
): Promise<Float32Array>
```

Test that:

- the caller's `positions` and `atomic_numbers` buffers remain attached;
- one session init transfers immutable atomic numbers/PBC/options once, while
  sequential frame messages transfer only positions and current lattice;
- changing the topology/rules session ID sends a new session init before its
  first frame;
- the worker receives copies through transfer lists;
- RGBA output is `[x, y, z, 1]` for every atom;
- graph arrays and RGBA output return through transfer lists;
- the RGBA output uses the shared 2D layout and includes zeroed padding after
  the last atom;
- `pack_trajectory_positions_worker` supports exact object-path frames without
  packing on the main thread;
- backend and elapsed time are preserved;
- worker rejection remains a rejection and never invokes main-thread detection.

- [ ] **Step 2: Run the focused worker tests and verify failure**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/workers/bond-worker-selection.test.ts
```

Expected: FAIL because the trajectory-specific result/API is absent.

- [ ] **Step 3: Add the worker message and RGBA packing**

Define the pure layout once:

```ts
export const POSITION_TEXTURE_ROW_ATOMS = 2048

export function position_texture_shape(atom_count: number): {
  width: number
  height: number
  float_count: number
} {
  const width = Math.max(
    1,
    Math.min(POSITION_TEXTURE_ROW_ATOMS, atom_count),
  )
  const height = Math.max(1, Math.ceil(atom_count / width))
  return { width, height, float_count: width * height * 4 }
}
```

WebGL2 implementations support at least this width. Use a distinct worker
message type so existing typed callers remain binary compatible:

```ts
let trajectory_session: {
  id: number
  atomic_numbers: Uint8Array
  pbc: Uint8Array
  options_json: string
} | null = null

if (type === `trajectory_session_init`) {
  trajectory_session = {
    id: e.data.session_id,
    atomic_numbers: e.data.atomic_numbers,
    pbc: e.data.pbc,
    options_json: e.data.options_json,
  }
  scope.postMessage({ id, type: `trajectory_session_ready` })
  return
}

if (type === `trajectory_frame_typed`) {
  if (!trajectory_session || trajectory_session.id !== e.data.session_id) {
    throw new Error(`Unknown trajectory bond session ${e.data.session_id}`)
  }
  const t0 = performance.now()
  const positions = e.data.positions as Float32Array
  const table = glue.detect_bonds_radii_typed(
    positions,
    trajectory_session.atomic_numbers,
    e.data.lattice,
    trajectory_session.pbc,
    trajectory_session.options_json,
  )
  const atom_count = positions.length / 3
  const shape = position_texture_shape(atom_count)
  const gpu_positions_rgba = new Float32Array(shape.float_count)
  for (let src = 0, dst = 0; src < positions.length; src += 3, dst += 4) {
    gpu_positions_rgba[dst] = positions[src]
    gpu_positions_rgba[dst + 1] = positions[src + 1]
    gpu_positions_rgba[dst + 2] = positions[src + 2]
    gpu_positions_rgba[dst + 3] = 1
  }
  const pairs = table.pairs
  const images = table.images
  const lengths = table.lengths
  const strengths = table.strengths
  table.free()
  scope.postMessage(
    {
      id,
      pairs,
      images,
      lengths,
      strengths,
      gpu_positions_rgba,
      dt: (performance.now() - t0).toFixed(1),
    },
    [
      pairs.buffer,
      images.buffer,
      lengths.buffer,
      strengths.buffer,
      gpu_positions_rgba.buffer,
    ],
  )
  return
}
```

Declare `trajectory_session` beside the worker's existing `initialized` state,
outside `scope.onmessage`, so it persists between session-init and frame
messages and is destroyed with the worker.

Add `compute_trajectory_frame_typed` to both `BondWorkerHandle` and
`BondWorkerRuntime`, then route the public API through the runtime so backend
selection, timeout, reset, and elapsed-time reporting stay identical to
`compute_bonds_typed`. `RealBondWorkerHandle` keeps the active numeric session
ID. On a changed ID it first sends `trajectory_session_init` with copied
atomic numbers, PBC, and options; `trajectory_frame_typed` then sends only a
copied positions buffer and current flattened lattice. A reset/new handle has
no active session and therefore reinitializes correctly. Factor lattice
flattening and ownership-preserving input copies into private helpers.
Implement `pack_trajectory_positions_worker` with a
`trajectory_positions_rgba` message on the same initialized worker; do not
transfer render-owned original arrays.

- [ ] **Step 4: Rerun focused tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/workers/bond-worker-selection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run worker and type regression tests**

Run:

```bash
pnpm vitest run tests/vitest/structure/workers
pnpm check
```

Expected: PASS with the repository's existing warning baseline and no new errors.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/structure/workers/bond-worker-runtime.ts \
  src/lib/structure/workers/bond-worker-api.ts \
  src/lib/structure/workers/bond-worker.ts \
  src/lib/structure/gpu/position-texture-layout.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/workers/bond-worker-selection.test.ts
git commit -m "perf: prepare trajectory positions in bond worker"
```

---

## Task 3: Build the bounded current-first prepared-frame pipeline

**Consumes:** Task 1 frame contracts and Task 2 worker result.

**Produces:** A pure queue that deduplicates requests, invalidates stale seek generations, prefetches forward frames, and retains 3–8 completed frames within a byte budget.

**Files:**

- Modify: `src/lib/structure/trajectory-prepared-frame.ts`
- Modify: `tests/vitest/structure/trajectory-prepared-frame.test.ts`
- Create: `src/lib/structure/trajectory-render-diagnostics.ts`
- Create: `tests/vitest/structure/trajectory-render-diagnostics.test.ts`

- [ ] **Step 1: Add failing state-machine tests**

The public pipeline API must be:

```ts
export type PrepareFrameRequest = {
  key: PreparedFrameKey
  priority: 'current' | 'prefetch'
  estimated_bytes: number
  prepare: () => Promise<PreparedTrajectoryFrame>
}

export type PreparedFramePipelineStats = {
  generation: number
  queued: number
  in_flight: number
  cached_frames: number
  cached_bytes: number
  queued_bytes: number
  in_flight_bytes: number
  retained_bytes: number
  cache_hits: number
  cache_misses: number
  evictions: number
  stale_results: number
}

export type PreparedFramePipeline = {
  begin_request(key: PreparedFrameKey): number
  request(
    request: PrepareFrameRequest,
    generation: number,
  ): Promise<PreparedFrameOutcome>
  peek(key: PreparedFrameKey): PreparedTrajectoryFrame | null
  ready_count(keys: readonly PreparedFrameKey[]): number
  stats(): PreparedFramePipelineStats
  clear(owner?: object): void
}

export function create_prepared_frame_pipeline(options?: {
  max_frames?: number
  max_bytes?: number
  max_in_flight?: number
}): PreparedFramePipeline
```

Tests must prove:

- duplicate keys share one promise;
- `current` jumps ahead of queued `prefetch`;
- sequential `n → n+1` with the same owner, positions version, topology
  version, and rules version stays in one generation;
- non-sequential seek, reverse step, owner change, positions-version change,
  topology-version change, and rules-version change increment the generation;
- a result from an old generation resolves as `stale` and never enters cache;
- queued records from an old generation resolve `stale` immediately and never
  delay the new current request;
- LRU eviction respects both `max_frames = 8` and `max_bytes`;
- byte accounting includes cached, queued, and in-flight position/graph
  estimates; queued prefetch is refused before `retained_bytes` exceeds the
  byte budget;
- the current frame is never evicted before older prefetched frames;
- `ready_count` reports the contiguous current-plus-lookahead warmup window;
- preparation failure returns `failed` and the queue continues;
- `max_in_flight` defaults to 1 because the active threaded worker already uses a Rayon pool.
- diagnostics distinguish requested, prepared, cached, stale, failed, and
  presented frames without retaining frame buffers.

- [ ] **Step 2: Run the state-machine test and verify failure**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
```

Expected: FAIL on missing pipeline and diagnostics exports.

- [ ] **Step 3: Implement the queue with explicit record states**

Use these internal states:

```ts
type QueueRecord = {
  request: PrepareFrameRequest
  generation: number
  sequence: number
  resolve: (outcome: PreparedFrameOutcome) => void
}

type CacheRecord = {
  value: PreparedTrajectoryFrame
  last_used: number
  priority: 'current' | 'prefetch'
}
```

Keep `cache: CacheRecord[]`, `queue: QueueRecord[]`, and
`in_flight: QueueRecord[]`. Compare owners by object identity. Sort by
current-before-prefetch then sequence. On completion, re-check generation and
key before insertion. When `begin_request` increments the generation, remove
and resolve queued old-generation records immediately; an already-running
worker request is allowed to finish and becomes stale. Protect the displayed
and current-request records; evict
the prefetched record farthest from the requested playhead first, then the
least-recent record at equal distance, until both limits pass. Record counters
through the allocation-light diagnostics module. A current request may
temporarily exceed the byte budget because correctness takes priority; reject
or evict prefetch records first and report the temporary peak.

- [ ] **Step 4: Rerun the state-machine test**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  src/lib/structure/trajectory-prepared-frame.ts \
  src/lib/structure/trajectory-render-diagnostics.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
git commit -m "feat: queue exact prepared trajectory frames"
```

---

## Task 4: Prepare and atomically publish exact scene snapshots

**Consumes:** Raw trajectory `RenderPacket`, random-access frame geometry, bonding settings, Tasks 1–3.

**Produces:** A `StructureScene` packet that changes only when one frame's positions, lattice, and exact graph are all ready.

**Files:**

- Create: `src/lib/structure/trajectory-frame-preparer.ts`
- Create: `src/lib/structure/trajectory-bond-legacy-diagnostic.ts`
- Create: `tests/vitest/structure/trajectory-frame-preparer.test.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/Structure.svelte`
- Modify: `src/lib/trajectory/Trajectory.svelte`
- Modify: `src/lib/structure/bond-computation-controller.svelte.ts`
- Replace: `tests/vitest/structure/trajectory-bond-refresh-budget.test.ts`
- Replace: `tests/vitest/trajectory/traj-bond-scheduling.test.ts`

- [ ] **Step 1: Write failing exact-preparer tests**

Add this shared random-access source contract:

```ts
export type TrajectoryFrameSource = {
  frame_idx: number
  positions: Float32Array
  forces: Float32Array | null
  lattice: number[][] | null
  positions_version: number
  topology_stable: boolean
}

export type ExactFramePrepareInput = {
  packet: RenderPacket
  source: TrajectoryFrameSource
  structure: AnyStructure
  strategy: BondingStrategy
  options: Record<string, number>
  pbc: [boolean, boolean, boolean] | null
  distance_rules: readonly BondDistanceRule[]
  rules_version: string
  graph_version: number
}

export async function prepare_exact_trajectory_frame(
  input: ExactFramePrepareInput,
): Promise<PreparedTrajectoryFrame>
```

Test both branches:

- exact worker edges and `jimage` values match the existing CPU reference for
  orthogonal, triclinic, partial-PBC, periodic self-image, and pair-distance
  rule fixtures;
- ordinary `atom_radii` with no distance rules calls `compute_trajectory_frame_typed`, converts the returned table, and commits the returned RGBA buffer;
- custom distance rules or another strategy calls the exact object worker path,
  applies the existing full distance-rule override, converts final `BondPair[]`
  without a stale-distance filter, and calls
  `pack_trajectory_positions_worker`;
- the result's `packet.frame.frame_idx`, positions, lattice, graph, graph hash, and key all describe the same source frame;
- optional force vectors remain attached to that same prepared source frame;
- future-frame prefetch is accepted only when `topology_stable` is true;
- no large-system sync fallback is callable.

- [ ] **Step 2: Run the preparer test and verify failure**

Run:

```bash
pnpm vitest run tests/vitest/structure/trajectory-frame-preparer.test.ts
```

Expected: FAIL because the preparer does not exist.

- [ ] **Step 3: Implement exact preparation**

Create the completed packet by preserving the raw packet's topology styling and replicas:

```ts
const graph = typed_table_to_base_bond_graph(
  worker_result.table,
  input.graph_version,
)
const packet: RenderPacket = {
  topology: {
    ...input.packet.topology,
    bond_graph: graph,
  },
  frame: {
    ...input.packet.frame,
    frame_idx: input.source.frame_idx,
    positions_version: input.source.positions_version,
    positions: input.source.positions,
    lattice: flatten_lattice(input.source.lattice),
  },
  replicas: input.packet.replicas,
}
```

The exact object branch must preserve manual/deleted/hidden feature ownership in `StructureScene`; only its auto-bond graph comes from this preparer.

- [ ] **Step 4: Replace approximation tests with exactness tests**

Delete assertions for `TRAJ_BOND_REFRESH_EVERY`, previous-frame reuse, and latest-wins stale publication. Add assertions that:

- 64 distinct requested frames cause 64 exact computes unless cached;
- cache hits return the exact frame-specific graph;
- frame `n+1` never returns frame `n` connectivity;
- stale generation results are discarded;
- the old eight-frame cadence symbol and old previous-connectivity return path are absent from the controller source.

- [ ] **Step 5: Integrate the pipeline in `StructureScene.svelte`**

Add props:

```ts
trajectory_frame_count?: number
get_trajectory_frame_source?: (
  frame_idx: number,
) => TrajectoryFrameSource | null
request_trajectory_frame_source?: (
  frame_idx: number,
) => Promise<TrajectoryFrameSource | null>
on_trajectory_frame_presented?: (
  frame_idx: number,
  positions_version: number,
) => void
on_trajectory_buffer_state?: (state: {
  frame_idx: number
  ready_ahead: number
  preparing: boolean
  error: string | null
}) => void
```

Maintain:

```ts
let prepared_render_packet = $state.raw<RenderPacket | null>(null)
let prepared_gpu_positions = $state.raw<Float32Array | null>(null)
let prepared_frame_forces = $state.raw<Float32Array | null>(null)
let prepared_error = $state<string | null>(null)
const prepared_pipeline = create_prepared_frame_pipeline({
  max_frames: 8,
  max_bytes: 96 * 1024 * 1024,
  max_in_flight: 1,
})
```

On each raw trajectory packet:

1. derive a stable `rules_version` from strategy, numeric options, PBC, and distance rules;
2. call `begin_request` with the current frame's complete key;
3. request the current frame at `current` priority;
4. when the trajectory topology is stable, enqueue up to the next 7 sources
   at `prefetch` priority, wrapping modulo `trajectory_frame_count` for the
   existing repeat behavior, using the
   synchronous getter on a cache hit and the asynchronous request provider
   otherwise;
5. on a `ready` current result, run one synchronous commit that assigns the
   complete packet, force vector, and RGBA buffer, updates the bond manager's
   auto topology, clears the error, then acknowledges presentation;
6. on `stale`, do nothing;
7. on `failed`, retain the previous packet and publish the error state.

After cache insert/evict/current request changes, publish
`on_trajectory_buffer_state` using `ready_count` for the current frame plus
contiguous forward keys.

The visible manager packet must start from `prepared_render_packet` while a trajectory is active. It must never combine the raw current frame with the previously prepared graph.

Treat the incoming `trajectory_frame_positions` and `render_packet` as
requested-frame inputs used only by the preparation effect. Every downstream
draw, bond-manager, polyhedra, clipping, label, force, and picking consumer
must read the presented frame positions/lattice from
`prepared_render_packet.frame` and forces from `prepared_frame_forces` while a
bonded trajectory is active. This is
what keeps the exact legacy/object fallback atomic too; otherwise an advanced
feature could still combine raw frame `n+1` positions with presented frame `n`
bonds.

- [ ] **Step 6: Forward random-access sources through `Structure.svelte`**

Replace the positions-only private callback with the aggregate source callback while retaining the old prop as a deprecated compatibility adapter for external callers:

```ts
trajectory_frame_count?: number
get_trajectory_frame_source?: (
  frame_idx: number,
) => TrajectoryFrameSource | null
request_trajectory_frame_source?: (
  frame_idx: number,
) => Promise<TrajectoryFrameSource | null>
on_trajectory_frame_presented?: (
  frame_idx: number,
  positions_version: number,
) => void
on_trajectory_buffer_state?: (state: {
  frame_idx: number
  ready_ahead: number
  preparing: boolean
  error: string | null
}) => void
```

Forward `trajectory_frame_count` plus all source, presentation, and
buffer-state props to `StructureScene`.

- [ ] **Step 7: Supply exact current/future sources from `Trajectory.svelte`**

Use the existing `position_cache`, compact `position_data`, `frame_pos_cache`,
materialized frame lattice, `effective_frames`, and
`trajectory_positions_version.v`. The synchronous getter returns `null` for
an undecoded frame. The async provider uses the existing position-only loader
or effective-frame cache without publishing into `current_frame`; do not
materialize the whole trajectory's site objects.

The callback must return identity-stable positions and the correct per-frame lattice:

```ts
function get_trajectory_frame_source(
  frame_idx: number,
): TrajectoryFrameSource | null {
  const frame = trajectory?.frames?.[frame_idx]
  const sites = frame?.structure?.sites
  const cached_frame = sites?.length
    ? frame_pos_cache.get(frame_idx, sites)
    : null
  const positions = position_cache?.[frame_idx] ??
    frame?.position_data?.positions ??
    cached_frame?.positions ??
    null
  if (!positions) return null
  const first_frame = trajectory?.frames?.[0]
  const base_lattice = first_frame?.position_data?.lattice ??
    (first_frame?.structure as
      | { lattice?: { matrix?: number[][] } }
      | undefined)?.lattice?.matrix ??
    null
  const lattice = frame?.position_data?.lattice ??
    (frame?.structure as
      | { lattice?: { matrix?: number[][] } }
      | undefined)?.lattice?.matrix ??
    base_lattice
  const metadata = trajectory?.metadata as
    | { source_format?: string; type?: string }
    | undefined
  const traj_source = metadata?.source_format ?? metadata?.type
  return {
    frame_idx,
    positions,
    forces: force_cache?.[frame_idx] ??
      frame?.position_data?.forces ??
      cached_frame?.forces ??
      null,
    lattice: lattice ?? null,
    positions_version: trajectory_positions_version.v,
    topology_stable: !frame?.position_data?.topology_changed &&
      traj_source !== `doping_substitution` &&
      traj_source !== `reaction_pathway`,
  }
}

async function request_trajectory_frame_source(
  frame_idx: number,
): Promise<TrajectoryFrameSource | null> {
  const cached = get_trajectory_frame_source(frame_idx)
  if (cached) return cached
  const owner = trajectory
  const loader = (owner as PaneTrajectory | undefined)?.frame_loader
  if (!owner || !loader || frame_has_unmaterialized_ops(owner, frame_idx)) {
    return null
  }
  const source = owner.frame_source_data ?? untrack(() => orig_data) ?? ``
  const first_frame = owner.frames?.[0]
  const base_lattice = first_frame?.position_data?.lattice ??
    (first_frame?.structure as
      | { lattice?: { matrix?: number[][] } }
      | undefined)?.lattice?.matrix ??
    null
  if (loader.load_frame_positions) {
    const data = await loader.load_frame_positions(source, frame_idx)
    if (trajectory !== owner || !data?.positions) return null
    return {
      frame_idx,
      positions: data.positions,
      forces: data.forces ?? null,
      lattice: data.lattice ?? base_lattice,
      positions_version: trajectory_positions_version.v,
      topology_stable: !data.topology_changed,
    }
  }
  const frame = await owner.effective_frames?.resolve(
    frame_idx,
    (idx) => loader.load_frame(source, idx),
  )
  if (trajectory !== owner || !frame?.structure?.sites?.length) return null
  const cached_frame = frame_pos_cache.get(
    frame_idx,
    frame.structure.sites,
  )
  return {
    frame_idx,
    positions: cached_frame.positions,
    forces: frame.position_data?.forces ?? cached_frame.forces ?? null,
    lattice: frame.position_data?.lattice ??
      (frame.structure as
        | { lattice?: { matrix?: number[][] } }
        | undefined)?.lattice?.matrix ??
      base_lattice,
    positions_version: trajectory_positions_version.v,
    topology_stable: false,
  }
}
```

Use `FramePositionData` directly for the position-only loader result. Do not
introduce a second compact-frame cache.

- [ ] **Step 8: Remove the approximation owner**

After the prepared path tests pass, remove:

- `TRAJ_BOND_REFRESH_EVERY`;
- `should_refresh_large_trajectory_bonds`;
- previous-connectivity returns for an unresolved trajectory frame;
- `traj_pending_frame`/`traj_in_flight_frame` latest-wins publication for trajectory packets;
- stale-distance filtering in `conn_to_typed_topology` for prepared graphs.

Keep non-trajectory controller behavior intact.

Move the old cadence implementation, unchanged except for imports, into
`trajectory-bond-legacy-diagnostic.ts`. Dynamically import it only when
`import.meta.env.DEV` is true and the query parameter is exactly
`trajectory_pipeline=legacy`. Production builds and all default tests must
contain no route from a prepared-path failure to this diagnostic module.

- [ ] **Step 9: Run the exact pipeline tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-bond-graph.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/trajectory-bond-refresh-budget.test.ts \
  tests/vitest/trajectory/traj-bond-scheduling.test.ts \
  tests/vitest/structure/trajectory-bond-pairs.test.ts
pnpm check
```

Expected: PASS, no stale-bond/cadence assertions remain, and no new type errors.

- [ ] **Step 10: Commit**

```bash
git add \
  src/lib/structure/trajectory-frame-preparer.ts \
  src/lib/structure/trajectory-bond-legacy-diagnostic.ts \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/Structure.svelte \
  src/lib/trajectory/Trajectory.svelte \
  src/lib/structure/bond-computation-controller.svelte.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/trajectory-bond-refresh-budget.test.ts \
  tests/vitest/trajectory/traj-bond-scheduling.test.ts
git commit -m "feat: publish exact prepared trajectory snapshots"
```

---

## Task 5: Backpressure playback and keep the visible index truthful

**Consumes:** Task 4 presentation acknowledgement.

**Produces:** At most one unpresented current request; playback/scrub holds the last complete frame and visible index until acknowledgement.

**Files:**

- Modify: `src/lib/trajectory/Trajectory.svelte`
- Create: `tests/vitest/trajectory/prepared-playback-backpressure.test.ts`
- Modify: `tests/vitest/trajectory/frame-loading.test.ts`
- Modify: `tests/vitest/trajectory/frame-positions.test.ts`

- [ ] **Step 1: Write failing playback-state tests**

Extract a pure controller local to `Trajectory.svelte` or a sibling tested module with this behavior:

```ts
export type PreparedPlaybackState = {
  requested_idx: number
  presented_idx: number
  generation: number
}

export function request_playback_frame(
  state: PreparedPlaybackState,
  frame_idx: number,
): PreparedPlaybackState

export function acknowledge_playback_frame(
  state: PreparedPlaybackState,
  frame_idx: number,
): PreparedPlaybackState

export function may_advance_playback(
  state: PreparedPlaybackState,
): boolean
```

Tests must prove:

- timer ticks do not advance while `requested_idx !== presented_idx`;
- start/resume waits until the contiguous warmup window contains 3 frames
  (or all remaining frames when fewer than 3 remain);
- an acknowledgement for an obsolete seek is ignored;
- the current request acknowledgement advances `presented_idx`;
- loop `last → 0` starts a new generation;
- direct scrub starts a new generation and leaves `presented_idx` unchanged;
- inspect/export/edit resolve the presented frame and mutations remain disabled
  while a different request is pending;
- pause, edit, and single-frame cases keep their existing behavior.

- [ ] **Step 2: Run the playback test and verify failure**

Run:

```bash
pnpm vitest run tests/vitest/trajectory/prepared-playback-backpressure.test.ts
```

Expected: FAIL because requested/presented state is not separated.

- [ ] **Step 3: Implement requested/presented indices**

Keep `current_step_idx` as the request index for loading. Add:

```ts
let presented_step_idx = $state(0)
let presented_positions_version = $state(0)
let prepared_ready_ahead = $state(0)
let waiting_for_prepared_warmup = $state(false)

function handle_trajectory_frame_presented(
  frame_idx: number,
  positions_version: number,
): void {
  if (frame_idx !== current_step_idx) return
  if (positions_version !== trajectory_positions_version.v) return
  presented_step_idx = frame_idx
  presented_positions_version = positions_version
}
```

Change the interval body to return early while a request is outstanding:

```ts
play_interval = setInterval(() => {
  if (waiting_for_prepared_warmup) {
    const required = Math.min(3, total_frames)
    if (prepared_ready_ahead < required) return
    waiting_for_prepared_warmup = false
  }
  if (current_step_idx !== presented_step_idx) return
  if (current_step_idx >= total_frames - 1) {
    emit_end_for_presented_frame()
    go_to_step(0)
    emit_loop()
  } else {
    next_step()
  }
}, rate_ms)
```

`start_playback()` and resume set
`waiting_for_prepared_warmup = trajectory_scene_props.show_bonds !== false`.
The buffer-state callback updates `prepared_ready_ahead`; a decode/worker
error pauses playback and surfaces the existing error UI. If bonds are hidden,
warmup is unnecessary because atom-only frames acknowledge immediately.

Use `presented_step_idx` for the visible step number, time label, active plot marker, and exported “currently displayed” metadata. Keep the range control's pending thumb/request state explicit with `aria-busy={current_step_idx !== presented_step_idx}`.

Route inspect/export/push-back/edit callbacks through a
`get_presented_frame_data()` lookup keyed by `presented_step_idx`; do not let
the newly loaded requested `current_frame` describe the still-visible previous
snapshot. While `current_step_idx !== presented_step_idx`, disable mutating
canvas/edit actions and keep navigation responsive. Re-enable them in the same
acknowledgement that changes the visible index.

- [ ] **Step 4: Wire the acknowledgement**

Pass:

```svelte
<Structure
  ...
  trajectory_frame_count={total_frames}
  on_trajectory_frame_presented={handle_trajectory_frame_presented}
  on_trajectory_buffer_state={handle_trajectory_buffer_state}
/>
```

When bonds are hidden, acknowledge a raw frame immediately after the atom-only packet is ready; do not wait on bond computation that will not be displayed.

- [ ] **Step 5: Run playback regression tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/trajectory/prepared-playback-backpressure.test.ts \
  tests/vitest/trajectory/frame-loading.test.ts \
  tests/vitest/trajectory/frame-positions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/trajectory/Trajectory.svelte \
  tests/vitest/trajectory/prepared-playback-backpressure.test.ts \
  tests/vitest/trajectory/frame-loading.test.ts \
  tests/vitest/trajectory/frame-positions.test.ts
git commit -m "fix: backpressure trajectory presentation"
```

---

## Task 6: Upload positions once and share them across atom and bond draws

**Consumes:** Task 4's worker-packed RGBA positions and complete packet.

**Produces:** One position texture upload per presented frame; atom and bond renderers fetch from the same resource.

**Files:**

- Create: `src/lib/structure/gpu/webgl2/shared-position-texture.ts`
- Create: `tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts`
- Modify: `src/lib/structure/gpu/webgl2/atom-replica-renderer.ts`
- Modify: `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
- Modify: `tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts`
- Modify: `tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts`

- [ ] **Step 1: Write failing shared-resource tests**

Use this exact resource API:

```ts
import { DataTexture } from 'three'
import type { FrameGeometry } from '../../scene/render-packet'

export type SharedPositionTextureStats = {
  uploads: number
  skipped_same_frame: number
  atom_consumers: number
  bond_consumers: number
  picker_consumers: number
}

export class SharedPositionTexture {
  readonly texture: DataTexture
  update(frame: FrameGeometry, rgba?: Float32Array | null): boolean
  register(consumer: 'atom' | 'bond' | 'picker'): () => void
  stats(): SharedPositionTextureStats
  dispose(): void
}
```

Tests must prove:

- first frame uploads once;
- the same owner/frame/version does not upload again;
- a new version uploads exactly once;
- supplied RGBA is installed without RGB→RGBA packing;
- missing RGBA uses a correct compatibility pack;
- all consumers see the same `DataTexture` identity;
- dispose is idempotent.

- [ ] **Step 2: Run the shared-resource test and verify failure**

Run:

```bash
pnpm vitest run tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts
```

Expected: FAIL because the resource does not exist.

- [ ] **Step 3: Implement `SharedPositionTexture`**

Use `RGBAFormat`, `FloatType`, nearest filtering, no mipmaps, and
`position_texture_shape(atom_count)` from the pure layout module. Set
`texture.image.data`, `texture.image.width`, and `texture.image.height` from
that layout and set `texture.needsUpdate = true` only when the frame
identity/version changes.

Track identity as:

```ts
type UploadedFrame = {
  owner: object
  frame_idx: number
  positions_version: number
}
```

- [ ] **Step 4: Convert the atom renderer to indexed texture fetch**

Replace `attribute vec3 instancePosition` with a base-site index:

```glsl
attribute float instanceSite;
uniform sampler2D uPosTex;
uniform int uPosTexWidth;

vec3 fetchBasePosition(float site) {
  int idx = int(site + 0.5);
  ivec2 uv = ivec2(idx % uPosTexWidth, idx / uPosTexWidth);
  return texelFetch(uPosTex, uv, 0).xyz;
}
```

The main atom draw stores only `instanceSite = 0..N-1`. Ghost atoms store `ghostBaseSite`, not copied xyz. Remove atom-owned per-frame position arrays and buffer uploads.

- [ ] **Step 5: Inject the shared resource into the bond renderer**

Change construction to:

```ts
new BondReplicaRenderer({
  ...style,
  positions: shared_position_texture,
})
```

Delete `#pos_texture`, its RGB→RGBA loop, and its disposal from `BondReplicaRenderer`. Bind `positions.texture` and width to both main and ghost materials.

- [ ] **Step 6: Run renderer tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts
```

Expected: PASS, and test spies observe exactly one texture `needsUpdate` per new frame.

- [ ] **Step 7: Commit**

```bash
git add \
  src/lib/structure/gpu/webgl2/shared-position-texture.ts \
  src/lib/structure/gpu/webgl2/atom-replica-renderer.ts \
  src/lib/structure/gpu/webgl2/bond-replica-renderer.ts \
  tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts
git commit -m "perf: share one WebGL2 position texture"
```

---

## Task 7: Make one WebGL2 layer own atoms and bonds

**Consumes:** Task 6 shared texture and Task 4 complete manager packet.

**Produces:** One packet effect, one position update, and one lifecycle owner for both visible draws.

**Files:**

- Modify: `src/lib/structure/gpu/WebGLReplicaLayer.svelte`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/atoms/AtomManagerInstances.svelte`
- Modify: `src/lib/structure/bonding/BondManagerInstances.svelte`
- Create: `tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts`
- Modify: `tests/vitest/structure/gpu/webgl2-replica-managers.test.ts`
- Modify: `tests/vitest/structure/gpu/webgl2-replica-managers-harness.svelte`

- [ ] **Step 1: Write failing unified-owner tests**

Mount a trajectory packet through the scene/manager harness and assert:

- exactly one `WebGLReplicaLayer` is mounted;
- that layer creates one atom renderer and one bond renderer;
- both receive the identical packet and shared position resource;
- advancing one frame increments the shared upload count by one;
- atom and bond managers do not mount private packet layers;
- static/legacy manager mode still mounts its existing meshes.
- an unsupported packet-render feature selects the legacy managers using the
  presented frame positions, not the requested raw positions.

- [ ] **Step 2: Run the unified-owner test and verify failure**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-managers.test.ts
```

Expected: FAIL because atoms and bonds currently own separate layers.

- [ ] **Step 3: Let the layer own and update the shared resource**

Add props:

```ts
interface Props {
  packet: RenderPacket
  gpu_positions_rgba?: Float32Array | null
  position_resource: SharedPositionTexture
  show_atoms?: boolean
  show_bonds?: boolean
  // existing appearance props remain
}
```

The packet effect order must be:

```ts
position_resource.update(packet.frame, gpu_positions_rgba)
atom_renderer?.update(packet)
bond_renderer?.update(packet)
mark_dirty()
```

The layer does not dispose an injected resource; `StructureScene` owns and disposes it.

- [ ] **Step 4: Add explicit external packet ownership to both managers**

Add:

```ts
packet_renderer_owned?: boolean
```

When true, the manager keeps selection/edit bookkeeping but mounts neither its
packet layer nor its legacy visual mesh for the packet-owned atoms/bonds. When
false, pass `render_packet={null}` so the existing exact legacy visual path
owns that manager.

- [ ] **Step 5: Mount one combined layer in `StructureScene.svelte`**

Create a pure `combined_packet_render_eligible` predicate. It returns false
for per-atom/per-bond opacity overrides, cutting, drag overrides, partial
occupancy wedges, bond-order/multibond rendering, or another visual feature
that `WebGLReplicaLayer` does not implement. These cases use the legacy
managers with Task 4's presented positions. Create one
`SharedPositionTexture` for the scene lifecycle and mount:

```svelte
{#if manager_render_packet && combined_packet_render_eligible && !webgl_suspended}
  <WebGLReplicaLayer
    packet={manager_render_packet}
    gpu_positions_rgba={prepared_gpu_positions}
    position_resource={shared_position_texture}
    show_atoms={show_bulk_atoms}
    show_bonds={show_bonds}
    bond_radius={bond_thickness}
    {incomplete_edge_length_scale}
    ambient_light={active_ambient_light}
    directional_light={active_directional_light}
    {light_dir}
    {render_style}
    {matcap_preset}
    highlight_strength={active_highlight_strength}
    opacity={1}
    ghost_opacity={image_atom_opacity}
  />
{/if}
```

Pass `packet_renderer_owned={manager_render_packet !== null &&
combined_packet_render_eligible}` and
`render_packet={combined_packet_render_eligible ? manager_render_packet :
null}` to both managers. Dispose the scene-owned shared texture exactly once
on scene unmount.

- [ ] **Step 6: Run layer and manager tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-managers.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-atoms.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  src/lib/structure/gpu/WebGLReplicaLayer.svelte \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/atoms/AtomManagerInstances.svelte \
  src/lib/structure/bonding/BondManagerInstances.svelte \
  tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-managers.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-managers-harness.svelte
git commit -m "refactor: unify WebGL2 trajectory draw ownership"
```

---

## Task 8: Make picking on-demand without another position upload

**Consumes:** Task 7 scene-owned shared texture and complete packet.

**Produces:** Atom/bond picking that reads the visible frame's texture and only synchronizes pick IDs/topology during pointer interaction.

**Files:**

- Modify: `src/lib/structure/gpu/webgl2/replica-id-picker.ts`
- Modify: `src/lib/structure/gpu-picker-integration.svelte.ts`
- Create: `tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts`
- Modify: `tests/vitest/structure/gpu/replica-picking.test.ts`

- [ ] **Step 1: Write failing picker-sharing tests**

Assert:

- `ReplicaPickScene` receives `SharedPositionTexture` by injection;
- picker atom and bond materials reference the same texture as visible draws;
- playback with no pointer events creates no picker and performs zero picker syncs;
- the first hover creates/syncs the picker but does not increment position uploads;
- repeated hover on the same packet does not rebuild topology;
- a new presented frame changes pick results through the shared texture without picker-owned RGB→RGBA work;
- atom, bond, replica-cell, and ghost-image IDs remain correct.

- [ ] **Step 2: Run picker tests and verify failure**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts
```

Expected: FAIL because the picker owns duplicate position buffers/textures.

- [ ] **Step 3: Convert picker shaders to shared indexed fetch**

Use the same `uPosTex`, `uPosTexWidth`, and base-site attributes as the visible atom/bond renderers. Remove the pick scene's atom `instancePosition` upload and bond position texture/packing loop.

Construct with:

```ts
new ReplicaPickScene({
  renderer,
  positions: shared_position_texture,
})
```

The picker registers as a consumer but does not call `positions.update`.

- [ ] **Step 4: Keep synchronization event-driven**

In `gpu-picker-integration.svelte.ts`, retain lazy creation inside pointer pick
actions. `sync(packet)` may update pick codec, topology, replica layout, and
viewport; it must not upload frame positions.

- [ ] **Step 5: Run picker and layer tests**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts
```

Expected: PASS with `picker_position_uploads = 0`.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/structure/gpu/webgl2/replica-id-picker.ts \
  src/lib/structure/gpu-picker-integration.svelte.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts
git commit -m "perf: share trajectory positions with picker"
```

---

## Task 9: Harden failure, feature fallback, cache, and context-restore behavior

**Consumes:** The complete prepared/render/picker path.

**Produces:** No approximation under worker failure or advanced features, bounded memory, and reliable WebGL recovery.

**Files:**

- Create: `tests/vitest/structure/trajectory-prepared-failure.test.ts`
- Modify: `src/lib/structure/trajectory-frame-preparer.ts`
- Modify: `src/lib/structure/trajectory-prepared-frame.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/gpu/webgl2/shared-position-texture.ts`
- Modify: `tests/vitest/structure/bond-distance-rules.test.ts`
- Modify: `tests/vitest/structure/bond-orders.test.ts`
- Modify: `tests/vitest/structure/polyhedra-bonds.test.ts`

- [ ] **Step 1: Write failing failure/fallback tests**

Cover:

- typed worker rejection retains the last complete frame and visible index;
- recovery on the next request publishes a complete new frame;
- a small frame may use the existing exact synchronous backend after worker
  failure, while a frame at or above `LARGE_SYSTEM_MIN_ATOMS` pauses and
  reports the worker error without any main-thread or approximate fallback;
- owner change clears old cached frames;
- editing current positions increments the key version and invalidates only affected cache entries;
- distance rules preserve their full override behavior;
- manual/deleted/hidden bonds merge after exact auto topology;
- hydrogen bonds, bond orders, clipping, polyhedra, and drag use the exact object path and do not publish partial frames;
- `show_bonds = false` bypasses bond computation and immediately presents atoms;
- prepared cache never exceeds 8 frames or 96 MiB;
- WebGL context restoration re-uploads the current complete frame once and preserves texture identity for recreated consumers;
- component unmount disposes cached arrays, shared texture, worker listeners, and picker resources.
- default/production execution never imports the legacy diagnostic, and a
  prepared-path error never switches to it.

- [ ] **Step 2: Run failure/fallback tests and verify failure**

Run:

```bash
pnpm vitest run tests/vitest/structure/trajectory-prepared-failure.test.ts
```

Expected: FAIL on at least the newly asserted recovery, feature, and restore cases.

- [ ] **Step 3: Implement explicit eligibility and exact fallback**

Create one predicate whose result is diagnostic:

```ts
export type PreparedPathEligibility =
  | { kind: 'typed-fast' }
  | { kind: 'exact-object'; reasons: string[] }
  | { kind: 'atom-only' }

export function classify_prepared_path(
  input: PreparedPathFeatureInput,
): PreparedPathEligibility
```

The predicate may choose a slower exact path but never an approximate path.
`typed-fast` requires `atom_radii`, stable atom identity/count, no pair-distance
rules, no site-specific bonding-radius override, and no feature that consumes
per-frame `BondPair` objects. Manual/deleted/hidden bonds, hydrogen bonds,
bond-order perception, clipping, polyhedra, drag overrides, and topology
changes select `exact-object` unless they are independently merged after the
exact auto graph with tested identical semantics.
On worker failure, call the existing exact synchronous backend only below
`LARGE_SYSTEM_MIN_ATOMS`. Publish a user-visible non-blocking error and pause
playback when the worker is unavailable for a large frame while retaining the
last complete view. Never select the development legacy diagnostic
automatically.

- [ ] **Step 4: Implement restore and cleanup**

On context loss, retain the current prepared packet in CPU state. On restore, recreate Three.js consumers, mark the existing shared texture data for one upload, and redraw the same frame. Cache eviction and unmount must release references so old frame buffers are garbage-collectable.

- [ ] **Step 5: Run the structure regression set**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-prepared-failure.test.ts \
  tests/vitest/structure/trajectory-bond-pairs.test.ts \
  tests/vitest/structure/bond-distance-rules.test.ts \
  tests/vitest/structure/gpu
pnpm check
```

Expected: PASS, no new type errors, no approximation behavior.

- [ ] **Step 6: Commit**

```bash
git add \
  src/lib/structure/trajectory-frame-preparer.ts \
  src/lib/structure/trajectory-prepared-frame.ts \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/gpu/webgl2/shared-position-texture.ts \
  tests/vitest/structure/trajectory-prepared-failure.test.ts \
  tests/vitest/structure/bond-distance-rules.test.ts \
  tests/vitest/structure/bond-orders.test.ts \
  tests/vitest/structure/polyhedra-bonds.test.ts
git commit -m "fix: harden exact trajectory presentation"
```

---

## Task 10: Add diagnostics and prove correctness/performance on the real trajectory

**Consumes:** All prior tasks and the local real `.traj`.

**Produces:** Reproducible exactness, responsiveness, upload-count, memory, and unique-frame-FPS evidence.

**Files:**

- Modify: `src/lib/structure/trajectory-render-diagnostics.ts`
- Modify: `tests/vitest/structure/trajectory-render-diagnostics.test.ts`
- Modify: `src/lib/structure/trajectory-prepared-frame.ts`
- Modify: `src/lib/structure/trajectory-frame-preparer.ts`
- Modify: `src/lib/structure/gpu/webgl2/shared-position-texture.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Create: `tests/playwright/trajectory-exact-smooth-real-file.spec.ts`
- Modify: `tests/playwright/trajectory-performance.test.ts`
- Update: `docs/superpowers/handoff-traj-round4-review-gate-a.md`

- [ ] **Step 1: Extend diagnostics tests for browser-facing measurements**

Expose a development/test-only snapshot:

```ts
export type TrajectoryRenderDiagnostics = {
  requested_frames: number
  prepared_frames: number
  presented_frames: number
  unique_presented_frames: number
  stale_results: number
  failed_frames: number
  graph_hash_by_frame: Record<number, string>
  bond_count_by_frame: Record<number, number>
  bond_compute_ms: number[]
  cold_first_frame_ms: number | null
  warmup_ms: number | null
  frame_time_p95_ms: number | null
  main_thread_long_tasks: number
  cache_frames: number
  cache_bytes: number
  queued_bytes: number
  in_flight_bytes: number
  retained_bytes: number
  position_uploads: number
  position_upload_bytes: number
  topology_uploads: number
  topology_upload_bytes: number
  picker_position_uploads: number
  presentation_latency_ms: number[]
  unique_frame_fps: number
}
```

Install it only in development/test as:

```ts
globalThis.__catgoTrajectoryDiagnostics = diagnostics.snapshot
```

Tests must distinguish render-loop FPS from unique presented trajectory FPS.

- [ ] **Step 2: Run diagnostics tests and verify failure**

Run the focused unit test chosen for the diagnostics module:

```bash
pnpm vitest run tests/vitest/structure/trajectory-render-diagnostics.test.ts
```

Expected: FAIL because graph hashes, latency rings, upload counters, and
unique-frame FPS are not yet wired into one browser-facing snapshot.

- [ ] **Step 3: Implement allocation-light diagnostics**

Use counters and a fixed-size latency ring buffer. Do not retain full graphs or position arrays. Reset diagnostics on trajectory owner change and expose graph hashes for all 100 reference frames.

- [ ] **Step 4: Add the real-file Playwright gate**

The spec must skip unless both conditions hold:

```ts
const traj_path = process.env.DUMP_TRAJ
const perf_gate = process.env.CATGO_GPU_PERF_GATE === `1`
test.skip(!traj_path || !perf_gate, `real GPU trajectory gate not configured`)
```

The test must:

1. verify the file SHA before launch;
2. build the serial exact reference in a separate browser context and close it;
3. open a fresh measurement context, load
   `/home/james0001/Downloads/dump.traj` through the real UI/drop path, and
   measure cold frame 0 plus the three-frame warmup;
4. play all 100 frames with bonds visible;
5. before playback, run a non-rendering serial reference sweep through the
   exact worker, store only 100 canonical hashes/counts, reset runtime
   diagnostics, then compare all 100 displayed snapshots against that
   independently scheduled reference pass;
6. assert `position_uploads === unique_presented_frames` during uninterrupted
   playback (a deliberate WebGL context restore is the only re-upload
   exception);
7. assert `picker_position_uploads === 0` during playback without pointer movement;
8. issue random seeks while playing and assert input acknowledgement within 100 ms and complete-frame presentation without mixed indices;
9. assert cache frames `≤ 8` and total retained cache/queue/in-flight bytes
   `≤ 96 MiB` on the reference run;
10. assert no worker error, console error, context loss, missing frame, stale publication, or atom/bond mismatch;
11. measure a 4-second warm segment and the remaining steady segment;
12. require unique presented trajectory FPS `≥ 24` in both segments and report the target comparison to 30 FPS.
13. record cold first-frame time, three-frame warmup time, frame-time p95,
    main-thread long tasks, and position/topology upload counts and bytes.

Do not accept compositor FPS as the performance result.

- [ ] **Step 5: Run the real-file gate on the RTX 4060**

Run:

```bash
DUMP_TRAJ=/home/james0001/Downloads/dump.traj \
CATGO_GPU_PERF_GATE=1 \
pnpm playwright test tests/playwright/trajectory-exact-smooth-real-file.spec.ts \
  --project=chromium --workers=1
```

Expected:

- all 100 graph hashes match;
- one position upload per unique presented frame;
- zero picker position uploads during passive playback;
- cache within both bounds;
- input acknowledgement under 100 ms;
- at least 24 unique presented frames/s, with 30 frames/s reported as the target.

If unique-frame FPS is below 24, stop before merge readiness. Use the latency breakdown to optimize the dominant measured stage without weakening exactness, backpressure, or upload-count assertions.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-bond-graph.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/trajectory/prepared-playback-backpressure.test.ts \
  tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts \
  tests/vitest/structure/gpu/webgl2-unified-replica-layer.test.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/trajectory-prepared-failure.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
pnpm test
pnpm check
python -m pytest
git diff --check
```

Expected:

- all tests pass;
- Svelte check has zero errors;
- Python tests pass;
- `git diff --check` prints nothing.

- [ ] **Step 7: Update the handoff with measured evidence**

Record:

- commit SHA and branch;
- exact reference file SHA/shape;
- browser/GPU/backend;
- 100/100 graph-hash result;
- first 4-second and steady unique-frame FPS;
- cold first-frame time, three-frame warmup time, frame-time p95, and
  main-thread long-task count;
- median/p95 bond compute and presentation latency;
- position/topology upload counts and bytes;
- peak prepared cache frames/bytes;
- scrub acknowledgement latency;
- all verification commands and outcomes;
- known non-blocking limitations.

- [ ] **Step 8: Commit**

```bash
git add \
  src/lib/structure/trajectory-render-diagnostics.ts \
  src/lib/structure/trajectory-prepared-frame.ts \
  src/lib/structure/trajectory-frame-preparer.ts \
  src/lib/structure/gpu/webgl2/shared-position-texture.ts \
  src/lib/structure/StructureScene.svelte \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts \
  tests/playwright/trajectory-exact-smooth-real-file.spec.ts \
  tests/playwright/trajectory-performance.test.ts \
  docs/superpowers/handoff-traj-round4-review-gate-a.md
git commit -m "test: gate exact smooth real trajectory playback"
```

---

## Final Merge-Readiness Gate

- [ ] Every displayed frame has matching frame index, positions version, lattice, and graph hash.
- [ ] The eight-frame cadence and stale-bond publication paths no longer exist.
- [ ] Custom/advanced bond features remain exact through the object fallback.
- [ ] Playback never advances its visible index ahead of the complete snapshot.
- [ ] One shared WebGL2 position upload occurs per unique presented frame
  during uninterrupted playback; context restore is the documented re-upload
  exception.
- [ ] Passive playback performs zero picker position uploads.
- [ ] Prepared cache stays at 8 frames or fewer and total retained
  cache/queue/in-flight memory stays at 96 MiB or less on the reference run.
- [ ] Real 100-frame trajectory passes 100/100 exact graph comparisons.
- [ ] RTX 4060 achieves at least 24 unique presented frames/s; 30 is the target.
- [ ] Scrub/play input acknowledgement is under 100 ms.
- [ ] Focused tests, full frontend tests, `pnpm check`, Python tests, and `git diff --check` all pass.
- [ ] Handoff contains measured results rather than projected numbers.
