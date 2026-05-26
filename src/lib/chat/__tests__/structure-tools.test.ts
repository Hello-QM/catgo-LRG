import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CLIENT_TOOLS, execute_tool, tool_kind } from '../structure-tools'
import { set_current_structure } from '$lib/structure/current-structure.svelte'
import * as routing from '../provider-routing'

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
    const spy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: `mp-1`, attributes: { chemical_formula_reduced: `NaCl` } }] }), {
        status: 200, headers: { 'Content-Type': `application/json` },
      }),
    )
    const out = JSON.parse(await execute_tool(`fetch_optimade`, { provider: `mp`, formula: `NaCl`, limit: 1 }))
    expect(out.results[0].id).toBe(`mp-1`)
    expect(spy.mock.calls[0][0]).toContain(routing.RELAY_URL)
    spy.mockRestore()
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
