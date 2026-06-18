import { describe, it, expect } from 'vitest'
import { sanitize_html } from '../../../src/lib/viewer/HtmlView.svelte'

describe('sanitize_html', () => {
  it('keeps data: URI on img src', () => {
    const input = '<img src="data:image/png;base64,iVBORw0KGgo=">'
    const out = sanitize_html(input)
    expect(out).toContain('data:image/png;base64,iVBORw0KGgo=')
  })
  it('strips script tags', () => {
    const input = '<p>hello</p><script>alert(1)<\/script>'
    const out = sanitize_html(input)
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<p>hello</p>')
  })
  it('strips on* event handlers', () => {
    const input = '<div onclick="evil()">click</div>'
    const out = sanitize_html(input)
    expect(out).not.toContain('onclick')
    expect(out).toContain('click')
  })
  it('strips javascript: hrefs', () => {
    const input = '<a href="javascript:alert(1)">link</a>'
    const out = sanitize_html(input)
    expect(out).not.toContain('javascript:')
  })
})
