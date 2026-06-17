import { describe, expect, it } from 'vitest'
import { assistant_text_fallback } from '../claude.js'

const assistant = (blocks: unknown[]) => ({ type: 'assistant', message: { content: blocks } })

describe('assistant_text_fallback — text-loss guard for cold-start turns', () => {
  it('emits the final text blocks when NO partials streamed (len=0)', () => {
    const out = assistant_text_fallback(assistant([{ type: 'text', text: 'Hello!' }]), 0)
    expect(out).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('returns [] when text already streamed (avoid duplication)', () => {
    const out = assistant_text_fallback(assistant([{ type: 'text', text: 'Hello!' }]), 6)
    expect(out).toEqual([])
  })

  it('returns [] when the assistant message has only tool_use (no text)', () => {
    const out = assistant_text_fallback(
      assistant([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]),
      0,
    )
    expect(out).toEqual([])
  })

  it('emits multiple text blocks in order, skipping non-text blocks', () => {
    const out = assistant_text_fallback(
      assistant([
        { type: 'text', text: 'A' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
        { type: 'text', text: 'B' },
      ]),
      0,
    )
    expect(out).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])
  })

  it('tolerates malformed / empty messages', () => {
    expect(assistant_text_fallback({ type: 'assistant' }, 0)).toEqual([])
    expect(assistant_text_fallback(null, 0)).toEqual([])
    expect(assistant_text_fallback(assistant([{ type: 'text', text: '' }]), 0)).toEqual([])
  })
})
