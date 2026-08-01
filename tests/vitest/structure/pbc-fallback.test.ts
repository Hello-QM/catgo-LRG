import type { ParsedStructure } from '$lib/structure/parse'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const wasm = vi.hoisted(() => ({
  find_pbc_images: vi.fn(),
}))

vi.mock(`$lib/structure/ferrox-wasm`, () => ({
  wasm_find_pbc_images: wasm.find_pbc_images,
}))

import { find_pbc_images_fast, get_pbc_image_sites } from '$lib/structure/pbc'

function boundary_bond_structure(): ParsedStructure {
  return {
    lattice: {
      matrix: [
        [10, 0, 0],
        [0, 10, 0],
        [0, 0, 10],
      ],
      pbc: [true, false, false],
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 1000,
    },
    sites: [
      {
        species: [{ element: `C`, occu: 1 }],
        abc: [0.02, 0.5, 0.5],
        xyz: [0.2, 5, 5],
        label: `C`,
        properties: {},
      },
      {
        species: [{ element: `C`, occu: 1 }],
        abc: [0.11, 0.5, 0.5],
        xyz: [1.1, 5, 5],
        label: `C`,
        properties: {},
      },
    ],
  } as ParsedStructure
}

function image_parent_indices(structure: ParsedStructure): number[] {
  const original_count = structure.num_original_sites ?? 2
  return structure.sites.slice(original_count).map((site) =>
    site.properties.orig_site_idx as number
  )
}

beforeEach(() => {
  wasm.find_pbc_images.mockReset()
  wasm.find_pbc_images.mockResolvedValue(null)
})

describe(`PBC image JS fallback bond completion`, () => {
  test(`get_pbc_image_sites keeps bond completion enabled by default`, () => {
    const structure = boundary_bond_structure()

    expect(image_parent_indices(get_pbc_image_sites(structure, false))).toEqual([0])
    expect(image_parent_indices(get_pbc_image_sites(structure))).toEqual([0, 1])
    expect(image_parent_indices(get_pbc_image_sites(structure, true))).toEqual([0, 1])
  })

  test(`find_pbc_images_fast fallback defaults to geometric images without a bond halo`, async () => {
    const structure = boundary_bond_structure()

    const result = await find_pbc_images_fast(structure)

    expect(image_parent_indices(result)).toEqual([0])
    expect(wasm.find_pbc_images).toHaveBeenCalledWith(
      structure,
      expect.objectContaining({ bond_completion: false }),
    )
  })

  test(`partial options still default fallback bond completion to false`, async () => {
    const structure = boundary_bond_structure()

    const result = await find_pbc_images_fast(structure, { range_min: -0.05 })

    expect(image_parent_indices(result)).toEqual([0])
    expect(wasm.find_pbc_images).toHaveBeenCalledWith(
      structure,
      expect.objectContaining({ bond_completion: false }),
    )
  })

  test(`find_pbc_images_fast fallback preserves explicit bond completion opt-in`, async () => {
    const structure = boundary_bond_structure()

    const result = await find_pbc_images_fast(structure, { bond_completion: true })

    expect(image_parent_indices(result)).toEqual([0, 1])
    expect(wasm.find_pbc_images).toHaveBeenCalledWith(
      structure,
      expect.objectContaining({ bond_completion: true }),
    )
  })

})
