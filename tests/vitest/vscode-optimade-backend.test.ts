import { afterEach, describe, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe(`VS Code OPTIMADE backend`, () => {
  test(`resolves provider indexes and preserves pagination metadata and query options`, async () => {
    const fetch_mock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `https://providers.optimade.org/v1/links`) {
        return new Response(JSON.stringify({
          data: [{
            id: `mpdd`,
            type: `links`,
            attributes: {
              name: `MPDD`,
              base_url: `https://providers.optimade.org/index-metadbs/mpdd`,
            },
          }],
        }))
      }
      if (url.endsWith(`/index-metadbs/mpdd/links`)) {
        return new Response(JSON.stringify({
          data: [{
            type: `links`,
            attributes: {
              link_type: `child`,
              base_url: `http://mpddoptimade.phaseslab.org`,
            },
          }],
        }))
      }
      if (url.startsWith(`http://mpddoptimade.phaseslab.org/v1/structures?`)) {
        return new Response(JSON.stringify({
          data: [{ id: `mpdd-1`, type: `structures`, attributes: {} }],
          meta: {
            data_returned: 1,
            data_available: 57,
            more_data_available: true,
          },
        }))
      }
      return new Response(`unexpected URL: ${url}`, { status: 404 })
    })
    vi.stubGlobal(`fetch`, fetch_mock)

    const { search_optimade_structures_backend } = await import(
      `../../extensions/vscode/src/optimade-backend`
    )
    const result = await search_optimade_structures_backend(`mpdd`, {
      limit: 1,
      offset: 0,
      response_fields: `chemical_formula_reduced,nsites`,
      sort: `nsites`,
    })

    expect(fetch_mock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^http:\/\/mpddoptimade\.phaseslab\.org\/v1\/structures\?/,
      ),
      expect.any(Object),
    )
    const search_url = String(fetch_mock.mock.calls.at(-1)?.[0])
    expect(search_url).toContain(`response_fields=chemical_formula_reduced%2Cnsites`)
    expect(search_url).toContain(`sort=nsites`)
    expect(result).toEqual({
      structures: [{ id: `mpdd-1`, type: `structures`, attributes: {} }],
      total_count: 57,
      has_more: true,
    })
  })

  test(`supports provider base URLs that already include the API version`, async () => {
    const fetch_mock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `https://providers.optimade.org/v1/links`) {
        return new Response(JSON.stringify({
          data: [{
            id: `atomgpt`,
            type: `links`,
            attributes: {
              name: `AtomGPT`,
              base_url: `https://atomgpt.org/optimade/v1`,
            },
          }],
        }))
      }
      if (url.endsWith(`/links`)) {
        return new Response(`not an index`, { status: 404 })
      }
      if (url === `https://atomgpt.org/optimade/v1/structures?page_limit=2&page_offset=0`) {
        return new Response(JSON.stringify({
          data: [{ id: `JVASP-1`, type: `structures`, attributes: {} }],
          meta: { data_available: 1, data_returned: 1 },
        }))
      }
      return new Response(`unexpected URL: ${url}`, { status: 404 })
    })
    vi.stubGlobal(`fetch`, fetch_mock)

    const { search_optimade_structures_backend } = await import(
      `../../extensions/vscode/src/optimade-backend`
    )
    const result = await search_optimade_structures_backend(`atomgpt`, {
      limit: 2,
    })

    expect(result.structures.map((entry) => entry.id)).toEqual([`JVASP-1`])
    expect(fetch_mock).toHaveBeenCalledWith(
      `https://atomgpt.org/optimade/v1/structures?page_limit=2&page_offset=0`,
      expect.any(Object),
    )
  })
})
