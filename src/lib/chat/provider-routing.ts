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

/** Lowercased header names from a RequestInit, across Headers/object/array forms. */
function header_names(init?: RequestInit): string[] {
  if (!init?.headers) return []
  const h = init.headers
  const names: string[] = h instanceof Headers
    ? [...h.keys()]
    : Array.isArray(h)
    ? h.map(([k]) => k)
    : Object.keys(h)
  return names.map((n) => n.toLowerCase())
}

/** Hosts the relay may forward an X-API-KEY header to. The relay is CatGo's
 *  OWN Cloudflare Worker (workers/cors-relay — target-host allowlisted, fixed
 *  forward-header list), not an arbitrary third party. The Materials Project
 *  key must transit it in the STATIC_ONLY web build because
 *  api.materialsproject.org blocks browser CORS (#147). */
const RELAY_KEY_ALLOWED_HOSTS = new Set<string>([`api.materialsproject.org`])

/** Hosts the relay may forward an Authorization (Bearer) header to. NVIDIA's
 *  OpenAI-compatible endpoint blocks browser CORS, so the web build can only
 *  reach it through the relay — chat/models/test requests included. Keep this
 *  list minimal: every entry sends that provider's key through the (CatGo-
 *  owned) Worker. All other LLM hosts allow browser CORS and stay direct. */
const RELAY_AUTH_ALLOWED_HOSTS = new Set<string>([`integrate.api.nvidia.com`])

/** True when the relay is allowed to carry `url`'s credential headers (the
 *  host is credential-allowlisted for the header type in question). */
function relay_credential_allowed(url: string, init?: RequestInit): boolean {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return false
  }
  const names = header_names(init)
  if (names.includes(`authorization`) && !RELAY_AUTH_ALLOWED_HOSTS.has(host)) {
    return false
  }
  if (names.includes(`x-api-key`) && !RELAY_KEY_ALLOWED_HOSTS.has(host)) {
    return false
  }
  return true
}

/** True when relaying `url` with `init`'s headers would hand the relay a
 *  credential that must not transit it (security §8 C): an Authorization or
 *  X-API-KEY header for a host outside its respective allowlist. */
function refuses_relay(url: string, init?: RequestInit): boolean {
  if (!needs_relay(url)) return false
  const names = header_names(init)
  if (!names.includes(`authorization`) && !names.includes(`x-api-key`)) {
    return false
  }
  return !relay_credential_allowed(url, init)
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
  // SECURITY (§8 C): never hand the relay a credential it must not carry —
  // any Authorization header (LLM keys use llm_fetch: native, no relay), or
  // an X-API-KEY outside the explicit RELAY_KEY_ALLOWED_HOSTS allowlist.
  // This guard is defense-in-depth against an accidental key-bearing caller.
  if (refuses_relay(url, init)) {
    throw new Error(
      `Refusing to relay a request carrying an Authorization/x-api-key header`,
    )
  }
  return fetch(needs_relay(url) ? relay_url(url) : url, init)
}

/** Key-bearing LLM fetch. On mobile it goes through the Tauri HTTP plugin
 *  (native Rust fetch, no browser CORS) and THROWS on failure — there is NO
 *  relay fallback because the request carries the user's API key (security
 *  §8 C). In the browser it is a plain `fetch`, except for CORS-blocked LLM
 *  hosts whose credential the relay is explicitly allowed to carry (NVIDIA,
 *  RELAY_AUTH_ALLOWED_HOSTS) — those are rewritten to the CatGo-owned relay,
 *  which is the only way the web build can reach them at all. */
export async function llm_fetch(url: string, init?: RequestInit): Promise<Response> {
  if (isMobile()) {
    // No try/relay fallback: surface the error instead of leaking the key.
    const { fetch: tauriFetch } = await import(`@tauri-apps/plugin-http`)
    // connectTimeout bounds ONLY the TCP handshake — not the model's response
    // time (the caller's 60s idle watchdog covers that). Without it, a host that
    // is configured but silently unreachable (e.g. an Ollama server that's now
    // offline — the socket sits in SYN_SENT with no RST) hangs each attempt for
    // the full idle timeout, which on iOS reads as the whole app freezing. A LAN
    // handshake is sub-100ms, so 10s is generous and still fails fast on a dead
    // host. (connectTimeout is fixed at 10s for all llm_fetch calls — `init` is
    // a plain RequestInit and carries no connectTimeout to override it.)
    return tauriFetch(url, { connectTimeout: 10_000, ...init })
  }
  if (needs_relay(url) && relay_credential_allowed(url, init)) {
    return fetch(relay_url(url), init)
  }
  return fetch(url, init)
}

/** True when the tool-calling loop should run in-browser (no backend proxy). */
export function is_client_direct(config: ChatConfig): boolean {
  if (SDK_PROVIDERS.has(config.provider)) return false // SDK agents always backend
  // Mobile has NO Python backend, so every non-SDK provider must run in-browser.
  // The native HTTP plugin handles CORS, so even hosts that need the backend
  // proxy on web (e.g. NVIDIA via requires_backend_chat) are reachable direct.
  // Without this, a custom/NVIDIA base URL routes to the absent backend and hangs.
  if (isMobile()) return true
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
