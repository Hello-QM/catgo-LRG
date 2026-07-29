/** Shared semantic model for the WebGL DOM gizmo and the WebGPU gizmo adapter.
 *
 * Keep this module dependency-free: the public color module and the lean GPU
 * renderer both import it, so palette/layout facts never need to be copied.
 */

export type GizmoAxisColor = readonly [
  axis: `x` | `y` | `z`,
  color: string,
  hover_color: string,
]

export type GizmoNegativeAxisColor = readonly [
  axis: `nx` | `ny` | `nz`,
  color: string,
  hover_color: string,
]

export const GIZMO_AXIS_COLORS = [
  [`x`, `#d75555`, `#e66666`],
  [`y`, `#55b855`, `#66c966`],
  [`z`, `#5555d7`, `#6666e6`],
] as const satisfies readonly GizmoAxisColor[]

export const GIZMO_NEG_AXIS_COLORS = [
  [`nx`, `#b84444`, `#cc5555`],
  [`ny`, `#44a044`, `#55b155`],
  [`nz`, `#4444b8`, `#5555c9`],
] as const satisfies readonly GizmoNegativeAxisColor[]

export const GIZMO_AXIS_HEX = GIZMO_AXIS_COLORS.map(([, color]) => color)
export const GIZMO_NEG_AXIS_HEX = GIZMO_NEG_AXIS_COLORS.map(([, color]) => color)

export const GIZMO_WORLD_AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const

export interface HudSafeArea {
  l: number
  r: number
  t: number
  b: number
}

export const EMPTY_HUD_SAFE_AREA: Readonly<HudSafeArea> = Object.freeze({
  l: 0,
  r: 0,
  t: 0,
  b: 0,
})

export const GIZMO_LAYOUT = Object.freeze({
  edge_inset_css_px: 5,
  min_size_css_px: 70,
  responsive_size_cqmin: 18,
  max_size_css_px: 100,
  internal_half_extent: 1.8,
  line_width_css_px: 4,
})

export const GIZMO_SIZE_CSS =
  `clamp(${GIZMO_LAYOUT.min_size_css_px}px, ${GIZMO_LAYOUT.responsive_size_cqmin}cqmin, ${GIZMO_LAYOUT.max_size_css_px}px)`

const finite_nonnegative = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? Math.max(0, value) : fallback

export function normalize_hud_safe_area(
  safe: Partial<HudSafeArea> | null | undefined,
): HudSafeArea {
  return {
    l: finite_nonnegative(safe?.l ?? 0),
    r: finite_nonnegative(safe?.r ?? 0),
    t: finite_nonnegative(safe?.t ?? 0),
    b: finite_nonnegative(safe?.b ?? 0),
  }
}

export function gizmo_dom_offset(
  safe: Readonly<HudSafeArea> = EMPTY_HUD_SAFE_AREA,
): { left: number; bottom: number } {
  return {
    left: GIZMO_LAYOUT.edge_inset_css_px + finite_nonnegative(safe.l),
    bottom: GIZMO_LAYOUT.edge_inset_css_px + finite_nonnegative(safe.b),
  }
}

export interface ResolveGizmoLayoutInput {
  width_device_px: number
  height_device_px: number
  dpr: number
  safe_left_css_px?: number
  safe_bottom_css_px?: number
}

export interface ResolvedGizmoLayout {
  size_css_px: number
  radius_device_px: number
  unit_device_px: number
  line_half_width_device_px: number
  left_device_px: number
  bottom_device_px: number
  center_ndc: readonly [number, number]
  pixel_to_ndc: readonly [number, number]
}

/** Resolve the CSS clamp first, then convert to device pixels exactly once. */
export function resolve_gizmo_layout({
  width_device_px,
  height_device_px,
  dpr,
  safe_left_css_px = 0,
  safe_bottom_css_px = 0,
}: ResolveGizmoLayoutInput): ResolvedGizmoLayout {
  const width = Math.max(1, finite_nonnegative(width_device_px, 1))
  const height = Math.max(1, finite_nonnegative(height_device_px, 1))
  const pixel_ratio = Math.max(0.1, finite_nonnegative(dpr, 1))
  const cqmin_css_px = Math.min(width, height) / pixel_ratio / 100
  const responsive_size =
    GIZMO_LAYOUT.responsive_size_cqmin * cqmin_css_px
  const size_css_px = Math.min(
    Math.max(GIZMO_LAYOUT.min_size_css_px, responsive_size),
    GIZMO_LAYOUT.max_size_css_px,
  )
  const radius_device_px = (size_css_px * pixel_ratio) / 2
  const left_device_px = (
    GIZMO_LAYOUT.edge_inset_css_px + finite_nonnegative(safe_left_css_px)
  ) * pixel_ratio
  const bottom_device_px = (
    GIZMO_LAYOUT.edge_inset_css_px + finite_nonnegative(safe_bottom_css_px)
  ) * pixel_ratio

  return {
    size_css_px,
    radius_device_px,
    unit_device_px: radius_device_px / GIZMO_LAYOUT.internal_half_extent,
    line_half_width_device_px: (GIZMO_LAYOUT.line_width_css_px * pixel_ratio) / 2,
    left_device_px,
    bottom_device_px,
    center_ndc: [
      -1 + (2 * (left_device_px + radius_device_px)) / width,
      -1 + (2 * (bottom_device_px + radius_device_px)) / height,
    ],
    pixel_to_ndc: [2 / width, 2 / height],
  }
}

/** Apply a column-major view rotation to the shared world-axis basis. */
export function project_gizmo_axes(
  view: ArrayLike<number>,
): [number, number, number][] {
  if (view.length < 11) {
    throw new RangeError(`gizmo view matrix must contain at least 11 values`)
  }
  return GIZMO_WORLD_AXES.map((_, axis) => {
    const offset = axis * 4
    return [
      Number(view[offset]),
      Number(view[offset + 1]),
      Number(view[offset + 2]),
    ]
  })
}

const wgsl_axis_vector = (axis: readonly [number, number, number]): string =>
  `  vec3<f32>(${axis.map((value) => value.toFixed(1)).join(`, `)})`

/** WGSL orientation contract generated from the same world-axis basis used by
 * the CPU parity helper. The view matrix is column-major, matching the camera
 * uniform packer and Three.js Matrix4 storage. */
export const GIZMO_ORIENTATION_WGSL = `
const GIZMO_AXES = array<vec3<f32>, 3>(
${GIZMO_WORLD_AXES.map(wgsl_axis_vector).join(`,\n`)}
);

fn project_gizmo_axis(view : mat4x4<f32>, axis : u32) -> vec3<f32> {
  let rot = mat3x3<f32>(
    view[0].xyz,
    view[1].xyz,
    view[2].xyz,
  );
  return rot * GIZMO_AXES[axis];
}`.trim()

const hex_channel = (hex: string, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255

/** Generate WGSL literals from the shared display-space palette. */
export function gizmo_wgsl_color_vectors(hexes: readonly string[]): string {
  return hexes.map((hex) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
      throw new TypeError(`gizmo color must be a six-digit hex value: ${hex}`)
    }
    const channels = [1, 3, 5]
      .map((offset) => hex_channel(hex, offset).toFixed(3))
      .join(`, `)
    return `  vec3<f32>(${channels})`
  }).join(`,\n`)
}
