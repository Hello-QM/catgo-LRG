/**
 * Render-surface marking + active-canvas selection (Visual T6).
 *
 * The viewer can paint through several canvases: the Threlte WebGL canvas
 * (webgl2, or legacy webgl1 where webgl2 is unavailable) and the WebGPU
 * large-system overlay canvas stacked above it. Exactly ONE of them is the
 * visible renderer at any time — the Bonds-T6 atomic swap flips overlay
 * mount/unmount and WebGL suspension in the same synchronous flush.
 *
 * Raster capture (PNG / video / PNG-sequence) must read pixels from the
 * ACTIVE canvas, never blindly from the first `<canvas>` in the wrapper —
 * a suspended WebGL canvas under the overlay holds a stale (or blank)
 * drawing buffer. Canvases advertise themselves via two data attributes:
 *
 *   data-render-backend = "webgpu" | "webgl2" | "legacy"
 *   data-render-active  = "true" | "false"
 *
 * Backend choice is a CAPTURE concern only — it must never leak into
 * scientific-structure routing (see controllers/transform-controller.ts
 * `visual_replication_active`).
 *
 * Pure DOM helpers — no Svelte / Three.js imports.
 */

export type RenderSurfaceBackend = `webgpu` | `webgl2` | `legacy`

export const RENDER_BACKEND_ATTR = `data-render-backend`
export const RENDER_ACTIVE_ATTR = `data-render-active`

/** Stamp a canvas with its render backend and whether it is currently the
 *  visible renderer. Idempotent — call from reactive effects freely. */
export function mark_render_surface(
  canvas: HTMLCanvasElement,
  backend: RenderSurfaceBackend,
  active: boolean,
): void {
  canvas.setAttribute(RENDER_BACKEND_ATTR, backend)
  canvas.setAttribute(RENDER_ACTIVE_ATTR, active ? `true` : `false`)
}

/**
 * Pick the canvas raster capture should read from.
 *
 * Priority:
 * 1. The LAST canvas explicitly marked active — the WebGPU overlay is a
 *    later sibling stacked above the kept-warm WebGL canvas, so on the
 *    (contractually impossible) double-active frame the topmost one wins.
 * 2. The first canvas NOT explicitly marked inactive — preserves legacy
 *    first-canvas behaviour for unmarked scenes (other panes' viewers).
 * 3. The first canvas, if every canvas is marked inactive.
 */
export function select_active_render_canvas(
  root: ParentNode | null | undefined,
): HTMLCanvasElement | null {
  if (!root) return null
  const canvases = Array.from(root.querySelectorAll(`canvas`))
  if (canvases.length === 0) return null
  for (let idx = canvases.length - 1; idx >= 0; idx--) {
    if (canvases[idx].getAttribute(RENDER_ACTIVE_ATTR) === `true`) {
      return canvases[idx]
    }
  }
  return canvases.find(
    (canvas) => canvas.getAttribute(RENDER_ACTIVE_ATTR) !== `false`,
  ) ?? canvases[0]
}
