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

export interface TerminalLeafState {
  session_id?: string
  host?: string
  username?: string
  shell?: string
  sync_cwd: boolean
  cwd?: string
}

export type LeafContent =
  | { type: 'structure'; pane: PaneState }
  | { type: 'terminal'; term: TerminalLeafState }

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

// Seed from a random base so a Vite HMR module reload (which resets module
// state) mints a disjoint id space and cannot collide with ids in live trees.
let _id_counter = Math.floor(Math.random() * 1e9)
function next_id(prefix: string): string {
  _id_counter += 1
  return `${prefix}-${_id_counter}`
}

export function leaves(node: PaneNode): LeafNode[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node]
  if (!node.children) return []
  return [...leaves(node.children[0]), ...leaves(node.children[1])]
}

export function leafCount(node: PaneNode): number {
  if (!node) return 0
  if (node.kind === 'leaf') return 1
  if (!node.children) return 0
  return leafCount(node.children[0]) + leafCount(node.children[1])
}

export function findLeafById(node: PaneNode, id: string): LeafNode | null {
  if (!node) return null
  if (node.kind === 'leaf') return node.id === id ? node : null
  if (!node.children) return null
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id)
}

export function findSplit(node: PaneNode, id: string): SplitNode | null {
  if (!node || node.kind === 'leaf') return null
  if (node.id === id) return node
  if (!node.children) return null
  return findSplit(node.children[0], id) ?? findSplit(node.children[1], id)
}

/** True iff a leaf with `leafId` lives anywhere in `node`'s subtree. */
export function subtreeContains(node: PaneNode, leafId: string): boolean {
  return findLeafById(node, leafId) !== null
}

export function create_empty_leaf(): LeafNode {
  return { kind: 'leaf', id: next_id('leaf'), content: { type: 'structure', pane: create_empty_pane() } }
}

export function isStructureLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'structure'
}

export function isTerminalLeaf(leaf: LeafNode): boolean {
  return leaf.content.type === 'terminal'
}

export function structurePane(leaf: LeafNode): PaneState | null {
  return leaf.content.type === 'structure' ? leaf.content.pane : null
}

export function terminalState(leaf: LeafNode): TerminalLeafState | null {
  return leaf.content.type === 'terminal' ? leaf.content.term : null
}

export function create_terminal_leaf(opts?: Partial<TerminalLeafState>): LeafNode {
  return { kind: 'leaf', id: next_id('term'), content: { type: 'terminal', term: { sync_cwd: false, ...opts } } }
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

/** Replace a leaf's content in place (keeps the same leaf id). Pure. */
export function setLeafContent(root: PaneNode, leafId: string, content: LeafContent): PaneNode {
  return replaceNode(root, leafId, { kind: 'leaf', id: leafId, content })
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

export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.2, Math.min(0.8, ratio))
  function go(node: PaneNode): PaneNode {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) return { ...node, ratio: clamped }
    const a = go(node.children[0]); const b = go(node.children[1])
    if (a === node.children[0] && b === node.children[1]) return node
    return { ...node, children: [a, b] }
  }
  return go(root)
}

/** The shallowest leaf in the tree (ties broken by traversal order). */
export function shallowestLeaf(root: PaneNode): LeafNode {
  let best = root.kind === 'leaf' ? root : leaves(root)[0]
  let best_depth = Infinity
  const walk = (node: PaneNode, depth: number): void => {
    if (node.kind === 'leaf') {
      if (depth < best_depth) { best_depth = depth; best = node }
      return
    }
    walk(node.children[0], depth + 1)
    walk(node.children[1], depth + 1)
  }
  walk(root, 0)
  return best
}

/**
 * Open-file target: reuse the first empty leaf; else split the SHALLOWEST leaf
 * (one at a time) up to CAP; else null (caller opens a new tab).
 *
 * Splitting the shallowest leaf — not the active one — keeps repeated imports
 * balanced: single → two columns ('h') → 2+1 → 2x2 quad ('v' fills each
 * column), instead of stacking N panes down the active column (1+N).
 */
export function escalateForImport(root: PaneNode, _activeLeafId: string): { root: PaneNode; leafId: string } | null {
  const empty = findFirstEmptyLeaf(root)
  if (empty) return { root, leafId: empty.id }
  const dir: SplitDir = leafCount(root) === 1 ? 'h' : 'v'
  const split = splitLeaf(root, shallowestLeaf(root).id, dir)
  if (!split) return null
  return { root: split.root, leafId: split.newLeafId }
}

export function buildPreset(preset: PresetId): PaneNode {
  if (preset === 'single') return create_empty_leaf()
  if (preset === 'splitH') return { kind: 'split', id: next_id('split'), direction: 'h', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] }
  if (preset === 'splitV') return { kind: 'split', id: next_id('split'), direction: 'v', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] }
  // quad = h-split of two v-splits
  const col = (): SplitNode => ({ kind: 'split', id: next_id('split'), direction: 'v', ratio: 0.5, children: [create_empty_leaf(), create_empty_leaf()] })
  return { kind: 'split', id: next_id('split'), direction: 'h', ratio: 0.5, children: [col(), col()] }
}

export function matchesPreset(root: PaneNode): PresetId | null {
  if (root.kind === 'leaf') return 'single'
  const [a, b] = root.children
  if (a.kind === 'leaf' && b.kind === 'leaf') return root.direction === 'h' ? 'splitH' : 'splitV'
  if (root.direction === 'h' && a.kind === 'split' && b.kind === 'split'
    && a.direction === 'v' && b.direction === 'v'
    && a.children.every(c => c.kind === 'leaf') && b.children.every(c => c.kind === 'leaf')) return 'quad'
  return null
}
