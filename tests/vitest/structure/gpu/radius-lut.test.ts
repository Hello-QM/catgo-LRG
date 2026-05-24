import { describe, it, expect } from 'vitest'
import { build_atom_radii } from '$lib/structure/gpu/radius-lut'
import type { Site } from '$lib/structure'

function site(element: string, xyz: [number, number, number]): Site {
  return { species: [{ element, occu: 1, oxidation_state: 0 } as never], abc: [0, 0, 0], xyz } as Site
}

describe(`build_atom_radii`, () => {
  it(`returns one finite radius per site, using the primary species`, () => {
    const sites = [site(`H`, [0, 0, 0]), site(`O`, [1, 0, 0]), site(`C`, [2, 0, 0])]
    const radii = build_atom_radii(sites)
    expect(radii).toBeInstanceOf(Float32Array)
    expect(radii.length).toBe(3)
    for (const r of radii) expect(r).toBeGreaterThan(0)
    expect(radii[1]).toBeLessThan(radii[2]) // O covalent radius (0.66) < C (0.76)
  })
  it(`falls back to a default radius for unknown elements`, () => {
    const radii = build_atom_radii([site(`Xx`, [0, 0, 0])])
    expect(radii[0]).toBeGreaterThan(0)
  })
})
