/**
 * Local Whisper STT engine using Transformers.js.
 *
 * Runs Whisper models entirely in-browser with WebGPU (Chrome/Edge) or WASM fallback.
 * Models are cached in IndexedDB after first download (~75MB for whisper-tiny).
 */

import type { VoiceEvent } from './gesture-types'
import type { VoiceCallback, VoiceErrorCallback } from './voice-engine'
import { match_command_with_score } from './voice-engine'
import { start_vad, stop_vad } from './vad'
import type { AudioPipeline } from './audio-pipeline'

// ─── Model Status ────────────────────────────────────────────────────

export type ModelStatus = `idle` | `loading` | `downloading` | `ready` | `error`

export type ModelProgressCallback = (status: ModelStatus, progress?: number) => void

// ─── Singleton Pipeline ──────────────────────────────────────────────

const MODEL_EN = `onnx-community/whisper-tiny.en`
const MODEL_MULTI = `onnx-community/whisper-tiny`

let pipeline_promise: Promise<any> | null = null
let current_model_id: string | null = null

async function get_pipeline(
  language: string,
  on_progress?: ModelProgressCallback,
): Promise<any> {
  const model_id = language === `en` ? MODEL_EN : MODEL_MULTI

  // Return cached pipeline if same model
  if (pipeline_promise && current_model_id === model_id) {
    return pipeline_promise
  }

  // New model needed — reset
  pipeline_promise = null
  current_model_id = model_id

  on_progress?.(`loading`)

  pipeline_promise = (async () => {
    const { pipeline, env } = await import(`@huggingface/transformers`)

    // Prefer WebGPU, fall back to WASM
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1
    }

    on_progress?.(`downloading`, 0)

    const pipe = await pipeline(`automatic-speech-recognition`, model_id, {
      dtype: `q8`,
      device: `auto`,
      progress_callback: (data: any) => {
        if (data.status === `progress` && typeof data.progress === `number`) {
          on_progress?.(`downloading`, data.progress)
        }
      },
    })

    on_progress?.(`ready`)
    return pipe
  })()

  try {
    return await pipeline_promise
  } catch (err) {
    pipeline_promise = null
    current_model_id = null
    on_progress?.(`error`)
    throw err
  }
}

/** Pre-load the Whisper model (e.g. from settings UI). */
export async function preload_whisper_model(
  language = `en`,
  on_progress?: ModelProgressCallback,
): Promise<void> {
  await get_pipeline(language, on_progress)
}

// ─── Local Whisper Engine ────────────────────────────────────────────

export class LocalWhisperEngine {
  private callback: VoiceCallback | null = null
  private error_callback: VoiceErrorCallback | null = null
  private running = false
  private language = `en`
  private ai_enabled = false
  private transcribing = false
  private pipeline: AudioPipeline | null = null
  private on_progress: ModelProgressCallback | undefined

  constructor(on_progress?: ModelProgressCallback) {
    this.on_progress = on_progress
  }

  get is_supported(): boolean {
    return typeof navigator !== `undefined`
      && !!navigator.mediaDevices?.getUserMedia
  }

  get is_running(): boolean {
    return this.running
  }

  async start(
    callback: VoiceCallback,
    language = `en-US`,
    ai_enabled = false,
    on_error?: VoiceErrorCallback,
    noise_suppression = false,
  ): Promise<void> {
    if (this.running) return
    this.callback = callback
    this.error_callback = on_error ?? null
    this.language = language.split(`-`)[0]
    this.ai_enabled = ai_enabled

    try {
      // Load model first (may trigger download)
      await get_pipeline(this.language, this.on_progress)

      // Optionally create noise suppression pipeline
      let stream: MediaStream | undefined
      if (noise_suppression) {
        try {
          const { create_audio_pipeline } = await import(`./audio-pipeline`)
          this.pipeline = await create_audio_pipeline()
          stream = this.pipeline.stream
        } catch (err) {
          console.warn(`[LocalWhisper] Noise suppression failed, using raw mic:`, err)
        }
      }

      // Start Silero VAD
      await start_vad({
        on_speech_end: (audio: Float32Array) => {
          this.transcribe_local(audio)
        },
        stream,
      })

      this.running = true
      console.info(`[LocalWhisper] Started (lang=${this.language}, local inference)`)
    } catch (err) {
      console.error(`[LocalWhisper] Failed to start:`, err)
      this.error_callback?.(err instanceof DOMException ? `not-allowed` : `audio-capture`)
      throw err
    }
  }

  stop(): void {
    this.running = false
    stop_vad()
    if (this.pipeline) {
      this.pipeline.destroy()
      this.pipeline = null
    }
    this.callback = null
  }

  set_language(lang: string, ai_enabled = false): void {
    const new_lang = lang.split(`-`)[0]
    const model_changed = (new_lang === `en`) !== (this.language === `en`)
    this.language = new_lang
    this.ai_enabled = ai_enabled

    // If switching between en ↔ multilingual, the pipeline will reload on next transcription
    if (model_changed) {
      pipeline_promise = null
      current_model_id = null
      console.info(`[LocalWhisper] Language changed, model will reload on next transcription`)
    }
  }

  // ─── Local Transcription ──────────────────────────────────────────

  private async transcribe_local(audio: Float32Array): Promise<void> {
    if (this.transcribing) return
    this.transcribing = true

    try {
      const pipe = await get_pipeline(this.language, this.on_progress)

      const result = await pipe(audio, {
        language: this.language === `en` ? undefined : this.language,
        task: `transcribe`,
      })

      const text = (result as any)?.text?.trim()
      if (!text) return

      const confidence = 0.85
      const { action, match_score } = match_command_with_score(text, this.ai_enabled, confidence)
      this.callback?.({
        action,
        raw_text: text,
        confidence,
        is_final: true,
        match_score,
        timestamp: performance.now(),
      })
    } catch (err) {
      console.error(`[LocalWhisper] Transcription failed:`, err)
    } finally {
      this.transcribing = false
    }
  }
}
