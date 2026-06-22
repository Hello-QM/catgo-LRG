import { getDownloadUrl } from '$lib/api/hpc'
import { isMobile } from '$lib/api/transport'
import { check_tauri } from '$lib/io/tauri'
import { t, load_i18n_module } from '$lib/i18n/index.svelte'
import { download_manager, type DownloadTask } from './download-manager.svelte'

load_i18n_module('common')

export interface HpcManagedDownloadInput {
  session_id: string
  remote_path: string
  filename: string
  is_dir: boolean
}

interface HpcDownloadManager {
  tasks: DownloadTask[]
  panel_open: boolean
  add(task: Omit<DownloadTask, 'id' | 'created_at' | 'updated_at'>): DownloadTask
  update(id: string, patch: Partial<Omit<DownloadTask, 'id' | 'created_at'>>): void
}

export interface HpcDownloadDeps {
  manager: HpcDownloadManager
  check_tauri: () => boolean
  is_mobile: () => boolean
  translate: (key: string) => string
  get_download_url: typeof getDownloadUrl
  save_dialog: (options: {
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<string | null>
  fetch_impl: typeof fetch
  write_file: (path: string, data: Uint8Array | ReadableStream<Uint8Array>) => Promise<void>
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function write_stream_to_file(
  deps: Pick<HpcDownloadDeps, 'manager' | 'fetch_impl' | 'write_file'>,
  url: string,
  save_path: string,
  task_id: string,
  signal: AbortSignal,
): Promise<number> {
  const response = await deps.fetch_impl(url, { signal })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = await response.json()
      detail = body?.detail || body?.message || detail
    } catch {
      const text = await response.text().catch(() => ``)
      if (text) detail = text.slice(0, 300)
    }
    throw new Error(`Download failed (${response.status}): ${detail}`)
  }

  const total_header = response.headers.get(`Content-Length`)
  const total_bytes = total_header ? Number.parseInt(total_header, 10) : 0
  deps.manager.update(task_id, {
    status: 'downloading',
    total_bytes: Number.isFinite(total_bytes) && total_bytes > 0 ? total_bytes : null,
  })

  let received = 0

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    await deps.write_file(save_path, bytes)
    received = bytes.byteLength
    deps.manager.update(task_id, { received_bytes: received })
    return received
  }

  const progress_stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (signal.aborted) throw new DOMException('Download canceled', 'AbortError')
      received += chunk.byteLength
      deps.manager.update(task_id, { received_bytes: received })
      controller.enqueue(chunk)
    },
  }))

  await deps.write_file(save_path, progress_stream)
  return received
}

export async function start_hpc_managed_download_with_deps(
  input: HpcManagedDownloadInput,
  deps: HpcDownloadDeps,
): Promise<boolean> {
  if (!deps.check_tauri()) return false

  if (deps.is_mobile()) {
    // `add` already opens the panel; just record the unsupported-platform task.
    deps.manager.add({
      filename: input.filename,
      source_path: input.remote_path,
      platform: 'mobile',
      is_archive: input.is_dir,
      status: 'failed',
      received_bytes: 0,
      total_bytes: null,
      error: deps.translate('common.download_mobile_unsupported'),
    })
    return true
  }

  const abort_controller = new AbortController()
  const task = deps.manager.add({
    filename: input.filename,
    source_path: input.remote_path,
    platform: 'desktop',
    is_archive: input.is_dir,
    status: 'selecting',
    received_bytes: 0,
    total_bytes: input.is_dir ? null : 0,
    abort_controller,
  })

  try {
    const ext = input.filename.includes('.') ? input.filename.split('.').pop()?.toLowerCase() : undefined
    const filters = [
      { name: input.is_dir ? 'Archives' : 'All Files', extensions: input.is_dir ? ['gz', 'tgz', 'zip', '*'] : ['*'] },
    ]
    if (ext && !input.is_dir) filters.unshift({ name: `${ext.toUpperCase()} Files`, extensions: [ext] })

    const save_path = await deps.save_dialog({
      defaultPath: input.filename,
      filters,
    })

    if (!save_path) {
      deps.manager.update(task.id, { status: 'canceled' })
      return true
    }

    if (abort_controller.signal.aborted) {
      deps.manager.update(task.id, { status: 'canceled' })
      return true
    }

    deps.manager.update(task.id, { save_path, status: 'queued' })
    const url = deps.get_download_url(input.session_id, input.remote_path, {
      is_dir: input.is_dir,
      skip_stat: input.is_dir,
    })
    const received = await write_stream_to_file(deps, url, save_path, task.id, abort_controller.signal)
    deps.manager.update(task.id, {
      status: abort_controller.signal.aborted ? 'canceled' : 'completed',
      received_bytes: received,
    })
    return true
  } catch (error) {
    deps.manager.update(task.id, {
      status: abort_controller.signal.aborted ? 'canceled' : 'failed',
      error: abort_controller.signal.aborted ? undefined : error_message(error),
    })
    return true
  }
}

export async function start_hpc_managed_download(input: HpcManagedDownloadInput): Promise<boolean> {
  if (!check_tauri()) return false

  if (isMobile()) {
    return start_hpc_managed_download_with_deps(input, {
      manager: download_manager,
      check_tauri: () => true,
      is_mobile: () => true,
      translate: t,
      get_download_url: getDownloadUrl,
      save_dialog: async () => null,
      // Bind to globalThis: passing bare `fetch` makes `deps.fetch_impl(...)` call
    // fetch with `this === deps`, which WebKitGTK (the packaged Linux/Tauri
    // WKWebView) rejects with "Can only call Window.fetch on instances of
    // Window". Chromium (dev) is lenient, so this only bit packaged builds.
    fetch_impl: fetch.bind(globalThis),
      write_file: async () => {},
    })
  }

  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  return start_hpc_managed_download_with_deps(input, {
    manager: download_manager,
    check_tauri: () => true,
    is_mobile: () => false,
    translate: t,
    get_download_url: getDownloadUrl,
    save_dialog: save,
    // Bind to globalThis: passing bare `fetch` makes `deps.fetch_impl(...)` call
    // fetch with `this === deps`, which WebKitGTK (the packaged Linux/Tauri
    // WKWebView) rejects with "Can only call Window.fetch on instances of
    // Window". Chromium (dev) is lenient, so this only bit packaged builds.
    fetch_impl: fetch.bind(globalThis),
    write_file: writeFile,
  })
}
