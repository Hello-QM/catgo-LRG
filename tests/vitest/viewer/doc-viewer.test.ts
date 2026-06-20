import { describe, it, expect } from 'vitest'
import { renderer_for } from '../../../src/lib/viewer/DocViewer.svelte'

describe('renderer_for', () => {
  it('markdown preview → mdpreview, edit → monaco', () => {
    expect(renderer_for('markdown', 'preview')).toBe('mdpreview')
    expect(renderer_for('markdown', 'edit')).toBe('monaco')
  })
  it('html preview → htmlview, edit → monaco', () => {
    expect(renderer_for('html', 'preview')).toBe('htmlview')
    expect(renderer_for('html', 'edit')).toBe('monaco')
  })
  it('docx → docx regardless of view', () => {
    expect(renderer_for('docx', 'preview')).toBe('docx')
  })
  it('csv/pdf/image/excel → preview', () => {
    for (const k of ['csv', 'pdf', 'image', 'excel'] as const) {
      expect(renderer_for(k, 'preview')).toBe('preview')
    }
  })
  it('text → monaco', () => {
    expect(renderer_for('text', 'edit')).toBe('monaco')
  })
})
