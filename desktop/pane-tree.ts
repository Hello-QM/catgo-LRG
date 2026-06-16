/**
 * Recursive pane tree — the desktop layout primitive (replaces the fixed
 * single/splitH/splitV/quad grid). A tab's layout is one PaneNode.
 *
 * Subproject 1: leaf content is only { type: 'structure', pane }. Subproject 2
 * widens LeafContent to include { type: 'terminal', ... }.
 */
import type { PaneState } from './pane-utils'
import { create_empty_pane, pane_has_content } from './pane-utils'

export type SplitDir = 'h' | 'v' // 'h' = side by side (vertical divider); 'v' = stacked (horizontal divider)
export type PresetId = 'single' | 'splitH' | 'splitV' | 'quad'

export type LeafContent = { type: 'structure'; pane: PaneState }

export interface LeafNode {
  kind: 'leaf'
  id: string
  content: LeafContent
}

export interface SplitNode {
  kind: 'split'
  id: string
  direction: SplitDir
  ratio: number // 0..1 fraction for children[0]; clamped 0.2..0.8 on user drag
  children: [PaneNode, PaneNode]
}

export type PaneNode = SplitNode | LeafNode

/** Max leaves per tab (spec D6). Preserves the old single->2->4 GPU envelope. */
export const CAP = 4

let _id_counter = 0
function next_id(prefix: string): string {
  _id_counter += 1
  return `${prefix}-${_id_counter}`
}

export function leaves(node: PaneNode): LeafNode[] {
  if (node.kind === 'leaf') return [node]
  return [...leaves(node.children[0]), ...leaves(node.children[1])]
}

export function leafCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : leafCount(node.children[0]) + leafCount(node.children[1])
}

export function findLeafById(node: PaneNode, id: string): LeafNode | null {
  if (node.kind === 'leaf') return node.id === id ? node : null
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id)
}

export function findSplit(node: PaneNode, id: string): SplitNode | null {
  if (node.kind === 'leaf') return null
  if (node.id === id) return node
  return findSplit(node.children[0], id) ?? findSplit(node.children[1], id)
}
