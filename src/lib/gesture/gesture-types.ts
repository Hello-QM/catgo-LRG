/**
 * Type definitions for the gesture & voice control system.
 */

// ─── Gesture Classification ───────────────────────────────────────────

export type GestureType =
  | `open_palm`   // All fingers extended — rotate / pan
  | `fist`        // All fingers closed — grab / hold
  | `pinch`       // Thumb + index close — zoom / place atom
  | `point`       // Index finger extended — select / hover
  | `peace`       // Index + middle extended — reserved
  | `thumbs_up`   // Confirmation
  | `none`        // No clear gesture detected

export type HandSide = `left` | `right`

/** Normalized 3D landmark from MediaPipe (values 0-1) */
export interface Landmark {
  x: number
  y: number
  z: number
}

/** State of a single detected hand per frame */
export interface HandState {
  side: HandSide
  gesture: GestureType
  prev_gesture: GestureType
  landmarks: Landmark[]          // 21 MediaPipe hand landmarks
  center: { x: number; y: number }  // Palm center (normalized 0-1, mirrored)
  pinch_distance: number         // Thumb tip ↔ index tip distance (normalized)
  gesture_strength: number       // Strength of active gesture 0-1
  confidence: number             // Detection confidence 0-1
}

/** Emitted every frame by the gesture system */
export interface GestureFrame {
  hands: HandState[]
  timestamp: number
}

// ─── High-Level Gesture Events ────────────────────────────────────────

export type GestureAction =
  | `rotate`
  | `zoom`
  | `pan`
  | `select`
  | `hover`
  | `place_atom`
  | `art_draw`
  | `art_end`
  | `confirm`
  | `idle`

export interface GestureEvent {
  action: GestureAction
  /** Movement delta since last frame (normalized 0-1) */
  delta: { x: number; y: number }
  /** Pinch distance change since last frame */
  pinch_delta: number
  /** Screen-space position of the active hand (pixels) */
  screen_pos: { x: number; y: number }
  /** Raw hand states this frame */
  hands: HandState[]
  timestamp: number
}

// ─── Voice Commands ───────────────────────────────────────────────────

export type VoiceAction =
  | { type: `navigate`; command: `rotate_left` | `rotate_right` | `rotate_up` | `rotate_down` | `zoom_in` | `zoom_out` | `reset_view` | `pan_left` | `pan_right` | `pan_up` | `pan_down` }
  | { type: `select`; command: `select_all` | `clear_selection` | `delete` | `undo` }
  | { type: `element`; symbol: string }
  | { type: `mode`; command: `art_on` | `art_off` | `gesture_off` | `voice_off` }
  | { type: `ai_query`; raw: string }
  | { type: `unknown`; raw: string }

export interface VoiceEvent {
  action: VoiceAction
  raw_text: string
  confidence: number
  is_final: boolean
  timestamp: number
  match_score?: number
}

// ─── MediaPipe Landmark Indices ───────────────────────────────────────

export const LANDMARK = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const

/** Connections between landmarks for skeleton drawing */
export const HAND_CONNECTIONS: [number, number][] = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17],
]

// ─── Configuration ────────────────────────────────────────────────────

export type VoiceMethod = `auto` | `web_speech` | `whisper`
export type WhisperMode = `local` | `cloud` | `auto`

export interface GestureConfig {
  enabled: boolean
  show_webcam_pip: boolean
  show_skeleton: boolean
  sensitivity: number          // 0.1 - 3.0
  voice_enabled: boolean
  voice_language: string       // 'en-US' | 'zh-CN' | etc.
  voice_method: VoiceMethod    // STT engine selection
  whisper_api_key: string      // OpenAI API key for Whisper fallback
  art_trail_spacing: number    // Angstroms between trail atoms
  neon_color: string           // Primary neon color hex
  tts_enabled: boolean         // Text-to-speech voice response
  tts_volume: number           // 0.0 - 1.0
  tts_rate: number             // 0.5 - 2.0
  tts_voice: string            // SpeechSynthesisVoice.name or '' for auto
  voice_ai_enabled: boolean    // Route unknown commands to AI chat
  noise_suppression: boolean   // RNNoise audio noise suppression
  whisper_mode: WhisperMode    // Local (Transformers.js) vs Cloud (OpenAI API)
}

/** Detect user's preferred language for voice recognition. */
function detect_voice_language(): string {
  if (typeof navigator === `undefined`) return `en-US`
  const lang = navigator.language || (navigator as any).userLanguage || `en-US`
  // Map common Chinese locales to zh-CN
  if (lang.startsWith(`zh`)) return `zh-CN`
  // Keep full locale for others (en-US, ja-JP, ko-KR, etc.)
  return lang
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  enabled: false,
  show_webcam_pip: true,
  show_skeleton: true,
  sensitivity: 1.0,
  voice_enabled: true,
  voice_language: detect_voice_language(),
  voice_method: `auto`,
  whisper_api_key: ``,
  art_trail_spacing: 2.0,
  neon_color: `#00fff7`,
  tts_enabled: true,
  tts_volume: 0.8,
  tts_rate: 1.0,
  tts_voice: ``,
  voice_ai_enabled: true,
  noise_suppression: true,
  whisper_mode: `auto`,
}
