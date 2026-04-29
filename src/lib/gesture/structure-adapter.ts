/**
 * Maps gesture events to 3D structure viewer actions.
 *
 * Translates hand movements into camera rotation/zoom/pan and atom selection.
 */

import type { GestureEvent, GestureAction, VoiceEvent } from './gesture-types'

export interface StructureGestureAPI {
  /** Rotate camera around axis by angle (radians) */
  rotate(axis: `x` | `y` | `z`, angle: number): void
  /** Zoom by delta (positive = in, negative = out) */
  zoom(delta: number): void
  /** Pan by screen-space delta */
  pan(dx: number, dy: number): void
  /** Get atom index at screen pixel position, or null */
  atom_at(screen_x: number, screen_y: number): number | null
  /** Set hovered atom index */
  set_hover(idx: number | null): void
  /** Toggle selection of atom */
  toggle_select(idx: number): void
  /** Reset camera to default */
  reset_camera(): void
  /** Select all atoms */
  select_all(): void
  /** Clear selection */
  clear_selection(): void
  /** Delete selected */
  delete_selected(): void
  /** Undo last action */
  undo(): void
  /** Canvas dimensions */
  canvas_size(): { width: number; height: number }
}

// ─── Sensitivity Multipliers ──────────────────────────────────────────

const ROTATE_SPEED = 8.0     // radians per normalized unit
const ZOOM_SPEED = 8.0       // zoom units per normalized pinch delta
const PAN_SPEED = 1.0        // fraction of canvas size per normalized unit

// ─── State Tracking ───────────────────────────────────────────────────

interface AdapterState {
  prev_center: { x: number; y: number } | null
  prev_pinch: number
  active_gesture: GestureAction
}

export class StructureAdapter {
  private api: StructureGestureAPI
  private sensitivity: number
  private state: AdapterState = {
    prev_center: null,
    prev_pinch: 0,
    active_gesture: `idle`,
  }

  constructor(api: StructureGestureAPI, sensitivity = 1.0) {
    this.api = api
    this.sensitivity = sensitivity
  }

  set_sensitivity(s: number): void {
    this.sensitivity = s
  }

  /** Process a gesture frame and apply to the structure viewer. */
  process(event: GestureEvent): void {
    const { action, delta, pinch_delta, screen_pos, hands } = event

    switch (action) {
      case `rotate`: {
        const s = ROTATE_SPEED * this.sensitivity
        if (delta.x !== 0) this.api.rotate(`y`, delta.x * s)
        if (delta.y !== 0) this.api.rotate(`x`, delta.y * s)
        break
      }
      case `zoom`: {
        const s = ZOOM_SPEED * this.sensitivity
        this.api.zoom(-pinch_delta * s)
        break
      }
      case `pan`: {
        const size = this.api.canvas_size()
        const s = PAN_SPEED * this.sensitivity
        // Negate both: webcam mirror inverts x, MediaPipe y-down inverts y
        this.api.pan(-delta.x * size.width * s, -delta.y * size.height * s)
        break
      }
      case `hover`: {
        const idx = this.api.atom_at(screen_pos.x, screen_pos.y)
        this.api.set_hover(idx)
        break
      }
      case `select`: {
        const idx = this.api.atom_at(screen_pos.x, screen_pos.y)
        if (idx !== null) this.api.toggle_select(idx)
        break
      }
    }

    this.state.active_gesture = action
  }

  /** Process a voice command. */
  process_voice(event: VoiceEvent): void {
    if (!event.is_final) return
    const { action } = event

    switch (action.type) {
      case `navigate`:
        switch (action.command) {
          case `rotate_left`: this.api.rotate(`y`, -0.3 * this.sensitivity); break
          case `rotate_right`: this.api.rotate(`y`, 0.3 * this.sensitivity); break
          case `rotate_up`: this.api.rotate(`x`, -0.3 * this.sensitivity); break
          case `rotate_down`: this.api.rotate(`x`, 0.3 * this.sensitivity); break
          case `zoom_in`: this.api.zoom(2 * this.sensitivity); break
          case `zoom_out`: this.api.zoom(-2 * this.sensitivity); break
          case `reset_view`: this.api.reset_camera(); break
          case `pan_left`: this.api.pan(-50 * this.sensitivity, 0); break
          case `pan_right`: this.api.pan(50 * this.sensitivity, 0); break
          case `pan_up`: this.api.pan(0, -50 * this.sensitivity); break
          case `pan_down`: this.api.pan(0, 50 * this.sensitivity); break
        }
        break
      case `select`:
        switch (action.command) {
          case `select_all`: this.api.select_all(); break
          case `clear_selection`: this.api.clear_selection(); break
          case `delete`: this.api.delete_selected(); break
          case `undo`: this.api.undo(); break
        }
        break
    }
  }

  reset(): void {
    this.state = { prev_center: null, prev_pinch: 0, active_gesture: `idle` }
  }
}
