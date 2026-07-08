/**
 * 5A: HPC file browser state and handlers.
 * Extracted from Sidebar.svelte.
 *
 * Uses factory function pattern — $state must be created in component context.
 */

import { readRemoteFile, uploadFile, getDownloadUrl, mergeStructuresFromDir, hpc_mkdir, hpc_delete, hpc_rename, hpc_copy, hpc_move } from '$lib/api/hpc'
import { read_file } from '$lib/api/project'
import { LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'
import { start_hpc_managed_download } from '$lib/downloads/hpc-download'
import { download } from '$lib/io/fetch'
import type { RemoteFile } from '$lib/api/hpc'

export interface HpcBrowserCallbacks {
  get_source: () => string
  on_load_file: (content: string | ArrayBuffer, filename: string, file_path?: string, session_id?: string) => void
  on_open_editor?: (content: string, filename: string, file_path: string, session_id: string) => void
  on_load_trajectory?: (content: string, filename: string, meta?: { session_id: string; dir_path: string }) => void
  /** Stream a large trajectory from a backend-local path (after remote materialize). */
  on_load_trajectory_stream?: (path: string, filename: string) => void | Promise<void>
  on_preview_file?: (mode: string, filename: string, file_path: string, session_id: string, content?: string, binary_data?: string, mime_type?: string) => void
}

export function create_hpc_browser_state(callbacks: HpcBrowserCallbacks) {
  let hpc_current_path = $state(`~`)
  let hpc_merging_dir = $state<string | null>(null)
  let hpc_merge_status = $state<{ type: `success` | `error`; message: string } | null>(null)
  let hpc_merge_timer: ReturnType<typeof setTimeout> | null = null
  let hpc_upload_progress = $state<number | null>(null)
  let hpc_files_error = $state(``)
  let hpc_file_tree_key = $state(0)
  let hpc_loading_file = $state<{ name: string; size?: number } | null>(null)

  function set_hpc_merge_status(type: `success` | `error`, message: string) {
    hpc_merge_status = { type, message }
    if (hpc_merge_timer) clearTimeout(hpc_merge_timer)
    hpc_merge_timer = setTimeout(() => { hpc_merge_status = null }, type === `success` ? 5000 : 8000)
  }

  /** Cleanup merge timer — call on component destroy */
  function cleanup() {
    if (hpc_merge_timer) clearTimeout(hpc_merge_timer)
  }

  /** Read file content — local filesystem (read_file) or remote (readRemoteFile) */
  async function read_file_content(file: RemoteFile): Promise<string | null> {
    const source = callbacks.get_source()
    if (source === LOCAL_SESSION_ID) {
      const result = await read_file(file.path)
      return result.content || null
    }
    const result = await readRemoteFile(source, file.path)
    if (!result.success) {
      set_hpc_merge_status(`error`, `Failed to read ${file.name}: ${result.message || `unknown error`}`)
      return null
    }
    if (!result.content) {
      set_hpc_merge_status(`error`, `${file.name} is empty`)
      return null
    }
    return result.content
  }

  /** Read binary file — local via Tauri readFile, remote via readRemoteBinaryFile */
  async function read_binary_content(file: RemoteFile): Promise<{ data: string; mime_type: string } | null> {
    const source = callbacks.get_source()
    if (source === LOCAL_SESSION_ID) {
      try {
        const { readFile } = await import(`@tauri-apps/plugin-fs`)
        const bytes = await readFile(file.path)
        const ext = file.name.toLowerCase().split(`.`).pop() || ``
        const mime = ext === `svg` ? `image/svg+xml` : ext === `gif` ? `image/gif` : ext === `webp` ? `image/webp` : ext === `bmp` ? `image/bmp` : ext.startsWith(`tif`) ? `image/tiff` : ext === `pdf` ? `application/pdf` : `image/${ext === `jpg` ? `jpeg` : ext}`
        let bin = ``
        const chunk_size = 8192
        for (let i = 0; i < bytes.length; i += chunk_size) {
          bin += String.fromCharCode(...bytes.subarray(i, i + chunk_size))
        }
        const data = btoa(bin)
        return { data, mime_type: mime }
      } catch {
        // Tauri plugin-fs not available (desktop:dev) — try backend
        const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
        const result = await readRemoteBinaryFile(source, file.path)
        return result.success ? { data: result.data, mime_type: result.mime_type } : null
      }
    }
    const { readRemoteBinaryFile } = await import(`$lib/api/hpc`)
    const result = await readRemoteBinaryFile(source, file.path)
    return result.success ? { data: result.data, mime_type: result.mime_type } : null
  }

  async function hpc_load_structure(file: RemoteFile) {
    const source = callbacks.get_source()
    hpc_loading_file = { name: file.name, size: file.size_bytes }
    try {
      // Large remote trajectory → materialize to a backend-local cache file
      // (gzip on the wire) and stream frames, instead of pulling the whole
      // file into the webview (which freezes it).
      if (callbacks.on_load_trajectory_stream) {
        const { materialize_remote_if_large } = await import('$lib/trajectory/remote-frame-loader')
        const local = await materialize_remote_if_large(source, file.path, file.name, file.size_bytes)
        if (local) {
          const nm = file.path.split(/[/\\]/).pop() || file.name
          await callbacks.on_load_trajectory_stream(local, nm)
          return
        }
      }
      const content = await read_file_content(file)
      if (!content) return
      const filename = file.path.split(/[/\\]/).pop() || file.name
      // Auto-detect trajectory files
      const { is_trajectory_file } = await import('$lib/trajectory/parse')
      if (callbacks.on_load_trajectory && is_trajectory_file(file.name, content)) {
        callbacks.on_load_trajectory(content, filename, { session_id: source, dir_path: file.path })
      } else {
        // For ambiguous extensions (.out, .log), fall back to editor if not a known structure
        const { is_structure_file } = await import('$lib/structure/parse')
        if (!is_structure_file(file.name) && callbacks.on_open_editor) {
          callbacks.on_open_editor(content, file.name, file.path, source)
        } else {
          callbacks.on_load_file(content, filename, file.path, source)
        }
      }
    } catch (err) {
      console.error(`Failed to load structure:`, err)
      set_hpc_merge_status(`error`, `Failed to load ${file.name}: ${err}`)
    } finally {
      hpc_loading_file = null
    }
  }

  async function hpc_open_editor(file: RemoteFile) {
    if (!callbacks.on_open_editor) return
    const source = callbacks.get_source()
    hpc_loading_file = { name: file.name, size: file.size_bytes }
    try {
      const content = await read_file_content(file)
      if (content !== null) {
        callbacks.on_open_editor(content, file.name, file.path, source)
      }
    } catch (err) {
      console.error(`Failed to open file:`, err)
    } finally {
      hpc_loading_file = null
    }
  }

  async function hpc_open_preview(file: RemoteFile, preview_type: string) {
    if (!callbacks.on_preview_file) return
    const source = callbacks.get_source()
    const is_binary = preview_type === `image` || preview_type === `pdf` || preview_type === `excel` || preview_type === `docx`
    try {
      if (is_binary) {
        const result = await read_binary_content(file)
        if (result) {
          callbacks.on_preview_file(preview_type, file.name, file.path, source, undefined, result.data, result.mime_type)
        }
      } else {
        const content = await read_file_content(file)
        if (content !== null) {
          callbacks.on_preview_file(preview_type, file.name, file.path, source, content)
        }
      }
    } catch (e) {
      console.error(`Failed to preview file:`, e)
    }
  }

  async function hpc_merge_trajectory(dir: RemoteFile, pattern: string = `CONTCAR`) {
    if (!callbacks.on_load_trajectory) return
    const source = callbacks.get_source()
    hpc_merging_dir = dir.name
    hpc_merge_status = null
    try {
      const result = await mergeStructuresFromDir(source, dir.path, pattern)
      if (result.success && result.content) {
        callbacks.on_load_trajectory(result.content, `${dir.name}_${pattern}_trajectory.xyz`, {
          session_id: source,
          dir_path: dir.path,
        })
        set_hpc_merge_status(`success`, `Loaded ${pattern} trajectory from ${dir.name}/`)
      } else {
        set_hpc_merge_status(`error`, `No ${pattern} files found in ${dir.name}/`)
      }
    } catch (e: any) {
      set_hpc_merge_status(`error`, `Merge failed: ${e?.message || String(e)}`)
    } finally {
      hpc_merging_dir = null
    }
  }

  async function hpc_upload(event: Event) {
    const source = callbacks.get_source()
    const input = event.target as HTMLInputElement
    const files = input.files
    if (!files?.length) return
    hpc_files_error = ``
    for (const file of files) {
      hpc_upload_progress = 0
      try {
        await uploadFile(source, hpc_current_path, file, (p) => { hpc_upload_progress = p })
      } catch (err) {
        hpc_files_error = `Upload failed: ${err}`
        break
      }
    }
    hpc_upload_progress = null
    hpc_file_tree_key++
    input.value = ``
  }

  async function hpc_download(file: RemoteFile) {
    const source = callbacks.get_source()
    if (source === LOCAL_SESSION_ID) {
      const { check_tauri } = await import(`$lib/io/tauri`)
      if (check_tauri()) {
        // Desktop app: open the local file with the system default app.
        try {
          const { open } = await import(`@tauri-apps/plugin-shell`)
          await open(file.path)
        } catch {
          navigator.clipboard.writeText(file.path).catch(() => {})
        }
      } else if (!file.is_dir) {
        // Web/dev mode: Tauri shell is unavailable (the button was a silent
        // no-op), so fetch the file via /__files/raw and route through the
        // shared download() helper (native save dialog on desktop).
        const url = `/__files/raw?path=${encodeURIComponent(file.path)}`
        const blob = await (await fetch(url)).blob()
        download(blob, file.name, `application/octet-stream`)
      } else {
        navigator.clipboard.writeText(file.path).catch(() => {})
      }
      return
    }
    const filename = file.is_dir ? `${file.name}.tar.gz` : file.name
    try {
      hpc_files_error = ``
      hpc_loading_file = { name: filename, size: file.is_dir ? undefined : file.size_bytes }
      hpc_upload_progress = file.is_dir ? null : 0

      const handled = await start_hpc_managed_download({
        session_id: source,
        remote_path: file.path,
        filename,
        is_dir: file.is_dir,
      })
      if (handled) return

      const global_download = (globalThis as Record<string, unknown>).download
      if (typeof document !== `undefined` && typeof global_download !== `function`) {
        const url = getDownloadUrl(source, file.path, { is_dir: file.is_dir, skip_stat: true })
        const blob = await (await fetch(url)).blob()
        download(blob, filename, `application/octet-stream`)
        return
      }
    } catch (err) {
      hpc_files_error = `Download failed: ${err}`
    } finally {
      hpc_loading_file = null
      hpc_upload_progress = null
    }
  }

  function hpc_copy_path(file: RemoteFile) {
    navigator.clipboard.writeText(file.path).catch(() => {})
  }

  return {
    get hpc_current_path() { return hpc_current_path },
    set hpc_current_path(v: string) { hpc_current_path = v },
    get hpc_merging_dir() { return hpc_merging_dir },
    get hpc_merge_status() { return hpc_merge_status },
    get hpc_upload_progress() { return hpc_upload_progress },
    get hpc_files_error() { return hpc_files_error },
    get hpc_file_tree_key() { return hpc_file_tree_key },
    set hpc_file_tree_key(v: number) { hpc_file_tree_key = v },
    get hpc_loading_file() { return hpc_loading_file },
    set_hpc_merge_status,
    read_file_content,
    read_binary_content,
    hpc_load_structure,
    hpc_open_editor,
    hpc_open_preview,
    hpc_merge_trajectory,
    hpc_upload,
    hpc_download,
    hpc_copy_path,
    cleanup,
    // HPC file operations — wrappers that use current source
    async hpc_do_mkdir(parent_path: string, name: string) {
      const source = callbacks.get_source()
      const sep = parent_path.endsWith(`/`) ? `` : `/`
      await hpc_mkdir(source, `${parent_path}${sep}${name}`)
    },
    async hpc_do_delete(file: RemoteFile) {
      const source = callbacks.get_source()
      await hpc_delete(source, file.path)
    },
    async hpc_do_rename(file: RemoteFile, new_name: string) {
      const source = callbacks.get_source()
      const last_sep = Math.max(file.path.lastIndexOf(`/`), file.path.lastIndexOf(`\\`))
      const parent = last_sep >= 0 ? file.path.substring(0, last_sep) : ``
      const sep = file.path.includes(`\\`) ? `\\` : `/`
      await hpc_rename(source, file.path, `${parent}${sep}${new_name}`)
    },
    async hpc_do_copy(src: RemoteFile, dest: string) {
      const source = callbacks.get_source()
      await hpc_copy(source, src.path, dest)
    },
    async hpc_do_move(src: RemoteFile, dest: string) {
      const source = callbacks.get_source()
      await hpc_move(source, src.path, dest)
    },
    async hpc_do_upload(files: FileList | File[], dest_path: string) {
      const source = callbacks.get_source()
      hpc_files_error = ``
      for (const file of files) {
        hpc_upload_progress = 0
        try {
          await uploadFile(source, dest_path, file, (p) => { hpc_upload_progress = p })
        } catch (err) {
          hpc_files_error = `Upload failed: ${err}`
          break
        }
      }
      hpc_upload_progress = null
      hpc_file_tree_key++
    },
  }
}
