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

export interface WaterLayerParams {
  z_start?: number
  z_end?: number
  min_distance?: number
  equilibrate?: boolean
  equil_steps?: number
  equil_temperature?: number
}

export interface WaterLayerResult {
  structure: PymatgenStructure
  n_water_molecules: number
  n_atoms_added: number
  n_water_filled: number
  n_water_removed: number
  z_start: number
  z_end: number
  c_axis_adjusted: boolean
  new_c_length: number
  equilibrated: boolean
  actual_density?: number
  message: string
}

export async function addWaterLayer(
  structure: PymatgenStructure,
  params: WaterLayerParams = {},
  server_url = SERVER_URL,
): Promise<WaterLayerResult> {
  // Water packing (spc216 tiling + clash removal) runs fully client-side — no
  // backend round-trip needed. The only step that requires the Python backend
  // is the optional TIP4P/LAMMPS equilibration, which is currently hidden in
  // the UI; if it is ever requested explicitly, fall back to the backend.
  if (!params.equilibrate) {
    const { add_water_layer_local } = await import('./water-layer-local')
    return add_water_layer_local(structure, params)
  }

  const response = await fetch(`${server_url}/api/water-layer/add`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, params }),
  })

  if (!response.ok) {
    const error_data = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error_data.detail) || `Server error: ${response.status}`)
  }

  return await response.json()
}
