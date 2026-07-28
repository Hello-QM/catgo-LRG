import { afterEach, describe, expect, it, vi } from 'vitest'

describe(`PubChem search routing`, () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it(`keeps different page sizes in separate cache entries`, async () => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.resetModules()
    const fetch_spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (input) => {
      const url = new URL(String(input))
      const count = Number(url.searchParams.get(`max_results`))
      return new Response(
        JSON.stringify({
          compounds: Array.from({ length: count }, (_, index) => ({
            cid: index + 1,
            formula: `C${index + 1}`,
          })),
          total_count: 100,
          has_more: true,
        }),
        { status: 200 },
      )
    })

    const { search_pubchem_compounds } = await import(`../pubchem`)
    const small = await search_pubchem_compounds(`carbon`, undefined, 5, 0)
    const large = await search_pubchem_compounds(`carbon`, undefined, 20, 0)

    expect(small.compounds).toHaveLength(5)
    expect(large.compounds).toHaveLength(20)
    expect(fetch_spy).toHaveBeenCalledTimes(2)
  })

  it(`paginates direct formula searches through a PubChem list key`, async () => {
    ;(globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__ = true
    vi.resetModules()
    const fetch_spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(`/fastformula/C6H12O6/cids/JSON`)) {
        return new Response(
          JSON.stringify({
            IdentifierList: { ListKey: `formula-key`, Size: 25 },
          }),
          { status: 200 },
        )
      }
      if (url.includes(`/compound/listkey/formula-key/property/`)) {
        return new Response(
          JSON.stringify({
            PropertyTable: {
              Properties: Array.from({ length: 5 }, (_, index) => ({
                CID: 21 + index,
                MolecularFormula: `C6H12O6`,
                MolecularWeight: 180.16,
              })),
            },
          }),
          { status: 200 },
        )
      }
      return new Response(`unexpected URL: ${url}`, { status: 500 })
    })

    const { search_pubchem_compounds } = await import(`../pubchem`)
    const result = await search_pubchem_compounds(`C6H12O6`, undefined, 5, 20)

    expect(result.compounds.map((entry) => entry.cid)).toEqual([21, 22, 23, 24, 25])
    expect(result.total_count).toBe(25)
    expect(result.has_more).toBe(false)
    expect(fetch_spy).toHaveBeenCalledTimes(2)
    const page_url = String(fetch_spy.mock.calls[1]?.[0] ?? ``)
    expect(page_url).toContain(`listkey_start=20`)
    expect(page_url).toContain(`listkey_count=5`)
  })

  it(`uses fast substructure rather than a name lookup for direct element search`, async () => {
    ;(globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__ = true
    vi.resetModules()
    const fetch_spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(`/fastsubstructure/smiles/%5BFe%5D/cids/JSON`)) {
        return new Response(
          JSON.stringify({
            IdentifierList: { ListKey: `iron-key`, Size: 2 },
          }),
          { status: 200 },
        )
      }
      if (url.includes(`/compound/listkey/iron-key/property/`)) {
        return new Response(
          JSON.stringify({
            PropertyTable: {
              Properties: [
                { CID: 1, MolecularFormula: `Fe2O3`, MolecularWeight: 159.69 },
                { CID: 2, MolecularFormula: `FeS`, MolecularWeight: 87.91 },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response(`unexpected URL: ${url}`, { status: 500 })
    })

    const { search_pubchem_compounds } = await import(`../pubchem`)
    const result = await search_pubchem_compounds(undefined, [`Fe`, `O`], 20, 0)

    expect(result.compounds.map((entry) => entry.cid)).toEqual([1])
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(String(fetch_spy.mock.calls[0]?.[0] ?? ``)).toContain(
      `/fastsubstructure/smiles/%5BFe%5D/cids/JSON`,
    )
  })
})
