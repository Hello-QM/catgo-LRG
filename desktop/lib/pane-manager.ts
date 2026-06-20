/**
 * Pane close/unload management — extracted from App.svelte.
 *
 * Functions for handling pane close confirmation, save-and-close,
 * and project listing for save dialogs.
 */

import type { PaneState, StructureTabState } from '../pane-utils'
import { create_empty_pane, auto_name as _auto_name, serialize_structure_content } from '../pane-utils'
import { findLeafById, leafCount, leaves, removeLeaf, isTerminalLeaf, structurePane } from '../pane-tree'
import { exp } from '../state/export-state.svelte'
import { sidebar } from '../state/sidebar-state.svelte'
import { list_projects, save_structure_to_db } from '$lib/api/project'
import { writeRemoteFile } from '$lib/api/hpc'
import {
  cancel_pending_library_removal,
  commit_pending_library_removal,
  sync_active_library_entry,
} from './library-pane-bindings'

export interface PaneManagerDeps {
  tab_states: Record<string, StructureTabState>
  update_tab_label: (tab_id: string) => void
  export_fs_browse: (dir: string) => void
  reset_viewer?: (tab_id: string, leaf_id: string) => void
}

export function handle_unload(deps: PaneManagerDeps, tab_id: string, leaf_id: string) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const leaf = findLeafById(ts.root, leaf_id)
  if (!leaf) return
  // Terminal leaves close directly (kill session via Task 4 hook); no
  // save-confirm banner — there is no saveable structure.
  if (isTerminalLeaf(leaf)) {
    ts.close_confirm_leaf_id = null
    if (leafCount(ts.root) > 1) {
      ts.root = removeLeaf(ts.root, leaf_id)
      if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id
    }
    deps.update_tab_label(tab_id)
    return
  }
  const pane = structurePane(leaf)
  if (!pane) return
  // Workflow panes: only prompt if user has opened/edited a workflow
  if (pane.mode === 'workflow') {
    if (pane.modified) {
      ts.close_confirm_leaf_id = leaf_id
      return
    }
    close_panel(deps, tab_id, leaf_id)
    return
  }
  // Structure panes: prompt if has content
  const has_content = !!(pane.structure || pane.trajectory || pane.cube_file)
  if (has_content) {
    ts.close_confirm_leaf_id = leaf_id
    init_close_save_target(pane)
    if (pane.structure) load_close_save_projects()
    return
  }
  close_panel(deps, tab_id, leaf_id)
}

export function close_panel(deps: PaneManagerDeps, tab_id: string, leaf_id: string) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const closing_leaf = findLeafById(ts.root, leaf_id)
  if (!closing_leaf) return
  const closed_entry_id = structurePane(closing_leaf)?.library_entry_id ?? null
  ts.close_confirm_leaf_id = null
  deps.reset_viewer?.(tab_id, leaf_id)
  if (leafCount(ts.root) <= 1) {
    const pane = closing_leaf && structurePane(closing_leaf)
    if (pane) Object.assign(pane, create_empty_pane())
    commit_pending_library_removal(ts, leaf_id, closed_entry_id)
    sync_active_library_entry(ts)
    deps.update_tab_label(tab_id)
    return
  }
  ts.root = removeLeaf(ts.root, leaf_id)
  if (!findLeafById(ts.root, ts.active_leaf_id)) ts.active_leaf_id = leaves(ts.root)[0].id
  if (ts.maximized_leaf_id && !findLeafById(ts.root, ts.maximized_leaf_id)) ts.maximized_leaf_id = null
  commit_pending_library_removal(ts, leaf_id, closed_entry_id)
  sync_active_library_entry(ts)
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

export async function save_and_close_panel(deps: PaneManagerDeps, tab_id: string, leaf_id: string) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const leaf = findLeafById(ts.root, leaf_id)
  const pane = leaf ? structurePane(leaf) : null
  if (!pane) return
  const structure = (pane.saveable_structure ?? pane.structure) as Record<string, unknown> | undefined
  if (!structure) {
    close_panel(deps, tab_id, leaf_id)
    return
  }
  exp.close_saving = true
  try {
    if (exp.close_save_target === `local`) {
      // Open export dialog with folder browser, close panel after save
      exp.close_after = { tab_id, leaf_id }
      ts.close_confirm_leaf_id = null
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
    close_panel(deps, tab_id, leaf_id)
  } catch (e) {
    exp.error = e instanceof Error ? e.message : `Save failed`
    console.error(`Save before close failed:`, e)
    // The close was abandoned (no dialog opens for the HPC/DB path, so there
    // is no cancel flow to clean up). Drop the pending removal so a later,
    // unrelated direct close of this same leaf does not silently commit it.
    cancel_pending_library_removal(ts, leaf_id)
  } finally {
    exp.close_saving = false
  }
}
