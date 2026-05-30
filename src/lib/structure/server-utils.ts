/**
 * Pure helpers, constants, types, and factory functions extracted from ServerPane.svelte.
 *
 * Nothing here touches Svelte reactivity ($state / $derived / $effect).
 */

import type {
  HPCWSConnection,
  HPCJob,
  HPCOverview,
  SchedulerType,
} from '$lib/api/hpc'

// ====== Constants ======

export const LOCAL_SESSION_ID = `__local__`

// ====== Session Interface & Factories ======

export interface HPCSession {
  _id: string // stable internal ID for finding session in reactive array
  session_id: string
  host: string
  username: string
  scheduler: SchedulerType
  conn_status: 'disconnected' | 'connecting' | 'otp_required' | 'connected' | 'error'
  conn_error: string
  otp_prompt: string
  otp_code: string
  ws_conn: HPCWSConnection | null
  // Jobs
  jobs: HPCJob[]
  jobs_loading: boolean
  jobs_fetched: boolean
  jobs_error: string
  auto_refresh: boolean
  refresh_interval: ReturnType<typeof setInterval> | null
  // Files
  current_path: string
  work_root: string
  files_error: string
  upload_progress: number | null
  // Overview
  overview: HPCOverview | null
  overview_loading: boolean
}

let _next_id = 0

export function create_session(): HPCSession {
  return {
    _id: `hpc_${++_next_id}`,
    session_id: ``,
    host: ``,
    username: ``,
    scheduler: `slurm`,
    conn_status: `disconnected`,
    conn_error: ``,
    otp_prompt: `Verification code:`,
    otp_code: ``,
    ws_conn: null,
    jobs: [],
    jobs_loading: false,
    jobs_fetched: false,
    jobs_error: ``,
    auto_refresh: false,
    refresh_interval: null,
    current_path: `~`,
    work_root: ``,
    files_error: ``,
    upload_progress: null,
    overview: null,
    overview_loading: false,
  }
}

export function create_local_session(): HPCSession {
  return {
    _id: LOCAL_SESSION_ID,
    session_id: LOCAL_SESSION_ID,
    host: `Local`,
    username: ``,
    scheduler: `slurm`,
    conn_status: `connected`,
    conn_error: ``,
    otp_prompt: ``,
    otp_code: ``,
    ws_conn: null,
    jobs: [],
    jobs_loading: false,
    jobs_fetched: false,
    jobs_error: ``,
    auto_refresh: false,
    refresh_interval: null,
    current_path: `~`,
    work_root: ``,
    files_error: ``,
    upload_progress: null,
    overview: null,
    overview_loading: false,
  }
}

// ====== Tab / Filter Types & Definitions ======

export type ServerTab = `connection` | `jobs` | `files`

export const tab_defs: { id: ServerTab; label: string }[] = [
  { id: `connection`, label: `Connection` },
  { id: `jobs`, label: `Jobs` },
  { id: `files`, label: `Files` },
]

export type JobStatusFilter = `all` | `RUNNING` | `PENDING` | `COMPLETED` | `FAILED` | `CANCELLED`

export type JobTimeFilter = `all` | `1h` | `6h` | `24h` | `7d` | `30d`

export type CalcTypeFilter = `all` | `opt` | `scf` | `md` | `freq` | `band` | `dos` | `neb`

export type CalcSoftwareFilter = `all` | `vasp` | `qe` | `lammps` | `cp2k`

// ====== Pure Helper Functions ======

const SACCT_TIME_MAP: Record<string, string> = {
  'all': ``,
  '1h': `now-1hour`,
  '6h': `now-6hours`,
  '24h': `now-24hours`,
  '7d': `now-7days`,
  '30d': `now-30days`,
}

export function get_sacct_start_time(time_filter: JobTimeFilter): string {
  return SACCT_TIME_MAP[time_filter] || ``
}

export function truncate_workdir(path: string, skip_segments: number): string {
  const parts = path.split(`/`).filter(Boolean)
  if (parts.length <= skip_segments) return parts[parts.length - 1] || path
  return parts.slice(skip_segments).join(`/`)
}

export function format_file_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Return CSS color variable name for a session connection status.
 */
export function get_status_color(
  conn_status: HPCSession['conn_status'] | undefined,
): string {
  if (!conn_status) return `var(--text-color-dim)`
  if (conn_status === `connected`) return `var(--success-color)`
  if (conn_status === `connecting` || conn_status === `otp_required`) return `var(--warning-color)`
  if (conn_status === `error`) return `var(--error-color)`
  return `var(--text-color-dim)`
}

/**
 * Client-side job filtering. Pure function — no reactivity dependency.
 */
export function filter_jobs(
  jobs: HPCJob[],
  status_filter: JobStatusFilter,
  software_filter: CalcSoftwareFilter,
  calc_filter: CalcTypeFilter,
): HPCJob[] {
  let result = jobs
  if (status_filter !== `all`) {
    result = result.filter((j) => j.status === status_filter)
  }
  if (software_filter !== `all`) {
    result = result.filter((j) => j.calc_software === software_filter)
  }
  if (calc_filter !== `all`) {
    result = result.filter((j) => j.calc_type === calc_filter)
  }
  return result
}
