/**
 * API client for COHP analysis endpoints.
 */

import type {
  COHPDataResult,
  COHPSessionInfo,
  ICOHPResult,
} from '$lib/electronic/cohp_types'
import { SERVER_URL } from './config'

export async function upload_cohpcar(
  file: File,
  server_url = SERVER_URL,
): Promise<COHPSessionInfo> {
  const form = new FormData()
  form.append(`file`, file)

  const response = await fetch(`${server_url}/api/cohp/upload-cohpcar`, {
    method: `POST`,
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Upload failed: ${detail}`)
  }

  return response.json()
}

export async function get_cohp_data(
  session_id: string,
  bond_indices: number[],
  params: {
    include_orbitals?: boolean
    orbital_filter?: string[]
    aggregate_orbitals?: boolean
  } = {},
  server_url = SERVER_URL,
): Promise<COHPDataResult> {
  const response = await fetch(`${server_url}/api/cohp/data`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      bond_indices,
      include_orbitals: params.include_orbitals ?? false,
      orbital_filter: params.orbital_filter ?? null,
      aggregate_orbitals: params.aggregate_orbitals ?? false,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`COHP data request failed: ${detail}`)
  }

  return response.json()
}

export async function upload_icohplist(
  file: File,
  server_url = SERVER_URL,
): Promise<ICOHPResult> {
  const form = new FormData()
  form.append(`file`, file)

  const response = await fetch(`${server_url}/api/cohp/upload-icohplist`, {
    method: `POST`,
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`ICOHPLIST upload failed: ${detail}`)
  }

  return response.json()
}

export async function cleanup_cohp_session(
  session_id: string,
  server_url = SERVER_URL,
): Promise<void> {
  await fetch(`${server_url}/api/cohp/${session_id}`, { method: `DELETE` })
}

export async function load_from_remote(
  hpc_session_id: string,
  remote_path: string,
  server_url = SERVER_URL,
): Promise<COHPSessionInfo> {
  const response = await fetch(`${server_url}/api/cohp/from-remote?session_id=${encodeURIComponent(hpc_session_id)}&remote_path=${encodeURIComponent(remote_path)}`, {
    method: 'POST',
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Remote load failed: ${detail}`)
  }

  return response.json()
}

export async function load_icohp_from_remote(
  hpc_session_id: string,
  remote_path: string,
  server_url = SERVER_URL,
): Promise<ICOHPResult> {
  const response = await fetch(`${server_url}/api/cohp/icohp-from-remote?session_id=${encodeURIComponent(hpc_session_id)}&remote_path=${encodeURIComponent(remote_path)}`, {
    method: 'POST',
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Remote load failed: ${detail}`)
  }

  return response.json()
}
