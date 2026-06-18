import { describe, it, expect } from 'vitest'
import { renderer_for } from '../../../src/lib/viewer/DocViewer.svelte'

describe('renderer_for', () => {
  it('editable text/markdown → monaco', () => {
    expect(renderer_for('text', true)).toBe('monaco')
    expect(renderer_for('markdown', true)).toBe('monaco')
  })
  it('docx → docx', () => {
    expect(renderer_for('docx', false)).toBe('docx')
  })
  it('csv/pdf/image/excel → preview', () => {
    for (const k of ['csv', 'pdf', 'image', 'excel'] as const) {
      expect(renderer_for(k, false)).toBe('preview')
    }
  })
})
