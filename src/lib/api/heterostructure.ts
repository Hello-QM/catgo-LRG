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

export type HeterostructureMode = `bulk` | `slab` | `intermat` | `lateral` | `grid_scan`

export interface HeterostructureSearchParams {
  mode?: HeterostructureMode
  substrate_miller?: [number, number, number]
  film_miller?: [number, number, number]
  max_area?: number
  max_area_ratio_tol?: number
  max_length_tol?: number
  max_angle_tol?: number
  max_results?: number
}

export interface HeterostructureMatch {
  match_id: number
  match_area: number
  film_miller: [number, number, number]
  substrate_miller: [number, number, number]
  film_transformation: number[][]
  substrate_transformation: number[][]
  film_sl_vectors: number[][]
  substrate_sl_vectors: number[][]
  strain: number
  n_atoms_substrate: number
  n_atoms_film: number
}

export interface HeterostructureTermination {
  film_termination: string
  substrate_termination: string
  label: string
}

export interface HeterostructureSearchResult {
  matches: HeterostructureMatch[]
  terminations: HeterostructureTermination[]
  n_matches: number
  n_terminations: number
  message: string
}

export interface HeterostructureBuildParams {
  gap?: number
  vacuum?: number
  substrate_thickness?: number
  film_thickness?: number
  twist_angle?: number
}

export interface HeterostructureBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  n_atoms_substrate: number
  n_atoms_film: number
  match_area: number
  strain: number
  message: string
}

export async function buildHeterostructureManual(
  substrate: PymatgenStructure,
  film: PymatgenStructure,
  substrate_transform: number[][],
  film_transform: number[][],
  gap = 2.0,
  vacuum = 20.0,
  twist_angle = 0.0,
  server_url = `http://localhost:8000`,
): Promise<HeterostructureBuildResult> {
  const response = await fetch(`${server_url}/api/heterostructure/build-manual`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ substrate, film, substrate_transform, film_transform, gap, vacuum, twist_angle }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error_data.detail || `Server error: ${response.status}`)
  }

  return response.json()
}

export async function searchHeterostructureMatches(
  substrate: PymatgenStructure,
  film: PymatgenStructure,
  params: HeterostructureSearchParams = {},
  server_url = SERVER_URL,
): Promise<HeterostructureSearchResult> {
  const response = await fetch(`${server_url}/api/heterostructure/search`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ substrate, film, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

export async function buildHeterostructure(
  substrate: PymatgenStructure,
  film: PymatgenStructure,
  match: HeterostructureMatch,
  termination_index: number = 0,
  params: HeterostructureBuildParams = {},
  search_params: HeterostructureSearchParams = {},
  server_url = SERVER_URL,
): Promise<HeterostructureBuildResult> {
  const response = await fetch(`${server_url}/api/heterostructure/build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ substrate, film, match, termination_index, params, search_params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

// ---------------------------------------------------------------------------
// Intermat mode
// ---------------------------------------------------------------------------

export interface IntermatBuildParams {
  substrate_miller?: [number, number, number]
  film_miller?: [number, number, number]
  substrate_thickness?: number
  film_thickness?: number
  separation?: number
  vacuum?: number
  max_area?: number
  ltol?: number
  atol?: number
  max_area_ratio_tol?: number
  apply_strain?: boolean
  disp_intvl?: number
}

export interface IntermatBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  n_atoms_substrate: number
  n_atoms_film: number
  match_area: number
  strain: number
  mismatch_u: number
  mismatch_v: number
  mismatch_angle: number
  area_substrate: number
  area_film: number
  message: string
}

export async function buildHeterostructureIntermat(
  substrate: PymatgenStructure,
  film: PymatgenStructure,
  params: IntermatBuildParams = {},
  server_url = `http://localhost:8000`,
): Promise<IntermatBuildResult> {
  const response = await fetch(`${server_url}/api/heterostructure/build-intermat`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ substrate, film, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error_data.detail || `Server error: ${response.status}`)
  }

  return response.json()
}

// ---------------------------------------------------------------------------
// Registry candidates (batch build)
// ---------------------------------------------------------------------------

export async function downloadRegistryCandidates(
  substrate: PymatgenStructure,
  film: PymatgenStructure,
  match: HeterostructureMatch,
  n_shift: number = 0,
  gap: number = 2.0,
  vacuum: number = 20.0,
  fmt: string = `cif`,
  search_params: HeterostructureSearchParams = {},
  step_angstrom: number = 0.0,
  target_z: number = 0.0,
  server_url = SERVER_URL,
): Promise<void> {
  const response = await fetch(`${server_url}/api/heterostructure/batch-build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ substrate, film, match, n_shift, gap, vacuum, fmt, search_params, step_angstrom, target_z }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  // Download the zip blob
  const candidate_count = response.headers.get(`X-Candidate-Count`) ?? `?`
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement(`a`)
  a.href = url
  a.download = `registry_candidates_${candidate_count}.zip`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Lateral (in-plane) mode
// ---------------------------------------------------------------------------

export interface LateralSearchParams {
  interface_axis?: number // 0=a, 1=b
  max_length?: number
  max_strain?: number
  max_results?: number
}

export interface LateralMatch {
  match_id: number
  n1: number
  n2: number
  edge_length_A: number
  edge_length_B: number
  strain_percent: number
  n_atoms_A: number
  n_atoms_B: number
}

export interface LateralSearchResult {
  matches: LateralMatch[]
  n_matches: number
  message: string
}

export interface LateralBuildParams {
  width_A?: number
  width_B?: number
  buffer?: number
  vacuum?: number
}

export interface LateralBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  n_atoms_A: number
  n_atoms_B: number
  interface_length: number
  strain: number
  message: string
}

export async function searchLateralMatches(
  slab_A: PymatgenStructure,
  slab_B: PymatgenStructure,
  params: LateralSearchParams = {},
  server_url = `http://localhost:8000`,
): Promise<LateralSearchResult> {
  const response = await fetch(`${server_url}/api/heterostructure/search-lateral`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ slab_A, slab_B, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error_data.detail || `Server error: ${response.status}`)
  }

  return response.json()
}

export async function buildLateralInterface(
  slab_A: PymatgenStructure,
  slab_B: PymatgenStructure,
  match: LateralMatch,
  params: LateralBuildParams = {},
  search_params: LateralSearchParams = {},
  server_url = `http://localhost:8000`,
): Promise<LateralBuildResult> {
  const response = await fetch(`${server_url}/api/heterostructure/build-lateral`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ slab_A, slab_B, match, params, search_params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error_data.detail || `Server error: ${response.status}`)
  }

  return response.json()
}


// ---------------------------------------------------------------------------
// Grid Scan mode — symmetry-reduced lateral shift exhaustive search
// ---------------------------------------------------------------------------

export interface GridScanParams {
  n_grid_x?: number
  n_grid_y?: number
  symprec?: number
}

export interface GridScanShiftEntry {
  shift_frac: [number, number]
  shift_cart: [number, number, number]
  structure: PymatgenStructure
  n_atoms: number
  label: string
}

export interface GridScanResult {
  entries: GridScanShiftEntry[]
  n_total_grid: number
  n_irreducible: number
  n_symmetry_ops: number
  reduction_ratio: number
  structures: PymatgenStructure[]
  labels: string[]
  message: string
}

export async function gridScanHeterostructure(
  heterostructure: PymatgenStructure,
  film: PymatgenStructure,
  n_atoms_substrate: number,
  params: GridScanParams = {},
  server_url = SERVER_URL,
): Promise<GridScanResult> {
  const response = await fetch(`${server_url}/api/heterostructure/grid-scan`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ heterostructure, film, n_atoms_substrate, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}
