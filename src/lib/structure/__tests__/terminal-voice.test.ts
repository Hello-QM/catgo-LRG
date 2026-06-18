import { describe, it, expect, vi } from 'vitest'
import { TerminalVoice } from '../terminal-voice.svelte'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

function fake_event(text: string, is_final: boolean): VoiceEvent {
  return {
    action: { type: `none` } as any,
    raw_text: text,
    confidence: 0.9,
    is_final,
    match_score: 0,
    timestamp: 0,
  }
}

// A controllable fake engine that lets the test fire transcript events.
function make_fake() {
  let cb: ((e: VoiceEvent) => void) | null = null
  const engine = {
    is_supported: true,
    start: vi.fn((c: any) => { cb = c }),
    stop: vi.fn(() => { cb = null }),
  }
  return { engine, fire: (e: VoiceEvent) => cb?.(e) }
}

describe('TerminalVoice', () => {
  it('forwards only final transcripts to send, with a trailing space', async () => {
    const { engine, fire } = make_fake()
    const tv = new TerminalVoice(() => engine)
    const sent: string[] = []
    await tv.toggle((t) => sent.push(t))
    expect(tv.recording).toBe(true)

    fire(fake_event(`hello`, false)) // interim — ignored
    fire(fake_event(`hello world`, true)) // final — sent
    expect(sent).toEqual([`hello world `])
  })

  it('drops empty / whitespace-only final transcripts', async () => {
    const { engine, fire } = make_fake()
    const tv = new TerminalVoice(() => engine)
    const sent: string[] = []
    await tv.toggle((t) => sent.push(t))
    fire(fake_event(`   `, true))
    expect(sent).toEqual([])
  })

  it('toggle a second time stops and clears recording', async () => {
    const { engine } = make_fake()
    const tv = new TerminalVoice(() => engine)
    await tv.toggle(() => {})
    await tv.toggle(() => {})
    expect(engine.stop).toHaveBeenCalled()
    expect(tv.recording).toBe(false)
  })

  it('reports unsupported when the engine is unsupported', () => {
    const tv = new TerminalVoice(() => ({ is_supported: false, start: vi.fn(), stop: vi.fn() }))
    expect(tv.is_supported).toBe(false)
  })
})
