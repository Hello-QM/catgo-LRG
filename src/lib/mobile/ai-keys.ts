/**
 * Mobile AI-key storage + helpers.
 *
 * Wraps the native encrypted key store (transport.keyStore / keyLoad) so the
 * user-supplied LLM API key is persisted AES-256-GCM at rest, never in
 * localStorage. One stored key per provider id so switching providers recalls
 * the right key. See docs/developer/mobile-ai-chat-design.md §5, §8.
 */

import { transport } from '$lib/api/transport'
import type { LLMProvider } from '$lib/chat/types'
import { SDK_PROVIDERS } from '$lib/chat/types'

/** Opaque key-store id for a provider's API key (kept distinct from SSH keys,
 *  which use host:port:username ids). */
export function apiKeyId(provider: LLMProvider): string {
  return `llm-apikey:${provider}`
}

/** Persist a provider's API key in the native encrypted store. */
export async function saveApiKey(provider: LLMProvider, key: string): Promise<void> {
  await transport.keyStore(apiKeyId(provider), key)
}

/** Load a provider's API key, or null if none stored. */
export async function loadApiKey(provider: LLMProvider): Promise<string | null> {
  return transport.keyLoad(apiKeyId(provider))
}

/** The full LLMProvider union minus SDK_PROVIDERS. Listed as a literal so the
 *  set is deterministic; the runtime SDK_PROVIDERS filter keeps it honest if a
 *  provider id is ever recategorised. (LLMProvider is a compile-time-only union,
 *  so it cannot be enumerated reflectively.) */
const ALL_PROVIDERS: LLMProvider[] = [
  `sdk-claude`,
  `sdk-codex`,
  `sdk-gemini`,
  `deepseek`,
  `qwen`,
  `kimi`,
  `zhipu`,
  `gemini`,
  `anthropic`,
  `custom`,
  `ollama`,
]

/** API-key providers selectable in the mobile chat (no backend → no SDK agents). */
export function mobile_chat_providers(): LLMProvider[] {
  return ALL_PROVIDERS.filter((p) => !SDK_PROVIDERS.has(p))
}

/** Hosts/IPs we treat as loopback or private-LAN, where http:// is acceptable
 *  (the key never leaves the local network). RFC1918 + loopback + .local mDNS. */
function is_local_host(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === `localhost` || h === `127.0.0.1` || h === `::1` || h === `[::1]`) return true
  if (h.endsWith(`.local`)) return true // mDNS / Bonjour LAN names
  if (h.startsWith(`192.168.`)) return true // RFC1918 /16
  if (h.startsWith(`10.`)) return true // RFC1918 /8
  // RFC1918 172.16.0.0 – 172.31.255.255
  const m = h.match(/^172\.(\d{1,3})\./)
  if (m) {
    const oct = Number(m[1])
    if (oct >= 16 && oct <= 31) return true
  }
  return false
}

/** Validate a custom/ollama base URL BEFORE the key is ever sent (§8 H).
 *  Requires https:// for non-loopback/non-LAN hosts; allows http only locally;
 *  rejects anything that is not a parseable http(s) URL. */
export function validate_base_url(
  url: string,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = url.trim()
  if (!trimmed) return { ok: false, reason: `Base URL is required` }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: `Not a valid URL` }
  }
  if (parsed.protocol !== `https:` && parsed.protocol !== `http:`) {
    return { ok: false, reason: `URL must use http:// or https://` }
  }
  if (parsed.protocol === `http:` && !is_local_host(parsed.hostname)) {
    return {
      ok: false,
      reason: `http:// is only allowed for localhost/LAN hosts — use https:// for remote`,
    }
  }
  return { ok: true }
}

// `redact()` lives in the shared chat utils (message-utils) so both the mobile
// display layer and the shared client-llm error path can mask secrets at the
// source. Re-exported here so existing mobile imports keep working (§8 M).
export { redact } from '$lib/chat/message-utils'
