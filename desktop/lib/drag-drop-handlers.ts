/**
 * Global drag-and-drop handlers — extracted from App.svelte.
 *
 * Functions for handling file drag-and-drop onto structure panes.
 */

import type { StructureTabState } from '../pane-utils'
import { pane_has_content } from '../pane-utils'

export interface ImportItem {
  content?: string | ArrayBuffer
  filename: string
  file?: File
  path?: string | null
}

export interface DragDropDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_type: () => string
  get_active_tab_id: () => string
  process_file_content: (tab_id: string, content: string | ArrayBuffer, filename: string, pane_idx: number) => Promise<void>
  import_many: (tab_id: string, items: ImportItem[], pane_idx: number) => Promise<void>
  get_drag_target_pane: () => number | null
  set_drag_target_pane: (v: number | null) => void
  set_is_loading: (v: boolean) => void
}

/* Minimal File System Entry typings (non-standard webkit API). */
interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  fullPath?: string
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void }
}

/** Recursively collect File objects from a dropped FileSystemEntry (depth/count guarded). */
async function read_entry_files(entry: FsEntry | null, out: Array<{ file: File; path: string | null }>, depth: number): Promise<void> {
  if (!entry || depth > 3 || out.length >= 500) return
  if (entry.isFile && entry.file) {
    await new Promise<void>((resolve) => {
      entry.file!((f) => { out.push({ file: f, path: entry.fullPath || null }); resolve() }, () => resolve())
    })
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    const read_batch = (): Promise<FsEntry[]> =>
      new Promise((resolve) => reader.readEntries((e) => resolve(e), () => resolve([])))
    let batch = await read_batch()
    while (batch.length > 0 && out.length < 500) {
      for (const e of batch) {
        if (out.length >= 500) break
        await read_entry_files(e, out, depth + 1)
      }
      batch = await read_batch()
    }
  }
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

  // Capture entries/files synchronously — the DataTransfer list is invalidated
  // once the event handler yields (first await), so snapshot before any await.
  const dt = event.dataTransfer
  const entry_roots: FsEntry[] = []
  const items = dt?.items
  if (items && items.length && typeof (items[0] as unknown as { webkitGetAsEntry?: unknown }).webkitGetAsEntry === `function`) {
    for (let i = 0; i < items.length; i++) {
      const ent = (items[i] as unknown as { webkitGetAsEntry: () => FsEntry | null }).webkitGetAsEntry()
      if (ent) entry_roots.push(ent)
    }
  }
  const flat_files = Array.from(dt?.files ?? [])

  if (entry_roots.length === 0 && flat_files.length === 0) return

  deps.set_is_loading(true)
  try {
    const collected: Array<{ file: File; path: string | null }> = []
    if (entry_roots.length > 0) {
      for (const root of entry_roots) await read_entry_files(root, collected, 0)
    }
    // Fallback / supplement: any plain files not surfaced via the entry API.
    if (collected.length === 0) {
      for (const f of flat_files) collected.push({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || null })
    }
    if (collected.length === 0) return
    await deps.import_many(
      deps.get_active_tab_id(),
      collected.map(c => ({ file: c.file, filename: c.file.name, path: c.path })),
      pane_idx,
    )
    ts.active_pane = pane_idx
  } catch (err) {
    console.error(`[Drop] Error:`, err)
  } finally {
    deps.set_is_loading(false)
  }
}
