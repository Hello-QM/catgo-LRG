/**
 * One Euro Filter — adaptive low-pass filter for landmark smoothing.
 *
 * Smooths heavily when motion is slow (kills jitter), lightly when fast
 * (preserves responsiveness). From Casiez et al. CHI 2012.
 *
 * Used by MediaPipe internally for similar purposes.
 */

import type { Landmark } from './gesture-types'

// ─── Low-pass filter primitive ─────────────────────────────────────────

class LowPassFilter {
  private y = 0
  private s = 0
  private initialized = false

  filter(x: number, alpha: number): number {
    if (!this.initialized) {
      this.y = x
      this.s = x
      this.initialized = true
      return x
    }
    this.y = alpha * x + (1 - alpha) * this.y
    this.s = alpha * x + (1 - alpha) * this.s
    return this.y
  }

  reset(): void {
    this.initialized = false
  }

  get last(): number {
    return this.y
  }
}

// ─── One Euro Filter ───────────────────────────────────────────────────

export class OneEuroFilter {
  private min_cutoff: number
  private beta: number
  private d_cutoff: number
  private x_filter = new LowPassFilter()
  private dx_filter = new LowPassFilter()
  private last_t = -1

  /**
   * @param min_cutoff - Minimum cutoff frequency (Hz). Lower = more smoothing at rest.
   * @param beta - Speed coefficient. Higher = less smoothing during fast motion.
   * @param d_cutoff - Cutoff for derivative estimation.
   */
  constructor(min_cutoff = 0.05, beta = 40.0, d_cutoff = 1.0) {
    this.min_cutoff = min_cutoff
    this.beta = beta
    this.d_cutoff = d_cutoff
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff)
    return 1.0 / (1.0 + tau / dt)
  }

  /**
   * Filter a single scalar value.
   * @param x - Raw input value
   * @param t - Timestamp in seconds (must be monotonically increasing)
   */
  filter(x: number, t: number): number {
    if (this.last_t < 0) {
      this.last_t = t
      this.dx_filter.filter(0, 1)
      return this.x_filter.filter(x, 1)
    }

    const dt = Math.max(t - this.last_t, 1e-6)
    this.last_t = t

    // Estimate derivative
    const dx = (x - this.x_filter.last) / dt
    const edx = this.dx_filter.filter(dx, OneEuroFilter.alpha(this.d_cutoff, dt))

    // Adaptive cutoff based on speed
    const cutoff = this.min_cutoff + this.beta * Math.abs(edx)

    return this.x_filter.filter(x, OneEuroFilter.alpha(cutoff, dt))
  }

  reset(): void {
    this.x_filter.reset()
    this.dx_filter.reset()
    this.last_t = -1
  }
}

// ─── Landmark Filter Bank ──────────────────────────────────────────────

/**
 * Manages 63 One Euro Filters (21 landmarks × 3 axes) for one hand.
 */
export class LandmarkFilterBank {
  private filters: OneEuroFilter[]

  constructor(min_cutoff = 0.05, beta = 40.0, d_cutoff = 1.0) {
    this.filters = Array.from({ length: 63 }, () =>
      new OneEuroFilter(min_cutoff, beta, d_cutoff),
    )
  }

  /** Filter a full set of 21 landmarks. Returns new filtered array. */
  filter(landmarks: Landmark[], t_seconds: number): Landmark[] {
    return landmarks.map((lm, i) => ({
      x: this.filters[i * 3].filter(lm.x, t_seconds),
      y: this.filters[i * 3 + 1].filter(lm.y, t_seconds),
      z: this.filters[i * 3 + 2].filter(lm.z, t_seconds),
    }))
  }

  reset(): void {
    for (const f of this.filters) f.reset()
  }
}
