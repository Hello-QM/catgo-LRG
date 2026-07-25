import { describe, it, expect } from 'vitest'
import { build_atom_radii, build_display_radii } from '$lib/structure/gpu/radius-lut'
import { atomic_radii, type Site } from '$lib/structure'

function site(element: string, xyz: [number, number, number]): Site {
  return { species: [{ element, occu: 1, oxidation_state: 0 } as never], abc: [0, 0, 0], xyz } as Site
}

// The scale the WebGL instance writer applies on top of the resolved radius —
// VISUAL_RADIUS_SCALE in src/lib/structure/atoms/atom-instanced-renderer.ts.
// build_display_radii MUST fold in the same factor or the overlay draws every
// sphere at 2× the WebGL size (the original large-system-mode bug).
const VISUAL_RADIUS_SCALE = 0.5

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
  // The WebGL ball-and-stick view sizes a sphere as
  //   atomic_radii[el] * atom_radius * VISUAL_RADIUS_SCALE
  // (StructureScene resolves atomic_radii[el] * atom_radius into atom_data.radius,
  // then the instance writer halves it). The overlay must land on the same value.
  const sites = [site(`O`, [0, 0, 0]), site(`H`, [1, 0, 0]), site(`Ca`, [2, 0, 0])]

  it(`matches the WebGL per-element radius including VISUAL_RADIUS_SCALE`, () => {
    const atom_radius = 1.5 // the app default
    const radii = build_display_radii(sites, { atom_radius })
    for (let i = 0; i < sites.length; i++) {
      const el = sites[i].species[0].element
      const expected = (atomic_radii[el] ?? 1) * atom_radius * VISUAL_RADIUS_SCALE
      expect(radii[i]).toBeCloseTo(expected, 5)
    }
  })

  it(`is exactly half the pre-scale radius — regression guard for the 2× bug`, () => {
    // Without VISUAL_RADIUS_SCALE the overlay drew spheres at double size. Pin the
    // ratio directly so a dropped factor fails loudly rather than looking "a bit big".
    const scaled = build_display_radii(sites, { atom_radius: 1 })
    for (let i = 0; i < sites.length; i++) {
      const el = sites[i].species[0].element
      expect(scaled[i]).toBeCloseTo((atomic_radii[el] ?? 1) * VISUAL_RADIUS_SCALE, 5)
    }
  })

  it(`applies the scale to the same_size_atoms branch`, () => {
    const radii = build_display_radii(sites, { atom_radius: 2, same_size_atoms: true })
    // Every atom collapses to atom_radius * scale, regardless of element.
    for (const r of radii) expect(r).toBeCloseTo(2 * VISUAL_RADIUS_SCALE, 5)
  })

  it(`applies the scale to a per-site override`, () => {
    const overrides = new Map<number, number>([[0, 0.8]])
    const radii = build_display_radii(sites, { atom_radius: 1.5, site_radius_overrides: overrides })
    expect(radii[0]).toBeCloseTo(0.8 * 1.5 * VISUAL_RADIUS_SCALE, 5)
    // Non-overridden sites keep the element-resolved size (still scaled).
    expect(radii[1]).toBeCloseTo((atomic_radii[`H`] ?? 1) * 1.5 * VISUAL_RADIUS_SCALE, 5)
  })

  it(`applies a per-element override, scaled`, () => {
    const radii = build_display_radii(sites, {
      atom_radius: 1,
      element_radius_overrides: { O: 1.2 },
    })
    expect(radii[0]).toBeCloseTo(1.2 * VISUAL_RADIUS_SCALE, 5)
  })
})
