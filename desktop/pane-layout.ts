/**
 * Pure geometry for the flat pane renderer: turns the pane tree into a flat list
 * of absolutely-positioned leaf boxes + divider boxes (all in % of the
 * container). No DOM. Lets PaneTree render leaves as one keyed list so they
 * never remount when the tree restructures.
 */
import type { PaneNode } from './pane-tree'
import type { LeafNode } from './pane-tree'

export interface Rect { x: number; y: number; w: number; h: number }
export interface LeafBox { leaf: LeafNode; rect: Rect }
/** `span` = the split's own extent (%) along the drag axis (width for 'h',
 *  height for 'v') — the resize handler needs it to convert px → ratio. */
export interface DividerBox { split_id: string; dir: 'h' | 'v'; rect: Rect; span: number }
export interface PaneLayout { leaves: LeafBox[]; dividers: DividerBox[] }

function leaf_ids(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.id]
  if (!node.children) return []
  return [...leaf_ids(node.children[0]), ...leaf_ids(node.children[1])]
}

export function compute_pane_layout(
  root: PaneNode | undefined,
  maximized_leaf_id: string | null,
): PaneLayout {
  const leaves: LeafBox[] = []
  const dividers: DividerBox[] = []

  function walk(node: PaneNode | undefined, rect: Rect): void {
    if (!node) return
    if (node.kind === 'leaf') {
      leaves.push({ leaf: node, rect })
      return
    }
    if (!node.children) return
    const [c0, c1] = node.children
    if (maximized_leaf_id) {
      // The child subtree holding the maximized leaf takes the full rect; the
      // other collapses to zero size but its leaves stay mounted (keep-warm).
      const zero = { ...rect, w: 0, h: 0 }
      if (leaf_ids(c0).includes(maximized_leaf_id)) { walk(c0, rect); walk(c1, zero) }
      else if (leaf_ids(c1).includes(maximized_leaf_id)) { walk(c0, zero); walk(c1, rect) }
      else { walk(c0, zero); walk(c1, zero) }
      return
    }
    if (node.direction === 'h') {
      const w0 = rect.w * node.ratio
      walk(c0, { x: rect.x, y: rect.y, w: w0, h: rect.h })
      walk(c1, { x: rect.x + w0, y: rect.y, w: rect.w - w0, h: rect.h })
      dividers.push({ split_id: node.id, dir: 'h', rect: { x: rect.x + w0, y: rect.y, w: 0, h: rect.h }, span: rect.w })
    } else {
      const h0 = rect.h * node.ratio
      walk(c0, { x: rect.x, y: rect.y, w: rect.w, h: h0 })
      walk(c1, { x: rect.x, y: rect.y + h0, w: rect.w, h: rect.h - h0 })
      dividers.push({ split_id: node.id, dir: 'v', rect: { x: rect.x, y: rect.y + h0, w: rect.w, h: 0 }, span: rect.h })
    }
  }

  walk(root, { x: 0, y: 0, w: 100, h: 100 })
  return { leaves, dividers }
}
