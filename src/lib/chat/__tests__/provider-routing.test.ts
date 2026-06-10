import { afterEach, describe, expect, it, vi } from 'vitest'
import { is_client_direct, needs_relay, normalize_provider_base_url, relay_fetch, relay_url, RELAY_URL, requires_backend_chat } from '../provider-routing'
import type { ChatConfig } from '../types'

// Controllable isMobile + native-fetch mocks for the mobile relay_fetch path.
const mobile_flag = vi.hoisted(() => ({ value: false }))
const tauri_fetch_mock = vi.hoisted(() => vi.fn())
vi.mock('$lib/api/transport', async (importOriginal) => {
  const orig = await importOriginal<typeof import('$lib/api/transport')>()
  return { ...orig, isMobile: () => mobile_flag.value }
})
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauri_fetch_mock }))

describe(`needs_relay`, () => {
  it(`flags Materials Project OPTIMADE host`, () => {
    expect(needs_relay(`https://optimade.materialsproject.org/v1/structures`)).toBe(true)
  })
  it(`passes open CORS providers through directly`, () => {
    expect(needs_relay(`https://alexandria.icams.rub.de/pbe/v1/structures`)).toBe(false)
    expect(needs_relay(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound`)).toBe(false)
  })
  it(`routes NVIDIA's OpenAI-compatible API through the relay`, () => {
    expect(needs_relay(`https://integrate.api.nvidia.com/v1/models`)).toBe(true)
  })
})

describe(`relay_url`, () => {
  it(`wraps a target URL as a relay query param`, () => {
    const wrapped = relay_url(`https://optimade.materialsproject.org/v1/structures?x=1`)
    expect(wrapped).toBe(`${RELAY_URL}/?url=${encodeURIComponent(`https://optimade.materialsproject.org/v1/structures?x=1`)}`)
  })
})

describe(`normalize_provider_base_url`, () => {
  it(`accepts provider base URLs and trims complete endpoint URLs`, () => {
    expect(normalize_provider_base_url(`https://integrate.api.nvidia.com/v1/`)).toBe(`https://integrate.api.nvidia.com/v1`)
    expect(normalize_provider_base_url(`https://integrate.api.nvidia.com/v1/chat/completions`)).toBe(`https://integrate.api.nvidia.com/v1`)
    expect(normalize_provider_base_url(`https://integrate.api.nvidia.com/v1/models`)).toBe(`https://integrate.api.nvidia.com/v1`)
  })
})

describe(`provider chat routing`, () => {
  const base_config: ChatConfig = {
    provider: `custom`,
    model: `model`,
    temperature: 0.2,
    max_tokens: 1024,
    api_key: `sk-test`,
    base_url: `https://api.example.com/v1`,
    api_format: `openai`,
    fetched_models: {},
    mode: `universal`,
  }

  it(`routes NVIDIA chat through the backend in local/desktop builds`, () => {
    const config = {
      ...base_config,
      base_url: `https://integrate.api.nvidia.com/v1/chat/completions`,
    }
    expect(requires_backend_chat(config)).toBe(true)
    expect(is_client_direct(config)).toBe(false)
  })

  it(`routes ordinary custom OpenAI-compatible providers through the backend by default`, () => {
    expect(requires_backend_chat(base_config)).toBe(false)
    expect(is_client_direct(base_config)).toBe(false)
  })

  it(`keeps built-in OpenAI-compatible providers client-direct by default`, () => {
    const config = {
      ...base_config,
      provider: `deepseek`,
      model: `deepseek-chat`,
      base_url: `https://api.deepseek.com`,
    } satisfies ChatConfig
    expect(requires_backend_chat(config)).toBe(false)
    expect(is_client_direct(config)).toBe(true)
  })
})

describe(`relay_fetch auth-header guard (§8 C)`, () => {
  it(`refuses to relay a request carrying an Authorization header to a relay host`, async () => {
    await expect(
      relay_fetch(`https://optimade.materialsproject.org/v1/structures`, {
        headers: { Authorization: `Bearer secret` },
      }),
    ).rejects.toThrow(/Refusing to relay/)
  })

  it(`refuses an x-api-key header (object + Headers forms) to a relay host`, async () => {
    await expect(
      relay_fetch(`https://api.materialsproject.org/x`, {
        headers: { 'x-api-key': `secret` },
      }),
    ).rejects.toThrow(/Refusing to relay/)
    await expect(
      relay_fetch(`https://api.materialsproject.org/x`, {
        headers: new Headers({ Authorization: `Bearer secret` }),
      }),
    ).rejects.toThrow(/Refusing to relay/)
  })

  describe(`mobile native path`, () => {
    afterEach(() => {
      mobile_flag.value = false
      tauri_fetch_mock.mockReset()
    })

    it(`allows a key-bearing Materials Project request on mobile via native fetch (regression: guard used to fire before the native path and broke MP on mobile)`, async () => {
      mobile_flag.value = true
      tauri_fetch_mock.mockResolvedValue(new Response(`{}`, { status: 200 }))
      const url = `https://api.materialsproject.org/materials/summary/?_limit=1`
      const resp = await relay_fetch(url, { headers: { 'X-API-KEY': `secret` } })
      expect(resp.status).toBe(200)
      // Native fetch got the ORIGINAL url — never the relay.
      expect(tauri_fetch_mock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({ headers: { 'X-API-KEY': `secret` } }),
      )
    })

    it(`still refuses to relay a key when the native plugin is unavailable on mobile`, async () => {
      mobile_flag.value = true
      tauri_fetch_mock.mockRejectedValue(new Error(`plugin missing`))
      await expect(
        relay_fetch(`https://api.materialsproject.org/x`, {
          headers: { 'X-API-KEY': `secret` },
        }),
      ).rejects.toThrow(/Refusing to relay/)
    })
  })
})
