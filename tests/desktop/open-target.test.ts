import { describe, it, expect } from 'vitest'
import { resolve_open_target, type OpenTarget } from '../../src/lib/state.svelte'
import { plan_open } from '../../desktop/lib/open-dispatch'
import {
  buildPreset,
  create_empty_leaf,
  create_terminal_leaf,
  findFirstEmptyLeaf,
  leaves,
} from '../../desktop/pane-tree'

const t = (kind: OpenTarget['kind'], mode: OpenTarget['mode']): OpenTarget => ({ kind, mode })

describe('resolve_open_target', () => {
  it('returns the default when shift is false', () => {
    expect(resolve_open_target(t('split', 'new'), false)).toEqual(t('split', 'new'))
    expect(resolve_open_target(t('window', 'overwrite'), false)).toEqual(t('window', 'overwrite'))
  })

  it('flips new→overwrite when shift is true, keeping the kind', () => {
    expect(resolve_open_target(t('split', 'new'), true)).toEqual(t('split', 'overwrite'))
    expect(resolve_open_target(t('tab', 'new'), true)).toEqual(t('tab', 'overwrite'))
  })

  it('flips overwrite→new when shift is true', () => {
    expect(resolve_open_target(t('window', 'overwrite'), true)).toEqual(t('window', 'new'))
  })
})

describe('plan_open', () => {
  it('routes any window kind to a popout', () => {
    const root = buildPreset('single')
    expect(plan_open(root, root.id, t('window', 'new'))).toEqual({ action: 'window' })
    expect(plan_open(root, root.id, t('window', 'overwrite'))).toEqual({ action: 'window' })
  })

  it('tab + new asks the caller to create a fresh tab', () => {
    const root = buildPreset('single')
    expect(plan_open(root, root.id, t('tab', 'new'))).toEqual({ action: 'new-tab' })
  })

  it('tab + overwrite collapses to a single fresh leaf', () => {
    const root = buildPreset('splitH')
    const plan = plan_open(root, leaf0(root), t('tab', 'overwrite'))
    expect(plan.action).toBe('pane')
    if (plan.action !== 'pane') throw new Error('expected pane')
    expect(plan.root).not.toBe(root) // brand-new tree
    expect(plan.root.kind).toBe('leaf')
    expect(plan.leafId).toBe(plan.root.id)
  })

  it('split + overwrite targets the active leaf in place', () => {
    const root = buildPreset('splitH')
    const active = leaf0(root)
    const plan = plan_open(root, active, t('split', 'overwrite'))
    expect(plan).toEqual({ action: 'pane', root, leafId: active })
  })

  it('split + new reuses the first empty leaf', () => {
    const root = buildPreset('splitH')
    const empty = findFirstEmptyLeaf(root)!
    const plan = plan_open(root, leaf0(root), t('split', 'new'))
    expect(plan.action).toBe('pane')
    if (plan.action !== 'pane') throw new Error('expected pane')
    expect(plan.leafId).toBe(empty.id)
  })

  // Regression: a full-pane terminal tab (landing "Terminal" converts the
  // structure tab's only leaf to a terminal) + Split/Overwrite silently showed
  // nothing — the plan targeted the terminal leaf in place, which can't host a
  // structure. Overwrite aimed at a terminal must escalate like `new`.
  it('split + overwrite over a terminal leaf escalates to a split', () => {
    const root = create_terminal_leaf()
    const plan = plan_open(root, root.id, t('split', 'overwrite'))
    expect(plan.action).toBe('pane')
    if (plan.action !== 'pane') throw new Error('expected pane')
    expect(plan.root.kind).toBe('split') // terminal kept, structure pane beside it
    expect(plan.leafId).not.toBe(root.id)
  })

  it('split + overwrite over a terminal leaf reuses an existing empty pane', () => {
    const root = buildPreset('splitH')
    const b = leaves(root)[1]
    const withTerm = { ...root, children: [create_terminal_leaf(), b] } as typeof root
    const term = leaves(withTerm)[0]
    const plan = plan_open(withTerm, term.id, t('split', 'overwrite'))
    expect(plan.action).toBe('pane')
    if (plan.action !== 'pane') throw new Error('expected pane')
    expect(plan.leafId).toBe(b.id) // the empty structure leaf, tree unchanged
    expect(plan.root).toBe(withTerm)
  })

  it('split + overwrite over a structure leaf still loads in place', () => {
    const root = buildPreset('single')
    const plan = plan_open(root, root.id, t('split', 'overwrite'))
    expect(plan).toEqual({ action: 'pane', root, leafId: root.id })
  })

  // Regression: after the first escalate created a structure pane beside the
  // terminal, every later Ctrl+click (which re-focuses the terminal) split yet
  // ANOTHER pane. Overwrite means "replace what's showing" — reuse the
  // existing structure pane even when it already has content.
  it('split + overwrite over a terminal overwrites an existing full structure pane', () => {
    const full = create_empty_leaf()
    ;(full.content as { pane: { structure?: unknown } }).pane.structure = { sites: [] }
    const term = create_terminal_leaf()
    const root = {
      kind: 'split',
      id: 's-mixed',
      direction: 'h',
      ratio: 0.5,
      children: [term, full],
    } as unknown as ReturnType<typeof buildPreset>
    const plan = plan_open(root, term.id, t('split', 'overwrite'))
    expect(plan).toEqual({ action: 'pane', root, leafId: full.id })
  })

  it('split + overwrite over a terminal at the pane cap falls back to a new tab', () => {
    // 4 terminal leaves = CAP reached, nothing empty, nothing splittable.
    const col = (l1: ReturnType<typeof create_terminal_leaf>, l2: ReturnType<typeof create_terminal_leaf>) =>
      ({ kind: 'split', id: `s-${l1.id}`, direction: 'v', ratio: 0.5, children: [l1, l2] }) as const
    const t1 = create_terminal_leaf(), t2 = create_terminal_leaf()
    const t3 = create_terminal_leaf(), t4 = create_terminal_leaf()
    const root = {
      kind: 'split',
      id: `s-root`,
      direction: 'h',
      ratio: 0.5,
      children: [col(t1, t2), col(t3, t4)],
    } as unknown as ReturnType<typeof buildPreset>
    expect(plan_open(root, t1.id, t('split', 'overwrite'))).toEqual({ action: 'new-tab' })
  })
})

/** First leaf id of a freshly built preset tree. */
function leaf0(root: ReturnType<typeof buildPreset>): string {
  return root.kind === 'leaf' ? root.id : (root.children[0] as { id: string }).id
}
