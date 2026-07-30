import { afterEach, describe, expect, it, vi } from 'vitest'
import * as materials_project from '../materials-project'
import { search_mp_structures, set_mp_api_key, validate_mp_api_key } from '../materials-project'

// Controllable isMobile + native-fetch mocks (same pattern as provider-routing tests).
const mobile_flag = vi.hoisted(() => ({ value: false }))
const tauri_fetch_mock = vi.hoisted(() => vi.fn())
vi.mock('$lib/api/transport', async (importOriginal) => {
  const orig = await importOriginal<typeof import('$lib/api/transport')>()
  return { ...orig, isMobile: () => mobile_flag.value }
})
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauri_fetch_mock }))

describe(`materials-project mobile gating`, () => {
  afterEach(() => {
    mobile_flag.value = false
    tauri_fetch_mock.mockReset()
    set_mp_api_key(``)
    vi.unstubAllGlobals()
  })

  // Regression: local Android/iOS dev builds run with STATIC_ONLY=false, so the
  // old `vscode_api || STATIC_ONLY` gate sent mobile down the backend-proxy
  // branch (localhost:8000 — unreachable on a phone). Mobile must take the
  // direct-API branch like optimade.ts does (STATIC_ONLY || isMobile()).
  it(`validate_mp_api_key on mobile hits the MP API directly, not the backend proxy`, async () => {
    mobile_flag.value = true
    tauri_fetch_mock.mockResolvedValue(new Response(`{"data":[]}`, { status: 200 }))
    const ok = await validate_mp_api_key(`test-key`)
    expect(ok).toBe(true)
    const url = String(tauri_fetch_mock.mock.calls[0]?.[0] ?? ``)
    expect(url).toMatch(/^https:\/\/api\.materialsproject\.org\//)
  })

  it(`validate_mp_api_key on mobile returns false when MP rejects the key`, async () => {
    mobile_flag.value = true
    tauri_fetch_mock.mockResolvedValue(new Response(`{}`, { status: 401, statusText: `Unauthorized` }))
    const ok = await validate_mp_api_key(`bad-key`)
    expect(ok).toBe(false)
  })

  it(`search_mp_structures on mobile queries the MP API directly`, async () => {
    mobile_flag.value = true
    set_mp_api_key(`test-key`)
    tauri_fetch_mock.mockResolvedValue(
      new Response(`{"data":[{"material_id":"mp-1"}]}`, { status: 200 }),
    )
    const results = await search_mp_structures([`Fe`, `O`], undefined, 5)
    expect(results).toHaveLength(1)
    const url = String(tauri_fetch_mock.mock.calls[0]?.[0] ?? ``)
    expect(url).toMatch(/^https:\/\/api\.materialsproject\.org\/materials\/summary/)
    expect(url).toContain(`elements=Fe%2CO`)
  })

  it(`requests structure geometry when loading one MP material`, async () => {
    mobile_flag.value = true
    set_mp_api_key(`test-key`)
    tauri_fetch_mock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              material_id: `mp-2657`,
              formula_pretty: `TiO2`,
              nsites: 6,
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
                sites: [],
                charge: 0,
                properties: {},
              },
            },
          ],
        }),
        { status: 200 },
      ),
    )

    const result = await materials_project.get_mp_structure_summary(`mp-2657`)

    expect(result?.material_id).toBe(`mp-2657`)
    const url = new URL(String(tauri_fetch_mock.mock.calls[0]?.[0] ?? ``))
    expect(url.pathname).toBe(`/materials/summary/`)
    expect(url.searchParams.get(`material_ids`)).toBe(`mp-2657`)
    expect(url.searchParams.get(`_limit`)).toBe(`1`)
    const fields = url.searchParams.get(`_fields`)?.split(`,`) ?? []
    expect(fields).toContain(`structure`)
  })

  it(`uses MP REST nelements bounds for an exact element set on mobile`, async () => {
    mobile_flag.value = true
    set_mp_api_key(`test-key`)
    tauri_fetch_mock.mockResolvedValue(
      new Response(JSON.stringify({ data: [], meta: { total_doc: 0 } }), { status: 200 }),
    )

    await materials_project.search_mp_structures_page({
      elements: [`Ti`, `O`],
      num_elements: 2,
      limit: 20,
      offset: 0,
    })

    const url = new URL(String(tauri_fetch_mock.mock.calls[0]?.[0] ?? ``))
    expect(url.searchParams.get(`nelements_min`)).toBe(`2`)
    expect(url.searchParams.get(`nelements_max`)).toBe(`2`)
    expect(url.searchParams.has(`num_elements`)).toBe(false)
  })

  it(`desktop (non-mobile, non-static) still uses the backend proxy`, async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(`{"valid":true}`, { status: 200 }),
    )
    vi.stubGlobal(`fetch`, fetch_mock)
    const ok = await validate_mp_api_key(`test-key`)
    expect(ok).toBe(true)
    const url = String(fetch_mock.mock.calls[0]?.[0] ?? ``)
    expect(url).toContain(`/mp/validate-key`)
    expect(tauri_fetch_mock).not.toHaveBeenCalled()
  })

  it(`searches an exact element set on the requested MP result page`, async () => {
    set_mp_api_key(`test-key`)
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ material_id: `mp-2657`, formula_pretty: `TiO2`, nsites: 6, nelements: 2 }],
          meta: { total_doc: 37 },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal(`fetch`, fetch_mock)

    const search_page = (
      materials_project as typeof materials_project & {
        search_mp_structures_page: (options: {
          elements: string[]
          num_elements: number
          limit: number
          offset: number
        }) => Promise<{
          structures: Array<{ material_id: string }>
          total_count?: number
          has_more: boolean
        }>
      }
    ).search_mp_structures_page

    const result = await search_page({
      elements: [`Ti`, `O`],
      num_elements: 2,
      limit: 20,
      offset: 20,
    })

    const request = fetch_mock.mock.calls[0]
    expect(String(request?.[0] ?? ``)).toContain(`/mp/search`)
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      elements: [`Ti`, `O`],
      formula: null,
      material_ids: null,
      num_elements: 2,
      limit: 20,
      offset: 20,
    })
    expect(result.structures.map((entry) => entry.material_id)).toEqual([`mp-2657`])
    expect(result.total_count).toBe(37)
    expect(result.has_more).toBe(true)
  })

  it(`maps an MP summary into the structure-card contract`, () => {
    const to_optimade = (
      materials_project as typeof materials_project & {
        mp_summary_to_optimade_structure: (
          summary: materials_project.MPSummaryData,
        ) => {
          id: string
          type: string
          attributes: Record<string, unknown>
        }
      }
    ).mp_summary_to_optimade_structure

    const mapped = to_optimade({
      material_id: `mp-2657`,
      formula_pretty: `TiO2`,
      nsites: 6,
      nelements: 2,
      symmetry: { crystal_system: `Tetragonal`, symbol: `P4₂/mnm`, number: 136 },
      energy_above_hull: 0,
      formation_energy_per_atom: -3.45,
      band_gap: 1.8,
      is_stable: true,
      is_metal: false,
      ordering: `NM`,
      has_props: { dos: true, bandstructure: true },
    })

    expect(mapped.id).toBe(`mp-2657`)
    expect(mapped.type).toBe(`structures`)
    expect(mapped.attributes).toMatchObject({
      chemical_formula_descriptive: `TiO2`,
      chemical_formula_reduced: `TiO2`,
      nsites: 6,
      nelements: 2,
      _mp_crystal_system: `Tetragonal`,
      _mp_spacegroup_symbol: `P4₂/mnm`,
      _mp_spacegroup_number: 136,
      _mp_energy_above_hull: 0,
      _mp_formation_energy_per_atom: -3.45,
      _mp_band_gap: 1.8,
      _mp_is_stable: true,
      _mp_is_metal: false,
      _mp_ordering: `NM`,
      _mp_has_props: { dos: true, bandstructure: true },
    })
  })

  it(`maps MP structure geometry so import does not call OPTIMADE`, () => {
    const mapped = materials_project.mp_summary_to_optimade_structure({
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
    })

    expect(mapped.attributes).toMatchObject({
      dimension_types: [1, 1, 1],
      nperiodic_dimensions: 3,
      lattice_vectors: [[4.59, 0, 0], [0, 4.59, 0], [0, 0, 2.96]],
      cartesian_site_positions: [[0, 0, 0], [2.295, 2.295, 1.48]],
      species_at_sites: [`Ti`, `O`],
    })
  })

  it(`returns MP REST search results in the shared database-search shape`, async () => {
    set_mp_api_key(`test-key`)
    vi.stubGlobal(
      `fetch`,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                material_id: `mp-2657`,
                formula_pretty: `TiO2`,
                nsites: 6,
                nelements: 2,
                energy_above_hull: 0,
              },
            ],
            meta: { total_doc: 1 },
          }),
          { status: 200 },
        ),
      ),
    )

    const search_as_optimade = (
      materials_project as typeof materials_project & {
        search_mp_structures_as_optimade: (
          options: materials_project.MPSearchOptions,
        ) => Promise<{
          structures: Array<{ id: string; attributes: Record<string, unknown> }>
          total_count?: number
          has_more: boolean
        }>
      }
    ).search_mp_structures_as_optimade

    const result = await search_as_optimade({ formula: `TiO2`, limit: 20, offset: 0 })

    expect(result.structures).toHaveLength(1)
    expect(result.structures[0]).toMatchObject({
      id: `mp-2657`,
      attributes: {
        chemical_formula_descriptive: `TiO2`,
        _mp_energy_above_hull: 0,
      },
    })
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
  })
})
