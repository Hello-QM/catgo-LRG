/**
 * In-process registry bridging CatBot tools <-> the visible terminal PTYs.
 * Each TerminalPanel registers a handle on mount and marks itself active on
 * focus; CatBot tools call get_active_terminal(). Renderer-global singleton —
 * in a popout window it is that window's own registry (window-local, like the
 * CWD-sync rule). No Svelte $state needed: callers read at call time, not in a
 * reactive context.
 */

export interface TerminalHandle {
  id: string
  session_id: string // '' for local, HPC session id for remote
  host?: string
  username?: string
  is_remote: boolean
  run_command: (cmd: string, opts?: { timeout_ms?: number }) =>
    Promise<{ output: string; exit_code: number | null; running: boolean }>
  send_keys: (data: string) => Promise<void>
  interrupt: () => Promise<void>
  read_buffer: (lines?: number) => string
}

const _handles = new Map<string, TerminalHandle>()
const _order: string[] = [] // registration order; last = most recent
let _active_id: string | null = null

export function register_terminal(h: TerminalHandle): void {
  _handles.set(h.id, h)
  const i = _order.indexOf(h.id)
  if (i >= 0) _order.splice(i, 1)
  _order.push(h.id)
}

export function unregister_terminal(id: string): void {
  _handles.delete(id)
  const i = _order.indexOf(id)
  if (i >= 0) _order.splice(i, 1)
  if (_active_id === id) _active_id = null
}

export function mark_terminal_active(id: string): void {
  if (_handles.has(id)) _active_id = id
}

export function get_active_terminal(): TerminalHandle | null {
  if (_active_id && _handles.has(_active_id)) return _handles.get(_active_id)!
  for (let i = _order.length - 1; i >= 0; i--) {
    const h = _handles.get(_order[i])
    if (h) return h
  }
  return null
}

export function has_active_terminal(): boolean {
  return get_active_terminal() !== null
}

/**
 * App registers an opener so the tools can auto-spawn a local terminal when none
 * exists. Returns the new handle once it has registered.
 */
let _opener: (() => Promise<TerminalHandle | null>) | null = null
export function set_terminal_opener(fn: (() => Promise<TerminalHandle | null>) | null): void {
  _opener = fn
}
export async function ensure_active_terminal(): Promise<TerminalHandle | null> {
  const existing = get_active_terminal()
  if (existing) return existing
  if (_opener) return await _opener()
  return null
}

/** Test-only: clear all state. */
export function _reset_registry_for_test(): void {
  _handles.clear()
  _order.length = 0
  _active_id = null
  _opener = null
}
