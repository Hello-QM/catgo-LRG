import type { RenderStyle } from '$lib/settings'

export const VISUAL_RADIUS_SCALE = 0.5
export const TOON_SHADOW_THRESHOLD = 0.3
export const TOON_HIGHLIGHT_THRESHOLD = 0.97
export const TOON_SHADOW_BRIGHTNESS = 0.5

export type BackendRenderStyle = 0 | 1 | 2 | 3
export type WebgpuRenderStyle = Exclude<BackendRenderStyle, 3>
export type LegacyImpostorRenderStyle = WebgpuRenderStyle
export type VisualBackend = `webgl2` | `webgpu`

export type ResolvedVisualShading = {
  light_dir: [number, number, number]
  is_ortho: boolean
  ambient: number
  directional: number
  spec_strength: number
  roughness: number
  metalness: number
  render_style: BackendRenderStyle
  outline: number
  depth_cueing: number
  depth_near: number
  depth_far: number
  depth_bg: [number, number, number]
  toon_shadow_threshold: number
  toon_highlight_threshold: number
  toon_shadow_brightness: number
}

export type ResolvedVisualState = {
  shading: ResolvedVisualShading
  background_linear: [number, number, number]
}

export type VisualStateSource = {
  revision: string
  resolve: () => ResolvedVisualState
}

export function render_style_to_backend(
  style: RenderStyle,
  backend: `webgpu`,
): WebgpuRenderStyle
export function render_style_to_backend(
  style: RenderStyle,
  backend: `webgl2`,
): BackendRenderStyle
export function render_style_to_backend(
  style: RenderStyle,
  backend: VisualBackend,
): BackendRenderStyle {
  if (style === `toon`) return 2
  if (style === `matte` || style === `soft` || style === `flat`) return 1
  if (style === `matcap`) return backend === `webgl2` ? 3 : 0
  return 0
}

/**
 * The legacy AtomImpostors shader has only glossy, matte, and toon branches.
 * Keep its unsupported MatCap behavior explicit instead of relying on shader
 * branch 3 falling through the final `else` by accident.
 */
export function render_style_to_legacy_impostor(
  style: RenderStyle,
): LegacyImpostorRenderStyle {
  switch (style) {
    case `toon`:
      return 2
    case `matte`:
    case `soft`:
    case `flat`:
      return 1
    case `glossy`:
    case `metallic`:
    case `matcap`:
      return 0
  }
}

export function style_pbr(style: RenderStyle): { roughness: number; metalness: number } {
  return style === `metallic`
    ? { roughness: 0.4, metalness: 0.4 }
    : { roughness: 0.2, metalness: 0 }
}

export function same_visual_shading(
  a: ResolvedVisualShading,
  b: ResolvedVisualShading,
): boolean {
  return a.light_dir.every((value, idx) => value === b.light_dir[idx]) &&
    a.is_ortho === b.is_ortho &&
    a.ambient === b.ambient &&
    a.directional === b.directional &&
    a.spec_strength === b.spec_strength &&
    a.roughness === b.roughness &&
    a.metalness === b.metalness &&
    a.render_style === b.render_style &&
    a.outline === b.outline &&
    a.depth_cueing === b.depth_cueing &&
    a.depth_near === b.depth_near &&
    a.depth_far === b.depth_far &&
    a.depth_bg.every((value, idx) => value === b.depth_bg[idx]) &&
    a.toon_shadow_threshold === b.toon_shadow_threshold &&
    a.toon_highlight_threshold === b.toon_highlight_threshold &&
    a.toon_shadow_brightness === b.toon_shadow_brightness
}
