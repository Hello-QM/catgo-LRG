import type { DocTab } from './doc-viewer-state.svelte'

export interface DocContent {
  text: string | null
  binary: string | null
  mime: string | null
}

const BINARY_KINDS = new Set(['pdf', 'image', 'excel', 'docx'])

export async function load_doc_content(tab: DocTab): Promise<DocContent> {
  // Inline payload carried directly in the ref — cross-window safe (no localStorage).
  if (tab.inline) {
    return { text: tab.inline.text, binary: tab.inline.binary, mime: tab.inline.mime }
  }

  const want_binary = BINARY_KINDS.has(tab.kind)

  if (tab.origin) {
    if (want_binary) {
      const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
      const r = await readRemoteBinaryFile(tab.origin.session_id, tab.origin.file_path)
      return { text: null, binary: r.success ? r.data : null, mime: r.mime_type ?? null }
    }
    const { readRemoteFile } = await import(`$lib/api/hpc`)
    const r = await readRemoteFile(tab.origin.session_id, tab.origin.file_path)
    return { text: r.success ? r.content : null, binary: null, mime: null }
  }

  if (tab.local_path) {
    if (want_binary) {
      // Local binary base64 endpoint is a deferred backend follow-up (v1 has no
      // local binary read API — read_file returns text, not base64). Degrade
      // gracefully so the renderer shows an empty/no-content state instead of
      // trying to decode text as base64.
      return { text: null, binary: null, mime: null }
    }
    const { read_file } = await import(`$lib/api/project`)
    const r = await read_file(tab.local_path)
    return { text: r.content, binary: null, mime: null }
  }

  return { text: null, binary: null, mime: null }
}

export async function save_doc_content(tab: DocTab, text: string): Promise<void> {
  if (tab.origin) {
    const { writeRemoteFile } = await import(`$lib/api/hpc`)
    await writeRemoteFile(tab.origin.session_id, tab.origin.file_path, text)
    return
  }
  if (tab.local_path) {
    const { write_file } = await import(`$lib/api/project`)
    await write_file(tab.local_path, text)
  }
}
