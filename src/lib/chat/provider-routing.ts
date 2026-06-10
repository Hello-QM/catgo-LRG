import { STATIC_ONLY } from '$lib/api/config'
import { isMobile } from '$lib/api/transport'
import type { ChatConfig } from './types'
import { SDK_PROVIDERS } from './types'

/** Edge CORS relay base URL. Override at build time via VITE_CORS_RELAY_URL;
 *  falls back to the deployed catgo-cors-relay Worker. */
export const RELAY_URL: string =
  (typeof import.meta.env.VITE_CORS_RELAY_URL === `string` &&
    import.meta.env.VITE_CORS_RELAY_URL) ||
  `https://catgo-cors-relay.guangshengliu2021.workers.dev`

/** Hosts known to block browser CORS — fetches to these must go through the relay.
 *  Both Materials Project surfaces (OPTIMADE + the REST API that serves energies/
 *  band gaps) send no Access-Control-Allow-Origin, so they must be relayed. */
const RELAY_HOSTS = new Set<string>([
  `optimade.materialsproject.org`,
  `api.materialsproject.org`,
  // NVIDIA's OpenAI-compatible endpoint does not allow browser CORS for direct
  // CatBot model/test/chat requests, so desktop/web client-direct mode must relay.
  `integrate.api.nvidia.com`,
])

const BACKEND_CHAT_HOSTS = new Set<string>([
  // The public relay does not allow this host. In local/desktop builds, route
  // NVIDIA chat through CatGo's backend OpenAI-compatible proxy instead.
  `integrate.api.nvidia.com`,
])

export function needs_relay(url: string): boolean {
  try {
    return RELAY_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

export function relay_url(url: string): string {
  return `${RELAY_URL}/?url=${encodeURIComponent(url)}`
}

export function normalize_provider_base_url(base_url: string): string {
  const base = base_url.replace(/\/$/, ``)
  for (const suffix of [`/chat/completions`, `/messages`, `/models`]) {
    if (base.toLowerCase().endsWith(suffix)) {
      return base.slice(0, -suffix.length).replace(/\/$/, ``)
    }
  }
  return base
}

export function requires_backend_chat(config: ChatConfig): boolean {
  const base = normalize_provider_base_url(config.base_url || ``)
  if (!base) return false
  try {
    return BACKEND_CHAT_HOSTS.has(new URL(base).host)
  } catch {
    return false
  }
}

/** True when `init` carries an API-key / bearer header that must NEVER transit a
 *  third-party relay (security §8 C). Case-insensitive across Headers/object/array. */
function has_auth_header(init?: RequestInit): boolean {
  if (!init?.headers) return false
  const h = init.headers
  const names: string[] = h instanceof Headers
    ? [...h.keys()]
    : Array.isArray(h)
    ? h.map(([k]) => k)
    : Object.keys(h)
  return names.some((n) => {
    const lower = n.toLowerCase()
    return lower === `authorization` || lower === `x-api-key`
  })
}

/** A fetch wrapper that transparently routes CORS-blocked hosts via the relay. */
export async function relay_fetch(url: string, init?: RequestInit): Promise<Response> {
  // On mobile (Tauri) there is no browser CORS — the native HTTP plugin fetches
  // from Rust, so CORS-blocked sources (Materials Project, the OPTIMADE provider
  // list, any provider that omits Access-Control-Allow-Origin) work DIRECTLY
  // with no relay and no backend. This is why the database showed only PubChem.
  // Key-bearing requests (e.g. Materials Project X-API-KEY) are safe on this
  // path: the native fetch goes straight to the target host, never the relay —
  // which is why this branch must run BEFORE the §8 C guard below (the guard
  // used to come first and broke MP API access on mobile entirely).
  if (isMobile()) {
    try {
      const { fetch: tauriFetch } = await import(`@tauri-apps/plugin-http`)
      return await tauriFetch(url, init)
    } catch (e) {
      console.warn(`[CatGo] tauri http fetch failed, falling back:`, url, e)
      // Plugin unavailable (e.g. plain browser) — fall back to the relay path,
      // which is still protected by the auth-header guard below.
    }
  }
  // SECURITY (§8 C): the relay is a third party. NEVER hand it a request that
  // carries the user's API key. Key-bearing chat requests must use llm_fetch
  // (native, no relay) — this guard is defense-in-depth against an accidental
  // key-bearing relay_fetch caller.
  if (has_auth_header(init) && needs_relay(url)) {
    throw new Error(
      `Refusing to relay a request carrying an Authorization/x-api-key header`,
    )
  }
  return fetch(needs_relay(url) ? relay_url(url) : url, init)
}

/** Key-bearing LLM fetch. On mobile it goes through the Tauri HTTP plugin
 *  (native Rust fetch, no browser CORS) and THROWS on failure — there is NO
 *  relay fallback because the request carries the user's API key and the relay
 *  is a third party (security §8 C). On desktop it is a plain `fetch`. */
export async function llm_fetch(url: string, init?: RequestInit): Promise<Response> {
  if (isMobile()) {
    // No try/relay fallback: surface the error instead of leaking the key.
    const { fetch: tauriFetch } = await import(`@tauri-apps/plugin-http`)
    return tauriFetch(url, init)
  }
  return fetch(url, init)
}

/** True when the tool-calling loop should run in-browser (no backend proxy). */
export function is_client_direct(config: ChatConfig): boolean {
  if (SDK_PROVIDERS.has(config.provider)) return false // SDK agents always backend
  if (!STATIC_ONLY && config.provider === `custom` && config.client_direct !== true) {
    return false
  }
  if (!STATIC_ONLY && requires_backend_chat(config)) return false
  // Built-in non-SDK providers (DeepSeek/Qwen/Kimi/Gemini/Anthropic/ollama) keep
  // their API key client-side, so default to the in-browser tool-calling loop
  // (not only under static deploys) — otherwise CatBot falls back to a
  // text-only backend proxy and can never call CLIENT_TOOLS (validate_hpc_config,
  // get_skill, structure tools). Explicit client_direct:false opts back into
  // the text-only path. Custom providers default to backend in local/desktop
  // builds because third-party OpenAI-compatible gateways often do not allow
  // browser CORS even when their /models and backend test calls succeed.
  return STATIC_ONLY || config.client_direct !== false
}
