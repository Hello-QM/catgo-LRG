import { describe, it, expect, beforeEach } from 'vitest'
import { build_doc_ref } from '../../../src/lib/viewer/doc-ref'

beforeEach(() => localStorage.clear())

describe('build_doc_ref', () => {
  it('uses local_path when given, no inline key', () => {
    const ref = build_doc_ref('a.txt', { local_path: '/tmp/a.txt' })
    expect(ref).toMatchObject({ filename: 'a.txt', kind: 'text', editable: true, view: 'edit', local_path: '/tmp/a.txt', inline_key: null })
  })
  it('uses origin for remote', () => {
    const ref = build_doc_ref('d.pdf', { origin: { session_id: 's', file_path: '/r/d.pdf' } })
    expect(ref).toMatchObject({ kind: 'pdf', editable: false, view: 'preview', origin: { session_id: 's', file_path: '/r/d.pdf' } })
  })
  it('stashes inline content under a localStorage key when path-less', () => {
    const ref = build_doc_ref('drop.txt', { content: 'HELLO' })
    expect(ref.inline_key).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(ref.inline_key!)!)).toEqual({ text: 'HELLO', binary: null, mime: null })
  })
  it('defaults markdown to preview view', () => {
    const ref = build_doc_ref('README.md', { local_path: '/tmp/README.md' })
    expect(ref.view).toBe('preview')
  })
  it('defaults html to preview view', () => {
    const ref = build_doc_ref('index.html', { local_path: '/tmp/index.html' })
    expect(ref.view).toBe('preview')
  })
  it('defaults text to edit view', () => {
    const ref = build_doc_ref('main.py', { local_path: '/tmp/main.py' })
    expect(ref.view).toBe('edit')
  })
  it('respects explicit src.view override', () => {
    const ref = build_doc_ref('README.md', { local_path: '/tmp/README.md', view: 'edit' })
    expect(ref.view).toBe('edit')
  })
})
