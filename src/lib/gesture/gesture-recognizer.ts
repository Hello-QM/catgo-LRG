/**
 * Gesture recognition from MediaPipe hand landmarks.
 *
 * Classifies 21 landmarks into discrete gestures (open_palm, fist, pinch, point, etc.)
 * with continuous gesture strengths, hysteresis thresholds, minimum hold time,
 * and temporal smoothing to prevent jitter.
 */

import { LANDMARK, type GestureType, type Landmark } from './gesture-types'

// ─── Geometry Helpers ─────────────────────────────────────────────────

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Ratio of tip-to-wrist distance vs pip-to-wrist distance (>1 = extended). */
function finger_extension_ratio(landmarks: Landmark[], tip: number, pip: number): number {
  const wrist = landmarks[LANDMARK.WRIST]
  const tip_dist = dist(landmarks[tip], wrist)
  const pip_dist = dist(landmarks[pip], wrist)
  if (pip_dist < 1e-6) return 0
  return tip_dist / pip_dist
}

/** Ratio of mcp-to-wrist distance vs tip-to-wrist distance (>1 = curled). */
function finger_curl_ratio(landmarks: Landmark[], tip: number, mcp: number): number {
  const wrist = landmarks[LANDMARK.WRIST]
  const tip_dist = dist(landmarks[tip], wrist)
  const mcp_dist = dist(landmarks[mcp], wrist)
  if (mcp_dist < 1e-6) return 0
  return mcp_dist / tip_dist
}

// ─── Gesture Strengths ───────────────────────────────────────────────

type GestureStrengths = Record<GestureType, number>

function compute_gesture_strengths(landmarks: Landmark[]): GestureStrengths {
  const strengths: GestureStrengths = {
    pinch: 0,
    open_palm: 0,
    fist: 0,
    point: 0,
    peace: 0,
    thumbs_up: 0,
    none: 0,
  }

  if (landmarks.length < 21) {
    strengths.none = 1
    return strengths
  }

  // ── Wrist-relative normalization ──────────────────────────────────
  // Normalize landmarks relative to wrist position and palm size so that
  // hand distance from camera doesn't affect gesture sensitivity.
  const wrist = landmarks[LANDMARK.WRIST]
  const palm_size = dist(wrist, landmarks[LANDMARK.MIDDLE_MCP])
  const scale = Math.max(palm_size, 1e-6)

  const normalized: Landmark[] = landmarks.map(lm => ({
    x: (lm.x - wrist.x) / scale,
    y: (lm.y - wrist.y) / scale,
    z: (lm.z - wrist.z) / scale,
  }))

  // Finger extension ratios (>1 = extended) — dimensionless, scale-invariant
  const index_ext = finger_extension_ratio(normalized, LANDMARK.INDEX_TIP, LANDMARK.INDEX_PIP)
  const middle_ext = finger_extension_ratio(normalized, LANDMARK.MIDDLE_TIP, LANDMARK.MIDDLE_PIP)
  const ring_ext = finger_extension_ratio(normalized, LANDMARK.RING_TIP, LANDMARK.RING_PIP)
  const pinky_ext = finger_extension_ratio(normalized, LANDMARK.PINKY_TIP, LANDMARK.PINKY_PIP)

  // Finger curl ratios (>1 = curled) — dimensionless, scale-invariant
  const index_curl = finger_curl_ratio(normalized, LANDMARK.INDEX_TIP, LANDMARK.INDEX_MCP)
  const middle_curl = finger_curl_ratio(normalized, LANDMARK.MIDDLE_TIP, LANDMARK.MIDDLE_MCP)
  const ring_curl = finger_curl_ratio(normalized, LANDMARK.RING_TIP, LANDMARK.RING_MCP)
  const pinky_curl = finger_curl_ratio(normalized, LANDMARK.PINKY_TIP, LANDMARK.PINKY_MCP)

  // Thumb
  const thumb_tip = normalized[LANDMARK.THUMB_TIP]
  const thumb_ip = normalized[LANDMARK.THUMB_IP]
  const thumb_mcp = normalized[LANDMARK.THUMB_MCP]
  const thumb_ext_ratio = dist(thumb_tip, thumb_mcp) / (dist(thumb_ip, thumb_mcp) + 1e-6)

  // Convert ratios to 0-1 scores: extension -> how extended (0=curled, 1=extended)
  // Extension ratio ~0.95 = threshold, map [0.8, 1.2] -> [0, 1]
  const ext_score = (r: number) => clamp01((r - 0.8) / 0.4)
  // Curl ratio ~1.05 = threshold, map [0.85, 1.2] -> [0, 1]
  const curl_score = (r: number) => clamp01((r - 0.85) / 0.35)

  const i_ext_s = ext_score(index_ext)
  const m_ext_s = ext_score(middle_ext)
  const r_ext_s = ext_score(ring_ext)
  const p_ext_s = ext_score(pinky_ext)

  const i_curl_s = curl_score(index_curl)
  const m_curl_s = curl_score(middle_curl)
  const r_curl_s = curl_score(ring_curl)
  const p_curl_s = curl_score(pinky_curl)

  // ── Pinch: thumb tip close to index tip (normalized distance, threshold recalibrated)
  const pinch_dist = dist(normalized[LANDMARK.THUMB_TIP], normalized[LANDMARK.INDEX_TIP])
  strengths.pinch = clamp01(1 - pinch_dist / 0.50)

  // ── Open palm: average of 4 finger extension scores
  strengths.open_palm = (i_ext_s + m_ext_s + r_ext_s + p_ext_s) / 4

  // ── Fist: ALL 4 fingers must be curled (min-based prevents point→fist confusion)
  strengths.fist = Math.min(i_curl_s, m_curl_s, r_curl_s, p_curl_s)

  // ── Point: index extended (0.5) + other 3 curled (0.5)
  const others_curled = (m_curl_s + r_curl_s + p_curl_s) / 3
  strengths.point = i_ext_s * 0.5 + others_curled * 0.5

  // ── Peace: index+middle extended (0.5) + ring+pinky curled (0.5)
  const two_extended = (i_ext_s + m_ext_s) / 2
  const two_curled = (r_curl_s + p_curl_s) / 2
  strengths.peace = two_extended * 0.5 + two_curled * 0.5

  // ── Thumbs up: thumb extended upward + all fingers curled + thumb separated
  // Min-based scoring: ALL conditions must be present (prevents false positives
  // from fist where thumb wraps around fingers, or point where fingers are curled)
  const thumb_ext_s = clamp01((thumb_ext_ratio - 1.2) / 0.4)
  const all_curled = (i_curl_s + m_curl_s + r_curl_s + p_curl_s) / 4
  // Thumb must point up: tip above MCP (MediaPipe y increases downward)
  const thumb_up_amount = normalized[LANDMARK.THUMB_MCP].y - normalized[LANDMARK.THUMB_TIP].y
  const thumb_up_s = clamp01((thumb_up_amount - 0.15) / 0.5)
  // Thumb must be away from curled fingers (not wrapped like in a fist)
  const thumb_index_sep = dist(normalized[LANDMARK.THUMB_TIP], normalized[LANDMARK.INDEX_MCP])
  const thumb_separated = clamp01((thumb_index_sep - 0.4) / 0.4)
  // Weakest component determines score — all must be present
  strengths.thumbs_up = Math.min(thumb_ext_s, all_curled, thumb_up_s, thumb_separated)

  return strengths
}

// ─── Hysteresis Thresholds ───────────────────────────────────────────

interface GestureThreshold {
  activate: number
  deactivate: number
  hold_ms: number
}

const THRESHOLDS: Record<Exclude<GestureType, `none`>, GestureThreshold> = {
  pinch:     { activate: 0.75, deactivate: 0.60, hold_ms: 100 },
  open_palm: { activate: 0.70, deactivate: 0.55, hold_ms: 100 },
  fist:      { activate: 0.70, deactivate: 0.55, hold_ms: 120 },
  point:     { activate: 0.70, deactivate: 0.55, hold_ms: 80 },
  peace:     { activate: 0.70, deactivate: 0.55, hold_ms: 150 },
  thumbs_up: { activate: 0.75, deactivate: 0.60, hold_ms: 150 },
}

// ─── Smoothed Recognizer ──────────────────────────────────────────────

const HYSTERESIS_FRAMES = 3
const HISTORY_SIZE = 5

export class GestureRecognizer {
  private history: GestureType[] = []
  private current: GestureType = `none`
  private _current_strength = 0
  private streak = 0
  private streak_gesture: GestureType = `none`
  private hold_start = 0
  private hold_gesture: GestureType = `none`

  /** Classify gesture from landmarks with hysteresis + hold time. */
  classify(landmarks: Landmark[]): GestureType {
    const strengths = compute_gesture_strengths(landmarks)

    // ── Hysteresis: sticky current gesture
    let next: GestureType = `none`
    let next_strength = 0

    if (this.current !== `none`) {
      const thresh = THRESHOLDS[this.current]
      if (strengths[this.current] >= thresh.deactivate) {
        // Current gesture still strong enough — keep it (sticky)
        next = this.current
        next_strength = strengths[this.current]
      }
    }

    // If current gesture dropped below deactivate, find strongest candidate
    if (next === `none`) {
      let best: GestureType = `none`
      let best_strength = 0
      for (const g of Object.keys(THRESHOLDS) as Exclude<GestureType, `none`>[]) {
        if (strengths[g] >= THRESHOLDS[g].activate && strengths[g] > best_strength) {
          best = g
          best_strength = strengths[g]
        }
      }
      next = best
      next_strength = best === `none` ? 0 : best_strength
    }

    // ── Frame streak: require consistent frames before switching
    if (next === this.streak_gesture) {
      this.streak++
    } else {
      this.streak_gesture = next
      this.streak = 1
    }

    // ── Minimum hold time
    if (next !== this.hold_gesture) {
      this.hold_gesture = next
      this.hold_start = performance.now()
    }

    const hold_elapsed = performance.now() - this.hold_start
    const required_hold = next === `none` ? 0 : THRESHOLDS[next].hold_ms

    if (this.streak >= HYSTERESIS_FRAMES && hold_elapsed >= required_hold && next !== this.current) {
      this.current = next
    }

    // Update strength for current gesture
    this._current_strength = this.current === `none` ? 0 : strengths[this.current]

    // Update history
    this.history.push(this.current)
    if (this.history.length > HISTORY_SIZE) this.history.shift()

    return this.current
  }

  /** Strength of the currently active gesture (0-1). */
  get current_strength(): number {
    return this._current_strength
  }

  /** Get the pinch distance (thumb tip ↔ index tip). */
  pinch_distance(landmarks: Landmark[]): number {
    if (landmarks.length < 21) return 1
    return dist(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.INDEX_TIP])
  }

  /** Get palm center (average of wrist + MCP joints). */
  palm_center(landmarks: Landmark[]): { x: number; y: number } {
    if (landmarks.length < 21) return { x: 0.5, y: 0.5 }
    const points = [
      landmarks[LANDMARK.WRIST],
      landmarks[LANDMARK.INDEX_MCP],
      landmarks[LANDMARK.MIDDLE_MCP],
      landmarks[LANDMARK.RING_MCP],
      landmarks[LANDMARK.PINKY_MCP],
    ]
    const x = points.reduce((s, p) => s + p.x, 0) / points.length
    const y = points.reduce((s, p) => s + p.y, 0) / points.length
    return { x, y }
  }

  reset(): void {
    this.history = []
    this.current = `none`
    this._current_strength = 0
    this.streak = 0
    this.streak_gesture = `none`
    this.hold_start = 0
    this.hold_gesture = `none`
  }
}
