/**
 * API client for band structure analysis endpoints.
 */

import type {
  BandSessionInfo,
  BandDataResult,
  BandProjectionGroup,
  BandProjectionResult,
} from '$lib/electronic/band_types'
import { SERVER_URL } from './config'

export async function upload_band_vasprun(
  file: File,
  kpoints_file?: File,
  server_url = SERVER_URL,
): Promise<BandSessionInfo> {
  const form = new FormData()
  form.append(`file`, file)
  if (kpoints_file) {
    form.append(`kpoints_file`, kpoints_file)
  }

  const response = await fetch(`${server_url}/api/bands/upload`, {
    method: `POST`,
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Upload failed: ${detail}`)
  }

  return response.json()
}

export async function get_band_data(
  session_id: string,
  params: { emin?: number; emax?: number } = {},
  server_url = SERVER_URL,
): Promise<BandDataResult> {
  const response = await fetch(`${server_url}/api/bands/data`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      emin: params.emin ?? -8.0,
      emax: params.emax ?? 6.0,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Band data request failed: ${detail}`)
  }

  return response.json()
}

export async function get_band_projections(
  session_id: string,
  groups: BandProjectionGroup[],
  params: { emin?: number; emax?: number } = {},
  server_url = SERVER_URL,
): Promise<BandProjectionResult> {
  const response = await fetch(`${server_url}/api/bands/projections`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      groups,
      emin: params.emin ?? -8.0,
      emax: params.emax ?? 6.0,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Projection request failed: ${detail}`)
  }

  return response.json()
}

export async function select_band_atoms(
  session_id: string,
  opts: { elements?: string[]; index_spec?: string },
  server_url = SERVER_URL,
): Promise<number[]> {
  const response = await fetch(`${server_url}/api/bands/select-atoms`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, ...opts }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Atom selection failed: ${detail}`)
  }

  const data = await response.json()
  return data.atoms
}

export async function load_band_from_directory(
  hpc_session_id: string,
  remote_path: string,
  server_url = SERVER_URL,
): Promise<BandSessionInfo> {
  const response = await fetch(
    `${server_url}/api/bands/from-directory?session_id=${encodeURIComponent(hpc_session_id)}&remote_path=${encodeURIComponent(remote_path)}`,
    { method: `POST` },
  )

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Directory load failed: ${detail}`)
  }

  return response.json()
}

export async function cleanup_band_session(
  session_id: string,
  server_url = SERVER_URL,
): Promise<void> {
  await fetch(`${server_url}/api/bands/${session_id}`, { method: `DELETE` })
}
