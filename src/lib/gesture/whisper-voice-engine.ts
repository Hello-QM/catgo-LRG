/**
 * Whisper-based voice engine for browsers without Web Speech API.
 *
 * Uses Silero VAD (neural network) for speech detection and OpenAI Whisper API
 * for transcription. Optionally uses RNNoise audio pipeline for noise suppression.
 */

import type { VoiceEvent } from './gesture-types'
import type { VoiceCallback, VoiceErrorCallback } from './voice-engine'
import { match_command_with_score } from './voice-engine'
import { start_vad, stop_vad } from './vad'
import { float32_to_wav } from './audio-utils'
import type { AudioPipeline } from './audio-pipeline'

export class WhisperVoiceEngine {
  private callback: VoiceCallback | null = null
  private error_callback: VoiceErrorCallback | null = null
  private running = false
  private api_key: string
  private language = `en`
  private ai_enabled = false
  private transcribing = false
  private pipeline: AudioPipeline | null = null

  constructor(api_key: string) {
    this.api_key = api_key
  }

  get is_supported(): boolean {
    return typeof navigator !== `undefined`
      && !!navigator.mediaDevices?.getUserMedia
      && !!this.api_key
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
    if (this.running || !this.is_supported) return
    this.callback = callback
    this.error_callback = on_error ?? null
    this.language = language.split(`-`)[0]
    this.ai_enabled = ai_enabled

    try {
      // Optionally create noise suppression pipeline
      let stream: MediaStream | undefined
      if (noise_suppression) {
        try {
          const { create_audio_pipeline } = await import(`./audio-pipeline`)
          this.pipeline = await create_audio_pipeline()
          stream = this.pipeline.stream
          console.info(`[WhisperVoice] Noise suppression pipeline active`)
        } catch (err) {
          console.warn(`[WhisperVoice] Noise suppression failed, using raw mic:`, err)
        }
      }

      // Start Silero VAD — delivers Float32Array at 16kHz on speech end
      await start_vad({
        on_speech_end: (audio: Float32Array) => {
          const wav = float32_to_wav(audio, 16000)
          this.transcribe(wav)
        },
        stream,
      })

      this.running = true
      console.info(`[WhisperVoice] Started (lang=${this.language}, Silero VAD + Whisper API)`)
    } catch (err) {
      console.error(`[WhisperVoice] Failed to start:`, err)
      this.error_callback?.(err instanceof DOMException ? `not-allowed` : `audio-capture`)
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

  // ─── Whisper API Transcription ───────────────────────────────────

  private async transcribe(blob: Blob): Promise<void> {
    if (this.transcribing || blob.size < 1000) return
    this.transcribing = true

    try {
      const form = new FormData()
      form.append(`file`, blob, `voice.wav`)
      form.append(`model`, `whisper-1`)
      if (this.language) form.append(`language`, this.language)

      const res = await fetch(`https://api.openai.com/v1/audio/transcriptions`, {
        method: `POST`,
        headers: { Authorization: `Bearer ${this.api_key}` },
        body: form,
      })

      if (!res.ok) {
        const err_text = await res.text().catch(() => `HTTP ${res.status}`)
        console.error(`[WhisperVoice] API error:`, err_text)
        this.error_callback?.(`network`)
        return
      }

      const data = await res.json()
      const text = data.text?.trim()
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
      console.error(`[WhisperVoice] Transcription failed:`, err)
    } finally {
      this.transcribing = false
    }
  }
}
