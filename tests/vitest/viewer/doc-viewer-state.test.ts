import { describe, it, expect, beforeEach } from 'vitest'
import { doc_viewer, open_doc, close_tab, activate, set_dirty, set_view } from '../../../src/lib/viewer/doc-viewer-state.svelte'
import type { DocRef } from '../../../src/lib/viewer/doc-viewer-state.svelte'

const ref = (over: Partial<DocRef> = {}): DocRef => ({
  filename: 'a.txt', kind: 'text', editable: true, view: 'edit',
  origin: null, local_path: '/tmp/a.txt', inline: null, ...over,
})

beforeEach(() => { doc_viewer.tabs = []; doc_viewer.active_id = null })

describe('doc-viewer-state', () => {
  it('appends a tab and activates it', () => {
    const id = open_doc(ref())
    expect(doc_viewer.tabs).toHaveLength(1)
    expect(doc_viewer.active_id).toBe(id)
  })
  it('dedupes the same file to one tab and focuses it', () => {
    const id1 = open_doc(ref())
    const id2 = open_doc(ref({ filename: 'b.txt', local_path: '/tmp/b.txt' }))
    const id1b = open_doc(ref()) // same local_path as id1
    expect(doc_viewer.tabs).toHaveLength(2)
    expect(id1b).toBe(id1)
    expect(doc_viewer.active_id).toBe(id1)
    expect(id2).not.toBe(id1)
  })
  it('close removes a tab and re-activates a neighbor', () => {
    const a = open_doc(ref())
    const b = open_doc(ref({ filename: 'b.txt', local_path: '/tmp/b.txt' }))
    close_tab(b)
    expect(doc_viewer.tabs.map(t => t.id)).toEqual([a])
    expect(doc_viewer.active_id).toBe(a)
  })
  it('set_dirty flags the tab', () => {
    const a = open_doc(ref())
    set_dirty(a, true)
    expect(doc_viewer.tabs[0].dirty).toBe(true)
  })
  it('set_view changes the view on the matching tab', () => {
    const a = open_doc(ref({ view: 'edit' }))
    set_view(a, 'preview')
    expect(doc_viewer.tabs[0].view).toBe('preview')
    set_view(a, 'edit')
    expect(doc_viewer.tabs[0].view).toBe('edit')
  })
  it('dedupes path-less inline refs by filename', () => {
    const id1 = open_doc(ref({ filename: 'drop.txt', local_path: null, inline: { text: 'A', binary: null, mime: null } }))
    const id2 = open_doc(ref({ filename: 'drop.txt', local_path: null, inline: { text: 'B', binary: null, mime: null } }))
    expect(id2).toBe(id1)
    expect(doc_viewer.tabs).toHaveLength(1)
  })
})
