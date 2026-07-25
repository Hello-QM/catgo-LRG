import { Color } from 'three'
import type { RenderStyle } from '$lib/settings'

export type LinearRgb = [number, number, number]
export type DisplayRgb = [number, number, number]
export type Vec3Like = [number, number, number] | { x: number; y: number; z: number }

export type LargeSystemLighting = {
  light_dir: LinearRgb
  ambient_light: number
  directional_light: number
  highlight_strength: number
  /** Numeric atom render-style branch used by the WGSL atom shader.
   *  Matches AtomManagerInstances: 0 glossy/PBR, 1 matte/soft/flat, 2 toon,
   *  3 procedural matcap. Metallic uses branch 0 plus roughness/metalness. */
  render_style?: number
  roughness?: number
  metalness?: number
  depth_cueing?: number
  depth_near?: number
  depth_far?: number
  atom_outline_strength?: number
  bond_outline_strength?: number
  /** Display-RGB background used for depth-cue mixing after fragment encoding. */
  depth_cue_bg_display?: DisplayRgb
  /** MatCap params: ambient, diffuse, spec, specExp, rim, vGrad. */
  matcap_params?: [number, number, number, number, number, number]
}

const scratch = new Color()

export function hex_to_linear_rgb(hex: string): LinearRgb {
  // Matches StructureScene.__hex_to_linear_rgb: with Three ColorManagement on,
  // Color.set(hex) already converts CSS/sRGB hex values to linear RGB. Calling
  // convertSRGBToLinear() again double-darkens mid-tone colors.
  scratch.set(hex)
  return [scratch.r, scratch.g, scratch.b]
}

export function linear_to_display_channel(v: number): number {
  const x = Math.max(0, Math.min(1, v))
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

export function linear_rgb_to_display_rgb(rgb: LinearRgb): DisplayRgb {
  return [
    linear_to_display_channel(rgb[0]),
    linear_to_display_channel(rgb[1]),
    linear_to_display_channel(rgb[2]),
  ]
}

export function render_style_to_int(style: RenderStyle): number {
  if (style === `toon`) return 2
  if (style === `matcap`) return 3
  if (style === `matte` || style === `soft` || style === `flat`) return 1
  return 0
}

export function render_style_pbr(style: RenderStyle): { roughness: number; metalness: number } {
  return style === `metallic`
    ? { roughness: 0.4, metalness: 0.4 }
    : { roughness: 0.2, metalness: 0.0 }
}

const MATCAP_PARAM_MAP: Record<string, [number, number, number, number, number, number]> = {
  // Mirrors src/lib/structure/atoms/matcap-texture.ts. Keeping the params here
  // lets the WebGPU shader evaluate the same procedural material-capture sphere
  // analytically without uploading a canvas texture.
  ceramic: [0.34, 0.66, 0.35, 48, 0.14, 0],
  clay: [0.42, 0.6, 0, 1, 0.1, 0],
  glossy: [0.28, 0.6, 0.6, 90, 0.12, 0.12],
  pearl: [0.46, 0.48, 0.5, 60, 0.06, 0.18],
}

export function matcap_preset_params(
  preset: string | undefined,
): [number, number, number, number, number, number] {
  const params = MATCAP_PARAM_MAP[preset ?? `ceramic`] ?? MATCAP_PARAM_MAP.ceramic
  return [params[0], params[1], params[2], params[3], params[4], params[5]]
}

export function resolve_background_display_rgb(
  background_color: string | undefined,
  background_opacity: number,
  theme_srgb: DisplayRgb,
): DisplayRgb {
  // Mirror StructureScene.compute_canvas_bg exactly: picked hex colors are
  // Three linear Colors, CSS theme rgb is fed through Color.setRGB (so those
  // numeric components are also treated as linear), then WebGLRenderer performs
  // the final output conversion. WebGPU clear values bypass the fragment shader,
  // so we do that final linear->display conversion here.
  const picked = new Color(background_color ?? `#000000`)
  const t = Math.max(0, Math.min(1, background_opacity))
  const bg = new Color().setRGB(theme_srgb[0], theme_srgb[1], theme_srgb[2])
  if (t >= 0.999) bg.copy(picked)
  else if (t > 0.001) bg.lerp(picked, t)
  return linear_rgb_to_display_rgb([bg.r, bg.g, bg.b])
}

export function normalize_light_dir(light_dir: Vec3Like | undefined): LinearRgb {
  const raw: LinearRgb = Array.isArray(light_dir)
    ? [light_dir[0], light_dir[1], light_dir[2]]
    : light_dir
      ? [light_dir.x, light_dir.y, light_dir.z]
      : [0.4, 0.7, 0.6]
  const len = Math.hypot(raw[0], raw[1], raw[2])
  if (!Number.isFinite(len) || len <= 1e-12) return [0.4, 0.7, 0.6]
  return [raw[0] / len, raw[1] / len, raw[2] / len]
}

export function normalize_lighting(
  opts: Partial<Omit<LargeSystemLighting, `light_dir`>> & { light_dir?: Vec3Like },
): LargeSystemLighting {
  const bg = opts.depth_cue_bg_display
  const matcap = opts.matcap_params ?? MATCAP_PARAM_MAP.ceramic
  return {
    light_dir: normalize_light_dir(opts.light_dir),
    ambient_light: Number.isFinite(opts.ambient_light)
      ? Math.max(0, opts.ambient_light as number)
      : 0.7,
    directional_light: Number.isFinite(opts.directional_light)
      ? Math.max(0, opts.directional_light as number)
      : 0.3,
    highlight_strength: Number.isFinite(opts.highlight_strength)
      ? Math.max(0, opts.highlight_strength as number)
      : 1.0,
    render_style: Number.isFinite(opts.render_style) ? opts.render_style : 0,
    roughness: Number.isFinite(opts.roughness) ? Math.max(0.001, opts.roughness as number) : 0.2,
    metalness: Number.isFinite(opts.metalness)
      ? Math.max(0, Math.min(1, opts.metalness as number))
      : 0,
    depth_cueing: Number.isFinite(opts.depth_cueing)
      ? Math.max(0, Math.min(1, opts.depth_cueing as number))
      : 0,
    depth_near: Number.isFinite(opts.depth_near) ? opts.depth_near : 0,
    depth_far: Number.isFinite(opts.depth_far) ? opts.depth_far : 10,
    atom_outline_strength: Number.isFinite(opts.atom_outline_strength)
      ? Math.max(0, Math.min(1, opts.atom_outline_strength as number))
      : 0,
    bond_outline_strength: Number.isFinite(opts.bond_outline_strength)
      ? Math.max(0, Math.min(1, opts.bond_outline_strength as number))
      : 0,
    depth_cue_bg_display: bg
      ? [
          Math.max(0, Math.min(1, bg[0])),
          Math.max(0, Math.min(1, bg[1])),
          Math.max(0, Math.min(1, bg[2])),
        ]
      : [1, 1, 1],
    matcap_params: [
      Math.max(0, matcap[0]),
      Math.max(0, matcap[1]),
      Math.max(0, matcap[2]),
      Math.max(1, matcap[3]),
      Math.max(0, matcap[4]),
      matcap[5],
    ],
  }
}
