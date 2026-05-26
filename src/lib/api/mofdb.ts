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

export interface MofHit {
  id: number
  name: string
  database: string
  elements: string[]
  n_elements: number
}

export interface MofSearchResult {
  hits: MofHit[]
  count: number
}

export interface MofStructureResult {
  structure: PymatgenStructure
  name: string
  database: string
}

export const MOFDB_DATABASES = [
  `CoREMOF 2019`,
  `CoREMOF 2014`,
  `CSD`,
  `hMOF`,
  `IZA`,
  `PCOD-syn`,
  `Tobacco`,
]

export async function searchMofs(
  body: { name?: string; database?: string; limit?: number },
  server_url = SERVER_URL,
): Promise<MofSearchResult> {
  const response = await fetch(`${server_url}/api/mofdb/search`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ limit: 50, ...body }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}

export async function getMofStructure(
  name: string,
  database = ``,
  server_url = SERVER_URL,
): Promise<MofStructureResult> {
  const params = new URLSearchParams({ name })
  if (database) params.set(`database`, database)
  const response = await fetch(`${server_url}/api/mofdb/structure?${params.toString()}`)
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(err.detail) || `Server error: ${response.status}`)
  }
  return response.json()
}
