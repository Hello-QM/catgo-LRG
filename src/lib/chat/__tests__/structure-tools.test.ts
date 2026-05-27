import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CLIENT_TOOLS, execute_tool, tool_kind } from '../structure-tools'
import { set_current_structure, get_current_structure } from '$lib/structure/current-structure.svelte'
import * as routing from '../provider-routing'
import * as ferrox from '$lib/structure/ferrox-wasm'

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
