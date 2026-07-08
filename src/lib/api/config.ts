// Centralized backend server URL — injected at build time by vite.config.ts
// so each worktree automatically connects to its own backend port.
// Override: set VITE_SERVER_URL env var or PORT env var.

declare const __CATGO_SERVER_URL__: string
declare const __CATGO_DESKTOP__: boolean
declare const __CATGO_STATIC_ONLY__: boolean

function _default_server_url(): string {
  // Runtime override the backend injects into the served index.html
  // (`globalThis.__CATGO_RUNTIME_SERVER__ = location.origin`), so a
  // backend-served SPA is same-origin and `catgo` / `catgo app` works on ANY
  // port. Read as a DYNAMIC global-property access so the bundler can't fold it
  // away — a `typeof window` guard tree-shakes to the fallback in the SSR build.
  const runtime = (globalThis as Record<string, unknown>).__CATGO_RUNTIME_SERVER__
  if (typeof runtime === `string` && runtime.length > 0) return runtime
  if (typeof __CATGO_SERVER_URL__ !== `undefined` && __CATGO_SERVER_URL__) {
    return __CATGO_SERVER_URL__
  }
  return `http://localhost:8000`
}

export let SERVER_URL: string = _default_server_url()

export let API_BASE = `${SERVER_URL}/api`
export let WS_BASE = SERVER_URL.replace(/^http/, `ws`) + `/api`

/** Override server URL at runtime (used by VS Code extension to set dynamic port). */
export function setServerUrl(url: string): void {
  SERVER_URL = url
  API_BASE = `${url}/api`
  WS_BASE = url.replace(/^http/, `ws`) + `/api`
}

/** True when built for static-only deployment (no Python backend). */
export const STATIC_ONLY: boolean = typeof __CATGO_STATIC_ONLY__ !== `undefined` &&
  __CATGO_STATIC_ONLY__

// In static mode, intercept all fetch requests to the backend and return
// a friendly error instead of making network requests that will fail.
if (STATIC_ONLY && typeof window !== `undefined`) {
  const _original_fetch = window.fetch
  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === `string`
      ? input
      : input instanceof URL
      ? input.href
      : input.url
    if (url.startsWith(SERVER_URL) || url.startsWith(API_BASE)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            detail:
              `This feature requires the CatGo desktop app. Visit github.com/Hello-QM/catgo-LRG to download.`,
          }),
          {
            status: 503,
            statusText: `Service Unavailable`,
            headers: { 'Content-Type': `application/json` },
          },
        ),
      )
    }
    return _original_fetch.call(window, input, init)
  }
}

/** [2026-03] Detect if Python backend is available in desktop mode (desktop:serve).
 * Cached after first check.  Used by project.ts / workflow.ts to bypass stale WASM cache. */
let _backend_state: boolean | null = null
export async function desktop_backend_available(): Promise<boolean> {
  if (STATIC_ONLY) return false
  if (typeof __CATGO_DESKTOP__ === `undefined` || !__CATGO_DESKTOP__) return false
  if (_backend_state !== null) return _backend_state
  try {
    // Liveness probe: hit /health (always present when backend is up).
    // Was /providers, which 404s — that route lives at /api/optimade/providers
    // & /api/chat/providers, so the old probe made desktop_backend_available()
    // always return false even with a healthy backend.
    const resp = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    _backend_state = resp.ok
  } catch {
    _backend_state = false
  }
  return _backend_state
}
