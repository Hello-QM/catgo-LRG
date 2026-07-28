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

describe(`Materials Project primary REST search`, () => {
  afterEach(async () => {
    const { set_mp_api_key } = await import(`../materials-project`)
    set_mp_api_key(``)
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it(`uses the MP summary API instead of OPTIMADE when an API key is configured`, async () => {
    vi.resetModules()
    const { set_mp_api_key } = await import(`../materials-project`)
    set_mp_api_key(`test-key`)

    const fetch_spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(`/mp/search`)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                material_id: `mp-2657`,
                formula_pretty: `TiO2`,
                nsites: 6,
                nelements: 2,
              },
            ],
            meta: { total_doc: 1 },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ data: [], meta: { data_returned: 0, data_available: 0 } }),
        { status: 200 },
      )
    })

    const { search_optimade_structures } = await import(`../optimade`)
    const result = await search_optimade_structures(
      `mp`,
      [{
        id: `mp`,
        type: `links`,
        attributes: {
          name: `Materials Project`,
          base_url: `https://optimade.materialsproject.org`,
        },
      }],
      { formula: `TiO2`, limit: 20, offset: 0 },
    )

    expect(result.structures.map((entry) => entry.id)).toEqual([`mp-2657`])
    expect(fetch_spy).toHaveBeenCalledTimes(1)
    expect(String(fetch_spy.mock.calls[0]?.[0] ?? ``)).toContain(`/mp/search`)
  })

  it(`loads MP geometry from the summary API instead of OPTIMADE`, async () => {
    vi.resetModules()
    const { set_mp_api_key } = await import(`../materials-project`)
    set_mp_api_key(`test-key`)

    const fetch_spy = vi.spyOn(globalThis, `fetch`).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(`/mp/structure/mp-2657`)) {
        return new Response(
          JSON.stringify({
            data: {
              material_id: `mp-2657`,
              formula_pretty: `TiO2`,
              nsites: 2,
              nelements: 2,
              structure: {
                lattice: {
                  matrix: [[4.59, 0, 0], [0, 4.59, 0], [0, 0, 2.96]],
                  pbc: [true, true, true],
                  a: 4.59,
                  b: 4.59,
                  c: 2.96,
                  alpha: 90,
                  beta: 90,
                  gamma: 90,
                  volume: 62.36,
                },
                sites: [
                  {
                    species: [{ element: `Ti`, occu: 1 }],
                    abc: [0, 0, 0],
                    xyz: [0, 0, 0],
                    label: `Ti`,
                    properties: {},
                  },
                  {
                    species: [{ element: `O`, occu: 1 }],
                    abc: [0.5, 0.5, 0.5],
                    xyz: [2.295, 2.295, 1.48],
                    label: `O`,
                    properties: {},
                  },
                ],
                charge: 0,
                properties: {},
              },
            },
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 })
    })

    const { fetch_optimade_structure } = await import(`../optimade`)
    const result = await fetch_optimade_structure(
      `mp-2657`,
      `mp`,
      [{
        id: `mp`,
        type: `links`,
        attributes: {
          name: `Materials Project`,
          base_url: `https://optimade.materialsproject.org`,
        },
      }],
    )

    expect(result).toMatchObject({
      id: `mp-2657`,
      attributes: {
        lattice_vectors: [[4.59, 0, 0], [0, 4.59, 0], [0, 0, 2.96]],
        species_at_sites: [`Ti`, `O`],
      },
    })
    expect(fetch_spy).toHaveBeenCalledTimes(1)
    expect(String(fetch_spy.mock.calls[0]?.[0] ?? ``)).toContain(`/mp/structure/mp-2657`)
  })
})

describe(`OPTIMADE pagination metadata`, () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it(`uses data_available for the total and offset-aware has_more`, async () => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.resetModules()
    vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{
            id: `alex-21`,
            type: `structures`,
            attributes: { chemical_formula_reduced: `TiO2` },
          }],
          meta: { data_returned: 1, data_available: 57 },
        }),
        { status: 200 },
      ),
    )

    const { search_optimade_structures } = await import(`../optimade`)
    const result = await search_optimade_structures(
      `alexandria`,
      [{
        id: `alexandria`,
        type: `links`,
        attributes: {
          name: `Alexandria`,
          base_url: `https://alexandria.icams.rub.de/pbe`,
        },
      }],
      { limit: 20, offset: 20 },
    )

    expect(result.total_count).toBe(57)
    expect(result.has_more).toBe(true)
  })
})

describe(`VS Code structure routing`, () => {
  afterEach(async () => {
    const { set_mp_api_key } = await import(`../materials-project`)
    set_mp_api_key(``)
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it(`routes MPDD structure fetches through the backend instead of the MP endpoint`, async () => {
    vi.resetModules()
    const { set_mp_api_key } = await import(`../materials-project`)
    set_mp_api_key(``)
    const posted: Array<Record<string, unknown>> = []

    const { fetch_optimade_structure, set_vscode_api } = await import(`../optimade`)
    set_vscode_api({
      postMessage(message) {
        const msg = message as Record<string, unknown>
        posted.push(msg)
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent(`message`, {
            data: {
              command: `optimade_fetch_response`,
              request_id: msg.request_id,
              data: {
                data: {
                  id: `mpdd-1`,
                  type: `structures`,
                  attributes: {},
                },
              },
            },
          }))
        })
      },
    })

    const result = await fetch_optimade_structure(
      `mpdd-1`,
      `mpdd`,
      [{
        id: `mpdd`,
        type: `links`,
        attributes: {
          name: `MPDD`,
          base_url: `https://providers.optimade.org/index-metadbs/mpdd`,
        },
      }],
    )

    expect(result?.id).toBe(`mpdd-1`)
    const requested_url = String(posted[0]?.url)
    expect(requested_url).toContain(`/optimade/structure/mpdd/mpdd-1`)
    expect(requested_url).not.toContain(`optimade.materialsproject.org`)
  })

  it(`routes MPDD suggestions through the extension search backend`, async () => {
    vi.resetModules()
    const posted: Array<Record<string, unknown>> = []
    const { fetch_suggested_structures, set_vscode_api } = await import(`../optimade`)
    set_vscode_api({
      postMessage(message) {
        const msg = message as Record<string, unknown>
        posted.push(msg)
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent(`message`, {
            data: {
              command: `optimade_search_response`,
              request_id: msg.request_id,
              data: {
                structures: [{
                  id: `mpdd-1`,
                  type: `structures`,
                  attributes: {},
                }],
                total_count: 1,
                has_more: false,
              },
            },
          }))
        })
      },
    })

    const result = await fetch_suggested_structures(
      `mpdd`,
      [{
        id: `mpdd`,
        type: `links`,
        attributes: {
          name: `MPDD`,
          base_url: `https://providers.optimade.org/index-metadbs/mpdd`,
        },
      }],
      12,
    )

    expect(result.map((entry) => entry.id)).toEqual([`mpdd-1`])
    expect(posted[0]).toMatchObject({
      command: `optimade_search`,
      provider: `mpdd`,
      options: { limit: 12, offset: 0 },
    })
  })
})

// MP moved thermo data into a nested `_mp_stability` dict (keyed by thermo
// type); the flat `_mp_formation_energy_per_atom` / `_mp_energy_above_hull`
// fields now return null. Details extraction and stability sorting must read
// the nested form — and must NOT assign the dict object to numeric fields.
describe(`MP nested _mp_stability extraction + stability sort`, () => {
  const mp_stability = {
    'gga_gga+u': {
      thermo_id: `mp-1_GGA_GGA+U`,
      energy_above_hull: 0.27,
      formation_energy_per_atom: -1.149,
    },
    'gga_gga+u_r2scan': {
      thermo_id: `mp-1_GGA_GGA+U_R2SCAN`,
      energy_above_hull: 0.28,
      formation_energy_per_atom: -1.145,
    },
  }

  it(`extract_provider_details reads hull + formation energy from _mp_stability (gga_gga+u preferred)`, async () => {
    const { extract_provider_details } = await import(`../optimade`)
    const details = extract_provider_details({
      chemical_formula_reduced: `FeO2`,
      _mp_stability: mp_stability,
      _mp_formation_energy_per_atom: null,
      _mp_energy_above_hull: null,
    })
    expect(details.energy_above_hull).toBe(0.27)
    expect(details.formation_energy).toBe(-1.149)
  })

  it(`extract_provider_details never assigns the _mp_stability object to a numeric field`, async () => {
    const { extract_provider_details } = await import(`../optimade`)
    const details = extract_provider_details({ _mp_stability: mp_stability })
    expect(typeof details.energy_above_hull).toBe(`number`)
  })

  it(`falls back to the first thermo entry when gga_gga+u is absent`, async () => {
    const { extract_provider_details } = await import(`../optimade`)
    const details = extract_provider_details({
      _mp_stability: { r2scan: { energy_above_hull: 0.1, formation_energy_per_atom: -2 } },
    })
    expect(details.energy_above_hull).toBe(0.1)
    expect(details.formation_energy).toBe(-2)
  })

  it(`sort_structures_by_stability orders by energy_above_hull ascending, formation energy as tiebreak`, async () => {
    const { sort_structures_by_stability } = await import(`../optimade`)
    const s = (id: string, attrs: Record<string, unknown>) =>
      ({ id, type: `structures`, attributes: attrs }) as never
    const sorted = sort_structures_by_stability([
      s(`high-hull`, { _mp_stability: { 'gga_gga+u': { energy_above_hull: 1.05, formation_energy_per_atom: -0.43 } } }),
      s(`no-data`, { chemical_formula_reduced: `X` }),
      s(`stable`, { _mp_stability: { 'gga_gga+u': { energy_above_hull: 0, formation_energy_per_atom: -1.9 } } }),
      s(`legacy-flat`, { _alexandria_energy_above_hull: 0.1, _alexandria_formation_energy_per_atom: -1.2 }),
      s(`tie-hull-lower-formation`, { _mp_stability: { 'gga_gga+u': { energy_above_hull: 0, formation_energy_per_atom: -2.5 } } }),
    ])
    expect(sorted.map((x: { id: string }) => x.id)).toEqual([
      `tie-hull-lower-formation`,
      `stable`,
      `legacy-flat`,
      `high-hull`,
      `no-data`,
    ])
  })
})

// Cold-start race: on desktop the Python sidecar that serves
// /api/optimade/providers boots a few seconds after the webview. If the user
// opens Search-Database immediately, the first providers fetch is refused at
// the socket level — the dialog then degrades to PubChem-only (the modal injects
// PubChem client-side; the OPTIMADE list needs the backend). fetch_optimade_providers
// must retry the backend instead of giving up on the first failure, and must
// never cache an empty result (so a later open still recovers).
describe(`fetch_optimade_providers cold-start retry`, () => {
  let mod: typeof import('../optimade')

  beforeEach(async () => {
    delete (globalThis as Record<string, unknown>).__CATGO_STATIC_ONLY__
    vi.resetModules()
    vi.useFakeTimers()
    mod = await import(`../optimade`)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const providers_response = (ids: string[]) =>
    new Response(
      JSON.stringify({ data: ids.map((id) => ({ id, type: `links`, attributes: { name: id, base_url: `https://x/${id}` } })) }),
      { status: 200, headers: { 'Content-Type': `application/vnd.api+json` } },
    )

  it(`retries the backend and succeeds when the sidecar comes up late`, async () => {
    let calls = 0
    vi.spyOn(globalThis, `fetch`).mockImplementation(() => {
      calls++
      // First two attempts: sidecar not listening yet (connection refused).
      if (calls < 3) return Promise.reject(new TypeError(`Failed to fetch`))
      return Promise.resolve(providers_response([`mp`, `alexandria`]))
    })

    const promise = mod.fetch_optimade_providers()
    await vi.runAllTimersAsync()
    const result = await promise

    expect(calls).toBe(3)
    expect(result.map((p) => p.id)).toEqual([`mp`, `alexandria`])
  })

  it(`returns an empty, UN-cached list when the backend never comes up`, async () => {
    vi.spyOn(globalThis, `fetch`).mockImplementation(() =>
      Promise.reject(new TypeError(`Failed to fetch`)),
    )

    const promise = mod.fetch_optimade_providers()
    await vi.runAllTimersAsync()
    const first = await promise
    expect(first).toEqual([])

    // Not cached as empty: a subsequent open re-attempts the backend, and now
    // the sidecar is up, so the real list loads (no stale empty cache wins).
    vi.restoreAllMocks()
    vi.spyOn(globalThis, `fetch`).mockImplementation(() =>
      Promise.resolve(providers_response([`mp`])),
    )
    const promise2 = mod.fetch_optimade_providers()
    await vi.runAllTimersAsync()
    const second = await promise2
    expect(second.map((p) => p.id)).toEqual([`mp`])
  })
})
