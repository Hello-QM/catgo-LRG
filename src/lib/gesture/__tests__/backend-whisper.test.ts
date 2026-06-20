import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

// Capture the VAD's speech-end callback so tests can drive transcription
// without a real microphone / Silero model.
const vad = vi.hoisted(() => ({
  on_speech_end: null as ((a: Float32Array) => void) | null,
  start: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('$lib/gesture/vad', () => ({
  start_vad: vi.fn(async (cfg: { on_speech_end: (a: Float32Array) => void }) => {
    vad.on_speech_end = cfg.on_speech_end
    vad.start()
  }),
  stop_vad: () => vad.stop(),
}))

import { BackendWhisperEngine, backend_stt_available } from '../backend-whisper'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('BackendWhisperEngine', () => {
  beforeEach(() => {
    vad.on_speech_end = null
    vad.start.mockClear()
    vad.stop.mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs each speech segment to /stt/transcribe and forwards the text', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const eng = new BackendWhisperEngine()
    const events: VoiceEvent[] = []
    await eng.start((e) => events.push(e), 'en-US', false, undefined, false, 'whisper-base')
    expect(vad.start).toHaveBeenCalled()

    vad.on_speech_end!(new Float32Array([0.1, 0.2, 0.3]))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/stt/transcribe')
    expect(url).toContain('language=en')
    expect(url).toContain('model=whisper-base')
    expect(init.method).toBe('POST')

    expect(events).toHaveLength(1)
    expect(events[0].raw_text).toBe('hello world')
    expect(events[0].is_final).toBe(true)
  })

  it('drops empty / whitespace-only transcriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ text: '   ' }) })))
    const eng = new BackendWhisperEngine()
    const events: VoiceEvent[] = []
    await eng.start((e) => events.push(e))
    vad.on_speech_end!(new Float32Array([0]))
    await flush()
    expect(events).toEqual([])
  })

  it('serializes: a segment arriving mid-request is dropped (no backlog)', async () => {
    // First request never resolves → the second speech-end must be ignored.
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const eng = new BackendWhisperEngine()
    await eng.start(() => {})
    vad.on_speech_end!(new Float32Array([0.1]))
    vad.on_speech_end!(new Float32Array([0.2]))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not throw / inject when the backend errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const eng = new BackendWhisperEngine()
    const events: VoiceEvent[] = []
    await eng.start((e) => events.push(e))
    vad.on_speech_end!(new Float32Array([0.1]))
    await flush()
    expect(events).toEqual([])
  })
})

describe('backend_stt_available', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('true when /stt/health reports available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: true }) })))
    expect(await backend_stt_available(true)).toBe(true)
  })

  it('false when health reports unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: false }) })))
    expect(await backend_stt_available(true)).toBe(false)
  })

  it('false when the request throws (no backend)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused') }))
    expect(await backend_stt_available(true)).toBe(false)
  })
})
