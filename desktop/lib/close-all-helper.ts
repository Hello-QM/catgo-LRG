/**
 * Close-all dialog helpers — extracted from App.svelte.
 *
 * Pure functions that build dialog entries and execute batch save+close.
 * No $state needed.
 */

import type { CloseAllEntry } from '../state/modal-state.svelte'
import type { StructureTabState } from '../pane-utils'
import type { AppTab } from '../TabBar.svelte'
import {
  pane_has_content,
  auto_name as _auto_name, serialize_structure_content,
  create_tab_state,
} from '../pane-utils'
import { leaves, structurePane } from '../pane-tree'
import { save_structure_to_db, write_file } from '$lib/api/project'
import { writeRemoteFile } from '$lib/api/hpc'

/**
 * Build the list of entries for the close-all dialog.
 */
export function build_close_all_entries(
  tabs: AppTab[],
  tab_states: Record<string, StructureTabState>,
): CloseAllEntry[] {
  const entries: CloseAllEntry[] = []
  for (const tab of tabs) {
    if (tab.type !== `structure`) continue
    const ts = tab_states[tab.id]
    if (!ts) continue
    for (const leaf of leaves(ts.root)) {
      const pane = structurePane(leaf)
      if (!pane || !pane_has_content(pane)) continue
      const structure = pane.saveable_structure ?? pane.structure
      const formula = structure?.sites?.length ? _auto_name(structure as Record<string, unknown>) : (pane.trajectory ? `Trajectory` : `Cube`)
      let save_target: CloseAllEntry[`save_target`] = `none`
      let save_path: string | undefined
      if (pane.local_file_path) {
        save_target = `local`
        save_path = pane.local_file_path
      } else if (pane.remote_origin?.session_id) {
        save_target = `hpc`
        save_path = pane.remote_origin.file_path
      } else if (structure) {
        save_target = `database`
      }
      entries.push({
        tab_id: tab.id,
        label: tab.label,
        leaf_id: leaf.id,
        formula,
        save_target,
        save_path,
        checked: save_target !== `none` && !!structure,
      })
    }
  }
  return entries
}

/**
 * Execute saving of checked entries (called during close-all).
 */
export async function execute_close_all_saves(
  entries: CloseAllEntry[],
  tab_states: Record<string, StructureTabState>,
): Promise<void> {
  for (const entry of entries) {
    if (!entry.checked) continue
    const ts = tab_states[entry.tab_id]
    if (!ts) continue
    const leaf = leaves(ts.root).find(l => l.id === entry.leaf_id)
    const pane = leaf ? structurePane(leaf) : null
    if (!pane) continue
    const structure = (pane.saveable_structure ?? pane.structure) as Record<string, unknown> | undefined
    if (!structure) continue

    if (entry.save_target === `local` && entry.save_path) {
      const ext = entry.save_path.split(`.`).pop()?.toLowerCase() || `cif`
      let format = `cif`
      if ([`poscar`, `vasp`, `contcar`].includes(ext) || /^(POSCAR|CONTCAR)$/i.test(entry.save_path.split(/[/\\]/).pop() || ``)) format = `poscar`
      else if (ext === `xyz`) format = `xyz`
      else if (ext === `extxyz`) format = `extxyz`
      const content = await serialize_structure_content(structure, format)
      await write_file(entry.save_path, content)
    } else if (entry.save_target === `hpc` && pane.remote_origin) {
      const ext = pane.remote_origin.file_path.split(`.`).pop()?.toLowerCase() || `cif`
      let format = `cif`
      if ([`poscar`, `vasp`, `contcar`].includes(ext)) format = `poscar`
      else if (ext === `xyz`) format = `xyz`
      else if (ext === `extxyz`) format = `extxyz`
      const content = await serialize_structure_content(structure, format)
      await writeRemoteFile(pane.remote_origin.session_id, pane.remote_origin.file_path, content)
    } else if (entry.save_target === `database`) {
      await save_structure_to_db(structure, entry.formula)
    }
  }
}

/**
 * Close all structure tabs (or reset last tab to empty).
 */
export function close_all_structure_tabs(
  tabs: AppTab[],
  tab_states: Record<string, StructureTabState>,
  close_tab: (id: string) => void,
): void {
  const structure_tab_ids = tabs.filter(t => t.type === `structure`).map(t => t.id)
  let remaining = structure_tab_ids.length
  for (const id of structure_tab_ids) {
    if (remaining <= 1) {
      // Last structure tab: reset to empty instead of closing
      const ts = tab_states[id]
      if (ts) {
        const r = create_tab_state()
        ts.root = r.root
        ts.active_leaf_id = r.active_leaf_id
        ts.close_confirm_leaf_id = null
        ts.library = []
        ts.active_library_id = null
        const tab = tabs.find(t => t.id === id)
        if (tab) tab.label = `Structure`
      }
    } else {
      close_tab(id)
      remaining--
    }
  }
}
