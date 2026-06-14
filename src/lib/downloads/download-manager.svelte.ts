export type DownloadStatus = 'queued' | 'selecting' | 'downloading' | 'completed' | 'failed' | 'canceled'
export type DownloadPlatform = 'browser' | 'desktop' | 'mobile'

export interface DownloadTask {
  id: string
  filename: string
  source_path: string
  save_path?: string
  status: DownloadStatus
  platform: DownloadPlatform
  is_archive: boolean
  received_bytes: number
  total_bytes: number | null
  error?: string
  created_at: number
  updated_at: number
  abort_controller?: AbortController
}

export function create_download_manager() {
  let tasks = $state<DownloadTask[]>([])
  let panel_open = $state(false)

  function add(task: Omit<DownloadTask, 'id' | 'created_at' | 'updated_at'>): DownloadTask {
    const now = Date.now()
    const entry: DownloadTask = {
      ...task,
      id: crypto.randomUUID?.() ?? `download-${now}-${Math.random().toString(36).slice(2)}`,
      created_at: now,
      updated_at: now,
    }
    tasks = [entry, ...tasks]
    panel_open = true
    return entry
  }

  function update(id: string, patch: Partial<Omit<DownloadTask, 'id' | 'created_at'>>): void {
    const now = Date.now()
    tasks = tasks.map((task) => task.id === id ? { ...task, ...patch, updated_at: now } : task)
  }

  function remove(id: string): void {
    tasks = tasks.filter((task) => task.id !== id)
  }

  function clear_finished(): void {
    tasks = tasks.filter((task) => task.status === 'queued' || task.status === 'selecting' || task.status === 'downloading')
  }

  function cancel(id: string): void {
    const task = tasks.find((item) => item.id === id)
    task?.abort_controller?.abort()
    update(id, { status: 'canceled' })
  }

  return {
    get tasks() { return tasks },
    get panel_open() { return panel_open },
    set panel_open(value: boolean) { panel_open = value },
    add,
    update,
    remove,
    clear_finished,
    cancel,
  }
}

export const download_manager = create_download_manager()

export function format_download_size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
