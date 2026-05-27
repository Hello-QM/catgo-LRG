import type { PymatgenStructure } from '$lib/structure'
import { SERVER_URL, STATIC_ONLY } from './config'

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

// Client-side (WASM) fallback used when no Python backend is available
// (STATIC_ONLY deployments) or when the backend request fails. Mirrors the
// /api/moire/search endpoint via the ferrox-wasm `moire_search` export.
async function searchMoireAnglesWasm(
  layer_a: MoireLayerInput,
  layer_b: MoireLayerInput | null,
  params: MoireAngleSearchParams,
): Promise<MoireAngleSearchResult> {
  const { wasm_moire_search } = await import('$lib/structure/ferrox-wasm')
  const result = await wasm_moire_search<MoireAngleSearchResult>({ layer_a, layer_b, params })
  if (`error` in result) throw new Error(result.error)
  return result.ok
}

// Client-side (WASM) fallback for /api/moire/build.
async function buildMoireBilayerWasm(
  layer_a: MoireLayerInput,
  candidate: MoireCandidate,
  layer_b: MoireLayerInput | null,
  params: MoireBuildParams,
): Promise<MoireBuildResult> {
  const { wasm_build_moire } = await import('$lib/structure/ferrox-wasm')
  const result = await wasm_build_moire<MoireBuildResult>({ layer_a, layer_b, candidate, params })
  if (`error` in result) throw new Error(result.error)
  return result.ok
}

export async function searchMoireAngles(
  layer_a: MoireLayerInput,
  layer_b: MoireLayerInput | null = null,
  params: MoireAngleSearchParams = {},
  server_url = SERVER_URL,
): Promise<MoireAngleSearchResult> {
  // No Python backend in static deployments — run the WASM path directly.
  if (STATIC_ONLY) {
    return searchMoireAnglesWasm(layer_a, layer_b, params)
  }

  try {
    const response = await fetch(`${server_url}/api/moire/search`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ layer_a, layer_b, params }),
    })

    if (!response.ok) {
      const error_data = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    // Backend unreachable (e.g. desktop FE-only) — fall back to WASM.
    if (err instanceof TypeError) {
      return searchMoireAnglesWasm(layer_a, layer_b, params)
    }
    throw err
  }
}

export async function buildMoireBilayer(
  layer_a: MoireLayerInput,
  candidate: MoireCandidate,
  layer_b: MoireLayerInput | null = null,
  params: MoireBuildParams = {},
  server_url = SERVER_URL,
): Promise<MoireBuildResult> {
  if (STATIC_ONLY) {
    return buildMoireBilayerWasm(layer_a, candidate, layer_b, params)
  }

  try {
    const response = await fetch(`${server_url}/api/moire/build`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ layer_a, layer_b, candidate, params }),
    })

    if (!response.ok) {
      const error_data = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    if (err instanceof TypeError) {
      return buildMoireBilayerWasm(layer_a, candidate, layer_b, params)
    }
    throw err
  }
}
