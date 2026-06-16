/**
 * Panel resize handlers — extracted from App.svelte.
 *
 * Per-SplitNode ratio drag for the recursive pane tree (replaces the old
 * fixed col/row grid dividers + quad center handle).
 */

import type { StructureTabState } from '../pane-utils'
import { findSplit, setRatio } from '../pane-tree'

export interface ResizeDepsMin {
  tab_states: Record<string, StructureTabState>
  set_is_panel_resizing: (v: boolean) => void
}

export function on_split_drag(
  deps: ResizeDepsMin,
  e: MouseEvent,
  split_id: string,
  dir: 'h' | 'v',
  tab_id: string,
  on_start: () => void,
  on_end: () => void,
) {
  const ts = deps.tab_states[tab_id]
  if (!ts) return
  const node = findSplit(ts.root, split_id)
  if (!node) return
  const container = (e.target as HTMLElement).parentElement // the .split flex container
  if (!container) return
  e.preventDefault()
  deps.set_is_panel_resizing(true)
  on_start()
  const start = dir === 'h' ? e.clientX : e.clientY
  const start_ratio = node.ratio
  function on_move(ev: MouseEvent) {
    const rect = container!.getBoundingClientRect()
    const total = dir === 'h' ? rect.width : rect.height
    const delta = ((dir === 'h' ? ev.clientX : ev.clientY) - start) / total
    ts!.root = setRatio(ts!.root, split_id, start_ratio + delta)
  }
  function on_up() {
    window.removeEventListener(`mousemove`, on_move)
    window.removeEventListener(`mouseup`, on_up)
    deps.set_is_panel_resizing(false)
    on_end()
  }
  window.addEventListener(`mousemove`, on_move)
  window.addEventListener(`mouseup`, on_up)
}
