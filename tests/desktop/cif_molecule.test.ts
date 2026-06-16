import { describe, expect, it } from 'vitest'
import { structure_to_cif_str } from '../../src/lib/structure/export'
import { parse_cif } from '../../src/lib/structure/parsers/cif'

const molecule = {
  sites: [
    { species: [{ element: 'O', occu: 1, oxidation_state: 0 }], xyz: [0, 0, 0], abc: [0, 0, 0], label: 'O1', properties: {} },
    { species: [{ element: 'H', occu: 1, oxidation_state: 0 }], xyz: [0.96, 0, 0], abc: [0, 0, 0], label: 'H1', properties: {} },
    { species: [{ element: 'H', occu: 1, oxidation_state: 0 }], xyz: [-0.24, 0.93, 0], abc: [0, 0, 0], label: 'H2', properties: {} },
  ],
} as never

describe('molecule CIF round-trip', () => {
  it('exports Cartesian CIF (no cell) for a no-lattice structure', () => {
    const cif = structure_to_cif_str(molecule)
    expect(cif).toMatch(/_atom_site_Cartn_x/)
    expect(cif).not.toMatch(/_cell_length/)
  })
  it('parses a Cartesian-no-cell CIF back into a molecule with correct xyz', () => {
    const cif = structure_to_cif_str(molecule)
    const s = parse_cif(cif)
    expect(s).not.toBeNull()
    expect(s?.sites?.length).toBe(3)
    const o = s!.sites[0]
    expect(o.xyz[0]).toBeCloseTo(0, 3)
    const h = s!.sites[1]
    expect(h.xyz[0]).toBeCloseTo(0.96, 2)
  })
})
