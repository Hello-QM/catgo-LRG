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
const LANG_KEY = `catgo-terminal-voice-lang`

export class TerminalVoice {
  recording = $state(false)
  model_status = $state<ModelStatus>(`idle`)
  download_progress = $state(0)
  model_id = $state(DEFAULT_WHISPER_MODEL_ID)
  // BCP-47-ish tag handed to the engine; `en-US` → Whisper auto-detect (English
  // lean), `zh-CN` → forced Chinese, etc. Forcing the language fixes Chinese
  // speech being transcribed as English under auto-detect on short audio.
  language = $state(`en-US`)
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
      const lang = localStorage.getItem(LANG_KEY)
      if (lang) this.language = lang
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

  set_language(lang: string): void {
    this.language = lang
    if (typeof localStorage !== `undefined`) localStorage.setItem(LANG_KEY, lang)
    // Apply live if an engine exists so a mid-session change takes effect.
    ;(this.engine as { set_language?: (l: string) => void } | null)?.set_language?.(lang)
  }

  async toggle(send: (text: string) => void, language?: string): Promise<void> {
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
      await this.engine.start(on_event, language ?? this.language, false, on_error, false, this.model_id)
    } catch {
      this.recording = false
    }
  }

  stop(): void {
    this.recording = false
    this.engine?.stop()
  }
}
