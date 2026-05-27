import { describe, it, expect } from 'vitest'
import {
  get_bulk_stash,
  get_film_stash,
  get_hetero_matches,
  get_lateral_matches,
  set_bulk_stash,
  set_film_stash,
  set_hetero_matches,
  set_lateral_matches,
} from '../hetero-stash.svelte'
import type { HeterostructureMatch, LateralMatch } from '$lib/api/heterostructure'

const CUBIC = {
  '@module': `pymatgen.core.structure`,
  '@class': `Structure`,
  lattice: { matrix: [[3.5, 0, 0], [0, 3.5, 0], [0, 0, 3.5]] },
  sites: [{ species: [{ element: `Cu`, occu: 1 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: `Cu` }],
}

const MATCH: HeterostructureMatch = {
  match_id: 0,
  match_area: 50,
  film_miller: [0, 0, 1],
  substrate_miller: [0, 0, 1],
  film_transformation: [[1, 0], [0, 1]],
  substrate_transformation: [[1, 0], [0, 1]],
  film_sl_vectors: [],
  substrate_sl_vectors: [],
  strain: 0.5,
  n_atoms_substrate: 4,
  n_atoms_film: 4,
}

describe(`hetero-stash`, () => {
  it(`film set/get round-trips`, () => {
    set_film_stash(CUBIC as never)
    expect(get_film_stash()).toStrictEqual(CUBIC as never)
  })

  it(`matches set/get round-trips`, () => {
    set_hetero_matches([MATCH])
    const out = get_hetero_matches()
    expect(out).toHaveLength(1)
    expect(out[0].match_id).toBe(0)
    expect(out[0].substrate_transformation).toEqual([[1, 0], [0, 1]])
  })

  it(`bulk set/get round-trips`, () => {
    expect(get_bulk_stash()).toBeNull()
    set_bulk_stash(CUBIC as never)
    expect(get_bulk_stash()).toStrictEqual(CUBIC as never)
  })

  it(`lateral-matches set/get round-trips`, () => {
    const lateral: LateralMatch = {
      match_id: 3,
      n1: 2,
      n2: 3,
      edge_length_A: 10.2,
      edge_length_B: 10.1,
      strain_percent: 0.9,
      n_atoms_A: 6,
      n_atoms_B: 8,
    }
    set_lateral_matches([lateral])
    const out = get_lateral_matches()
    expect(out).toHaveLength(1)
    expect(out[0].match_id).toBe(3)
    expect(out[0].strain_percent).toBe(0.9)
    expect(out[0].edge_length_A).toBe(10.2)
  })
})
