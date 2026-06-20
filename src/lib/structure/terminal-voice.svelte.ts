/**
 * Per-terminal voice-dictation controller.
 *
 * Bridges a local STT engine (LocalWhisperEngine by default) to the terminal:
 * only FINAL transcripts are forwarded to `send`, which the TerminalPanel wires
 * to panel_send_keys (no Enter). The engine is injected via a factory so this is
 * unit-testable without a microphone. Desktop only.
 */

import { LocalWhisperEngine, type ModelStatus } from '$lib/gesture/local-whisper'
import { backend_stt_available, BackendWhisperEngine } from '$lib/gesture/backend-whisper'
import { DEFAULT_WHISPER_MODEL_ID } from '$lib/gesture/whisper-models'
import type { VoiceEvent } from '$lib/gesture/gesture-types'

export type Accel = `cpu` | `gpu`

export interface VoiceEngineLike {
  readonly is_supported: boolean
  start(
    cb: (e: VoiceEvent) => void,
    language?: string,
    ai_enabled?: boolean,
    on_error?: (err: string) => void,
    noise_suppression?: boolean,
    model_id?: string,
    accel?: Accel,
  ): void | Promise<void>
  stop(): void
}

const STORAGE_KEY = `catgo-terminal-voice-model`
const LANG_KEY = `catgo-terminal-voice-lang`
const ACCEL_KEY = `catgo-terminal-voice-accel`

// Only one terminal voice may record at a time. There is a single microphone and
// the VAD + Whisper pipeline is a shared singleton; enabling voice on two panes
// otherwise spins up two MicVAD instances that BOTH transcribe the same speech
// and each inject keystrokes → duplicated input. Starting voice on any pane stops
// it on whichever pane held it before.
let active_voice: TerminalVoice | null = null

export class TerminalVoice {
  recording = $state(false)
  model_status = $state<ModelStatus>(`idle`)
  download_progress = $state(0)
  model_id = $state(DEFAULT_WHISPER_MODEL_ID)
  // BCP-47-ish tag handed to the engine; `en-US` → Whisper auto-detect (English
  // lean), `zh-CN` → forced Chinese, etc. Forcing the language fixes Chinese
  // speech being transcribed as English under auto-detect on short audio.
  language = $state(`en-US`)
  // `cpu` = wasm/q8 (correct everywhere). `gpu` = WebGPU/fp16 (faster where
  // WebGPU is sound; opt-in because some integrated GPUs misbehave).
  accel = $state<Accel>(`cpu`)
  error = $state<string | null>(null)

  // Injected factory (tests / explicit override). When absent, the engine is
  // chosen at start time: native backend STT when reachable, else in-browser WASM.
  private injected_make?: () => VoiceEngineLike
  private engine: VoiceEngineLike | null = null
  // Lazy Traditional→Simplified converter. Whisper's multilingual model emits
  // Traditional Chinese for Mandarin; convert to Simplified for zh-CN. Loaded
  // on first Chinese utterance so non-Chinese use pays nothing.
  private t2s: ((s: string) => string) | null = null

  private async ensure_t2s(): Promise<(s: string) => string> {
    if (this.t2s) return this.t2s
    const OpenCC: any = await import(`opencc-js`)
    this.t2s = OpenCC.Converter({ from: `t`, to: `cn` })
    return this.t2s!
  }

  constructor(make_engine?: () => VoiceEngineLike) {
    this.injected_make = make_engine
    if (typeof localStorage !== `undefined`) {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) this.model_id = saved
      const lang = localStorage.getItem(LANG_KEY)
      if (lang) this.language = lang
      const accel = localStorage.getItem(ACCEL_KEY)
      if (accel === `cpu` || accel === `gpu`) this.accel = accel
    }
  }

  get is_supported(): boolean {
    if (this.injected_make) {
      if (!this.engine) this.engine = this.injected_make()
      return this.engine.is_supported
    }
    // Both real engines only need a microphone — don't instantiate one (and
    // commit to backend-vs-WASM) just to answer the button's disabled state.
    return typeof navigator !== `undefined`
      && !!navigator.mediaDevices?.getUserMedia
  }

  /** Pick the STT engine: native backend (faster-whisper) when the server is
   *  reachable, else the in-browser WASM engine. Injected factory wins (tests). */
  private async create_engine(): Promise<VoiceEngineLike> {
    if (this.injected_make) return this.injected_make()
    if (await backend_stt_available()) return new BackendWhisperEngine()
    return new LocalWhisperEngine((status, progress) => {
      this.model_status = status
      if (typeof progress === `number`) this.download_progress = progress
    })
  }

  set_model(id: string): void {
    this.model_id = id
    if (typeof localStorage !== `undefined`) localStorage.setItem(STORAGE_KEY, id)
    // Apply live so a mid-session model switch takes effect on the next utterance
    // (the backend engine reads model_id per request; no restart needed).
    ;(this.engine as { set_model?: (id: string) => void } | null)?.set_model?.(id)
  }

  set_language(lang: string): void {
    this.language = lang
    if (typeof localStorage !== `undefined`) localStorage.setItem(LANG_KEY, lang)
    // Apply live if an engine exists so a mid-session change takes effect.
    ;(this.engine as { set_language?: (l: string) => void } | null)?.set_language?.(lang)
  }

  set_accel(accel: Accel): void {
    this.accel = accel
    if (typeof localStorage !== `undefined`) localStorage.setItem(ACCEL_KEY, accel)
    // Takes effect on the next start() (pipeline reloads for the new backend).
  }

  async toggle(send: (text: string) => void, language?: string): Promise<void> {
    if (this.recording) {
      this.stop()
      return
    }
    this.error = null
    if (!this.engine) this.engine = await this.create_engine()

    const on_event = async (e: VoiceEvent) => {
      if (!e.is_final) return
      let text = e.raw_text.trim()
      if (!text) return
      if (this.language.startsWith(`zh`)) {
        try {
          const conv = await this.ensure_t2s()
          text = conv(text)
        } catch { /* fall back to raw (Traditional) text */ }
      }
      send(`${text} `)
    }
    const on_error = (err: string) => {
      this.error = err
      // Fully stop — clearing only `recording` would leave the VAD/mic running,
      // so it keeps transcribing and injecting with the button visibly off.
      this.stop()
    }

    // Single global voice: stop whichever pane was recording before taking over.
    if (active_voice && active_voice !== this) active_voice.stop()
    active_voice = this

    this.recording = true
    try {
      await this.engine.start(
        on_event,
        language ?? this.language,
        false,
        on_error,
        false,
        this.model_id,
        this.accel,
      )
    } catch {
      this.stop() // tear down any partially-started VAD/mic
    }
  }

  stop(): void {
    this.recording = false
    this.engine?.stop()
    if (active_voice === this) active_voice = null
  }
}
