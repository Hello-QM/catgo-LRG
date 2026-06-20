import { describe, it, expect } from 'vitest'
import { resolve_open_target, type OpenTarget } from '../../src/lib/state.svelte'
import { plan_open } from '../../desktop/lib/open-dispatch'
import { buildPreset, findFirstEmptyLeaf } from '../../desktop/pane-tree'

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
})

/** First leaf id of a freshly built preset tree. */
function leaf0(root: ReturnType<typeof buildPreset>): string {
  return root.kind === 'leaf' ? root.id : (root.children[0] as { id: string }).id
}
