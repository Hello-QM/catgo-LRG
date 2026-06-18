/**
 * Export / Save dialog handlers — extracted from App.svelte.
 *
 * Functions for opening export dialogs and executing exports
 * to project DB, HPC, or local filesystem.
 */

import { exp } from '../state/export-state.svelte'
import { sidebar } from '../state/sidebar-state.svelte'
import { auto_name as _auto_name, serialize_structure_content } from '../pane-utils'
import { save_structure_to_db, write_file } from '$lib/api/project'
import { writeRemoteFile } from '$lib/api/hpc'

export interface ExportHandlerDeps {
  close_panel: (tab_id: string, leaf_id: string) => void
  load_close_save_projects: () => void
}

export async function export_fs_browse(dir: string) {
  exp.fs_loading = true
  try {
    const { browse_files } = await import(`$lib/api/project`)
    const result = await browse_files(dir)
    exp.fs_dir = result.dir
    exp.fs_items = result.items.filter((i: { type: string }) => i.type === `dir`)
  } catch {
    exp.fs_items = []
  } finally {
    exp.fs_loading = false
  }
}

export function open_save_dialog(deps: ExportHandlerDeps, structure: Record<string, unknown>) {
  exp.pending_structure = structure
  exp.error = ``
  deps.load_close_save_projects()
  const name = _auto_name(structure)
  exp.dialog = { mode: `project`, filename: `${name}.cif`, format: `cif` }
}

export function open_export_to_hpc(structure: Record<string, unknown>) {
  exp.pending_structure = structure
  exp.error = ``
  exp.dialog = { mode: `hpc`, filename: `structure.cif`, format: `cif` }
}

export function open_export_to_file(structure: Record<string, unknown>) {
  exp.pending_structure = structure
  exp.error = ``
  const name = _auto_name(structure)
  exp.dialog = { mode: `file`, filename: `${name}.cif`, format: `cif` }
  // Initialize directory picker with sidebar path or home
  export_fs_browse(sidebar.fs_path || `~`)
}

export async function do_export(deps: ExportHandlerDeps) {
  if (!exp.dialog) return
  const structure = exp.pending_structure
  if (!structure) { exp.error = `No structure to export`; return }

  exp.saving = true
  exp.error = ``
  try {
    if (exp.dialog.mode === `project`) {
      // Database export: save directly, no serialization needed
      const name = exp.dialog.filename.replace(/\.[^.]+$/, ``)
      await save_structure_to_db(structure, name, exp.close_save_project_id || undefined)
      sidebar.refresh_counter++
    } else {
      // File/HPC export: use frontend serializers (preserves pseudo-H labels)
      const content = await serialize_structure_content(structure, exp.dialog.format)

      if (exp.dialog.mode === `hpc`) {
        const session_id = sidebar.source !== `catgo` && sidebar.source !== `localdb` ? sidebar.source : null
        if (!session_id) { exp.error = `No HPC session connected`; exp.saving = false; return }
        const hpc_dir = sidebar.hpc_path || `~`
        const sep = hpc_dir.endsWith(`/`) ? `` : `/`
        await writeRemoteFile(session_id, `${hpc_dir}${sep}${exp.dialog.filename}`, content)
      } else if (exp.dialog.mode === `file`) {
        if (!exp.fs_dir) { exp.error = `No directory selected`; exp.saving = false; return }
        const sep = exp.fs_dir.includes(`\\`) ? `\\` : `/`
        await write_file(`${exp.fs_dir}${sep}${exp.dialog.filename}`, content)
      }
    }
    exp.dialog = null
    if (exp.close_after) {
      deps.close_panel(exp.close_after.tab_id, exp.close_after.leaf_id)
      exp.close_after = null
    }
  } catch (e) {
    exp.error = e instanceof Error ? e.message : `Export failed`
  } finally {
    exp.saving = false
  }
}
