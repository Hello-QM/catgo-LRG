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
  const root_el = (e.target as HTMLElement).parentElement // .pane-tree-root
  if (!root_el) return
  // The divider carries its split's % extent along the drag axis (data-split-span)
  // so nested-split drags convert px → ratio against the split's own size, not
  // the whole tree.
  const span_pct = parseFloat((e.target as HTMLElement).dataset.splitSpan ?? '100') || 100
  e.preventDefault()
  deps.set_is_panel_resizing(true)
  on_start()
  const start = dir === 'h' ? e.clientX : e.clientY
  const start_ratio = node.ratio
  function on_move(ev: MouseEvent) {
    const rect = root_el!.getBoundingClientRect()
    const total = (dir === 'h' ? rect.width : rect.height) * (span_pct / 100)
    const delta = total > 0 ? ((dir === 'h' ? ev.clientX : ev.clientY) - start) / total : 0
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
