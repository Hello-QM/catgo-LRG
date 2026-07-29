import { beforeAll, describe, expect, it } from 'vitest'
import { create_bond_compute } from '$lib/structure/gpu/bond-compute'
import { detect_bonds_reference } from '$lib/structure/gpu/bond-detect-reference'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'

let device: GPUDevice | null = null
beforeAll(async () => {
  device = await acquire_webgpu_device()
})
const pair_set = (bonds: { a: number; b: number }[]) =>
  new Set(bonds.map((b) => `${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`))

describe.skipIf(!globalThis.navigator?.gpu)(`bond-compute (GPU)`, () => {
  it(`matches the JS reference on a small periodic cell (direct small-N path)`, async () => {
    if (!device) return
    // 5 Å cell with max_bond_dist 3 ⇒ a periodic THIN cell (grid dim < 3). At
    // 3 atoms the dispatch policy routes this to the small-N DIRECT all-pairs
    // shader (exact 27-image search) — the grid shader has no fallback.
    const positions = new Float32Array([0.2, 0, 0, 4.9, 0, 0, 0.2, 1.2, 0])
    const radii = new Float32Array([0.76, 0.76, 0.76])
    const lattice = new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5])
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 }
    const ref = detect_bonds_reference(positions, lattice, radii, opts)
    const compute = create_bond_compute(device, { capacity: 1024 })
    const gpu = await compute.run({ positions, radii, lattice, periodic: true, ...opts })
    expect(gpu.status).toBe(`complete`)
    if (gpu.status !== `complete`) return
    expect(gpu.count).toBe(ref.length)
    expect(pair_set(gpu.pairs)).toEqual(pair_set(ref))
    expect(gpu.overflowed).toBe(false)
  })

  it(`refuses a periodic thin cell above the direct limit (requires-rust-wasm)`, async () => {
    if (!device) return
    // Same thin 5 Å cell, but with direct_limit 0 the system is "large": the
    // grid is unusable (dim < 3) and the GPU path must REFUSE with a typed
    // outcome instead of running an all-pairs fallback (design §8.2).
    const positions = new Float32Array([0.2, 0, 0, 4.9, 0, 0, 0.2, 1.2, 0])
    const radii = new Float32Array([0.76, 0.76, 0.76])
    const lattice = new Float32Array([5, 0, 0, 0, 5, 0, 0, 0, 5])
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 }
    const compute = create_bond_compute(device, { capacity: 1024, direct_limit: 0 })
    const gpu = await compute.run({ positions, radii, lattice, periodic: true, ...opts })
    expect(gpu).toEqual({
      status: `requires-rust-wasm`,
      reason: `periodic-thin-cell`,
    })
  })

  it(`matches the JS reference on a MEDIUM periodic cell (uniform-grid path)`, async () => {
    if (!device) return
    // An 11.2 Å cubic cell with max_bond_dist 3 ⇒ floor(11.2/3)=3 grid dims (≥3)
    // ⇒ the grid is usable; direct_limit 0 forces the grid path so the cell-list
    // candidate search is what's exercised. Fill it with a 4×4×4 simple-cubic
    // lattice of carbons at 2.8 Å spacing so nearest neighbors (2.8 Å) sit
    // comfortably inside the 3 Å cutoff (no float-boundary ties) and bond
    // across grid cells + PBC faces.
    const lat = 11.2
    const lattice = new Float32Array([lat, 0, 0, 0, lat, 0, 0, 0, lat])
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 }
    const coords: number[] = []
    const radii_arr: number[] = []
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          coords.push(i * 2.8 + 0.05, j * 2.8 + 0.05, k * 2.8 + 0.05)
          radii_arr.push(0.76)
        }
      }
    }
    const positions = new Float32Array(coords)
    const radii = new Float32Array(radii_arr)
    const ref = detect_bonds_reference(positions, lattice, radii, opts)
    const compute = create_bond_compute(device, { capacity: 65536, direct_limit: 0 })
    const gpu = await compute.run({ positions, radii, lattice, periodic: true, ...opts })
    expect(gpu.status).toBe(`complete`)
    if (gpu.status !== `complete`) return
    expect(gpu.overflowed).toBe(false)
    expect(gpu.count).toBe(ref.length)
    expect(pair_set(gpu.pairs)).toEqual(pair_set(ref))
  })

  it(`matches the JS reference on a NON-PERIODIC cluster (AABB grid path)`, async () => {
    if (!device) return
    // Non-periodic always grids (over the atom AABB); direct_limit 0 forces the
    // grid path for this small cluster. A 3×3×3 cubic blob of atoms at 2.4 Å
    // spacing, jittered, so neighbors bond across AABB cells.
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 }
    const coords: number[] = []
    const radii_arr: number[] = []
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          coords.push(i * 2.4 + 0.1, j * 2.4 - 0.05, k * 2.4 + 0.07)
          radii_arr.push(0.76)
        }
      }
    }
    const positions = new Float32Array(coords)
    const radii = new Float32Array(radii_arr)
    const zero = new Float32Array(9) // non-periodic ⇒ all-zero lattice in the ref
    const ref = detect_bonds_reference(positions, zero, radii, opts)
    const compute = create_bond_compute(device, { capacity: 65536, direct_limit: 0 })
    const gpu = await compute.run({
      positions,
      radii,
      lattice: zero,
      periodic: false,
      ...opts,
    })
    expect(gpu.status).toBe(`complete`)
    if (gpu.status !== `complete`) return
    expect(gpu.overflowed).toBe(false)
    expect(gpu.count).toBe(ref.length)
    expect(pair_set(gpu.pairs)).toEqual(pair_set(ref))
  })

  it(`grows an undersized pair capacity and still returns the complete graph`, async () => {
    if (!device) return
    // Start with capacity 4 — far below the 64-atom cubic lattice's bond count.
    // The run must detect the pair overflow, grow to nextPow2(raw), rerun, and
    // return the COMPLETE graph (never a clamped one).
    const lat = 11.2
    const lattice = new Float32Array([lat, 0, 0, 0, lat, 0, 0, 0, lat])
    const opts = { tolerance: 0.45, max_bond_dist: 3.0, min_bond_dist: 0.1 }
    const coords: number[] = []
    const radii_arr: number[] = []
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (let k = 0; k < 4; k++) {
          coords.push(i * 2.8 + 0.05, j * 2.8 + 0.05, k * 2.8 + 0.05)
          radii_arr.push(0.76)
        }
      }
    }
    const positions = new Float32Array(coords)
    const radii = new Float32Array(radii_arr)
    const ref = detect_bonds_reference(positions, lattice, radii, opts)
    const compute = create_bond_compute(device, { capacity: 4, direct_limit: 0 })
    const gpu = await compute.run({ positions, radii, lattice, periodic: true, ...opts })
    expect(gpu.status).toBe(`complete`)
    if (gpu.status !== `complete`) return
    expect(gpu.count).toBe(ref.length)
    expect(pair_set(gpu.pairs)).toEqual(pair_set(ref))
    expect(gpu.diagnostics.overflow.retries).toBeGreaterThan(0)
  })
})
