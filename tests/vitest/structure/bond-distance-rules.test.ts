import { describe, expect, it } from 'vitest'
import { apply_bond_distance_rules } from '$lib/structure/bond-distance-rules'
import type { AnyStructure, BondPair, Site, Vec3 } from '$lib/structure'

function site(el: string, xyz: Vec3): Site {
  return {
    species: [{ element: el, occu: 1, oxidation_state: 0 }],
    xyz,
    abc: xyz,
    label: el,
    properties: {},
  } as unknown as Site
}

function struct(sites: Site[], matrix?: [Vec3, Vec3, Vec3]): AnyStructure {
  return (matrix ? { sites, lattice: { matrix } } : { sites }) as unknown as AnyStructure
}

function bond(i: number, j: number, len: number): BondPair {
  return {
    pos_1: [0, 0, 0], pos_2: [0, 0, 0], site_idx_1: i, site_idx_2: j,
    bond_length: len, strength: 1, transform_matrix: new Float32Array(16),
    jimage: [0, 0, 0],
  } as unknown as BondPair
}

describe(`apply_bond_distance_rules`, () => {
  it(`returns bonds unchanged when there are no rules`, () => {
    const s = struct([site(`Fe`, [0, 0, 0]), site(`O`, [2, 0, 0])])
    const bonds = [bond(0, 1, 2)]
    expect(apply_bond_distance_rules(s, null, bonds, [])).toHaveLength(1)
  })

  it(`keeps bonds of element pairs that have no rule`, () => {
    const s = struct([site(`P`, [0, 0, 0]), site(`O`, [1.5, 0, 0])])
    const bonds = [bond(0, 1, 1.5)]
    const out = apply_bond_distance_rules(s, null, bonds, [
      { element_1: `Fe`, element_2: `O`, min_dist: 0, max_dist: 2.3 },
    ])
    expect(out).toHaveLength(1) // P-O untouched (no P-O rule)
  })

  it(`uses current-frame positions (trajectory) instead of static xyz`, () => {
    // Static geometry: Fe-O at 2.5 Å, outside [0, 2.3] → no bond.
    // The trajectory's current frame moved O to 2.0 Å → the rule must
    // regenerate the bond from the FRAME position, not the static one.
    const s = struct([site(`Fe`, [0, 0, 0]), site(`O`, [2.5, 0, 0])])
    const frame = new Float32Array([0, 0, 0, 2.0, 0, 0])
    const out = apply_bond_distance_rules(
      s,
      null,
      [],
      [{ element_1: `Fe`, element_2: `O`, min_dist: 0, max_dist: 2.3 }],
      frame,
    )
    expect(out).toHaveLength(1)
    expect(out[0].bond_length).toBeCloseTo(2.0, 3)
  })

  it(`removes a ruled-pair bond that is longer than max`, () => {
    // Fe-O at 2.5 Å, rule max 2.3 -> dropped, and not regenerated (out of range)
    const s = struct([site(`Fe`, [0, 0, 0]), site(`O`, [2.5, 0, 0])])
    const bonds = [bond(0, 1, 2.5)]
    const out = apply_bond_distance_rules(s, null, bonds, [
      { element_1: `Fe`, element_2: `O`, min_dist: 0, max_dist: 2.3 },
    ])
    expect(out).toHaveLength(0)
  })

  it(`generates a ruled-pair bond within range even if the strategy missed it`, () => {
    // No input bond at all; Fe-O at 2.296 Å within [0,2.3] must be created
    const s = struct([site(`Fe`, [0, 0, 0]), site(`O`, [2.296, 0, 0])])
    const out = apply_bond_distance_rules(s, null, [], [
      { element_1: `Fe`, element_2: `O`, min_dist: 0, max_dist: 2.3 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].bond_length).toBeCloseTo(2.296, 3)
    expect(out[0].jimage).toEqual([0, 0, 0])
  })

  it(`generates cross-cell bonds with the correct jimage and PBC distance`, () => {
    // 4 Å cubic. Fe at origin, O at (3.7,0,0). In-cell dist 3.7 (> 2.3, dropped),
    // but the -x image of O is at (-0.3,0,0) -> dist 0.3... use a cleaner case:
    // Fe (2,2,2), O (2,2,0): in-cell dist 2 (kept), image (2,2,4) dist 2 (kept).
    const LAT: [Vec3, Vec3, Vec3] = [[4, 0, 0], [0, 4, 0], [0, 0, 4]]
    const s = struct([site(`Fe`, [2, 2, 2]), site(`O`, [2, 2, 0])], LAT)
    const out = apply_bond_distance_rules(s, LAT, [], [
      { element_1: `Fe`, element_2: `O`, min_dist: 0.5, max_dist: 2.3 },
    ])
    // two Fe-O bonds: in-cell (jimage 0,0,0) and +z image (0,0,1), both 2 Å
    expect(out).toHaveLength(2)
    expect(out.every((b) => Math.abs(b.bond_length - 2) < 1e-9)).toBe(true)
    const jimages = out.map((b) => b.jimage.join(`,`)).sort()
    expect(jimages).toEqual([`0,0,0`, `0,0,1`])
  })

  it(`does not double-count a bond from both directions`, () => {
    // Two Fe-O within range; ensure each undirected bond appears once
    const s = struct([site(`Fe`, [0, 0, 0]), site(`O`, [2, 0, 0])])
    const out = apply_bond_distance_rules(s, null, [], [
      { element_1: `O`, element_2: `Fe`, min_dist: 0, max_dist: 2.3 },
    ])
    expect(out).toHaveLength(1)
  })
})
