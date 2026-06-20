/**
 * Backend Whisper STT engine — transcribes via the native faster-whisper
 * endpoint instead of running Whisper in the webview.
 *
 * WebKit webviews (WebKitGTK on Linux, WKWebView on macOS/iOS — every Tauri
 * webview except Windows' Chromium WebView2) leak ~0.8 GB of unreclaimable WASM
 * memory per inference with the in-browser engine, OOM-killing the renderer
 * (blank window). This engine keeps only the tiny Silero VAD in the browser to
 * segment speech, then POSTs each finished 16 kHz float32 segment to
 * `/api/stt/transcribe`, where native CTranslate2 runs it (CPU int8 or CUDA) at
 * no webview memory cost. Drop-in for LocalWhisperEngine (same VoiceEngineLike
 * shape); language post-processing (zh Traditional→Simplified) stays in
 * TerminalVoice, so this engine only forwards raw recognized text.
 */

import type { VoiceCallback, VoiceErrorCallback } from './voice-engine'
import { match_command_with_score } from './voice-engine'
import { start_vad, stop_vad } from './vad'
import type { AudioPipeline } from './audio-pipeline'
import { API_BASE } from '$lib/api/config'

export type Accel = `cpu` | `gpu`

/** Probe the native STT endpoint. Cached so each pane's engine doesn't re-hit
 *  it. Returns false when the backend is absent (static web) or the dependency
 *  is missing, so the caller can fall back to the in-browser WASM engine. */
let _availability: Promise<boolean> | null = null
export function backend_stt_available(force = false): Promise<boolean> {
  if (force) _availability = null
  if (!_availability) {
    _availability = (async () => {
      try {
        const resp = await fetch(`${API_BASE}/stt/health`, { method: `GET` })
        if (!resp.ok) return false
        const data = await resp.json()
        return data?.available === true
      } catch {
        return false
      }
    })()
  }
  return _availability
}

export class BackendWhisperEngine {
  private callback: VoiceCallback | null = null
  private error_callback: VoiceErrorCallback | null = null
  private running = false
  private language = `en`
  private ai_enabled = false
  private model_id = `base`
  private transcribing = false
  private pipeline: AudioPipeline | null = null

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
    _accel: Accel = `cpu`, // backend picks its own device (CUDA/CPU)
  ): Promise<void> {
    if (this.running) return
    this.callback = callback
    this.error_callback = on_error ?? null
    this.language = language.split(`-`)[0]
    this.ai_enabled = ai_enabled
    this.model_id = model_id ?? `base`

    try {
      let stream: MediaStream | undefined
      if (noise_suppression) {
        try {
          const { create_audio_pipeline } = await import(`./audio-pipeline`)
          this.pipeline = await create_audio_pipeline()
          stream = this.pipeline.stream
        } catch (err) {
          console.warn(`[BackendWhisper] Noise suppression failed, using raw mic:`, err)
        }
      }

      await start_vad({
        on_speech_end: (audio: Float32Array) => {
          this.transcribe_remote(audio)
        },
        stream,
      })

      this.running = true
      console.info(`[BackendWhisper] Started (lang=${this.language}, native backend STT)`)
    } catch (err) {
      console.error(`[BackendWhisper] Failed to start:`, err)
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
    this.language = lang.split(`-`)[0]
    this.ai_enabled = ai_enabled
  }

  set_model(model_id: string): void {
    this.model_id = model_id
  }

  private async transcribe_remote(audio: Float32Array): Promise<void> {
    // Serialize: drop overlapping segments while one request is in flight, so a
    // slow backend can't queue a backlog of POSTs.
    if (this.transcribing) return
    this.transcribing = true

    try {
      // Copy into a fresh (non-shared) ArrayBuffer: under cross-origin isolation
      // the VAD's buffer may be a SharedArrayBuffer, which fetch refuses as a body.
      const pcm = new Float32Array(audio)
      const lang = encodeURIComponent(this.language || `en`)
      const model = encodeURIComponent(this.model_id || `base`)
      const resp = await fetch(
        `${API_BASE}/stt/transcribe?language=${lang}&model=${model}`,
        {
          method: `POST`,
          headers: { 'Content-Type': `application/octet-stream` },
          body: pcm.buffer,
        },
      )
      if (!resp.ok) {
        console.error(`[BackendWhisper] transcribe failed: HTTP ${resp.status}`)
        return
      }
      const data = await resp.json()
      const text = (data?.text ?? ``).trim()
      if (!text) return

      const confidence = 0.9
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
      console.error(`[BackendWhisper] Transcription failed:`, err)
    } finally {
      this.transcribing = false
    }
  }
}
