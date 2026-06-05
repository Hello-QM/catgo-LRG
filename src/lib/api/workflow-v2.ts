// src/lib/api/workflow-v2.ts — engine workflow API (paths: /api/engine/workflows, /api/engine/tasks)
import { API_BASE } from './config'

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json()
}

// --- Workflows ---

export interface V2WorkflowSummary {
  id: string
  name: string
  status: string
  created_at: string | null
  updated_at: string | null
  task_count: number
  status_counts: Record<string, number>
  project_id: string | null
}

export interface V2Task {
  id: string
  workflow_id: string
  node_id?: string   // graph node id; `id` is namespaced {workflow_id}:{node_id}
  task_type: string
  name: string | null
  status: string
  params_json: string
  software: string | null
  system_name: string | null
  hpc_job_id: string | null
  work_dir: string | null
  error_message: string | null
  retry_count: number
  created_at: string | null
  parent_task_id: string | null
  map_key: string | null
}

export interface V2Link {
  id: number
  workflow_id: string
  source_task_id: string
  target_task_id: string
  source_key: string
  target_key: string
}

export interface V2DAG {
  tasks: V2Task[]
  links: V2Link[]
}

export async function list_v2_workflows(): Promise<V2WorkflowSummary[]> {
  return handle(await fetch(`${API_BASE}/engine/workflows`))
}

export async function list_v2_workflows_for_project(project_id: string): Promise<V2WorkflowSummary[]> {
  return handle(await fetch(`${API_BASE}/engine/workflows/by-project/${encodeURIComponent(project_id)}`))
}

export async function assign_v2_workflow_to_project(workflow_id: string, project_id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/engine/workflows/${encodeURIComponent(workflow_id)}/project/${encodeURIComponent(project_id)}`, { method: 'PUT' })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
}

export async function unassign_v2_workflow_from_project(workflow_id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/engine/workflows/${encodeURIComponent(workflow_id)}/project`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
}

export async function get_v2_workflow(id: string) {
  return handle<{ workflow: Record<string, unknown>; tasks: V2Task[]; task_count: number }>(
    await fetch(`${API_BASE}/engine/workflows/${id}`)
  )
}

export async function get_v2_dag(id: string): Promise<V2DAG> {
  return handle(await fetch(`${API_BASE}/engine/workflows/${id}/dag`))
}

export async function submit_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/engine/workflows/${id}/submit`, { method: 'POST' }))
}

export async function pause_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/engine/workflows/${id}/pause`, { method: 'POST' }))
}

export async function resume_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/engine/workflows/${id}/resume`, { method: 'POST' }))
}

export async function reset_v2_workflow(id: string) {
  return handle(await fetch(`${API_BASE}/engine/workflows/${id}/reset`, { method: 'POST' }))
}

// --- Tasks ---

export async function get_v2_task(id: string) {
  return handle<{ task: V2Task; parents: V2Link[]; children: V2Link[] }>(
    await fetch(`${API_BASE}/engine/tasks/${id}`)
  )
}

export async function update_v2_task_params(id: string, params: Record<string, unknown>) {
  return handle(await fetch(`${API_BASE}/engine/tasks/${id}/params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  }))
}

export async function retry_v2_task(id: string) {
  return handle<{ reset_tasks: string[] }>(
    await fetch(`${API_BASE}/engine/tasks/${id}/retry`, { method: 'POST' })
  )
}

export async function cancel_v2_task(id: string) {
  return handle(await fetch(`${API_BASE}/engine/tasks/${id}/cancel`, { method: 'POST' }))
}

export async function get_v2_task_result(id: string) {
  return handle<Record<string, unknown>>(
    await fetch(`${API_BASE}/engine/tasks/${id}/result`)
  )
}

export async function get_v2_task_provenance(task_id: string) {
  return handle<{ task_id: string; lineage: Record<string, unknown>; duplicate: { hash: string; matching_tasks: string[] } | null }>(
    await fetch(`${API_BASE}/engine/tasks/${task_id}/provenance`)
  )
}

// --- Task Confirmation (PENDING_REVIEW gate) ---

export async function confirm_engine_task(task_id: string) {
  return handle<{ task_id: string; status: string }>(
    await fetch(`${API_BASE}/engine/tasks/${encodeURIComponent(task_id)}/confirm`, { method: 'POST' })
  )
}

export async function reject_engine_task(task_id: string) {
  return handle<{ task_id: string; status: string }>(
    await fetch(`${API_BASE}/engine/tasks/${encodeURIComponent(task_id)}/reject`, { method: 'POST' })
  )
}

export async function confirm_all_engine_tasks(workflow_id: string) {
  return handle<{ workflow_id: string; confirmed: number }>(
    await fetch(`${API_BASE}/engine/workflows/${encodeURIComponent(workflow_id)}/confirm-all`, { method: 'POST' })
  )
}

/** Update task params (only WAITING/READY/PENDING_REVIEW tasks) */
export async function update_engine_task_params(
  task_id: string,
  params: Record<string, unknown>,
): Promise<{ task_id: string; status: string }> {
  const { API_BASE } = await import('./config')
  const r = await fetch(`${API_BASE}/engine/tasks/${task_id}/params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return handle<{ task_id: string; status: string }>(r)
}

// --- Task Monitoring ---

export interface TaskFileEntry {
  name: string
  path: string
  is_dir: boolean
  size_bytes: number
  modified_time: string
}

export interface TaskFilesResponse {
  work_dir: string
  resolved_path: string
  subdir: string
  files: TaskFileEntry[]
}

export interface ConvergencePoint {
  step: number
  energy: number
  dE: number
  energy_sigma0: number
  max_force: number
  rms_force: number
}

export interface TaskConvergenceResponse {
  success: boolean
  points: ConvergencePoint[]
  converged: boolean
  message: string
  convergence_thresholds?: { max_grad: number; rms_grad: number }
  image_energies?: Record<string, Array<[number, number]>>
}

export interface TaskFileContentResponse {
  path: string
  content: string
  total_lines: number
}

export async function get_engine_task_files(task_id: string, subdir = ''): Promise<TaskFilesResponse> {
  const params = subdir ? `?subdir=${encodeURIComponent(subdir)}` : ''
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/files${params}`))
}

export async function get_engine_task_convergence(task_id: string): Promise<TaskConvergenceResponse> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/convergence`))
}

export interface TaskMlpProgressResponse {
  points: ConvergencePoint[]
  // null when the per-task fmax target is unresolvable — the frontend
  // status-sync must NOT treat the node as converged in that case.
  converged: boolean | null
  message: string
}

export async function get_engine_task_mlp_progress(task_id: string): Promise<TaskMlpProgressResponse> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/mlp-progress`))
}

export async function get_engine_task_file_content(task_id: string, path: string): Promise<TaskFileContentResponse> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/file-content?path=${encodeURIComponent(path)}`))
}

export async function put_engine_task_file_content(task_id: string, path: string, content: string): Promise<{ path: string; success: boolean }> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/file-content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }))
}

export async function get_engine_task_frequencies(task_id: string): Promise<Record<string, unknown>> {
  return handle(await fetch(`${API_BASE}/engine/tasks/${task_id}/frequencies`))
}

// --- Convert ---

export async function convert_graph_to_v2(name: string, graph_json: string, config?: Record<string, unknown>) {
  return handle<{ workflow_id: string; name: string; task_count: number }>(
    await fetch(`${API_BASE}/engine/workflows/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, graph_json, config }),
    })
  )
}

// --- Dry-run (local validate + per-node input generation, no HPC) ---

/** Per-node dry-run outcome.
 *  - ok===true  : passed (validated + inputs generated)
 *  - ok===false : real failure — `error` carries the message
 *  - ok===null  : couldn't run (e.g. upstream structure unavailable) — `skipped`
 *                 carries the reason. NOT a failure. */
export interface DryRunNodeResult {
  ok: boolean | null
  error?: string
  skipped?: string
}

export interface DryRunResponse {
  valid: boolean
  results: Record<string, DryRunNodeResult>
  graph_errors: string[]
}

export interface DryRunNode {
  id: string
  type: string
  params: Record<string, unknown>
}

export interface DryRunEdge {
  from: string
  to: string
  fromH?: string
  toH?: string
}

/** Run a local dry-run: validate the graph and generate each calc node's
 *  inputs without touching HPC. `structures` maps node id → input structure
 *  (pymatgen-json or POSCAR string). */
export async function dry_run_workflow(
  nodes: DryRunNode[],
  edges: DryRunEdge[],
  structures: Record<string, string>,
): Promise<DryRunResponse> {
  return handle<DryRunResponse>(
    await fetch(`${API_BASE}/engine/workflows/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes, edges, structures }),
    })
  )
}

// --- WebSocket Monitor ---

export interface V2MonitorCallbacks {
  on_task_status?: (task_id: string, status: string) => void
  on_workflow_status?: (status: string) => void
  on_error?: (error: string) => void
  /** Fired once on (re)connect with the current DAG snapshot, before any
   *  streamed task_status updates. Additive (#224 Phase 3 prep): lets the
   *  editor seed live status from the WS itself instead of a separate
   *  get_v2_dag REST call. Carries the same {tasks, links} shape as the
   *  /dag endpoint. Optional — existing consumers can ignore it. */
  on_initial_state?: (dag: V2DAG) => void
}

export function connect_v2_monitor(workflow_id: string, callbacks: V2MonitorCallbacks): { close: () => void } {
  const WS_BASE = API_BASE.replace(/^http/, 'ws')
  const url = `${WS_BASE}/v2/workflows/${workflow_id}/monitor`

  let ws: WebSocket | null = null
  let closed = false
  let retries = 0
  let heartbeat_id: ReturnType<typeof setInterval> | null = null
  let last_pong = 0

  // Two-phase retry: fast exponential backoff, then slow indefinite polling.
  // Long-running jobs (NEB-TS, IRC) can take hours — we must never give up.
  const FAST_RETRIES = 10       // ~8.5 min of exponential backoff
  const SLOW_INTERVAL = 60_000  // then retry every 60s indefinitely
  const HEARTBEAT_INTERVAL = 30_000
  const HEARTBEAT_TIMEOUT = 15_000

  function connect() {
    if (closed) return
    ws = new WebSocket(url)

    ws.onopen = () => {
      retries = 0
      last_pong = Date.now()
      // Heartbeat: send ping every 30s to detect half-open connections
      heartbeat_id = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        // If we haven't heard back in 15s, the connection is dead
        if (last_pong && Date.now() - last_pong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
          ws.close()
          return
        }
        ws.send(JSON.stringify({ type: 'ping' }))
      }, HEARTBEAT_INTERVAL)
    }

    ws.onmessage = (ev) => {
      last_pong = Date.now()
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'pong' || msg.type === 'heartbeat') return
        if (msg.type === 'initial_state') {
          callbacks.on_initial_state?.({ tasks: msg.tasks ?? [], links: msg.links ?? [] })
        } else if (msg.type === 'task_status') {
          callbacks.on_task_status?.(msg.task_id, msg.status)
        } else if (msg.type === 'workflow_status') {
          callbacks.on_workflow_status?.(msg.status)
        } else if (msg.type === 'error') {
          callbacks.on_error?.(msg.message)
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      if (heartbeat_id) { clearInterval(heartbeat_id); heartbeat_id = null }
      if (closed) return
      retries++
      if (retries <= FAST_RETRIES) {
        setTimeout(connect, Math.min(1000 * 2 ** retries, 30_000))
      } else {
        // Slow polling phase — keep trying for the lifetime of the job
        setTimeout(connect, SLOW_INTERVAL)
      }
    }

    ws.onerror = () => { ws?.close() }
  }

  connect()

  return {
    close() {
      closed = true
      if (heartbeat_id) { clearInterval(heartbeat_id); heartbeat_id = null }
      ws?.close()
    }
  }
}
