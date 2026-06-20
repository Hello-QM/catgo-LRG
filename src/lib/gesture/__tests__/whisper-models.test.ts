import { describe, it, expect } from 'vitest'
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL_ID,
  resolve_model_id,
} from '../whisper-models'

describe('whisper-models registry', () => {
  it('is non-empty and every id is namespaced under onnx-community', () => {
    expect(WHISPER_MODELS.length).toBeGreaterThan(0)
    for (const m of WHISPER_MODELS) {
      expect(m.id).toMatch(/^onnx-community\/whisper-/)
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.size_mb).toBeGreaterThan(0)
    }
  })

  it('exposes a default id that exists in the registry', () => {
    expect(WHISPER_MODELS.some((m) => m.id === DEFAULT_WHISPER_MODEL_ID)).toBe(true)
  })

  it('resolve_model_id honors an explicit known id', () => {
    const known = WHISPER_MODELS[0].id
    expect(resolve_model_id(known, 'en')).toBe(known)
  })

  it('resolve_model_id ignores an unknown explicit id and falls back', () => {
    const out = resolve_model_id('totally/unknown', 'en')
    expect(WHISPER_MODELS.some((m) => m.id === out)).toBe(true)
  })

  it('resolve_model_id picks an English-only model for en and a multilingual one otherwise', () => {
    const en = resolve_model_id(undefined, 'en-US')
    const multi = resolve_model_id(undefined, 'zh-CN')
    expect(WHISPER_MODELS.find((m) => m.id === en)?.multilingual).toBe(false)
    expect(WHISPER_MODELS.find((m) => m.id === multi)?.multilingual).toBe(true)
  })
})
