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
 * Multi-host: each tab carries the `session_id` (and a cluster label) it is
 * bound to, so tabs for several clusters coexist in one strip. `ensure_tab()`
 * seeds a first tab per session on connect; `close_tabs_for_session()` removes
 * a cluster's tabs on eject. (Supersedes the single-host v1 noted in
 * docs/developer/mobile-terminal-tabs-design.md §6.1.)
 */

export type TermTab = {
  /** Stable local id (also the `{#each}` key and the component-ref key). */
  id: string
  /** Last-known cwd from OSC 7; drives the basename label. */
  cwd: string
  /** 1-based creation ordinal, used for the `Terminal N` fallback label. */
  seq: number
  /** The live SSH session this tab's PTY runs on. */
  session_id: string
  /** Short cluster label (saved-connection nickname or `user@host`) shown on
   * the chip when tabs from several clusters coexist. */
  cluster: string
}

/** Hard cap on simultaneous terminals (N live PTYs + xterm instances on a
 *  phone WebView). Decided with the mentor. */
export const MAX_TABS = 5

export const term_tabs = $state({
  tabs: [] as TermTab[],
  active_id: null as string | null,
  /** Edit mode reveals a ✕ on each tab for closing several quickly. */
  edit_mode: false,
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

/** Add a terminal on `session_id` and make it active. No-op past MAX_TABS. */
export function add_tab(session_id: string, cluster: string): string | null {
  if (term_tabs.tabs.length >= MAX_TABS) return null
  seq_counter += 1
  const tab: TermTab = { id: next_id(), cwd: ``, seq: seq_counter, session_id, cluster }
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
  const closed = term_tabs.tabs[idx]
  term_tabs.tabs.splice(idx, 1)
  // The ✕ affordance only shows with >1 tab, so don't leave edit mode "on"
  // (and re-appearing) once we're back down to a single terminal.
  if (term_tabs.tabs.length <= 1) term_tabs.edit_mode = false
  if (term_tabs.tabs.length === 0) {
    // last-tab respawn on the same cluster — always ≥ 1 terminal
    add_tab(closed.session_id, closed.cluster)
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

/** Make sure `session_id` has at least one tab; activate its first tab.
 *  Idempotent — reconnecting/switching to a cluster that already has tabs
 *  just focuses them instead of wiping anything. */
export function ensure_tab(session_id: string, cluster: string): void {
  const existing = term_tabs.tabs.find((t) => t.session_id === session_id)
  if (existing) {
    term_tabs.active_id = existing.id
    return
  }
  add_tab(session_id, cluster)
}

/** Repoint every tab on `old_id` to `new_id` after a reconnect minted a fresh
 *  session for the same endpoint. Preserves each tab's identity (id/seq/cwd), so
 *  its MobileTerminal re-runs its `$effect` (the `session_id` prop changed),
 *  re-opens the PTY on the new session, and — because `persist_key` is derived
 *  from the unchanged `seq` (`catgo-<seq>`) — re-attaches the SAME surviving
 *  tmux session, restoring the running job. */
export function repoint_session(old_id: string, new_id: string): void {
  if (old_id === new_id) return
  for (const tab of term_tabs.tabs) {
    if (tab.session_id === old_id) tab.session_id = new_id
  }
}

/** Close all tabs bound to one session (cluster eject). Unlike close_tab,
 *  closing the last tab overall does NOT respawn — an empty strip is correct
 *  when no cluster is connected. */
export function close_tabs_for_session(session_id: string): void {
  term_tabs.tabs = term_tabs.tabs.filter((t) => t.session_id !== session_id)
  if (term_tabs.tabs.length <= 1) term_tabs.edit_mode = false
  if (!term_tabs.tabs.some((t) => t.id === term_tabs.active_id)) {
    term_tabs.active_id = term_tabs.tabs[0]?.id ?? null
  }
}

/** Wipe everything (full reset, e.g. all clusters gone). */
export function clear_tabs(): void {
  term_tabs.tabs = []
  term_tabs.active_id = null
  term_tabs.edit_mode = false
  seq_counter = 0
}
