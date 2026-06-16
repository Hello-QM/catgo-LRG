import { describe, expect, it } from 'vitest'
import { create_empty_pane } from '../../desktop/pane-utils'
import {
  CAP, buildPreset, create_empty_leaf, escalateForImport, findFirstEmptyLeaf,
  findLeafById, findSplit, isEmptyLeaf, leafCount, leaves, matchesPreset,
  removeLeaf, setLeafContent, setRatio, splitLeaf, subtreeContains,
  type LeafNode, type PaneNode, type SplitNode,
} from '../../desktop/pane-tree'
import {
  create_terminal_leaf, isStructureLeaf, isTerminalLeaf, structurePane, terminalState,
} from '../../desktop/pane-tree'

const leaf = (id: string): LeafNode => ({ kind: 'leaf', id, content: { type: 'structure', pane: create_empty_pane() } })
const split = (id: string, dir: 'h' | 'v', ratio: number, a: PaneNode, b: PaneNode): SplitNode => ({ kind: 'split', id, direction: dir, ratio, children: [a, b] })

describe('leaves / leafCount / find', () => {
  it('single leaf', () => {
    const root = leaf('L1')
    expect(leaves(root).map(l => l.id)).toEqual(['L1'])
    expect(leafCount(root)).toBe(1)
  })
  it('nested tree returns leaves left-to-right', () => {
    const root = split('S1', 'h', 0.5, split('S2', 'v', 0.5, leaf('A'), leaf('B')), leaf('C'))
    expect(leaves(root).map(l => l.id)).toEqual(['A', 'B', 'C'])
    expect(leafCount(root)).toBe(3)
    expect(findLeafById(root, 'B')?.id).toBe('B')
    expect(findLeafById(root, 'nope')).toBeNull()
    expect(findSplit(root, 'S2')?.direction).toBe('v')
    expect(findSplit(root, 'A')).toBeNull()
  })
})

describe('empty leaves', () => {
  it('create_empty_leaf is an empty structure leaf with a unique id', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf()
    expect(a.kind).toBe('leaf')
    expect(a.content.type).toBe('structure')
    expect(isEmptyLeaf(a)).toBe(true)
    expect(a.id).not.toBe(b.id)
  })
  it('findFirstEmptyLeaf returns first content-free leaf or null', () => {
    const filled = create_empty_leaf(); filled.content.pane.structure = { sites: [{}] } as never
    const empty = create_empty_leaf()
    const root = split('S', 'h', 0.5, filled, empty)
    expect(findFirstEmptyLeaf(root)?.id).toBe(empty.id)
    const full = split('S2', 'h', 0.5, filled, filled)
    expect(findFirstEmptyLeaf(full)).toBeNull()
  })
})

describe('splitLeaf / removeLeaf', () => {
  it('splitLeaf replaces a leaf with a split of [old, newEmpty]', () => {
    const root0 = create_empty_leaf()
    const { root, newLeafId } = splitLeaf(root0, root0.id, 'h')
    expect(root.kind).toBe('split')
    expect(leafCount(root)).toBe(2)
    expect((root as SplitNode).direction).toBe('h')
    expect((root as SplitNode).ratio).toBe(0.5)
    expect(findLeafById(root, newLeafId)).not.toBeNull()
    // original leaf id preserved as children[0]
    expect(((root as SplitNode).children[0] as LeafNode).id).toBe(root0.id)
  })
  it('splitLeaf refuses at CAP leaves', () => {
    let root: PaneNode = create_empty_leaf()
    let active = (root as LeafNode).id
    for (let i = 1; i < CAP; i++) { const r = splitLeaf(root, active, 'v'); root = r.root; active = r.newLeafId }
    expect(leafCount(root)).toBe(CAP)
    expect(splitLeaf(root, active, 'v')).toBeNull()
  })
  it('removeLeaf collapses parent split, sibling takes its place', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf(); const c = create_empty_leaf()
    const root = split('S1', 'h', 0.4, split('S2', 'v', 0.5, a, b), c)
    const next = removeLeaf(root, b.id) // S2 collapses -> a takes S2's slot
    expect(leaves(next).map(l => l.id)).toEqual([a.id, c.id])
    expect((next as SplitNode).id).toBe('S1')
    expect(((next as SplitNode).children[0] as LeafNode).id).toBe(a.id)
  })
  it('removeLeaf of the only leaf returns the leaf unchanged (never empty tree)', () => {
    const only = create_empty_leaf()
    expect(removeLeaf(only, only.id)).toBe(only)
  })
})

describe('setRatio', () => {
  it('sets a split ratio (pure) and clamps 0.2..0.8', () => {
    const root = split('S', 'h', 0.5, create_empty_leaf(), create_empty_leaf())
    expect((setRatio(root, 'S', 0.7) as SplitNode).ratio).toBe(0.7)
    expect((setRatio(root, 'S', 0.01) as SplitNode).ratio).toBe(0.2)
    expect((setRatio(root, 'S', 0.99) as SplitNode).ratio).toBe(0.8)
    expect(setRatio(root, 'missing', 0.7)).toBe(root)
  })
})

describe('escalateForImport (open-file target policy)', () => {
  it('1->2->3->4 leaves one at a time, then null at CAP (open new tab)', () => {
    let root: PaneNode = create_empty_leaf()
    let active = (root as LeafNode).id
    // fill the first leaf so it is no longer empty
    ;(root as LeafNode).content.pane.structure = { sites: [{}] } as never
    for (let n = 2; n <= CAP; n++) {
      const r = escalateForImport(root, active)!
      root = r.root; active = r.leafId
      expect(leafCount(root)).toBe(n)
      findLeafById(root, active)!.content.pane.structure = { sites: [{}] } as never
    }
    expect(escalateForImport(root, active)).toBeNull()
  })
  it('reuses an existing empty leaf instead of splitting', () => {
    const filled = create_empty_leaf(); filled.content.pane.structure = { sites: [{}] } as never
    const empty = create_empty_leaf()
    const root = split('S', 'h', 0.5, filled, empty)
    const r = escalateForImport(root, filled.id)!
    expect(r.leafId).toBe(empty.id)
    expect(leafCount(r.root)).toBe(2) // no new split
  })
})

describe('buildPreset / matchesPreset', () => {
  it('builds canonical preset trees', () => {
    expect(leafCount(buildPreset('single'))).toBe(1)
    expect(leafCount(buildPreset('splitH'))).toBe(2)
    expect((buildPreset('splitH') as SplitNode).direction).toBe('h')
    expect((buildPreset('splitV') as SplitNode).direction).toBe('v')
    expect(leafCount(buildPreset('quad'))).toBe(4)
  })
  it('matchesPreset recognizes the canonical shapes, else null', () => {
    expect(matchesPreset(buildPreset('single'))).toBe('single')
    expect(matchesPreset(buildPreset('splitH'))).toBe('splitH')
    expect(matchesPreset(buildPreset('splitV'))).toBe('splitV')
    expect(matchesPreset(buildPreset('quad'))).toBe('quad')
    const custom = split('S', 'h', 0.5, split('S2', 'v', 0.5, create_empty_leaf(), create_empty_leaf()), create_empty_leaf())
    expect(matchesPreset(custom)).toBeNull() // left-2-right-1
  })
})

describe('not-found ops are no-ops', () => {
  it('splitLeaf returns null for a missing leaf id', () => {
    const root = create_empty_leaf()
    expect(splitLeaf(root, 'missing', 'h')).toBeNull()
  })
  it('removeLeaf returns the same root reference for a missing id', () => {
    const a = create_empty_leaf()
    const b = create_empty_leaf()
    const root = split('S', 'h', 0.5, a, b)
    expect(removeLeaf(root, 'missing')).toBe(root)
  })
})

import { create_tab_state } from '../../desktop/pane-utils'
describe('create_tab_state', () => {
  it('starts as one empty structure leaf, active = that leaf', () => {
    const ts = create_tab_state()
    expect(leafCount(ts.root)).toBe(1)
    expect(ts.active_leaf_id).toBe((ts.root as LeafNode).id)
    expect(isEmptyLeaf(ts.root as LeafNode)).toBe(true)
    expect(ts.close_confirm_leaf_id).toBeNull()
  })
})

describe('terminal leaves', () => {
  it('create_terminal_leaf makes a terminal leaf with a unique id and given state', () => {
    const t = create_terminal_leaf({ shell: 'bash', sync_cwd: true })
    expect(t.kind).toBe('leaf')
    expect(isTerminalLeaf(t)).toBe(true)
    expect(isStructureLeaf(t)).toBe(false)
    expect(terminalState(t)?.shell).toBe('bash')
    expect(terminalState(t)?.sync_cwd).toBe(true)
    expect(structurePane(t)).toBeNull()
    expect(create_terminal_leaf().id).not.toBe(t.id)
  })
  it('structure leaf: structurePane returns the pane, terminalState null', () => {
    const s = create_empty_leaf()
    expect(isStructureLeaf(s)).toBe(true)
    expect(structurePane(s)).toBe(s.content.type === 'structure' ? s.content.pane : null)
    expect(terminalState(s)).toBeNull()
  })
  it('a terminal leaf is never "empty" and never an import target', () => {
    const t = create_terminal_leaf()
    expect(isEmptyLeaf(t)).toBe(false)
    const root = split('S', 'h', 0.5, t, create_empty_leaf())
    expect(findFirstEmptyLeaf(root)?.id).not.toBe(t.id) // the empty structure leaf, not the terminal
  })
  it('setLeafContent converts a structure leaf to a terminal, keeping its id', () => {
    const s = create_empty_leaf()
    const root = setLeafContent(s, s.id, { type: 'terminal', term: { sync_cwd: false } })
    const out = findLeafById(root, s.id)!
    expect(out.id).toBe(s.id) // same leaf id
    expect(isTerminalLeaf(out)).toBe(true)
    expect(terminalState(out)?.sync_cwd).toBe(false)
  })
})

describe('subtreeContains', () => {
  it('true iff the leaf is somewhere in the node subtree', () => {
    const a = create_empty_leaf(); const b = create_empty_leaf(); const c = create_empty_leaf()
    const root = split('S1', 'h', 0.5, split('S2', 'v', 0.5, a, b), c)
    expect(subtreeContains(root, a.id)).toBe(true)
    expect(subtreeContains((root as SplitNode).children[1], a.id)).toBe(false)
    expect(subtreeContains((root as SplitNode).children[1], c.id)).toBe(true)
    expect(subtreeContains(root, 'nope')).toBe(false)
  })
})
