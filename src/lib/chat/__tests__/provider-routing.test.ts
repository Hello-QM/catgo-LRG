import { describe, it, expect } from 'vitest'
import { is_client_direct, needs_relay, normalize_provider_base_url, relay_url, RELAY_URL, requires_backend_chat } from '../provider-routing'
import type { ChatConfig } from '../types'

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
