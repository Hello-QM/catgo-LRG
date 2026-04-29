/**
 * API client for DOS analysis endpoints.
 */

import type {
  DBandResult,
  DOSGroup,
  DOSSessionInfo,
  PDOSResult,
} from '$lib/electronic/types'
import { SERVER_URL } from './config'

export async function upload_h5(
  file: File,
  server_url = SERVER_URL,
): Promise<DOSSessionInfo> {
  const form = new FormData()
  form.append(`file`, file)

  const response = await fetch(`${server_url}/api/dos/upload`, {
    method: `POST`,
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Upload failed: ${detail}`)
  }

  return response.json()
}

export async function upload_procar(
  procar: File,
  outcar?: File | null,
  poscar?: File | null,
  efermi?: number | null,
  server_url = SERVER_URL,
): Promise<DOSSessionInfo> {
  const form = new FormData()
  form.append(`procar`, procar)
  if (outcar) form.append(`outcar`, outcar)
  if (poscar) form.append(`poscar`, poscar)
  if (efermi != null) form.append(`efermi`, String(efermi))

  const response = await fetch(`${server_url}/api/dos/upload-procar`, {
    method: `POST`,
    body: form,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Upload failed: ${detail}`)
  }

  return response.json()
}

export async function load_from_directory(
  hpc_session_id: string,
  remote_path: string,
  server_url = SERVER_URL,
): Promise<DOSSessionInfo> {
  const response = await fetch(
    `${server_url}/api/dos/from-directory?session_id=${encodeURIComponent(hpc_session_id)}&remote_path=${encodeURIComponent(remote_path)}`,
    { method: `POST` },
  )

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Directory load failed: ${detail}`)
  }

  return response.json()
}

export async function compute_pdos(
  session_id: string,
  groups: DOSGroup[],
  params: {
    sigma?: number
    emin?: number
    emax?: number
    ngrid?: number
  } = {},
  server_url = SERVER_URL,
): Promise<PDOSResult> {
  const response = await fetch(`${server_url}/api/dos/compute`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      groups,
      sigma: params.sigma ?? 0.05,
      emin: params.emin ?? -8.0,
      emax: params.emax ?? 6.0,
      ngrid: params.ngrid ?? 2000,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`PDOS computation failed: ${detail}`)
  }

  return response.json()
}

export async function compute_total_dos(
  session_id: string,
  params: {
    sigma?: number
    emin?: number
    emax?: number
    ngrid?: number
  } = {},
  server_url = SERVER_URL,
): Promise<PDOSResult> {
  const response = await fetch(`${server_url}/api/dos/total`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      sigma: params.sigma ?? 0.05,
      emin: params.emin ?? -8.0,
      emax: params.emax ?? 6.0,
      ngrid: params.ngrid ?? 2000,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Total DOS computation failed: ${detail}`)
  }

  return response.json()
}

export async function compute_dband(
  session_id: string,
  atoms: number[],
  params: {
    sigma?: number
    occupied_only_center?: boolean
  } = {},
  server_url = SERVER_URL,
): Promise<DBandResult> {
  const response = await fetch(`${server_url}/api/dos/dband`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      atoms,
      sigma: params.sigma ?? 0.05,
      occupied_only_center: params.occupied_only_center ?? true,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`D-band analysis failed: ${detail}`)
  }

  return response.json()
}

export async function select_atoms(
  session_id: string,
  opts: {
    elements?: string[]
    index_spec?: string
  },
  server_url = SERVER_URL,
): Promise<number[]> {
  const response = await fetch(`${server_url}/api/dos/select-atoms`, {
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

export async function cleanup_session(
  session_id: string,
  server_url = SERVER_URL,
): Promise<void> {
  await fetch(`${server_url}/api/dos/${session_id}`, { method: `DELETE` })
}

export async function load_from_remote(
  hpc_session_id: string,
  remote_path: string,
  server_url = SERVER_URL,
): Promise<DOSSessionInfo> {
  const response = await fetch(`${server_url}/api/dos/from-remote?session_id=${encodeURIComponent(hpc_session_id)}&remote_path=${encodeURIComponent(remote_path)}`, {
    method: 'POST',
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Remote load failed: ${detail}`)
  }

  return response.json()
}
