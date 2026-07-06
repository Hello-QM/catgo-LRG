// Regression: dragging an 11k-atom LAMMPS .data file froze the UI for
// minutes — get_pbc_image_sites read every coordinate through the Svelte
// $state proxy inside its hot loops (profiled: 104s self + 84s proxy gets).
// The geometry is now extracted into typed arrays in one pass, so the image
// search must stay fast even when the structure is proxy-wrapped.
import { describe, expect, test } from 'vitest'
import { get_pbc_image_sites } from '../../../src/lib/structure/pbc'
import type { ParsedStructure } from '../../../src/lib/structure/parsers/common'

/** Wrap every object/array in a get-counting proxy — a stand-in for the
 *  overhead pattern of Svelte's reactive proxies. */
function deep_proxy<T extends object>(obj: T, counter: { gets: number }): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      counter.gets++
      const v = Reflect.get(target, prop, receiver)
      return typeof v === `object` && v !== null ? deep_proxy(v as object, counter) : v
    },
  }) as T
}

function make_structure(n_side: number): ParsedStructure {
  // Simple cubic carbon lattice, 1.6 Å spacing → bonded chain, some boundary atoms
  const a = n_side * 1.6
  const sites = []
  for (let i = 0; i < n_side; i++) {
    for (let j = 0; j < n_side; j++) {
      for (let k = 0; k < n_side; k++) {
        const abc: [number, number, number] = [i / n_side, j / n_side, k / n_side]
        sites.push({
          species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
          abc,
          xyz: [abc[0] * a, abc[1] * a, abc[2] * a] as [number, number, number],
          label: `C`,
          properties: {},
        })
      }
    }
  }
  return {
    sites,
    lattice: {
      matrix: [[a, 0, 0], [0, a, 0], [0, 0, a]],
      pbc: [true, true, true],
      a, b: a, c: a, alpha: 90, beta: 90, gamma: 90, volume: a * a * a,
    },
  } as unknown as ParsedStructure
}

describe(`get_pbc_image_sites performance`, () => {
  test(`10k-atom proxied structure completes fast with O(n) proxy reads`, () => {
    const counter = { gets: 0 }
    const s = deep_proxy(make_structure(22), counter) // 22³ = 10648 atoms
    const t0 = performance.now()
    const out = get_pbc_image_sites(s)
    const ms = performance.now() - t0
    expect(out.sites.length).toBeGreaterThan(10648) // boundary images added
    // One extraction pass reads ~20 props per site (~200k). The old code did
    // hundreds of millions. Generous ceiling that still catches an O(pairs)
    // proxy regression outright.
    expect(counter.gets).toBeLessThan(3_000_000)
    expect(ms).toBeLessThan(15_000)
  }, 60000)

  test(`image positions unchanged by the typed-array rewrite`, () => {
    const s = make_structure(3) // 27 atoms
    const out = get_pbc_image_sites(s)
    const n_orig = 27
    expect(out.num_original_sites).toBe(n_orig)
    // Every image must be an integer lattice translation of its parent
    for (let i = n_orig; i < out.sites.length; i++) {
      const img = out.sites[i]
      const parent = out.sites[out.image_to_original_map![i - n_orig]]
      for (let d = 0; d < 3; d++) {
        const delta = img.abc[d] - parent.abc[d]
        expect(Math.abs(delta - Math.round(delta))).toBeLessThan(1e-9)
      }
    }
  })
})
