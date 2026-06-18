import type { DocKind } from './doc-kind'

export interface DocRef {
  filename: string
  kind: DocKind
  editable: boolean
  view: 'preview' | 'edit'
  origin: { session_id: string; file_path: string } | null
  local_path: string | null
  inline: { text: string | null; binary: string | null; mime: string | null } | null
}

export interface DocTab extends DocRef {
  id: string
  dirty: boolean
}

export const doc_viewer = $state<{ tabs: DocTab[]; active_id: string | null }>({
  tabs: [],
  active_id: null,
})

export function dedupe_key(ref: Pick<DocRef, 'origin' | 'local_path' | 'inline' | 'filename'>): string {
  if (ref.origin) return `hpc:${ref.origin.session_id}:${ref.origin.file_path}`
  if (ref.local_path) return `local:${ref.local_path}`
  if (ref.inline) return `inline:${ref.filename}`
  return `name:${ref.filename}`
}

let _seq = 0
function next_id(): string {
  _seq += 1
  return `doc-${_seq}`
}

export function open_doc(ref: DocRef): string {
  const key = dedupe_key(ref)
  const existing = doc_viewer.tabs.find((t) => dedupe_key(t) === key)
  if (existing) {
    doc_viewer.active_id = existing.id
    return existing.id
  }
  const tab: DocTab = { ...ref, id: next_id(), dirty: false }
  doc_viewer.tabs = [...doc_viewer.tabs, tab]
  doc_viewer.active_id = tab.id
  return tab.id
}

export function activate(id: string): void {
  if (doc_viewer.tabs.some((t) => t.id === id)) doc_viewer.active_id = id
}

export function close_tab(id: string): void {
  const idx = doc_viewer.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  doc_viewer.tabs = doc_viewer.tabs.filter((t) => t.id !== id)
  if (doc_viewer.active_id === id) {
    const neighbor = doc_viewer.tabs[idx] ?? doc_viewer.tabs[idx - 1] ?? null
    doc_viewer.active_id = neighbor ? neighbor.id : null
  }
}

export function set_dirty(id: string, dirty: boolean): void {
  const t = doc_viewer.tabs.find((x) => x.id === id)
  if (t) t.dirty = dirty
}

export function set_view(id: string, view: 'preview' | 'edit'): void {
  const t = doc_viewer.tabs.find((x) => x.id === id)
  if (t) t.view = view
}
