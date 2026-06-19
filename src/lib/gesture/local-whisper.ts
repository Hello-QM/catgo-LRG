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
import { resolve_model_id } from './whisper-models'

// ─── Model Status ────────────────────────────────────────────────────

export type ModelStatus = `idle` | `loading` | `downloading` | `ready` | `error`

export type ModelProgressCallback = (status: ModelStatus, progress?: number) => void

// ─── Singleton Pipeline ──────────────────────────────────────────────

/** Inference backend. cpu = wasm + q8 (correct everywhere, slower). gpu =
 * WebGPU + fp16 (fast where WebGPU is sound; q8-on-WebGPU hallucinates, so the
 * GPU path uses an fp16 model variant instead). */
export type Accel = `cpu` | `gpu`

let pipeline_promise: Promise<any> | null = null
let current_key: string | null = null

async function get_pipeline(
  model_id: string,
  accel: Accel = `cpu`,
  on_progress?: ModelProgressCallback,
): Promise<any> {
  const key = `${model_id}::${accel}`
  // Return cached pipeline if same model + backend
  if (pipeline_promise && current_key === key) {
    return pipeline_promise
  }

  // New model/backend needed — reset
  pipeline_promise = null
  current_key = key

  on_progress?.(`loading`)

  pipeline_promise = (async () => {
    const { pipeline, env } = await import(`@huggingface/transformers`)

    if (env.backends?.onnx?.wasm) {
      // Multi-threaded wasm needs SharedArrayBuffer, which only exists when the
      // page is cross-origin isolated (COOP/COEP headers). When it is, use up to
      // 4 cores for a big CPU-inference speedup (the common case on machines
      // without usable WebGPU, e.g. integrated graphics under WebKitGTK); when
      // it is not, fall back to a single thread (the safe default — more threads
      // without isolation would fail to init).
      const isolated = typeof globalThis !== `undefined`
        && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
      const cores = (typeof navigator !== `undefined` && navigator.hardwareConcurrency) || 4
      // Use most cores but leave ~2 for the audio worklet / VAD / UI, and cap at
      // 8 — beyond that wasm Whisper is memory-bandwidth bound and thread-sync
      // overhead eats the gains (16 threads ≠ 2× of 8). Single thread without
      // cross-origin isolation (no SharedArrayBuffer).
      env.backends.onnx.wasm.numThreads = isolated ? Math.max(1, Math.min(8, cores - 2)) : 1
      // Load the onnxruntime-web wasm runtime from a CDN pinned to the version
      // @huggingface/transformers bundles. Without this, the WASM backend (the
      // fallback when WebGPU is unavailable — e.g. machines without a discrete
      // GPU) tries to fetch ort-wasm-*.mjs from the app's own /assets, which the
      // Vite build does not emit, producing "no available backend found". The
      // version MUST match @huggingface/transformers' onnxruntime-web dep.
      if (!env.backends.onnx.wasm.wasmPaths) {
        env.backends.onnx.wasm.wasmPaths =
          `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/`
      }
    }

    on_progress?.(`downloading`, 0)

    // CPU path: wasm + q8 (correct everywhere). GPU path: WebGPU + fp16 — q8 on
    // WebGPU produces garbage/hallucinated output (esp. integrated GPUs), so the
    // GPU path uses the fp16 model variant, which runs correctly on WebGPU.
    const pipe = await pipeline(`automatic-speech-recognition`, model_id, {
      dtype: accel === `gpu` ? `fp16` : `q8`,
      device: accel === `gpu` ? `webgpu` : `wasm`,
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
    current_key = null
    on_progress?.(`error`)
    throw err
  }
}

/** Pre-load a Whisper model (e.g. from settings UI). */
export async function preload_whisper_model(
  language = `en`,
  on_progress?: ModelProgressCallback,
  model_id?: string,
  accel: Accel = `cpu`,
): Promise<void> {
  await get_pipeline(resolve_model_id(model_id, language), accel, on_progress)
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
  private model_id: string | null = null
  private accel: Accel = `cpu`

  constructor(on_progress?: ModelProgressCallback) {
    this.on_progress = on_progress
  }

  get current_model_id(): string | null {
    return this.model_id
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
    model_id?: string,
    accel: Accel = `cpu`,
  ): Promise<void> {
    if (this.running) return
    this.callback = callback
    this.error_callback = on_error ?? null
    this.language = language.split(`-`)[0]
    this.ai_enabled = ai_enabled
    this.model_id = resolve_model_id(model_id, this.language)
    this.accel = accel

    try {
      // Load model first (may trigger download)
      await get_pipeline(this.model_id, this.accel, this.on_progress)

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
    const new_model_id = resolve_model_id(undefined, new_lang)
    const model_changed = new_model_id !== this.model_id
    this.language = new_lang
    this.ai_enabled = ai_enabled
    this.model_id = new_model_id

    // If the resolved model changed, the pipeline will reload on next transcription
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
      const pipe = await get_pipeline(
        this.model_id ?? resolve_model_id(undefined, this.language),
        this.accel,
        this.on_progress,
      )

      const result = await pipe(audio, {
        language: this.language === `en` ? undefined : this.language,
        task: `transcribe`,
        // Anti-hallucination: Whisper degenerates into endless repeated
        // multilingual fragments on near-silent / very short / noisy clips.
        // Block repeated n-grams and penalize repetition to break the loop.
        no_repeat_ngram_size: 3,
        repetition_penalty: 1.2,
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
