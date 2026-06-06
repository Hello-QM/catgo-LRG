/**
 * Campaign (md-orchestration) API client — HTTP-only.
 *
 * Unlike project.ts (tri-modal DB routing), an md campaign is a filesystem scaffold
 * performed by the Python backend (where catgo + scaffold_project live), so this
 * always hits the FastAPI route. Requires the backend to be running.
 */
import { API_BASE } from './config'

export interface CampaignCreated {
  ok: boolean
  path: string
  name: string
  template: string
}

export async function create_campaign(
  name: string,
  base: string,
  template = `blank`,
): Promise<CampaignCreated> {
  const response = await fetch(`${API_BASE}/campaign/new`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ name, base, template }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}
