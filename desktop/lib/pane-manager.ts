/**
 * Pane close/unload management — extracted from App.svelte.
 *
 * Functions for handling pane close confirmation, save-and-close,
 * and project listing for save dialogs.
 */

import type { PaneState, StructureTabState } from '../pane-utils'
import type { create_modified_registry } from '$lib/structure/close-guard.svelte'
import {
  create_empty_pane,
  auto_name as _auto_name,
  serialize_structure_content,
  clear_modified_if_sole_pane,
} from '../pane-utils'
import { save_format_from_path } from '$lib/structure/save-format'
import { findLeafById, leafCount, leaves, removeLeaf, isTerminalLeaf, structurePane } from '../pane-tree'
import { exp } from '../state/export-state.svelte'
import { remove_pane_panels } from '$lib/panel/panel-state.svelte'
import { remove_pane_toolbar } from '$lib/structure/toolbar-state.svelte'
import { sidebar } from '../state/sidebar-state.svelte'
import { list_projects, save_structure_to_db, write_file } from '$lib/api/project'
import { writeRemoteFile } from '$lib/api/hpc'
import {
  cancel_pending_library_removal,
  commit_pending_library_removal,
  sync_active_library_entry,
} from './library-pane-bindings'

export interface PaneManagerDeps {
  tab_states: Record<string, StructureTabState>
  update_tab_label: (tab_id: string) => void
  // Per-tab unsaved-edit registry (close/save guard). Exposed here so Task B3
  // can gate pane close on `modified.is_modified(tab_id)` and call
  // `modified.clear(tab_id)` after a successful save-and-close.
  modified: ReturnType<typeof create_modified_registry>
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
  // Structure panes: prompt only when the tab has unsaved edits (Task B3
  // close-guard). A clean tab — content loaded/built but never edited — closes
  // with no prompt, per the plan's "close while clean → no prompt" rule. This
  // is the same decision `guard_close` ($lib/structure/save-on-close) encodes;
  // the modified branch is realised by the app's inline save/discard/cancel
  // banner (App.svelte), which saves to the source in its original format.
  const has_content = !!(pane.structure || pane.trajectory || pane.cube_file)
  if (has_content && deps.modified.is_modified(tab_id)) {
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
  remove_pane_panels(`${tab_id}:${leaf_id}`) // 不留失效 pane_id 的面板状态
  remove_pane_toolbar(`${tab_id}:${leaf_id}`)
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
  // Path-less panes (e.g. a structure imported from the project DB — no
  // local_file_path, no remote_origin) default to a Save-As FILE dialog so
  // "Save & Close" ASKS where to save instead of silently writing back to the
  // DB. The `local` target with no local_file_path routes through the export
  // dialog (see save_and_close_panel's `local` branch). Saving to the CatGO DB
  // stays available as an explicit, conscious choice via the banner's target
  // select — it is just no longer the silent default.
  else exp.close_save_target = `local`
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
  // Only silently overwrite a local source when we can serialize it back in its
  // ORIGINAL format (plan constraint: "never change format on save"). A source
  // with no faithful serializer (unknown ext, extension-less non-POSCAR, .gz)
  // maps to null and must fall through to Save-As instead of being CIF-ified.
  const local_fmt = pane.local_file_path ? save_format_from_path(pane.local_file_path) : null
  exp.close_saving = true
  try {
    if (exp.close_save_target === `local` && pane.local_file_path && local_fmt) {
      // Known source file with a faithful serializer → silently overwrite it in
      // its original format. Plan constraint: the close-prompt "Save" never
      // opens a dialog (that's "Save As", a separate explicit action) and never
      // changes the format. Uses the same write seam as the close-all flow.
      await write_file(pane.local_file_path, await serialize_structure_content(structure, local_fmt))
    } else if (exp.close_save_target === `local`) {
      // No known source path, OR a source format with no faithful serializer →
      // fall back to the export dialog (Save As), where the user explicitly
      // picks a supported format; the close is deferred until the dialog
      // completes (exp.close_after). Never silently rewrite as CIF.
      exp.close_after = { tab_id, leaf_id }
      ts.close_confirm_leaf_id = null
      const name = _auto_name(structure)
      exp.pending_structure = structure
      exp.error = ``
      exp.dialog = { mode: `file`, filename: `${name}.cif`, format: `cif` }
      deps.export_fs_browse(sidebar.fs_path || `~`)
      exp.close_saving = false
      return
    } else if (exp.close_save_target === `hpc` && pane.remote_origin) {
      // Remote overwrite is a headless seam — no Save-As dialog to fall back to.
      // If the source format has no faithful serializer, refuse: throw so the
      // catch surfaces the error and keeps the tab open (mirrors the VS Code
      // extension's refuse-and-stay-dirty), never CIF-ify the remote file.
      const remote_fmt = save_format_from_path(pane.remote_origin.file_path)
      if (!remote_fmt) {
        const base = pane.remote_origin.file_path.split(/[/\\]/).pop() || pane.remote_origin.file_path
        throw new Error(`Cannot save "${base}" in place: its format has no serializer. Use Save As to export it in a supported format.`)
      }
      const content = await serialize_structure_content(structure, remote_fmt)
      await writeRemoteFile(pane.remote_origin.session_id, pane.remote_origin.file_path, content)
    } else {
      // Reached only when the user CONSCIOUSLY picks "CatGO DB" in the close
      // banner's target select. Path-less panes no longer land here by default
      // (init_close_save_target defaults them to `local` → the Save-As dialog
      // above), so there is no silent DB write on close. The silent-DB batch
      // save lives on in the Close-All flow (execute_close_all_saves), whose
      // per-entry checklist makes the DB target an explicit opt-in.
      await save_structure_to_db(structure, _auto_name(structure), exp.close_save_project_id || undefined)
    }
    // Pane-scoped save success: only clear the tab flag when this pane is the
    // tab's sole content-bearing pane — a dirty sibling must keep it set.
    clear_modified_if_sole_pane(deps.modified, ts.root, tab_id, leaf_id)
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
