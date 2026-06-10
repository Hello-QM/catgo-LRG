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
