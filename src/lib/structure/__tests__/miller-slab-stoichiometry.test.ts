import { describe, it, expect } from 'vitest'
import { generate_slab_pipeline } from '../miller-slab'
import type { Matrix3x3 } from '$lib/math'

// Rocksalt NiO conventional cubic cell, a = 4.13792322 Å (4 Ni + 4 O).
const A = 4.13792322
const lattice = [
  [A, 0, 0],
  [0, A, 0],
  [0, 0, A],
] as Matrix3x3

const frac: { el: string; f: [number, number, number] }[] = [
  { el: 'Ni', f: [0, 0, 0] },
  { el: 'Ni', f: [0.5, 0.5, 0] },
  { el: 'Ni', f: [0.5, 0, 0.5] },
  { el: 'Ni', f: [0, 0.5, 0.5] },
  { el: 'O', f: [0, 0, 0.5] },
  { el: 'O', f: [0.5, 0, 0] },
  { el: 'O', f: [0, 0.5, 0] },
  { el: 'O', f: [0.5, 0.5, 0.5] },
]

const structure: any = {
  lattice: { matrix: lattice, a: A, b: A, c: A, alpha: 90, beta: 90, gamma: 90, volume: A ** 3, pbc: [true, true, true] },
  sites: frac.map((s, i) => ({
    species: [{ element: s.el, occu: 1 }],
    abc: s.f,
    xyz: [s.f[0] * A, s.f[1] * A, s.f[2] * A],
    label: `${s.el}${i}`,
    properties: {},
  })),
}

function composition(sites: any[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const s of sites) {
    const el = s.species[0].element
    c[el] = (c[el] ?? 0) + 1
  }
  return c
}

function min_pair_distance(sites: any[]): number {
  let m = Infinity
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d = Math.hypot(
        sites[i].xyz[0] - sites[j].xyz[0],
        sites[i].xyz[1] - sites[j].xyz[1],
        sites[i].xyz[2] - sites[j].xyz[2],
      )
      if (d < m) m = d
    }
  }
  return m
}

// Regression: the species-blind primitive reduction used to accept the c/2
// cation→anion glide in rocksalt (110) and then delete one whole species,
// producing an all-Ni / zero-O slab. (110) is a neutral, stoichiometric
// surface — every slab must keep Ni:O = 1:1 with no overlapping atoms.
describe('NiO (110) slab is stoichiometric', () => {
  const D = 2.926 // d-spacing(110) ≈ a/√2
  const mid = D / 2

  for (const growth of ['centered', 'anchor_minus_z'] as const) {
    for (const mult of [1, 2, 3]) {
      it(`growth=${growth} thickness=${mult}d keeps Ni:O = 1:1`, () => {
        const res = generate_slab_pipeline(structure, {
          miller_index: [1, 1, 0],
          offset: growth === 'centered' ? mid : D,
          thickness: mult * D,
          vacuum: 15,
          growth_mode: growth,
          supercell: [1, 1],
        })
        expect(res).not.toBeNull()
        const comp = composition(res!.sites)
        expect(comp.Ni).toBeGreaterThan(0)
        expect(comp.O).toBeGreaterThan(0)
        expect(comp.Ni).toBe(comp.O)
        expect(min_pair_distance(res!.sites)).toBeGreaterThan(0.5)
      })
    }
  }
})
