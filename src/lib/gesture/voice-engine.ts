/**
 * Voice command engine using Web Speech API.
 *
 * Continuous speech recognition with command matching in English and Chinese.
 * Supports AI routing: unrecognized commands are forwarded to the AI chat system.
 */

import type { VoiceAction, VoiceEvent } from './gesture-types'
import { fuzzy_match_command } from './fuzzy-matcher'

export type VoiceCallback = (event: VoiceEvent) => void

// ─── Command Dictionary ──────────────────────────────────────────────

export interface CommandEntry {
  patterns: string[]       // Match patterns (lowercase)
  action: VoiceAction
}

export const ELEMENT_MAP: Record<string, string> = {
  // English — canonical names
  hydrogen: `H`, helium: `He`, lithium: `Li`, beryllium: `Be`, boron: `B`,
  carbon: `C`, nitrogen: `N`, oxygen: `O`, fluorine: `F`, neon: `Ne`,
  sodium: `Na`, magnesium: `Mg`, aluminum: `Al`, silicon: `Si`,
  phosphorus: `P`, sulfur: `S`, chlorine: `Cl`, argon: `Ar`,
  potassium: `K`, calcium: `Ca`, titanium: `Ti`, vanadium: `V`,
  chromium: `Cr`, manganese: `Mn`, iron: `Fe`, cobalt: `Co`,
  nickel: `Ni`, copper: `Cu`, zinc: `Zn`, gallium: `Ga`,
  germanium: `Ge`, arsenic: `As`, selenium: `Se`, bromine: `Br`,
  silver: `Ag`, gold: `Au`, platinum: `Pt`, palladium: `Pd`,
  ruthenium: `Ru`, rhodium: `Rh`, iridium: `Ir`, osmium: `Os`,

  // Common accent-induced STT variants & abbreviations
  aluminium: `Al`,    // British/international spelling (STT often outputs this)
  silicone: `Si`,     // Very common mishearing of "silicon"
  sulphur: `S`,       // British spelling
  flourine: `F`,      // Common misspelling in STT
  fosfor: `P`,        // Spanish/Portuguese-influenced
  phosphorous: `P`,   // Common STT error (adjective form)
  cromium: `Cr`,      // R→no-R accent
  platinam: `Pt`,     // Common accent variant
  palladiam: `Pd`,    // Accent variant
  titanum: `Ti`,      // Dropped vowel
  calzium: `Ca`,      // German-influenced
  kalzium: `Ca`,      // German
  natrium: `Na`,      // Latin/European name
  kalium: `K`,        // Latin/European name
  ferrum: `Fe`,       // Latin name (used in many languages)
  cuprum: `Cu`,       // Latin name
  aurum: `Au`,        // Latin name
  argentum: `Ag`,     // Latin name

  // Chinese
  氢: `H`, 氦: `He`, 锂: `Li`, 铍: `Be`, 硼: `B`,
  碳: `C`, 氮: `N`, 氧: `O`, 氟: `F`, 氖: `Ne`,
  钠: `Na`, 镁: `Mg`, 铝: `Al`, 硅: `Si`,
  磷: `P`, 硫: `S`, 氯: `Cl`, 氩: `Ar`,
  钾: `K`, 钙: `Ca`, 钛: `Ti`, 钒: `V`,
  铬: `Cr`, 锰: `Mn`, 铁: `Fe`, 钴: `Co`,
  镍: `Ni`, 铜: `Cu`, 锌: `Zn`, 镓: `Ga`,
  锗: `Ge`, 砷: `As`, 硒: `Se`, 溴: `Br`,
  银: `Ag`, 金: `Au`, 铂: `Pt`, 钯: `Pd`,
  钌: `Ru`, 铑: `Rh`, 铱: `Ir`, 锇: `Os`,
}

export const COMMANDS: CommandEntry[] = [
  // Navigation — English + common accent variants
  // R/L confusion (East Asian L1), TH→T/D (many L1s), vowel shifts
  { patterns: [`rotate left`, `turn left`, `spin left`, `go left`, `左转`], action: { type: `navigate`, command: `rotate_left` } },
  { patterns: [`rotate right`, `turn right`, `spin right`, `go right`, `右转`], action: { type: `navigate`, command: `rotate_right` } },
  { patterns: [`rotate up`, `tilt up`, `spin up`, `look up`, `上转`, `向上`], action: { type: `navigate`, command: `rotate_up` } },
  { patterns: [`rotate down`, `tilt down`, `spin down`, `look down`, `下转`, `向下`], action: { type: `navigate`, command: `rotate_down` } },
  { patterns: [`zoom in`, `closer`, `bigger`, `enlarge`, `放大`], action: { type: `navigate`, command: `zoom_in` } },
  { patterns: [`zoom out`, `farther`, `smaller`, `shrink`, `缩小`], action: { type: `navigate`, command: `zoom_out` } },
  { patterns: [`reset view`, `reset`, `go back`, `start over`, `重置`, `复位`], action: { type: `navigate`, command: `reset_view` } },
  { patterns: [`pan left`, `move left`, `shift left`, `左移`], action: { type: `navigate`, command: `pan_left` } },
  { patterns: [`pan right`, `move right`, `shift right`, `右移`], action: { type: `navigate`, command: `pan_right` } },
  { patterns: [`pan up`, `move up`, `shift up`, `上移`], action: { type: `navigate`, command: `pan_up` } },
  { patterns: [`pan down`, `move down`, `shift down`, `下移`], action: { type: `navigate`, command: `pan_down` } },

  // Selection
  { patterns: [`select all`, `select everything`, `全选`], action: { type: `select`, command: `select_all` } },
  { patterns: [`clear selection`, `deselect`, `unselect`, `select none`, `取消选择`], action: { type: `select`, command: `clear_selection` } },
  { patterns: [`delete`, `remove`, `erase`, `删除`], action: { type: `select`, command: `delete` } },
  { patterns: [`undo`, `go back`, `撤销`], action: { type: `select`, command: `undo` } },

  // Mode control
  { patterns: [`art mode`, `drawing mode`, `draw mode`, `画画模式`, `艺术模式`], action: { type: `mode`, command: `art_on` } },
  { patterns: [`exit art`, `stop drawing`, `stop art`, `退出画画`, `退出艺术`], action: { type: `mode`, command: `art_off` } },
  { patterns: [`gesture off`, `stop gesture`, `disable gesture`, `关闭手势`], action: { type: `mode`, command: `gesture_off` } },
  { patterns: [`voice off`, `stop listening`, `stop voice`, `mute`, `关闭语音`], action: { type: `mode`, command: `voice_off` } },
]

// ─── Command Matching ─────────────────────────────────────────────────

export function match_command(text: string, ai_enabled = false, confidence = 0.5): VoiceAction {
  const result = fuzzy_match_command(text, COMMANDS, ELEMENT_MAP, confidence, ai_enabled)
  return result.action
}

/** Match command and return both action and match score. */
export function match_command_with_score(
  text: string,
  ai_enabled = false,
  confidence = 0.5,
): { action: VoiceAction; match_score: number } {
  return fuzzy_match_command(text, COMMANDS, ELEMENT_MAP, confidence, ai_enabled)
}

// ─── Command Confirmations for TTS ───────────────────────────────────

/** Generate a short spoken confirmation for a recognized command. */
export function command_confirmation(action: VoiceAction, lang = `en-US`): string | null {
  const zh = lang.startsWith(`zh`)

  switch (action.type) {
    case `navigate`:
      switch (action.command) {
        case `rotate_left`: return zh ? `左转` : `Rotated left`
        case `rotate_right`: return zh ? `右转` : `Rotated right`
        case `rotate_up`: return zh ? `上转` : `Tilted up`
        case `rotate_down`: return zh ? `下转` : `Tilted down`
        case `zoom_in`: return zh ? `放大` : `Zoomed in`
        case `zoom_out`: return zh ? `缩小` : `Zoomed out`
        case `reset_view`: return zh ? `视角已重置` : `View reset`
        case `pan_left`: return zh ? `左移` : `Panned left`
        case `pan_right`: return zh ? `右移` : `Panned right`
        case `pan_up`: return zh ? `上移` : `Panned up`
        case `pan_down`: return zh ? `下移` : `Panned down`
        default: return null
      }
    case `select`:
      switch (action.command) {
        case `select_all`: return zh ? `已全选` : `All selected`
        case `clear_selection`: return zh ? `已取消选择` : `Selection cleared`
        case `delete`: return zh ? `已删除` : `Deleted`
        case `undo`: return zh ? `已撤销` : `Undone`
        default: return null
      }
    case `element`:
      return zh ? `已选择 ${action.symbol}` : `Selected ${action.symbol}`
    case `mode`:
      switch (action.command) {
        case `art_on`: return zh ? `艺术模式已开启` : `Art mode on`
        case `art_off`: return zh ? `艺术模式已关闭` : `Art mode off`
        default: return null
      }
    default:
      return null
  }
}

// ─── Voice Engine ─────────────────────────────────────────────────────

export type VoiceErrorCallback = (error: string) => void

export class VoiceEngine {
  private recognition: any = null  // SpeechRecognition instance
  private callback: VoiceCallback | null = null
  private error_callback: VoiceErrorCallback | null = null
  private running = false

  get is_supported(): boolean {
    return typeof window !== `undefined` && (`SpeechRecognition` in window || `webkitSpeechRecognition` in window)
  }

  get is_running(): boolean {
    return this.running
  }

  start(callback: VoiceCallback, language = `en-US`, ai_enabled = false, on_error?: VoiceErrorCallback): void {
    if (this.running || !this.is_supported) return
    this.callback = callback
    this.error_callback = on_error ?? null

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    this.recognition = new SpeechRecognition()
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.lang = language
    this.recognition.maxAlternatives = 1

    this.recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const text = result[0].transcript
        const confidence = result[0].confidence || 0.5
        const is_final = result.isFinal

        // Only route to AI on final results to avoid partial query spam
        const { action, match_score } = match_command_with_score(text, is_final && ai_enabled, confidence)

        this.callback?.({
          action,
          raw_text: text,
          confidence,
          is_final,
          match_score,
          timestamp: performance.now(),
        })
      }
    }

    this.recognition.onerror = (event: any) => {
      // 'no-speech' and 'aborted' are non-fatal
      if (event.error !== `no-speech` && event.error !== `aborted`) {
        console.warn(`[VoiceEngine] Error:`, event.error)
        this.error_callback?.(event.error)
      }
    }

    // Auto-restart on end (browser may stop after silence)
    this.recognition.onend = () => {
      if (this.running) {
        try { this.recognition?.start() } catch { /* already started */ }
      }
    }

    this.running = true
    this.recognition.start()
  }

  stop(): void {
    this.running = false
    if (this.recognition) {
      try { this.recognition.stop() } catch { /* ignore */ }
      this.recognition = null
    }
    this.callback = null
  }

  /** Change recognition language on the fly. */
  set_language(lang: string, ai_enabled = false): void {
    if (!this.recognition) return
    const cb = this.callback
    const was_running = this.running
    this.stop()
    if (was_running && cb) {
      this.start(cb, lang, ai_enabled)
    }
  }
}
