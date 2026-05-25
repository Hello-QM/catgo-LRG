import { describe, it, expect } from 'vitest'
import { pack_params, unpack_jimage, PARAMS_BYTES, type BondComputeRun } from '$lib/structure/gpu/bond-compute'

const make_run = (over: Partial<BondComputeRun> = {}): BondComputeRun => ({
  tolerance: 0.45,
  max_bond_dist: 3,
  min_dist: 0.1,
  positions: new Float32Array([0, 0, 0]),
  radii: new Float32Array([0.76]),
  lattice: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  periodic: true,
  ...over,
})

describe(`pack_params`, () => {
  it(`PARAMS_BYTES is 128 and the buffer is 128 bytes`, () => {
    // 80 bytes (header + transposed lattice) + 48 bytes uniform-grid block.
    expect(PARAMS_BYTES).toBe(128)
    const buf = pack_params(3, 1024, make_run())
    expect(buf.byteLength).toBe(128)
  })

  it(`u32 header lands at word offsets 0..3`, () => {
    const buf = pack_params(7, 1024, make_run({ periodic: true }))
    const u32 = new Uint32Array(buf)
    expect(u32[0]).toBe(7) // n
    expect(u32[1]).toBe(1024) // capacity
    expect(u32[2]).toBe(1) // periodic
    expect(u32[3]).toBe(0) // _pad0
  })

  it(`periodic=false packs 0`, () => {
    const u32 = new Uint32Array(pack_params(1, 8, make_run({ periodic: false })))
    expect(u32[2]).toBe(0)
  })

  it(`f32 scalars land at word offsets 4..7`, () => {
    const buf = pack_params(1, 8, make_run({ tolerance: 0.45, max_bond_dist: 3, min_dist: 0.1 }))
    const f32 = new Float32Array(buf)
    expect(f32[4]).toBeCloseTo(0.45, 6) // tolerance
    expect(f32[5]).toBeCloseTo(3, 6) // max_bond_dist
    expect(f32[6]).toBeCloseTo(0.1, 6) // min_dist
    expect(f32[7]).toBe(0) // _pad1
  })

  it(`TRANSPOSES the lattice: WGSL column k = row-major row k, pads are 0`, () => {
    // rows a=(1,2,3), b=(4,5,6), c=(7,8,9)
    const lattice = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const f32 = new Float32Array(pack_params(1, 8, make_run({ lattice })))
    // column 0 = row a at f32 8..10
    expect([f32[8], f32[9], f32[10]]).toEqual([1, 2, 3])
    // column 1 = row b at f32 12..14
    expect([f32[12], f32[13], f32[14]]).toEqual([4, 5, 6])
    // column 2 = row c at f32 16..18
    expect([f32[16], f32[17], f32[18]]).toEqual([7, 8, 9])
    // mat3x3 column pads (f32 11, 15, 19) are 0
    expect([f32[11], f32[15], f32[19]]).toEqual([0, 0, 0])
  })

  it(`reads back transposed lattice via DataView little-endian`, () => {
    const lattice = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const dv = new DataView(pack_params(1, 8, make_run({ lattice })))
    expect(dv.getFloat32(32, true)).toBe(1) // column0.x at byte 32
    expect(dv.getFloat32(48, true)).toBe(4) // column1.x at byte 48
    expect(dv.getFloat32(64, true)).toBe(7) // column2.x at byte 64
  })

  it(`grid block (words 20..28) defaults to use_grid 0 when no plan passed`, () => {
    const u32 = new Uint32Array(pack_params(1, 8, make_run()))
    expect(u32[23]).toBe(0) // use_grid = 0 ⇒ shader takes the O(N²) fallback
  })

  it(`packs the uniform-grid plan into words 20..28`, () => {
    const buf = pack_params(1, 8, make_run({ periodic: false }), {
      use_grid: true,
      dims: [4, 5, 6],
      n_cells: 120,
      aabb_min: [-1, 2, -3],
      inv_h: 0.5,
      max_per_cell: 64,
    })
    const u32 = new Uint32Array(buf)
    const f32 = new Float32Array(buf)
    expect([u32[20], u32[21], u32[22]]).toEqual([4, 5, 6]) // grid_dims
    expect(u32[23]).toBe(1) // use_grid
    expect([f32[24], f32[25], f32[26]]).toEqual([-1, 2, -3]) // aabb_min
    expect(u32[27]).toBe(64) // max_per_cell
    expect(f32[28]).toBeCloseTo(0.5, 6) // inv_h
  })
})

describe(`unpack_jimage`, () => {
  it(`round-trips every (na,nb,nc) in {-1,0,1}^3`, () => {
    for (let na = -1; na <= 1; na++) {
      for (let nb = -1; nb <= 1; nb++) {
        for (let nc = -1; nc <= 1; nc++) {
          const packed = (na + 1) | ((nb + 1) << 2) | ((nc + 1) << 4)
          expect(unpack_jimage(packed)).toEqual([na, nb, nc])
        }
      }
    }
  })

  it(`[0,0,0] packs to 0b010101 = 21`, () => {
    expect(unpack_jimage(21)).toEqual([0, 0, 0])
  })
})
