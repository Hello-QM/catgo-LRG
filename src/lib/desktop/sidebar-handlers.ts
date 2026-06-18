/**
 * Sidebar action handlers that bridge file-tree interactions to the doc viewer.
 * Each handler builds a DocRef with the correct initial view intent and sends it
 * to the doc window via the doc-channel.
 */
import { build_doc_ref } from '$lib/viewer/doc-ref'
import { send_open_doc } from '$lib/viewer/doc-channel'
import { check_tauri } from '$lib/io/tauri'

export interface RemoteFile {
  name: string
  path: string
  session_id: string
}

/**
 * Open a file for rendered preview (eye icon action).
 * Markdown and HTML will render; other kinds fall back to their natural preview.
 */
export async function handle_sidebar_preview(file: RemoteFile): Promise<void> {
  const ref = build_doc_ref(file.name, {
    origin: { session_id: file.session_id, file_path: file.path },
    view: 'preview',
  })
  await send_open_doc(ref, check_tauri())
}

/**
 * Open a file for editing (pencil icon action).
 * Forces Monaco editor regardless of file kind (if editable).
 */
export async function handle_sidebar_open_editor(file: RemoteFile): Promise<void> {
  const ref = build_doc_ref(file.name, {
    origin: { session_id: file.session_id, file_path: file.path },
    view: 'edit',
  })
  await send_open_doc(ref, check_tauri())
}
