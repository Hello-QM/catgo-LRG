import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue_pending, drain_pending } from '../../../src/lib/viewer/doc-channel'
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
