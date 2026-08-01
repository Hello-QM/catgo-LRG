/**
 * Project management API client: CRUD for workflow projects.
 *
 * [2025-02] Three-way routing:
 *   Tauri (tauri:dev)     → db-local.ts → invoke() → Rust (rusqlite)
 *   Desktop (desktop:dev) → db-wasm.ts  → sql.js   + Vite middleware (file I/O)
 *   Desktop (desktop:serve) → fetch()   → Python FastAPI (backend available)
 *   Browser (dev)         → null        → fetch()  → Python FastAPI
 *
 * [2026-03] desktop:serve fix: when Python backend is running, data CRUD operations
 * use HTTP instead of WASM.  The WASM db caches in-memory and doesn't see changes
 * made by the Python backend (e.g. MCP/CatBot workflow tools).  File management
 * Database-open operations still use WASM/Tauri storage. Filesystem operations
 * use the Python API whenever that backend is available; the `/__files/*`
 * middleware only exists in Vite development and is not served by the bundled
 * production SPA.
 */

import { check_tauri } from '$lib/io/tauri'
import { API_BASE, desktop_backend_available } from './config'

declare const __CATGO_DESKTOP__: boolean // set by vite.desktop.config.ts define

let local: typeof import('./db-local') | null = null
async function getLocal() {
  if (local) return local
  if (check_tauri()) {
    local = await import('./db-local')
  } else if (typeof __CATGO_DESKTOP__ !== `undefined` && __CATGO_DESKTOP__) {
    local = await import('./db-wasm') // [2025-02] sql.js WASM SQLite for desktop:dev
  }
  return local
}

/** [2026-03] Get the local DB module, but return null if the Python backend should be
 * used instead.  Use this for data CRUD ops.  For file management ops (db_open,
 * browse_directory, etc.), use getLocal() directly. */
async function getLocalForData() {
  if (check_tauri()) return getLocal()
  if (await desktop_backend_available()) return null
  return getLocal()
}

/** Route host-filesystem operations through FastAPI in backend-served builds.
 * A desktop production bundle still defines `__CATGO_DESKTOP__`, so blindly
 * calling getLocal() selects db-wasm and its Vite-only `/__files/*` routes.
 * FastAPI then serves index.html via the SPA fallback, which looks like a
 * silent click and eventually fails JSON parsing on `<!DOCTYPE html>`.
 */
async function getLocalForFiles() {
  if (check_tauri()) return getLocal()
  if (await desktop_backend_available()) return null
  return getLocal()
}

export interface ProjectSummary {
  id: string
  name: string
  description: string
  ase_db_path?: string
  parent_id?: string | null
  created_at: string
  updated_at: string
  workflow_count?: number
}

export interface ProjectDetail extends ProjectSummary {
  workflows: Array<{
    id: string
    name: string
    status: string
    step_count: number
    completed_steps: number
    created_at: string
  }>
}

async function handle_response<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}

export async function create_project(name: string, description = ``, parent_id?: string): Promise<ProjectSummary> {
  const db = await getLocalForData()
  if (db) return db.db_create_project(name, description, parent_id)
  const params = new URLSearchParams({ name, description })
  if (parent_id) params.set(`parent_id`, parent_id)
  const response = await fetch(`${API_BASE}/workflow/project/?${params}`, {
    method: `POST`,
  })
  return handle_response(response)
}

export async function list_projects(): Promise<ProjectSummary[]> {
  const db = await getLocalForData()
  if (db) return db.db_list_projects()
  const response = await fetch(`${API_BASE}/workflow/project/`)
  return handle_response(response)
}

export async function get_project(id: string): Promise<ProjectDetail> {
  const db = await getLocalForData()
  if (db) return db.db_get_project(id)
  const response = await fetch(`${API_BASE}/workflow/project/${encodeURIComponent(id)}`)
  return handle_response(response)
}

export async function update_project(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<ProjectSummary> {
  const db = await getLocalForData()
  if (db) return db.db_update_project(id, data)
  const params = new URLSearchParams()
  if (data.name !== undefined) params.set(`name`, data.name)
  if (data.description !== undefined) params.set(`description`, data.description)
  if (data.parent_id === null) {
    params.set(`unset_parent`, `true`)
  } else if (data.parent_id !== undefined) {
    params.set(`parent_id`, data.parent_id)
  }
  const response = await fetch(`${API_BASE}/workflow/project/${encodeURIComponent(id)}?${params}`, {
    method: `PUT`,
  })
  return handle_response(response)
}

export async function delete_project(id: string): Promise<void> {
  const db = await getLocalForData()
  if (db) return db.db_delete_project(id)
  const response = await fetch(`${API_BASE}/workflow/project/${encodeURIComponent(id)}`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to delete project`)
  }
}

export async function assign_workflow_to_project(workflow_id: string, project_id: string): Promise<void> {
  const db = await getLocalForData()
  if (db) return db.db_assign_workflow_to_project(workflow_id, project_id)
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/project/${encodeURIComponent(project_id)}`, {
    method: `PUT`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to assign workflow to project`)
  }
}

export async function unassign_workflow_from_project(workflow_id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(workflow_id)}/project`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to unassign workflow from project`)
  }
}

/** Update the display label of a result */
export async function update_result_label(row_id: number, label: string): Promise<{ row_id: number; label: string }> {
  const db = await getLocalForData()
  if (db) return db.db_update_result_label(row_id, label)
  const response = await fetch(`${API_BASE}/workflow/results/${row_id}/label?label=${encodeURIComponent(label)}`, {
    method: `PUT`,
  })
  return handle_response(response)
}

/** Delete a result from the ASE database */
export async function delete_result(row_id: number): Promise<void> {
  const db = await getLocalForData()
  if (db) return db.db_delete_result(row_id)
  const response = await fetch(`${API_BASE}/workflow/results/${row_id}`, {
    method: `DELETE`,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(error.detail || `Failed to delete result`)
  }
}

/** Drag a result to a project (backend auto-decides copy vs move based on node_type)
 * [2025-02] Renamed from move_result_to_project; returns action: "moved"|"copied" */
export async function drag_result_to_project(row_id: number, project_id: string): Promise<{ row_id: number; project_id: string; action: string }> {
  const db = await getLocalForData()
  if (db) return db.db_move_or_copy_result(row_id, project_id)
  const response = await fetch(`${API_BASE}/workflow/results/${row_id}/move/${encodeURIComponent(project_id)}`, {
    method: `PUT`,
  })
  return handle_response(response)
}

/** Enriched result with computed columns for dashboard display */
export interface EnrichedResult {
  id: number | null
  formula: string | null
  energy: number | null
  energy_per_atom: number | null
  natoms: number | null
  volume: number | null
  a: number | null
  b: number | null
  c: number | null
  alpha: number | null
  beta: number | null
  gamma: number | null
  workflow_id: string
  workflow_name: string
  step_id: string
  step_label: string
  node_type: string
  // Optional fields from ORCA convergence expansion
  energy_eh?: number | null
  wavelength_nm?: number | null
  oscillator_strength?: number | null
  // Convergence data for opt/neb_ts/irc (energy vs step plot)
  convergence_points?: Array<{ step: number; energy: number; [key: string]: unknown }>
  // Vibrational frequency data (for orca_freq)
  frequencies?: Array<{
    index: number
    frequency_cm: number
    imaginary: boolean
    ir_intensity_km_mol?: number
  }>
  num_imaginary?: number
  // UV-Vis absorption states (for orca_uvvis spectrum plot)
  absorption_states?: Array<{ wavelength_nm: number; oscillator_strength: number; state?: number }>
  n_transitions?: number | null
  brightest_wavelength_nm?: number | null
  // NEB-TS specific fields (for orca_neb_ts)
  activation_barrier_kcal_mol?: number | null
  neb_converged?: boolean
  path_summary?: {
    images: Array<{ image: string; de_kcal_mol: number; is_ci?: boolean; is_ts?: boolean }>
  }
  // Per-iteration image energies from ORCA.interp (NEB-TS only)
  image_energies?: Record<string, Array<[number, number]>>
}

/** Get enriched results for a project (aggregated from all workflows) */
export async function get_enriched_results(project_id: string): Promise<EnrichedResult[]> {
  // Always use HTTP (Python backend) to ensure fresh results from ASE database.
  // The WASM db caches in-memory and doesn't reload when the Python backend writes results.
  const response = await fetch(`${API_BASE}/workflow/project/${encodeURIComponent(project_id)}/results-enriched`)
  const data = await handle_response<{ results: EnrichedResult[]; count: number }>(response)
  return data.results
}

/** Get a result as PymatgenStructure JSON (for loading into viewer) */
export async function get_result_structure(row_id: number): Promise<Record<string, unknown>> {
  const db = await getLocalForData()
  if (db) return db.db_get_result_structure(row_id)
  const response = await fetch(`${API_BASE}/workflow/results/${row_id}/structure`)
  return handle_response(response)
}

/** Save a structure to the ASE database */
export async function save_structure_to_db(
  structure: Record<string, unknown>,
  name: string,
  project_id?: string,
): Promise<{ row_id: number; formula: string }> {
  const db = await getLocalForData()
  if (db) return db.db_save_structure(structure, name, project_id)
  const response = await fetch(`${API_BASE}/workflow/results/save-structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, name, project_id }),
  })
  return handle_response(response)
}

/** Query ASE database results for a project */
export async function get_project_results(project_id: string): Promise<{
  results: Array<Record<string, unknown>>
  count: number
}> {
  // Project results are aggregated from all project workflows
  const project = await get_project(project_id)
  const all_results: Record<string, unknown>[] = []

  for (const wf of project.workflows) {
    try {
      const response = await fetch(`${API_BASE}/workflow/${encodeURIComponent(wf.id)}/results`)
      if (response.ok) {
        const data = await response.json()
        all_results.push(...(data.results || []))
      }
    } catch (e) {
      // Non-critical: skip workflows whose results can't be fetched (e.g. deleted or no results yet)
      console.debug(`[project] Skipped results for workflow ${wf.id}:`, e)
    }
  }

  return { results: all_results, count: all_results.length }
}

// [2025-02] Database management API

export interface DbInfo {
  path: string
  name: string
}

/** Get the current active ASE database info */
export async function get_current_db(): Promise<DbInfo> {
  const db = await getLocal()
  if (db) {
    const info = await db.db_get_current()
    // Sync Python backend to the same DB on startup
    await sync_backend_db(`open`, info.path)
    return info
  }
  const response = await fetch(`${API_BASE}/workflow/db/current`)
  return handle_response(response)
}

/** Notify Python backend to switch its active DB to the same path.
 * Fire-and-forget — don't block the Tauri operation if backend is unavailable. */
async function sync_backend_db(endpoint: string, path: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/workflow/db/${endpoint}?path=${encodeURIComponent(path)}`, {
      method: `POST`,
    })
  } catch {
    // Backend may not be running yet — fire-and-forget sync is intentional
  }
}

/** Create a new empty database at the given path and switch to it */
export async function create_new_db(path: string): Promise<DbInfo> {
  const db = await getLocal()
  if (db) {
    const result = await db.db_new(path)
    await sync_backend_db(`new`, path)
    return result
  }
  const response = await fetch(`${API_BASE}/workflow/db/new?path=${encodeURIComponent(path)}`, {
    method: `POST`,
  })
  return handle_response(response)
}

/** Open an existing database file and switch to it */
export async function open_db(path: string): Promise<DbInfo> {
  const db = await getLocal()
  if (db) {
    const result = await db.db_open(path)
    await sync_backend_db(`open`, path)
    return result
  }
  const response = await fetch(`${API_BASE}/workflow/db/open?path=${encodeURIComponent(path)}`, {
    method: `POST`,
  })
  return handle_response(response)
}

/** Save current database to a new path (copy) and switch to it */
export async function save_db_as(path: string): Promise<DbInfo> {
  const db = await getLocal()
  if (db) {
    const result = await db.db_save_as(path)
    await sync_backend_db(`save-as`, path)
    return result
  }
  const response = await fetch(`${API_BASE}/workflow/db/save-as?path=${encodeURIComponent(path)}`, {
    method: `POST`,
  })
  return handle_response(response)
}

/** [2025-02] Browse server filesystem for the in-app file picker */
export interface BrowseResult {
  dir: string
  parent: string
  items: Array<{ name: string; type: 'dir' | 'file'; path: string }>
}

export async function browse_directory(dir = '~'): Promise<BrowseResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_browse_directory(dir)
  const response = await fetch(`${API_BASE}/workflow/db/browse?dir=${encodeURIComponent(dir)}`)
  return handle_response(response)
}

// [2026-03] General filesystem browser (all files, not filtered to .db)

export interface FileBrowseItem {
  name: string
  type: 'dir' | 'file'
  path: string
}

export interface FileBrowseResult {
  dir: string
  parent: string
  items: FileBrowseItem[]
}

export async function browse_files(dir = '~'): Promise<FileBrowseResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_browse_files(dir)
  const response = await fetch(`${API_BASE}/workflow/files/browse?dir=${encodeURIComponent(dir)}`)
  return handle_response(response)
}

export interface FileReadResult {
  path: string
  name: string
  content: string
}

export async function read_file(path: string): Promise<FileReadResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_read_file(path)
  const response = await fetch(`${API_BASE}/workflow/files/read?path=${encodeURIComponent(path)}`)
  return handle_response(response)
}

export interface FileWriteResult {
  path: string
  name: string
}

export async function write_file(path: string, content: string): Promise<FileWriteResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_write_file(path, content)
  const response = await fetch(`${API_BASE}/workflow/files/write`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ path, content }),
  })
  return handle_response(response)
}

export interface ExportStructureResult {
  path: string
  name: string
  format: string
}

export async function export_structure(
  structure: Record<string, unknown>,
  path: string,
  format?: string,
): Promise<ExportStructureResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_export_structure(structure, path, format)
  const response = await fetch(`${API_BASE}/workflow/files/export-structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, path, format }),
  })
  return handle_response(response)
}

export interface SerializeStructureResult {
  content: string
  format: string
}

/** Serialize a structure to text content without writing to disk (for HPC export). */
export async function serialize_structure(
  structure: Record<string, unknown>,
  format: string = `cif`,
): Promise<SerializeStructureResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_serialize_structure(structure, format)
  const response = await fetch(`${API_BASE}/workflow/files/serialize-structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, format }),
  })
  return handle_response(response)
}

// ====== Local File Operations ======

export interface FileOpResult {
  success: boolean
  message: string
}

export async function fs_mkdir(path: string): Promise<FileOpResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_fs_mkdir(path)
  const response = await fetch(`${API_BASE}/workflow/files/mkdir`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ path }),
  })
  return handle_response(response)
}

export async function fs_delete(path: string): Promise<FileOpResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_fs_delete(path)
  const response = await fetch(`${API_BASE}/workflow/files/delete`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ path }),
  })
  return handle_response(response)
}

export async function fs_rename(old_path: string, new_path: string): Promise<FileOpResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_fs_rename(old_path, new_path)
  const response = await fetch(`${API_BASE}/workflow/files/rename`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ old_path, new_path }),
  })
  return handle_response(response)
}

export async function fs_copy(source: string, destination: string): Promise<FileOpResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_fs_copy(source, destination)
  const response = await fetch(`${API_BASE}/workflow/files/copy`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ source, destination }),
  })
  return handle_response(response)
}

export async function fs_move(source: string, destination: string): Promise<FileOpResult> {
  const db = await getLocalForFiles()
  if (db) return db.db_fs_move(source, destination)
  const response = await fetch(`${API_BASE}/workflow/files/move`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ source, destination }),
  })
  return handle_response(response)
}
