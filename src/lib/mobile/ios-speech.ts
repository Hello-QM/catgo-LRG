/**
 * Thin JS bridge to the native iOS speech-to-text plugin
 * (src-tauri/plugins/tauri-plugin-ios-speech).
 *
 * WebKit has no Web Speech API, so the mobile chat mic does NOT use
 * `webkitSpeechRecognition` (that path lives in the desktop ChatPane and is
 * WebKit-dead). Instead we invoke the native plugin, which drives
 * SFSpeechRecognizer on-device and streams transcripts back as plugin events.
 *
 * Lifecycle: request_permission() once → start_listening() → consume `partial`
 * events (live textarea updates) → a `final` event (or stop_listening()) ends
 * the turn. Always call the unlisten fns returned by on_transcript() on cleanup.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core'

const PLUGIN = `ios-speech`

interface PermissionResponse {
  granted: boolean
}
interface LocalesResponse {
  locales: string[]
}
interface TranscriptEvent {
  text: string
}
interface SpeechErrorEvent {
  message: string
}

/** Prompt for mic + speech authorization. Resolves true only if BOTH granted. */
export async function request_speech_permission(): Promise<boolean> {
  const res = await invoke<PermissionResponse>(`plugin:${PLUGIN}|request_permission`)
  return res.granted
}

/** BCP-47 locales this device can recognize (accents + Chinese variants etc.),
 *  sorted by display name. Only these are safe to pass to start_listening(). */
export async function supported_locales(): Promise<string[]> {
  const res = await invoke<LocalesResponse>(`plugin:${PLUGIN}|supported_locales`)
  return [...res.locales].sort((a, b) => locale_label(a).localeCompare(locale_label(b)))
}

// SFSpeechRecognizer collapses some languages onto a region code that
// Intl.DisplayNames labels only by the macro-language — e.g. zh-HK is really
// Cantonese, not "Chinese (Hong Kong)". Override those few for an honest label.
const SPECIAL_LABELS: Record<string, string> = {
  'zh-HK': `粤语 (香港)`,
  'yue-CN': `粤语 (中国)`,
}

/** Human label for a BCP-47 code, in the locale's OWN language so a Chinese
 *  speaker sees 中文, e.g. "en-GB"→"English (United Kingdom)", "zh-TW"→"中文 (台灣)".
 *  Falls back to the raw code if Intl.DisplayNames can't resolve it. */
export function locale_label(code: string): string {
  if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code]
  const [lang, region] = code.split(`-`)
  try {
    const langName = new Intl.DisplayNames([code], { type: `language` }).of(lang)
    if (!langName) return code
    if (!region) return langName
    const regionName = new Intl.DisplayNames([code], { type: `region` }).of(region)
    return regionName ? `${langName} (${regionName})` : langName
  } catch {
    return code
  }
}

/** Compact pill label, e.g. "en-US" → "EN-US". */
export function locale_short(code: string): string {
  return code.toUpperCase()
}

const STORAGE_KEY = `catgo.voice_locale`

/** Remembered voice locale, or `''` (= use the device default). */
export function load_voice_locale(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ``
  } catch {
    return ``
  }
}

export function save_voice_locale(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    /* storage unavailable (private mode) — selection just won't persist */
  }
}

/** Begin streaming. `locale` is BCP-47 (e.g. "en-US"); omit for device default. */
export async function start_listening(locale?: string): Promise<void> {
  await invoke(`plugin:${PLUGIN}|start_listening`, { locale })
}

/** End the session; the recognizer emits one last `final` with the full text. */
export async function stop_listening(): Promise<void> {
  await invoke(`plugin:${PLUGIN}|stop_listening`)
}

export interface TranscriptHandlers {
  /** Fired repeatedly as you speak — the best-guess transcript so far. */
  on_partial?: (text: string) => void
  /** Fired once when recognition settles (silence, or stop_listening()). */
  on_final?: (text: string) => void
  /** Fired on recognizer/audio failure; the session is already torn down. */
  on_error?: (message: string) => void
}

// Register the native event listeners ONCE for the app's lifetime, and route
// every event to whatever handler is currently active. We deliberately NEVER
// unregister: firing `remove_listener` invokes while Svelte tears down the chat
// (on minimize) wedged the WKWebView main thread and froze the app. Swapping a
// plain module reference instead is free — no IPC on unmount.
let listeners_ready: Promise<void> | null = null
let current: TranscriptHandlers | null = null

function ensure_listeners(): Promise<void> {
  if (!listeners_ready) {
    listeners_ready = (async () => {
      await addPluginListener<TranscriptEvent>(
        PLUGIN,
        `partial`,
        (e) => current?.on_partial?.(e.text),
      )
      await addPluginListener<TranscriptEvent>(
        PLUGIN,
        `final`,
        (e) => current?.on_final?.(e.text),
      )
      await addPluginListener<SpeechErrorEvent>(
        PLUGIN,
        `error`,
        (e) => current?.on_error?.(e.message),
      )
    })().catch((err) => {
      // Don't cache a failure — null it so the next mic tap retries instead of
      // rejecting forever (which would break voice input for the whole session).
      listeners_ready = null
      throw err
    })
  }
  return listeners_ready
}

/**
 * Make `h` the active transcript handler. Returns a cleanup that just clears the
 * handler reference (a plain assignment — NO native call, so it is safe to run
 * during a component unmount). The native listeners stay registered for the app.
 */
export async function on_transcript(h: TranscriptHandlers): Promise<() => void> {
  await ensure_listeners()
  current = h
  return () => {
    if (current === h) current = null
  }
}
