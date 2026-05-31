/**
 * HPC API client: SSH connections (WebSocket), job scheduling, file transfer, and profile management.
 * Follows the pattern from compute.ts — configurable base URL, error handling, WS support.
 */

// ====== Types ======

export type SchedulerType = `slurm` | `pbs`
export type AuthMethod = `password` | `password_otp` | `key` | `key_otp` | `ssh_config`
export type JobStatus =
  | `PENDING`
  | `RUNNING`
  | `COMPLETED`
  | `FAILED`
  | `CANCELLED`
  | `UNKNOWN`

export type CalcSoftware = `vasp` | `qe` | `lammps` | `cp2k` | `unknown`
export type CalcType = `opt` | `scf` | `md` | `freq` | `band` | `dos` | `neb` | `unknown`

export interface HPCConnectionConfig {
  host: string
  port: number
  username: string
  password?: string
  auth_method: AuthMethod
  key_file?: string // For key/key_otp auth (e.g. ~/.ssh/id_rsa_kaust)
  jump_host?: string
  jump_port?: number
  jump_username?: string
  jump_password?: string // If empty, use SSH key/agent auth for jump host
  scheduler: SchedulerType
  ssh_alias?: string // SSH config alias (e.g. "Shaheen"), for ssh_config auth
  // SOCKS5 proxy — route SSH traffic through a SOCKS5 proxy (e.g. 127.0.0.1:1080)
  proxy_host?: string
  proxy_port?: number // default: 1080
  proxy_username?: string
  proxy_password?: string
  work_root?: string
}

export interface HPCProfile {
  name: string
  host: string
  port: number
  username: string
  auth_method: AuthMethod
  key_file?: string
  jump_host?: string
  jump_port?: number
  jump_username?: string
  scheduler: SchedulerType
  ssh_alias?: string
  // SOCKS5 proxy (host/port persisted, password NOT persisted)
  proxy_host?: string
  proxy_port?: number
  proxy_username?: string
  work_root?: string
}

export interface HPCJob {
  job_id: string
  job_name: string
  status: JobStatus
  partition: string
  nodes: string
  time_elapsed: string
  time_limit: string
  submit_time: string
  start_time: string
  reason: string
  work_dir: string
  calc_software: string
  calc_type: string
}

export interface RemoteFile {
  name: string
  path: string
  is_dir: boolean
  size_bytes: number
  modified_time: string
}

export interface ConnectionInfo {
  session_id: string
  host: string
  username: string
  scheduler: SchedulerType
  uptime_seconds: number
  work_root?: string
}

export interface JobSummary {
  running: number
  pending: number
  completed: number
  failed: number
  total: number
}

export interface HPCOverview {
  session_id: string
  host: string
  username: string
  scheduler: SchedulerType
  uptime_seconds: number
  job_summary: JobSummary
  disk_usage: string
  system_info: string
}

export interface JobDetailInfo {
  job_id: string
  job_name: string
  status: JobStatus
  partition: string
  account: string
  nodes: string
  num_nodes: number
  num_cpus: number
  num_tasks: number
  time_elapsed: string
  time_limit: string
  submit_time: string
  start_time: string
  end_time: string
  work_dir: string
  stdout_path: string
  stderr_path: string
  command: string
  node_list: string
  reason: string
  exit_code: string
  cpus_per_task: number
  ntasks_per_node: number
  calc_software: CalcSoftware
  calc_type: CalcType
  current_step: number
  total_steps: number
}

export interface ConvergencePoint {
  step: number
  energy: number
  energy_sigma0: number
  max_force: number
  rms_force: number
}

export interface ConvergenceData {
  success: boolean
  points: ConvergencePoint[]
  converged: boolean
  message: string
}

export interface JobLogResponse {
  success: boolean
  content: string
  file_path: string
  total_lines: number
  message: string
}

export interface FileReadResponse {
  success: boolean
  content: string
  total_lines: number
  message: string
}

export interface FileWriteResponse {
  success: boolean
  message: string
}

export interface JobFilesResponse {
  success: boolean
  files: string[]
  work_dir: string
  message: string
}

export interface JobResubmitResponse {
  success: boolean
  message: string
  new_job_id: string
}

export interface JobSubmitConfig {
  session_id: string
  script_content: string
  job_name?: string
  partition?: string
  nodes?: number
  ntasks?: number
  cpus_per_task?: number
  time_limit?: string
  memory?: string
  work_dir?: string
}

// ====== API Base ======

import { API_BASE as _DEFAULT_API, WS_BASE as _DEFAULT_WS } from './config'

let API_BASE = _DEFAULT_API
let WS_BASE = _DEFAULT_WS

export function setHpcApiBase(httpBase: string, wsBase?: string): void {
  API_BASE = httpBase
  WS_BASE = wsBase ?? httpBase.replace(/^http/, `ws`)
}

/** Reset to the default (build-time) base URLs. */
export function resetHpcApiBase(): void {
  API_BASE = _DEFAULT_API
  WS_BASE = _DEFAULT_WS
}

export function getHpcApiBase(): { http: string; ws: string } {
  return { http: API_BASE, ws: WS_BASE }
}

// ====== WebSocket Connection ======

export interface HPCWSConnection {
  submit_otp: (code: string) => void
  disconnect: () => void
  isConnected: () => boolean
}

export interface HPCWSCallbacks {
  onConnected: (session_id: string, info?: { work_root?: string }) => void
  onOTPRequired: (prompt: string) => void
  onError: (message: string) => void
  onDisconnected: () => void
}

/**
 * Connect to an HPC system via WebSocket (supports interactive OTP).
 */
export function connectHPC(
  config: HPCConnectionConfig,
  callbacks: HPCWSCallbacks,
): HPCWSConnection {
  const ws_url = `${WS_BASE}/hpc/connect`
  let ws: WebSocket | null = null
  let connected = false

  try {
    ws = new WebSocket(ws_url)
  } catch (_err) {
    callbacks.onError(`Failed to create WebSocket connection`)
    return {
      submit_otp: () => {},
      disconnect: () => {},
      isConnected: () => false,
    }
  }

  ws.onopen = () => {
    ws?.send(JSON.stringify({ action: `connect`, config }))
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      switch (data.type) {
        case `connected`:
          connected = true
          callbacks.onConnected(data.session_id, { work_root: data.work_root || `` })
          break
        case `auth_challenge`:
          callbacks.onOTPRequired(data.prompt || `Verification code:`)
          break
        case `error`:
          callbacks.onError(data.message || `Connection error`)
          break
        case `disconnected`:
          connected = false
          callbacks.onDisconnected()
          break
      }
    } catch (err) {
      console.error(`Failed to parse HPC WebSocket message:`, event.data, err)
      callbacks.onError(`Failed to parse server message`)
    }
  }

  ws.onerror = () => {
    callbacks.onError(`WebSocket connection error`)
  }

  ws.onclose = () => {
    connected = false
    callbacks.onDisconnected()
  }

  return {
    submit_otp: (code: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: `otp_response`, otp_code: code }))
      }
    },
    disconnect: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: `disconnect` }))
      }
      ws?.close()
    },
    isConnected: () => connected,
  }
}

/**
 * Connect via SSH Config (ControlMaster) — no WebSocket needed.
 */
export async function connectSSHConfig(
  config: HPCConnectionConfig,
): Promise<{ type: string; session_id: string; host: string; username: string; message: string; work_root?: string }> {
  const response = await fetch(`${API_BASE}/hpc/connect/ssh-config`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(config),
  })
  return handleResponse(response)
}

// ====== REST: Jobs ======

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}

export async function submitJob(
  config: JobSubmitConfig,
): Promise<{ success: boolean; message: string; job_id?: string }> {
  const response = await fetch(`${API_BASE}/hpc/submit`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(config),
  })
  return handleResponse(response)
}

export interface PreflightCheck {
  name: string
  ok: boolean
  severity: 'error' | 'warn'
  detail: string
}

export interface VaspPreflightResponse {
  success: boolean
  checks: PreflightCheck[]
  message: string
}

export async function preflightVasp(
  session_id: string,
  config: {
    potcar_root: string
    potcar_functional: string
    vasp_command?: string
    elements?: string[]
    module_loads?: string
    python_env?: string
  },
): Promise<VaspPreflightResponse> {
  const response = await fetch(`${API_BASE}/hpc/preflight/vasp`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      potcar_root: config.potcar_root,
      potcar_functional: config.potcar_functional,
      vasp_command: config.vasp_command || ``,
      elements: config.elements || [],
      module_loads: config.module_loads || ``,
      python_env: config.python_env || ``,
    }),
  })
  return handleResponse(response)
}

export async function fetchJobs(
  session_id: string,
  start_time: string = ``,
): Promise<{ success: boolean; jobs: HPCJob[]; message?: string }> {
  let url = `${API_BASE}/hpc/jobs?session_id=${encodeURIComponent(session_id)}`
  if (start_time) {
    url += `&start_time=${encodeURIComponent(start_time)}`
  }
  const response = await fetch(url)
  return handleResponse(response)
}

export async function fetchJobDetail(
  session_id: string,
  job_id: string,
): Promise<HPCJob> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function fetchJobDetailInfo(
  session_id: string,
  job_id: string,
): Promise<JobDetailInfo> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/detail?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function fetchConvergence(
  session_id: string,
  job_id: string,
): Promise<ConvergenceData> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/convergence?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function fetchJobStructure(
  session_id: string,
  job_id: string,
): Promise<{ content: string; format: string }> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/structure?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function fetchJobLog(
  session_id: string,
  job_id: string,
  file: string = `stdout`,
  lines: number = 100,
): Promise<JobLogResponse> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/log?session_id=${encodeURIComponent(session_id)}&file=${encodeURIComponent(file)}&lines=${lines}`,
  )
  return handleResponse(response)
}

export async function cancelJob(
  session_id: string,
  job_id: string,
): Promise<{ success: boolean; message: string }> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}?session_id=${encodeURIComponent(session_id)}`,
    { method: `DELETE` },
  )
  return handleResponse(response)
}

// ====== REST: Files ======

export async function listFiles(
  session_id: string,
  path: string = `~`,
): Promise<{ success: boolean; files: RemoteFile[]; current_path: string; message?: string }> {
  const response = await fetch(`${API_BASE}/hpc/files/list`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, path }),
    signal: AbortSignal.timeout(30000),
  })
  return handleResponse(response)
}

export async function uploadFile(
  session_id: string,
  remote_path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ success: boolean; message: string; remote_path?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(`POST`, `${API_BASE}/hpc/upload`)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText))
      } else {
        reject(new Error(`Upload failed: ${xhr.statusText}`))
      }
    }

    xhr.onerror = () => reject(new Error(`Upload network error`))

    const formData = new FormData()
    formData.append(`session_id`, session_id)
    formData.append(`remote_path`, remote_path)
    formData.append(`file`, file)
    xhr.send(formData)
  })
}

export async function downloadFile(
  session_id: string,
  remote_path: string,
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  // The backend streams regular files as-is and directories as .tar.gz archives.
  const url = getDownloadUrl(session_id, remote_path)
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`)
  }

  const contentLength = response.headers.get(`Content-Length`)
  const total = contentLength ? parseInt(contentLength, 10) : 0

  if (!response.body || !total || !onProgress) {
    return response.blob()
  }

  // Stream with progress
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress(Math.round((received / total) * 100))
  }

  return new Blob(chunks as BlobPart[])
}

export function getDownloadUrl(
  session_id: string,
  remote_path: string,
  options: { is_dir?: boolean; skip_stat?: boolean } = {},
): string {
  const params = new URLSearchParams({
    session_id,
    remote_path,
  })
  if (options.is_dir !== undefined) params.set(`is_dir`, String(options.is_dir))
  if (options.skip_stat !== undefined) params.set(`skip_stat`, String(options.skip_stat))
  return `${API_BASE}/hpc/download?${params.toString()}`
}

// ====== REST: Profiles ======

export async function loadProfiles(): Promise<HPCProfile[]> {
  const response = await fetch(`${API_BASE}/hpc/profiles`)
  return handleResponse(response)
}

export async function saveProfile(profile: HPCProfile): Promise<void> {
  const response = await fetch(`${API_BASE}/hpc/profiles`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(profile),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to save profile`)
  }
}

export async function deleteProfile(name: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/hpc/profiles/${encodeURIComponent(name)}`,
    { method: `DELETE` },
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to delete profile`)
  }
}

// ====== REST: Connection Status ======

export async function checkConnectionStatus(
  session_id: string,
): Promise<{ connected: boolean; host?: string; username?: string; uptime_seconds?: number; work_root?: string }> {
  const response = await fetch(
    `${API_BASE}/hpc/status/${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function disconnectSession(session_id: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/hpc/disconnect/${encodeURIComponent(session_id)}`,
    { method: `DELETE` },
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to disconnect`)
  }
}

// ====== REST: Connections + Overview ======

export async function fetchConnections(): Promise<ConnectionInfo[]> {
  const response = await fetch(`${API_BASE}/hpc/connections`)
  return handleResponse(response)
}

export async function fetchOverview(session_id: string): Promise<HPCOverview> {
  const response = await fetch(
    `${API_BASE}/hpc/overview/${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function readRemoteFile(
  session_id: string,
  file_path: string,
  max_bytes?: number,
): Promise<FileReadResponse> {
  const cache_key = `${session_id}\0${file_path}\0${max_bytes ?? ``}`
  const cached = remote_file_cache.get(cache_key)
  if (cached && Date.now() - cached.time < REMOTE_FILE_CACHE_TTL_MS) {
    return cached.value
  }

  const body: Record<string, unknown> = { session_id, file_path }
  if (max_bytes !== undefined) body.max_bytes = max_bytes
  const response = await fetch(`${API_BASE}/hpc/files/read-content`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(body),
  })
  const result = await handleResponse<FileReadResponse>(response)
  if (result.success) {
    remote_file_cache.set(cache_key, { time: Date.now(), value: result })
  }
  return result
}

const REMOTE_FILE_CACHE_TTL_MS = 30_000
const remote_file_cache = new Map<string, { time: number; value: FileReadResponse }>()

export async function prefetchRemoteFiles(
  session_id: string,
  file_paths: string[],
  max_bytes: number = 65536,
): Promise<void> {
  const missing = file_paths.filter((file_path) => {
    const cache_key = `${session_id}\0${file_path}\0${max_bytes}`
    const cached = remote_file_cache.get(cache_key)
    return !cached || Date.now() - cached.time >= REMOTE_FILE_CACHE_TTL_MS
  })
  if (!missing.length) return

  const response = await fetch(`${API_BASE}/hpc/files/read-many`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, file_paths: missing, max_bytes }),
  })
  const result = await handleResponse<{
    success: boolean
    files: Array<FileReadResponse & { file_path: string }>
    message?: string
  }>(response)
  if (!result.success) return
  const now = Date.now()
  for (const file of result.files || []) {
    if (!file.success) continue
    remote_file_cache.set(`${session_id}\0${file.file_path}\0${max_bytes}`, {
      time: now,
      value: {
        success: true,
        content: file.content,
        total_lines: file.total_lines,
        message: file.message || ``,
      },
    })
    // Default reads use max_bytes=undefined (2MB backend default). For small
    // prefetched files, the 64KB cache is also valid for ordinary open/edit.
    remote_file_cache.set(`${session_id}\0${file.file_path}\0`, {
      time: now,
      value: {
        success: true,
        content: file.content,
        total_lines: file.total_lines,
        message: file.message || ``,
      },
    })
  }
}

export function clearRemoteFileCache(session_id?: string, file_path?: string): void {
  if (!session_id) {
    remote_file_cache.clear()
    return
  }
  for (const key of remote_file_cache.keys()) {
    if (key.startsWith(`${session_id}\0`) && (!file_path || key.startsWith(`${session_id}\0${file_path}\0`))) {
      remote_file_cache.delete(key)
    }
  }
}

export async function readRemoteBinaryFile(
  session_id: string,
  file_path: string,
): Promise<{ success: boolean; data: string; mime_type: string; size: number; message?: string }> {
  const response = await fetch(`${API_BASE}/hpc/files/read-binary`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, file_path }),
  })
  return handleResponse(response)
}

export async function writeRemoteFile(
  session_id: string,
  file_path: string,
  content: string,
): Promise<FileWriteResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/write-content`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, file_path, content }),
  })
  const result = await handleResponse<FileWriteResponse>(response)
  if (result.success) clearRemoteFileCache(session_id, file_path)
  return result
}

export async function mergeStructuresFromDir(
  session_id: string,
  dir_path: string,
  pattern: string = `CONTCAR`,
): Promise<{ success: boolean; content: string; files: string[]; count: number }> {
  const response = await fetch(`${API_BASE}/hpc/files/merge-structures`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, dir_path, pattern }),
  })
  return handleResponse(response)
}

export async function fetchJobTrajectory(
  session_id: string,
  job_id: string,
): Promise<{ content: string; format: string }> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/trajectory?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function fetchJobFiles(
  session_id: string,
  job_id: string,
): Promise<JobFilesResponse> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/files?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

export async function resubmitJob(
  session_id: string,
  job_id: string,
): Promise<JobResubmitResponse> {
  const response = await fetch(
    `${API_BASE}/hpc/jobs/${encodeURIComponent(job_id)}/resubmit?session_id=${encodeURIComponent(session_id)}`,
    { method: `POST` },
  )
  return handleResponse(response)
}

// ====== Remote File Operations ======

export interface FileOpResponse {
  success: boolean
  message: string
}

export async function hpc_mkdir(
  session_id: string,
  path: string,
): Promise<FileOpResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/mkdir`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, path }),
  })
  return handleResponse(response)
}

export async function hpc_delete(
  session_id: string,
  path: string,
): Promise<FileOpResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/delete`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, path }),
  })
  return handleResponse(response)
}

export async function hpc_rename(
  session_id: string,
  old_path: string,
  new_path: string,
): Promise<FileOpResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/rename`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, old_path, new_path }),
  })
  return handleResponse(response)
}

export async function hpc_copy(
  session_id: string,
  source: string,
  destination: string,
): Promise<FileOpResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/copy`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, source, destination }),
  })
  return handleResponse(response)
}

export async function hpc_move(
  session_id: string,
  source: string,
  destination: string,
): Promise<FileOpResponse> {
  const response = await fetch(`${API_BASE}/hpc/files/move`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, source, destination }),
  })
  return handleResponse(response)
}

// ====== CatGO Remote Launch ======

export type CatgoLaunchState =
  | `idle`
  | `submitting`
  | `pending`
  | `running`
  | `tunneling`
  | `ready`
  | `failed`

export interface CatgoLaunchResponse {
  success: boolean
  message: string
  job_id: string
  catgo_dir: string
}

export interface CatgoTunnelResponse {
  success: boolean
  message: string
  local_port: number
  remote_node: string
}

export interface CatgoStatusResponse {
  state: string
  job_id: string
  node: string
  local_port: number
  message: string
}

/** Submit the CatGO job on the remote HPC system. */
export async function launchCatgo(
  session_id: string,
  port: number = 8000,
): Promise<CatgoLaunchResponse> {
  const response = await fetch(`${API_BASE}/hpc/catgo/launch`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, port }),
  })
  return handleResponse(response)
}

/** Set up an SSH tunnel to the CatGO compute node. */
export async function setupCatgoTunnel(
  session_id: string,
  job_id: string,
  remote_port: number = 8000,
  local_port: number = 8000,
): Promise<CatgoTunnelResponse> {
  const response = await fetch(`${API_BASE}/hpc/catgo/tunnel`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id, job_id, remote_port, local_port }),
  })
  return handleResponse(response)
}

/** Tear down the CatGO SSH tunnel. */
export async function teardownCatgoTunnel(session_id: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/hpc/catgo/tunnel?session_id=${encodeURIComponent(session_id)}`,
    { method: `DELETE` },
  )
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to teardown tunnel`)
  }
}

/** Get the current CatGO launch state for a session. */
export async function getCatgoStatus(session_id: string): Promise<CatgoStatusResponse> {
  const response = await fetch(
    `${API_BASE}/hpc/catgo/status?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

// ====== Remote CatGO Install ======

export interface InstallStatus {
  installed: boolean
  has_conda: boolean
  has_env: boolean
  has_server: boolean
  has_frontend: boolean
  accounts: string[]
  catgo_dir: string
  conda_activate?: string
}

/** Check if CatGO server is installed on the connected HPC system. */
export async function checkInstallStatus(session_id: string): Promise<InstallStatus> {
  const response = await fetch(
    `${API_BASE}/hpc/install/status?session_id=${encodeURIComponent(session_id)}`,
  )
  return handleResponse(response)
}

/** Run the CatGO installer on a connected HPC system. Returns when install completes. */
export async function runInstall(
  session_id: string,
  account: string,
  on_progress: (message: string) => void,
  on_done: () => void,
  on_error: (message: string) => void,
): Promise<void> {
  try {
    const params = new URLSearchParams({ session_id, account })
    const response = await fetch(`${API_BASE}/hpc/install/stream?${params}`)
    if (!response.ok) {
      on_error(`Install failed (${response.status})`)
      return
    }
    const reader = response.body?.getReader()
    if (!reader) {
      on_error(`No response stream`)
      return
    }
    const decoder = new TextDecoder()
    let buffer = ``
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(`\n\n`)
      buffer = parts.pop() ?? ``
      for (const part of parts) {
        const event_match = part.match(/^event:\s*(.+)$/m)
        const data_match = part.match(/^data:\s*(.+)$/m)
        if (!data_match) continue
        const event_type = event_match?.[1] ?? `log`
        const data = data_match[1]
        if (event_type === `done`) {
          on_done()
          return
        } else if (event_type === `error`) {
          on_error(data)
          return
        } else {
          on_progress(data)
        }
      }
    }
    // Stream ended without done/error event
    on_done()
  } catch (e) {
    on_error(`${e}`)
  }
}

/** Configure Claude Code on a remote server to connect back to local CatGO. */
export async function setupClaudeCode(
  session_id: string,
): Promise<{ success: boolean; message: string; tunnel?: boolean }> {
  const response = await fetch(`${API_BASE}/hpc/setup-claude-code`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ session_id }),
  })
  return handleResponse(response)
}
