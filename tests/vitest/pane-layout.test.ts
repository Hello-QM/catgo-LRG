import { describe, it, expect } from 'vitest'
import { compute_pane_layout } from '../../desktop/pane-layout'
import type { LeafNode, SplitNode, PaneNode } from '../../desktop/pane-tree'
import { create_empty_pane } from '../../desktop/pane-utils'

function leaf(id: string): LeafNode {
  return { kind: 'leaf', id, content: { type: 'structure', pane: create_empty_pane() } }
}
function split(id: string, direction: 'h' | 'v', ratio: number, a: PaneNode, b: PaneNode): SplitNode {
  return { kind: 'split', id, direction, ratio, children: [a, b] }
}
function box(layout: ReturnType<typeof compute_pane_layout>, id: string) {
  return layout.leaves.find((l) => l.leaf.id === id)?.rect
}

describe('compute_pane_layout', () => {
  it('single leaf fills the whole area, no dividers', () => {
    const l = compute_pane_layout(leaf('a'), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(l.dividers).toEqual([])
  })

  it('splitH at 0.5 → side-by-side halves + one vertical divider with span 100', () => {
    const l = compute_pane_layout(split('s', 'h', 0.5, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 50, y: 0, w: 50, h: 100 })
    expect(l.dividers).toEqual([{ split_id: 's', dir: 'h', rect: { x: 50, y: 0, w: 0, h: 100 }, span: 100 }])
  })

  it('splitV at 0.5 → stacked halves + one horizontal divider', () => {
    const l = compute_pane_layout(split('s', 'v', 0.5, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 50, w: 100, h: 50 })
    expect(l.dividers).toEqual([{ split_id: 's', dir: 'v', rect: { x: 0, y: 50, w: 100, h: 0 }, span: 100 }])
  })

  it('asymmetric splitH respects the ratio', () => {
    const l = compute_pane_layout(split('s', 'h', 0.3, leaf('a'), leaf('b')), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 30, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 30, y: 0, w: 70, h: 100 })
  })

  it('quad (h-split of two v-splits) → 4 quadrants + 3 dividers', () => {
    const col0 = split('c0', 'v', 0.5, leaf('a'), leaf('b'))
    const col1 = split('c1', 'v', 0.5, leaf('c'), leaf('d'))
    const l = compute_pane_layout(split('root', 'h', 0.5, col0, col1), null)
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 50 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 50, w: 50, h: 50 })
    expect(box(l, 'c')).toEqual({ x: 50, y: 0, w: 50, h: 50 })
    expect(box(l, 'd')).toEqual({ x: 50, y: 50, w: 50, h: 50 })
    expect(l.dividers).toContainEqual({ split_id: 'root', dir: 'h', rect: { x: 50, y: 0, w: 0, h: 100 }, span: 100 })
    expect(l.dividers).toContainEqual({ split_id: 'c0', dir: 'v', rect: { x: 0, y: 50, w: 50, h: 0 }, span: 100 })
    expect(l.dividers).toContainEqual({ split_id: 'c1', dir: 'v', rect: { x: 50, y: 50, w: 50, h: 0 }, span: 100 })
    expect(l.dividers).toHaveLength(3)
  })

  it('maximize → maximized leaf fills, sibling collapses to 0, no dividers', () => {
    const l = compute_pane_layout(split('s', 'h', 0.5, leaf('a'), leaf('b')), 'a')
    expect(box(l, 'a')).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(box(l, 'b')).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(l.dividers).toEqual([])
  })

  it('undefined root → empty layout', () => {
    expect(compute_pane_layout(undefined, null)).toEqual({ leaves: [], dividers: [] })
  })
})
