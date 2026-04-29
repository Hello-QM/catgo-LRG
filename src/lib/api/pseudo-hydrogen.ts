import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL } from './config'

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

export async function passivateSlab(
  slab: PymatgenStructure,
  bulk: PymatgenStructure,
  params?: PseudoHydrogenParams,
  server_url = SERVER_URL,
): Promise<PseudoHydrogenResult> {
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
}
