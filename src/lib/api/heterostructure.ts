import type { AnyStructure, PymatgenStructure } from '$lib/structure'
import { download } from '$lib/io/fetch'
import {
  structure_to_cif_str,
  structure_to_extxyz_str,
  structure_to_poscar_str,
  structure_to_xyz_str,
} from '$lib/structure/export'
import {
  wasm_build_hetero,
  wasm_build_hetero_bulk,
  wasm_build_hetero_grid_scan,
  wasm_build_hetero_manual,
  wasm_build_hetero_registry,
  wasm_build_lateral,
  wasm_hetero_search,
  wasm_hetero_search_bulk,
  wasm_lateral_search,
} from '$lib/structure/ferrox-wasm'
import { desktop_backend_available, SERVER_URL, STATIC_ONLY } from './config'

declare const __CATGO_DESKTOP__: boolean

/** True when the SLAB-mode heterostructure path must run client-side via WASM
 *  instead of the Python backend.
 *
 *  - STATIC_ONLY build: always WASM (no backend exists).
 *  - Desktop build: WASM only when the bundled backend is NOT live
 *    (desktop_backend_available() probes /health).
 *  - Plain web app: never — keep using the configured SERVER_URL backend.
 *
 *  Only the CORE slab path (search / build / build-manual) is covered by WASM;
 *  bulk mode and the deferred endpoints always use the backend. */
async function slab_use_wasm_path(): Promise<boolean> {
  if (STATIC_ONLY) return true
  if (typeof __CATGO_DESKTOP__ !== `undefined` && __CATGO_DESKTOP__) {
    try {
      return !(await desktop_backend_available())
    } catch {
      return true
    }
  }
  return false
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
  xy_shift: [number, number] = [0, 0],
  server_url = SERVER_URL,
): Promise<HeterostructureBuildResult> {
  // build-manual is always slab mode. Use the client-side WASM path when no
  // backend is available. (twist_angle is not yet supported by the WASM path;
  // it is ignored there, matching the manual build's default of 0.0.)
  if (await slab_use_wasm_path()) {
    const result = await wasm_build_hetero_manual(
      substrate as never,
      film as never,
      substrate_transform,
      film_transform,
      gap,
      vacuum,
      xy_shift,
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as HeterostructureBuildResult
  }

  // NOTE: the backend `/build-manual` model does not (yet) accept an xy_shift
  // field, so it is only applied on the client-side WASM path above. The
  // backend body is left unchanged to preserve its existing behavior.
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
  // Client-side SLAB path (no Python backend). Only slab mode is supported by
  // WASM; bulk mode falls through to the backend below.
  if (params.mode === `slab` && (await slab_use_wasm_path())) {
    const result = await wasm_hetero_search(
      substrate as never,
      film as never,
      {
        max_area: params.max_area,
        max_area_ratio_tol: params.max_area_ratio_tol,
        max_length_tol: params.max_length_tol,
        max_angle_tol: params.max_angle_tol,
        max_results: params.max_results,
      },
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as HeterostructureSearchResult
  }

  // Client-side BULK path: cut surface slabs from the bulk crystals (Miller
  // index), then ZSL-match. Search is thickness-independent (the surface a/b
  // cell depends only on the Miller index), so a small fixed slab thickness is
  // used here; the build step applies the real thickness.
  if (params.mode === `bulk` && (await slab_use_wasm_path())) {
    const result = await wasm_hetero_search_bulk(
      substrate as never,
      film as never,
      params.substrate_miller ?? [0, 0, 1],
      params.film_miller ?? [0, 0, 1],
      3,
      3,
      0,
      0,
      {
        max_area: params.max_area,
        max_area_ratio_tol: params.max_area_ratio_tol,
        max_length_tol: params.max_length_tol,
        max_angle_tol: params.max_angle_tol,
        max_results: params.max_results,
      },
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as HeterostructureSearchResult
  }

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
  // Client-side SLAB path. match.match_id is the generation-order index that
  // the WASM build_hetero expects (same contract as the backend slab build).
  if (search_params.mode === `slab` && (await slab_use_wasm_path())) {
    const result = await wasm_build_hetero(
      substrate as never,
      film as never,
      match.match_id,
      params.gap ?? 2.0,
      params.vacuum ?? 20.0,
      params.twist_angle ?? 0.0,
      {
        max_area: search_params.max_area,
        max_area_ratio_tol: search_params.max_area_ratio_tol,
        max_length_tol: search_params.max_length_tol,
        max_angle_tol: search_params.max_angle_tol,
        max_results: search_params.max_results,
      },
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as HeterostructureBuildResult
  }

  // Client-side BULK path: cut slabs from the two bulk crystals (Miller +
  // thickness in layers + default termination) and build the chosen match.
  if (search_params.mode === `bulk` && (await slab_use_wasm_path())) {
    const result = await wasm_build_hetero_bulk(
      substrate as never,
      film as never,
      search_params.substrate_miller ?? [0, 0, 1],
      search_params.film_miller ?? [0, 0, 1],
      params.substrate_thickness ?? 3,
      params.film_thickness ?? 3,
      0,
      0,
      match.match_id,
      params.gap ?? 2.0,
      params.vacuum ?? 20.0,
      params.twist_angle ?? 0.0,
      {
        max_area: search_params.max_area,
        max_area_ratio_tol: search_params.max_area_ratio_tol,
        max_length_tol: search_params.max_length_tol,
        max_angle_tol: search_params.max_angle_tol,
        max_results: search_params.max_results,
      },
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as HeterostructureBuildResult
  }

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

/** Serialize a structure to the requested format string, matching the backend
 *  `Structure.to(fmt=...)` used by `/batch-build` (cif / poscar / xyz / extxyz). */
function serialize_structure(structure: PymatgenStructure, fmt: string): string {
  const s = structure as unknown as AnyStructure
  switch (fmt.toLowerCase()) {
    case `poscar`:
      return structure_to_poscar_str(s)
    case `xyz`:
      return structure_to_xyz_str(s)
    case `extxyz`:
      return structure_to_extxyz_str(s)
    case `cif`:
    default:
      return structure_to_cif_str(s)
  }
}

/** Trigger a download of the registry-candidates Blob under the given filename. */
function trigger_download(blob: Blob, filename: string): void {
  download(blob, filename, `application/zip`)
}

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
  // Client-side SLAB path: build candidates in-browser and assemble the same
  // zip archive (one structure file per candidate + manifest.json) the backend
  // `/batch-build` returns, then trigger the download. Matches the existing
  // contract / UX exactly.
  if (await slab_use_wasm_path()) {
    const result = await wasm_build_hetero_registry(
      substrate as never,
      film as never,
      match.match_id,
      n_shift,
      gap,
      vacuum,
      step_angstrom,
      target_z,
      {
        max_area: search_params.max_area,
        max_area_ratio_tol: search_params.max_area_ratio_tol,
        max_length_tol: search_params.max_length_tol,
        max_angle_tol: search_params.max_angle_tol,
        max_results: search_params.max_results,
      },
    )
    if (`error` in result) throw new Error(result.error)
    const { candidates } = result.ok as {
      candidates: {
        structure: PymatgenStructure
        shift_a: number
        shift_b: number
        label: string
        n_atoms: number
        match_area: number
        strain: number
      }[]
    }

    const file_ext = ({ cif: `.cif`, poscar: `.vasp`, xyz: `.xyz`, extxyz: `.extxyz` } as Record<
      string,
      string
    >)[fmt.toLowerCase()] ?? `.cif`

    const JSZip = (await import(`jszip`)).default
    const zip = new JSZip()
    const manifest: {
      filename: string
      shift_a: number
      shift_b: number
      n_atoms: number
      match_area: number
      strain: number
    }[] = []
    for (const cand of candidates) {
      const filename = `hetero_${cand.label}${file_ext}`
      zip.file(filename, serialize_structure(cand.structure, fmt))
      manifest.push({
        filename,
        shift_a: cand.shift_a,
        shift_b: cand.shift_b,
        n_atoms: cand.n_atoms,
        match_area: cand.match_area,
        strain: cand.strain,
      })
    }
    zip.file(`manifest.json`, JSON.stringify(manifest, null, 2))

    const blob = await zip.generateAsync({ type: `blob`, compression: `DEFLATE` })
    trigger_download(blob, `registry_candidates_${candidates.length}.zip`)
    return
  }

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
  download(blob, `registry_candidates_${candidate_count}.zip`, `application/zip`)
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
  // Client-side path (no Python backend) — lateral edge-match search in WASM.
  if (await slab_use_wasm_path()) {
    const result = await wasm_lateral_search(slab_A as never, slab_B as never, {
      interface_axis: params.interface_axis,
      max_length: params.max_length,
      max_strain: params.max_strain,
      max_results: params.max_results,
    })
    if (`error` in result) throw new Error(result.error)
    return result.ok as LateralSearchResult
  }

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
  // Client-side path: re-run the edge-match search inside the WASM build and
  // join the slabs side-by-side. Mirrors the backend `/build-lateral`, which
  // also re-runs the search and selects `match.match_id`.
  if (await slab_use_wasm_path()) {
    const result = await wasm_build_lateral(
      slab_A as never,
      slab_B as never,
      match.match_id,
      search_params.interface_axis ?? 0,
      params.width_A ?? 1,
      params.width_B ?? 1,
      params.buffer ?? 0.0,
      params.vacuum ?? 20.0,
      search_params.max_length ?? 100.0,
      search_params.max_strain ?? 5.0,
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as LateralBuildResult
  }

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
  // Client-side SLAB path: reduce the shift grid to the film's irreducible
  // wedge and shift the film atoms per point, all in-browser. Matches the
  // backend `/grid-scan` response shape exactly.
  if (await slab_use_wasm_path()) {
    const result = await wasm_build_hetero_grid_scan(
      heterostructure as never,
      film as never,
      n_atoms_substrate,
      params.n_grid_x ?? 6,
      params.n_grid_y ?? 6,
      params.symprec ?? 0.1,
    )
    if (`error` in result) throw new Error(result.error)
    return result.ok as GridScanResult
  }

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
