/**
 * Atom Art Mode: place atoms in 3D space using pinch gestures.
 *
 * Maps 2D hand position to a 3D plane perpendicular to the camera,
 * places atoms at pinch locations, and draws trails when pinch is held.
 */

import type { HandState, Landmark } from './gesture-types'

export interface AtomArtAPI {
  /** Get camera position and direction for 3D projection */
  get_camera_ray(screen_x: number, screen_y: number): {
    origin: { x: number; y: number; z: number }
    direction: { x: number; y: number; z: number }
  }
  /** Place an atom at 3D position with given element */
  place_atom(position: { x: number; y: number; z: number }, element: string): void
  /** Get the current selected element symbol */
  get_element(): string
  /** Set the selected element */
  set_element(symbol: string): void
  /** Get canvas dimensions */
  canvas_size(): { width: number; height: number }
}

interface ArtState {
  is_drawing: boolean
  last_place_pos: { x: number; y: number; z: number } | null
  trail_positions: { x: number; y: number; z: number }[]
}

export class AtomArt {
  private api: AtomArtAPI
  private state: ArtState = {
    is_drawing: false,
    last_place_pos: null,
    trail_positions: [],
  }
  private placement_depth = 10.0   // Distance from camera to placement plane (Angstroms)
  private trail_spacing: number     // Min distance between trail atoms (Angstroms)

  constructor(api: AtomArtAPI, trail_spacing = 2.0) {
    this.api = api
    this.trail_spacing = trail_spacing
  }

  set_trail_spacing(spacing: number): void {
    this.trail_spacing = spacing
  }

  set_placement_depth(depth: number): void {
    this.placement_depth = depth
  }

  /** Called each frame when art mode is active.
   *  Returns the current ghost position for preview rendering. */
  process_hand(hand: HandState, canvas_width: number, canvas_height: number): {
    ghost_pos: { x: number; y: number; z: number } | null
    placed: boolean
  } {
    const screen_x = hand.center.x * canvas_width
    const screen_y = hand.center.y * canvas_height

    // Project hand position to 3D
    const ray = this.api.get_camera_ray(screen_x, screen_y)
    const pos_3d = {
      x: ray.origin.x + ray.direction.x * this.placement_depth,
      y: ray.origin.y + ray.direction.y * this.placement_depth,
      z: ray.origin.z + ray.direction.z * this.placement_depth,
    }

    if (hand.gesture === `pinch`) {
      if (!this.state.is_drawing) {
        // Start drawing — place first atom
        this.state.is_drawing = true
        this.state.last_place_pos = pos_3d
        this.state.trail_positions = [pos_3d]
        this.api.place_atom(pos_3d, this.api.get_element())
        return { ghost_pos: pos_3d, placed: true }
      } else {
        // Continue drawing — place atom if moved enough
        if (this.state.last_place_pos) {
          const d = distance_3d(pos_3d, this.state.last_place_pos)
          if (d >= this.trail_spacing) {
            this.api.place_atom(pos_3d, this.api.get_element())
            this.state.last_place_pos = pos_3d
            this.state.trail_positions.push(pos_3d)
            return { ghost_pos: pos_3d, placed: true }
          }
        }
        return { ghost_pos: pos_3d, placed: false }
      }
    } else {
      // Not pinching — stop drawing, show ghost preview
      this.state.is_drawing = false
      return { ghost_pos: pos_3d, placed: false }
    }
  }

  /** Get the trail of placed atom positions for visual feedback. */
  get_trail(): { x: number; y: number; z: number }[] {
    return this.state.trail_positions
  }

  /** Clear the trail (for new drawing session). */
  clear_trail(): void {
    this.state.trail_positions = []
    this.state.last_place_pos = null
    this.state.is_drawing = false
  }

  get is_drawing(): boolean {
    return this.state.is_drawing
  }
}

function distance_3d(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}
