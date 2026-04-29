/**
 * Global drag-and-drop handlers — extracted from App.svelte.
 *
 * Functions for handling file drag-and-drop onto structure panes.
 */

import type { StructureTabState } from '../pane-utils'
import { pane_has_content } from '../pane-utils'
import { decompress_file } from '$lib/io/decompress'

export interface DragDropDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_type: () => string
  get_active_tab_id: () => string
  process_file_content: (tab_id: string, content: string | ArrayBuffer, filename: string, pane_idx: number) => Promise<void>
  get_drag_target_pane: () => number | null
  set_drag_target_pane: (v: number | null) => void
  set_is_loading: (v: boolean) => void
}

export function get_pane_from_event(deps: DragDropDeps, event: DragEvent): number {
  const ts = deps.get_active_ts()
  if (!ts) return 0
  const target = event.target as HTMLElement
  const pane_el = target.closest(`[data-pane]`)
  if (pane_el) return parseInt(pane_el.getAttribute(`data-pane`) || `0`)
  const first_empty = ts.panes.findIndex(p => !pane_has_content(p))
  return first_empty >= 0 ? first_empty : ts.active_pane
}

/** Check if event originates inside sidebar (FileTree has its own drag-drop) */
export function is_sidebar_drag(event: DragEvent): boolean {
  const el = event.target as HTMLElement | null
  return !!el?.closest?.(`.sidebar, .hpc-tree-container, .file-tree`)
}

/** Check if event originates inside chat panel (ChatPane has its own drag-drop) */
export function is_chat_drag(event: DragEvent): boolean {
  const el = event.target as HTMLElement | null
  return !!el?.closest?.(`.chat-panel`)
}

/** Check if a modal dialog with its own drop zone is open */
export function is_dialog_open(): boolean {
  return !!document.querySelector(`.dialog-backdrop`)
}

export function handle_dragover(deps: DragDropDeps, event: DragEvent) {
  // Always prevent browser from opening dropped files
  event.preventDefault()
  if (is_dialog_open() || deps.get_active_tab_type() !== `structure` || is_sidebar_drag(event) || is_chat_drag(event)) {
    // Clear structure pane highlight when dragging outside structure area
    if (deps.get_drag_target_pane() !== null) deps.set_drag_target_pane(null)
    return
  }
  deps.set_drag_target_pane(get_pane_from_event(deps, event))
}

export function handle_dragleave(deps: DragDropDeps, event: DragEvent) {
  if (!event.relatedTarget) deps.set_drag_target_pane(null)
}

export async function handle_drop(deps: DragDropDeps, event: DragEvent) {
  event.preventDefault()
  if (is_dialog_open()) return
  if (deps.get_active_tab_type() !== `structure`) return
  if (is_sidebar_drag(event)) return
  if (is_chat_drag(event)) return
  event.stopPropagation()
  const ts = deps.get_active_ts()
  if (!ts) return
  const pane_idx = get_pane_from_event(deps, event)
  deps.set_drag_target_pane(null)

  // [2026-03] Handle drag from sidebar filesystem browser (server-side file)
  const fs_path = event.dataTransfer?.getData(`application/x-catgo-filepath`)
  if (fs_path) {
    deps.set_is_loading(true)
    try {
      const { read_file } = await import(`$lib/api/project`)
      const result = await read_file(fs_path)
      await deps.process_file_content(deps.get_active_tab_id(), result.content, result.name, pane_idx)
      ts.active_pane = pane_idx
    } catch (err) {
      console.error(`[Drop] Error reading filesystem file:`, err)
    } finally {
      deps.set_is_loading(false)
    }
    return
  }

  const file = event.dataTransfer?.files[0]
  if (!file) {
    return
  }

  // Skip non-structure files in drag-and-drop
  const drop_name = file.name.toLowerCase()
  if (/\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|pdf|xlsx?|xlsm|xlsb|ods|mp[34]|wav|ogg|avi|mov|mkv|zip|gz|tar|rar|7z|exe|dll|so|dylib)$/i.test(drop_name)) {
    console.warn(`[Drop] Skipping non-structure file: ${file.name}`)
    return
  }

  deps.set_is_loading(true)
  try {
    const { content, filename } = await decompress_file(file)
    await deps.process_file_content(deps.get_active_tab_id(), content, filename, pane_idx)
    ts.active_pane = pane_idx
  } catch (err) {
    console.error(`[Drop] Error:`, err)
  } finally {
    deps.set_is_loading(false)
  }
}
