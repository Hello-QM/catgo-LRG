/**
 * Keyboard shortcut handler — extracted from App.svelte.
 *
 * Pure function that dispatches keyboard shortcuts.
 * No $state needed.
 */

import type { StructureTabState, LayoutType } from '../pane-utils'
import { layout_panel_count } from '../pane-utils'

export interface KeyboardShortcutDeps {
  get_tabs: () => { id: string; type: string }[]
  get_active_tab_id: () => string
  set_active_tab_id: (id: string) => void
  toggle_sidebar: () => void
  open_tab: (type: `structure` | `workflow`) => void
  get_active_ts: () => StructureTabState | null
  handle_open_file: (tab_id: string, pane_idx: number) => void
  handle_unload: (tab_id: string, pane_idx: number) => void
  request_close_tab: (id: string) => void
  get_tab_close_confirm_id: () => string | null
  set_tab_close_confirm_id: (id: string | null) => void
  get_pending_layout_change: () => { tab_id: string; new_layout: LayoutType; lost_count: number } | null
  set_pending_layout_change: (v: null) => void
}

export function create_handle_keydown(deps: KeyboardShortcutDeps) {
  return function handle_keydown(event: KeyboardEvent) {
    const ctrl = event.ctrlKey || event.metaKey

    // F5 / Ctrl+R / Cmd+R — reload the webview. Tauri doesn't bind
    // browser reload shortcuts by default, and Vite HMR can't reattach
    // listeners to an existing EventSource (each new SSE event type
    // requires a full re-mount). Without this, devs editing
    // App.svelte's SSE handlers had no clean way to refresh.
    if (event.key === `F5` || (ctrl && event.key === `r`) || (ctrl && event.key === `R`)) {
      event.preventDefault()
      window.location.reload()
      return
    }

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
    if (ctrl && event.key === `Tab`) {
      event.preventDefault()
      const tabs = deps.get_tabs()
      const active_tab_id = deps.get_active_tab_id()
      const current_idx = tabs.findIndex(t => t.id === active_tab_id)
      if (event.shiftKey) {
        deps.set_active_tab_id(tabs[(current_idx - 1 + tabs.length) % tabs.length].id)
      } else {
        deps.set_active_tab_id(tabs[(current_idx + 1) % tabs.length].id)
      }
      return
    }

    // Ctrl+B intentionally NOT bound: it collides with Claude Code's prefix
    // key. Toggle the sidebar with the in-app toolbar button instead.

    // Ctrl+T — new structure tab
    if (ctrl && event.key === `t`) {
      event.preventDefault()
      deps.open_tab(`structure`)
      return
    }

    // Structure-tab-only shortcuts
    const ts = deps.get_active_ts()
    if (!ts) return

    const active_tab_id = deps.get_active_tab_id()

    if (ctrl && event.key === `o`) {
      event.preventDefault()
      deps.handle_open_file(active_tab_id, ts.active_pane)
    }
    if (ctrl && event.key === `w`) {
      event.preventDefault()
      const panel_count = layout_panel_count(ts.layout)
      if (panel_count > 1) {
        deps.handle_unload(active_tab_id, ts.active_pane)
      } else {
        deps.request_close_tab(active_tab_id)
      }
    }
    if (event.key === `Escape`) {
      if (deps.get_tab_close_confirm_id()) {
        deps.set_tab_close_confirm_id(null)
        return
      }
      if (deps.get_pending_layout_change()) {
        deps.set_pending_layout_change(null)
        return
      }
      if (ts.close_confirm_pane !== null) {
        ts.close_confirm_pane = null
        return
      }
    }
    if (ctrl && event.key === `a`) {
      event.preventDefault()
      return
    }
    if (event.key >= `1` && event.key <= `4` && !ctrl) {
      const idx = parseInt(event.key) - 1
      if (idx < layout_panel_count(ts.layout)) {
        ts.active_pane = idx
      }
    }
  }
}
