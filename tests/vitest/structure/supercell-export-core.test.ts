import {
  type CoreStructure,
  EXPORT_ATOM_CONFIRM_THRESHOLD,
  expand_and_serialize,
  expand_supercell,
  expanded_atom_count,
  serialize_poscar,
  serialize_xyz,
} from '$lib/structure/export/supercell-export-core'
import { describe, expect, test } from 'vitest'

// 2-atom orthorhombic base cell (4 Å cube) — H at origin, He at the body centre.
const base: CoreStructure = {
  id: `H2He`,
  lattice: {
    matrix: [[4, 0, 0], [0, 4, 0], [0, 0, 4]],
    pbc: [true, true, true],
  },
  sites: [
    { species: [{ element: `H` }], xyz: [0, 0, 0], abc: [0, 0, 0], label: `H1` },
    { species: [{ element: `He` }], xyz: [2, 2, 2], abc: [0.5, 0.5, 0.5], label: `He1` },
  ],
}

describe(`expanded_atom_count`, () => {
  test(`multiplies site count by the cell product`, () => {
    expect(expanded_atom_count(base, [2, 1, 1])).toBe(4)
    expect(expanded_atom_count(base, [2, 2, 2])).toBe(16)
    expect(expanded_atom_count(base, [10, 10, 10])).toBe(2000)
  })
})

describe(`expand_supercell`, () => {
  test(`2-atom base ×2×1×1 → 4 atoms with scaled lattice + correct positions`, () => {
    const sc = expand_supercell(base, [2, 1, 1])

    // 2 atoms × 2 cells = 4 sites.
    expect(sc.sites.length).toBe(4)

    // Lattice scaled by [2,1,1] along a only.
    expect(sc.lattice!.matrix).toEqual([[8, 0, 0], [0, 4, 0], [0, 0, 4]])

    // Cell (0,0,0): H@(0,0,0), He@(2,2,2). Cell (1,0,0): +a(4,0,0).
    const xyz = sc.sites.map((s) => s.xyz)
    expect(xyz[0]).toEqual([0, 0, 0]) // H, cell 0
    expect(xyz[1]).toEqual([2, 2, 2]) // He, cell 0
    expect(xyz[2]).toEqual([4, 0, 0]) // H, cell (1,0,0)
    expect(xyz[3]).toEqual([6, 2, 2]) // He, cell (1,0,0)

    // Fractional coords are in the SCALED cell (a doubled → x halves).
    expect(sc.sites[2].abc![0]).toBeCloseTo(0.5, 10) // H replica at a-edge
    expect(sc.sites[0].abc).toEqual([0, 0, 0])

    // Elements preserved.
    expect(sc.sites.map((s) => s.species[0].element)).toEqual([`H`, `He`, `H`, `He`])
  })

  test(`charge scales by the cell count`, () => {
    const charged: CoreStructure = { ...base, charge: -2 }
    expect(expand_supercell(charged, [2, 2, 1]).charge).toBe(-8)
  })

  test(`throws without a lattice`, () => {
    expect(() => expand_supercell({ sites: base.sites }, [2, 1, 1])).toThrow(/lattice/)
  })
})

describe(`serialize_poscar`, () => {
  test(`expand ×2×1×1 then serialize to a valid POSCAR`, () => {
    const sc = expand_supercell(base, [2, 1, 1])
    const text = serialize_poscar(sc)
    const lines = text.trim().split(`\n`)

    // line 0: comment (id), line 1: scale.
    expect(lines[1].trim()).toBe(`1.0`)
    // Lattice a-vector doubled.
    expect(lines[2].trim().split(/\s+/).map(Number)[0]).toBeCloseTo(8, 6)
    // Element symbols + counts (grouped: 2 H, 2 He).
    expect(lines[5].trim().split(/\s+/)).toEqual([`H`, `He`])
    expect(lines[6].trim().split(/\s+/)).toEqual([`2`, `2`])
    expect(lines[7].trim()).toBe(`Direct`)
    // 4 coordinate lines follow.
    expect(lines.length).toBe(8 + 4)
  })
})

describe(`serialize_xyz`, () => {
  test(`plain xyz has atom count + element/coord lines`, () => {
    const sc = expand_supercell(base, [2, 1, 1])
    const lines = serialize_xyz(sc, false).trim().split(`\n`)
    expect(lines[0]).toBe(`4`)
    // First atom: H at origin.
    expect(lines[2].split(/\s+/)[0]).toBe(`H`)
    expect(lines.length).toBe(2 + 4)
  })

  test(`extxyz embeds Lattice + Properties in the comment line`, () => {
    const sc = expand_supercell(base, [2, 1, 1])
    const lines = serialize_xyz(sc, true).trim().split(`\n`)
    expect(lines[1]).toContain(`Lattice="`)
    expect(lines[1]).toContain(`Properties="species:S:1:pos:R:3"`)
    expect(lines[1]).toContain(`pbc="T T T"`)
  })
})

describe(`expand_and_serialize`, () => {
  test(`routes each format`, () => {
    expect(expand_and_serialize(base, [2, 1, 1], `poscar`)).toContain(`Direct`)
    expect(expand_and_serialize(base, [2, 1, 1], `xyz`).startsWith(`4\n`)).toBe(true)
    expect(expand_and_serialize(base, [2, 1, 1], `extxyz`)).toContain(`Lattice="`)
  })
})

describe(`EXPORT_ATOM_CONFIRM_THRESHOLD`, () => {
  test(`is a sane multi-million guard`, () => {
    expect(EXPORT_ATOM_CONFIRM_THRESHOLD).toBeGreaterThanOrEqual(1_000_000)
  })
})
