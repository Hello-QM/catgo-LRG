/**
 * Terminal-tabs registry — module-level reactive state for the mobile
 * "Terminals" panel (MobileWorkspace). Like `sessions.ts`, it lives at module
 * scope so it survives MobileWorkspace remounts within the app process.
 *
 * It holds ONLY display metadata + the active selection. Each terminal's live
 * PTY channel and xterm.js instance live inside its own MobileTerminal
 * component (the `$effect` closure), NOT here — storing DOM-tied objects in
 * module state would leak and block GC after a tab closes.
 *
 * Single-host (v1): the list belongs to the currently-connected session. Call
 * `reset_for_session(id)` on (re)connect to seed a fresh single tab, and
 * `clear_tabs()` on disconnect. Multi-host (a `Map<endpointKey, TermTab[]>`) is
 * a future extension — see docs/developer/mobile-terminal-tabs-design.md.
 */

export type TermTab = {
  /** Stable local id (also the `{#each}` key and the component-ref key). */
  id: string
  /** Last-known cwd from OSC 7; drives the basename label. */
  cwd: string
  /** 1-based creation ordinal, used for the `Terminal N` fallback label. */
  seq: number
}

/** Hard cap on simultaneous terminals (N live PTYs + xterm instances on a
 *  phone WebView). Decided with the mentor. */
export const MAX_TABS = 5

export const term_tabs = $state({
  tabs: [] as TermTab[],
  active_id: null as string | null,
  /** Edit mode reveals a ✕ on each tab for closing several quickly. */
  edit_mode: false,
  /** The session these tabs belong to (single-host v1). */
  session_id: null as string | null,
})

// Monotonic across the whole app life so ids never collide, even after a
// reset wipes the list (stale `{#each}` keys can't alias a fresh tab).
let id_counter = 0
// Per-session creation ordinal (reset by reset_for_session) → labels start at 1.
let seq_counter = 0

function next_id(): string {
  id_counter += 1
  return `t${id_counter}`
}

/** Last path segment, ignoring a trailing slash. `/` for root, `` for empty. */
export function path_basename(path: string): string {
  if (!path) return ``
  const trimmed = path.replace(/\/+$/, ``)
  if (trimmed === ``) return `/`
  const idx = trimmed.lastIndexOf(`/`)
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Add a terminal and make it active. No-op (returns null) past MAX_TABS. */
export function add_tab(): string | null {
  if (term_tabs.tabs.length >= MAX_TABS) return null
  seq_counter += 1
  const tab: TermTab = { id: next_id(), cwd: ``, seq: seq_counter }
  term_tabs.tabs.push(tab)
  term_tabs.active_id = tab.id
  return tab.id
}

/** Make `id` the active tab (ignored if `id` isn't a known tab). */
export function switch_tab(id: string): void {
  if (term_tabs.tabs.some((t) => t.id === id)) term_tabs.active_id = id
}

/** Close a terminal. Closing the last one respawns a fresh tab so the pane is
 *  never empty; otherwise the active selection moves to a neighbour. */
export function close_tab(id: string): void {
  const idx = term_tabs.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  term_tabs.tabs.splice(idx, 1)
  // The ✕ affordance only shows with >1 tab, so don't leave edit mode "on"
  // (and re-appearing) once we're back down to a single terminal.
  if (term_tabs.tabs.length <= 1) term_tabs.edit_mode = false
  if (term_tabs.tabs.length === 0) {
    add_tab() // last-tab respawn — always ≥ 1 terminal
    return
  }
  if (term_tabs.active_id === id) {
    const next = term_tabs.tabs[Math.min(idx, term_tabs.tabs.length - 1)]
    term_tabs.active_id = next.id
  }
}

/** Record a terminal's cwd (from its OSC 7 `on_cwd` callback). */
export function set_tab_cwd(id: string, cwd: string): void {
  const tab = term_tabs.tabs.find((t) => t.id === id)
  if (tab) tab.cwd = cwd
}

export function toggle_edit_mode(): void {
  term_tabs.edit_mode = !term_tabs.edit_mode
}

/** The active terminal's cwd (so the Files tab can follow it). */
export function active_cwd(): string {
  const tab = term_tabs.tabs.find((t) => t.id === term_tabs.active_id)
  return tab?.cwd ?? ``
}

/** Seed a fresh single-tab registry for a (new) session. Idempotent for the
 *  same session id that already has tabs, so re-renders don't wipe state. */
export function reset_for_session(session_id: string): void {
  if (term_tabs.session_id === session_id && term_tabs.tabs.length > 0) return
  term_tabs.tabs = []
  term_tabs.active_id = null
  term_tabs.edit_mode = false
  term_tabs.session_id = session_id
  seq_counter = 0
  add_tab()
}

/** Wipe everything (on disconnect). */
export function clear_tabs(): void {
  term_tabs.tabs = []
  term_tabs.active_id = null
  term_tabs.edit_mode = false
  term_tabs.session_id = null
  seq_counter = 0
}
