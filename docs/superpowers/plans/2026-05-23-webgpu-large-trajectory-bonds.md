# WebGPU Large-Trajectory Bond Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually-toggled, dedicated WebGPU compute+render path so million-atom trajectories render smoothly, with per-frame GPU bond perception (atom_radii, minimum-image PBC) and GPU-resident bonds read back to CPU only on pause/interaction.

**Architecture:** A parallel "large-system performance mode" that lives beside the existing Three.js/WebGL path (untouched). When the user toggles it on, a WebGPU device computes bonds per frame (uniform-grid neighbor search) and renders impostor spheres + instanced bonds directly from GPU buffers — no per-frame CPU readback. On pause/selection/export, one compute dispatch is read back to populate the existing `bond_state.bond_connectivity`. When WebGPU is unavailable, the toggle falls back to the existing CPU/worker path plus a hard atom cap warning.

**Tech Stack:** TypeScript, Svelte 5 runes, WebGPU (`navigator.gpu`) + WGSL, Three.js 0.181 (existing WebGL path), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-05-23-webgpu-large-trajectory-bonds-design.md`

**Reference facts (verified):**
- Test runner: `pnpm exec vitest run` (RTK serves stale vitest output — bypass with `rtk proxy pnpm exec vitest run`).

> **⚠️ TEST PLACEMENT & IMPORTS (overrides every per-task literal below).** Vitest `include` is `tests/vitest/**/*.test.ts` and `src/**/__tests__/**/*.test.ts` — tests do NOT colocate next to source. For every task:
> - **Source** files go at `src/lib/structure/gpu/<name>.ts` (as written).
> - **Test** files go at `tests/vitest/structure/gpu/<name>.test.ts` (NOT the `src/lib/structure/gpu/<name>.test.ts` shown in task "Files"/"Test" lines).
> - Inside tests, import production code via the **`$lib` alias**: `import { X } from '$lib/structure/gpu/<name>'` (NOT the relative `./<name>` shown in test code). Helpers: `create_test_structure` from `../setup`, `test_molecules` from `$site/molecules`.
> - `vitest run` and `git add` paths for tests use `tests/vitest/structure/gpu/...`.
> Mirror `tests/vitest/structure/bonding.test.ts` for style.
- Types (`src/lib/structure/index.ts`): `Site = { species: Species[]; abc: Vec3; xyz: Vec3 }`; `PymatgenLattice = { matrix: Matrix3x3 }`; `PymatgenStructure = PymatgenMolecule & { lattice: PymatgenLattice }`; `AnyStructure = PymatgenStructure | PymatgenMolecule`.
- CPU bond oracle: `compute_bonds_sync(structure, 'atom_radii', options)` in `src/lib/structure/workers/bond-worker-api.ts:158` → `BondPair[] | null`. Rust path emits cross-cell `image` (jimage). `options` is `Record<string, number>` (keys include `max_bond_dist`, `tolerance`).
- Covalent radii data: default-export numeric array in `src/lib/element/data.ts` (indexed by atomic number; see `src/lib/element/covalent_radii.d.ts`).
- `bond_connectivity` entry type (`bond-computation-controller.svelte.ts:52`): `{ site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }`.
- `bond_state` is created by `create_bond_state()` in `bond-computation-controller.svelte.ts`; `bond_state.bond_connectivity` is a `$state` array of the above entry type.

**Testing reality:** CI has no GPU. Pure-JS units are TDD'd normally. WGSL compute correctness is verified by a **device-gated golden test**: `describe.skipIf(!device)` comparing GPU bond output against the JS reference oracle (Task 4) on small/medium structures. Render correctness is a manual smoke (Task 9) plus a device-gated single-pixel readback (Task 8).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/structure/gpu/webgpu-context.ts` | Device/adapter acquisition, capability detection, async init, fallback signal. |
| `src/lib/structure/gpu/radius-lut.ts` | Build per-atom element-index array + covalent-radius table from a structure. Pure. |
| `src/lib/structure/gpu/frame-buffers.ts` | Pack frame positions + lattice into typed arrays for GPU upload. Pure. |
| `src/lib/structure/gpu/bond-detect-reference.ts` | JS reference: uniform-grid + minimum-image + atom_radii predicate. Oracle for WGSL. Pure. |
| `src/lib/structure/gpu/bond-compute.wgsl.ts` | WGSL compute shader source as a string. |
| `src/lib/structure/gpu/bond-compute.ts` | Compute pipeline wrapper: buffers, bind groups, dispatch, count readback. |
| `src/lib/structure/gpu/camera-uniform.ts` | Pack a Three camera into view/proj uniform bytes. Pure. |
| `src/lib/structure/gpu/large-system-renderer.ts` | WGSL render: impostor spheres + instanced bonds + selection + id-pick. |
| `src/lib/structure/gpu/large-system-mode.svelte.ts` | Orchestrator: toggle state, canvas switch, frame upload, playback loop, readback-on-pause → `bond_state`. |
| `tests/vitest/structure/gpu/*.test.ts` | Tests per module (see TEST PLACEMENT note above). |

Each `gpu/` module has one responsibility and a narrow interface; `large-system-mode` is the only one that knows about `StructureScene`/`bond_state`.

---

## Task 1: WebGPU context & capability detection

**Files:**
- Create: `src/lib/structure/gpu/webgpu-context.ts`
- Test: `src/lib/structure/gpu/webgpu-context.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// webgpu-context.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { is_webgpu_supported, acquire_webgpu_device } from './webgpu-context'

afterEach(() => { vi.unstubAllGlobals() })

describe('webgpu-context', () => {
  it('is_webgpu_supported reflects navigator.gpu presence', () => {
    vi.stubGlobal('navigator', {})
    expect(is_webgpu_supported()).toBe(false)
    vi.stubGlobal('navigator', { gpu: {} })
    expect(is_webgpu_supported()).toBe(true)
  })

  it('acquire_webgpu_device returns null when unsupported', async () => {
    vi.stubGlobal('navigator', {})
    expect(await acquire_webgpu_device()).toBeNull()
  })

  it('acquire_webgpu_device returns null when adapter unavailable', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } })
    expect(await acquire_webgpu_device()).toBeNull()
  })

  it('acquire_webgpu_device returns the device on success', async () => {
    const fake_device = { label: 'd' }
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => ({ requestDevice: async () => fake_device }) },
    })
    expect(await acquire_webgpu_device()).toBe(fake_device)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/webgpu-context.test.ts`
Expected: FAIL — cannot find module `./webgpu-context`.

- [ ] **Step 3: Implement**

```ts
// webgpu-context.ts
/** WebGPU device acquisition + capability detection. No rendering logic here. */

export function is_webgpu_supported(): boolean {
  return typeof navigator !== `undefined` && `gpu` in navigator && navigator.gpu != null
}

let cached_device: GPUDevice | null = null

/** Acquire a GPUDevice, or null if WebGPU is unavailable / acquisition fails.
 *  Result is cached for the process lifetime. */
export async function acquire_webgpu_device(): Promise<GPUDevice | null> {
  if (cached_device !== null) return cached_device
  if (!is_webgpu_supported()) return null
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: `high-performance` })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    cached_device = device
    return device
  } catch {
    return null
  }
}

/** Test-only: reset the cached device. */
export function __reset_device_cache(): void { cached_device = null }
```

- [ ] **Step 4: Run test, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/webgpu-context.test.ts`
Expected: PASS (4 tests). Note: the cache makes `acquire_webgpu_device` sticky — add `__reset_device_cache()` in `afterEach` if a later test needs isolation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/webgpu-context.ts src/lib/structure/gpu/webgpu-context.test.ts
git commit -m "feat(gpu): WebGPU device acquisition + capability detection"
```

---

## Task 2: Element covalent-radius LUT

**Files:**
- Create: `src/lib/structure/gpu/radius-lut.ts`
- Test: `src/lib/structure/gpu/radius-lut.test.ts`

A bond detector needs, per atom, a covalent radius. We pack two arrays: `atom_radius` (Float32Array, one radius per atom, taking each site's primary species) so the shader does a single buffer lookup per atom.

- [ ] **Step 1: Write failing test**

```ts
// radius-lut.test.ts
import { describe, it, expect } from 'vitest'
import { build_atom_radii } from './radius-lut'
import type { Site } from '$lib/structure'

function site(element: string, xyz: [number, number, number]): Site {
  return { species: [{ element, occu: 1, oxidation_state: 0 } as never], abc: [0, 0, 0], xyz } as Site
}

describe('build_atom_radii', () => {
  it('returns one finite radius per site, using the primary species', () => {
    const sites = [site('H', [0, 0, 0]), site('O', [1, 0, 0]), site('C', [2, 0, 0])]
    const radii = build_atom_radii(sites)
    expect(radii).toBeInstanceOf(Float32Array)
    expect(radii.length).toBe(3)
    for (const r of radii) expect(r).toBeGreaterThan(0)
    // O radius < C radius (covalent radii: O ~0.66, C ~0.76)
    expect(radii[1]).toBeLessThan(radii[2])
  })

  it('falls back to a default radius for unknown elements', () => {
    const radii = build_atom_radii([site('Xx', [0, 0, 0])])
    expect(radii[0]).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/radius-lut.test.ts`
Expected: FAIL — cannot find module `./radius-lut`.

- [ ] **Step 3: Implement**

```ts
// radius-lut.ts
import type { Site } from '$lib/structure'
import { element_data } from '$lib/element/data'

const DEFAULT_RADIUS = 1.0 // Å, fallback for elements with no covalent radius

/** Per-atom covalent radius (Å), one entry per site, from the site's primary
 *  species. Used as the GPU radius lookup for atom_radii bond detection. */
export function build_atom_radii(sites: readonly Site[]): Float32Array {
  const out = new Float32Array(sites.length)
  for (let i = 0; i < sites.length; i++) {
    const elem = sites[i].species[0]?.element
    out[i] = covalent_radius_of(elem) ?? DEFAULT_RADIUS
  }
  return out
}

function covalent_radius_of(element: string | undefined): number | null {
  if (!element) return null
  const entry = element_data.find((e) => e.symbol === element)
  const r = entry?.covalent_radius
  return typeof r === `number` && r > 0 ? r : null
}
```

> **Note for implementer:** Confirm the export shape of `src/lib/element/data.ts`. The reference grep shows a default-exported array. If the module exports `default` rather than a named `element_data`, import as `import element_data from '$lib/element/data'` and adjust. If entries key element by `symbol`/`name` and store radius under a different field (e.g. `covalent_radius` vs an array indexed by atomic number), adapt `covalent_radius_of` to match — keep the function's contract (symbol → radius|null) identical so the test stays valid.

- [ ] **Step 4: Run test, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/radius-lut.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/radius-lut.ts src/lib/structure/gpu/radius-lut.test.ts
git commit -m "feat(gpu): per-atom covalent radius LUT builder"
```

---

## Task 3: Frame position + lattice packing

**Files:**
- Create: `src/lib/structure/gpu/frame-buffers.ts`
- Test: `src/lib/structure/gpu/frame-buffers.test.ts`

The GPU needs a tightly-packed `Float32Array` of xyz positions and a 9-float lattice matrix. Trajectory frames already arrive as a `Float32Array` (3N) in the existing traj path; this module normalizes both "structure sites" and "raw frame Float32Array" into the same packed layout, and extracts the lattice.

- [ ] **Step 1: Write failing test**

```ts
// frame-buffers.test.ts
import { describe, it, expect } from 'vitest'
import { pack_positions, pack_lattice } from './frame-buffers'
import type { Site, PymatgenLattice } from '$lib/structure'

function site(xyz: [number, number, number]): Site {
  return { species: [{ element: 'C', occu: 1 } as never], abc: [0, 0, 0], xyz } as Site
}

describe('pack_positions', () => {
  it('packs site xyz into a flat Float32Array(3N)', () => {
    const out = pack_positions([site([1, 2, 3]), site([4, 5, 6])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns a raw Float32Array frame unchanged (already 3N)', () => {
    const frame = new Float32Array([7, 8, 9])
    expect(pack_positions(frame)).toBe(frame)
  })
})

describe('pack_lattice', () => {
  it('flattens a 3x3 lattice matrix row-major into Float32Array(9)', () => {
    const lat: PymatgenLattice = { matrix: [[1, 0, 0], [0, 2, 0], [0, 0, 3]] } as PymatgenLattice
    expect(Array.from(pack_lattice(lat))).toEqual([1, 0, 0, 0, 2, 0, 0, 0, 3])
  })

  it('returns a zero matrix for a non-periodic (no-lattice) structure', () => {
    expect(Array.from(pack_lattice(undefined))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/frame-buffers.test.ts`
Expected: FAIL — cannot find module `./frame-buffers`.

- [ ] **Step 3: Implement**

```ts
// frame-buffers.ts
import type { Site, PymatgenLattice } from '$lib/structure'

/** Pack atom positions into a flat Float32Array(3N), row = (x,y,z).
 *  A raw trajectory frame (already a 3N Float32Array) is returned as-is. */
export function pack_positions(input: readonly Site[] | Float32Array): Float32Array {
  if (input instanceof Float32Array) return input
  const out = new Float32Array(input.length * 3)
  for (let i = 0; i < input.length; i++) {
    const [x, y, z] = input[i].xyz
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  }
  return out
}

/** Flatten a 3x3 lattice matrix (rows = lattice vectors a,b,c) row-major into
 *  Float32Array(9). Non-periodic structures (no lattice) → all zeros, which the
 *  compute shader treats as "no PBC". */
export function pack_lattice(lattice: PymatgenLattice | undefined): Float32Array {
  const out = new Float32Array(9)
  const m = lattice?.matrix
  if (!m) return out
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = m[r][c]
  return out
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/frame-buffers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/frame-buffers.ts src/lib/structure/gpu/frame-buffers.test.ts
git commit -m "feat(gpu): frame position + lattice packing"
```

---

## Task 4: JS reference bond detector (the WGSL oracle)

**Files:**
- Create: `src/lib/structure/gpu/bond-detect-reference.ts`
- Test: `src/lib/structure/gpu/bond-detect-reference.test.ts`

This is the source of truth the WGSL shader must match. It implements the same atom_radii predicate as Rust `detect_bonds_atom_radii`, with minimum-image PBC. Keeping it in JS lets us (a) golden-test the GPU shader, and (b) reason about correctness without a GPU.

Predicate (matches `extensions/rust/src/bonding.rs` atom_radii): a bond exists between atoms i<j iff `min_dist² ≤ d² ≤ (r_i + r_j + tolerance)²` AND `d ≤ max_bond_dist`, where `d` is the **minimum-image** distance under the lattice. `min_dist` defaults to a tiny epsilon to drop coincident atoms. Output `jimage` is the image offset (in lattice units) applied to atom j to realize the minimum image.

- [ ] **Step 1: Write failing test**

```ts
// bond-detect-reference.test.ts
import { describe, it, expect } from 'vitest'
import { detect_bonds_reference, type RefBondOptions } from './bond-detect-reference'

const OPTS: RefBondOptions = { tolerance: 0.45, max_bond_dist: 3.0, min_dist: 0.1 }

describe('detect_bonds_reference', () => {
  it('finds a single bond between two close atoms (non-periodic)', () => {
    const pos = new Float32Array([0, 0, 0, 1.0, 0, 0]) // 1.0 Å apart
    const radii = new Float32Array([0.76, 0.76]) // C-C, sum+tol = 1.97
    const zero = new Float32Array(9) // no lattice
    const bonds = detect_bonds_reference(pos, zero, radii, OPTS)
    expect(bonds).toHaveLength(1)
    expect(bonds[0]).toMatchObject({ a: 0, b: 1, jimage: [0, 0, 0] })
  })

  it('rejects atoms beyond radius sum + tolerance', () => {
    const pos = new Float32Array([0, 0, 0, 2.5, 0, 0]) // 2.5 Å, > 0.76+0.76+0.45
    const radii = new Float32Array([0.76, 0.76])
    const bonds = detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)
    expect(bonds).toHaveLength(0)
  })

  it('rejects beyond max_bond_dist even if within radius sum', () => {
    const pos = new Float32Array([0, 0, 0, 2.9, 0, 0])
    const radii = new Float32Array([2.0, 2.0]) // sum+tol huge, but max_bond_dist=3 ok; use 3.1
    const opts = { ...OPTS, max_bond_dist: 2.0 }
    const bonds = detect_bonds_reference(pos, new Float32Array(9), radii, opts)
    expect(bonds).toHaveLength(0)
  })

  it('finds a minimum-image bond across a periodic boundary', () => {
    // Cubic 5 Å cell; atoms at x=0.2 and x=4.9 are 4.7 apart direct,
    // but 0.3 apart across the boundary (min image).
    const pos = new Float32Array([0.2, 0, 0, 4.9, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    const lat = new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5])
    const bonds = detect_bonds_reference(pos, lat, radii, OPTS)
    expect(bonds).toHaveLength(1)
    expect(bonds[0].jimage).toEqual([1, 0, 0]) // atom b imaged by +a to reach atom a
  })

  it('drops coincident atoms (below min_dist)', () => {
    const pos = new Float32Array([0, 0, 0, 0.01, 0, 0])
    const radii = new Float32Array([0.76, 0.76])
    const bonds = detect_bonds_reference(pos, new Float32Array(9), radii, OPTS)
    expect(bonds).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-detect-reference.test.ts`
Expected: FAIL — cannot find module `./bond-detect-reference`.

- [ ] **Step 3: Implement**

```ts
// bond-detect-reference.ts
export type RefBondOptions = { tolerance: number; max_bond_dist: number; min_dist: number }
export type RefBond = { a: number; b: number; dist: number; jimage: [number, number, number] }

/** Reference atom_radii bond detector with minimum-image PBC. Matches the
 *  Rust detect_bonds_atom_radii predicate. O(N²) — for test/oracle use and
 *  small structures only; the GPU path uses a uniform grid for scale. */
export function detect_bonds_reference(
  positions: Float32Array, // 3N
  lattice: Float32Array, // 9, row-major; all-zero ⇒ non-periodic
  radii: Float32Array, // N
  opts: RefBondOptions,
): RefBond[] {
  const n = radii.length
  const periodic = lattice.some((v) => v !== 0)
  const out: RefBond[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = positions[j * 3] - positions[i * 3]
      const dy = positions[j * 3 + 1] - positions[i * 3 + 1]
      const dz = positions[j * 3 + 2] - positions[i * 3 + 2]
      const mi = periodic
        ? minimum_image(dx, dy, dz, lattice)
        : { d2: dx * dx + dy * dy + dz * dz, jimage: [0, 0, 0] as [number, number, number] }
      const d = Math.sqrt(mi.d2)
      if (d < opts.min_dist || d > opts.max_bond_dist) continue
      const cutoff = radii[i] + radii[j] + opts.tolerance
      if (d <= cutoff) out.push({ a: i, b: j, dist: d, jimage: mi.jimage })
    }
  }
  return out
}

/** Minimum-image displacement for an orthogonal-or-not 3x3 lattice. Searches
 *  the 27 nearest images (offset components in {-1,0,1}) and returns the
 *  closest, with the integer image applied to atom b. Adequate for bond-length
 *  cutoffs ≪ cell size (the large-trajectory regime). */
function minimum_image(
  dx: number, dy: number, dz: number, L: Float32Array,
): { d2: number; jimage: [number, number, number] } {
  let best = { d2: Infinity, jimage: [0, 0, 0] as [number, number, number] }
  for (let na = -1; na <= 1; na++) {
    for (let nb = -1; nb <= 1; nb++) {
      for (let nc = -1; nc <= 1; nc++) {
        // image shift = na*a + nb*b + nc*c (lattice rows are a,b,c)
        const sx = na * L[0] + nb * L[3] + nc * L[6]
        const sy = na * L[1] + nb * L[4] + nc * L[7]
        const sz = na * L[2] + nb * L[5] + nc * L[8]
        const ex = dx + sx, ey = dy + sy, ez = dz + sz
        const d2 = ex * ex + ey * ey + ez * ez
        if (d2 < best.d2) best = { d2, jimage: [na, nb, nc] }
      }
    }
  }
  return best
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-detect-reference.test.ts`
Expected: PASS (5 tests). If the min-image jimage sign disagrees with `compute_bonds_sync`'s convention, align the sign here and document it — this convention is the contract the WGSL shader and the readback bridge (Task 8) both follow.

- [ ] **Step 5: Cross-check oracle against the production CPU detector**

Add one test that builds a small `PymatgenStructure`, runs both `compute_bonds_sync(struct, 'atom_radii', {max_bond_dist, tolerance})` and `detect_bonds_reference(...)`, and asserts the **bond pair sets match** (as unordered `{min(a,b)}-{max(a,b)}` strings). This guards against the oracle drifting from Rust.

```ts
it('matches compute_bonds_sync on a small periodic cell', async () => {
  const { compute_bonds_sync } = await import('$lib/structure/workers/bond-worker-api')
  // ...build a 4-8 atom PymatgenStructure with a lattice...
  // const cpu = compute_bonds_sync(struct, 'atom_radii', { max_bond_dist: 3, tolerance: 0.45 })
  // const ref = detect_bonds_reference(pack_positions(struct.sites), pack_lattice(struct.lattice), build_atom_radii(struct.sites), { tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 })
  // expect(pair_set(ref)).toEqual(pair_set(cpu))  // skip if compute_bonds_sync returns null (WASM not init in test env)
})
```

> If `compute_bonds_sync` returns `null` in the vitest env (Rust WASM not initialized), guard the assertion with an early return and leave the structural test in place for when WASM is available. Do not delete it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/structure/gpu/bond-detect-reference.ts src/lib/structure/gpu/bond-detect-reference.test.ts
git commit -m "feat(gpu): JS reference bond detector (atom_radii, minimum-image PBC)"
```

---

## Task 5: WGSL compute shader source

**Files:**
- Create: `src/lib/structure/gpu/bond-compute.wgsl.ts`
- Test: none yet (compiled/dispatched in Task 6; this task only defines the string and a smoke that it's non-empty WGSL).
- Test: `src/lib/structure/gpu/bond-compute.wgsl.test.ts`

v1 uses a uniform spatial grid. To keep the first GPU version simple and matchable to the oracle, this shader computes, **per atom i**, bonds against all atoms j>i by scanning candidate cells (27-neighborhood of i's cell), applying minimum-image + atom_radii, and appending `(i, j, jimage_packed)` to an output buffer via an atomic counter. (Grid build is a separate small dispatch; see Task 6.)

- [ ] **Step 1: Write failing test**

```ts
// bond-compute.wgsl.test.ts
import { describe, it, expect } from 'vitest'
import { BOND_COMPUTE_WGSL } from './bond-compute.wgsl'

describe('BOND_COMPUTE_WGSL', () => {
  it('is a non-empty WGSL string with the expected entry points', () => {
    expect(typeof BOND_COMPUTE_WGSL).toBe('string')
    expect(BOND_COMPUTE_WGSL).toContain('@compute')
    expect(BOND_COMPUTE_WGSL).toContain('fn detect_bonds')
    expect(BOND_COMPUTE_WGSL).toContain('atomicAdd')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-compute.wgsl.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// bond-compute.wgsl.ts
/** WGSL compute for atom_radii bond detection with minimum-image PBC.
 *  Bindings:
 *   0: positions   storage<read>      array<f32>  (3N, xyz interleaved)
 *   1: radii       storage<read>      array<f32>  (N)
 *   2: params      uniform            Params
 *   3: out_pairs   storage<read_write> array<u32> (capacity*3: a, b, jimage_packed)
 *   4: out_count   storage<read_write> atomic<u32>
 *  jimage_packed: (na+1) | ((nb+1)<<2) | ((nc+1)<<4), each in {0,1,2} for {-1,0,1}. */
export const BOND_COMPUTE_WGSL = /* wgsl */ `
struct Params {
  n_atoms: u32,
  capacity: u32,
  periodic: u32,
  _pad0: u32,
  tolerance: f32,
  max_bond_dist: f32,
  min_dist: f32,
  _pad1: f32,
  lattice: mat3x3<f32>, // rows a,b,c
};

@group(0) @binding(0) var<storage, read> positions: array<f32>;
@group(0) @binding(1) var<storage, read> radii: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var<storage, read_write> out_pairs: array<u32>;
@group(0) @binding(4) var<storage, read_write> out_count: atomic<u32>;

fn pos(i: u32) -> vec3<f32> {
  return vec3<f32>(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
}

fn pack_jimage(na: i32, nb: i32, nc: i32) -> u32 {
  return u32(na+1) | (u32(nb+1) << 2u) | (u32(nc+1) << 4u);
}

@compute @workgroup_size(64)
fn detect_bonds(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.n_atoms) { return; }
  let pi = pos(i);
  let ri = radii[i];
  // v1: O(N) per atom over all j>i. Grid acceleration is layered in Task 6
  // via a candidate list; the predicate below is the contract under test.
  for (var j: u32 = i + 1u; j < P.n_atoms; j = j + 1u) {
    let dvec = pos(j) - pi;
    var best_d2 = 1e30;
    var bi: i32 = 0; var bj: i32 = 0; var bk: i32 = 0;
    if (P.periodic == 1u) {
      for (var na: i32 = -1; na <= 1; na = na + 1) {
        for (var nb: i32 = -1; nb <= 1; nb = nb + 1) {
          for (var nc: i32 = -1; nc <= 1; nc = nc + 1) {
            let shift = f32(na)*P.lattice[0] + f32(nb)*P.lattice[1] + f32(nc)*P.lattice[2];
            let e = dvec + shift;
            let d2 = dot(e, e);
            if (d2 < best_d2) { best_d2 = d2; bi = na; bj = nb; bk = nc; }
          }
        }
      }
    } else {
      best_d2 = dot(dvec, dvec);
    }
    let d = sqrt(best_d2);
    if (d < P.min_dist || d > P.max_bond_dist) { continue; }
    if (d <= ri + radii[j] + P.tolerance) {
      let slot = atomicAdd(&out_count, 1u);
      if (slot < P.capacity) {
        out_pairs[slot*3u + 0u] = i;
        out_pairs[slot*3u + 1u] = j;
        out_pairs[slot*3u + 2u] = pack_jimage(bi, bj, bk);
      }
    }
  }
}
`
```

> **WGSL note:** `mat3x3<f32>` columns are accessed as `P.lattice[0/1/2]`. WGSL stores mat3x3 column-major; when uploading from `pack_lattice` (row-major a,b,c as rows), upload the **transpose** so columns are a,b,c — Task 6 handles the upload layout and its test pins it. The `shift = na*col0 + nb*col1 + nc*col2` here assumes columns are a,b,c.

- [ ] **Step 4: Run, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-compute.wgsl.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/bond-compute.wgsl.ts src/lib/structure/gpu/bond-compute.wgsl.test.ts
git commit -m "feat(gpu): WGSL bond-detect compute shader (atom_radii, min-image)"
```

---

## Task 6: Compute pipeline wrapper + device-gated golden test

**Files:**
- Create: `src/lib/structure/gpu/bond-compute.ts`
- Test: `src/lib/structure/gpu/bond-compute.test.ts`

Wraps the shader: creates buffers/bind group, packs the `Params` uniform (with the lattice **transposed** for column-major WGSL), dispatches, and reads back the bond count + pairs (readback used here for testing and for the on-pause bridge — NOT in the playback loop).

- [ ] **Step 1: Write the device-gated golden test**

```ts
// bond-compute.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { acquire_webgpu_device } from './webgpu-context'
import { create_bond_compute } from './bond-compute'
import { detect_bonds_reference } from './bond-detect-reference'

let device: GPUDevice | null = null
beforeAll(async () => { device = await acquire_webgpu_device() })

const pair_set = (bonds: { a: number; b: number }[]) =>
  new Set(bonds.map((b) => `${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`))

describe.skipIf(!globalThis.navigator?.gpu)('bond-compute (GPU)', () => {
  it('matches the JS reference on a small periodic cell', async () => {
    if (!device) return // no device in this env
    const positions = new Float32Array([0.2, 0, 0, 4.9, 0, 0, 0.2, 1.2, 0])
    const radii = new Float32Array([0.76, 0.76, 0.76])
    const lattice = new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5])
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_dist: 0.1 }
    const ref = detect_bonds_reference(positions, lattice, radii, opts)

    const compute = create_bond_compute(device, { capacity: 1024 })
    const gpu = await compute.run({ positions, radii, lattice, periodic: true, ...opts })

    expect(gpu.count).toBe(ref.length)
    expect(pair_set(gpu.pairs)).toEqual(pair_set(ref))
  })
})
```

- [ ] **Step 2: Run, verify it fails (or skips cleanly)**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-compute.test.ts`
Expected: in CI (no GPU) the suite is SKIPPED; locally with a GPU it FAILS — `create_bond_compute` not found.

- [ ] **Step 3: Implement**

```ts
// bond-compute.ts
import { BOND_COMPUTE_WGSL } from './bond-compute.wgsl'

export type BondComputeOptions = { tolerance: number; max_bond_dist: number; min_dist: number }
export type BondComputeRun = BondComputeOptions & {
  positions: Float32Array
  radii: Float32Array
  lattice: Float32Array // 9, row-major (a,b,c rows)
  periodic: boolean
}
export type BondComputeResult = {
  count: number
  pairs: { a: number; b: number; jimage: [number, number, number] }[]
}

const PARAMS_BYTES = 16 /*u32x4 + f32x4*/ + 64 /*mat3x4 padded*/ // 80, aligned

/** Compute pipeline for atom_radii bond detection. `run` dispatches and reads
 *  back (used for tests + the on-pause CPU bridge). The playback loop keeps
 *  the bond buffer GPU-resident and does NOT call run(); it reuses `dispatch`
 *  (Task 7 wires render directly to the buffer). */
export function create_bond_compute(device: GPUDevice, cfg: { capacity: number }) {
  const module = device.createShaderModule({ code: BOND_COMPUTE_WGSL })
  const pipeline = device.createComputePipeline({ layout: `auto`, compute: { module, entryPoint: `detect_bonds` } })

  async function run(r: BondComputeRun): Promise<BondComputeResult> {
    const n = r.radii.length
    const pos_buf = make_storage(device, r.positions)
    const rad_buf = make_storage(device, r.radii)
    const pairs_buf = device.createBuffer({ size: cfg.capacity * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const count_buf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(count_buf, 0, new Uint32Array([0]))
    const params_buf = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(params_buf, 0, pack_params(n, cfg.capacity, r))

    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: pos_buf } },
        { binding: 1, resource: { buffer: rad_buf } },
        { binding: 2, resource: { buffer: params_buf } },
        { binding: 3, resource: { buffer: pairs_buf } },
        { binding: 4, resource: { buffer: count_buf } },
      ],
    })

    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(Math.ceil(n / 64))
    pass.end()
    // readback (test + on-pause only)
    const count_read = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const pairs_read = device.createBuffer({ size: cfg.capacity * 3 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    enc.copyBufferToBuffer(count_buf, 0, count_read, 0, 4)
    enc.copyBufferToBuffer(pairs_buf, 0, pairs_read, 0, cfg.capacity * 3 * 4)
    device.queue.submit([enc.finish()])

    await count_read.mapAsync(GPUMapMode.READ)
    const count = Math.min(new Uint32Array(count_read.getMappedRange())[0], cfg.capacity)
    count_read.unmap()
    await pairs_read.mapAsync(GPUMapMode.READ)
    const raw = new Uint32Array(pairs_read.getMappedRange().slice(0))
    pairs_read.unmap()

    const pairs: BondComputeResult['pairs'] = []
    for (let i = 0; i < count; i++) {
      const a = raw[i * 3], b = raw[i * 3 + 1], jp = raw[i * 3 + 2]
      pairs.push({ a, b, jimage: unpack_jimage(jp) })
    }
    return { count, pairs }
  }

  return { pipeline, run }
}

function make_storage(device: GPUDevice, data: Float32Array): GPUBuffer {
  const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buf, 0, data)
  return buf
}

/** Pack the Params uniform. Lattice uploaded TRANSPOSED so WGSL column-major
 *  mat3x3 columns equal lattice rows a,b,c. mat3x3 in WGSL pads each column to
 *  vec4 (16 bytes) → 48 bytes; we lay it out at offset 16. */
function pack_params(n: number, capacity: number, r: BondComputeRun): ArrayBuffer {
  const buf = new ArrayBuffer(PARAMS_BYTES)
  const u = new Uint32Array(buf), f = new Float32Array(buf)
  u[0] = n; u[1] = capacity; u[2] = r.periodic ? 1 : 0; u[3] = 0
  f[4] = r.tolerance; f[5] = r.max_bond_dist; f[6] = r.min_dist; f[7] = 0
  // columns a,b,c at float offsets 8.., each padded to 4 floats
  const L = r.lattice
  const col = (rIdx: number, o: number) => { f[o] = L[rIdx * 3]; f[o + 1] = L[rIdx * 3 + 1]; f[o + 2] = L[rIdx * 3 + 2]; f[o + 3] = 0 }
  col(0, 8); col(1, 12); col(2, 16)
  return buf
}

function unpack_jimage(p: number): [number, number, number] {
  return [(p & 0x3) - 1, ((p >> 2) & 0x3) - 1, ((p >> 4) & 0x3) - 1]
}
```

- [ ] **Step 4: Run the golden test (locally, with a GPU)**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/bond-compute.test.ts`
Expected (with GPU): PASS — GPU pair set equals reference. (CI: SKIPPED.)
If it fails on jimage, re-check the transpose in `pack_params` and the pack/unpack convention against Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/bond-compute.ts src/lib/structure/gpu/bond-compute.test.ts
git commit -m "feat(gpu): bond compute pipeline + device-gated golden test"
```

---

## Task 7: Camera uniform packing

**Files:**
- Create: `src/lib/structure/gpu/camera-uniform.ts`
- Test: `src/lib/structure/gpu/camera-uniform.test.ts`

The WebGPU renderer must match the Three camera exactly so toggling modes doesn't jump. We pack `viewProjection` (mat4) + camera world position into a uniform.

- [ ] **Step 1: Write failing test**

```ts
// camera-uniform.test.ts
import { describe, it, expect } from 'vitest'
import { pack_camera_uniform } from './camera-uniform'

// Minimal fake matching the fields we read from a THREE.Camera.
function fake_camera() {
  return {
    matrixWorldInverse: { elements: Array.from({ length: 16 }, (_, i) => i) },
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => 100 + i) },
    position: { x: 1, y: 2, z: 3 },
  }
}

describe('pack_camera_uniform', () => {
  it('packs proj*view (column-major) then camera position', () => {
    const out = pack_camera_uniform(fake_camera() as never)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(20) // 16 mat + 3 pos + 1 pad
    expect(out[16]).toBe(1); expect(out[17]).toBe(2); expect(out[18]).toBe(3)
  })
}) 
```

- [ ] **Step 2: Run, verify fail**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/camera-uniform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// camera-uniform.ts
import { Matrix4 } from 'three'
import type { Camera } from 'three'

const _vp = new Matrix4()

/** Pack proj * view (column-major, WebGPU-ready) followed by camera world
 *  position (vec3 + pad) into Float32Array(20). */
export function pack_camera_uniform(camera: Camera): Float32Array {
  _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  const out = new Float32Array(20)
  out.set(_vp.elements, 0) // three stores column-major already
  out[16] = camera.position.x
  out[17] = camera.position.y
  out[18] = camera.position.z
  out[19] = 0
  return out
}
```

- [ ] **Step 4: Run, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/camera-uniform.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/camera-uniform.ts src/lib/structure/gpu/camera-uniform.test.ts
git commit -m "feat(gpu): camera uniform packing for WebGPU render path"
```

---

## Task 8: Orchestrator — toggle, frame loop, readback bridge

**Files:**
- Create: `src/lib/structure/gpu/large-system-mode.svelte.ts`
- Test: `src/lib/structure/gpu/large-system-mode.test.ts`

This is the only module that touches `bond_state`. It owns: the `enabled` toggle (manual), the per-frame upload+compute+render trigger, and the **readback bridge** that converts a `BondComputeResult` into `bond_state.bond_connectivity` entries (translating the v1 packed jimage into the `[na,nb,nc]` array form the rest of the app expects). v1 keeps the compute/render wiring thin (delegated to Tasks 6 + 9); the unit-tested surface here is the toggle state machine and the readback translation.

- [ ] **Step 1: Write failing test**

```ts
// large-system-mode.test.ts
import { describe, it, expect } from 'vitest'
import { result_to_connectivity } from './large-system-mode'

describe('result_to_connectivity', () => {
  it('translates compute pairs into bond_connectivity entries', () => {
    const conn = result_to_connectivity({
      count: 2,
      pairs: [
        { a: 0, b: 1, jimage: [0, 0, 0] },
        { a: 1, b: 2, jimage: [1, 0, 0] },
      ],
    })
    expect(conn).toEqual([
      { site_idx_1: 0, site_idx_2: 1, strength: 1, jimage: [0, 0, 0] },
      { site_idx_1: 1, site_idx_2: 2, strength: 1, jimage: [1, 0, 0] },
    ])
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/large-system-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (state machine + bridge)**

```ts
// large-system-mode.svelte.ts
import type { BondComputeResult } from './bond-compute'

type BondConn = { site_idx_1: number; site_idx_2: number; strength: number; jimage: [number, number, number] }

/** Translate a GPU bond result into the app's bond_connectivity entries.
 *  atom_radii strength is 1.0 (matches Rust detect_bonds_atom_radii). */
export function result_to_connectivity(result: BondComputeResult): BondConn[] {
  const out: BondConn[] = new Array(result.count)
  for (let i = 0; i < result.count; i++) {
    const p = result.pairs[i]
    out[i] = { site_idx_1: p.a, site_idx_2: p.b, strength: 1, jimage: p.jimage }
  }
  return out
}

/** Manual large-system performance mode. Svelte 5 runes state; wired into
 *  StructureScene in Task 9. WebGPU availability is injected so the toggle can
 *  refuse + signal fallback when no device. */
export function create_large_system_mode(deps: {
  has_webgpu: boolean
  on_fallback: (reason: string) => void
}) {
  let enabled = $state(false)
  return {
    get enabled() { return enabled },
    get available() { return deps.has_webgpu },
    enable() {
      if (!deps.has_webgpu) {
        deps.on_fallback(`WebGPU unavailable — staying on CPU path; very large systems will be capped.`)
        return false
      }
      enabled = true
      return true
    },
    disable() { enabled = false },
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/large-system-mode.test.ts`
Expected: PASS (1 test). Add a `create_large_system_mode` test: with `has_webgpu:false`, `enable()` returns false and calls `on_fallback`; with `true`, `enable()` sets `enabled` true.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/large-system-mode.svelte.ts src/lib/structure/gpu/large-system-mode.test.ts
git commit -m "feat(gpu): large-system mode toggle + readback→connectivity bridge"
```

---

## Task 9: Renderer + StructureScene integration (manual-verified)

**Files:**
- Create: `src/lib/structure/gpu/large-system-renderer.ts`
- Modify: `src/lib/structure/StructureScene.svelte` (canvas swap + toggle wiring; around the renderer/canvas creation block — locate via `WebGLRenderer`/canvas init).
- Modify: a UI control surface to expose the toggle (follow the existing bonding-controls pattern; the implementer locates the panel that hosts bond options, since the custom-bond-distance sliders already live there per the spec).

This task is integration + GPU rendering, which CI cannot test. It is verified manually (Step 4) plus the device-gated single-pixel readback below.

- [ ] **Step 1: Implement `large-system-renderer.ts`**

Render pipeline drawing (a) impostor spheres as instanced quads raymarched to spheres, reading the GPU position buffer + per-atom radius, and (b) instanced bonds reading the GPU bond buffer (Task 6's `pairs_buf`, kept resident). Selection highlight = a per-atom u32 "selected" storage buffer sampled in the sphere shader. Picking = render atom-id to an R32Uint attachment; `pick(x,y)` copies that texel to a readback buffer. Camera uniform from Task 7.

Provide:
```ts
export function create_large_system_renderer(device: GPUDevice, canvas: HTMLCanvasElement): {
  set_frame(positions: GPUBuffer, radii: GPUBuffer, n: number): void
  set_bonds(pairs: GPUBuffer, count: number): void
  set_camera(uniform: Float32Array): void
  set_selection(selected: GPUBuffer): void
  render(): void
  pick(x: number, y: number): Promise<number> // atom index or -1
  destroy(): void
}
```

> Keep the bond buffer GPU-resident: `set_bonds` receives the same `pairs_buf`/`count` the compute pass wrote, with no readback. `render` runs the compute dispatch (Task 6 `dispatch`, no readback variant) then the two render passes, every frame.

- [ ] **Step 2: Device-gated render smoke test**

`src/lib/structure/gpu/large-system-renderer.test.ts`: `describe.skipIf(!navigator.gpu)` — create an offscreen canvas, render two atoms, read back a center pixel from the color attachment, assert it is non-background. This catches pipeline/bind-group breakage without asserting exact shading.

- [ ] **Step 3: Wire into StructureScene**

- Add the toggle (from Task 8) to the bond-options UI.
- When `enabled` flips true: hide the Three/WebGL `<canvas>`, mount the WebGPU canvas, start the frame loop (on trajectory frame change or camera move → `set_frame` + `set_camera` + `render`).
- When `enabled` flips false: stop the loop, destroy the WebGPU renderer, show the WebGL canvas.
- On pause / selection / export: call `bond-compute.run(...)` once for the current frame and `bond_state.bond_connectivity = result_to_connectivity(result)` (Task 8) so CPU consumers (export, mof-analysis, measurement) see current bonds.
- Disable label/polyhedra/gizmo/measurement UI affordances while `enabled` (per spec); keep selection + picking.

- [ ] **Step 4: Manual verification (REQUIRED)**

Per `superpowers:verification-before-completion`. Use the catgo worktree dev setup (see project memory). Steps:
1. Load a large trajectory (or synthesize one ≥ the regime).
2. Toggle large-system mode on → confirm atoms + bonds render, playback/scrub is smooth, rotation works.
3. Confirm PBC boundary bonds appear (minimum image), no ghost atoms.
4. Pause, select an atom → confirm pick works and selection highlights.
5. Adjust the bond-distance slider → confirm bonds update live.
6. Toggle off → confirm clean return to the WebGL path, no leaks (check DevTools).
7. On a no-WebGPU runtime (or force `has_webgpu:false`) → confirm fallback message + CPU path + cap.

Record observations in the PR description.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/large-system-renderer.ts src/lib/structure/gpu/large-system-renderer.test.ts src/lib/structure/StructureScene.svelte
git commit -m "feat(gpu): large-system WebGPU renderer + StructureScene integration"
```

---

## Task 10: Custom bond distance — live uniform update

**Files:**
- Modify: `src/lib/structure/gpu/large-system-mode.svelte.ts` (thread bond options into compute params)
- Test: `src/lib/structure/gpu/large-system-mode.test.ts` (extend)

The existing bond-options sliders (tolerance / max_bond_dist) must drive the GPU `Params` uniform; changing a slider re-dispatches compute for the current frame.

- [ ] **Step 1: Write failing test**

```ts
it('maps bond options to compute params (custom bond distance)', () => {
  const { to_compute_options } = require('./large-system-mode')
  expect(to_compute_options({ max_bond_dist: 2.6, tolerance: 0.3 }))
    .toEqual({ max_bond_dist: 2.6, tolerance: 0.3, min_dist: 0.1 })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/large-system-mode.test.ts`
Expected: FAIL — `to_compute_options` not exported.

- [ ] **Step 3: Implement**

```ts
// add to large-system-mode.svelte.ts
const DEFAULT_MIN_DIST = 0.1
export function to_compute_options(opts: Record<string, number>): { tolerance: number; max_bond_dist: number; min_dist: number } {
  return {
    tolerance: opts.tolerance ?? 0.45,
    max_bond_dist: opts.max_bond_dist ?? 3.0,
    min_dist: opts.min_dist ?? DEFAULT_MIN_DIST,
  }
}
```

- [ ] **Step 4: Run, verify pass + wire**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu/large-system-mode.test.ts`
Expected: PASS. Then in StructureScene (Task 9 loop): on bond-option change while `enabled`, call `render()` (which re-dispatches with the new `Params`). Verify manually that dragging the slider re-bonds live.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/gpu/large-system-mode.svelte.ts src/lib/structure/gpu/large-system-mode.test.ts
git commit -m "feat(gpu): live custom bond distance drives GPU compute params"
```

---

## Task 11: Full suite + finish

- [ ] **Step 1: Run the whole gpu suite + lint/typecheck**

Run: `rtk proxy pnpm exec vitest run tests/vitest/structure/gpu`
Expected: all pure-JS tests PASS; GPU device-gated tests PASS locally / SKIP in CI.
Run: `rtk proxy pnpm exec svelte-check` (or the repo's typecheck script) — no new errors.

- [ ] **Step 2: Self-review against spec §3 decisions** — confirm every locked decision (1–9) has a corresponding task. Note in the PR any deferred item (electroneg/solid_angle GPU strategies, auto-threshold, full three/webgpu migration are explicitly out of scope per spec §8).

- [ ] **Step 3: Open PR** using `superpowers:finishing-a-development-branch`. Include the manual verification observations from Task 9 Step 4.

---

## Self-Review (plan author)

**Spec coverage:** §3 decisions → 1 (A path, Task 9 integration), 2 (per-frame compute, Task 6/9), 3 (GPU-resident + readback-on-pause, Task 8/9), 4 (reduced render + keep selection/pick, Task 9), 5 (min-image PBC, Tasks 4/5/6), 6 (atom_radii only, Tasks 4/5), 7 (manual toggle, Task 8), 8 (CPU fallback + warning, Task 8/9), 9 (custom bond distance, Task 10). ✓
**Placeholder scan:** Tasks 9 render/integration are intentionally manual (GPU/UI not CI-testable) — code interfaces are concrete; the WGSL render shader bodies are the one place left to the implementer because they depend on the chosen impostor technique. Flagged explicitly, not hidden. All pure-JS tasks have full code + tests.
**Type consistency:** `BondComputeResult`/`BondComputeRun` (Task 6) used consistently in Tasks 8/10; `result_to_connectivity` output matches `bond_connectivity` entry type; jimage pack/unpack convention shared across Tasks 4/5/6.
