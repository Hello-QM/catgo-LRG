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

  it('only one voice records at a time — starting a second stops the first', async () => {
    // Regression: two terminal panes each enabling voice spun up two MicVADs that
    // both transcribed the same speech, duplicating injected keystrokes. Starting
    // voice on pane B must stop pane A (single microphone → single voice).
    const a = make_fake()
    const b = make_fake()
    const va = new TerminalVoice(() => a.engine)
    const vb = new TerminalVoice(() => b.engine)

    await va.toggle(() => {})
    expect(va.recording).toBe(true)

    await vb.toggle(() => {})
    expect(vb.recording).toBe(true)
    // A was taken over → stopped and no longer recording.
    expect(va.recording).toBe(false)
    expect(a.engine.stop).toHaveBeenCalled()

    // A no longer receives transcripts; only B injects.
    const sent: string[] = []
    await vb.toggle(() => {}) // stop B to reset, then restart capturing
    await vb.toggle((t) => sent.push(t))
    b.fire(fake_event(`one`, true))
    a.fire(fake_event(`one`, true)) // A is dead — must not fire
    expect(sent).toEqual([`one `])
  })

  it('on_error fully stops — no phantom dictation with the button off', async () => {
    // Regression: on_error only cleared `recording`, leaving the VAD/mic running
    // so it kept transcribing + injecting while the mic button showed off.
    let on_err: ((e: string) => void) | null = null
    const engine = {
      is_supported: true,
      start: vi.fn((_cb: any, _l: any, _ai: any, oe: any) => { on_err = oe }),
      stop: vi.fn(),
    }
    const tv = new TerminalVoice(() => engine)
    await tv.toggle(() => {})
    expect(tv.recording).toBe(true)

    on_err!('audio-capture')
    expect(tv.recording).toBe(false)
    expect(engine.stop).toHaveBeenCalled()
  })

  it('reports unsupported when the engine is unsupported', () => {
    const tv = new TerminalVoice(() => ({ is_supported: false, start: vi.fn(), stop: vi.fn() }))
    expect(tv.is_supported).toBe(false)
  })
})
