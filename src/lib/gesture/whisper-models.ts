/**
 * Selectable Whisper ASR models for local in-browser transcription.
 *
 * All run via Transformers.js (WebGPU/WASM); models download on demand from the
 * HuggingFace Hub and are cached in IndexedDB. Sizes are approximate q8/q4
 * download sizes, shown in the picker so the user knows what they are fetching.
 */

export interface WhisperModel {
  id: string // HuggingFace repo id
  label: string // short UI label
  size_mb: number // approx download size
  multilingual: boolean // false = English-only (.en)
}

export const WHISPER_MODELS: WhisperModel[] = [
  { id: `onnx-community/whisper-tiny.en`, label: `Tiny (English)`, size_mb: 40, multilingual: false },
  { id: `onnx-community/whisper-tiny`, label: `Tiny (multilingual)`, size_mb: 40, multilingual: true },
  { id: `onnx-community/whisper-base.en`, label: `Base (English)`, size_mb: 80, multilingual: false },
  { id: `onnx-community/whisper-base`, label: `Base (multilingual)`, size_mb: 80, multilingual: true },
  { id: `onnx-community/whisper-small.en`, label: `Small (English)`, size_mb: 250, multilingual: false },
  { id: `onnx-community/whisper-small`, label: `Small (multilingual)`, size_mb: 250, multilingual: true },
  { id: `onnx-community/whisper-large-v3-turbo`, label: `Large turbo (multilingual)`, size_mb: 800, multilingual: true },
]

export const DEFAULT_WHISPER_MODEL_ID = `onnx-community/whisper-base`

/** Resolve which model id to load given an optional explicit choice + language. */
export function resolve_model_id(explicit: string | undefined, language: string): string {
  if (explicit && WHISPER_MODELS.some((m) => m.id === explicit)) return explicit
  const is_en = language === `en` || language.startsWith(`en-`)
  if (is_en) {
    const en = WHISPER_MODELS.find((m) => !m.multilingual)
    if (en) return en.id
  }
  return DEFAULT_WHISPER_MODEL_ID
}
