import { resolve_doc_kind } from './doc-kind'
import type { DocRef } from './doc-viewer-state.svelte'

let _inline_seq = 0

export function build_doc_ref(
  filename: string,
  src: {
    content?: string
    binary?: string
    mime?: string
    origin?: { session_id: string; file_path: string }
    local_path?: string
    view?: 'preview' | 'edit'
  },
): DocRef {
  const info = resolve_doc_kind(filename, src.mime)
  let inline_key: string | null = null
  // Inline content (localStorage) ONLY when there is no path to re-read from.
  // NOTE: each Tauri WebviewWindow has its OWN localStorage, so an inline key
  // written here (main window) is NOT visible to the #docs window — anything
  // with an origin/local_path must be re-read there via the backend instead.
  if (!src.origin && !src.local_path) {
    _inline_seq += 1
    inline_key = `catgo-docs-inline-${_inline_seq}-${filename}`
    try {
      localStorage.setItem(inline_key, JSON.stringify({
        text: src.content ?? null, binary: src.binary ?? null, mime: src.mime ?? null,
      }))
    } catch {
      // If storage fails the renderer shows an empty/error state; non-fatal.
    }
  }
  let view: 'preview' | 'edit'
  if (src.view !== undefined) {
    view = src.view
  } else if (info.kind === 'markdown' || info.kind === 'html') {
    view = 'preview'
  } else if (info.kind === 'text') {
    view = 'edit'
  } else {
    view = 'preview'
  }
  return {
    filename,
    kind: info.kind,
    editable: info.editable,
    view,
    origin: src.origin ?? null,
    local_path: src.local_path ?? null,
    inline_key,
  }
}
