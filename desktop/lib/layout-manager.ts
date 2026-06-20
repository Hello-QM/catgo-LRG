/**
 * Layout change management — extracted from App.svelte.
 *
 * Applies a layout preset (single/splitH/splitV/quad) to a tab's pane tree,
 * consolidating populated panes into the preset's leaves and confirming when
 * content would be lost.
 */

import type { StructureTabState } from '../pane-utils'
import { pane_has_content } from '../pane-utils'
import {
  buildPreset, leaves, matchesPreset, isTerminalLeaf, structurePane,
  type LeafNode, type PresetId,
} from '../pane-tree'

export interface LayoutManagerDeps {
  get_active_ts: () => StructureTabState | null
  get_active_tab_id: () => string
  tab_states: Record<string, StructureTabState>
  update_tab_label: (tab_id: string) => void
  get_pending_layout_change: () => { tab_id: string; new_layout: PresetId; lost_count: number } | null
  set_pending_layout_change: (v: { tab_id: string; new_layout: PresetId; lost_count: number } | null) => void
}

/** Number of leaves a preset's tree holds. */
function preset_leaf_count(preset: PresetId): number {
  if (preset === 'single') return 1
  if (preset === 'quad') return 4
  return 2
}

/**
 * Leaf nodes worth carrying across a preset switch: terminal leaves (always)
 * plus structure leaves that hold renderable content. We carry the whole leaf
 * (id + content), not just the content — preserving the id is what lets the flat
 * keyed renderer keep the component instance (terminal PTY / viewer WebGL) alive
 * across the layout change instead of remounting it.
 */
function filled_leaves(ts: StructureTabState): LeafNode[] {
  return leaves(ts.root).filter(l => {
    if (isTerminalLeaf(l)) return true
    const pane = structurePane(l)
    return !!pane && pane_has_content(pane)
  })
}

/** Rebuild the tab's tree from a preset, migrating populated leaves into its slots. */
function apply_preset(ts: StructureTabState, preset: PresetId, filled: LeafNode[]) {
  const root = buildPreset(preset)
  const slots = leaves(root)
  for (let i = 0; i < slots.length && i < filled.length; i++) {
    // Preserve the existing leaf's identity (id), not just its content, so the
    // keyed pane render reuses the same component instance — no remount.
    slots[i].id = filled[i].id
    slots[i].content = filled[i].content
  }
  ts.root = root
  ts.active_leaf_id = slots[0].id
  ts.close_confirm_leaf_id = null
  ts.pending_library_removal = null
}

export function handle_layout_change(deps: LayoutManagerDeps, preset: PresetId) {
  const ts = deps.get_active_ts()
  if (!ts) return
  if (matchesPreset(ts.root) === preset) return

  const filled = filled_leaves(ts)
  const target = preset_leaf_count(preset)

  if (filled.length > target) {
    deps.set_pending_layout_change({ tab_id: deps.get_active_tab_id(), new_layout: preset, lost_count: filled.length - target })
    return
  }

  apply_preset(ts, preset, filled)
  deps.update_tab_label(deps.get_active_tab_id())
}

export function confirm_layout_change(deps: LayoutManagerDeps) {
  const pending = deps.get_pending_layout_change()
  if (!pending) return
  const { tab_id, new_layout } = pending
  const ts = deps.tab_states[tab_id]
  if (!ts) { deps.set_pending_layout_change(null); return }

  // Truncate: keep only as many populated panes as the preset has leaves.
  const target = preset_leaf_count(new_layout)
  const filled = filled_leaves(ts).slice(0, target)

  apply_preset(ts, new_layout, filled)
  deps.set_pending_layout_change(null)
  deps.update_tab_label(tab_id)
}
