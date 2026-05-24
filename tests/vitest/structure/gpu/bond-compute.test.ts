import { describe, it, expect, beforeAll } from 'vitest'
import { acquire_webgpu_device } from '$lib/structure/gpu/webgpu-context'
import { create_bond_compute } from '$lib/structure/gpu/bond-compute'
import { detect_bonds_reference } from '$lib/structure/gpu/bond-detect-reference'

let device: GPUDevice | null = null
beforeAll(async () => { device = await acquire_webgpu_device() })
const pair_set = (bonds: { a: number; b: number }[]) =>
  new Set(bonds.map((b) => `${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`))

describe.skipIf(!globalThis.navigator?.gpu)(`bond-compute (GPU)`, () => {
  it(`matches the JS reference on a small periodic cell`, async () => {
    if (!device) return
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
