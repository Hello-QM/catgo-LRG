/**
 * API client for cube file processing.
 * Communicates with the Python FastAPI backend which calls the Rust cube-processor.
 */

import { API_BASE as _DEFAULT_API } from '$lib/api/config'

let API_BASE = _DEFAULT_API

export function setCubeApiBase(base: string) {
  API_BASE = base
}

export interface CubeAtom {
  atomic_number: number
  charge: number
  position: [number, number, number]
}

export interface CubeHeader {
  comment1: string
  comment2: string
  n_atoms: number
  origin: [number, number, number]
  dims: [number, number, number]
  voxel_axes: [[number, number, number], [number, number, number], [number, number, number]]
  atoms: CubeAtom[]
}

export interface CubeMesh {
  positions: number[] | Float32Array
  normals: number[] | Float32Array
  indices: number[] | Uint32Array
}

export interface IsosurfaceResult {
  header: CubeHeader
  positive: CubeMesh | null
  negative: CubeMesh | null
  isovalue: number
  elapsed_ms: number
}

export interface IsosurfaceParams {
  filepath: string
  isovalue: number
  dual: boolean
  decimate?: number
  format?: `json` | `glb` | `obj`
}

export interface SliceParams {
  filepath: string
  axis: `x` | `y` | `z`
  position: number
  colormap?: string
  format?: `png` | `raw`
}

export interface PlaneSliceParams {
  filepath: string
  normal: [number, number, number]
  center: [number, number, number]
  colormap?: string
  resolution?: number
}

export interface SlicePlaneState {
  mode: `x` | `y` | `z` | `custom`
  position: number // fractional 0-1 for axis modes
  offset: number // offset along normal for custom mode (Angstroms)
  selected_atoms: number[]
  normal: [number, number, number]
  center: [number, number, number]
  rotation: [number, number, number]
  show_plane: boolean
  plane_color: string
  colormap: `RdBu` | `Viridis` | `Plasma` | `Inferno` | `Coolwarm` | `BrBG` | `Spectral`
}

export interface CubeState {
  filepath: string
  header: CubeHeader | null
  isovalue: number
  dual: boolean
  decimate: number
  show_positive: boolean
  show_negative: boolean
  positive_color: string
  negative_color: string
  opacity: number
  wireframe: boolean
  slice_plane: SlicePlaneState
  loading: boolean
  error: string | null
}

/**
 * Upload a cube file to the server for processing.
 */
export async function uploadCubeFile(file: File): Promise<{ filename: string; path: string }> {
  const formData = new FormData()
  formData.append(`file`, file)
  const response = await fetch(`${API_BASE}/cube/upload`, {
    method: `POST`,
    body: formData,
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Upload failed: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Extract isosurface mesh from a cube file.
 * Returns vertex positions, normals, and triangle indices.
 */
export async function extractIsosurface(params: IsosurfaceParams): Promise<IsosurfaceResult> {
  const response = await fetch(`${API_BASE}/cube/isosurface`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ ...params, format: `json` }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Isosurface extraction failed`)
  }
  return response.json()
}

/**
 * Download isosurface as GLB or OBJ file.
 */
export async function downloadIsosurface(
  params: IsosurfaceParams,
  format: `glb` | `obj`,
): Promise<Blob> {
  const response = await fetch(`${API_BASE}/cube/isosurface`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ ...params, format }),
  })
  if (!response.ok) throw new Error(`Download failed`)
  return response.blob()
}

/**
 * Extract a 2D slice as PNG image.
 */
export async function extractSlicePng(params: SliceParams): Promise<Blob> {
  const response = await fetch(`${API_BASE}/cube/slice`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ ...params, format: `png` }),
  })
  if (!response.ok) throw new Error(`Slice extraction failed`)
  return response.blob()
}

/**
 * Extract an arbitrary plane slice as PNG image.
 */
export async function extractPlaneSlice(params: PlaneSliceParams): Promise<Blob> {
  const response = await fetch(`${API_BASE}/cube/plane-slice`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Plane slice extraction failed`)
  }
  return response.blob()
}

/**
 * List cached cube files on the server.
 */
export async function listCachedFiles(): Promise<
  { filename: string; filepath: string; size_mb: number }[]
> {
  const response = await fetch(`${API_BASE}/cube/cached-files`)
  if (!response.ok) throw new Error(`Failed to list cached files`)
  const data = await response.json()
  return data.files
}
