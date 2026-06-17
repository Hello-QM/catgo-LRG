/**
 * Global (per-window) poller for SDK-agent terminal requests. The backend
 * `catgo_terminal` MCP tool enqueues a request; this polls /api/terminal/pending,
 * gates run/send_keys/interrupt behind an approval card, executes via the
 * terminal-registry (the real visible PTY), and POSTs /api/terminal/result.
 */
import { API_BASE } from '$lib/api/config'
import { ensure_active_terminal } from '$lib/structure/terminal-registry.svelte'
import { resolve_keys } from '$lib/structure/terminal-capture'

interface TerminalReq {
  request_id: string
  action: string
  command?: string
  keys?: string
  lines?: number
}

// Approval state the App modal binds to. When a request needs approval, the
// poller sets `pending` and awaits the promise resolved by allow()/deny().
export const approval = $state<{
  pending: { action: string; detail: string } | null
  auto_run: boolean
  _resolve: ((ok: boolean) => void) | null
}>({ pending: null, auto_run: false, _resolve: null })

export function approval_allow(): void {
  const r = approval._resolve
  approval.pending = null
  approval._resolve = null
  r?.(true)
}

export function approval_deny(): void {
  const r = approval._resolve
  approval.pending = null
  approval._resolve = null
  r?.(false)
}

function request_approval(action: string, detail: string): Promise<boolean> {
  if (approval.auto_run) return Promise.resolve(true)
  return new Promise((resolve) => {
    approval.pending = { action, detail }
    approval._resolve = resolve
  })
}

async function post_result(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${API_BASE}/terminal/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // renderer best-effort — the backend request will time out if we can't reply
  }
}

async function handle_one(req: TerminalReq): Promise<void> {
  const mutating = req.action === 'run' || req.action === 'send_keys' || req.action === 'interrupt'
  const detail = req.action === 'run'
    ? (req.command ?? '')
    : req.action === 'send_keys'
      ? (req.keys ?? '')
      : req.action
  if (mutating) {
    const ok = await request_approval(req.action, detail)
    if (!ok) {
      await post_result({ request_id: req.request_id, denied: true })
      return
    }
  }
  const h = await ensure_active_terminal()
  if (!h) {
    await post_result({ request_id: req.request_id, error: 'no terminal available' })
    return
  }
  const target = h.is_remote ? `remote (${h.host ?? h.session_id})` : 'local shell'
  let result: Record<string, unknown>
  if (req.action === 'run') {
    result = await h.run_command(String(req.command ?? ''))
  } else if (req.action === 'read') {
    result = { output: h.read_buffer(typeof req.lines === 'number' ? req.lines : 40) }
  } else if (req.action === 'send_keys') {
    await h.send_keys(resolve_keys(String(req.keys ?? '')))
    await new Promise((r) => setTimeout(r, 200))
    result = { output: h.read_buffer(40) }
  } else {
    // interrupt
    await h.interrupt()
    await new Promise((r) => setTimeout(r, 200))
    result = { output: h.read_buffer(40) }
  }
  await post_result({ request_id: req.request_id, target, ...result })
}

let _started = false
let _busy = false

export function start_terminal_bridge_poller(): () => void {
  if (_started) return () => {}
  _started = true
  let active = true
  async function loop() {
    while (active) {
      try {
        if (!_busy) {
          const resp = await fetch(`${API_BASE}/terminal/pending`)
          if (resp.ok) {
            const data = await resp.json()
            const reqs: TerminalReq[] = data?.pending ?? []
            if (reqs.length > 0) {
              _busy = true
              try {
                await handle_one(reqs[0])
              } finally {
                _busy = false
              }
            }
          }
        }
      } catch {
        // backend down / between reloads — keep trying
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  loop()
  return () => {
    active = false
    _started = false
  }
}
