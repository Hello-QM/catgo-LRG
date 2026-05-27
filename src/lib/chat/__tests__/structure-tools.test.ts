import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CLIENT_TOOLS, execute_tool, tool_kind } from '../structure-tools'
import { set_current_structure, get_current_structure } from '$lib/structure/current-structure.svelte'
import * as routing from '../provider-routing'
import * as ferrox from '$lib/structure/ferrox-wasm'
import * as hetero_api from '$lib/api/heterostructure'
import * as pseudo_h from '$lib/api/pseudo-hydrogen'
import { set_bulk_stash, set_film_stash, set_hetero_matches, set_lateral_matches } from '../hetero-stash.svelte'
import type { HeterostructureMatch, LateralMatch } from '$lib/api/heterostructure'

const CUBIC_NACL = {
  '@module': `pymatgen.core.structure`,
  '@class': `Structure`,
  lattice: { matrix: [[5.6, 0, 0], [0, 5.6, 0], [0, 0, 5.6]] },
  sites: [
    { species: [{ element: `Na`, occu: 1 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: `Na` },
    { species: [{ element: `Cl`, occu: 1 }], abc: [0.5, 0.5, 0.5], xyz: [2.8, 2.8, 2.8], label: `Cl` },
  ],
}

describe(`structure-tools registry`, () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it(`registers get_structure_info as a read tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `get_structure_info`)).toBeTruthy()
    expect(tool_kind(`get_structure_info`)).toBe(`read`)
  })

  it(`get_structure_info returns composition + site count`, async () => {
    const out = JSON.parse(await execute_tool(`get_structure_info`, {}))
    expect(out.num_sites).toBe(2)
    expect(out.elements).toEqual(expect.arrayContaining([`Na`, `Cl`]))
  })

  it(`returns an error result for an unknown tool`, async () => {
    const out = JSON.parse(await execute_tool(`does_not_exist`, {}))
    expect(out.error).toMatch(/unknown tool/i)
  })
})

describe(`fetch_optimade tool`, () => {
  it(`is a read tool and routes MP through the relay`, async () => {
    expect(routing.needs_relay(`https://optimade.materialsproject.org/v1/structures`)).toBe(true)
    // fetch_optimade delegates to search_optimade_structures, whose browser-direct
    // (relay) path is gated on STATIC_ONLY — set it so MP routes through the relay.
    ;(globalThis as { __CATGO_STATIC_ONLY__?: boolean }).__CATGO_STATIC_ONLY__ = true
    const spy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: `mp-1`, attributes: { chemical_formula_reduced: `ClNa` } }] }), {
        status: 200, headers: { 'Content-Type': `application/json` },
      }),
    )
    const out = JSON.parse(await execute_tool(`fetch_optimade`, { provider: `mp`, formula: `NaCl`, limit: 1 }))
    expect(out.results[0].id).toBe(`mp-1`)
    expect(spy.mock.calls[0][0]).toContain(routing.RELAY_URL)
    spy.mockRestore()
    delete (globalThis as { __CATGO_STATIC_ONLY__?: boolean }).__CATGO_STATIC_ONLY__
  })
})

describe(`fetch_pubchem tool`, () => {
  it(`returns CID + SMILES and is a read tool`, async () => {
    expect(tool_kind(`fetch_pubchem`)).toBe(`read`)
    const spy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      new Response(JSON.stringify({ PropertyTable: { Properties: [{ CID: 962, CanonicalSMILES: `O` }] } }), { status: 200 }),
    )
    const out = JSON.parse(await execute_tool(`fetch_pubchem`, { name: `water` }))
    expect(out.cid).toBe(962)
    expect(out.smiles).toBe(`O`)
    spy.mockRestore()
  })
})

describe(`mutating tools`, () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it(`make_supercell is a mutate tool and grows site count`, async () => {
    // create_supercell calls real ferrox-wasm (Rust→WASM), which cannot
    // initialize in the vitest/node environment. Mock it to return a 4-site
    // structure so the test verifies the executor wiring (kind, write-back,
    // return shape) rather than the WASM math.
    const four_site = {
      ...CUBIC_NACL,
      lattice: { matrix: [[11.2, 0, 0], [0, 5.6, 0], [0, 0, 5.6]] },
      sites: [
        { species: [{ element: `Na`, occu: 1 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: `Na` },
        { species: [{ element: `Na`, occu: 1 }], abc: [0.5, 0, 0], xyz: [5.6, 0, 0], label: `Na` },
        { species: [{ element: `Cl`, occu: 1 }], abc: [0.25, 0.5, 0.5], xyz: [2.8, 2.8, 2.8], label: `Cl` },
        { species: [{ element: `Cl`, occu: 1 }], abc: [0.75, 0.5, 0.5], xyz: [8.4, 2.8, 2.8], label: `Cl` },
      ],
    }
    const spy = vi.spyOn(ferrox, `create_supercell`).mockResolvedValue({ ok: four_site as never })
    expect(tool_kind(`make_supercell`)).toBe(`mutate`)
    const out = JSON.parse(await execute_tool(`make_supercell`, { nx: 2, ny: 1, nz: 1 }))
    expect(out.num_sites).toBe(4)
    spy.mockRestore()
  })

  it(`substitute_element replaces species and writes structure back`, async () => {
    expect(tool_kind(`substitute_element`)).toBe(`mutate`)
    const out = JSON.parse(await execute_tool(`substitute_element`, { from: `Na`, to: `K` }))
    expect(out.replaced).toBe(1)
    const info = JSON.parse(await execute_tool(`get_structure_info`, {}))
    expect(info.elements).toContain(`K`)
    expect(info.elements).not.toContain(`Na`)
  })

  it(`generate_slab is a mutate tool`, () => {
    expect(tool_kind(`generate_slab`)).toBe(`mutate`)
  })

  it(`place_adsorbate is a mutate tool`, () => {
    expect(tool_kind(`place_adsorbate`)).toBe(`mutate`)
  })

  it(`place_adsorbate computes fractional abc from cartesian position`, async () => {
    const out = JSON.parse(await execute_tool(`place_adsorbate`, { element: `H`, position: [2.8, 2.8, 2.8] }))
    expect(out.num_sites).toBe(3)
    const added = (get_current_structure() as never as { sites: { abc: number[]; xyz: number[] }[] }).sites[2]
    // abc must be FRACTIONAL (0.5,0.5,0.5 in a 5.6 Å cubic cell), NOT the raw cartesian.
    expect(added.abc[0]).toBeCloseTo(0.5)
    expect(added.abc[1]).toBeCloseTo(0.5)
    expect(added.abc[2]).toBeCloseTo(0.5)
    expect(added.xyz[0]).toBeCloseTo(2.8)
    expect(added.xyz[1]).toBeCloseTo(2.8)
    expect(added.xyz[2]).toBeCloseTo(2.8)
  })
})

describe(`more read tools`, () => {
  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it(`get_distance returns a positive distance (executor wiring)`, async () => {
    expect(tool_kind(`get_distance`)).toBe(`read`)
    // get_distance hits real ferrox-wasm (Rust→WASM), which cannot initialize
    // in vitest/node. Mock the wrapper so the test exercises executor wiring.
    const spy = vi.spyOn(ferrox, `get_distance`).mockResolvedValue({ ok: 4.85 })
    const out = JSON.parse(await execute_tool(`get_distance`, { i: 0, j: 1 }))
    expect(out.distance).toBeGreaterThan(0)
    expect(out.distance).toBe(4.85)
    spy.mockRestore()
  })

  it(`get_spacegroup is a read tool`, () => {
    expect(tool_kind(`get_spacegroup`)).toBe(`read`)
  })

  it(`compute_xrd is a read tool`, () => {
    expect(tool_kind(`compute_xrd`)).toBe(`read`)
  })

  it(`load_optimade_structure is a mutate tool`, () => {
    expect(tool_kind(`load_optimade_structure`)).toBe(`mutate`)
  })
})

describe(`client-direct builder tools (#144 wasm)`, () => {
  // These call real ferrox-wasm builders, which cannot initialize in
  // vitest/node — so we assert only on `kind`, matching how generate_slab and
  // place_adsorbate are tested above.
  it(`build_nanotube is a mutate tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `build_nanotube`)).toBeTruthy()
    expect(tool_kind(`build_nanotube`)).toBe(`mutate`)
  })

  it(`build_nanoscroll is a mutate tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `build_nanoscroll`)).toBeTruthy()
    expect(tool_kind(`build_nanoscroll`)).toBe(`mutate`)
  })

  it(`build_moire is a mutate tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `build_moire`)).toBeTruthy()
    expect(tool_kind(`build_moire`)).toBe(`mutate`)
  })
})

describe(`heterostructure tools`, () => {
  const FAKE_MATCH: HeterostructureMatch = {
    match_id: 0,
    strain: 0.5,
    match_area: 50,
    n_atoms_substrate: 4,
    n_atoms_film: 4,
    substrate_transformation: [[1, 0], [0, 1]],
    film_transformation: [[1, 0], [0, 1]],
    film_miller: [0, 0, 1],
    substrate_miller: [0, 0, 1],
    film_sl_vectors: [],
    substrate_sl_vectors: [],
  }

  beforeEach(() => set_current_structure(CUBIC_NACL as never))

  it(`set_film is a read tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `set_film`)).toBeTruthy()
    expect(tool_kind(`set_film`)).toBe(`read`)
  })

  it(`heterostructure_search is a read tool`, () => {
    expect(tool_kind(`heterostructure_search`)).toBe(`read`)
  })

  it(`build_heterostructure is a mutate tool`, () => {
    expect(tool_kind(`build_heterostructure`)).toBe(`mutate`)
  })

  it(`set_film stashes the current structure and returns formula + site count`, async () => {
    const out = JSON.parse(await execute_tool(`set_film`, {}))
    expect(out.film_num_sites).toBe(2)
    expect(out.film_formula).toContain(`Na`)
    expect(out.film_formula).toContain(`Cl`)
  })

  it(`heterostructure_search stashes matches and returns a compact summary`, async () => {
    // Stash a film, then mock the api so no WASM/backend is hit.
    set_film_stash(CUBIC_NACL as never)
    const spy = vi.spyOn(hetero_api, `searchHeterostructureMatches`).mockResolvedValue({
      matches: [FAKE_MATCH],
      terminations: [],
      n_matches: 1,
      n_terminations: 0,
      message: `ok`,
    })
    const out = JSON.parse(await execute_tool(`heterostructure_search`, {}))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.n_matches).toBe(1)
    expect(out.matches[0].index).toBe(0)
    expect(out.matches[0].strain).toBe(0.5)
    expect(out.matches[0].n_atoms_substrate).toBe(4)
    spy.mockRestore()
  })

  it(`heterostructure_search errors when no film is stashed`, async () => {
    set_film_stash(null as never)
    const out = JSON.parse(await execute_tool(`heterostructure_search`, {}))
    expect(out.error).toMatch(/set_film/i)
  })

  it(`build_heterostructure uses stashed transforms and writes the result back`, async () => {
    set_film_stash(CUBIC_NACL as never)
    set_hetero_matches([FAKE_MATCH])
    const built = {
      ...CUBIC_NACL,
      sites: Array.from({ length: 8 }, (_, i) => ({
        species: [{ element: i < 4 ? `Na` : `Cl`, occu: 1 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: i < 4 ? `Na` : `Cl`,
      })),
    }
    const spy = vi.spyOn(hetero_api, `buildHeterostructureManual`).mockResolvedValue({
      structure: built as never,
      n_atoms: 8,
      n_atoms_substrate: 4,
      n_atoms_film: 4,
      match_area: 50,
      strain: 0.5,
      message: `ok`,
    })
    const out = JSON.parse(await execute_tool(`build_heterostructure`, { match_index: 0 }))
    expect(spy).toHaveBeenCalledTimes(1)
    // called with the stashed substrate/film transforms (args 3 and 4)
    expect(spy.mock.calls[0][2]).toEqual(FAKE_MATCH.substrate_transformation)
    expect(spy.mock.calls[0][3]).toEqual(FAKE_MATCH.film_transformation)
    expect(out.num_sites).toBe(8)
    expect(out.strain).toBe(0.5)
    // set_current_structure received the built (8-site) structure
    expect((get_current_structure() as never as { sites: unknown[] }).sites).toHaveLength(8)
    spy.mockRestore()
  })

  it(`build_heterostructure errors when no matches are stashed`, async () => {
    set_hetero_matches([])
    const out = JSON.parse(await execute_tool(`build_heterostructure`, {}))
    expect(out.error).toMatch(/heterostructure_search/i)
  })
})

describe(`lateral heterostructure tools`, () => {
  const FAKE_LATERAL: LateralMatch = {
    match_id: 0,
    n1: 2,
    n2: 3,
    edge_length_A: 10.0,
    edge_length_B: 9.8,
    strain_percent: 1.2,
    n_atoms_A: 6,
    n_atoms_B: 8,
  }

  beforeEach(() => {
    set_current_structure(CUBIC_NACL as never)
    set_film_stash(null as never)
    set_lateral_matches([])
  })

  it(`lateral_heterostructure_search is a read tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `lateral_heterostructure_search`)).toBeTruthy()
    expect(tool_kind(`lateral_heterostructure_search`)).toBe(`read`)
  })

  it(`build_lateral_heterostructure is a mutate tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `build_lateral_heterostructure`)).toBeTruthy()
    expect(tool_kind(`build_lateral_heterostructure`)).toBe(`mutate`)
  })

  it(`lateral_heterostructure_search stashes matches and returns a compact summary`, async () => {
    set_film_stash(CUBIC_NACL as never)
    const spy = vi.spyOn(hetero_api, `searchLateralMatches`).mockResolvedValue({
      matches: [FAKE_LATERAL],
      n_matches: 1,
      message: `ok`,
    })
    const out = JSON.parse(await execute_tool(`lateral_heterostructure_search`, {}))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(out.n_matches).toBe(1)
    expect(out.matches[0].index).toBe(0)
    expect(out.matches[0].strain).toBe(1.2)
    expect(out.matches[0].edge_length_A).toBe(10.0)
    expect(out.matches[0].n_atoms_A).toBe(6)
    spy.mockRestore()
  })

  it(`lateral_heterostructure_search errors when no film is stashed`, async () => {
    set_film_stash(null as never)
    const out = JSON.parse(await execute_tool(`lateral_heterostructure_search`, {}))
    expect(out.error).toMatch(/set_film/i)
  })

  it(`build_lateral_heterostructure uses the stashed match and writes the result back`, async () => {
    set_film_stash(CUBIC_NACL as never)
    set_lateral_matches([FAKE_LATERAL])
    const built = {
      ...CUBIC_NACL,
      sites: Array.from({ length: 14 }, () => ({
        species: [{ element: `Na`, occu: 1 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `Na`,
      })),
    }
    const spy = vi.spyOn(hetero_api, `buildLateralInterface`).mockResolvedValue({
      structure: built as never,
      n_atoms: 14,
      n_atoms_A: 6,
      n_atoms_B: 8,
      interface_length: 10.0,
      strain: 1.2,
      message: `ok`,
    })
    const out = JSON.parse(await execute_tool(`build_lateral_heterostructure`, { match_index: 0 }))
    expect(spy).toHaveBeenCalledTimes(1)
    // called with the stashed match object as the 3rd arg
    expect(spy.mock.calls[0][2]).toEqual(FAKE_LATERAL)
    expect(out.num_sites).toBe(14)
    expect(out.strain).toBe(1.2)
    expect(out.n_atoms_A).toBe(6)
    expect((get_current_structure() as never as { sites: unknown[] }).sites).toHaveLength(14)
    spy.mockRestore()
  })

  it(`build_lateral_heterostructure errors when no matches are stashed`, async () => {
    set_lateral_matches([])
    const out = JSON.parse(await execute_tool(`build_lateral_heterostructure`, {}))
    expect(out.error).toMatch(/lateral_heterostructure_search/i)
  })
})

describe(`pseudo-hydrogen passivation tools`, () => {
  // A distinct cubic "bulk" reference, separate from the slab (CUBIC_NACL).
  const CUBIC_BULK = {
    '@module': `pymatgen.core.structure`,
    '@class': `Structure`,
    lattice: { matrix: [[3.5, 0, 0], [0, 3.5, 0], [0, 0, 3.5]] },
    sites: [{ species: [{ element: `Cu`, occu: 1 }], abc: [0, 0, 0], xyz: [0, 0, 0], label: `Cu` }],
  }

  beforeEach(() => {
    set_current_structure(CUBIC_NACL as never)
    set_bulk_stash(null as never)
  })

  it(`set_bulk_reference is a read tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `set_bulk_reference`)).toBeTruthy()
    expect(tool_kind(`set_bulk_reference`)).toBe(`read`)
  })

  it(`passivate_surface is a mutate tool`, () => {
    expect(CLIENT_TOOLS.find((t) => t.name === `passivate_surface`)).toBeTruthy()
    expect(tool_kind(`passivate_surface`)).toBe(`mutate`)
  })

  it(`set_bulk_reference stashes the current structure and returns formula + site count`, async () => {
    set_current_structure(CUBIC_BULK as never)
    const out = JSON.parse(await execute_tool(`set_bulk_reference`, {}))
    expect(out.bulk_num_sites).toBe(1)
    expect(out.bulk_formula).toContain(`Cu`)
  })

  it(`passivate_surface errors when no bulk stashed and no bulk_coordination given`, async () => {
    set_bulk_stash(null as never)
    const out = JSON.parse(await execute_tool(`passivate_surface`, {}))
    expect(out.error).toMatch(/bulk reference|bulk_coordination/i)
  })

  it(`passivate_surface passes (slab, bulk, params) and writes the result back`, async () => {
    // Stash a distinct bulk; current = the slab.
    set_bulk_stash(CUBIC_BULK as never)
    set_current_structure(CUBIC_NACL as never)
    const passivated = {
      ...CUBIC_NACL,
      sites: Array.from({ length: 6 }, (_, i) => ({
        species: [{ element: i < 2 ? (i === 0 ? `Na` : `Cl`) : `H`, occu: 1 }],
        abc: [0, 0, 0],
        xyz: [0, 0, 0],
        label: `X`,
      })),
    }
    const spy = vi.spyOn(pseudo_h, `passivateSlab`).mockResolvedValue({
      structure: passivated as never,
      n_pseudo_h: 4,
      bulk_coordination: { Na: 6, Cl: 6 },
      valence_used: {},
      pseudo_h_list: [],
      unique_potcars: [],
      bond_warnings: [],
      message: `ok`,
    })
    const out = JSON.parse(await execute_tool(`passivate_surface`, {}))
    expect(spy).toHaveBeenCalledTimes(1)
    // arg 0 = slab (current), arg 1 = stashed bulk
    expect((spy.mock.calls[0][0] as { sites: unknown[] }).sites).toHaveLength(2)
    expect((spy.mock.calls[0][1] as { sites: unknown[] }).sites).toHaveLength(1)
    expect(out.num_sites).toBe(6)
    expect(out.n_hydrogens_added).toBe(4)
    // set_current_structure received the passivated structure
    expect((get_current_structure() as never as { sites: unknown[] }).sites).toHaveLength(6)
    spy.mockRestore()
  })

  it(`passivate_surface accepts explicit bulk_coordination without a stashed bulk`, async () => {
    set_bulk_stash(null as never)
    set_current_structure(CUBIC_NACL as never)
    const spy = vi.spyOn(pseudo_h, `passivateSlab`).mockResolvedValue({
      structure: CUBIC_NACL as never,
      n_pseudo_h: 0,
      bulk_coordination: { Na: 6, Cl: 6 },
      valence_used: {},
      pseudo_h_list: [],
      unique_potcars: [],
      bond_warnings: [],
      message: `ok`,
    })
    const out = JSON.parse(
      await execute_tool(`passivate_surface`, { bulk_coordination: { Na: 6, Cl: 6 } }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
    // explicit coordination passed through params (arg 2)
    expect((spy.mock.calls[0][2] as { bulk_coordination?: unknown }).bulk_coordination).toEqual({
      Na: 6,
      Cl: 6,
    })
    expect(out.num_sites).toBe(2)
    spy.mockRestore()
  })
})
