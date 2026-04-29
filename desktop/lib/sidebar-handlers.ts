/**
 * Sidebar event handlers — extracted from App.svelte.
 *
 * Functions handling sidebar load/preview/editor events and
 * terminal file opening.
 */

import type { AnyStructure } from '$lib'
import type { StructureTabState, PaneState } from '../pane-utils'
import { pane_has_content } from '../pane-utils'
import { sidebar } from '../state/sidebar-state.svelte'
import { parse_and_open_structure_window } from './popout-manager'

export interface SidebarHandlerDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_id: () => string
  get_active_tab_type: () => string
  process_file_content: (tab_id: string, content: string | ArrayBuffer, filename: string, pane_idx: number, remote_origin?: { session_id: string; file_path: string } | null, local_file_path?: string | null) => Promise<void>
  update_tab_label: (tab_id: string) => void
  is_tauri: boolean
  set_is_loading: (v: boolean) => void
  set_loading_text: (v: string) => void
  tab_states: Record<string, StructureTabState>
  tabs: { id: string; type: string }[]
  set_active_tab_id: (id: string) => void
}

export function handle_sidebar_load(deps: SidebarHandlerDeps, content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) {
  // When terminal tab is active, open structure in a new window
  if (deps.get_active_tab_type() === `terminal` && typeof content === `string`) {
    parse_and_open_structure_window(content, filename, deps.is_tauri)
    return
  }
  const ts = deps.get_active_ts()
  if (!ts) return
  const pane_idx = ts.panes.findIndex(p => !pane_has_content(p))
  const target = pane_idx >= 0 ? pane_idx : ts.active_pane
  const origin = (file_path && session_id) ? { session_id, file_path } : null
  // Local filesystem path: file_path is set but session_id is not (not HPC)
  const local_path = (file_path && !session_id) ? file_path : null
  deps.process_file_content(deps.get_active_tab_id(), content, filename, target, origin, local_path)
}

export function handle_sidebar_preview(_deps: SidebarHandlerDeps, mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) {
  sidebar.preview_mode = mode as typeof sidebar.preview_mode
  sidebar.preview_filename = filename
  sidebar.preview_content = content || ``
  sidebar.preview_binary_data = binary_data || ``
  sidebar.preview_mime_type = mime_type || ``
  sidebar.preview_file_path = file_path || ``
  sidebar.preview_session_id = session_id || ``
  sidebar.preview_open = true
  sidebar.editor_open = false
}

export function handle_sidebar_open_editor(_deps: SidebarHandlerDeps, content: string, filename: string, file_path: string, session_id: string) {
  sidebar.editor_content = content
  sidebar.editor_filename = filename
  // If session_id is empty, treat file_path as local filesystem path
  if (session_id) {
    sidebar.editor_file_path = file_path
    sidebar.editor_session_id = session_id
    sidebar.editor_local_path = ``
  } else {
    sidebar.editor_file_path = ``
    sidebar.editor_session_id = ``
    sidebar.editor_local_path = file_path
  }
  sidebar.editor_on_save = null
  sidebar.editor_open = true
}

export function handle_sidebar_load_trajectory(deps: SidebarHandlerDeps, content: string, filename: string, _meta?: { session_id: string; dir_path: string }) {
  // When terminal tab is active, open in a new window
  if (deps.get_active_tab_type() === `terminal`) {
    parse_and_open_structure_window(content, filename, deps.is_tauri)
    return
  }
  const ts = deps.get_active_ts()
  if (!ts) return
  const pane_idx = ts.panes.findIndex(p => !pane_has_content(p))
  const target = pane_idx >= 0 ? pane_idx : ts.active_pane
  deps.process_file_content(deps.get_active_tab_id(), content, filename, target)
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
        // Switch to first structure tab, or open new window if none exists
        const struct_tab = deps.tabs.find(t => t.type === `structure`)
        if (struct_tab) {
          deps.set_active_tab_id(struct_tab.id)
          handle_sidebar_load(deps, result.content, filename, file_path, session_id)
        } else {
          await parse_and_open_structure_window(result.content, filename, deps.is_tauri)
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
