/**
 * Panel resize handlers — extracted from App.svelte.
 *
 * Mouse-drag handlers for resizing split panes.
 */

import type { StructureTabState } from '../pane-utils'

export interface ResizeDeps {
  tab_states: Record<string, StructureTabState>
  set_is_panel_resizing: (v: boolean) => void
  set_resize_axis: (v: 'col' | 'row') => void
}

export function on_divider_mousedown(deps: ResizeDeps, e: MouseEvent, axis: 'col' | 'row', tab_id: string) {
  e.preventDefault()
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const container = (e.target as HTMLElement).closest(`.grid-container`) as HTMLElement
  if (!container) return
  deps.set_is_panel_resizing(true)
  deps.set_resize_axis(axis)
  const start = axis === 'col' ? e.clientX : e.clientY
  const start_pct = axis === 'col' ? ts.col_split : ts.row_split

  function on_move(ev: MouseEvent) {
    const rect = container.getBoundingClientRect()
    const total = axis === 'col' ? rect.width : rect.height
    const delta_pct = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / total * 100
    const new_pct = Math.max(20, Math.min(80, start_pct + delta_pct))
    if (axis === 'col') ts.col_split = new_pct
    else ts.row_split = new_pct
  }
  function on_up() {
    deps.set_is_panel_resizing(false)
    window.removeEventListener(`mousemove`, on_move)
    window.removeEventListener(`mouseup`, on_up)
  }
  window.addEventListener(`mousemove`, on_move)
  window.addEventListener(`mouseup`, on_up)
}

export function on_center_mousedown(deps: ResizeDeps, e: MouseEvent, tab_id: string) {
  e.preventDefault()
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const container = (e.target as HTMLElement).closest(`.grid-container`) as HTMLElement
  if (!container) return
  deps.set_is_panel_resizing(true)
  const start_x = e.clientX
  const start_y = e.clientY
  const start_col = ts.col_split
  const start_row = ts.row_split

  function on_move(ev: MouseEvent) {
    const rect = container.getBoundingClientRect()
    ts.col_split = Math.max(20, Math.min(80, start_col + (ev.clientX - start_x) / rect.width * 100))
    ts.row_split = Math.max(20, Math.min(80, start_row + (ev.clientY - start_y) / rect.height * 100))
  }
  function on_up() {
    deps.set_is_panel_resizing(false)
    window.removeEventListener(`mousemove`, on_move)
    window.removeEventListener(`mouseup`, on_up)
  }
  window.addEventListener(`mousemove`, on_move)
  window.addEventListener(`mouseup`, on_up)
}
