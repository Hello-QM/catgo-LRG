/**
 * Workflow API client: CRUD for workflows, steps, and templates.
 *
 * [2025-02] Three-way routing (same as project.ts):
 *   Tauri → db-local.ts, Desktop → db-wasm.ts, Browser → HTTP fetch
 */

import { check_tauri } from '$lib/io/tauri'
import type { WorkflowDetail, WorkflowSummary, WorkflowTemplate, WorkflowRunConfig, WorkflowRunStatus, StepInfo } from '$lib/workflow/workflow-types'
import { API_BASE, desktop_backend_available } from './config'

declare const __CATGO_DESKTOP__: boolean // set by vite.desktop.config.ts define

let local: typeof import('./db-local') | null = null
async function getLocal() {
  if (local) return local
  if (check_tauri()) {
    local = await import(`./db-local`)
  } else if (typeof __CATGO_DESKTOP__ !== `undefined` && __CATGO_DESKTOP__) {
    local = await import(`./db-wasm`) // [2025-02] sql.js WASM SQLite for desktop:dev
  }
  return local
}

/** [2026-03] Get the local DB module, but return null if the Python backend handles data. */
async function getLocalForData() {
  if (check_tauri()) return getLocal()
  if (await desktop_backend_available()) return null
  return getLocal()
}

async function handle_response<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}

export async function create_workflow(
  name: string,
  graph_json: string,
  description = ``,
  template_id?: string,
): Promise<WorkflowDetail> {
  const db = await getLocalForData()
  if (db) return db.db_create_workflow(name, graph_json, description, template_id) as Promise<unknown> as Promise<WorkflowDetail>
  const response = await fetch(`${API_BASE}/workflow/`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ name, description, template_id, graph_json }),
  })
  return handle_response(response)
}

export async function list_workflows(): Promise<WorkflowSummary[]> {
  const db = await getLocalForData()
  if (db) return db.db_list_workflows() as Promise<WorkflowSummary[]>
  const response = await fetch(`${API_BASE}/workflow/`)
  return handle_response(response)
}

export async function get_workflow(id: string): Promise<WorkflowDetail> {
  const db = await getLocalForData()
  if (db) {
    try {
      return await (db.db_get_workflow_detail(id) as Promise<unknown> as Promise<WorkflowDetail>)
    } catch {
      // Workflow not in local DB — fall back to backend (e.g. created by MCP/CLI agent)
      const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}`)
      return handle_response(response)
    }
  }
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}`)
  return handle_response(response)
}

export async function update_workflow(
  id: string,
  data: { name?: string; description?: string; graph_json?: string; status?: string; metadata?: string },
): Promise<WorkflowDetail> {
  const db = await getLocalForData()
  if (db) {
    try {
      return await (db.db_update_workflow(id, data) as Promise<unknown> as Promise<WorkflowDetail>)
    } catch {
      // Workflow not in local DB — fall back to backend (e.g. created by MCP/CLI agent)
    }
  }
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}`, {
    method: `PUT`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(data),
  })
  return handle_response(response)
}

export async function delete_workflow(id: string): Promise<void> {
  const db = await getLocalForData()
  if (db) return db.db_delete_workflow(id)
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to delete workflow`)
  }
}

export async function update_step(
  workflow_id: string,
  step_id: string,
  data: { config_json?: string; status?: string; hpc_job_id?: string; result_json?: string; error_message?: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps/${encodeURIComponent(step_id)}`,
    {
      method: `PUT`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify(data),
    },
  )
  return handle_response(response)
}

export async function list_templates(): Promise<WorkflowTemplate[]> {
  // [2025-02] Templates are server-only; return empty in local-DB mode (no Python backend)
  const db = await getLocalForData()
  if (db) return []
  const response = await fetch(`${API_BASE}/workflow/templates`)
  return handle_response(response)
}

export async function create_from_template(
  template_id: string,
  name = `New Workflow`,
): Promise<WorkflowDetail> {
  const response = await fetch(
    `${API_BASE}/workflow/from-template/${encodeURIComponent(template_id)}?name=${encodeURIComponent(name)}`,
    { method: `POST` },
  )
  return handle_response(response)
}

/** Check if a workflow graph contains any calculator nodes that need the Python backend.
 *  ALL calculators (any node with a `software` param) run remotely via SSH+SLURM.
 *  Only pure-local nodes (structure_input, analysis, etc.) can use the Rust engine. */
function needs_python_hpc(graph_json: string | object): boolean {
  try {
    const g = typeof graph_json === `string` ? JSON.parse(graph_json) : graph_json
    const nodes: Array<{ data?: { params?: Record<string, unknown> } }> = g.nodes ?? []
    return nodes.some(n => {
      const sw = n.data?.params?.software as string | undefined
      return !!sw  // Any node with a software param is a calculator → needs HPC
    })
  } catch { return false } // Malformed graph JSON — default to not needing HPC
}

export async function run_workflow(
  id: string,
  config: WorkflowRunConfig,
  graph_json?: string,
): Promise<{ status: string; workflow_id: string }> {
  // All workflows execute via Python backend (handles local + HPC nodes)
  //
  // [2026-04] Ensure the backend has the latest graph_json before running.
  //
  // [2026-06] Do NOT flush the WASM snapshot here. The browser's sql.js copy
  // is a whole-file image loaded at page start; flushing it over the on-disk
  // DB rolled back every row the backend persisted since then (new workflows,
  // graph updates with new nodes) — the "geo_opt node disappears after run" /
  // "Workflow not found" bug. The backend file is authoritative; callers with
  // editor state pass the live graph via `graph_json` and we sync just that.
  const db = await getLocal()
  if (db) {
    const dbInfo = await db.db_get_current()
    // Bug 1 fix: db/open failure must block execution
    const openResp = await fetch(`${API_BASE}/workflow/db/open?path=${encodeURIComponent(dbInfo.path)}`, {
      method: `POST`,
    })
    if (!openResp.ok) {
      const detail = await openResp.text().catch(() => openResp.statusText)
      throw new Error(`Failed to open database on backend: ${detail}`)
    }
  }
  if (db || graph_json != null) {
    // Prefer the editor's live graph (authoritative); fall back to the stored
    // workflow for callers without editor state (e.g. the in-app AI).
    let wf: { id: string; name: string; description?: string; graph_json: unknown; project_id?: string | null }
    let graph: string
    if (graph_json != null) {
      wf = await get_workflow(id).catch(() => ({ id, name: `Workflow`, description: ``, graph_json, project_id: null }))
      graph = graph_json
    } else {
      wf = await get_workflow(id)
      graph = typeof wf.graph_json === `string` ? wf.graph_json : JSON.stringify(wf.graph_json)
    }
    // Bug 1 fix: sync failure must block execution
    const sync_resp = await fetch(`${API_BASE}/workflow/`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({
        id: wf.id,
        name: wf.name,
        description: wf.description || ``,
        graph_json: graph,
        project_id: wf.project_id,
      }),
    })
    if (!sync_resp.ok) {
      const err = await sync_resp.text().catch(() => sync_resp.statusText)
      throw new Error(`Failed to sync workflow to backend: ${err}`)
    }
  }

  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/run`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(config),
  })
  return handle_response(response)
}

export async function pause_workflow(
  id: string,
  options?: { cancel_step_ids?: string[] },
): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/pause`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(options ?? {}),
  })
  return handle_response(response)
}

export async function resume_workflow(id: string, config: WorkflowRunConfig): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/resume`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(config),
  })
  return handle_response(response)
}

export async function reset_workflow(id: string): Promise<{ status: string; steps_reset: number }> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/reset`, {
    method: `POST`,
  })
  return handle_response(response)
}

export async function recheck_jobs(id: string): Promise<{
  rechecked: number
  updated: number
  results: Array<{ step_id: string; job_id: string; old_status: string; new_status: string }>
}> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(id)}/recheck-jobs`, {
    method: `POST`,
  })
  return handle_response(response)
}

export async function list_steps(workflow_id: string): Promise<StepInfo[]> {
  // Always try HTTP first — execution results (result_json, timestamps) are only
  // written to the Python backend DB, not the WASM DB. The WASM DB has step rows
  // from graph sync but they lack execution data.
  try {
    const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps`)
    const http_steps = await handle_response<StepInfo[]>(response)
    if (Array.isArray(http_steps)) return http_steps
  } catch {
    // Backend unreachable — fall back to local DB
  }
  const db = await getLocal()
  if (db) {
    try {
      const local = await (db.db_list_steps(workflow_id) as Promise<unknown> as Promise<StepInfo[]>)
      if (Array.isArray(local) && local.length > 0) return local
    } catch { /* local DB miss */ }
  }
  return []
}

/** Live status polling — Tauri reads local DB (instant), HTTP fallback for web mode */
export async function list_steps_http(workflow_id: string): Promise<StepInfo[]> {
  return list_steps(workflow_id)
}

/** Live workflow list — Tauri reads local DB (instant), HTTP fallback for web mode */
export async function list_workflows_http(): Promise<WorkflowSummary[]> {
  const db = await getLocal()
  if (db && check_tauri()) return db.db_list_workflows() as Promise<unknown> as Promise<WorkflowSummary[]>
  const response = await fetch(`${API_BASE}/workflow/`)
  return handle_response(response)
}

export async function get_run_status(workflow_id: string): Promise<WorkflowRunStatus> {
  const db = await getLocal()
  if (db?.db_get_run_status && check_tauri()) {
    try {
      const local = await (db.db_get_run_status(workflow_id) as Promise<unknown> as Promise<WorkflowRunStatus>)
      if (local.steps?.length > 0) return local
    } catch { /* local DB miss — fall through */ }
  }
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/run-status`)
  return handle_response(response)
}

export async function get_step_files(workflow_id: string, step_id: string, subdir?: string): Promise<{ files: Array<{ name: string; size: string; modified: string; permissions?: string }>; work_dir: string }> {
  const params = subdir ? `?subdir=${encodeURIComponent(subdir)}` : ``
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps/${encodeURIComponent(step_id)}/files${params}`)
  return handle_response(response)
}

export async function get_step_output(workflow_id: string, step_id: string, filename: string): Promise<{ filename: string; content: string; work_dir: string }> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/steps/${encodeURIComponent(step_id)}/output/${encodeURIComponent(filename)}`)
  return handle_response(response)
}

export async function get_workflow_results(workflow_id: string): Promise<{ results: Array<Record<string, unknown>>; count: number }> {
  const db = await getLocalForData()
  if (db) return db.db_query_results(workflow_id)
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/results`)
  return handle_response(response)
}

export async function get_job_script_presets(): Promise<Record<string, { id: string; name: string; template: string }>> {
  const response = await fetch(`${API_BASE}/workflow/job-script-presets`)
  return handle_response(response)
}

/** Convergence data point from OSZICAR + OUTCAR (VASP) or cp2k.out (CP2K). */
export interface ConvergencePoint {
  step: number
  energy: number
  dE: number
  energy_sigma0: number
  max_force: number
  rms_force: number
  max_step?: number          // MAX displacement (Bohr) — ORCA OPT only
  rms_step?: number          // RMS displacement (Bohr) — ORCA OPT only
  max_gradient?: number      // max |G| (Hartree/Bohr)  — ORCA IRC only
  rms_gradient?: number      // RMS(G) (Hartree/Bohr)   — ORCA IRC only
  is_ts?: boolean            // true for TS step (step 0) — ORCA IRC only
  // CP2K MD fields — present only when parse_cp2k_convergence routed to its
  // MD branch (cp2k.out had `STEP NUMBER` blocks). All in eV / K.
  temperature?: number       // K — instantaneous ionic temperature
  kinetic_energy?: number    // eV
  potential_energy?: number  // eV
  conserved_energy?: number  // eV — CP2K's "CONSERVED QUANTITY"
}

/** Get OSZICAR convergence history for a workflow step */
export async function get_convergence(
  workflow_id: string,
  step_id: string,
): Promise<{ points: ConvergencePoint[]; converged: boolean }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/convergence/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

/** Live per-iteration progress for MLP steps (mlp_relax / mlp_neb / mlp_vibrations).
 *
 * Parses ASE's opt.log / neb.log in the step's local work_dir. Returns empty
 * points with a human-readable `message` while the log hasn't been created
 * yet (step just started) or when the step runs on HPC (not yet wired).
 */
export async function get_mlp_progress(
  workflow_id: string,
  step_id: string,
): Promise<{ points: ConvergencePoint[]; converged: boolean; message: string }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/mlp-progress/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

/** Per-atom force data for a specific ionic step */
export interface StepForces {
  success: boolean
  forces: [number, number, number][]
  positions: [number, number, number][]
  step: number
  total_steps: number
  structure_content?: string
  message?: string
}

/** Get per-atom force vectors for a specific ionic step from OUTCAR */
export async function get_step_forces(
  workflow_id: string,
  step_id: string,
  ionic_step: number = 0,
): Promise<StepForces> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/forces/${encodeURIComponent(step_id)}?ionic_step=${ionic_step}`,
  )
  return handle_response(response)
}

/** Get completed step results from database (convergence points from result_json) */
export async function get_step_results(
  workflow_id: string,
  step_id: string,
): Promise<{ points: ConvergencePoint[]; converged?: boolean; message?: string; convergence_thresholds?: { max_grad: number; rms_grad: number } }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/step-results/${encodeURIComponent(step_id)}`,
  )
  const data = await handle_response<{
    node_type: string
    convergence_points: ConvergencePoint[]
    energy_eh?: number
    energy_ev?: number
    converged?: boolean
    n_steps?: number
    message?: string
    full_summary?: Record<string, unknown>
  }>(response)
  // Normalize to match get_orca_progress() format
  const summary = data.full_summary || {}
  return {
    points: data.convergence_points || [],
    converged: data.converged,
    message: data.message,
    convergence_thresholds: (summary as any).convergence_thresholds,
  }
}

/** Get live ORCA optimization/IRC progress from ORCA.out */
export async function get_orca_progress(
  workflow_id: string,
  step_id: string,
): Promise<{ points: ConvergencePoint[]; converged: boolean; message?: string; convergence_thresholds?: { max_grad: number; rms_grad: number }; image_energies?: Record<string, Array<[number, number]>> }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/orca_progress/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

/** Get lightweight UV-Vis progress (file size only, no parsing) */
export async function get_orca_uvvis_progress_light(
  workflow_id: string,
  step_id: string,
): Promise<{ file_size: number; completed: boolean; message: string }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/orca_uvvis_progress_light/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

/** Download IRC trajectory file for visualization */
export async function get_irc_trajectory(
  workflow_id: string,
  step_id: string,
): Promise<{ content: string; filename: string }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/irc_trajectory/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

/** Get VASP frequency data for a step (lazy-fetch with cache) */
export async function get_vasp_frequencies(
  workflow_id: string,
  step_id: string,
): Promise<VaspFrequencyData> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/vasp_frequencies/${encodeURIComponent(step_id)}`,
  )
  return handle_response(response)
}

export interface VaspFrequencyData {
  success: boolean
  message?: string
  real_freqs?: Array<{ index: number; frequency_cm: number; thz: number; mev: number }>
  imag_freqs?: Array<{ index: number; frequency_cm: number; thz: number; mev: number }>
  eigenvectors?: number[][][]
  positions?: number[][]
  masses?: number[]
  ions_per_type?: number[]
  atom_types?: number[]
  total_atoms?: number
  num_imaginary?: number
  free_indices?: number[] | null
}

export interface GibbsRequest {
  mode: 'adsorbed' | 'gas'
  temperature: number
  pressure: number
  freq_cutoff: number
  n_unpaired: number
}

export interface GibbsResult {
  mode: string
  temperature: number
  g_corr_ev: number
  g_corr_kcal: number
  zpe_ev: number
  h_corr_ev: number
  ts_vib_ev?: number
  ts_total_ev?: number
  // Gas mode extras
  molecular_mass_amu?: number
  is_linear?: boolean
  sigma?: number
  u_trans_ev?: number
  u_rot_ev?: number
  du_vib_ev?: number
  pv_ev?: number
  s_trans?: number
  s_rot?: number
  s_vib?: number
  s_elec?: number
  [key: string]: unknown
}

/** Calculate Gibbs free energy correction for a freq step */
export async function calculate_gibbs(
  workflow_id: string,
  step_id: string,
  params: GibbsRequest,
): Promise<GibbsResult> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/gibbs/${encodeURIComponent(step_id)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
  )
  return handle_response(response)
}

/** Get enriched results for a single workflow */
export async function get_enriched_results(
  workflow_id: string,
): Promise<{ results: import('./project').EnrichedResult[]; count: number }> {
  const response = await fetch(
    `${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/results-enriched`,
  )
  return handle_response(response)
}

// ---------------------------------------------------------------------------
// Workflow monitor: Tauri events (M4) or WebSocket fallback
// ---------------------------------------------------------------------------

export function connect_workflow_monitor(workflow_id: string, callbacks: {
  on_step_status?: (step_id: string, status: string, job_id?: string, message?: string) => void
  on_workflow_status?: (status: string) => void
  on_initial_state?: (data: { workflow_status: string; steps: Array<{ id: string; status: string; hpc_job_id?: string; error_message?: string }> }) => void
  on_error?: (error: string) => void
}): { close: () => void } {
  // Always use WebSocket — Python engine broadcasts directly
  return connect_websocket_monitor(workflow_id, callbacks)
}

/** Tauri event monitor: ExecutionEvent → frontend callbacks (instant, no polling) */
function connect_tauri_monitor(workflow_id: string, callbacks: {
  on_step_status?: (step_id: string, status: string, job_id?: string, message?: string) => void
  on_workflow_status?: (status: string) => void
  on_initial_state?: (data: { workflow_status: string; steps: Array<{ id: string; status: string; hpc_job_id?: string; error_message?: string }> }) => void
  on_error?: (error: string) => void
}): { close: () => void } {
  let unlisten: (() => void) | null = null

  import(`@tauri-apps/api/event`).then(({ listen }) => {
    listen<{ type: string; step_id?: string; status?: string; message?: string }>(
      `workflow-event-${workflow_id}`,
      (event) => {
        const data = event.payload
        switch (data.type) {
          case `step_status`:
            callbacks.on_step_status?.(data.step_id!, data.status!, undefined, data.message)
            break
          case `workflow_status`:
            callbacks.on_workflow_status?.(data.status!)
            break
          case `step_log`:
            // Step log messages — could wire to a log panel in the future
            break
        }
      },
    ).then((fn) => { unlisten = fn })
  })

  return {
    close: () => { unlisten?.() },
  }
}

/** WebSocket monitor with auto-reconnect (fallback for non-Tauri / HTTP mode) */
function connect_websocket_monitor(workflow_id: string, callbacks: {
  on_step_status?: (step_id: string, status: string, job_id?: string, message?: string) => void
  on_workflow_status?: (status: string) => void
  on_initial_state?: (data: { workflow_status: string; steps: Array<{ id: string; status: string; hpc_job_id?: string; error_message?: string }> }) => void
  on_error?: (error: string) => void
}): { close: () => void } {
  const WS_BASE_URL = API_BASE.replace(/^http/, `ws`)
  const url = `${WS_BASE_URL}/workflow/${encodeURIComponent(workflow_id)}/monitor`

  let ws: WebSocket | null = null
  let closed_by_user = false
  let workflow_finished = false
  let reconnect_attempts = 0
  const MAX_RECONNECTS = 5
  let reconnect_timer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    ws = new WebSocket(url)

    ws.onopen = () => {
      reconnect_attempts = 0
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      switch (msg.type) {
        case `initial_state`:
          callbacks.on_initial_state?.(msg)
          break
        case `step_status`:
          if (msg.error) callbacks.on_error?.(`Step ${msg.step_id}: ${msg.error}`)
          callbacks.on_step_status?.(msg.step_id, msg.status, msg.job_id, msg.message)
          break
        case `workflow_status`:
          if (msg.error) callbacks.on_error?.(msg.error)
          callbacks.on_workflow_status?.(msg.status)
          if (msg.status === `completed` || msg.status === `failed`) {
            workflow_finished = true
          }
          break
        case `step_progress`:
          break
        case `error`:
          callbacks.on_error?.(msg.message || `Unknown workflow error`)
          break
        case `ping`:
          break
      }
    }

    ws.onerror = () => {
      if (!closed_by_user && !workflow_finished) {
        callbacks.on_error?.(`WebSocket connection error — is the backend running?`)
      }
    }

    ws.onclose = (event) => {
      if (closed_by_user || workflow_finished) return

      if (event.code === 1000) {
        return
      }

      if (reconnect_attempts < MAX_RECONNECTS) {
        reconnect_attempts++
        const delay = Math.min(1000 * Math.pow(2, reconnect_attempts - 1), 10000)
        reconnect_timer = setTimeout(connect, delay)
      } else {
        callbacks.on_error?.(`Lost connection to workflow monitor after ${MAX_RECONNECTS} retries`)
      }
    }
  }

  connect()

  return {
    close: () => {
      closed_by_user = true
      if (reconnect_timer) clearTimeout(reconnect_timer)
      ws?.close()
    },
  }
}
