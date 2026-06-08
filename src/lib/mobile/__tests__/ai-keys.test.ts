import { describe, expect, it } from 'vitest'
import { apiKeyId, mobile_chat_providers, redact, validate_base_url } from '../ai-keys'

describe(`apiKeyId`, () => {
  it(`namespaces the key store id per provider`, () => {
    expect(apiKeyId(`anthropic`)).toBe(`llm-apikey:anthropic`)
    expect(apiKeyId(`deepseek`)).toBe(`llm-apikey:deepseek`)
    expect(apiKeyId(`custom`)).toBe(`llm-apikey:custom`)
  })
})

describe(`mobile_chat_providers`, () => {
  it(`excludes every SDK agent provider`, () => {
    const providers = mobile_chat_providers()
    expect(providers).not.toContain(`sdk-claude`)
    expect(providers).not.toContain(`sdk-codex`)
    expect(providers).not.toContain(`sdk-gemini`)
  })

  it(`includes the API-key + local providers`, () => {
    const providers = mobile_chat_providers()
    for (
      const p of [
        `anthropic`,
        `gemini`,
        `deepseek`,
        `qwen`,
        `kimi`,
        `zhipu`,
        `custom`,
        `ollama`,
      ]
    ) {
      expect(providers).toContain(p)
    }
  })
})

describe(`validate_base_url`, () => {
  it(`accepts https remote URLs`, () => {
    expect(validate_base_url(`https://api.example.com/v1`)).toEqual({ ok: true })
  })

  it(`allows http for localhost / LAN hosts`, () => {
    expect(validate_base_url(`http://localhost:11434`).ok).toBe(true)
    expect(validate_base_url(`http://127.0.0.1:11434`).ok).toBe(true)
    expect(validate_base_url(`http://192.168.1.42:11434`).ok).toBe(true)
    expect(validate_base_url(`http://10.0.0.5:8080`).ok).toBe(true)
    expect(validate_base_url(`http://172.16.0.9`).ok).toBe(true)
    expect(validate_base_url(`http://my-box.local:11434`).ok).toBe(true)
  })

  it(`rejects http for remote hosts`, () => {
    const r = validate_base_url(`http://api.example.com/v1`)
    expect(r.ok).toBe(false)
  })

  it(`rejects a non-LAN 172.x host over http`, () => {
    expect(validate_base_url(`http://172.32.0.1`).ok).toBe(false)
  })

  it(`rejects non-URLs and empty input`, () => {
    expect(validate_base_url(``).ok).toBe(false)
    expect(validate_base_url(`not a url`).ok).toBe(false)
    expect(validate_base_url(`ftp://example.com`).ok).toBe(false)
  })
})

describe(`redact`, () => {
  it(`masks Bearer tokens`, () => {
    expect(redact(`Authorization: Bearer sk-ant-abc123XYZ`)).not.toContain(`abc123XYZ`)
    expect(redact(`Bearer sk-12345`)).toBe(`Bearer ***`)
  })

  it(`masks sk- style keys anywhere in the string`, () => {
    const out = redact(`failed with key sk-proj-deadbeef in body`)
    expect(out).not.toContain(`deadbeef`)
    expect(out).toContain(`sk-***`)
  })

  it(`masks x-api-key header values`, () => {
    const out = redact(`x-api-key: super-secret-value-123`)
    expect(out).not.toContain(`super-secret-value-123`)
    expect(out).toContain(`x-api-key: ***`)
  })

  it(`leaves non-secret text untouched`, () => {
    expect(redact(`Provider error 429: rate limited`)).toBe(
      `Provider error 429: rate limited`,
    )
  })
})
