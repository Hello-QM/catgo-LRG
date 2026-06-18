/**
 * Per-terminal voice-dictation controller.
 *
 * Bridges a local STT engine (LocalWhisperEngine by default) to the terminal:
 * only FINAL transcripts are forwarded to `send`, which the TerminalPanel wires
 * to panel_send_keys (no Enter). The engine is injected via a factory so this is
 * unit-testable without a microphone. Desktop only.
 */

import { LocalWhisperEngine, type ModelStatus } from '$lib/gesture/local-whisper'
import { DEFAULT_WHISPER_MODEL_ID } from '$lib/gesture/whisper-models'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

export interface VoiceEngineLike {
  readonly is_supported: boolean
  start(
    cb: (e: VoiceEvent) => void,
    language?: string,
    ai_enabled?: boolean,
    on_error?: (err: string) => void,
    noise_suppression?: boolean,
    model_id?: string,
  ): void | Promise<void>
  stop(): void
}

const STORAGE_KEY = `catgo-terminal-voice-model`

export class TerminalVoice {
  recording = $state(false)
  model_status = $state<ModelStatus>(`idle`)
  download_progress = $state(0)
  model_id = $state(DEFAULT_WHISPER_MODEL_ID)
  error = $state<string | null>(null)

  private make_engine: () => VoiceEngineLike
  private engine: VoiceEngineLike | null = null

  constructor(make_engine?: () => VoiceEngineLike) {
    this.make_engine = make_engine
      ?? (() =>
        new LocalWhisperEngine((status, progress) => {
          this.model_status = status
          if (typeof progress === `number`) this.download_progress = progress
        }))
    if (typeof localStorage !== `undefined`) {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) this.model_id = saved
    }
  }

  get is_supported(): boolean {
    if (!this.engine) this.engine = this.make_engine()
    return this.engine.is_supported
  }

  set_model(id: string): void {
    this.model_id = id
    if (typeof localStorage !== `undefined`) localStorage.setItem(STORAGE_KEY, id)
  }

  async toggle(send: (text: string) => void, language = `en-US`): Promise<void> {
    if (this.recording) {
      this.stop()
      return
    }
    this.error = null
    if (!this.engine) this.engine = this.make_engine()

    const on_event = (e: VoiceEvent) => {
      if (!e.is_final) return
      const text = e.raw_text.trim()
      if (!text) return
      send(`${text} `)
    }
    const on_error = (err: string) => {
      this.error = err
      this.recording = false
    }

    this.recording = true
    try {
      await this.engine.start(on_event, language, false, on_error, false, this.model_id)
    } catch {
      this.recording = false
    }
  }

  stop(): void {
    this.recording = false
    this.engine?.stop()
  }
}
