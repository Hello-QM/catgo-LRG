/**
 * PTY API client — auto-detects runtime and picks the best transport:
 *
 * 1. Tauri desktop: xterm.js ←→ Tauri IPC (invoke/events) ←→ Rust PTY
 * 2. Browser/WSL:   xterm.js ←→ WebSocket ←→ FastAPI Python PTY
 *
 * Both paths use base64-encoded terminal bytes for safe JSON transport.
 */

import { WS_BASE, API_BASE } from './config'

export interface PtySession {
  id: number
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  kill(): Promise<void>
  onData(cb: (data: Uint8Array) => void): () => void
  onExit(cb: () => void): () => void
  /** Called when connection drops and reconnection starts. Only for WebSocket sessions. */
  onDisconnect?(cb: () => void): () => void
  /** Called when a reconnection succeeds. Only for WebSocket sessions. */
  onReconnect?(cb: () => void): () => void
  dispose(): void
}

/** Decode a base64 string to Uint8Array (safe for multi-byte UTF-8). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function isTauri(): boolean {
  return typeof window !== `undefined` &&
    (`__TAURI__` in window || `__TAURI_INTERNALS__` in window)
}

export interface ShellInfo {
  id: string
  label: string
}

export interface PtySpawnOpts {
  cwd?: string
  /** HPC session_id for remote SSH terminal. Omit for local shell. */
  session_id?: string
  /** Shell ID to spawn (e.g. 'powershell', 'git-bash', 'cmd'). */
  shell?: string
}

/** Fetch available local shells from the backend. */
export async function fetchAvailableShells(): Promise<ShellInfo[]> {
  try {
    const res = await fetch(`/api/pty/shells`)
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

/**
 * Spawn a new PTY session. Automatically chooses Tauri IPC or WebSocket.
 * Pass opts.session_id to open a remote terminal on an HPC server.
 */
export async function spawnPty(
  cols: number,
  rows: number,
  opts?: PtySpawnOpts,
): Promise<PtySession> {
  // Remote SSH always goes through WebSocket (Python server has the SSH connection)
  if (opts?.session_id) {
    return spawnWebSocketPty(cols, rows, opts.session_id)
  }
  if (isTauri()) {
    return spawnTauriPty(cols, rows, opts?.cwd)
  }
  return spawnWebSocketPty(cols, rows, undefined, opts?.shell)
}

// ====== Tauri IPC transport ======

async function spawnTauriPty(cols: number, rows: number, cwd?: string): Promise<PtySession> {
  const { invoke } = await import(`@tauri-apps/api/core`)
  const { listen } = await import(`@tauri-apps/api/event`)

  const id = await invoke<number>(`pty_spawn`, { cols, rows, cwd })
  const unlisteners: Array<() => void> = []

  return {
    id,
    async write(data: string) { await invoke(`pty_write`, { id, data }) },
    async resize(cols: number, rows: number) { await invoke(`pty_resize`, { id, cols, rows }) },
    async kill() { await invoke(`pty_kill`, { id }) },

    onData(cb: (data: Uint8Array) => void): () => void {
      // `cancelled` guards the case where the caller unsubscribes BEFORE the
      // async listen() resolves (rapid subscribe/unsubscribe, e.g. one per
      // run_command): without it the listener would register after off() and
      // leak for the PTY's lifetime.
      let unlisten: (() => void) | null = null
      let cancelled = false
      listen<{ id: number; data: string }>(`pty-output`, (event) => {
        if (event.payload.id === id) cb(b64ToBytes(event.payload.data))
      }).then((fn) => {
        if (cancelled) { fn(); return }
        unlisten = fn; unlisteners.push(fn)
      })
      return () => { cancelled = true; unlisten?.() }
    },

    onExit(cb: () => void): () => void {
      let unlisten: (() => void) | null = null
      let cancelled = false
      listen<{ id: number; success: boolean }>(`pty-exit`, (event) => {
        if (event.payload.id === id) cb()
      }).then((fn) => {
        if (cancelled) { fn(); return }
        unlisten = fn; unlisteners.push(fn)
      })
      return () => { cancelled = true; unlisten?.() }
    },

    dispose() {
      for (const fn of unlisteners) fn()
      unlisteners.length = 0
    },
  }
}

// ====== WebSocket transport (FastAPI fallback) ======

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000]
const HEARTBEAT_INTERVAL = 30_000
const CONNECTION_TIMEOUT = 10_000

/** Try to find a replacement session for an expired HPC session (same host). */
async function _try_recover_session(old_session_id?: string): Promise<string | null> {
  if (!old_session_id) return null
  try {
    const resp = await fetch(`${API_BASE}/hpc/connections`)
    if (!resp.ok) return null
    const connections: Array<{ session_id: string; host: string; username: string }> = await resp.json()
    // Any remote session that isn't the dead one is a valid replacement
    const replacement = connections.find(c => c.session_id !== `__local__` && c.session_id !== old_session_id)
    return replacement?.session_id ?? null
  } catch {
    return null
  }
}

async function spawnWebSocketPty(
  cols: number, rows: number, hpc_session_id?: string, shell?: string,
): Promise<PtySession> {
  // In desktop:dev mode (Vite without Tauri), try the Vite dev server's PTY first,
  // then fall back to the Python backend. For HPC sessions, always use Python backend.
  const vite_ws_url = `ws://${window.location.host}/api/pty/session`
  const backend_ws_url = `${WS_BASE}/pty/session`
  const use_vite = !isTauri() && !hpc_session_id && vite_ws_url !== backend_ws_url
  const ws_url = use_vite ? vite_ws_url : backend_ws_url

  let ws: WebSocket | null = null
  let sessionId = 0
  let dataCallbacks: Array<(data: Uint8Array) => void> = []
  let exitCallbacks: Array<() => void> = []
  let disconnectCallbacks: Array<() => void> = []
  let reconnectCallbacks: Array<() => void> = []
  let opened = false
  let disposed = false
  let reconnecting = false
  let reconnect_attempts = 0
  let needs_session_recovery = false
  let current_cols = cols
  let current_rows = rows
  let ws_gen = 0 // track current WebSocket generation to ignore stale events

  function create_ws_connection(): Promise<void> {
    const gen = ++ws_gen

    return new Promise<void>((resolve, reject) => {
      let resolved = false
      const timeout_id = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error(`Connection timeout`))
        }
      }, CONNECTION_TIMEOUT)

      let new_ws: WebSocket
      try {
        new_ws = new WebSocket(ws_url)
      } catch (e) {
        clearTimeout(timeout_id)
        reject(e)
        return
      }

      new_ws.onopen = () => {
        if (gen !== ws_gen) { new_ws.close(); return }
        const open_msg: Record<string, unknown> = { action: `open`, cols: current_cols, rows: current_rows }
        if (hpc_session_id) open_msg.session_id = hpc_session_id
        if (shell) open_msg.shell = shell
        new_ws.send(JSON.stringify(open_msg))
      }

      new_ws.onmessage = (event) => {
        if (gen !== ws_gen) return
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case `opened`:
            sessionId = msg.id
            opened = true
            reconnecting = false
            reconnect_attempts = 0
            ws = new_ws
            if (!resolved) {
              resolved = true
              clearTimeout(timeout_id)
              resolve()
            }
            for (const cb of reconnectCallbacks) cb()
            break
          case `output`: {
            const bytes = b64ToBytes(msg.data)
            for (const cb of dataCallbacks) cb(bytes)
            break
          }
          case `closed`:
            if (opened && !disposed) {
              opened = false
              schedule_reconnect()
            } else {
              opened = false
            }
            break
          case `error`:
            console.warn(`[PTY WS]`, msg.message)
            // Session gone — mark for recovery instead of disposing
            if (typeof msg.message === `string` && (msg.message.includes(`not found`) || msg.message.includes(`expired`))) {
              opened = false
              needs_session_recovery = true
              window.dispatchEvent(new CustomEvent(`catgo:hpc-session-expired`))
              // Don't set disposed — let schedule_reconnect handle recovery
            }
            break
          case `pong`:
            break
        }
      }

      new_ws.onclose = () => {
        if (gen !== ws_gen) return
        if (opened && !disposed) {
          opened = false
          schedule_reconnect()
        }
        if (!resolved) {
          resolved = true
          clearTimeout(timeout_id)
          reject(new Error(`WebSocket closed before session opened`))
        }
      }

      new_ws.onerror = () => {
        // onclose will handle cleanup
      }
    })
  }

  function schedule_reconnect() {
    if (disposed || reconnect_attempts >= MAX_RECONNECT_ATTEMPTS) {
      reconnecting = false
      for (const cb of exitCallbacks) cb()
      return
    }
    if (!reconnecting) {
      // First disconnect — notify listeners
      for (const cb of disconnectCallbacks) cb()
    }
    reconnecting = true
    reconnect_attempts++
    const delay = RECONNECT_DELAYS[Math.min(reconnect_attempts - 1, RECONNECT_DELAYS.length - 1)]

    setTimeout(async () => {
      if (disposed) return
      // If session expired, try to find a replacement before reconnecting
      if (needs_session_recovery && hpc_session_id) {
        const new_sid = await _try_recover_session(hpc_session_id)
        if (new_sid) {
          console.info(`[PTY WS] Recovered HPC session: ${new_sid}`)
          hpc_session_id = new_sid
          needs_session_recovery = false
          reconnect_attempts = 0 // reset — this is a fresh session
        }
        // If no replacement found, still try — maybe user will reconnect later
      }
      try {
        await create_ws_connection()
        needs_session_recovery = false
      } catch {
        schedule_reconnect()
      }
    }, delay)
  }

  // Initial connection
  await create_ws_connection()

  // Heartbeat ping to detect dead connections early
  const ping_iv = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ action: `ping` })) } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL)

  return {
    get id() { return sessionId },

    async write(data: string) {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: `input`, data }))
    },

    async resize(c: number, r: number) {
      current_cols = c
      current_rows = r
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: `resize`, cols: c, rows: r }))
    },

    async kill() {
      disposed = true // prevent reconnection
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ action: `close` }))
      ws?.close()
    },

    onData(cb: (data: Uint8Array) => void): () => void {
      dataCallbacks.push(cb)
      return () => { dataCallbacks = dataCallbacks.filter((c) => c !== cb) }
    },

    onExit(cb: () => void): () => void {
      exitCallbacks.push(cb)
      return () => { exitCallbacks = exitCallbacks.filter((c) => c !== cb) }
    },

    onDisconnect(cb: () => void): () => void {
      disconnectCallbacks.push(cb)
      return () => { disconnectCallbacks = disconnectCallbacks.filter((c) => c !== cb) }
    },

    onReconnect(cb: () => void): () => void {
      reconnectCallbacks.push(cb)
      return () => { reconnectCallbacks = reconnectCallbacks.filter((c) => c !== cb) }
    },

    dispose() {
      disposed = true
      clearInterval(ping_iv)
      dataCallbacks = []
      exitCallbacks = []
      disconnectCallbacks = []
      reconnectCallbacks = []
      ws?.close()
    },
  }
}
