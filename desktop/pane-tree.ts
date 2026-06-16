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

export function create_empty_leaf(): LeafNode {
  return { kind: 'leaf', id: next_id('leaf'), content: { type: 'structure', pane: create_empty_pane() } }
}

/** A leaf is "empty" when it is a structure leaf holding nothing renderable. */
export function isEmptyLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'structure' && !pane_has_content(leaf.content.pane)
}

export function findFirstEmptyLeaf(node: PaneNode): LeafNode | null {
  for (const l of leaves(node)) if (isEmptyLeaf(l)) return l
  return null
}

/** Replace `leafId` with a split of [existing, newEmptyLeaf]. Returns null at CAP. */
export function splitLeaf(root: PaneNode, leafId: string, direction: SplitDir): { root: PaneNode; newLeafId: string } | null {
  if (leafCount(root) >= CAP) return null
  const target = findLeafById(root, leafId)
  if (!target) return null
  const newLeaf = create_empty_leaf()
  const replacement: SplitNode = { kind: 'split', id: next_id('split'), direction, ratio: 0.5, children: [target, newLeaf] }
  return { root: replaceNode(root, leafId, replacement), newLeafId: newLeaf.id }
}

/** Remove a leaf; collapse its parent split so the sibling takes the parent's place. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode {
  if (root.kind === 'leaf') return root // never destroy the sole leaf
  return removeIn(root, leafId)
}

function removeIn(node: SplitNode, leafId: string): PaneNode {
  const [a, b] = node.children
  if (a.kind === 'leaf' && a.id === leafId) return b
  if (b.kind === 'leaf' && b.id === leafId) return a
  const na = a.kind === 'split' ? removeIn(a, leafId) : a
  const nb = b.kind === 'split' ? removeIn(b, leafId) : b
  if (na === a && nb === b) return node
  return { ...node, children: [na, nb] }
}

/** Pure structural replace of a node (by id) anywhere in the tree. */
function replaceNode(node: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === id ? replacement : node
  if (node.id === id) return replacement
  const a = replaceNode(node.children[0], id, replacement)
  const b = replaceNode(node.children[1], id, replacement)
  if (a === node.children[0] && b === node.children[1]) return node
  return { ...node, children: [a, b] }
}
