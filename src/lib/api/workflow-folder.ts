/**
 * Workflow Folder API: CRUD for organizing workflows into folders.
 * Mirrors project.ts but operates on the `workflow_folders` table.
 *
 * Three-way routing (same pattern as project.ts):
 *   Tauri → db-local.ts, Desktop → db-wasm.ts, Browser → HTTP fetch
 */

import { check_tauri } from '$lib/io/tauri'
import { API_BASE } from './config'

declare const __CATGO_DESKTOP__: boolean

let local: typeof import('./db-local') | null = null
async function getLocal() {
  if (local) return local
  if (check_tauri()) {
    local = await import('./db-local')
  } else if (typeof __CATGO_DESKTOP__ !== `undefined` && __CATGO_DESKTOP__) {
    local = await import('./db-wasm')
  }
  return local
}

export interface WorkflowFolderSummary {
  id: string
  name: string
  description: string
  parent_id: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowFolderDetail extends WorkflowFolderSummary {
  workflows: Array<{
    id: string
    name: string
    status: string
    step_count: number
    completed_steps: number
  }>
}

async function handle_response<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}

export async function create_workflow_folder(name: string, description = ``, parent_id?: string): Promise<WorkflowFolderSummary> {
  const db = await getLocal()
  if (db) return db.db_create_workflow_folder(name, description, parent_id)
  const params = new URLSearchParams({ name, description })
  if (parent_id) params.set(`parent_id`, parent_id)
  const response = await fetch(`${API_BASE}/workflow/folder/?${params}`, {
    method: `POST`,
  })
  return handle_response(response)
}

export async function list_workflow_folders(): Promise<WorkflowFolderSummary[]> {
  const db = await getLocal()
  if (db) return db.db_list_workflow_folders()
  const response = await fetch(`${API_BASE}/workflow/folder/`)
  return handle_response(response)
}

export async function get_workflow_folder(id: string): Promise<WorkflowFolderDetail> {
  const db = await getLocal()
  if (db) return db.db_get_workflow_folder(id)
  const response = await fetch(`${API_BASE}/workflow/folder/${encodeURIComponent(id)}`)
  return handle_response(response)
}

export async function update_workflow_folder(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<WorkflowFolderSummary> {
  const db = await getLocal()
  if (db) return db.db_update_workflow_folder(id, data)
  const params = new URLSearchParams()
  if (data.name !== undefined) params.set(`name`, data.name)
  if (data.description !== undefined) params.set(`description`, data.description)
  if (data.parent_id === null) {
    params.set(`unset_parent`, `true`)
  } else if (data.parent_id !== undefined) {
    params.set(`parent_id`, data.parent_id)
  }
  const response = await fetch(`${API_BASE}/workflow/folder/${encodeURIComponent(id)}?${params}`, {
    method: `PUT`,
  })
  return handle_response(response)
}

export async function delete_workflow_folder(id: string): Promise<void> {
  const db = await getLocal()
  if (db) return db.db_delete_workflow_folder(id)
  const response = await fetch(`${API_BASE}/workflow/folder/${encodeURIComponent(id)}`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to delete workflow folder`)
  }
}

export async function assign_workflow_to_folder(workflow_id: string, folder_id: string): Promise<void> {
  const db = await getLocal()
  if (db) return db.db_assign_workflow_to_folder(workflow_id, folder_id)
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/folder/${encodeURIComponent(folder_id)}`, {
    method: `PUT`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to assign workflow to folder`)
  }
}

export async function unassign_workflow_from_folder(workflow_id: string): Promise<void> {
  const db = await getLocal()
  if (db) return db.db_unassign_workflow_from_folder(workflow_id)
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/folder`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to unassign workflow from folder`)
  }
}
