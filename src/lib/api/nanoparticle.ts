// Nanoparticle / cluster builder API client. Backs the Nanoparticle build pane.
// Calls POST /api/build/nanoparticle (wraps ase.cluster server-side).
import { SERVER_URL } from '$lib/api/config'

export type NanoparticleShape = `wulff` | `octahedron` | `icosahedron` | `decahedron`

export interface NanoparticleBuildParams {
  element: string
  shape?: NanoparticleShape
  structure?: `fcc` | `bcc` | `sc` | `hcp`
  size?: number
  surfaces?: number[][]
  energies?: number[]
  rounding?: `closest` | `above` | `below`
  length?: number
  cutoff?: number
  shells?: number
  p?: number
  q?: number
  r?: number
  vacuum?: number
}

export interface NanoparticleBuildResult {
  structure: Record<string, unknown>
  n_atoms: number
  formula: string
  message: string
}

export async function buildNanoparticle(
  params: NanoparticleBuildParams,
  server_url = SERVER_URL,
): Promise<NanoparticleBuildResult> {
  const response = await fetch(`${server_url}/api/build/nanoparticle`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: response.statusText }))
    const detail = typeof data?.detail === `string` ? data.detail : ``
    throw new Error(detail || `Server error: ${response.status}`)
  }
  return response.json()
}
