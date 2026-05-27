// Materials Project API utilities.
// Requires user's API key from https://materialsproject.org/
// Three transports: VSCode extension host proxy, FastAPI backend proxy, and
// (STATIC_ONLY web build) browser-direct via the CORS relay — api.materialsproject.org
// sends no Access-Control-Allow-Origin, so direct browser fetches are blocked.

import { API_BASE as _DEFAULT_API, STATIC_ONLY } from './config'
import { relay_fetch } from '$lib/chat/provider-routing'

// API base URL - same as other API modules
let API_BASE = _DEFAULT_API

/**
 * Configure the API base URL.
 */
export function setMPApiBase(base: string): void {
  API_BASE = base
}

// Local storage key for API key
const MP_API_KEY_STORAGE = `mp_api_key`

/**
 * Get stored Materials Project API key
 */
export function get_mp_api_key(): string | null {
  if (typeof window === `undefined`) return null
  return localStorage.getItem(MP_API_KEY_STORAGE)
}

/**
 * Store Materials Project API key
 */
export function set_mp_api_key(key: string): void {
  if (typeof window === `undefined`) return
  if (key.trim()) {
    localStorage.setItem(MP_API_KEY_STORAGE, key.trim())
  } else {
    localStorage.removeItem(MP_API_KEY_STORAGE)
  }
}

/**
 * Check if API key is configured
 */
export function has_mp_api_key(): boolean {
  return !!get_mp_api_key()
}

// VSCode extension API support - routes API calls through extension host to bypass CSP
let vscode_api: { postMessage: (msg: unknown) => void } | null = null

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}
const pending_requests = new Map<string, PendingRequest>()

/**
 * Set VSCode API for extension context
 */
export function set_vscode_mp_api(api: { postMessage: (msg: unknown) => void }): void {
  vscode_api = api
  if (typeof window !== `undefined`) {
    window.addEventListener(`message`, (event: MessageEvent) => {
      const msg = event.data
      if (msg?.command === `mp_fetch_response` && msg.request_id) {
        const pending = pending_requests.get(msg.request_id)
        if (pending) {
          pending_requests.delete(msg.request_id)
          if (msg.error) {
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg.data)
          }
        }
      }
    })
    console.log(`[Materials Project] VSCode extension proxy initialized`)
  }
}

/**
 * Fetch via VSCode extension host with API key
 */
async function fetch_via_vscode(url: string, api_key?: string): Promise<unknown> {
  if (!vscode_api) {
    throw new Error(`VSCode API not available`)
  }
  const request_id = `mp_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    pending_requests.set(request_id, { resolve, reject })
    vscode_api!.postMessage({ command: `mp_fetch`, request_id, url, api_key })
    setTimeout(() => {
      if (pending_requests.has(request_id)) {
        pending_requests.delete(request_id)
        reject(new Error(`Request timeout for ${url}`))
      }
    }, 30000)
  })
}

/**
 * Context-aware fetch with API key
 */
async function fetch_json_smart(url: string, api_key: string): Promise<unknown> {
  if (vscode_api) {
    try {
      return await fetch_via_vscode(url, api_key)
    } catch (error) {
      console.warn(`[Materials Project] VSCode proxy failed:`, error)
      throw error
    }
  }

  // Web context: relay-aware fetch. api.materialsproject.org is CORS-blocked, so
  // relay_fetch transparently routes it through the edge relay (which forwards the
  // X-API-KEY header). Open hosts/backend-proxy URLs go direct.
  const response = await relay_fetch(url, {
    headers: {
      'Content-Type': `application/json`,
      'X-API-KEY': api_key,
    },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return await response.json()
}

export interface MPSummaryData {
  material_id: string
  formula_pretty: string
  nsites: number
  nelements: number
  symmetry?: {
    crystal_system?: string
    symbol?: string
    number?: number
  }
  energy_above_hull?: number
  formation_energy_per_atom?: number
  band_gap?: number
  is_stable?: boolean
  is_metal?: boolean
}

/**
 * Search Materials Project for structures with full computed properties
 */
export async function search_mp_structures(
  elements?: string[],
  formula?: string,
  limit: number = 20,
  material_ids?: string[],
): Promise<MPSummaryData[]> {
  const api_key = get_mp_api_key()
  if (!api_key) {
    throw new Error(`Materials Project API key not configured`)
  }

  let url: string
  let data: { data?: MPSummaryData[] }

  if (vscode_api || STATIC_ONLY) {
    // Direct Materials Project API call (relay-routed in the web build)
    const params = new URLSearchParams({
      _fields: `material_id,formula_pretty,nsites,nelements,symmetry,energy_above_hull,formation_energy_per_atom,band_gap,is_stable,is_metal`,
      _limit: String(limit),
    })

    if (material_ids) {
      params.set(`material_ids`, material_ids.join(`,`))
    } else if (elements) {
      params.set(`elements`, elements.join(`,`))
    }

    if (formula) {
      params.set(`formula`, formula)
    }

    url = `https://api.materialsproject.org/materials/summary/?${params}`
    data = await fetch_json_smart(url, api_key) as typeof data
  } else {
    // Backend proxy
    const response = await fetch(`${API_BASE}/mp/search`, {
      method: `POST`,
      headers: {
        'Content-Type': `application/json`,
        'X-API-KEY': api_key,
      },
      body: JSON.stringify({
        elements: elements || null,
        formula: formula || null,
        material_ids: material_ids || null,
        limit,
      }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(`Invalid API key. Please check your Materials Project API key.`)
      }
      throw new Error(`Materials Project API error: ${response.status}`)
    }

    data = await response.json()
  }

  return data.data || []
}

/**
 * Get a single structure's summary data from Materials Project
 */
export async function get_mp_structure_summary(material_id: string): Promise<MPSummaryData | null> {
  const api_key = get_mp_api_key()
  if (!api_key) {
    return null
  }

  try {
    let url: string
    let data: { data?: MPSummaryData }

    if (vscode_api || STATIC_ONLY) {
      // Direct API call (relay-routed in the web build)
      const params = new URLSearchParams({
        _fields: `material_id,formula_pretty,nsites,nelements,symmetry,energy_above_hull,formation_energy_per_atom,band_gap,is_stable,is_metal`,
      })
      url = `https://api.materialsproject.org/materials/summary/${material_id}?${params}`
      data = await fetch_json_smart(url, api_key) as typeof data
    } else {
      // Backend proxy
      const response = await fetch(`${API_BASE}/mp/structure/${material_id}`, {
        headers: { 'X-API-KEY': api_key },
      })

      if (!response.ok) return null

      data = await response.json()
    }

    return data.data || null
  } catch (err) {
    console.error(`[MP API] Error fetching ${material_id}:`, err)
    return null
  }
}

/**
 * Validate an API key by making a test request
 */
export async function validate_mp_api_key(key: string): Promise<boolean> {
  try {
    let url: string
    let data: { valid_response?: boolean }

    if (vscode_api) {
      // Direct API call - try the dedicated check endpoint
      url = `https://www.materialsproject.org/rest/v1/api_check`
      data = await fetch_json_smart(url, key) as { valid_response?: boolean }
      if (data.valid_response) {
        return true
      }

      // Fallback: try summary endpoint with limit 1
      url = `https://api.materialsproject.org/materials/summary/?_limit=1`
      await fetch_json_smart(url, key)
      return true // If we got here without error, key is valid
    } else if (STATIC_ONLY) {
      // Web build: validate via the new MP API summary endpoint through the relay
      // (the www.materialsproject.org api_check host is not relay-allowlisted).
      // fetch_json_smart throws on a non-2xx (e.g. 401 invalid key) → caught below.
      url = `https://api.materialsproject.org/materials/summary/?_limit=1`
      await fetch_json_smart(url, key)
      return true
    } else {
      // Backend proxy
      const response = await fetch(`${API_BASE}/mp/validate-key`, {
        headers: { 'X-API-KEY': key },
      })

      if (!response.ok) return false

      data = await response.json()
      return (data as any).valid === true
    }
  } catch (err) {
    console.error(`[MP API] Validation error:`, err)
    return false
  }
}
