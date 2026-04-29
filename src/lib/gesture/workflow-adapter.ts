/**
 * Maps gesture events to workflow editor canvas actions.
 *
 * Translates hand movements into canvas pan/zoom and node selection.
 */

import type { GestureEvent, VoiceEvent } from './gesture-types'

export interface WorkflowGestureAPI {
  /** Pan canvas by delta pixels */
  pan(dx: number, dy: number): void
  /** Zoom by delta (positive = in, negative = out) */
  zoom(delta: number): void
  /** Get node ID at screen position, or null */
  node_at(screen_x: number, screen_y: number): string | null
  /** Highlight a node */
  set_hover(node_id: string | null): void
  /** Select a node */
  select_node(node_id: string): void
  /** Clear selection */
  clear_selection(): void
  /** Canvas dimensions */
  canvas_size(): { width: number; height: number }
}

const PAN_SPEED = 1.5
const ZOOM_SPEED = 5.0

export class WorkflowAdapter {
  private api: WorkflowGestureAPI
  private sensitivity: number

  constructor(api: WorkflowGestureAPI, sensitivity = 1.0) {
    this.api = api
    this.sensitivity = sensitivity
  }

  set_sensitivity(s: number): void {
    this.sensitivity = s
  }

  process(event: GestureEvent): void {
    const { action, delta, pinch_delta, screen_pos } = event

    switch (action) {
      case `pan`: {
        const size = this.api.canvas_size()
        const s = PAN_SPEED * this.sensitivity
        this.api.pan(delta.x * size.width * s, delta.y * size.height * s)
        break
      }
      case `zoom`: {
        const s = ZOOM_SPEED * this.sensitivity
        this.api.zoom(-pinch_delta * s)
        break
      }
      case `hover`: {
        const node = this.api.node_at(screen_pos.x, screen_pos.y)
        this.api.set_hover(node)
        break
      }
      case `select`: {
        const node = this.api.node_at(screen_pos.x, screen_pos.y)
        if (node) this.api.select_node(node)
        break
      }
    }
  }

  process_voice(event: VoiceEvent): void {
    if (!event.is_final) return
    const { action } = event

    if (action.type === `navigate`) {
      switch (action.command) {
        case `zoom_in`: this.api.zoom(0.2 * this.sensitivity); break
        case `zoom_out`: this.api.zoom(-0.2 * this.sensitivity); break
        case `pan_left`: this.api.pan(-80 * this.sensitivity, 0); break
        case `pan_right`: this.api.pan(80 * this.sensitivity, 0); break
        case `pan_up`: this.api.pan(0, -80 * this.sensitivity); break
        case `pan_down`: this.api.pan(0, 80 * this.sensitivity); break
      }
    } else if (action.type === `select` && action.command === `clear_selection`) {
      this.api.clear_selection()
    }
  }
}
