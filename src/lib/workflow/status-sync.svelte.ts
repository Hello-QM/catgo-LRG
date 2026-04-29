/**
 * Cross-window sync via localStorage + storage events + polling fallback.
 *
 * BroadcastChannel does NOT work across Tauri WebviewWindows.
 * localStorage is shared across same-origin windows. The `storage` event
 * fires in other browser tabs, but does NOT reliably fire across Tauri
 * WebviewWindows. To handle this, `store_listen` uses a polling fallback
 * that checks for changes every 300ms when storage events aren't received.
 *
 * Keys:
 *  - catgo-popout-selection  : main → popout  (user clicked a different node)
 *  - catgo-popout-status     : main → popout  (node status update)
 *  - catgo-popout-pinned-*   : main → popout  (init data for pinned windows)
 *  - catgo-popout-command    : popout → main  (import, edit 3D, params change)
 *
 * Each write includes `_ts` to ensure the `storage` event fires even when
 * the payload is identical (e.g. user re-selects the same node).
 */

const SEL_KEY = `catgo-popout-selection`
const STATUS_KEY = `catgo-popout-status`
const CMD_KEY = `catgo-popout-command`
const PINNED_PREFIX = `catgo-popout-pinned-`

export interface StatusContext {
  workflow_id: string
  node_id: string
  node_type: string
  node_label: string
  status: string
  node_params: Record<string, unknown>
  /** Resolved upstream structure JSON (for computation nodes that take structure input) */
  upstream_structure_json?: string | null
}

// ─── helpers ───

function store_write(key: string, data: unknown): void {
  try { localStorage.setItem(key, JSON.stringify({ ...data as object, _ts: Date.now() })) } catch {}
}

function store_read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    delete parsed._ts
    return parsed as T
  } catch { return null }
}

function store_listen<T>(key: string, cb: (data: T) => void): () => void {
  let last_ts: number | null = null

  // Initialize last_ts from current localStorage value
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      last_ts = parsed._ts ?? null
    }
  } catch {}

  function process_raw(raw: string): void {
    try {
      const parsed = JSON.parse(raw)
      const ts = parsed._ts
      if (ts !== undefined && ts === last_ts) return  // Already processed
      last_ts = ts ?? null
      delete parsed._ts
      cb(parsed as T)
    } catch {}
  }

  // Primary: storage event (works in browser tabs, but not Tauri WebviewWindows)
  const handler = (e: StorageEvent) => {
    if (e.key !== key || !e.newValue) return
    process_raw(e.newValue)
  }
  window.addEventListener(`storage`, handler)

  // Fallback: poll localStorage for changes (handles Tauri WebviewWindows)
  const poll_interval = setInterval(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw) process_raw(raw)
    } catch {}
  }, 300)

  return () => {
    window.removeEventListener(`storage`, handler)
    clearInterval(poll_interval)
  }
}

// ─── Selection (main → follow-mode popout) ───

export function broadcast_selection(ctx: StatusContext): void { store_write(SEL_KEY, ctx) }
export function read_selection(): StatusContext | null { return store_read<StatusContext>(SEL_KEY) }
export function listen_selection(cb: (ctx: StatusContext) => void): () => void {
  return store_listen<StatusContext>(SEL_KEY, (ctx) => { if (ctx.node_id) cb(ctx) })
}

// ─── Status updates (main → all popouts) ───

export function broadcast_status(ctx: StatusContext): void { store_write(STATUS_KEY, ctx) }
export function listen_status(cb: (ctx: StatusContext) => void, filter_node_id?: string | null): () => void {
  return store_listen<StatusContext>(STATUS_KEY, (ctx) => {
    if (!ctx.node_id) return
    if (filter_node_id && ctx.node_id !== filter_node_id) return
    cb(ctx)
  })
}

// ─── Pinned node data (main → pinned popout, one key per node) ───

export function write_pinned(node_id: string, ctx: StatusContext): void {
  store_write(PINNED_PREFIX + node_id, ctx)
}
export function read_pinned(node_id: string): StatusContext | null {
  return store_read<StatusContext>(PINNED_PREFIX + node_id)
}

// ─── Commands (popout → main) ───

export interface PopoutCommand {
  type: `import` | `edit_3d` | `params_change`
  node_id: string
  params?: Record<string, unknown>
}

export function send_command(cmd: PopoutCommand): void { store_write(CMD_KEY, cmd) }
export function listen_command(cb: (cmd: PopoutCommand) => void): () => void {
  return store_listen<PopoutCommand>(CMD_KEY, (cmd) => { if (cmd.type) cb(cmd) })
}
