import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue_pending, drain_pending, sweep_inline_keys } from '../../../src/lib/viewer/doc-channel'
import type { DocRef } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const ref = (n: string): DocRef => ({
  filename: n, kind: 'text', editable: true, origin: null, local_path: `/tmp/${n}`, inline_key: null,
})

beforeEach(() => localStorage.clear())

describe('doc-channel pending queue', () => {
  it('enqueues and drains in order, then clears', () => {
    enqueue_pending(ref('a.txt'))
    enqueue_pending(ref('b.txt'))
    const drained = drain_pending()
    expect(drained.map(r => r.filename)).toEqual(['a.txt', 'b.txt'])
    expect(drain_pending()).toEqual([])
  })
  it('drain on empty returns []', () => {
    expect(drain_pending()).toEqual([])
  })
})

describe('sweep_inline_keys', () => {
  it('removes orphaned inline keys not in keep list', () => {
    localStorage.setItem('catgo-docs-inline-a', 'data-a')
    localStorage.setItem('catgo-docs-inline-b', 'data-b')
    localStorage.setItem('other', 'untouched')
    sweep_inline_keys(['catgo-docs-inline-a'])
    expect(localStorage.getItem('catgo-docs-inline-a')).toBe('data-a')
    expect(localStorage.getItem('catgo-docs-inline-b')).toBeNull()
    expect(localStorage.getItem('other')).toBe('untouched')
  })

  it('removes all inline keys when keep list is empty', () => {
    localStorage.setItem('catgo-docs-inline-x', 'x')
    sweep_inline_keys([])
    expect(localStorage.getItem('catgo-docs-inline-x')).toBeNull()
  })

  it('is a no-op when there are no inline keys', () => {
    localStorage.setItem('other', 'safe')
    sweep_inline_keys([])
    expect(localStorage.getItem('other')).toBe('safe')
  })
})
