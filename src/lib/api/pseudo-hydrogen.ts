import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL, STATIC_ONLY } from './config'

function format_error_detail(detail: unknown): string {
  if (typeof detail === `string`) return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === `object` && d?.msg) {
          const loc = Array.isArray(d.loc) ? d.loc.join(`.`) : ``
          return loc ? `${d.msg} (${loc})` : d.msg
        }
        return JSON.stringify(d)
      })
      .join(`; `)
  }
  return JSON.stringify(detail)
}

export interface PseudoHydrogenParams {
  passivate_top?: boolean
  passivate_bottom?: boolean
  surface_depth?: number
  bond_length_scale?: number
  cutoff_mult?: number
  selected_indices?: number[] | null
  valence_electrons?: Record<string, number> | null
  bulk_coordination?: Record<string, number> | null
}

export interface PseudoHInfo {
  position: [number, number, number]
  charge: number
  vasp_charge: number
  potcar_name: string
  parent_index: number
  parent_symbol: string
  missing_symbol: string
}

export interface PseudoHydrogenResult {
  structure: PymatgenStructure
  n_pseudo_h: number
  bulk_coordination: Record<string, number>
  valence_used: Record<string, number>
  pseudo_h_list: PseudoHInfo[]
  unique_potcars: string[]
  bond_warnings: string[]
  message: string
}

// Client-side fallback: run passivation entirely in the browser via ferrox-wasm.
// Used in STATIC_ONLY builds (no Python backend) and when the backend fetch fails.
async function passivateSlabWasm(
  slab: PymatgenStructure,
  bulk: PymatgenStructure,
  params?: PseudoHydrogenParams,
): Promise<PseudoHydrogenResult> {
  const { wasm_passivate_slab } = await import('$lib/structure/ferrox-wasm')
  const result = await wasm_passivate_slab(
    slab as unknown as import('$lib/structure/ferrox-wasm').Crystal,
    bulk as unknown as import('$lib/structure/ferrox-wasm').Crystal,
    params as Record<string, unknown> | undefined,
  )
  return result as PseudoHydrogenResult
}

export async function passivateSlab(
  slab: PymatgenStructure,
  bulk: PymatgenStructure,
  params?: PseudoHydrogenParams,
  server_url = SERVER_URL,
): Promise<PseudoHydrogenResult> {
  // STATIC_ONLY builds have no Python backend — go straight to WASM.
  if (STATIC_ONLY) {
    return passivateSlabWasm(slab, bulk, params)
  }

  try {
    const response = await fetch(`${server_url}/api/pseudo-hydrogen/passivate`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ slab, bulk, params }),
    })

    if (!response.ok) {
      const error_data = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
    }

    return response.json()
  } catch (err) {
    // Backend unavailable (network error / connection refused) — fall back to WASM.
    // Re-throw genuine server-side errors (HTTP errors thrown above) only if WASM also fails.
    try {
      return await passivateSlabWasm(slab, bulk, params)
    } catch (wasm_err) {
      throw err instanceof Error ? err : new Error(String(wasm_err))
    }
  }
}
