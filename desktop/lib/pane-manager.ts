/**
 * Pane close/unload management — extracted from App.svelte.
 *
 * Functions for handling pane close confirmation, save-and-close,
 * and project listing for save dialogs.
 */

import type { PaneState, StructureTabState, LayoutType } from '../pane-utils'
import { layout_panel_count, create_empty_pane, pane_has_content, auto_name as _auto_name, serialize_structure_content } from '../pane-utils'
import { exp } from '../state/export-state.svelte'
import { sidebar } from '../state/sidebar-state.svelte'
import { list_projects, save_structure_to_db, write_file } from '$lib/api/project'
import { writeRemoteFile } from '$lib/api/hpc'

export interface PaneManagerDeps {
  tab_states: Record<string, StructureTabState>
  update_tab_label: (tab_id: string) => void
  export_fs_browse: (dir: string) => void
}

export function handle_unload(deps: PaneManagerDeps, tab_id: string, pane_idx: number) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const pane = ts.panes[pane_idx]
  // Workflow panes: only prompt if user has opened/edited a workflow
  if (pane.mode === 'workflow') {
    if (pane.modified) {
      ts.close_confirm_pane = pane_idx
      return
    }
    close_panel(deps, tab_id, pane_idx)
    return
  }
  // Structure panes: prompt if has content
  const has_content = !!(pane.structure || pane.trajectory || pane.cube_file)
  if (has_content) {
    ts.close_confirm_pane = pane_idx
    init_close_save_target(pane)
    if (pane.structure) load_close_save_projects()
    return
  }
  close_panel(deps, tab_id, pane_idx)
}

export function close_panel(deps: PaneManagerDeps, tab_id: string, pane_idx: number) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const panel_count = layout_panel_count(ts.layout)

  // If only 1 panel, reset to single empty (don't close the tab)
  if (panel_count <= 1) {
    ts.panes[0] = create_empty_pane()
    ts.layout = 'single'
    ts.active_pane = 0
    ts.close_confirm_pane = null
    deps.update_tab_label(tab_id)
    return
  }

  // Clear the panel being closed
  ts.close_confirm_pane = null
  ts.panes[pane_idx] = create_empty_pane()

  // Consolidate non-empty panes to lower indices
  const visible: PaneState[] = []
  for (let i = 0; i < panel_count; i++) {
    if (i !== pane_idx) visible.push(ts.panes[i])
  }

  // Fill remaining slots with empty panes
  for (let i = 0; i < 4; i++) {
    ts.panes[i] = i < visible.length ? visible[i] : create_empty_pane()
  }

  // Reduce layout: 4->splitH, 2->single
  const new_count = panel_count - 1
  if (new_count <= 1) ts.layout = 'single'
  else if (new_count <= 2) ts.layout = ts.layout === 'splitV' ? 'splitV' : 'splitH'
  // new_count === 3 from quad -> go to splitH
  else ts.layout = 'splitH'

  if (ts.active_pane >= layout_panel_count(ts.layout)) ts.active_pane = 0
  deps.update_tab_label(tab_id)
}

export async function load_close_save_projects() {
  try {
    exp.close_save_projects = await list_projects()
    exp.close_save_project_id = exp.close_save_projects[0]?.id || null
  } catch {
    exp.close_save_projects = []
  }
}

export function init_close_save_target(pane: PaneState) {
  if (pane.local_file_path) exp.close_save_target = `local`
  else if (pane.remote_origin?.session_id) exp.close_save_target = `hpc`
  else exp.close_save_target = `project`
}

export async function save_and_close_panel(deps: PaneManagerDeps, tab_id: string, pane_idx: number) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const pane = ts.panes[pane_idx]
  const structure = (pane.saveable_structure ?? pane.structure) as Record<string, unknown> | undefined
  if (!structure) {
    close_panel(deps, tab_id, pane_idx)
    return
  }
  exp.close_saving = true
  try {
    if (exp.close_save_target === `local`) {
      // Open export dialog with folder browser, close panel after save
      exp.close_after = { tab_id, pane_idx }
      ts.close_confirm_pane = null
      const name = _auto_name(structure)
      exp.pending_structure = structure
      exp.error = ``
      if (pane.local_file_path) {
        // Pre-populate with original file's directory and name
        const parts = pane.local_file_path.replace(/\\/g, `/`).split(`/`)
        const fname = parts.pop() || `${name}.cif`
        const dir = parts.join(`/`) || `~`
        const ext = fname.split(`.`).pop()?.toLowerCase() || `cif`
        const format = [`poscar`, `vasp`, `contcar`].includes(ext) ? `poscar` : ext === `extxyz` ? `extxyz` : ext === `xyz` ? `xyz` : `cif`
        exp.dialog = { mode: `file`, filename: fname, format }
        deps.export_fs_browse(dir)
      } else {
        exp.dialog = { mode: `file`, filename: `${name}.cif`, format: `cif` }
        deps.export_fs_browse(sidebar.fs_path || `~`)
      }
      exp.close_saving = false
      return
    } else if (exp.close_save_target === `hpc` && pane.remote_origin) {
      const ext = pane.remote_origin.file_path.split(`.`).pop()?.toLowerCase() || `cif`
      let format = `cif`
      if ([`poscar`, `vasp`, `contcar`].includes(ext)) format = `poscar`
      else if (ext === `xyz`) format = `xyz`
      else if (ext === `extxyz`) format = `extxyz`
      const content = await serialize_structure_content(structure, format)
      await writeRemoteFile(pane.remote_origin.session_id, pane.remote_origin.file_path, content)
    } else {
      await save_structure_to_db(structure, _auto_name(structure), exp.close_save_project_id || undefined)
    }
    sidebar.refresh_counter++
    close_panel(deps, tab_id, pane_idx)
  } catch (e) {
    exp.error = e instanceof Error ? e.message : `Save failed`
    console.error(`Save before close failed:`, e)
  } finally {
    exp.close_saving = false
  }
}
