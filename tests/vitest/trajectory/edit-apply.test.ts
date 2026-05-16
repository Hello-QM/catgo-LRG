import { describe, expect, it } from 'vitest'
import { apply_displacements, sites_to_float32, write_sites_to_cache_slice } from '$lib/trajectory/edit-apply'

type Site = { xyz: [number, number, number]; abc: [number, number, number]; species: unknown }

function site(x: number, y: number, z: number): Site {
  return { xyz: [x, y, z], abc: [x, y, z], species: [{ element: 'O', occu: 1 }] }
}

describe('apply_displacements', () => {
  it('returns a new sites array with xyz + abc displaced for matched indices (no lattice = abc==xyz delta)', () => {
    const sites = [site(0, 0, 0), site(1, 1, 1)]
    const out = apply_displacements(sites, new Map([[1, [0.5, 0, -0.5]]]), null)
    expect(out).not.toBe(sites) // new array
    expect(out[0]).toBe(sites[0]) // untouched site kept by reference
    expect(out[1].xyz).toEqual([1.5, 1, 0.5])
    expect(out[1].abc).toEqual([1.5, 1, 0.5]) // no inv lattice → fractional delta == cartesian delta
    expect(sites[1].xyz).toEqual([1, 1, 1]) // input not mutated
  })

  it('uses the inverse-lattice matrix to convert the cartesian delta to a fractional abc delta', () => {
    // 2x identity lattice → inv = 0.5*I → frac delta = 0.5 * cartesian delta
    const inv: [number, number, number, number, number, number, number, number, number] =
      [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]
    const sites = [site(0, 0, 0)]
    const out = apply_displacements(sites, new Map([[0, [2, 4, 6]]]), inv)
    expect(out[0].xyz).toEqual([2, 4, 6])
    expect(out[0].abc).toEqual([1, 2, 3])
  })

  it('applies off-diagonal inv_lattice terms in row-major order (mat3_vec3 contract)', () => {
    // inv row-major = [1,2,0, 0,1,0, 0,0,1], Δ = [1,1,0]
    // abc delta = [1*1+2*1+0, 0+1+0, 0] = [3,1,0]; xyz delta = [1,1,0]
    const inv: [number, number, number, number, number, number, number, number, number] =
      [1, 2, 0, 0, 1, 0, 0, 0, 1]
    const sites = [site(0, 0, 0)]
    const out = apply_displacements(sites, new Map([[0, [1, 1, 0]]]), inv)
    expect(out[0].xyz).toEqual([1, 1, 0])
    expect(out[0].abc).toEqual([3, 1, 0])
  })

  it('delta-adds onto the existing abc rather than recomputing from xyz', () => {
    // site whose abc != xyz: xyz=[5,0,0], abc=[0.5,0,0]; Δ=[1,0,0], null inv
    // → xyz=[6,0,0], abc=[1.5,0,0] (proves abc + Δ, not inv·new_xyz recompute)
    const s: Site = { xyz: [5, 0, 0], abc: [0.5, 0, 0], species: [{ element: 'O', occu: 1 }] }
    const out = apply_displacements([s], new Map([[0, [1, 0, 0]]]), null)
    expect(out[0].xyz).toEqual([6, 0, 0])
    expect(out[0].abc).toEqual([1.5, 0, 0])
  })

  it('is a no-op (same array contents, new array) when displacements is empty', () => {
    const sites = [site(0, 0, 0)]
    const out = apply_displacements(sites, new Map(), null)
    expect(out[0]).toBe(sites[0])
  })
})

describe('write_sites_to_cache_slice', () => {
  it('mirrors sites xyz into the Float32Array slice in place, up to min(len)', () => {
    const sites = [site(1, 2, 3), site(4, 5, 6)]
    const arr = new Float32Array(6)
    write_sites_to_cache_slice(arr, sites)
    expect(Array.from(arr)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('does not overflow when the array is shorter than sites*3 (supercell-extra atoms)', () => {
    const sites = [site(1, 2, 3), site(4, 5, 6)]
    const arr = new Float32Array(3)
    write_sites_to_cache_slice(arr, sites)
    expect(Array.from(arr)).toEqual([1, 2, 3])
  })
})

describe('sites_to_float32', () => {
  it('builds a fresh xyz-flat (3·n) Float32Array from sites', () => {
    const out = sites_to_float32([site(1, 2, 3), site(4, 5, 6)])
    expect(out).toBeInstanceOf(Float32Array)
    expect(out.length).toBe(6)
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('returns an empty Float32Array for no sites', () => {
    const out = sites_to_float32([])
    expect(out.length).toBe(0)
  })

  it('reads xyz only (ignores abc) so the bond fallback matches the cache slice layout', () => {
    const s = { xyz: [7, 8, 9] as [number, number, number], abc: [0.1, 0.2, 0.3] as [number, number, number] }
    expect(Array.from(sites_to_float32([s]))).toEqual([7, 8, 9])
  })
})
