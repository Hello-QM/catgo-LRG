/**
 * Resolve the WebGL drawing-buffer pixel ratio used by the interactive
 * structure viewer.
 *
 * Atom and bond impostors write analytic fragment depth.  Ordinary MSAA only
 * smooths the proxy geometry silhouette, not the internal sphere/cylinder
 * depth boundary, so a modest supersampled drawing buffer is required for a
 * clean atom-bond junction.  The pixel budget prevents quality mode from
 * multiplying a large viewport into an unbounded framebuffer.
 */

export const QUALITY_TARGET_DPR = 2.5
export const QUALITY_PIXEL_BUDGET = 8_000_000

export type RenderDprOptions = {
  device_dpr: number
  width: number
  height: number
  quality: boolean
  moving: boolean
  playing: boolean
  suspended: boolean
}

export function resolve_render_dpr({
  device_dpr,
  width,
  height,
  quality,
  moving,
  playing,
  suspended,
}: RenderDprOptions): number {
  const native_dpr = Number.isFinite(device_dpr) && device_dpr > 0
    ? device_dpr
    : 1
  if (!quality || moving || playing || suspended) return native_dpr

  const css_pixels = Math.max(1, width) * Math.max(1, height)
  const budget_dpr = Math.sqrt(QUALITY_PIXEL_BUDGET / css_pixels)
  return Math.max(native_dpr, Math.min(QUALITY_TARGET_DPR, budget_dpr))
}
