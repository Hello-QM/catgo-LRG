import { describe, it, expect } from 'vitest'
import { base64_to_arraybuffer } from '../../../src/lib/viewer/DocxView.svelte'

describe('base64_to_arraybuffer', () => {
  it('round-trips ascii bytes', () => {
    const b64 = btoa('hi')
    const buf = base64_to_arraybuffer(b64)
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([104, 105]))
  })
})
