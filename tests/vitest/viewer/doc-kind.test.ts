import { describe, it, expect } from 'vitest'
import { resolve_doc_kind } from '../../../src/lib/viewer/doc-kind'

describe('resolve_doc_kind', () => {
  it('maps editable text/code/markdown', () => {
    expect(resolve_doc_kind('a.txt')).toEqual({ kind: 'text', editable: true, preview_mode: null })
    expect(resolve_doc_kind('main.py')).toEqual({ kind: 'text', editable: true, preview_mode: null })
    expect(resolve_doc_kind('README.md')).toEqual({ kind: 'markdown', editable: true, preview_mode: 'markdown' })
  })
  it('maps read-only preview kinds', () => {
    expect(resolve_doc_kind('t.csv')).toEqual({ kind: 'csv', editable: false, preview_mode: 'csv' })
    expect(resolve_doc_kind('d.pdf')).toEqual({ kind: 'pdf', editable: false, preview_mode: 'pdf' })
    expect(resolve_doc_kind('p.png')).toEqual({ kind: 'image', editable: false, preview_mode: 'image' })
    expect(resolve_doc_kind('s.xlsx')).toEqual({ kind: 'excel', editable: false, preview_mode: 'excel' })
    expect(resolve_doc_kind('r.docx')).toEqual({ kind: 'docx', editable: false, preview_mode: null })
  })
  it('maps html kinds', () => {
    expect(resolve_doc_kind('page.html')).toEqual({ kind: 'html', editable: true, preview_mode: null })
    expect(resolve_doc_kind('page.htm')).toEqual({ kind: 'html', editable: true, preview_mode: null })
    expect(resolve_doc_kind('page.xhtml')).toEqual({ kind: 'html', editable: true, preview_mode: null })
  })
  it('falls back unknown extensions to editable text', () => {
    expect(resolve_doc_kind('weird.zzz')).toEqual({ kind: 'text', editable: true, preview_mode: null })
  })
})
