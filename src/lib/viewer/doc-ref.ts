import { resolve_doc_kind } from './doc-kind'
import type { DocRef } from './doc-viewer-state.svelte'

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
  // Carry inline content directly in the ref when there is no path to re-read from.
  // This is cross-window safe: the ref is delivered via Tauri event / BroadcastChannel
  // and the docs window reads the payload directly — no localStorage needed.
  const inline = (!src.origin && !src.local_path)
    ? { text: src.content ?? null, binary: src.binary ?? null, mime: src.mime ?? null }
    : null
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
    inline,
  }
}
