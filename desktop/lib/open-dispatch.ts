/**
 * Open-target dispatch — pure planning for "open file to {tab|split|window}".
 *
 * Given the active tab's pane tree, the active leaf, and the resolved
 * OpenTarget (kind + mode), decide WHERE the incoming file lands. The caller
 * executes the returned plan (it owns the side effects: create_tab, writing
 * ts.root, process_file_content, or opening a popout window).
 */

import type { OpenTarget } from '$lib/state.svelte'
import type { PaneNode } from '../pane-tree'
import { buildPreset, escalateForImport, isTerminalLeaf, leaves } from '../pane-tree'

export type OpenPlan =
  | { action: 'window' }
  | { action: 'new-tab' }
  | { action: 'pane'; root: PaneNode; leafId: string }

/**
 * Plan the destination leaf for a single-file open.
 *
 * - window            → caller opens (or reuses) a popout window.
 * - tab + new         → caller creates a fresh structure tab, loads into it.
 * - tab + overwrite   → collapse the whole tab to one fresh leaf, load there.
 * - split + new       → reuse first empty leaf, else split the active leaf,
 *                       else (at CAP) fall back to a new tab.
 * - split + overwrite → load into the active leaf in place — unless that leaf
 *                       is a terminal (it can't host a structure, so an
 *                       in-place overwrite silently shows nothing); escalate
 *                       like `new` instead.
 */
export function plan_open(root: PaneNode, activeLeafId: string, target: OpenTarget): OpenPlan {
  if (target.kind === 'window') return { action: 'window' }

  if (target.kind === 'tab') {
    if (target.mode === 'new') return { action: 'new-tab' }
    const fresh = buildPreset('single')
    return { action: 'pane', root: fresh, leafId: fresh.id }
  }

  // kind === 'split'
  if (target.mode === 'overwrite') {
    const active = leaves(root).find((l) => l.id === activeLeafId)
    if (!active || !isTerminalLeaf(active)) return { action: 'pane', root, leafId: activeLeafId }
    // fall through: overwrite aimed at a terminal leaf escalates like `new`
  }

  const esc = escalateForImport(root, activeLeafId)
  if (!esc) return { action: 'new-tab' }
  return { action: 'pane', root: esc.root, leafId: esc.leafId }
}
