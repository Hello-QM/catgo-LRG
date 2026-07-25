# OVITO-Informed 40 FPS Exact Trajectory Bonds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve 100/100 exact per-frame bond graphs while raising both measured playback segments of the pinned 100 × 19,968-atom `dump.traj` to at least 40 unique presented FPS through a persistent Rust/WASM bond session and an 11-byte-per-bond WebGL2 topology layout.

**Architecture:** Keep the existing ordered prepared-frame pipeline and atomic presentation contract. Move static chemistry, grid metadata, and grow-only scratch into one worker-owned Rust `TrajectoryBondSession`; rebuild exact occupancy and distances for every frame. Replace CPU-expanded half-bond attributes in the visible renderer and GPU picker with one site-pair plus one jimage record per logical bond, derive half/cell indices from `gl_InstanceID`, and fetch static anchor colors from a topology-keyed RGBA32F texture.

**Tech Stack:** Rust 2024, nalgebra, Rayon, wasm-bindgen, Svelte 5, TypeScript, Three.js WebGL2/GLSL3, Vitest, Playwright, headed Chromium hardware WebGL.

## Global Constraints

- Scientific exactness is immutable: no stale graph, refresh cadence, distance-only filtering, topology budget, truncation, skipped presented frame, or approximate fallback.
- A frame with `N` session atoms is accepted only when `positions.length === 3 × N`. JavaScript and Rust both enforce this and publish nothing after a mismatch.
- Recognized atom-count, atomic-number, stable-site-ID, PBC, strategy, option, rule, or override changes create a new topology fingerprint and session. They are not repaired by truncation.
- Same-count frames without stable IDs make no cross-frame identity or Verlet-reuse assumption.
- A fully periodic fixed lattice may reuse grid geometry and stencil metadata. Mixed/non-periodic grids recompute coordinate extents and grid geometry every frame.
- Visible and picker bond instances use the same compact decode contract.
- WebGL2 remains complete. WebGPU is not required for this implementation.
- Preserve periodic self-image bonds, mixed PBC, thin cells, boundary policies, exact graph order, lengths, strengths, picking IDs, context restoration, and bounded prepared-cache behavior.
- Use strict red-green-refactor TDD. Every production change begins with a failing focused test, ends with its verification gate, and is committed separately.
- Reference file: `/home/james0001/Downloads/dump.traj`.
- Reference SHA-256: `38d4554e93744b7efc53e2add4f7ef90ed8f72557b78e45f0696347434b3e41c`.
- Reference shape: 100 frames × 19,968 atoms.
- Do not add the reference trajectory to Git.
- Never modify or stage `.claude/gate-approvals/`, `.claude/tmp-dump.traj`, or `.superpowers/`.
- Before every commit, inspect `git status --short` and stage only the explicit files named by that task.

## File and Responsibility Map

### New production files

- `src/lib/structure/gpu/webgl2/shared-atom-color-texture.ts`
  - Owns the topology-keyed RGBA32F atom-color texture used by visible bonds.
  - Converts RGB/RGBA topology colors once per topology/color identity and supports context restoration.
- `src/lib/structure/gpu/webgl2/compact-bond-instance-layout.ts`
  - Defines the 11-byte logical bond payload and the shared visible/picker instance decode.
- `src/lib/structure/trajectory-bond-session.ts`
  - Defines topology descriptors, complete-sequence equality/fingerprinting, and the typed JavaScript frame-length error.
- `extensions/rust/src/trajectory_bond.rs`
  - Implements the direct exact trajectory kernel, static chemistry cache, reusable workspace ownership, diagnostics, and native error type.
- `THIRD_PARTY_NOTICES.md`
  - Carries OVITO GmbH's MIT notice, pinned source commit, audited paths, and CatGo modifications.

### Modified production files

- `extensions/rust/src/lib.rs`
  - Exports the native trajectory-bond module.
- `extensions/rust/src/neighbors.rs`
  - Refactors cell-list construction into a reusable `NeighborSearchWorkspace` with fixed-periodic grid-plan reuse and grow-only storage.
- `extensions/rust/src/bonding.rs`
  - Shares the exact atom-radii predicate between the legacy `Structure` entry point and the direct trajectory kernel.
- `extensions/rust/src/wasm.rs`
  - Exposes creation, exact frame compute, diagnostics, and destruction of a mutable worker-owned trajectory session.
- `src/lib/structure/workers/bond-worker-runtime.ts`
  - Adds frame index, stable-site IDs, session diagnostics, and the typed session contract.
- `src/lib/structure/workers/bond-worker-api.ts`
  - Reuses one Rust session per JavaScript session, validates lengths before transfer, and propagates diagnostics.
- `src/lib/structure/workers/bond-worker.ts`
  - Owns the Rust session object, repeats strict length validation at the worker boundary, and calls the session instead of the legacy typed entry point.
- `src/lib/structure/trajectory-frame-preparer.ts`
  - Creates sessions from full topology descriptors, includes fingerprints in prepared keys, and records backend/session diagnostics.
- `src/lib/structure/trajectory-prepared-frame.ts`
  - Adds `topology_fingerprint` to cache/generation identity.
- `src/lib/structure/StructureScene.svelte`
  - Owns the shared color texture beside the shared position texture and restores both after WebGL context restoration.
- `src/lib/structure/gpu/WebGLReplicaLayer.svelte`
  - Injects the shared color resource into the visible bond renderer.
- `src/lib/structure/trajectory-render-diagnostics.ts`
  - Records backend/thread/session/grid/capacity state and compact main-topology payload separately from total topology uploads.
- `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
  - Deletes half-expanded pair/jimage/selector/RGB mirrors and uses compact per-bond attributes plus the static color texture.
- `src/lib/structure/gpu/webgl2/replica-id-picker.ts`
  - Uses the same per-bond divisor and instance decode as the visible renderer.

### Tests and acceptance files

- Create `tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts`.
- Create `tests/vitest/structure/trajectory-bond-session.test.ts`.
- Create `tests/vitest/structure/gpu/ovito-attribution.test.ts`.
- Modify `tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts`.
- Modify `tests/vitest/structure/gpu/replica-picking.test.ts`.
- Modify `tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts`.
- Modify `tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts`.
- Modify `tests/vitest/structure/trajectory-frame-preparer.test.ts`.
- Modify `tests/vitest/structure/trajectory-prepared-frame.test.ts`.
- Modify `tests/vitest/structure/trajectory-render-diagnostics.test.ts`.
- Modify `tests/playwright/trajectory-exact-smooth-real-file.spec.ts`.

---

## Task 1: Add OVITO MIT provenance before adapting the hot path

**Consumes:** OVITO Basic commit `0b2cdccef7452bf28212e15daf9df2dc7a545bcc`, its per-file dual-license header, and `LICENSE.MIT.txt`.

**Produces:** A repository notice plus source-local provenance on both analytic ray-cylinder implementations.

**Files:**

- Create: `THIRD_PARTY_NOTICES.md`
- Create: `tests/vitest/structure/gpu/ovito-attribution.test.ts`
- Modify: `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
- Modify: `src/lib/structure/gpu/webgl2/replica-id-picker.ts`

- [ ] **Step 1: Write the failing attribution test**

Add a Node-environment Vitest test that reads the three files and requires the exact pinned commit, copyright, MIT grant, audited upstream paths, and CatGo modification list:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(path, `utf8`)
const COMMIT = `0b2cdccef7452bf28212e15daf9df2dc7a545bcc`

describe(`OVITO-derived WebGL bond code attribution`, () => {
  test(`retains the MIT notice and pinned provenance`, () => {
    const notice = read(`THIRD_PARTY_NOTICES.md`)
    expect(notice).toContain(`Copyright 2026 OVITO GmbH, Germany`)
    expect(notice).toContain(COMMIT)
    expect(notice).toContain(`Permission is hereby granted, free of charge`)
    expect(notice).toContain(`OpenGLCylinderPrimitive.cpp`)
    expect(notice).toContain(`cylinder.frag`)
    expect(notice).toContain(`WebGL2 GLSL3`)
    expect(notice).toContain(`half-bond replica decoding`)
    expect(notice).toContain(`GPU picking`)
  })

  test.each([
    `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`,
    `src/lib/structure/gpu/webgl2/replica-id-picker.ts`,
  ])(`%s points to the repository notice and pinned source`, (path) => {
    const source = read(path)
    expect(source).toContain(COMMIT)
    expect(source).toContain(`THIRD_PARTY_NOTICES.md`)
    expect(source).toContain(`OVITO GmbH`)
  })
})
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run tests/vitest/structure/gpu/ovito-attribution.test.ts
```

Expected: FAIL because the notice and source-local provenance do not exist.

- [ ] **Step 3: Add the complete notice and source comments**

Create `THIRD_PARTY_NOTICES.md` with the full text from OVITO's `LICENSE.MIT.txt`, name the pinned commit and these audited files:

```text
src/ovito/opengl/OpenGLCylinderPrimitive.cpp
src/ovito/opengl/resources/glsl/cylinder/cylinder.vert
src/ovito/opengl/resources/glsl/cylinder/cylinder.frag
src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.vert
src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.frag
```

Record the material CatGo changes: WebGL2 GLSL3 syntax, Three.js uniforms, half-bond replica decoding, static atom-color lookup, analytic coverage, sparse ghost halves, and GPU picking.

Immediately above the visible and picker analytic cylinder shader constants, add:

```ts
/**
 * Ray-cylinder intersection adapted from OVITO Basic
 * commit 0b2cdccef7452bf28212e15daf9df2dc7a545bcc.
 * Copyright 2026 OVITO GmbH, Germany. Used under the MIT option.
 * Full permission notice and CatGo modifications: THIRD_PARTY_NOTICES.md.
 */
```

- [ ] **Step 4: Run GREEN and formatting checks**

Run:

```bash
pnpm vitest run tests/vitest/structure/gpu/ovito-attribution.test.ts
git diff --check
```

Expected: PASS; `git diff --check` prints nothing.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add \
  THIRD_PARTY_NOTICES.md \
  tests/vitest/structure/gpu/ovito-attribution.test.ts \
  src/lib/structure/gpu/webgl2/bond-replica-renderer.ts \
  src/lib/structure/gpu/webgl2/replica-id-picker.ts
git commit -m "docs: attribute OVITO bond impostor code"
```

---

## Task 2: Add a topology-keyed static atom-color texture

**Consumes:** `BaseTopology.colors`, `BaseTopology.atom_count`, and Three.js `DataTexture`.

**Produces:** One RGBA32F color texel per base atom, uploaded only when topology/color identity changes.

**Files:**

- Create: `src/lib/structure/gpu/webgl2/shared-atom-color-texture.ts`
- Create: `tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts`

- [ ] **Step 1: Write failing color-texture tests**

Test RGB and RGBA inputs, exact float preservation, same-topology no-op, color-only identity change, malformed color length, and restore:

```ts
import { describe, expect, test, vi } from 'vitest'
import { SharedAtomColorTexture } from
  '$lib/structure/gpu/webgl2/shared-atom-color-texture'

test(`packs RGB into exact RGBA32F texels and skips identical topology`, () => {
  const colors = Float32Array.from([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
  const topology = { version: 4, atom_count: 2, colors }
  const resource = new SharedAtomColorTexture()
  expect(resource.update(topology)).toBe(true)
  expect([...(resource.texture.image.data as Float32Array).slice(0, 8)])
    .toEqual([0.1, 0.2, 0.3, 1, 0.7, 0.8, 0.9, 1])
  expect(resource.update(topology)).toBe(false)
  expect(resource.stats()).toMatchObject({ uploads: 1, skipped_same_topology: 1 })
  resource.dispose()
})

test(`a new color array uploads even when the numeric version is reused`, () => {
  const resource = new SharedAtomColorTexture()
  resource.update({
    version: 1,
    atom_count: 1,
    colors: Float32Array.from([1, 0, 0]),
  })
  expect(resource.update({
    version: 1,
    atom_count: 1,
    colors: Float32Array.from([0, 1, 0]),
  })).toBe(true)
  expect(resource.stats().uploads).toBe(2)
  resource.dispose()
})
```

Use a minimal structural input type:

```ts
export type AtomColorTopology = Pick<
  BaseTopology,
  'version' | 'atom_count' | 'colors'
>
```

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the resource**

Implement this public surface:

```ts
export type SharedAtomColorTextureStats = {
  uploads: number
  skipped_same_topology: number
  restores: number
}

export class SharedAtomColorTexture {
  readonly texture: DataTexture
  update(topology: AtomColorTopology): boolean
  restore(): boolean
  stats(): SharedAtomColorTextureStats
  dispose(): void
}
```

Use `position_texture_shape(atom_count)` for width/height, allocate `float_count`, copy RGB or RGBA into RGBA texels without quantization, set alpha to the supplied RGBA alpha or `1`, and reject any length other than `3 × atom_count` or `4 × atom_count` with `RangeError`. The skip key is the triple `(topology.version, colors array identity, atom_count)`: a new color array uploads even if a buggy producer reuses the numeric version, while a per-frame topology wrapper with the same version/colors does not re-upload. Set `NearestFilter`, `RGBAFormat`, `FloatType`, no mipmaps.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts \
  tests/vitest/structure/gpu/webgl2-shared-position-texture.test.ts
pnpm check
git diff --check
```

Expected: all tests pass, `pnpm check` has zero errors, and the diff check is clean.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add \
  src/lib/structure/gpu/webgl2/shared-atom-color-texture.ts \
  tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts
git commit -m "feat: add static atom color texture"
```

---

## Task 3: Compact the visible bond draw to 11 bytes per logical bond

**Consumes:** `BaseBondGraph`, replica dimensions, `SharedPositionTexture`, and `SharedAtomColorTexture`.

**Produces:** One per-bond `a_site`/`a_jimage` record serving both halves and all cells, exact shared decode, and compact upload diagnostics.

**Files:**

- Create: `src/lib/structure/gpu/webgl2/compact-bond-instance-layout.ts`
- Modify: `src/lib/structure/gpu/webgl2/bond-replica-renderer.ts`
- Modify: `src/lib/structure/trajectory-render-diagnostics.ts`
- Modify: `src/lib/structure/gpu/WebGLReplicaLayer.svelte`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts`
- Modify: `tests/vitest/structure/trajectory-render-diagnostics.test.ts`
- Modify: `tests/vitest/structure/trajectory-prepared-failure.test.ts`

- [ ] **Step 1: Replace half-expanded assertions with failing compact assertions**

Define the shared pure contract expected by tests:

```ts
export const COMPACT_BOND_TOPOLOGY_BYTES = 2 * 4 + 3

export type CompactBondInstance = {
  bond_index: number
  half: 0 | 1
  cell_index: number
  cell: [number, number, number]
}

export function decode_compact_bond_instance(
  instance_index: number,
  dims: ReplicaDims,
  out?: CompactBondInstance,
): CompactBondInstance
```

For every test dimension, assert:

```ts
const cell_count = cell_count_of(dims)
const group_size = 2 * cell_count
const bond_index = Math.floor(instance_index / group_size)
const within_bond = instance_index % group_size
const half = Math.floor(within_bond / cell_count) as 0 | 1
const cell_index = within_bond % cell_count
```

Update renderer assertions to require:

```ts
expect(geometry.instanceCount).toBe(BOND_COUNT * 2 * cell_count)
expect(attr(renderer.mesh, `a_site`).count).toBe(BOND_COUNT)
expect(attr(renderer.mesh, `a_jimage`).count).toBe(BOND_COUNT)
expect(attr(renderer.mesh, `a_site`).meshPerAttribute).toBe(2 * cell_count)
expect(attr(renderer.mesh, `a_jimage`).meshPerAttribute).toBe(2 * cell_count)
expect(geometry.getAttribute(`a_half`)).toBeUndefined()
expect(geometry.getAttribute(`a_color`)).toBeUndefined()
expect(snapshot.bond_main_topology_upload_bytes).toBe(BOND_COUNT * 11)
```

Add a color test that inspects `uColorTex`, changes only topology colors, and proves the graph attributes keep their identities while the color texture upload count increments.

Extend the context-restoration test to require the scene's
`webglcontextrestored` handler to call both
`shared_position_texture.restore()` and
`shared_atom_color_texture.restore()`.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
```

Expected: FAIL on the old `2B` attribute counts, old attributes, old 54-byte accounting, and missing compact decoder/diagnostics.

- [ ] **Step 3: Implement the shared decoder and compact CPU mirrors**

In `compact-bond-instance-layout.ts`, validate non-negative integer instance indices and use `cell_count_of` plus x-fastest cell decoding.

In `BondReplicaRenderer`, replace:

```ts
#half_capacity
#half_count
#sites
#jimages
#halves
#colors
```

with:

```ts
#bond_capacity = 0
#bond_count = 0
#sites = new Float32Array(0)
#jimages = new Int8Array(0)
#colors: SharedAtomColorTexture
#owns_colors: boolean
```

Grow `#sites` to `2 × bond_capacity` and `#jimages` to `3 × bond_capacity`. Copy graph arrays directly into the live prefix:

```ts
this.#sites.set(graph.pairs, 0)
this.#jimages.set(graph.jimages, 0)
```

Install both attributes with divisor `2 * cell_count` and set:

```ts
this.#geometry.instanceCount = this.#bond_count * 2 * cell_count
```

Never allocate per-half pair, jimage, selector, or RGB mirrors.

Add `colors?: SharedAtomColorTexture` to `BondReplicaOptions`, inject one
shared instance from `StructureScene.svelte` through
`WebGLReplicaLayer.svelte`, and dispose it only when the renderer created it
internally. Restore the scene-owned color and position textures together on
`webglcontextrestored`.

- [ ] **Step 4: Change the visible shader to derive half/cell and fetch color**

Add `uColorTex` and `uColorTexWidth` beside the position texture. Fetch color with:

```glsl
vec3 fetchBaseColor(float site) {
  int idx = int(site + 0.5);
  ivec2 uv = ivec2(idx % uColorTexWidth, idx / uColorTexWidth);
  return texelFetch(uColorTex, uv, 0).rgb;
}
```

Replace `a_half` decode with:

```glsl
int group_size = 2 * uCellCount;
int within_bond = gl_InstanceID % group_size;
int half = within_bond / uCellCount;
int cell_index = within_bond % uCellCount;
bool is_b_half = half == 1;
```

Set `vColor = fetchBaseColor(is_b_half ? a_site.y : a_site.x)`. Preserve the existing probe, midpoint, stub/hide/ghost behavior, self-image handling, cylinder intersection, caps, and analytic depth.

For sparse ghost pages, keep sites/jimages/cells unchanged but remove `g_color`; fetch endpoint B's color from the same texture in `GHOST_VERTEX_SHADER`.

- [ ] **Step 5: Add compact upload diagnostics**

Extend the recorder with:

```ts
bond_main_topology_uploads: number
bond_main_topology_upload_bytes: number
bond_main_topology_uploaded_bonds: number

record_bond_main_topology_upload(
  bond_count: number,
  bytes: number,
): void
```

Call it once for each graph rewrite with exactly:

```ts
const bytes = bond_count * COMPACT_BOND_TOPOLOGY_BYTES
trajectory_render_diagnostics.record_bond_main_topology_upload(
  bond_count,
  bytes,
)
```

Continue recording total topology bytes, including sparse ghosts, through `record_topology_upload`.

- [ ] **Step 6: Run GREEN**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts \
  tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
pnpm vitest run tests/vitest/structure/trajectory-prepared-failure.test.ts
pnpm check
git diff --check
```

Expected: tests pass; main payload is exactly 11 bytes per logical bond; no `a_half`, `a_color`, or ghost color attribute remains.

- [ ] **Step 7: Commit**

Run:

```bash
git status --short
git add \
  src/lib/structure/gpu/webgl2/compact-bond-instance-layout.ts \
  src/lib/structure/gpu/webgl2/bond-replica-renderer.ts \
  src/lib/structure/trajectory-render-diagnostics.ts \
  src/lib/structure/gpu/WebGLReplicaLayer.svelte \
  src/lib/structure/StructureScene.svelte \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts \
  tests/vitest/structure/trajectory-prepared-failure.test.ts
git commit -m "perf: compact visible bond topology"
```

---

## Task 4: Give the GPU picker the same compact bond contract

**Consumes:** `decode_compact_bond_instance`, compact bond attributes, and `ReplicaIdCodec`.

**Produces:** Picker-visible parity: both halves and all cells map to one logical graph ID without a second half-expanded topology.

**Files:**

- Modify: `src/lib/structure/gpu/webgl2/replica-id-picker.ts`
- Modify: `tests/vitest/structure/gpu/replica-picking.test.ts`
- Modify: `tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts`

- [ ] **Step 1: Write failing compact picker tests**

After `scene.sync(packet)`, assert:

```ts
const geometry = scene.bond_mesh.geometry as THREE.InstancedBufferGeometry
const cell_count = 2
expect(geometry.getAttribute(`a_site`).count).toBe(2)
expect(geometry.getAttribute(`a_jimage`).count).toBe(2)
expect(geometry.getAttribute(`a_site`).meshPerAttribute).toBe(2 * cell_count)
expect(geometry.getAttribute(`a_jimage`).meshPerAttribute).toBe(2 * cell_count)
expect(geometry.getAttribute(`a_half`)).toBeUndefined()
expect(geometry.instanceCount).toBe(2 * 2 * cell_count)
```

Exhaustively iterate `instance_index` for several dimensions. Decode through `decode_compact_bond_instance`, compute the shader-equivalent encoded ID:

```ts
codec.bond_first_id +
  decoded.bond_index +
  codec.base_bond_count * decoded.cell_index
```

and assert `decode_replica_pick_id` returns the same logical bond for both halves.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts
```

Expected: FAIL because the picker still holds `2B` records and `a_half`.

- [ ] **Step 3: Implement compact picker mirrors and shader decode**

Store graph-sized mirrors:

```ts
#bond_capacity = 0
#bond_count = 0
#sites = new Float32Array(0)
#jimages = new Int8Array(0)
```

Grow capacity by the same retained ×1.5 policy as the visible renderer, copy
only the live `pairs` and `jimages` prefixes, and mark only those prefixes as
updated. Install with divisor `2 * cell_count`; set instance count to
`bond_count * 2 * cell_count`. Count changes within capacity must preserve
typed-array and WebGL attribute identity.

In `BOND_PICK_VERTEX_SHADER`, derive:

```glsl
int group_size = 2 * uCellCount;
int within_bond = gl_InstanceID % group_size;
int half = within_bond / uCellCount;
int cell_index = within_bond % uCellCount;
int bond_index = gl_InstanceID / group_size;
bool is_b_half = half == 1;
```

Keep the ID formula:

```glsl
uBondFirstId + bond_index + uBaseBondCount * cell_index
```

and preserve the visible renderer's boundary-policy geometry exactly.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts
pnpm check
git diff --check
```

Expected: all tests pass and visible/picker instance decoding is identical.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add \
  src/lib/structure/gpu/webgl2/replica-id-picker.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts
git commit -m "perf: compact bond picker topology"
```

---

## Task 5: Make topology segments and malformed frame lengths explicit in TypeScript

**Consumes:** packet atomic numbers/site IDs, PBC, atom-radii options, rules version, and frame index.

**Produces:** Full topology descriptor equality, prepared-key fingerprinting, typed length errors, and one JavaScript session per recognized topology segment.

**Files:**

- Create: `src/lib/structure/trajectory-bond-session.ts`
- Create: `tests/vitest/structure/trajectory-bond-session.test.ts`
- Modify: `src/lib/structure/trajectory-prepared-frame.ts`
- Modify: `src/lib/structure/trajectory-frame-preparer.ts`
- Modify: `src/lib/structure/StructureScene.svelte`
- Modify: `src/lib/structure/workers/bond-worker-runtime.ts`
- Modify: `src/lib/structure/workers/bond-worker-api.ts`
- Modify: `src/lib/structure/workers/bond-worker.ts`
- Modify: `tests/vitest/structure/trajectory-prepared-frame.test.ts`
- Modify: `tests/vitest/structure/trajectory-frame-preparer.test.ts`
- Modify: `tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts`

- [ ] **Step 1: Write failing descriptor and typed-error tests**

Require this public contract:

```ts
export type TrajectoryBondSessionDescriptor = {
  atomic_numbers: Uint8Array
  site_ids: Uint32Array | null
  pbc: readonly [boolean, boolean, boolean] | null
  strategy: 'atom_radii'
  options: Readonly<Record<string, number>>
  rules_version: string
}

export function same_trajectory_bond_topology(
  left: TrajectoryBondSessionDescriptor,
  right: TrajectoryBondSessionDescriptor,
): boolean

export function trajectory_bond_topology_fingerprint(
  descriptor: TrajectoryBondSessionDescriptor,
): string

export class TrajectoryBondFrameLengthError extends RangeError {
  readonly session_id: number
  readonly expected_atom_count: number
  readonly expected_float_count: number
  readonly actual_float_count: number
  readonly frame_idx: number | null
}

export function assert_trajectory_bond_frame_length(
  session_id: number,
  expected_atom_count: number,
  actual_float_count: number,
  frame_idx?: number | null,
): void
```

Tests must prove:

- equal copied arrays reuse one topology fingerprint/session;
- changed atom count, any atomic number, any stable site ID, PBC, option, or rules version changes it;
- `site_ids = null` is distinct from an available ID sequence;
- same-count/no-ID motion cannot affect the fingerprint;
- the typed error includes session ID, expected atom/float counts, actual floats, and frame index.

`TrajectoryFrameSource` gains optional
`stable_site_ids?: Uint32Array | null`. Use it only when a loader supplies
real stable IDs; do not treat render-packet `site_ids` synthesized from array
indices as file-provided identity.

- [ ] **Step 2: Add failing worker-boundary tests**

Extend `trajectory_input` with `frame_idx`. Send a two-atom session with 3 or 9 position floats and assert:

```ts
await expect(handle.compute_trajectory_frame_typed(input)).rejects
  .toBeInstanceOf(TrajectoryBondFrameLengthError)
expect(worker.posted).toHaveLength(0)
```

Bypass `RealBondWorkerHandle` and send the malformed message directly to `install_bond_worker`; assert the worker posts the same detailed error and `detect_bonds_radii_typed` is not called.

Add preparer tests proving a changed atomic-number sequence or site-ID sequence creates a different session ID and prepared `topology_fingerprint`, while copied-equal arrays reuse the session.

Add a prepared-pipeline test that begins an old fingerprint request, transitions
to a new fingerprint before the old promise resolves, and asserts the old
result is `stale` and never becomes the displayed/cache value.

- [ ] **Step 3: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-bond-session.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts
```

Expected: FAIL on missing descriptor/error types and old reference-only session identity.

- [ ] **Step 4: Implement complete-sequence identity**

Compare typed arrays element-by-element; compare sorted numeric option entries; compare PBC and rules exactly. Build a deterministic collision-free canonical fingerprint string containing every atomic number and every site ID in order, followed by canonical PBC/options/rules text. Session reuse must still call `same_trajectory_bond_topology` so the diagnostic string is not the only authority.

Snapshot arrays/options when creating `TypedSessionIdentity`; never retain mutable caller arrays as the equality authority.

Add to `PreparedFrameKey`:

```ts
topology_fingerprint: string
```

and include it in `same_prepared_frame_key`, cache lookup, stale-result checks, and keys built by `StructureScene.svelte`/the preparer. A topology transition therefore invalidates queued old-segment results before publication.

- [ ] **Step 5: Enforce strict lengths twice in JavaScript**

Add to `TrajectoryTypedBondInput`:

```ts
frame_idx: number
session: {
  id: number
  topology_fingerprint: string
  atomic_numbers: Uint8Array
  stable_site_ids: Uint32Array | null
  pbc: [boolean, boolean, boolean] | null
  options: Record<string, number>
}
```

Call `assert_trajectory_bond_frame_length`:

1. at the start of `RealBondWorkerHandle.compute_trajectory_frame_typed`, before slicing or posting;
2. in `install_bond_worker`'s `trajectory_frame_typed` branch, before any WASM call or RGBA packing.

Include `frame_idx` and `topology_fingerprint` in the worker messages. `RealBondWorkerHandle` reinitializes when either session ID or fingerprint changes. Never use `Math.floor`, `.subarray(0, expected)`, padding, or partial publication for mismatches.

- [ ] **Step 6: Run GREEN**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-bond-session.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/trajectory-prepared-failure.test.ts
pnpm check
git diff --check
```

Expected: all pass; malformed frames make zero WASM calls and zero publications.

- [ ] **Step 7: Commit**

Run:

```bash
git status --short
git add \
  src/lib/structure/trajectory-bond-session.ts \
  src/lib/structure/trajectory-prepared-frame.ts \
  src/lib/structure/trajectory-frame-preparer.ts \
  src/lib/structure/StructureScene.svelte \
  src/lib/structure/workers/bond-worker-runtime.ts \
  src/lib/structure/workers/bond-worker-api.ts \
  src/lib/structure/workers/bond-worker.ts \
  tests/vitest/structure/trajectory-bond-session.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts
git commit -m "feat: enforce trajectory bond session identity"
```

---

## Task 6: Refactor exact neighbor search into a reusable workspace

**Consumes:** the existing CSR/SoA `CellList`, brute-force small-system path, deterministic traversal order, and `NeighborListConfig`.

**Produces:** A grow-only `NeighborSearchWorkspace` that reuses fixed-periodic grid geometry and all frame scratch while preserving legacy output bytes.

**Files:**

- Modify: `extensions/rust/src/neighbors.rs`

- [ ] **Step 1: Write failing native workspace tests**

Add tests named with the `trajectory_workspace_` prefix for:

- byte/order parity with `build_neighbor_list` on a periodic crystal;
- two fixed-periodic same-lattice frames: one grid rebuild then one grid hit;
- changed lattice: grid rebuild increments;
- mixed/non-periodic same-lattice changed positions: grid rebuild increments every frame;
- stable second-frame capacities: no capacity-growth increment;
- zero atoms, one atom, thin periodic cells, mixed PBC, and unwrapped coordinates;
- default-feature Rayon output equals `--no-default-features` scalar fixture bytes.

Require:

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NeighborWorkspaceStats {
    pub grid_cache_hits: u64,
    pub grid_rebuilds: u64,
    pub capacity_growths: u64,
}

#[derive(Default)]
pub struct NeighborSearchWorkspace {
    fixed_periodic_key: Option<FixedPeriodicGridKey>,
    grid_plan: Option<CellGridPlan>,
    cell_list: CellList,
    neighbors: NeighborList,
    rayon_partials: Vec<NeighborList>,
    stats: NeighborWorkspaceStats,
}

impl NeighborSearchWorkspace {
    pub fn rebuild_from_fractional<'a>(
        &'a mut self,
        frac_coords: &[Vector3<f64>],
        lattice: &Lattice,
        config: &NeighborListConfig,
    ) -> &'a NeighborList;

    pub fn stats(&self) -> NeighborWorkspaceStats;

    pub fn into_neighbor_list(self) -> NeighborList;
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_workspace_ --no-default-features
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_workspace_
```

Expected: compile/test failure because the workspace does not exist.

- [ ] **Step 3: Separate grid plan from frame occupancy**

Extract private `CellGridPlan` fields:

```rust
struct CellGridPlan {
    n_bins: [usize; 3],
    origin_frac: [f64; 3],
    extent_frac: [f64; 3],
    bin_size_frac: [f64; 3],
    stencil: Vec<[i32; 3]>,
    pbc: [bool; 3],
}
```

Use an exact cache key containing atom count, cutoff bits, all nine lattice `f64::to_bits()` values, and PBC. Reuse the plan only when all PBC axes are true and the key is identical. For any false PBC axis, recompute current coordinate extents and the plan every call.

- [ ] **Step 4: Reuse occupancy, SoA, output, and Rayon partial capacities**

Move the current `CellList` vectors into the workspace and update them with `clear`, `resize`, and tracked `reserve` rather than replacement. Retain:

- histogram/prefix offsets;
- bin atoms and linear-bin scratch;
- atom bins and wrap shifts;
- wrapped Cartesian AoS and x/y/z SoA;
- stable counting-sort cursors;
- final `NeighborList`;
- deterministic per-chunk `NeighborList` buffers for Rayon.

Clear Rayon chunk lists and append them in ascending center-range order. Do not change scan order or pair/image conventions.

- [ ] **Step 5: Make the legacy entry point use the same workspace implementation**

Implement `build_neighbor_list` as a one-shot workspace call for the cell-list path, cloning/moving the completed `NeighborList` only at the public ownership boundary. This prevents session and legacy algorithms from drifting.

- [ ] **Step 6: Run GREEN and full neighbor tests**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_workspace_ --no-default-features
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_workspace_
cargo test --manifest-path extensions/rust/Cargo.toml neighbors::tests
cargo fmt --manifest-path extensions/rust/Cargo.toml --check
git diff --check
```

Expected: scalar and Rayon tests pass with deterministic identical ordering; fixed periodic frame 2 reports a hit and no new capacity growth.

- [ ] **Step 7: Commit**

Run:

```bash
git status --short
git add extensions/rust/src/neighbors.rs
git commit -m "perf: reuse exact neighbor search workspace"
```

---

## Task 7: Implement the direct exact Rust trajectory bond session

**Consumes:** atomic numbers, atom-radii options, PBC, raw typed positions/lattice, `NeighborSearchWorkspace`, and the legacy exact bond predicate.

**Produces:** Cached chemistry, direct current-frame exact compute, reusable result scratch, native typed mismatch errors, and session diagnostics.

**Files:**

- Create: `extensions/rust/src/trajectory_bond.rs`
- Modify: `extensions/rust/src/lib.rs`
- Modify: `extensions/rust/src/bonding.rs`

- [ ] **Step 1: Write failing session parity and lifecycle tests**

Define and test:

```rust
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct TrajectoryBondSessionStats {
    pub frame_count: u64,
    pub grid_cache_hits: u64,
    pub grid_rebuilds: u64,
    pub capacity_growths: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TrajectoryBondSessionError {
    #[error(
        "trajectory bond session {session_id} frame {frame_idx:?}: positions \
         length {actual_float_count} != expected {expected_float_count} \
         for {expected_atom_count} atoms"
    )]
    PositionLengthMismatch {
        session_id: u32,
        expected_atom_count: usize,
        expected_float_count: usize,
        actual_float_count: usize,
        frame_idx: Option<u32>,
    },
    #[error("trajectory bond session {session_id}: lattice must have 0 or 9 values, got {actual}")]
    LatticeLengthMismatch { session_id: u32, actual: usize },
    #[error("trajectory bond session {session_id}: site {site_idx} has unknown atomic number {atomic_number}")]
    UnknownAtomicNumber {
        session_id: u32,
        site_idx: usize,
        atomic_number: u8,
    },
}

pub struct TrajectoryBondSession {
    session_id: u32,
    atomic_numbers: Vec<u8>,
    effective_radii: Vec<f64>,
    pbc: [bool; 3],
    options: AtomRadiiOptions,
    cutoff: f64,
    cart_coords: Vec<Vector3<f64>>,
    frac_coords: Vec<Vector3<f64>>,
    neighbor_config: NeighborListConfig,
    neighbor_workspace: NeighborSearchWorkspace,
    bonds: Vec<Bond>,
    capacity_growths: u64,
    frame_count: u64,
}

impl TrajectoryBondSession {
    pub fn new(
        session_id: u32,
        atomic_numbers: &[u8],
        pbc: [bool; 3],
        options: AtomRadiiOptions,
    ) -> Result<Self, TrajectoryBondSessionError>;

    pub fn compute_frame(
        &mut self,
        positions: &[f32],
        lattice: &[f64],
        frame_idx: Option<u32>,
    ) -> Result<&[Bond], TrajectoryBondSessionError>;

    pub fn stats(&self) -> TrajectoryBondSessionStats;
}
```

Compare the session result byte-for-byte with `detect_bonds_atom_radii` for:

- the real predicate's ordinary periodic case;
- zero atoms;
- one non-periodic atom;
- one periodic self-image atom;
- thin multi-image periodic cell;
- mixed PBC;
- unwrapped positions;
- changed lattice;
- repeated fixed-lattice frames;
- malformed position and lattice lengths followed by a valid frame, proving no partial result leaks.

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_bond::tests --no-default-features
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_bond::tests
```

Expected: compile failure because the module/session does not exist.

- [ ] **Step 3: Share one exact predicate**

Refactor `BondEvalInput` to borrow an effective-radius slice rather than full `ElementProps`, then expose a crate-private driver:

```rust
pub(crate) fn collect_bonds_atom_radii_from_neighbor_list(
    effective_radii: &[f64],
    options: &AtomRadiiOptions,
    neighbors: &NeighborList,
    out: &mut Vec<Bond>,
)
```

Both legacy `detect_bonds_atom_radii` and the session must call this driver. It clears and reuses `out` capacity; the legacy entry point supplies a fresh vector while the session supplies its retained vector. Preserve center ordering, endpoint/image canonicalization, minimum-distance check, upper bound, lengths, strengths, and Rayon ordered chunk flattening.

- [ ] **Step 4: Cache immutable chemistry and direct frame scratch**

At construction, validate every atomic number and store effective covalent radii, parsed options, PBC, exact cutoff, and grow-only Cartesian/fractional vectors.

For each valid frame:

1. convert every `f32` xyz to cached `Vector3<f64>` storage;
2. build current lattice or the same non-periodic padded bounding box semantics as `detect_bonds_radii_typed`;
3. compute fractional coordinates into reused storage;
4. call `NeighborSearchWorkspace::rebuild_from_fractional`;
5. call the shared exact predicate;
6. retain only the current result;
7. update stats after successful completion.

Perform all input validation before clearing the last valid result. Errors must leave session state usable and return no partial graph.

- [ ] **Step 5: Run GREEN and legacy parity**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_bond::tests --no-default-features
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_bond::tests
cargo test --manifest-path extensions/rust/Cargo.toml \
  bonding::tests
cargo fmt --manifest-path extensions/rust/Cargo.toml --check
git diff --check
```

Expected: all direct-session fixtures are byte-identical to the legacy entry point in scalar and default Rayon builds.

- [ ] **Step 6: Commit**

Run:

```bash
git status --short
git add \
  extensions/rust/src/trajectory_bond.rs \
  extensions/rust/src/lib.rs \
  extensions/rust/src/bonding.rs
git commit -m "feat: add exact Rust trajectory bond session"
```

---

## Task 8: Wire the Rust session through WASM and the worker

**Consumes:** native `TrajectoryBondSession`, current worker session messages, typed graph transfers, and runtime backend selection.

**Produces:** One mutable Rust session per worker topology segment, frame-only exact calls, Rust final-defense errors, and propagated session metrics.

**Files:**

- Modify: `extensions/rust/src/wasm.rs`
- Modify: `src/lib/structure/workers/bond-worker.ts`
- Modify: `src/lib/structure/workers/bond-worker-api.ts`
- Modify: `src/lib/structure/workers/bond-worker-runtime.ts`
- Modify: `tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts`

- [ ] **Step 1: Change fake glue tests to require a Rust session object**

Extend the glue test surface:

```ts
export interface BondWorkerTrajectorySessionGlue {
  compute_frame(
    positions: Float32Array,
    lattice: Float64Array,
    frame_idx: number,
  ): {
    pairs: Uint32Array
    images: Int8Array
    lengths: Float32Array
    strengths: Float32Array
    free(): void
  }
  diagnostics_json(): string
  free(): void
}

export interface BondWorkerGlue {
  create_trajectory_bond_session(
    session_id: number,
    atomic_numbers: Uint8Array,
    pbc: Uint8Array,
    options_json?: string,
  ): BondWorkerTrajectorySessionGlue
}
```

Tests must prove:

- one init creates exactly one Rust session;
- repeated frames call `compute_frame` and never `detect_bonds_radii_typed`;
- changed session frees the old Rust object before creating the replacement;
- malformed input reaching Rust is surfaced and publishes no typed arrays;
- frame responses include session diagnostics;
- worker replacement initializes exactly one new Rust session.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts
```

Expected: FAIL because the worker still calls `detect_bonds_radii_typed`.

- [ ] **Step 3: Export a wasm-bindgen session wrapper**

In `wasm.rs`, add:

```rust
#[wasm_bindgen]
pub struct WasmTrajectoryBondSession {
    inner: crate::trajectory_bond::TrajectoryBondSession,
}

#[wasm_bindgen]
pub fn create_trajectory_bond_session(
    session_id: u32,
    atomic_numbers: &[u8],
    pbc: &[u8],
    options_json: Option<String>,
) -> Result<WasmTrajectoryBondSession, JsValue>;

#[wasm_bindgen]
impl WasmTrajectoryBondSession {
    pub fn compute_frame(
        &mut self,
        positions: &[f32],
        lattice: &[f64],
        frame_idx: u32,
    ) -> Result<BondTable, JsValue>;

    pub fn diagnostics_json(&self) -> String;
}
```

Map `TrajectoryBondSessionError` to a JavaScript `Error` whose `name` is `TrajectoryBondFrameLengthError` for length mismatches and whose properties contain all typed fields. Convert the current borrowed bonds into an owning `BondTable` before returning so later session calls cannot mutate a prepared frame's arrays.

- [ ] **Step 4: Replace the worker's metadata-only session**

Store:

```ts
let trajectory_session: {
  id: number
  atom_count: number
  rust: BondWorkerTrajectorySessionGlue
} | null = null
let trajectory_session_initializations = 0
let active_thread_count = 1
```

On `trajectory_session_init`, free the old object, call `create_trajectory_bond_session`, increment initialization count, and reply ready only after success. On `trajectory_frame_typed`, run the JavaScript guard then `rust.compute_frame`. Post:

```ts
session_diagnostics: {
  ...JSON.parse(trajectory_session.rust.diagnostics_json()),
  session_initializations: trajectory_session_initializations,
  thread_count: active_thread_count,
}
```

Keep RGBA packing and all output transfer lists unchanged.

- [ ] **Step 5: Propagate metrics through API/runtime**

Add:

```ts
export type TrajectoryBondSessionDiagnostics = {
  thread_count: number
  session_initializations: number
  frame_count: number
  grid_cache_hits: number
  grid_rebuilds: number
  capacity_growths: number
}
```

Include it in `TrajectoryFrameWorkerResult` and `ComputeTrajectoryFrameTypedResult`. Preserve `backend` from `create_bond_worker_runtime`. Store the actual constructor `thread_count` in `RealBondWorkerHandle`; do not infer threaded status from browser capability after initialization.

Also add `threading_expected: boolean` to
`ComputeTrajectoryFrameTypedResult`. Set it from the initial
`select_rust_bond_backend` result before attempting initialization, retain it
when a threaded initialization falls back to scalar, and return it with every
compute. This distinguishes “threads unsupported” from “threads expected but
failed.”

- [ ] **Step 6: Build and verify both WASM artifacts**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml \
  trajectory_bond::tests
pnpm build:wasm -- --only ferrox
pnpm verify:wasm
pnpm vitest run \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/workers/bond-worker-selection.test.ts
pnpm check
git diff --check
```

Expected: scalar and threaded artifacts export the session API, worker tests pass, and no generated artifact is manually edited.

- [ ] **Step 7: Commit**

Generated `extensions/rust-wasm/pkg*` outputs are build artifacts and are not staged unless `git ls-files` shows them as tracked. Run:

```bash
git status --short
git add \
  extensions/rust/src/wasm.rs \
  src/lib/structure/workers/bond-worker.ts \
  src/lib/structure/workers/bond-worker-api.ts \
  src/lib/structure/workers/bond-worker-runtime.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts
git commit -m "perf: use persistent WASM bond session"
```

---

## Task 9: Expose session/backend evidence at the prepared-frame boundary

**Consumes:** `ComputeTrajectoryFrameTypedResult.backend`, session diagnostics, compact renderer counters, and the existing browser snapshot.

**Produces:** Gate-visible backend/thread/session/grid/capacity evidence without retaining frame buffers.

**Files:**

- Modify: `src/lib/structure/trajectory-render-diagnostics.ts`
- Modify: `src/lib/structure/trajectory-frame-preparer.ts`
- Modify: `tests/vitest/structure/trajectory-render-diagnostics.test.ts`
- Modify: `tests/vitest/structure/trajectory-frame-preparer.test.ts`

- [ ] **Step 1: Write failing diagnostics tests**

Require snapshot fields:

```ts
bond_backend: BondBackendKind | null
bond_threading_expected: boolean
bond_thread_count: number
bond_session_initializations: number
bond_session_frames: number
bond_grid_cache_hits: number
bond_grid_rebuilds: number
bond_capacity_growths: number
```

and recorder method:

```ts
record_bond_session(
  backend: BondBackendKind,
  threading_expected: boolean,
  diagnostics: TrajectoryBondSessionDiagnostics,
): void
```

Test that repeated cumulative worker snapshots do not sum twice: the recorder keeps the latest monotonic values for one owner. Owner reset clears them. No typed array or session object appears in `snapshot()`.

Mock a typed preparer result and assert it records backend and diagnostics exactly once before returning the immutable prepared frame.

- [ ] **Step 2: Run RED**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts
```

Expected: FAIL because session/backend fields are missing.

- [ ] **Step 3: Implement recording at the typed result boundary**

Initialize backend to `null`, threading-expected to `false`, and numeric fields to zero. In `record_bond_session`, assign backend/threading-expected/thread count and take `Math.max` for cumulative counters. In the typed-fast branch immediately after the worker result:

```ts
trajectory_render_diagnostics.record_bond_session(
  result.backend,
  result.threading_expected,
  result.session_diagnostics,
)
```

Object and atom-only paths must not fabricate Rust session metrics.

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm vitest run \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts
pnpm check
git diff --check
```

Expected: all pass and the browser snapshot remains scalar-only metadata.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add \
  src/lib/structure/trajectory-render-diagnostics.ts \
  src/lib/structure/trajectory-frame-preparer.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts
git commit -m "feat: report trajectory bond session metrics"
```

---

## Task 10: Raise and pass the real exact hardware gate

**Consumes:** all mandatory implementation stages, the pinned real trajectory, independent exact reference sweep, and headed RTX 4060 WebGL.

**Produces:** Fresh evidence for 100/100 exactness, at least 40 FPS in both segments, compact payload, bounded memory, session reuse, and stable GL context.

**Files:**

- Modify: `tests/playwright/trajectory-exact-smooth-real-file.spec.ts`

- [ ] **Step 1: Raise the measurement rate and acceptance assertions**

Set:

```ts
const MIN_UNIQUE_FPS = 40
const TARGET_FPS = 60
```

Rename the test to `real dump.traj is exact and presents at least 40 unique FPS`.

Extend `Diagnostics` and the final JSON with every Task 3/9 field. Add:

```ts
expect(snapshot.bond_main_topology_upload_bytes)
  .toBeLessThanOrEqual(snapshot.bond_main_topology_uploaded_bonds * 11)
expect(snapshot.bond_session_frames).toBeGreaterThan(0)
expect(snapshot.bond_grid_cache_hits).toBeGreaterThan(0)
expect(snapshot.bond_grid_rebuilds).toBeGreaterThan(0)
expect(snapshot.bond_backend).toMatch(/^rust-wasm-(threads|scalar)$/)
```

When `bond_threading_expected` is true, require `bond_backend === 'rust-wasm-threads'` and `bond_thread_count >= 2`; do not silently accept scalar fallback. Keep all existing exactness, upload, cache, seek, error, context, and GL assertions.

- [ ] **Step 2: Run the focused non-hardware gate**

Run:

```bash
cargo test --manifest-path extensions/rust/Cargo.toml --lib
pnpm vitest run \
  tests/vitest/structure/gpu/ovito-attribution.test.ts \
  tests/vitest/structure/gpu/webgl2-shared-atom-color-texture.test.ts \
  tests/vitest/structure/gpu/webgl2-replica-bonds.test.ts \
  tests/vitest/structure/gpu/replica-picking.test.ts \
  tests/vitest/structure/gpu/replica-picking-shared-positions.test.ts \
  tests/vitest/structure/trajectory-bond-session.test.ts \
  tests/vitest/structure/trajectory-prepared-frame.test.ts \
  tests/vitest/structure/trajectory-frame-preparer.test.ts \
  tests/vitest/structure/workers/bond-worker-trajectory-frame.test.ts \
  tests/vitest/structure/workers/bond-worker-selection.test.ts \
  tests/vitest/structure/trajectory-render-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the headed real-file gate**

Run:

```bash
DUMP_TRAJ=/home/james0001/Downloads/dump.traj \
CATGO_GPU_PERF_GATE=1 \
pnpm playwright test tests/playwright/trajectory-exact-smooth-real-file.spec.ts \
  --project=chromium --workers=1
```

Required result:

- pinned hash and 100 × 19,968 shape;
- RTX 4060 Laptop GPU hardware renderer;
- 100/100 graph hashes and counts match the independent exact sweep;
- first four-second unique presented FPS ≥ 40;
- steady unique presented FPS ≥ 40;
- no failed, stale, approximate, truncated, or skipped presented frame;
- position uploads equal unique presented frames;
- passive picker position uploads equal zero;
- compact main topology payload ≤ 11 bytes per uploaded logical bond;
- cache ≤ 8 frames and retained prepared state < 96 MiB;
- random-seek acknowledgement < 100 ms;
- threaded backend and thread count match capability selection;
- session initializes once per topology segment, grid hits occur on fixed lattice, and capacity growth stabilizes;
- zero context loss, page/console errors, and GL errors.

- [ ] **Step 4: If either FPS segment is below 40, diagnose before changing code**

Do not weaken the gate or commit Task 10. Invoke `superpowers:systematic-debugging`, capture a Chrome performance trace plus the new diagnostics, and select exactly one measured branch:

1. scalar active when threads are expected → repair COI/SAB/atomics/Rayon initialization;
2. compute p95 > 25 ms → profile Rust session allocation/conversion/search and remove the largest remaining exact hot spot;
3. main topology preparation/upload dominates → retain 11 logical bytes but test one interleaved stable VBO update;
4. GPU fragment time dominates → adapt one OVITO MIT shader optimization with pixel/depth/picking parity tests;
5. genuine threaded Rust remains the hard limit → plan the existing exact WebGPU grid backend as optional preparation with complete WASM fallback.

Write the selected evidence and concrete red-green task into a dated follow-up plan, commit it, execute it with `superpowers:executing-plans`, and rerun this exact Task 10 gate. Repeat until both segments pass. This measured loop is mandatory because the remaining bottleneck cannot be chosen safely before the first post-implementation trace.

- [ ] **Step 5: Run every final verification gate after the real gate passes**

Run:

```bash
pnpm verify:wasm
cargo test --manifest-path extensions/rust/Cargo.toml --lib
pnpm test
pnpm check
python -m pytest
git diff --check
git status --short
```

Expected:

- Rust tests pass;
- full frontend suite passes;
- Svelte check has zero errors;
- Python baseline passes;
- `git diff --check` prints nothing;
- only the explicitly protected local paths remain untracked/unstaged.

- [ ] **Step 6: Commit the passing gate**

Run:

```bash
git add tests/playwright/trajectory-exact-smooth-real-file.spec.ts
git commit -m "test: require 40 fps exact trajectory bonds"
```

- [ ] **Step 7: Record final evidence**

Report:

- branch and final commit SHA;
- reference SHA and shape;
- browser, GPU, active backend, and Rayon thread count;
- exact graph result;
- first/steady unique FPS;
- cold/warmup/frame p95/long-task metrics;
- compute median/p95 and presentation median/p95;
- Rust session initialization/frame/grid/capacity counters;
- position and compact/total topology upload counts and bytes;
- cache/retained peaks and max seek acknowledgement;
- focused/full/Rust/Python/type/diff gate results;
- confirmation that protected paths were untouched and unstaged.

## Plan Completion Checklist

- [ ] Every production edit began with a failing focused test.
- [ ] Every task has one focused commit.
- [ ] No plan step contains a placeholder implementation.
- [ ] TypeScript interfaces agree across preparer, runtime, API, worker, renderer, picker, diagnostics, and tests.
- [ ] Native and WASM session APIs agree on session ID, frame index, arrays, errors, and diagnostics.
- [ ] Scalar and Rayon exact outputs are byte-identical.
- [ ] Visible and picker compact decode are identical.
- [ ] Main bond topology accounting is exactly 11 bytes per logical bond.
- [ ] OVITO MIT notice and pinned provenance are retained.
- [ ] The real gate passes 100/100 exactness and both ≥40 FPS segments.
- [ ] All final verification gates have fresh output.
- [ ] `.claude/gate-approvals/`, `.claude/tmp-dump.traj`, and `.superpowers/` remain unmodified and unstaged.
