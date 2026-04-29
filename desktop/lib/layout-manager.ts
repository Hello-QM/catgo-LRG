/**
 * Layout change management — extracted from App.svelte.
 *
 * Functions for handling layout changes with pane consolidation
 * and confirmation when content would be lost.
 */

import type { PaneState, LayoutType, StructureTabState } from '../pane-utils'
import { layout_panel_count, create_empty_pane, pane_has_content } from '../pane-utils'

export interface LayoutManagerDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_id: () => string
  tab_states: Record<string, StructureTabState>
  update_tab_label: (tab_id: string) => void
  get_pending_layout_change: () => { tab_id: string; new_layout: LayoutType; lost_count: number } | null
  set_pending_layout_change: (v: { tab_id: string; new_layout: LayoutType; lost_count: number } | null) => void
}

export function handle_layout_change(deps: LayoutManagerDeps, new_layout: LayoutType) {
  const ts = deps.get_active_ts()
  if (!ts) return
  if (new_layout === ts.layout) return
  const old_count = layout_panel_count(ts.layout)
  const new_count = layout_panel_count(new_layout)

  if (new_count < old_count) {
    // Check if trimmed panels have structures
    const filled_beyond: number[] = []
    for (let i = new_count; i < old_count; i++) {
      const p = ts.panes[i]
      if (pane_has_content(p)) filled_beyond.push(i)
    }

    if (filled_beyond.length > 0) {
      // Consolidate non-empty panes into lower indices
      const all_filled: number[] = []
      for (let i = 0; i < old_count; i++) {
        const p = ts.panes[i]
        if (pane_has_content(p)) all_filled.push(i)
      }
      const will_lose = all_filled.length - new_count
      if (will_lose > 0) {
        // Show confirmation modal
        deps.set_pending_layout_change({ tab_id: deps.get_active_tab_id(), new_layout, lost_count: will_lose })
        return
      }
      // No content will be lost — consolidate into lower slots
      for (let dest = 0; dest < Math.min(new_count, all_filled.length); dest++) {
        if (all_filled[dest] !== dest) {
          const src = all_filled[dest]
          ts.panes[dest] = ts.panes[src]
          ts.panes[src] = create_empty_pane()
        }
      }
    }
  }

  ts.layout = new_layout
  ts.col_split = 50
  ts.row_split = 50
  if (ts.active_pane >= new_count) ts.active_pane = 0
  deps.update_tab_label(deps.get_active_tab_id())
}

export function confirm_layout_change(deps: LayoutManagerDeps) {
  const pending = deps.get_pending_layout_change()
  if (!pending) return
  const { tab_id, new_layout } = pending
  const ts = deps.tab_states[tab_id]
  if (!ts) { deps.set_pending_layout_change(null); return }
  const old_count = layout_panel_count(ts.layout)
  const new_count = layout_panel_count(new_layout)

  // Consolidate non-empty panes into first N slots, drop the rest
  const filled: PaneState[] = []
  for (let i = 0; i < old_count; i++) {
    const p = ts.panes[i]
    if (pane_has_content(p)) filled.push(p)
  }
  for (let i = 0; i < 4; i++) {
    if (i < new_count && i < filled.length) ts.panes[i] = filled[i]
    else if (i < new_count) ts.panes[i] = create_empty_pane()
    else ts.panes[i] = create_empty_pane()
  }

  ts.layout = new_layout
  ts.col_split = 50
  ts.row_split = 50
  if (ts.active_pane >= new_count) ts.active_pane = 0
  deps.set_pending_layout_change(null)
  deps.update_tab_label(tab_id)
}
