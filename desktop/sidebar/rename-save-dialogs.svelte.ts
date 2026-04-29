/**
 * 5D: Rename & save dialog state and handlers.
 * Extracted from Sidebar.svelte.
 *
 * Uses factory function pattern — $state must be created in component context.
 */

import type { ProjectSummary } from '$lib/api/project'
import { update_project, update_result_label, save_structure_to_db, assign_workflow_to_project } from '$lib/api/project'
import type { DbResult } from '../sidebar-data'

export interface RenameSaveCallbacks {
  get_db_projects: () => ProjectSummary[]
  load_db: () => Promise<void>
  on_save_structure?: () => Record<string, unknown> | null
  on_save_workflow?: () => string | null
}

export function create_rename_save_state(callbacks: RenameSaveCallbacks) {
  let renaming_project_id = $state<string | null>(null)
  let renaming_result_id = $state<number | null>(null)
  let rename_value = $state(``)
  let saving = $state(false)
  let show_save_dialog = $state(false)
  let save_target_project = $state<string | null>(null)

  // --- Project rename ---
  function start_rename_project(project_id: string) {
    renaming_project_id = project_id
    rename_value = callbacks.get_db_projects().find(p => p.id === project_id)?.name || ``
  }

  async function finish_rename_project() {
    if (!renaming_project_id || !rename_value.trim()) {
      renaming_project_id = null
      return
    }
    try {
      await update_project(renaming_project_id, { name: rename_value.trim() })
      await callbacks.load_db()
    } catch (e) {
      console.error(`Failed to rename project:`, e)
    }
    renaming_project_id = null
  }

  // --- Result rename ---
  function start_rename_result(result: DbResult) {
    renaming_result_id = result.id
    rename_value = result.label || result.formula
  }

  async function finish_rename_result() {
    if (!renaming_result_id || !rename_value.trim()) {
      renaming_result_id = null
      return
    }
    try {
      await update_result_label(renaming_result_id, rename_value.trim())
      await callbacks.load_db()
    } catch (e) {
      console.error(`Failed to rename result:`, e)
    }
    renaming_result_id = null
  }

  // [2025-02] Unified save: saves workflow if active pane is workflow, else structure
  async function do_save_current(project_id: string | null) {
    const wf_id = callbacks.on_save_workflow?.()
    if (wf_id) {
      saving = true
      try {
        const pid = project_id || save_target_project
        if (!pid) { alert(`Select a folder first`); return }
        await assign_workflow_to_project(wf_id, pid)
        show_save_dialog = false
        save_target_project = null
        await callbacks.load_db()
      } catch (e) {
        alert(`Save failed: ${e instanceof Error ? e.message : e}`)
      } finally {
        saving = false
      }
      return
    }
    if (!callbacks.on_save_structure) return
    const structure = callbacks.on_save_structure()
    if (!structure) {
      alert(`No structure loaded in viewer`)
      return
    }
    saving = true
    try {
      const pid = project_id || save_target_project
      const result = await save_structure_to_db(structure, ``, pid || undefined)
      alert(`Saved as ${result.formula} (row ${result.row_id})`)
      show_save_dialog = false
      save_target_project = null
      // [2025-02] Full refresh so new result appears immediately
      await callbacks.load_db()
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      saving = false
    }
  }

  return {
    get renaming_project_id() { return renaming_project_id },
    set renaming_project_id(v: string | null) { renaming_project_id = v },
    get renaming_result_id() { return renaming_result_id },
    set renaming_result_id(v: number | null) { renaming_result_id = v },
    get rename_value() { return rename_value },
    set rename_value(v: string) { rename_value = v },
    get saving() { return saving },
    set saving(v: boolean) { saving = v },
    get show_save_dialog() { return show_save_dialog },
    set show_save_dialog(v: boolean) { show_save_dialog = v },
    get save_target_project() { return save_target_project },
    set save_target_project(v: string | null) { save_target_project = v },
    start_rename_project,
    finish_rename_project,
    start_rename_result,
    finish_rename_result,
    do_save_current,
  }
}
