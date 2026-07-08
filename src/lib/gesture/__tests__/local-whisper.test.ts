import { describe, it, expect, vi, beforeEach } from 'vitest'

const pipeline_spy = vi.fn(async (..._a: any[]) => async () => ({ text: `` }))

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: any[]) => pipeline_spy(...args),
  env: { backends: { onnx: { wasm: {} } } },
}))

describe('local-whisper model id threading', () => {
  beforeEach(() => {
    pipeline_spy.mockClear()
    vi.resetModules()
  })

  it('preload uses an explicit model id verbatim', async () => {
    const { preload_whisper_model } = await import('../local-whisper')
    await preload_whisper_model('en', undefined, 'onnx-community/whisper-small')
    expect(pipeline_spy).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-small',
      expect.anything(),
    )
  })

  it('preload falls back to a registry model when no id given', async () => {
    const { preload_whisper_model } = await import('../local-whisper')
    const { WHISPER_MODELS } = await import('../whisper-models')
    await preload_whisper_model('zh-CN')
    const used = pipeline_spy.mock.calls[0][1]
    expect(WHISPER_MODELS.some((m) => m.id === used)).toBe(true)
  })
})
