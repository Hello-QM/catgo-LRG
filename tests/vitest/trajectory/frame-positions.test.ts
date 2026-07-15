import { describe, expect, test } from 'vitest'
import { create_frame_position_cache } from '$lib/trajectory/frame-positions'

const site = (x: number, y: number, z: number, force?: number[]) => ({
  xyz: [x, y, z],
  properties: force ? { force } : {},
})

describe(`create_frame_position_cache`, () => {
  test(`builds a flat positions array from sites`, () => {
    const cache = create_frame_position_cache()
    const { positions, forces } = cache.get(0, [site(1, 2, 3), site(4, 5, 6)])
    expect(Array.from(positions)).toEqual([1, 2, 3, 4, 5, 6])
    expect(forces).toBeNull()
  })

  test(`extracts forces when present on any site`, () => {
    const cache = create_frame_position_cache()
    const { forces } = cache.get(0, [site(0, 0, 0, [0.1, 0.2, 0.3]), site(1, 1, 1)])
    expect(forces).not.toBeNull()
    expect(Array.from(forces!.slice(0, 3)).map((v) => Number(v.toFixed(6))))
      .toEqual([0.1, 0.2, 0.3])
    expect(Array.from(forces!.slice(3))).toEqual([0, 0, 0])
  })

  test(`returns the SAME Float32Array reference on revisit (bond-cache key stability)`, () => {
    const cache = create_frame_position_cache()
    const sites = [site(1, 2, 3)]
    const first = cache.get(7, sites)
    const again = cache.get(7, sites)
    expect(again.positions).toBe(first.positions)
  })

  test(`rebuilds when the site count changed for the same frame index`, () => {
    const cache = create_frame_position_cache()
    const first = cache.get(0, [site(1, 2, 3)])
    const grown = cache.get(0, [site(1, 2, 3), site(4, 5, 6)])
    expect(grown.positions).not.toBe(first.positions)
    expect(grown.positions.length).toBe(6)
  })

  test(`evicts least-recently-used entries beyond max`, () => {
    const cache = create_frame_position_cache(2)
    const s = [site(1, 1, 1)]
    const e0 = cache.get(0, s)
    cache.get(1, s)
    cache.get(0, s) // touch 0 → 1 is now LRU
    cache.get(2, s) // evicts 1
    expect(cache.size()).toBe(2)
    expect(cache.get(0, s).positions).toBe(e0.positions) // 0 survived
    const e1_rebuilt = cache.get(1, s) // 1 was evicted → new array
    expect(e1_rebuilt.positions.length).toBe(3)
    expect(cache.size()).toBe(2)
  })

  test(`clear() drops all entries`, () => {
    const cache = create_frame_position_cache()
    const first = cache.get(0, [site(1, 2, 3)])
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.get(0, [site(1, 2, 3)]).positions).not.toBe(first.positions)
  })
})
