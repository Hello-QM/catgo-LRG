/**
 * 5B: Filesystem browser state and handlers for the localdb sidebar section.
 * Extracted from Sidebar.svelte.
 *
 * Uses factory function pattern — $state must be created in component context.
 */

import { browse_files, read_file, export_structure } from '$lib/api/project'
import type { FileBrowseItem } from '$lib/api/project'
import { is_structure_file, is_db_file } from '../sidebar-utils'
import { check_tauri } from '$lib/io/tauri'

export interface FsBrowserCallbacks {
  on_load_file: (content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) => void
  on_open_editor?: (content: string, filename: string, file_path: string, session_id: string) => void
  on_load_trajectory?: (content: string, filename: string, meta?: { session_id: string; dir_path: string }) => void
  /** Stream a large on-disk trajectory frame-by-frame via the backend (no full read). */
  on_load_trajectory_stream?: (path: string, filename: string) => void | Promise<void>
  on_save_structure?: () => Record<string, unknown> | null
  on_preview_file?: (mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) => void
  on_before_db_switch?: () => Promise<boolean>
  /** Called when a DB file is opened from the fs browser */
  on_open_db_file: (path: string) => Promise<void>
  /** Setter for db_error */
  set_db_error: (msg: string) => void
}

export function create_fs_browser_state(callbacks: FsBrowserCallbacks) {
  let fs_browser_open = $state(false)
  let fs_current_dir = $state(``)
  let fs_items = $state<FileBrowseItem[]>([])
  let fs_parent = $state(``)
  let fs_loading = $state(false)
  let fs_error = $state(``)
  let fs_path_editing = $state(false)
  let fs_path_input = $state(``)

  // Export state
  let fs_export_name = $state(`structure.cif`)
  let fs_exporting = $state(false)
  let fs_export_msg = $state(``)

  // Context menu & file operations
  let fs_ctx = $state<{ x: number; y: number; item: FileBrowseItem } | null>(null)
  let fs_clipboard = $state<{ item: FileBrowseItem; op: `copy` | `cut` } | null>(null)
  let fs_renaming = $state<FileBrowseItem | null>(null)
  let fs_rename_val = $state(``)
  let fs_delete_confirm = $state<FileBrowseItem | null>(null)
  let fs_new_folder = $state(false)
  let fs_new_folder_name = $state(`New Folder`)
  let fs_op_loading = $state(false)

  async function fs_browse(dir: string) {
    fs_loading = true
    fs_error = ``
    try {
      const result = await browse_files(dir)
      fs_current_dir = result.dir
      fs_parent = result.parent
      fs_items = result.items
    } catch (e: any) {
      fs_error = e?.message || String(e) || `Failed to browse`
    } finally {
      fs_loading = false
    }
  }

  function fs_go_up() {
    if (fs_parent && fs_parent !== fs_current_dir) {
      fs_browse(fs_parent)
    }
  }

  async function fs_handle_click(item: FileBrowseItem) {
    if (item.type === `dir`) {
      fs_browse(item.path)
      return
    }
    // File clicked
    if (is_db_file(item.name)) {
      if (callbacks.on_before_db_switch && !(await callbacks.on_before_db_switch())) return
      try {
        await callbacks.on_open_db_file(item.path)
      } catch (e) {
        callbacks.set_db_error(e instanceof Error ? e.message : `Failed to open database`)
      }
      return
    }

    const lower_name = item.name.toLowerCase()
    const is_tauri = check_tauri()

    // Read raw bytes of a local file in BOTH modes: the Tauri fs plugin in the
    // desktop app, or the Vite dev /__files/raw route in browser/web mode.
    // Without the web branch, the plugin-fs import throws "Cannot read
    // properties of undefined (reading 'invoke')" and previews fail in web mode.
    async function read_local_bytes(path: string): Promise<Uint8Array> {
      if (is_tauri) {
        const { readFile } = await import(`@tauri-apps/plugin-fs`)
        return await readFile(path)
      }
      const resp = await fetch(`/__files/raw?path=${encodeURIComponent(path)}`)
      if (!resp.ok) throw new Error(`Cannot read file (HTTP ${resp.status})`)
      return new Uint8Array(await resp.arrayBuffer())
    }
    function bytes_to_base64(bytes: Uint8Array): string {
      let bin = ``
      const chunk_size = 8192
      for (let i = 0; i < bytes.length; i += chunk_size) bin += String.fromCharCode(...bytes.subarray(i, i + chunk_size))
      return btoa(bin)
    }

    // In-app preview for images
    if (callbacks.on_preview_file && /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?)$/i.test(lower_name)) {
      try {
        const bytes = await read_local_bytes(item.path)
        const ext = lower_name.split(`.`).pop() || ``
        const mime = ext === `svg` ? `image/svg+xml` : ext === `gif` ? `image/gif` : ext === `webp` ? `image/webp` : ext === `bmp` ? `image/bmp` : ext.startsWith(`tif`) ? `image/tiff` : `image/${ext === `jpg` ? `jpeg` : ext}`
        callbacks.on_preview_file(`image`, item.name, item.path, ``, undefined, bytes_to_base64(bytes), mime)
      } catch (e) {
        fs_error = e instanceof Error ? e.message : `Cannot read image`
      }
      return
    }

    // In-app preview for PDFs
    if (callbacks.on_preview_file && /\.pdf$/i.test(lower_name)) {
      try {
        const bytes = await read_local_bytes(item.path)
        callbacks.on_preview_file(`pdf`, item.name, item.path, ``, undefined, bytes_to_base64(bytes), `application/pdf`)
      } catch (e) {
        fs_error = e instanceof Error ? e.message : `Cannot read PDF`
      }
      return
    }

    // Non-previewable binary files: open with the system default app (desktop),
    // or open the raw file in a new browser tab in web mode.
    if (/\.(xlsx?|xlsm|xlsb|ods|mp[34]|wav|ogg|avi|mov|mkv|zip|gz|tar|rar|7z|exe|dll|so|dylib|woff2?|ttf|eot|doc|docx|ppt|pptx)$/i.test(lower_name)) {
      try {
        if (is_tauri) {
          const { open } = await import(`@tauri-apps/plugin-shell`)
          await open(item.path)
        } else {
          window.open(`/__files/raw?path=${encodeURIComponent(item.path)}`, `_blank`)
        }
      } catch (e) {
        fs_error = e instanceof Error ? e.message : `Cannot open file`
      }
      return
    }

    // Large on-disk trajectory: stream frame-by-frame from the backend instead
    // of slurping 100s of MB into the webview (which freezes it).
    if (callbacks.on_load_trajectory_stream) {
      const { probe_streamable_trajectory } = await import('$lib/trajectory/remote-frame-loader')
      const probe = await probe_streamable_trajectory(item.path, item.name)
      if (probe?.stream) {
        await callbacks.on_load_trajectory_stream(item.path, item.name)
        return
      }
    }

    // Text-based files: read content
    try {
      const result = await read_file(item.path)

      // Trajectory detection
      if (callbacks.on_load_trajectory) {
        const { is_trajectory_file } = await import('$lib/trajectory/parse')
        if (is_trajectory_file(item.name, result.content)) {
          callbacks.on_load_trajectory(result.content, result.name)
          return
        }
      }

      // Structure files
      if (is_structure_file(item.name)) {
        callbacks.on_load_file(result.content, result.name, item.path)
        return
      }

      // Markdown/CSV preview
      if (callbacks.on_preview_file && /\.(md|rst)$/i.test(lower_name)) {
        callbacks.on_preview_file(`markdown`, item.name, item.path, ``, result.content)
        return
      }
      if (callbacks.on_preview_file && /\.(csv|tsv)$/i.test(lower_name)) {
        callbacks.on_preview_file(`csv`, item.name, item.path, ``, result.content)
        return
      }

      // Other text files -> editor
      if (callbacks.on_open_editor) {
        callbacks.on_open_editor(result.content, result.name, item.path, ``)
        return
      }

      // Fallback: load as structure attempt
      callbacks.on_load_file(result.content, result.name, item.path)
    } catch (e) {
      fs_error = e instanceof Error ? e.message : `Cannot read file`
    }
  }

  function fs_submit_path() {
    fs_path_editing = false
    const trimmed = fs_path_input.trim()
    if (trimmed) fs_browse(trimmed)
  }

  async function fs_export_current() {
    if (!callbacks.on_save_structure || !fs_current_dir) return
    const struct = callbacks.on_save_structure()
    if (!struct) { fs_export_msg = `No structure to export`; return }
    const sep = fs_current_dir.includes(`\\`) ? `\\` : `/`
    const full_path = `${fs_current_dir}${sep}${fs_export_name}`
    fs_exporting = true
    fs_export_msg = ``
    try {
      const result = await export_structure(struct, full_path)
      fs_export_msg = `Saved ${result.name}`
      // Refresh file list to show the new file
      await fs_browse(fs_current_dir)
      setTimeout(() => { fs_export_msg = `` }, 3000)
    } catch (e) {
      fs_export_msg = e instanceof Error ? e.message : `Export failed`
    } finally {
      fs_exporting = false
    }
  }

  async function fs_do_mkdir() {
    if (!fs_new_folder_name.trim() || !fs_current_dir) return
    fs_op_loading = true
    try {
      const sep = fs_current_dir.includes(`\\`) ? `\\` : `/`
      await (await import(`$lib/api/project`)).fs_mkdir(`${fs_current_dir}${sep}${fs_new_folder_name.trim()}`)
      fs_new_folder = false
      fs_new_folder_name = `New Folder`
      await fs_browse(fs_current_dir)
    } catch (e) { fs_error = e instanceof Error ? e.message : `mkdir failed` }
    finally { fs_op_loading = false }
  }

  async function fs_do_delete() {
    if (!fs_delete_confirm) return
    fs_op_loading = true
    try {
      await (await import(`$lib/api/project`)).fs_delete(fs_delete_confirm.path)
      fs_delete_confirm = null
      await fs_browse(fs_current_dir)
    } catch (e) { fs_error = e instanceof Error ? e.message : `delete failed` }
    finally { fs_op_loading = false }
  }

  async function fs_do_rename() {
    if (!fs_renaming || !fs_rename_val.trim()) return
    fs_op_loading = true
    try {
      const last_sep = Math.max(fs_renaming.path.lastIndexOf(`/`), fs_renaming.path.lastIndexOf(`\\`))
      const parent = last_sep >= 0 ? fs_renaming.path.substring(0, last_sep) : ``
      const sep = parent.includes(`\\`) ? `\\` : `/`
      const new_path = `${parent}${sep}${fs_rename_val.trim()}`
      await (await import(`$lib/api/project`)).fs_rename(fs_renaming.path, new_path)
      fs_renaming = null
      fs_rename_val = ``
      await fs_browse(fs_current_dir)
    } catch (e) { fs_error = e instanceof Error ? e.message : `rename failed` }
    finally { fs_op_loading = false }
  }

  async function fs_do_paste() {
    if (!fs_clipboard || !fs_current_dir) return
    fs_op_loading = true
    try {
      const sep = fs_current_dir.includes(`\\`) ? `\\` : `/`
      const dest = `${fs_current_dir}${sep}${fs_clipboard.item.name}`
      const api = await import(`$lib/api/project`)
      if (fs_clipboard.op === `copy`) {
        await api.fs_copy(fs_clipboard.item.path, dest)
      } else {
        await api.fs_move(fs_clipboard.item.path, dest)
        fs_clipboard = null
      }
      await fs_browse(fs_current_dir)
    } catch (e) { fs_error = e instanceof Error ? e.message : `paste failed` }
    finally { fs_op_loading = false }
  }

  return {
    get fs_browser_open() { return fs_browser_open },
    set fs_browser_open(v: boolean) { fs_browser_open = v },
    get fs_current_dir() { return fs_current_dir },
    set fs_current_dir(v: string) { fs_current_dir = v },
    get fs_items() { return fs_items },
    get fs_parent() { return fs_parent },
    get fs_loading() { return fs_loading },
    get fs_error() { return fs_error },
    set fs_error(v: string) { fs_error = v },
    get fs_path_editing() { return fs_path_editing },
    set fs_path_editing(v: boolean) { fs_path_editing = v },
    get fs_path_input() { return fs_path_input },
    set fs_path_input(v: string) { fs_path_input = v },
    get fs_export_name() { return fs_export_name },
    set fs_export_name(v: string) { fs_export_name = v },
    get fs_exporting() { return fs_exporting },
    get fs_export_msg() { return fs_export_msg },
    get fs_ctx() { return fs_ctx },
    set fs_ctx(v: { x: number; y: number; item: FileBrowseItem } | null) { fs_ctx = v },
    get fs_clipboard() { return fs_clipboard },
    set fs_clipboard(v: { item: FileBrowseItem; op: `copy` | `cut` } | null) { fs_clipboard = v },
    get fs_renaming() { return fs_renaming },
    set fs_renaming(v: FileBrowseItem | null) { fs_renaming = v },
    get fs_rename_val() { return fs_rename_val },
    set fs_rename_val(v: string) { fs_rename_val = v },
    get fs_delete_confirm() { return fs_delete_confirm },
    set fs_delete_confirm(v: FileBrowseItem | null) { fs_delete_confirm = v },
    get fs_new_folder() { return fs_new_folder },
    set fs_new_folder(v: boolean) { fs_new_folder = v },
    get fs_new_folder_name() { return fs_new_folder_name },
    set fs_new_folder_name(v: string) { fs_new_folder_name = v },
    get fs_op_loading() { return fs_op_loading },
    fs_browse,
    fs_go_up,
    fs_handle_click,
    fs_submit_path,
    fs_export_current,
    fs_do_mkdir,
    fs_do_delete,
    fs_do_rename,
    fs_do_paste,
  }
}
