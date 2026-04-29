/**
 * API client for batch trajectory editing.
 * Sends multi-frame edit operations to the backend to avoid browser freezes.
 */

import { API_BASE } from './config'

export interface TrajectoryEditParams {
  frames: Record<string, unknown>[]
  operation: 'replace_atom' | 'add_atom' | 'delete_atoms' | 'move_atoms'
  params: Record<string, unknown>
  skip_frame?: number
}

export interface TrajectoryEditResult {
  frames: Record<string, unknown>[]
  modified: number
  skipped: number
}

export async function batch_edit_trajectory(
  params: TrajectoryEditParams,
): Promise<TrajectoryEditResult> {
  const response = await fetch(`${API_BASE}/trajectory-edit/batch`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Trajectory batch edit failed: ${detail}`)
  }
  return response.json()
}
