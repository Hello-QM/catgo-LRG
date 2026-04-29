/**
 * Tauri invoke wrappers for Rust-side SQLite commands.
 * Only imported when running inside the Tauri desktop shell.
 */

import { invoke } from '@tauri-apps/api/core'
import type { DbInfo, ProjectSummary, ProjectDetail, BrowseResult, EnrichedResult } from './project'

// ---------------------------------------------------------------------------
// DB management
// ---------------------------------------------------------------------------

export function db_get_current(): Promise<DbInfo> {
  return invoke(`db_get_current`)
}

export function db_new(path: string): Promise<DbInfo> {
  return invoke(`db_new`, { path })
}

export function db_open(path: string): Promise<DbInfo> {
  return invoke(`db_open`, { path })
}

export function db_save_as(path: string): Promise<DbInfo> {
  return invoke(`db_save_as`, { path })
}

export function db_browse_directory(dir?: string): Promise<BrowseResult> {
  return invoke(`db_browse_directory`, { dir })
}

// [2026-03] General filesystem browse + read + write
import type { FileBrowseResult, FileReadResult, FileWriteResult, ExportStructureResult, SerializeStructureResult, FileOpResult } from './project'

export function db_browse_files(dir?: string): Promise<FileBrowseResult> {
  return invoke(`db_browse_files`, { dir })
}

export function db_read_file(path: string): Promise<FileReadResult> {
  return invoke(`db_read_file`, { path })
}

export function db_write_file(path: string, content: string): Promise<FileWriteResult> {
  return invoke(`db_write_file`, { path, content })
}

export function db_export_structure(
  structure: Record<string, unknown>,
  path: string,
  format?: string,
): Promise<ExportStructureResult> {
  return invoke(`db_export_structure`, { structure, path, format })
}

export function db_serialize_structure(
  structure: Record<string, unknown>,
  format: string = `cif`,
): Promise<SerializeStructureResult> {
  return invoke(`db_serialize_structure`, { structure, format })
}

// [2026-03] File operations
export function db_fs_mkdir(path: string): Promise<FileOpResult> {
  return invoke(`db_fs_mkdir`, { path })
}

export function db_fs_delete(path: string): Promise<FileOpResult> {
  return invoke(`db_fs_delete`, { path })
}

export function db_fs_rename(old_path: string, new_path: string): Promise<FileOpResult> {
  return invoke(`db_fs_rename`, { oldPath: old_path, newPath: new_path })
}

export function db_fs_copy(source: string, destination: string): Promise<FileOpResult> {
  return invoke(`db_fs_copy`, { source, destination })
}

export function db_fs_move(source: string, destination: string): Promise<FileOpResult> {
  return invoke(`db_fs_move`, { source, destination })
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function db_list_projects(): Promise<ProjectSummary[]> {
  return invoke(`db_list_projects`)
}

export function db_create_project(
  name: string,
  description?: string,
  parent_id?: string,
): Promise<ProjectSummary> {
  return invoke(`db_create_project`, { name, description, parentId: parent_id })
}

export function db_update_project(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<ProjectSummary> {
  return invoke(`db_update_project`, {
    id,
    name: data.name,
    description: data.description,
    parentId: data.parent_id === null ? undefined : data.parent_id,
    unsetParent: data.parent_id === null ? true : undefined,
  })
}

export function db_get_project(id: string): Promise<ProjectDetail> {
  return invoke(`db_get_project`, { id })
}

export function db_get_enriched_results(project_id: string): Promise<EnrichedResult[]> {
  return invoke(`db_get_enriched_results`, { projectId: project_id })
}

export function db_delete_project(id: string): Promise<void> {
  return invoke(`db_delete_project`, { id })
}

export function db_assign_workflow_to_project(workflow_id: string, project_id: string): Promise<void> {
  return invoke(`db_assign_workflow_to_project`, { workflowId: workflow_id, projectId: project_id })
}

// ---------------------------------------------------------------------------
// Workflow Folders
// ---------------------------------------------------------------------------

export interface WorkflowFolderSummary {
  id: string
  name: string
  description: string
  parent_id: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowFolderDetail extends WorkflowFolderSummary {
  workflows: Array<{ id: string; name: string; status: string; step_count: number; completed_steps: number }>
}

export function db_list_workflow_folders(): Promise<WorkflowFolderSummary[]> {
  return invoke(`db_list_workflow_folders`)
}

export function db_create_workflow_folder(
  name: string,
  description?: string,
  parent_id?: string,
): Promise<WorkflowFolderSummary> {
  return invoke(`db_create_workflow_folder`, { name, description, parentId: parent_id })
}

export function db_update_workflow_folder(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<WorkflowFolderSummary> {
  return invoke(`db_update_workflow_folder`, {
    id,
    name: data.name,
    description: data.description,
    parentId: data.parent_id === null ? undefined : data.parent_id,
    unsetParent: data.parent_id === null ? true : undefined,
  })
}

export function db_get_workflow_folder(id: string): Promise<WorkflowFolderDetail> {
  return invoke(`db_get_workflow_folder`, { id })
}

export function db_delete_workflow_folder(id: string): Promise<void> {
  return invoke(`db_delete_workflow_folder`, { id })
}

export function db_assign_workflow_to_folder(workflow_id: string, folder_id: string): Promise<void> {
  return invoke(`db_assign_workflow_to_folder`, { workflowId: workflow_id, folderId: folder_id })
}

export function db_unassign_workflow_from_folder(workflow_id: string): Promise<void> {
  return invoke(`db_unassign_workflow_from_folder`, { workflowId: workflow_id })
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export function db_list_workflows(): Promise<Array<{
  id: string
  name: string
  description: string
  status: string
  template_id: string | null
  project_id: string | null
  created_at: string
  updated_at: string
  step_count: number
  completed_steps: number
}>> {
  return invoke(`db_list_workflows`)
}

export function db_create_workflow(
  name: string,
  graph_json: string,
  description?: string,
  template_id?: string,
): Promise<Record<string, unknown>> {
  return invoke(`db_create_workflow`, { name, graphJson: graph_json, description, templateId: template_id })
}

export function db_get_workflow_detail(id: string): Promise<Record<string, unknown>> {
  return invoke(`db_get_workflow_detail`, { id })
}

export function db_update_workflow(
  id: string,
  data: { name?: string; description?: string; graph_json?: string; status?: string; metadata?: string },
): Promise<Record<string, unknown>> {
  return invoke(`db_update_workflow`, { id, name: data.name, description: data.description, graphJson: data.graph_json, status: data.status, metadata: data.metadata })
}

export function db_delete_workflow(id: string): Promise<void> {
  return invoke(`db_delete_workflow`, { id })
}

export function db_list_steps(workflow_id: string): Promise<Array<Record<string, unknown>>> {
  return invoke(`db_list_steps`, { workflowId: workflow_id })
}

// ---------------------------------------------------------------------------
// Workflow Execution (M4: Tauri direct engine)
// ---------------------------------------------------------------------------

export function db_run_workflow(workflow_id: string, config_json: string): Promise<string> {
  return invoke(`db_run_workflow`, { workflowId: workflow_id, configJson: config_json })
}

export function db_pause_workflow(workflow_id: string): Promise<void> {
  return invoke(`db_pause_workflow`, { workflowId: workflow_id })
}

export function db_resume_workflow(workflow_id: string, config_json: string): Promise<string> {
  return invoke(`db_resume_workflow`, { workflowId: workflow_id, configJson: config_json })
}

export function db_get_run_status(workflow_id: string): Promise<{
  workflow_id: string
  status: string
  progress: number
  steps: Array<{ id: string; status: string; hpc_job_id?: string; tool?: string; label?: string }>
}> {
  return invoke(`db_get_run_status`, { workflowId: workflow_id })
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function db_query_results(
  workflow_id: string,
): Promise<{ results: Array<Record<string, unknown>>; count: number }> {
  return invoke(`db_query_results`, { workflowId: workflow_id })
}

export function db_update_result_label(
  row_id: number,
  label: string,
): Promise<{ row_id: number; label: string }> {
  return invoke(`db_update_result_label`, { rowId: row_id, label })
}

export function db_delete_result(row_id: number): Promise<void> {
  return invoke(`db_delete_result`, { rowId: row_id })
}

export function db_move_or_copy_result(
  row_id: number,
  project_id: string,
): Promise<{ row_id: number; project_id: string; action: string }> {
  return invoke(`db_move_or_copy_result`, { rowId: row_id, projectId: project_id })
}

export function db_get_result_structure(row_id: number): Promise<Record<string, unknown>> {
  return invoke(`db_get_result_structure`, { rowId: row_id })
}

export function db_save_structure(
  structure: Record<string, unknown>,
  name: string,
  project_id?: string,
): Promise<{ row_id: number; formula: string }> {
  return invoke(`db_save_structure`, { structure, name, projectId: project_id })
}
