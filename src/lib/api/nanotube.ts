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

export async function getNanotubeInfo(
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
