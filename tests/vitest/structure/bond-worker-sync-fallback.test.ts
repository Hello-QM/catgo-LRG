import type { ElementSymbol, Vec3 } from '$lib'
import type { PymatgenStructure, Site } from '$lib/structure'
import { parse_cif } from '$lib/structure/parsers/cif'
import { compute_bonds_sync } from '$lib/structure/workers/bond-worker-api'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/structure/ferrox-wasm', async (import_original) => {
  const actual = await import_original<typeof import('$lib/structure/ferrox-wasm')>()
  return {
    ...actual,
    get_ferrox_wasm_sync: () => null,
  }
})

function site(element: string, xyz: Vec3): Site {
  return {
    xyz,
    abc: [0, 0, 0],
    species: [{ element: element as ElementSymbol, occu: 1 }],
    label: element,
    properties: {},
  }
}

describe(`compute_bonds_sync JS fallback`, () => {
  beforeEach(() => vi.clearAllMocks())

  it(`computes a periodic image bond without WASM`, () => {
    const crystal = {
      sites: [site(`C`, [0.2, 0, 0]), site(`C`, [4.7, 0, 0])],
      lattice: {
        matrix: [[5, 0, 0], [0, 5, 0], [0, 0, 5]],
        pbc: [true, true, true],
      },
    } as PymatgenStructure

    const bonds = compute_bonds_sync(crystal, `atom_radii`, { scale: 1.15 })
    expect(bonds).toHaveLength(1)
    expect(bonds?.[0]).toMatchObject({
      site_idx_1: 0,
      site_idx_2: 1,
      jimage: [-1, 0, 0],
    })
    expect(bonds?.[0].bond_length).toBeCloseTo(0.5)
  })

  it(`matches the LiFePO4 WASM bond graph on a cold start`, () => {
    const crystal = parse_cif(
      readFileSync(resolve(`src/site/structures/LiFePO4.cif`), `utf8`),
    ) as PymatgenStructure

    const bonds = compute_bonds_sync(crystal, `atom_radii`, { scale: 1.15 })
    expect(bonds).toHaveLength(68)
    expect(bonds?.some((bond) => bond.jimage?.some((value) => value !== 0))).toBe(true)
  })

  it(`keeps periodic self-image bonds for one-atom primitive cells`, () => {
    const primitive = {
      sites: [site(`C`, [0, 0, 0])],
      lattice: {
        matrix: [[1.5, 0, 0], [0, 1.5, 0], [0, 0, 1.5]],
        pbc: [true, true, true],
      },
    } as PymatgenStructure

    const bonds = compute_bonds_sync(primitive, `atom_radii`, { scale: 1.15 })
    expect(bonds).toHaveLength(3)
    expect(bonds?.map((bond) => bond.jimage)).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ])
  })

  it(`keeps the immediate JS fallback for non-periodic structures`, () => {
    const molecule = {
      sites: [site(`O`, [0, 0, 0]), site(`H`, [0.96, 0, 0])],
    } as PymatgenStructure

    const bonds = compute_bonds_sync(molecule, `atom_radii`, { scale: 1.15 })
    expect(bonds).toHaveLength(1)
    expect(bonds?.[0]).toMatchObject({ site_idx_1: 0, site_idx_2: 1 })
  })

  it(`keeps the immediate JS fallback for an explicitly non-periodic box`, () => {
    const molecule_in_box = {
      sites: [site(`O`, [0, 0, 0]), site(`H`, [0.96, 0, 0])],
      lattice: {
        matrix: [[20, 0, 0], [0, 20, 0], [0, 0, 20]],
        pbc: [false, false, false],
      },
    } as PymatgenStructure

    expect(compute_bonds_sync(molecule_in_box, `atom_radii`, { scale: 1.15 }))
      .toHaveLength(1)
  })
})
