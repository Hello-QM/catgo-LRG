import { describe, it, expect } from 'vitest'
import {
  build_atom_radii,
  build_display_radii,
  build_logical_radii,
} from '$lib/structure/gpu/radius-lut'
import { atomic_radii, type Site } from '$lib/structure'
import { VISUAL_RADIUS_SCALE } from '$lib/structure/rendering/visual-state'

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

  it(`weights mixed-species radii by occupancy before applying the display scale`, () => {
    const mixed = {
      ...site(`O`, [0, 0, 0]),
      species: [
        { element: `O`, occu: 0.25, oxidation_state: 0 },
        { element: `Ca`, occu: 0.75, oxidation_state: 0 },
      ],
    } as Site
    const element_radius_overrides = { Ca: 1.8 }
    const logical = build_logical_radii([mixed], {
      atom_radius: 1.5,
      element_radius_overrides,
    })
    const display = build_display_radii([mixed], {
      atom_radius: 1.5,
      element_radius_overrides,
    })
    const expected_logical = (
      0.25 * (atomic_radii.O ?? 1) +
      0.75 * element_radius_overrides.Ca
    ) * 1.5
    expect(logical[0]).toBeCloseTo(expected_logical, 5)
    expect(display[0]).toBeCloseTo(expected_logical * VISUAL_RADIUS_SCALE, 5)
  })

  it.each([
    [`element`, {}, undefined],
    [`same-size`, { same_size_atoms: true }, undefined],
    [`element override`, { element_radius_overrides: { O: 1.2 } }, undefined],
    [`site override`, {}, new Map([[0, 0.8]])],
  ] as const)(
    `keeps the %s display result at logical radius × VISUAL_RADIUS_SCALE`,
    (_label, opts, site_radius_overrides) => {
      const resolved = {
        atom_radius: 1.5,
        ...opts,
        site_radius_overrides,
      }
      const logical = build_logical_radii(sites, resolved)
      const display = build_display_radii(sites, resolved)
      for (let idx = 0; idx < sites.length; idx++) {
        expect(display[idx]).toBeCloseTo(
          logical[idx] * VISUAL_RADIUS_SCALE,
          5,
        )
      }
    },
  )
})
