import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL } from './config'

export type StrainLayer = `top` | `bottom` | `both`

export interface MoireLayerInput {
  structure?: PymatgenStructure
  lattice_vectors?: [number, number][]
  elements?: string[]
  basis_coords?: [number, number][]
  celldm?: number[]
}

export interface MoireAngleSearchParams {
  angle_min?: number
  angle_max?: number
  angle_step?: number
  max_index?: number
  mismatch_threshold?: number
  max_atoms?: number
  strain_layer?: StrainLayer
  apply_strain?: boolean
  max_strain_percent?: number
  deep_search?: boolean
  deep_search_range?: number
  deep_search_step?: number
  final_mismatch_threshold?: number
  fix_angle?: boolean
  fixed_angle_value?: number
  max_results?: number
}

export interface MoireCandidate {
  angle: number
  m: number
  n: number
  p: number
  q: number
  m2: number
  n2: number
  p2: number
  q2: number
  mismatch: number
  n_atoms: number
  area_ratio: number
  strain_percent: number | null
  strain_tensor: number[][] | null
}

export interface MoireAngleSearchResult {
  candidates: MoireCandidate[]
  n_candidates: number
  angle_range: [number, number]
  message: string
}

export interface MoireBuildParams {
  translate_z?: number
  vacuum?: number
  z_a?: number
}

export interface MoireBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  n_atoms_layer_a: number
  n_atoms_layer_b: number
  angle: number
  supercell_area: number
  strain_applied: boolean
  message: string
}

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

export async function searchMoireAngles(
  layer_a: MoireLayerInput,
  layer_b: MoireLayerInput | null = null,
  params: MoireAngleSearchParams = {},
  server_url = SERVER_URL,
): Promise<MoireAngleSearchResult> {
  const response = await fetch(`${server_url}/api/moire/search`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ layer_a, layer_b, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

export async function buildMoireBilayer(
  layer_a: MoireLayerInput,
  candidate: MoireCandidate,
  layer_b: MoireLayerInput | null = null,
  params: MoireBuildParams = {},
  server_url = SERVER_URL,
): Promise<MoireBuildResult> {
  const response = await fetch(`${server_url}/api/moire/build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ layer_a, layer_b, candidate, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}
