import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { needs_relay, relay_url } from '$lib/chat/provider-routing'

// Routing contract: Materials Project's OPTIMADE host blocks browser CORS and
// must traverse the relay Worker; open-CORS providers fetch directly.
describe(`optimade static MP routing`, () => {
  it(`MP base url needs relay; alexandria does not`, () => {
    expect(needs_relay(`https://optimade.materialsproject.org/v1/structures`)).toBe(true)
    expect(needs_relay(`https://alexandria.icams.rub.de/pbe/v1/structures`)).toBe(false)
  })

  it(`MP REST API host (energies/band gaps) needs relay`, () => {
    // api.materialsproject.org also sends no ACAO; the API-key validation +
    // summary enrichment must traverse the relay in the static web build.
    expect(needs_relay(`https://api.materialsproject.org/materials/summary/?_limit=1`)).toBe(true)
  })
})

// Stronger integration: in static mode the OPTIMADE search must go out through
// the relay for MP, and directly for open providers. We flip the build-time
// global on globalThis (the `typeof __CATGO_STATIC_ONLY__` guard reads it from
// the global scope) and spy on fetch.
describe(`optimade search static-mode relay substitution`, () => {
  let search_optimade_structures: typeof import('../optimade').search_optimade_structures

  const ok_response = () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [], meta: { data_returned: 0 } }), {
        status: 200,
        headers: { 'Content-Type': `application/vnd.api+json` },
      }),
    )

  beforeEach(async () => {
    ;(globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__ = true
    vi.resetModules()
    ;({ search_optimade_structures } = await import(`../optimade`))
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.restoreAllMocks()
  })

  const mp_provider = [
    {
      id: `mp`,
      type: `links` as const,
      attributes: { name: `MP`, base_url: `https://optimade.materialsproject.org` },
    },
  ]
  const alex_provider = [
    {
      id: `alexandria`,
      type: `links` as const,
      attributes: { name: `Alexandria`, base_url: `https://alexandria.icams.rub.de/pbe` },
    },
  ]

  it(`routes MP search through the relay URL`, async () => {
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(ok_response)
    await search_optimade_structures(`mp`, mp_provider, { limit: 5 })
    expect(spy).toHaveBeenCalled()
    const called_url = String(spy.mock.calls[0][0])
    expect(called_url.startsWith(relay_url(`https://optimade.materialsproject.org`).split(`?`)[0])).toBe(true)
    expect(called_url).toContain(encodeURIComponent(`https://optimade.materialsproject.org`))
  })

  it(`fetches an open provider (alexandria) directly, not via relay`, async () => {
    const spy = vi.spyOn(globalThis, `fetch`).mockImplementation(ok_response)
    await search_optimade_structures(`alexandria`, alex_provider, { limit: 5 })
    expect(spy).toHaveBeenCalled()
    const called_url = String(spy.mock.calls[0][0])
    expect(called_url.startsWith(`https://alexandria.icams.rub.de/pbe/v1/structures`)).toBe(true)
    expect(called_url).not.toContain(`catgo-cors-relay`)
  })
})
