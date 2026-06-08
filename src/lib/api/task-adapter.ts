// src/lib/api/task-adapter.ts
// Unified data-fetching adapter for V1 workflow steps and V2 engine tasks.
// NodeStatusPanel calls these instead of directly importing V1 or V2 APIs.

import * as v1 from './workflow'
import * as v2 from './workflow-v2'

// --- Discriminated union for task identity ---

export type TaskRef =
  | { mode: 'step'; workflow_id: string; node_id: string }
  | { mode: 'task'; task_id: string }

// --- Normalized types ---

export interface NormalizedFileEntry {
  name: string
  size: string          // human-readable string (matches V1 format)
  size_bytes: number
  modified: string      // ISO timestamp
  is_dir: boolean
  permissions?: string
}

export interface NormalizedConvergence {
  points: v1.ConvergencePoint[]
  converged: boolean
  message?: string
  convergence_thresholds?: { max_grad: number; rms_grad: number }
  image_energies?: Record<string, Array<[number, number]>>
}

export interface NormalizedFileContent {
  path: string
  content: string
}

// --- Adapter functions ---

/** List files in the task's work directory */
export async function get_files(
  ref: TaskRef,
  subdir?: string,
): Promise<{ files: NormalizedFileEntry[]; work_dir: string }> {
  if (ref.mode === 'step') {
    const data = await v1.get_step_files(ref.workflow_id, ref.node_id, subdir)
    return {
      work_dir: data.work_dir ?? '',
      files: (data.files ?? [])
        .filter(f => f.name !== '.' && f.name !== '..')
        .map(f => ({
          name: f.name,
          size: f.size ?? '0',
          size_bytes: parseInt(f.size ?? '0') || 0,
          modified: f.modified ?? '',
          is_dir: f.permissions?.startsWith('d') ?? false,
          permissions: f.permissions,
        })),
    }
  } else {
    const data = await v2.get_engine_task_files(ref.task_id, subdir ?? '')
    return {
      work_dir: data.work_dir ?? '',
      files: data.files.map(f => ({
        name: f.name,
        size: format_bytes(f.size_bytes),
        size_bytes: f.size_bytes,
        modified: f.modified_time ?? '',
        is_dir: f.is_dir,
      })),
    }
  }
}

/** Get convergence data */
export async function get_convergence(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    return v1.get_convergence(ref.workflow_id, ref.node_id)
  } else {
    const data = await v2.get_engine_task_convergence(ref.task_id)
    return { points: data.points, converged: data.converged, message: data.message, convergence_thresholds: data.convergence_thresholds, image_energies: data.image_energies }
  }
}

/** Live per-iteration progress for MLP steps (mlp_relax / mlp_neb).
 *
 * V2 task-mode returns a soft failure (empty points + explanatory message)
 * rather than throwing, so the NodeStatusPanel's `.catch(console.warn)`
 * can't silently swallow it — the UI renders the message and the user
 * knows why the plot is empty instead of guessing.
 *
 * The V1 path covers step-mode refs. _engine_get_step_status inside the
 * V1 endpoint already handles the V2 lookup internally, so workflows
 * created under either engine work through this path. */
export async function get_mlp_progress(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    const data = await v1.get_mlp_progress(ref.workflow_id, ref.node_id)
    return { points: data.points, converged: data.converged, message: data.message }
  }
  // V2 task-mode: hit the V2-native endpoint, which parses the SAME ASE
  // optimizer log via the V1 parser. `converged` may come back null when the
  // task's fmax target is unresolvable — pass it through unchanged so the
  // status-sync branch in NodeStatusPanel keeps the node "running" rather than
  // treating it as converged (the V1 step-mode path above does the same).
  const data = await v2.get_engine_task_mlp_progress(ref.task_id)
  return {
    points: data.points,
    converged: data.converged as NormalizedConvergence['converged'],
    message: data.message,
  }
}

/** Read file content */
export async function get_file_content(
  ref: TaskRef,
  filename: string,
): Promise<NormalizedFileContent> {
  if (ref.mode === 'step') {
    const data = await v1.get_step_output(ref.workflow_id, ref.node_id, filename)
    return { path: filename, content: data.content }
  } else {
    const data = await v2.get_engine_task_file_content(ref.task_id, filename)
    return { path: data.path, content: data.content }
  }
}

/** Write file content */
export async function put_file_content(
  ref: TaskRef,
  filename: string,
  content: string,
): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('File editing not supported for V1 steps')
  } else {
    await v2.put_engine_task_file_content(ref.task_id, filename, content)
  }
}

/** Get frequency data */
export async function get_frequencies(ref: TaskRef): Promise<Record<string, unknown>> {
  if (ref.mode === 'step') {
    return v1.get_vasp_frequencies(ref.workflow_id, ref.node_id) as unknown as Record<string, unknown>
  } else {
    return v2.get_engine_task_frequencies(ref.task_id)
  }
}

/** Retry / rerun from this node */
export async function retry(ref: TaskRef): Promise<{ message: string }> {
  if (ref.mode === 'step') {
    const { API_BASE } = await import('./config')
    const res = await fetch(
      `${API_BASE}/workflow/${ref.workflow_id}/steps/${ref.node_id}/retry`,
      { method: 'POST' },
    )
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText)
    const data = await res.json()
    return { message: `Reset ${data.reset_nodes?.length ?? 0} nodes to pending` }
  } else {
    const data = await v2.retry_v2_task(ref.task_id)
    return { message: `Reset ${data.reset_tasks?.length ?? 0} tasks` }
  }
}

/** Cancel a running task (engine only) */
export async function cancel(ref: TaskRef): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('Cancel not supported for V1 steps')
  } else {
    await v2.cancel_v2_task(ref.task_id)
  }
}

/** Confirm a PENDING_REVIEW task (engine only) */
export async function confirm(ref: TaskRef): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('Confirm not supported for V1 steps')
  } else {
    await v2.confirm_engine_task(ref.task_id)
  }
}

/** Reject a PENDING_REVIEW task (engine only) */
export async function reject(ref: TaskRef): Promise<void> {
  if (ref.mode === 'step') {
    throw new Error('Reject not supported for V1 steps')
  } else {
    await v2.reject_engine_task(ref.task_id)
  }
}

/** Get ORCA convergence / progress */
export async function get_orca_progress(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    return v1.get_orca_progress(ref.workflow_id, ref.node_id)
  } else {
    return get_convergence(ref)
  }
}

/** Get step results from DB (V1) or convergence (V2) */
export async function get_step_results(ref: TaskRef): Promise<NormalizedConvergence> {
  if (ref.mode === 'step') {
    const data = await v1.get_step_results(ref.workflow_id, ref.node_id)
    return { points: data.points, converged: data.converged ?? false, message: data.message }
  } else {
    return get_convergence(ref)
  }
}

/** Normalize engine task status to V1-style lowercase */
export function normalize_status(status: string): string {
  const lower = status.toLowerCase()
  const MAP: Record<string, string> = {
    'remote_error': 'failed',
    'pending_review': 'pending_review',
    'waiting': 'pending',
    'ready': 'pending',
    'generating': 'running',
    'uploading': 'running',
    'submitted': 'queued',
    'queued': 'queued',
    'completed_remote': 'completed',
    'collecting': 'running',
    'cancelled': 'failed',
    'paused': 'pending',
  }
  return MAP[lower] ?? lower
}

// --- Helpers ---

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
