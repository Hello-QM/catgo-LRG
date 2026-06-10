import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
