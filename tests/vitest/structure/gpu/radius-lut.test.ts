import { describe, it, expect } from 'vitest'
import { build_atom_radii, build_display_radii } from '$lib/structure/gpu/radius-lut'
import type { Site } from '$lib/structure'
import { atomic_radii } from '$lib/structure'

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

describe(`build_display_radii`, () => {
  it(`matches the final WebGL impostor radius scale by default`, () => {
    const radii = build_display_radii([
      site(`H`, [0, 0, 0]),
      site(`O`, [1, 0, 0]),
    ], { atom_radius: 2 })
    expect(radii).toBeInstanceOf(Float32Array)
    expect(radii[0]).toBeCloseTo((atomic_radii.H ?? 1) * 2 * 0.5)
    expect(radii[1]).toBeCloseTo((atomic_radii.O ?? 1) * 2 * 0.5)
  })

  it(`uses the global atom radius for same-size mode`, () => {
    const radii = build_display_radii([
      site(`H`, [0, 0, 0]),
      site(`O`, [1, 0, 0]),
      site(`C`, [2, 0, 0]),
    ], { atom_radius: 1.25, same_size_atoms: true })
    expect([...radii]).toEqual([0.625, 0.625, 0.625])
  })

  it(`applies element overrides and lets site overrides take precedence`, () => {
    const radii = build_display_radii([
      site(`H`, [0, 0, 0]),
      site(`O`, [1, 0, 0]),
      site(`C`, [2, 0, 0]),
    ], {
      atom_radius: 2,
      element_radius_overrides: { H: 3, O: 4 },
      site_radius_overrides: new Map([[1, 5]]),
    })
    expect(radii[0]).toBeCloseTo(3)
    expect(radii[1]).toBeCloseTo(5)
    expect(radii[2]).toBeCloseTo((atomic_radii.C ?? 1) * 2 * 0.5)
  })
})
