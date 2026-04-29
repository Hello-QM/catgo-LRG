/**
 * Text-to-speech engine using Web Speech Synthesis API.
 *
 * Speaks AI responses and command confirmations back to the user.
 * Supports English and Chinese with automatic voice selection.
 */

export interface TTSConfig {
  enabled: boolean
  volume: number    // 0.0 - 1.0
  rate: number      // 0.5 - 2.0
  pitch: number     // 0.0 - 2.0
  language: string  // 'en-US' | 'zh-CN'
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  enabled: true,
  volume: 0.8,
  rate: 1.0,
  pitch: 1.0,
  language: `en-US`,
}

export type TTSPriority = `low` | `normal` | `high`

export class TTSEngine {
  private synth: SpeechSynthesis | null = null
  private voice_cache: Map<string, SpeechSynthesisVoice> = new Map()
  private selected_voice: SpeechSynthesisVoice | null = null
  private config: TTSConfig
  private queue: Array<{ text: string; priority: TTSPriority }> = []
  private _speaking = false

  constructor(config: TTSConfig = DEFAULT_TTS_CONFIG) {
    this.config = { ...config }
    if (typeof window !== `undefined` && `speechSynthesis` in window) {
      this.synth = window.speechSynthesis
      this.synth.onvoiceschanged = () => this.cache_voices()
      this.cache_voices()
    }
  }

  get is_supported(): boolean {
    return this.synth !== null
  }

  get is_speaking(): boolean {
    return this.synth?.speaking ?? false
  }

  update_config(updates: Partial<TTSConfig>): void {
    Object.assign(this.config, updates)
  }

  /** Override the auto-selected voice. Pass null to revert to auto. */
  set_voice(voice: SpeechSynthesisVoice | null): void {
    this.selected_voice = voice
  }

  /** Set voice by name (for restoring from saved config). */
  set_voice_by_name(name: string): void {
    if (!name || !this.synth) {
      this.selected_voice = null
      return
    }
    const match = this.synth.getVoices().find(v => v.name === name)
    this.selected_voice = match ?? null
  }

  /** Get all available synthesis voices (for the settings UI). */
  get_voices(): SpeechSynthesisVoice[] {
    return this.synth?.getVoices() ?? []
  }

  private static readonly MAX_QUEUE = 8

  /** Speak text with given priority. High priority interrupts current speech. */
  speak(text: string, priority: TTSPriority = `normal`): void {
    if (!this.synth || !this.config.enabled || !text.trim()) return

    if (priority === `high`) {
      this.synth.cancel()
      this.queue = []
      this.speak_now(text)
    } else if (priority === `low` && this._speaking) {
      // Drop low-priority if already speaking
      return
    } else {
      // Cap queue size — drop oldest low-priority items when full
      if (this.queue.length >= TTSEngine.MAX_QUEUE) {
        const low_idx = this.queue.findIndex(q => q.priority === `low`)
        if (low_idx >= 0) {
          this.queue.splice(low_idx, 1)
        } else {
          this.queue.shift()
        }
      }
      this.queue.push({ text, priority })
      if (!this._speaking) this.process_queue()
    }
  }

  /** Stop all speech and clear queue. */
  stop(): void {
    if (!this.synth) return
    this.synth.cancel()
    this.queue = []
    this._speaking = false
  }

  private speak_now(text: string): void {
    if (!this.synth) return

    // Truncate very long texts
    const truncated = text.length > 300
      ? text.slice(0, 297) + `...`
      : text

    const utterance = new SpeechSynthesisUtterance(truncated)
    utterance.volume = this.config.volume
    utterance.rate = this.config.rate
    utterance.pitch = this.config.pitch
    utterance.lang = this.config.language

    const voice = this.selected_voice ?? this.voice_cache.get(this.config.language)
    if (voice) utterance.voice = voice

    utterance.onend = () => {
      this._speaking = false
      this.process_queue()
    }
    utterance.onerror = () => {
      this._speaking = false
      this.process_queue()
    }

    this._speaking = true
    this.synth.speak(utterance)
  }

  private process_queue(): void {
    if (this.queue.length === 0) return
    const next = this.queue.shift()!
    this.speak_now(next.text)
  }

  private cache_voices(): void {
    if (!this.synth) return
    const voices = this.synth.getVoices()

    // Prefer voices matching exact language
    for (const lang of [`en-US`, `zh-CN`, `en-GB`, `zh-TW`]) {
      const exact = voices.find(v => v.lang === lang)
      if (exact) this.voice_cache.set(lang, exact)
    }
    // Fallback: prefix matching
    for (const prefix of [`en`, `zh`]) {
      const key = prefix === `en` ? `en-US` : `zh-CN`
      if (!this.voice_cache.has(key)) {
        const match = voices.find(v => v.lang.startsWith(prefix))
        if (match) this.voice_cache.set(key, match)
      }
    }
  }
}
