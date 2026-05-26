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

export interface ReticularBuildResult {
  structure: PymatgenStructure
  n_atoms: number
  topology: string
  formula: string
  message: string
}

export interface TopologyInfo {
  name: string
}

export interface BuildingBlockInfo {
  name: string
  n_connection_points: number
}

export interface TopologyDetail {
  name: string
  node_types: number[]
  node_cn: number[]
  edge_types: number[][]
}

export interface PresetInfo {
  id: string
  label: string
  topology: string
}

async function get_json<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}

export async function listPresets(server_url = SERVER_URL): Promise<PresetInfo[]> {
  return get_json(`${server_url}/api/reticular/presets`)
}

export async function listTopologies(
  q = ``,
  server_url = SERVER_URL,
): Promise<TopologyInfo[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ``
  return get_json(`${server_url}/api/reticular/topologies${qs}`)
}

export async function listBuildingBlocks(
  q = ``,
  server_url = SERVER_URL,
): Promise<BuildingBlockInfo[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ``
  return get_json(`${server_url}/api/reticular/building-blocks${qs}`)
}

export async function getTopology(
  name: string,
  server_url = SERVER_URL,
): Promise<TopologyDetail> {
  return get_json(`${server_url}/api/reticular/topology/${encodeURIComponent(name)}`)
}

export async function buildReticular(
  body: {
    mode: `preset` | `advanced`
    preset?: string
    topology?: string
    node_bbs?: Record<number, string>
    edge_bbs?: Record<string, string>
  },
  server_url = SERVER_URL,
): Promise<ReticularBuildResult> {
  const response = await fetch(`${server_url}/api/reticular/build`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}
