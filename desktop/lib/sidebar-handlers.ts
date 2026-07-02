/**
 * Sidebar event handlers — extracted from App.svelte.
 *
 * Functions handling sidebar load/preview/editor events and
 * terminal file opening.
 */

import type { AnyStructure } from '$lib'
import type { StructureTabState } from '../pane-utils'
import { findFirstEmptyLeaf } from '../pane-tree'
import { parse_and_open_structure_window, open_doc_window } from './popout-manager'
import { build_doc_ref } from '$lib/viewer/doc-ref'
import { resolve_open_target, type OpenTarget } from '$lib/state.svelte'
import { show_toast } from '$lib/toast-state.svelte'

export interface SidebarHandlerDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_id: () => string
  get_active_tab_type: () => string
  get_open_target: () => OpenTarget
  process_file_content: (tab_id: string, content: string | ArrayBuffer, filename: string, leaf_id: string, remote_origin?: { session_id: string; file_path: string } | null, local_file_path?: string | null) => Promise<void>
  place_single: (tab_id: string, leaf_id: string, content: string | ArrayBuffer, filename: string, target: OpenTarget, origin?: { session_id: string; file_path: string } | null, local_path?: string | null) => Promise<void>
  update_tab_label: (tab_id: string) => void
  is_tauri: boolean
  set_is_loading: (v: boolean) => void
  set_loading_text: (v: string) => void
  tab_states: Record<string, StructureTabState>
  tabs: { id: string; type: string }[]
  set_active_tab_id: (id: string) => void
  /** Create a fresh structure tab and return its ids (App owns the side effect). */
  open_new_structure_tab: () => { tab_id: string; leaf_id: string }
}

export function handle_sidebar_load(deps: SidebarHandlerDeps, content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) {
  // Route by the resolved open target (tab/split/window × new/overwrite); the
  // App owns the side effects via place_single.
  const ts = deps.get_active_ts()
  if (!ts) return
  const target = resolve_open_target(deps.get_open_target(), false)
  const origin = (file_path && session_id) ? { session_id, file_path } : null
  // Local filesystem path: file_path is set but session_id is not (not HPC)
  const local_path = (file_path && !session_id) ? file_path : null
  deps.place_single(deps.get_active_tab_id(), ts.active_leaf_id, content, filename, target, origin, local_path)
    .catch((e) => {
      console.error(`Failed to load ${filename}:`, e)
      show_toast({ message: `Could not load ${filename}: ${e instanceof Error ? e.message : String(e)}`, variant: `error` })
    })
}

export function handle_sidebar_preview(deps: SidebarHandlerDeps, _mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) {
  const origin = session_id ? { session_id, file_path } : undefined
  const local_path = !session_id && file_path ? file_path : undefined
  const ref = build_doc_ref(filename, { content, binary: binary_data, mime: mime_type, origin, local_path })
  void open_doc_window(ref, deps.is_tauri)
}

export function handle_sidebar_open_editor(deps: SidebarHandlerDeps, content: string, filename: string, file_path: string, session_id: string) {
  const origin = session_id ? { session_id, file_path } : undefined
  const local_path = !session_id && file_path ? file_path : undefined
  const ref = build_doc_ref(filename, { content, origin, local_path })
  void open_doc_window(ref, deps.is_tauri)
}

export function handle_sidebar_load_trajectory(deps: SidebarHandlerDeps, content: string, filename: string, _meta?: { session_id: string; dir_path: string }) {
  const ts = deps.get_active_ts()
  if (!ts) return
  const target = resolve_open_target(deps.get_open_target(), false)
  deps.place_single(deps.get_active_tab_id(), ts.active_leaf_id, content, filename, target)
    .catch((e) => {
      console.error(`Failed to load ${filename}:`, e)
      show_toast({ message: `Could not load ${filename}: ${e instanceof Error ? e.message : String(e)}`, variant: `error` })
    })
}

/** Open a remote file from terminal Ctrl+click, routing by file type to the appropriate viewer. */
export async function handle_terminal_open_file(deps: SidebarHandlerDeps, file_path: string, filename: string, session_id: string) {
  const lower = filename.toLowerCase()
  const is_img = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?)$/i.test(lower)
  const is_pdf_f = /\.pdf$/i.test(lower)
  const is_excel_f = /\.(xlsx?|xlsm|xlsb|ods)$/i.test(lower)
  const is_csv = /\.(csv|tsv)$/i.test(lower)
  const is_md = /\.(md|rst)$/i.test(lower)
  const is_binary = is_img || is_pdf_f || is_excel_f
  deps.set_is_loading(true)
  deps.set_loading_text(`Loading ${filename}...`)
  try {
    // Structure / trajectory files -> load into structure viewer
    const { is_structure_file } = await import(`$lib/structure/parse`)
    const { is_trajectory_file } = await import(`$lib/trajectory/parse`)
    if (is_structure_file(filename) || is_trajectory_file(filename)) {
      const { readRemoteFile } = await import(`$lib/api/hpc`)
      const result = await readRemoteFile(session_id, file_path)
      if (result.success && result.content !== undefined) {
        // Switch to the first structure tab and route by the open target.
        const struct_tab = deps.tabs.find(t => t.type === `structure`)
        if (struct_tab) {
          deps.set_active_tab_id(struct_tab.id)
          handle_sidebar_load(deps, result.content, filename, file_path, session_id)
        } else {
          // No structure tab exists (e.g. a terminal-only tab is active).
          // Honor the user's open target: only an explicit Window choice pops
          // out; Tab/Split get a fresh structure tab (there is nothing to
          // split, so both collapse to "new tab").
          const target = resolve_open_target(deps.get_open_target(), false)
          if (target.kind === `window`) {
            await parse_and_open_structure_window(result.content, filename, deps.is_tauri, target.mode === `overwrite`)
            return
          }
          const n = deps.open_new_structure_tab()
          const made = deps.tabs.find(t => t.id === n.tab_id)
          if (n.leaf_id && made?.type === `structure`) {
            const origin = session_id ? { session_id, file_path } : null
            const local_path = session_id ? null : file_path
            await deps.process_file_content(n.tab_id, result.content, filename, n.leaf_id, origin, local_path)
          } else {
            // Tab cap reached (create_tab no-oped) — popout as a last resort.
            await parse_and_open_structure_window(result.content, filename, deps.is_tauri)
          }
        }
      }
      return
    }
    if (is_binary) {
      const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
      const result = await readRemoteBinaryFile(session_id, file_path)
      if (result.success) {
        const mode = is_img ? `image` : is_pdf_f ? `pdf` : `excel`
        handle_sidebar_preview(deps, mode, filename, file_path, session_id, undefined, result.data, result.mime_type)
      }
    } else {
      const { readRemoteFile } = await import(`$lib/api/hpc`)
      const result = await readRemoteFile(session_id, file_path)
      if (result.success && result.content !== undefined) {
        if (is_csv || is_md) {
          const mode = is_csv ? `csv` : `markdown`
          handle_sidebar_preview(deps, mode, filename, file_path, session_id, result.content)
        } else {
          handle_sidebar_open_editor(deps, result.content, filename, file_path, session_id)
        }
      }
    }
  } catch (e) {
    console.error(`Failed to open file from terminal:`, e)
  } finally {
    deps.set_is_loading(false)
    deps.set_loading_text(``)
  }
}
