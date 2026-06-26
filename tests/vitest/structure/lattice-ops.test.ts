import type { PymatgenMolecule, PymatgenStructure, Vec3 } from '$lib'
import {
  fractional_to_cartesian,
  wrap_molecule_with_lattice_params,
  type LatticeParams,
} from '$lib/structure/lattice-ops'
import { describe, expect, it } from 'vitest'

const water = {
  sites: [
    { name: `O`, species: [{ element: `O`, occu: 1 }], xyz: [0.0, 0.0, 0.586], properties: {} },
    { name: `H`, species: [{ element: `H`, occu: 1 }], xyz: [0.757, 0.0, 0.0], properties: {} },
    { name: `H`, species: [{ element: `H`, occu: 1 }], xyz: [-0.757, 0.0, 0.0], properties: {} },
  ],
} as unknown as PymatgenMolecule

const cubic_box: LatticeParams = {
  a: 10,
  b: 10,
  c: 10,
  alpha: 90,
  beta: 90,
  gamma: 90,
}

const triclinic_box: LatticeParams = {
  a: 10,
  b: 11,
  c: 12,
  alpha: 80,
  beta: 100,
  gamma: 75,
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function expect_vec_close(actual: Vec3, expected: Vec3, digits = 10): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits)
  expect(actual[1]).toBeCloseTo(expected[1], digits)
  expect(actual[2]).toBeCloseTo(expected[2], digits)
}

function minimum_image_distance(structure: PymatgenStructure, i: number, j: number): number {
  const da: Vec3 = [
    structure.sites[i].abc[0] - structure.sites[j].abc[0],
    structure.sites[i].abc[1] - structure.sites[j].abc[1],
    structure.sites[i].abc[2] - structure.sites[j].abc[2],
  ]
  const wrapped: Vec3 = [
    da[0] - Math.round(da[0]),
    da[1] - Math.round(da[1]),
    da[2] - Math.round(da[2]),
  ]
  const cart = fractional_to_cartesian(wrapped, structure.lattice.matrix)
  return Math.hypot(cart[0], cart[1], cart[2])
}

describe(`wrap_molecule_with_lattice_params`, () => {
  it(`stores fractional abc coordinates when wrapping H2O in a cubic periodic box`, () => {
    const boxed = wrap_molecule_with_lattice_params(water, cubic_box)

    expect(boxed.lattice.pbc).toEqual([true, true, true])
    expect(boxed.sites).toHaveLength(3)

    for (const site of boxed.sites) {
      expect(site.abc).toHaveLength(3)
      expect_vec_close(
        fractional_to_cartesian(site.abc, boxed.lattice.matrix),
        site.xyz,
      )
    }

    const original_oh = distance(water.sites[0].xyz, water.sites[1].xyz)
    const boxed_oh = distance(boxed.sites[0].xyz, boxed.sites[1].xyz)
    const pbc_oh = minimum_image_distance(boxed, 0, 1)

    expect(boxed_oh).toBeCloseTo(original_oh, 10)
    expect(pbc_oh).toBeCloseTo(original_oh, 10)
    expect(pbc_oh).toBeLessThan(1.1)
  })

  it(`keeps molecular bond lengths correct for a non-orthogonal periodic box`, () => {
    const boxed = wrap_molecule_with_lattice_params(water, triclinic_box)

    for (const site of boxed.sites) {
      expect_vec_close(
        fractional_to_cartesian(site.abc, boxed.lattice.matrix),
        site.xyz,
      )
    }

    const original_oh_1 = distance(water.sites[0].xyz, water.sites[1].xyz)
    const original_oh_2 = distance(water.sites[0].xyz, water.sites[2].xyz)

    expect(distance(boxed.sites[0].xyz, boxed.sites[1].xyz)).toBeCloseTo(original_oh_1, 10)
    expect(distance(boxed.sites[0].xyz, boxed.sites[2].xyz)).toBeCloseTo(original_oh_2, 10)
    expect(minimum_image_distance(boxed, 0, 1)).toBeCloseTo(original_oh_1, 10)
    expect(minimum_image_distance(boxed, 0, 2)).toBeCloseTo(original_oh_2, 10)
  })
})
