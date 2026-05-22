// RT14 pure hit-test helpers — NO DOM / NO Svelte. Used by
// CatRenderViewPane to turn a preview click (already converted to the
// renderer's projected SVG-space coordinates) into the picked atom or bond.
//
// Coordinates here are the SAME projected coords the wasm renderer drew
// (parsed from the rendered `<circle cx cy r>` list), so a positive hit
// aligns pixel-accurately with the molecule on screen. Both functions are
// pure and deterministic (stable tie-break = lowest index wins).

/** A projected atom: screen-space centre + drawn radius. */
export type PickAtom = { x: number; y: number; r: number }

/**
 * Index of the atom hit by a click at (cx,cy).
 *
 * Priority:
 *  1. If the click is INSIDE any atom's circle (dist ≤ r), the closest such
 *     atom wins.
 *  2. Otherwise, the nearest atom whose centre is within `r + slack` px
 *     (small forgiving slack so a near-miss on a tiny atom still picks it).
 *  3. Else `null`.
 *
 * Ties (exactly equal distance) resolve deterministically to the LOWEST
 * index — iteration uses strict `<` so the first-seen (lowest) index keeps
 * the win.
 */
export function nearest_atom(
  cx: number,
  cy: number,
  atoms: PickAtom[],
  slack = 6,
): number | null {
  let inside_best = -1
  let inside_d = Infinity
  let near_best = -1
  let near_d = Infinity
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i]
    const d = Math.hypot(cx - a.x, cy - a.y)
    if (d <= a.r) {
      if (d < inside_d) {
        inside_d = d
        inside_best = i
      }
    } else if (d <= a.r + slack) {
      if (d < near_d) {
        near_d = d
        near_best = i
      }
    }
  }
  if (inside_best >= 0) return inside_best
  if (near_best >= 0) return near_best
  return null
}

/** Squared point-to-line-SEGMENT distance (segment, not infinite line). */
function seg_dist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  // Degenerate segment (coincident endpoints) → point distance.
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const qx = ax + t * vx
  const qy = ay + t * vy
  return (px - qx) ** 2 + (py - qy) ** 2
}

/**
 * The bond `[i,j]` whose projected segment is closest to (cx,cy), provided
 * that distance is within `thresh` px. Uses point-to-SEGMENT distance (a
 * click beyond an endpoint is measured to the endpoint, never to the
 * infinite line), so clicking past a bond's end does NOT spuriously hit it.
 *
 * `bonds` are `[i,j]` index pairs into `atoms` (the projected atom coords).
 * Ties resolve to the FIRST bond in the array (strict `<`). Returns `null`
 * if no bond is within `thresh`, or inputs are empty / reference missing
 * atoms.
 */
export function nearest_bond(
  cx: number,
  cy: number,
  bonds: [number, number][],
  atoms: { x: number; y: number }[],
  thresh: number,
): [number, number] | null {
  let best: [number, number] | null = null
  let best_d2 = Infinity
  const thresh2 = thresh * thresh
  for (const [i, j] of bonds) {
    const a = atoms[i]
    const b = atoms[j]
    if (!a || !b) continue
    const d2 = seg_dist2(cx, cy, a.x, a.y, b.x, b.y)
    if (d2 <= thresh2 && d2 < best_d2) {
      best_d2 = d2
      best = [i, j]
    }
  }
  return best
}
