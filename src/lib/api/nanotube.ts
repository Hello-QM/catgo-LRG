import type { PymatgenStructure } from '$lib/structure'
import {
  type WasmNanotubeLayer,
  wasm_build_nanotube,
  wasm_nanotube_info,
} from '$lib/structure/ferrox-wasm'
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

export interface NanotubeLayerInput {
  structure?: PymatgenStructure
  lattice_vectors?: [number, number][]
  elements?: string[]
  basis_coords?: [number, number][]
  z_coords?: number[]
}

export interface NanotubeInfoParams {
  n: number
  m: number
  NL?: number
}

export interface NanotubeInfoResult {
  chiral_angle_deg: number
  circumference: number
  diameter: number
  radius: number
  trans_length: number
  tube_length: number
  n_atoms_estimate: number
  t1: number
  t2: number
  chirality: string
  message: string
}

export interface NanotubeBuildParams {
  n: number
  m: number
  NL?: number
  vacuum?: number
  n_walls?: number
  interlayer_spacing?: number
}

export interface WallInfo {
  n: number
  m: number
  radius: number
  n_atoms: number
}

export interface NanotubeBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  chiral_angle_deg: number
  circumference: number
  diameter: number
  tube_length: number
  chirality: string
  n_walls: number
  walls: WallInfo[]
  message: string
}

// Replicate the backend's layer extraction (routers/nanotube._extract_layer_data
// + utils.nanotube_algorithm.extract_2d_layer) so the WASM path can accept the
// same NanotubeLayerInput shape the backend does.
function extract_wasm_layer(layer: NanotubeLayerInput): WasmNanotubeLayer {
  if (layer.structure) {
    const s = layer.structure
    const matrix = s.lattice?.matrix
    if (!matrix) {
      throw new Error(`Structure has no lattice (molecule). Need a periodic 2D material.`)
    }
    // Take xy components of the first two lattice vectors.
    const lattice_vectors: [[number, number], [number, number]] = [
      [matrix[0][0], matrix[0][1]],
      [matrix[1][0], matrix[1][1]],
    ]
    const all_z = s.sites.map((site) => (site.xyz ?? [0, 0, 0])[2])
    const z_center = (Math.min(...all_z) + Math.max(...all_z)) / 2.0
    const elements: string[] = []
    const basis_coords: [number, number][] = []
    const z_coords: number[] = []
    for (const site of s.sites) {
      // Dominant species by occupancy.
      const dominant = site.species.reduce((best, sp) =>
        (sp.occu ?? 1.0) > (best.occu ?? 1.0) ? sp : best
      )
      elements.push(String(dominant.element))
      const abc = site.abc ?? [0, 0, 0]
      basis_coords.push([abc[0], abc[1]])
      z_coords.push((site.xyz ?? [0, 0, 0])[2] - z_center)
    }
    return { lattice_vectors, elements, basis_coords, z_coords }
  }

  if (!layer.lattice_vectors || !layer.elements || !layer.basis_coords) {
    throw new Error(
      `Either structure or (lattice_vectors, elements, basis_coords) must be provided`,
    )
  }
  const vecs = layer.lattice_vectors
  return {
    lattice_vectors: [
      [vecs[0][0], vecs[0][1]],
      [vecs[1][0], vecs[1][1]],
    ],
    elements: layer.elements,
    basis_coords: layer.basis_coords,
    z_coords: layer.z_coords && layer.z_coords.length > 0
      ? layer.z_coords
      : layer.elements.map(() => 0.0),
  }
}

async function getNanotubeInfoWasm(
  layer: NanotubeLayerInput,
  params: NanotubeInfoParams,
): Promise<NanotubeInfoResult> {
  const wasm_layer = extract_wasm_layer(layer)
  const result = await wasm_nanotube_info(wasm_layer, params.n, params.m, params.NL ?? 1)
  if (`error` in result) throw new Error(result.error)
  return result.ok as NanotubeInfoResult
}

async function buildNanotubeWasm(
  layer: NanotubeLayerInput,
  params: NanotubeBuildParams,
): Promise<NanotubeBuildResult> {
  const wasm_layer = extract_wasm_layer(layer)
  const result = await wasm_build_nanotube(wasm_layer, params.n, params.m, {
    nl: params.NL ?? 1,
    vacuum: params.vacuum ?? 15.0,
    n_walls: params.n_walls ?? 1,
    interlayer_spacing: params.interlayer_spacing ?? 3.4,
  })
  if (`error` in result) throw new Error(result.error)
  return result.ok as unknown as NanotubeBuildResult
}

export async function getNanotubeInfo(
  layer: NanotubeLayerInput,
  params: NanotubeInfoParams,
  server_url = SERVER_URL,
): Promise<NanotubeInfoResult> {
  // STATIC_ONLY: no Python backend — run the builder client-side in WASM.
  if (STATIC_ONLY) return getNanotubeInfoWasm(layer, params)

  try {
    return await getNanotubeInfoBackend(layer, params, server_url)
  } catch (error) {
    // Backend unavailable (network/503) — fall back to the WASM implementation.
    console.warn(`[nanotube] backend info failed, falling back to WASM:`, error)
    return getNanotubeInfoWasm(layer, params)
  }
}

async function getNanotubeInfoBackend(
  layer: NanotubeLayerInput,
  params: NanotubeInfoParams,
  server_url = SERVER_URL,
): Promise<NanotubeInfoResult> {
  const response = await fetch(`${server_url}/api/nanotube/info`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ layer, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}

export async function buildNanotube(
  layer: NanotubeLayerInput,
  params: NanotubeBuildParams,
  server_url = SERVER_URL,
): Promise<NanotubeBuildResult> {
  // STATIC_ONLY: no Python backend — run the builder client-side in WASM.
  if (STATIC_ONLY) return buildNanotubeWasm(layer, params)

  try {
    return await buildNanotubeBackend(layer, params, server_url)
  } catch (error) {
    // Backend unavailable (network/503) — fall back to the WASM implementation.
    console.warn(`[nanotube] backend build failed, falling back to WASM:`, error)
    return buildNanotubeWasm(layer, params)
  }
}

async function buildNanotubeBackend(
  layer: NanotubeLayerInput,
  params: NanotubeBuildParams,
  server_url = SERVER_URL,
): Promise<NanotubeBuildResult> {
  const response = await fetch(`${server_url}/api/nanotube/build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ layer, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return response.json()
}
