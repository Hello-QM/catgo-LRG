import { STATIC_ONLY } from '$lib/api/config'
import type { ChatConfig } from './types'
import { SDK_PROVIDERS } from './types'

/** Edge CORS relay base URL. Override at build time via VITE_CORS_RELAY_URL;
 *  falls back to the deployed catgo-cors-relay Worker. */
export const RELAY_URL: string =
  (typeof import.meta.env.VITE_CORS_RELAY_URL === `string` && import.meta.env.VITE_CORS_RELAY_URL) ||
  `https://catgo-cors-relay.guangshengliu2021.workers.dev`

/** Hosts known to block browser CORS — fetches to these must go through the relay.
 *  Both Materials Project surfaces (OPTIMADE + the REST API that serves energies/
 *  band gaps) send no Access-Control-Allow-Origin, so they must be relayed. */
const RELAY_HOSTS = new Set<string>([
  `optimade.materialsproject.org`,
  `api.materialsproject.org`,
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

/** A fetch wrapper that transparently routes CORS-blocked hosts via the relay. */
export function relay_fetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(needs_relay(url) ? relay_url(url) : url, init)
}

/** True when the tool-calling loop should run in-browser (no backend proxy). */
export function is_client_direct(config: ChatConfig): boolean {
  if (SDK_PROVIDERS.has(config.provider)) return false // SDK agents always backend
  // Non-SDK providers (DeepSeek/Qwen/Kimi/Gemini/Anthropic/custom/ollama) keep
  // their API key client-side, so default to the in-browser tool-calling loop
  // (not only under static deploys) — otherwise CatBot falls back to a
  // text-only backend proxy and can never call CLIENT_TOOLS (validate_hpc_config,
  // get_skill, structure tools). Explicit client_direct:false opts back into
  // the text-only path.
  return STATIC_ONLY || config.client_direct !== false
}
