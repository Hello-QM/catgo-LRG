import { describe, it, expect } from 'vitest'
import { base64_to_arraybuffer, sanitize_docx_html } from '../../../src/lib/viewer/DocxView.svelte'

describe('base64_to_arraybuffer', () => {
  it('round-trips ascii bytes', () => {
    const b64 = btoa('hi')
    const buf = base64_to_arraybuffer(b64)
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([104, 105]))
  })
})

describe('sanitize_docx_html', () => {
  it('keeps data: URI on img src so mammoth inline images render', () => {
    const raw = `<img src="data:image/png;base64,iVBORw0KGgo=">`
    const out = sanitize_docx_html(raw)
    expect(out).toContain(`src="data:image/png;base64,iVBORw0KGgo="`)
  })

  it('strips script tags (XSS protection)', () => {
    const raw = `<p>hello</p><script>alert(1)<\/script>`
    const out = sanitize_docx_html(raw)
    expect(out).not.toContain(`<script`)
    expect(out).not.toContain(`alert(1)`)
    expect(out).toContain(`hello`)
  })
})
