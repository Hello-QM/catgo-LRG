/// <reference types="@webgpu/types" />
/** WebGPU large-system render path (Task 9).
 *
 *  Milestone 9.1 — de-risking skeleton: clear-only pass + camera uniform upload.
 *  Milestone 9.2 — render the current frame's ATOMS as impostor spheres.
 *  A single instanced draw paints one screen-facing quad per atom; the fragment
 *  shader ray-traces a sphere inside the quad and writes correct clip-space depth
 *  so spheres occlude each other properly.
 *  Milestone 9.3 — GPU bond detection + bond rendering. The bond-detect compute
 *  (BOND_COMPUTE_WGSL) runs over the SAME positions buffer plus a separate
 *  COVALENT-radii buffer, writing a GPU-resident `pairs` buffer + atomic count.
 *  A tiny 1-thread compute then writes draw-indirect args from that count so the
 *  bond draw never stalls the CPU (trajectory-ready for 9.4). Bonds render as
 *  instanced procedural cylinders, sharing the atom depth buffer so they occlude
 *  correctly. No trajectory / picking yet — those arrive in later milestones. */
import {
  BOND_COMPUTE_DIRECT_WGSL,
  BOND_COMPUTE_WGSL,
} from '$lib/structure/gpu/bond-compute.wgsl'
import {
  pack_jimage,
  pack_params,
  PARAMS_BYTES,
  unpack_jimage,
} from '$lib/structure/gpu/bond-compute'
import {
  type BondDirtyKind,
  type BondGpuDiagnostics,
  classify_bond_dirty,
  create_bond_run_controller,
} from '$lib/structure/gpu/bond-diagnostics'
import { MAX_PER_CELL } from '$lib/structure/gpu/bond-grid'
import {
  MAX_DIRECT_ATOMS,
  plan_bond_dispatch,
} from '$lib/structure/workers/bond-backend-policy'
import { diff_render_packet } from '$lib/structure/scene/render-packet'
import type {
  BaseBondGraph,
  BoundaryPolicy,
  ImageInstanceTable,
  RenderPacket,
  RenderPacketDiff,
  ReplicaPickResult,
} from '$lib/structure/scene/render-packet'
import {
  build_image_instance_table,
  decode_replica_instance,
} from '$lib/structure/scene/replica-layout'
import { BOND_MIDPOINT_SPLIT } from '$lib/structure/rendering/bond-colors'
import {
  same_visual_shading,
  style_pbr,
  TOON_HIGHLIGHT_THRESHOLD,
  TOON_SHADOW_BRIGHTNESS,
  TOON_SHADOW_THRESHOLD,
  type ResolvedVisualShading,
} from '$lib/structure/rendering/visual-state'
import type {
  ComputeBondsTypedResult,
  TypedBondInput,
  TypedBondTable,
} from '$lib/structure/workers/bond-worker-runtime'
import {
  GIZMO_AXIS_HEX,
  GIZMO_NEG_AXIS_HEX,
  GIZMO_ORIENTATION_WGSL,
  gizmo_wgsl_color_vectors,
  resolve_gizmo_layout,
} from '$lib/structure/rendering/gizmo'

export { GIZMO_AXIS_HEX, GIZMO_NEG_AXIS_HEX }

/** Camera uniform (legacy 9.1): 20 floats (proj*view + camPos + pad) = 80 bytes. */
const CAMERA_UNIFORM_BYTES = 80

/** Camera uniform (9.2 impostor): view(16) + proj(16) + camPos vec3 + pad = 36
 *  floats = 144 bytes. Matches pack_camera_full's layout. */
const CAMERA_FULL_BYTES = 144

/** GPU supercell uniform (Phase 1): dims vec4<u32> (nx,ny,nz,base_count) + base
 *  lattice rows a,b,c as 3×vec4<f32> = 4 vec4 = 64 bytes. */
const SUPERCELL_BYTES = 64

/** Cell uniform: lattice rows + transformed origin + color, all vec4-aligned. */
export const CELL_BYTES = 80

/** Pure packing seam for the WebGL-equivalent transformed cell box. */
export function pack_cell_uniform(
  lattice: ArrayLike<number>,
  origin: readonly [number, number, number],
  color: readonly [number, number, number],
): Float32Array {
  const data = new Float32Array(CELL_BYTES / Float32Array.BYTES_PER_ELEMENT)
  data[0] = lattice[0] ?? 0
  data[1] = lattice[1] ?? 0
  data[2] = lattice[2] ?? 0
  data[4] = lattice[3] ?? 0
  data[5] = lattice[4] ?? 0
  data[6] = lattice[5] ?? 0
  data[8] = lattice[6] ?? 0
  data[9] = lattice[7] ?? 0
  data[10] = lattice[8] ?? 0
  data[12] = origin[0]
  data[13] = origin[1]
  data[14] = origin[2]
  data[16] = color[0]
  data[17] = color[1]
  data[18] = color[2]
  data[19] = 1
  return data
}


/** Vertices per bond half. Each half is an IMPOSTOR cylinder: a camera-facing
 *  billboard whose fragment shader ray-traces a mathematically smooth, capped
 *  finite cylinder. Constant low vertex count regardless of curvature (no
 *  facets), matching the atom impostor approach.
 *
 *  The billboard is a 6-vertex triangle-STRIP "hull" of two screen-aligned
 *  squares (one per endpoint, each side ~2r) — a capsule-bounding hexagon. This
 *  ALWAYS covers the full projected capsule silhouette from any view angle:
 *  - end-on (axis pointing at the eye, v0≈v1 in screen XY): each square is still
 *    a full 2r×2r screen quad, so the cap disk (radius r) is fully rasterized —
 *    no hollow ring. A degenerate single-vertex ribbon could not do this.
 *  - side / oblique long bonds: each endpoint square is anchored at that
 *    endpoint's OWN view-space depth, so perspective foreshortening can't clip
 *    the silhouette at grazing angles (a single-depth screen quad would).
 *
 *  This is the single source of truth for the indirect-args vertex_count
 *  (`cfg.x`) and MUST stay in sync with the render pipeline topology
 *  (triangle-strip ⇒ this many verts). */
const BOND_VERTS_PER_CYLINDER = 6

/** Bond-render uniform: 3 padded lattice rows + 2 style vec4s. The final three
 *  lanes remain reserved so the established 80-byte ABI does not move; rendered
 *  endpoint colors come exclusively from the authoritative atom-color buffer. */
export const BOND_RENDER_BYTES = 80

export type LargeSystemBondStyle = {
  /** Cylinder radius in Å; fed by the viewer's bond_thickness setting. */
  radius: number
  /** Shorten incomplete periodic half-edges instead of ending at the midpoint. */
  incomplete_edge_mode: boolean
  /** Fraction of the historical midpoint half-edge length, clamped to [0.05, 1]. */
  incomplete_edge_length_scale: number
  /** Collapse incomplete boundary edges when no real/ghost partner is drawn. */
  hide_incomplete_bonds: boolean
  /** Opacity of incomplete periodic half-edges (full/ghost-complete edges stay opaque). */
  periodic_bond_opacity: number
}

const DEFAULT_BOND_STYLE: LargeSystemBondStyle = {
  radius: 0.07,
  incomplete_edge_mode: false,
  incomplete_edge_length_scale: 1,
  hide_incomplete_bonds: false,
  periodic_bond_opacity: 1,
}

/** Normalize DOM/settings inputs once at the renderer boundary. */
export function normalize_bond_style(
  style: Partial<LargeSystemBondStyle> = {},
): LargeSystemBondStyle {
  const radius = Number.isFinite(style.radius) && (style.radius as number) > 0
    ? style.radius as number
    : DEFAULT_BOND_STYLE.radius
  const raw_scale = Number.isFinite(style.incomplete_edge_length_scale)
    ? style.incomplete_edge_length_scale as number
    : DEFAULT_BOND_STYLE.incomplete_edge_length_scale
  const raw_opacity = Number.isFinite(style.periodic_bond_opacity)
    ? style.periodic_bond_opacity as number
    : DEFAULT_BOND_STYLE.periodic_bond_opacity
  return {
    radius,
    incomplete_edge_mode: style.incomplete_edge_mode === true,
    incomplete_edge_length_scale: Math.max(0.05, Math.min(1, raw_scale)),
    hide_incomplete_bonds: style.hide_incomplete_bonds === true,
    periodic_bond_opacity: Math.max(0, Math.min(1, raw_opacity)),
  }
}

/** Pure std140-compatible packer shared by production uploads and tests. */
export function pack_bond_render_uniform(
  lattice: Float32Array,
  style: LargeSystemBondStyle,
): Float32Array {
  const u = new Float32Array(BOND_RENDER_BYTES / 4)
  u[0] = lattice[0]; u[1] = lattice[1]; u[2] = lattice[2]; u[3] = 0
  u[4] = lattice[3]; u[5] = lattice[4]; u[6] = lattice[5]; u[7] = 0
  u[8] = lattice[6]; u[9] = lattice[7]; u[10] = lattice[8]; u[11] = 0
  u[12] = style.radius
  u[13] = style.incomplete_edge_mode ? 1 : 0
  u[14] = style.incomplete_edge_length_scale
  u[15] = style.hide_incomplete_bonds ? 1 : 0
  u[16] = style.periodic_bond_opacity
  // u[17..19] are reserved to retain the 80-byte BondU ABI.
  return u
}

/** Default clear color when no background is threaded in: a distinct dark
 *  background (near-black, faint blue tint) so flipping the toggle visibly
 *  swaps which canvas paints. Overridden by set_background to match the WebGL
 *  viewer's actual canvas background (so dark atoms keep their contrast). */
const CLEAR_COLOR: GPUColor = { r: 0.02, g: 0.03, b: 0.05, a: 1 }

const DEPTH_FORMAT: GPUTextureFormat = `depth24plus`

/** Shared WGSL: the linear-RGB → sRGB transfer curve, byte-for-byte the same
 *  piecewise function as `linearTosRGB` in the WebGL atom shader
 *  (src/lib/structure/atoms/AtomManagerInstances.svelte).
 *
 *  Why every fragment shader here MUST end with it: the swapchain is configured
 *  with `navigator.gpu.getPreferredCanvasFormat()`, which is a NON-sRGB format
 *  (`bgra8unorm` on every current platform). WebGPU therefore performs no
 *  automatic encode on write — whatever a shader returns is what the display
 *  shows, bit for bit. Every colour reaching these shaders is LINEAR (atom
 *  colours, cell edge, bond grey, depth-cue background), so without this the
 *  overlay displays linear values as though they were sRGB. That crushes the
 *  mid-tones toward black — grey #808080 lands on 41/255 instead of 128/255 —
 *  which is what made the cell box and bonds nearly invisible and flattened
 *  every sphere's shaded limb into the background. */
const LINEAR_TO_SRGB_WGSL = `
fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}
`

/** TS twin of LINEAR_TO_SRGB_WGSL, for colours that bypass a shader — i.e. the
 *  render-pass `clearValue`, which the driver writes into the (non-sRGB) target
 *  verbatim. */
function linear_to_srgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055
}

/** Atom shading uniform: 6 × vec4 = 96 bytes. Carries the SAME knobs the WebGL
 *  atom shader takes as uniforms, so the two paths shade identically:
 *    0: light_dir.xyz (view-space headlamp) | w = 1 when the camera is orthographic
 *    1: ambient | directional | spec_strength | roughness
 *    2: metalness | render_style (0 glossy, 1 matte, 2 toon) | outline | depth_cueing
 *    3: depth_near | depth_far | bond_outline | pad
 *    4: depth_cue_bg.rgb (LINEAR — the shader encodes it) | pad
 *    5: toon shadow_threshold | highlight_threshold | shadow_brightness | pad */
const SHADING_FLOATS = 24
const SHADING_BYTES = SHADING_FLOATS * Float32Array.BYTES_PER_ELEMENT

/** Neutral defaults, used until the overlay pushes the viewer's real settings.
 *  Mirrors the `glossy` lighting profile + depth cueing off. */
const DEFAULT_SHADING: ResolvedVisualShading = {
  light_dir: [0, 0, 1],
  is_ortho: false,
  ambient: 0.6,
  directional: 2.2,
  spec_strength: 1,
  ...style_pbr(`glossy`),
  render_style: 0,
  outline: 0,
  bond_outline: 0,
  depth_cueing: 0,
  depth_near: 0,
  depth_far: 10,
  depth_bg: [0, 0, 0],
  toon_shadow_threshold: TOON_SHADOW_THRESHOLD,
  toon_highlight_threshold: TOON_HIGHLIGHT_THRESHOLD,
  toon_shadow_brightness: TOON_SHADOW_BRIGHTNESS,
}

/** Compatibility name for callers migrating to the shared visual-state core.
 *  The renderer itself consumes ResolvedVisualShading directly. */
export type LargeSystemShading = ResolvedVisualShading

/** Pack the shared shading snapshot into the six-vec4 WGSL uniform layout. */
function pack_shading_uniform(state: ResolvedVisualShading): Float32Array {
  const f = new Float32Array(SHADING_FLOATS)
  // vec4 0: headlamp xyz + is_ortho flag
  f[0] = state.light_dir[0]
  f[1] = state.light_dir[1]
  f[2] = state.light_dir[2]
  f[3] = state.is_ortho ? 1 : 0
  // vec4 1: ambient, directional, spec_strength, roughness
  f[4] = state.ambient
  f[5] = state.directional
  f[6] = state.spec_strength
  f[7] = state.roughness
  // vec4 2: metalness, render_style, outline, depth_cueing
  f[8] = state.metalness
  f[9] = state.render_style
  f[10] = state.outline
  f[11] = state.depth_cueing
  // vec4 3: depth near/far, bond-only outline (+ 1 zero-initialized pad)
  f[12] = state.depth_near
  f[13] = state.depth_far
  f[14] = state.bond_outline
  // vec4 4: depth-cue background, LINEAR rgb (+ zero padding)
  f[16] = state.depth_bg[0]
  f[17] = state.depth_bg[1]
  f[18] = state.depth_bg[2]
  // vec4 5: toon thresholds (+ zero padding)
  f[20] = state.toon_shadow_threshold
  f[21] = state.toon_highlight_threshold
  f[22] = state.toon_shadow_brightness
  return f
}

/** Keep the cached comparison snapshot independent of caller-owned tuples. */
function snapshot_shading(state: ResolvedVisualShading): ResolvedVisualShading {
  return {
    ...state,
    light_dir: [...state.light_dir],
    depth_bg: [...state.depth_bg],
  }
}

/** MSAA sample count for the overlay. 4× MSAA + alpha-to-coverage gives the
 *  impostor silhouettes (defined by fragment discard / ray-miss) smooth,
 *  analytically-AA'd edges that match the WebGL view's `antialias:true`. Both
 *  the color and depth render targets are multisampled at this count; the color
 *  target resolves into the swapchain texture each frame. */
const SAMPLE_COUNT = 4

/** WGSL cell-box line shader. Draws the 12 edges of the parallelepiped spanned
 *  by lattice vectors a,b,c as a `line-list` (24 vertices = 12 edges × 2 ends).
 *  Corners are generated in the vertex shader from transformed lattice vectors
 *  and the transformed cell origin. This matches the WebGL scene group's
 *  T(target)·R·T(-target) transform for both atoms and the lattice box.
 *  Lattice convention: lat0/lat1/lat2 are rows a/b/c of the row-major 9-float
 *  matrix (same as the bond render uniform), so corner(i) = bit0·a + bit1·b +
 *  bit2·c. Depth uses the SAME GL→WebGPU clip-z remap as the atom impostor so the
 *  box shares the depth buffer and is occluded by atoms in front. */
const CELL_LINE_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};
// Cell uniform: lattice rows a,b,c + transformed origin + color.
struct CellU {
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
  origin : vec4<f32>,
  color : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<uniform> cell : CellU;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec3<f32>,
};

// 12 edges as corner-index pairs. Corner i = bit0·a + bit1·b + bit2·c.
const EDGES = array<vec2<u32>, 12>(
  vec2<u32>(0u, 1u), vec2<u32>(0u, 2u), vec2<u32>(0u, 4u),
  vec2<u32>(1u, 3u), vec2<u32>(1u, 5u), vec2<u32>(2u, 3u),
  vec2<u32>(2u, 6u), vec2<u32>(4u, 5u), vec2<u32>(4u, 6u),
  vec2<u32>(3u, 7u), vec2<u32>(5u, 7u), vec2<u32>(6u, 7u),
);

fn corner(i : u32) -> vec3<f32> {
  let fa = f32(i & 1u);
  let fb = f32((i >> 1u) & 1u);
  let fc = f32((i >> 2u) & 1u);
  return cell.origin.xyz
    + fa * cell.lat0.xyz + fb * cell.lat1.xyz + fc * cell.lat2.xyz;
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VsOut {
  let edge = EDGES[vi / 2u];
  let ci = select(edge.x, edge.y, (vi & 1u) == 1u);
  let world = corner(ci);
  var clip = camera.proj * (camera.view * vec4<f32>(world, 1.0));
  // SAME GL->WebGPU NDC z remap as the atom impostor shader.
  clip.z = (clip.z + clip.w) * 0.5;

  var out : VsOut;
  out.clip = clip;
  out.color = cell.color.xyz;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // cell.color is LINEAR (hex_to_linear_rgb) — encode, or the default #808080
  // grey box paints at 41/255 instead of 128/255 and all but disappears.
  return vec4<f32>(linear_to_srgb(in.color), 1.0);
}
` + LINEAR_TO_SRGB_WGSL

/** WGSL axis-orientation gizmo. A WebGPU replica of the WebGL viewer's
 *  three-viewport-gizmo widget (sphere type, as configured in StructureScene's
 *  gizmo_props), which is gone while WebGL is suspended in overlay mode. Visual
 *  spec mirrored from that library's sphere layout:
 *    - internal ortho frame spans ±1.8 units across the widget; axis heads sit
 *      at ±1.0 unit along each (camera-rotation-projected) axis
 *    - positive heads: filled circle, radius 0.35 unit, axis-colored, with the
 *      axis letter inside (labelColor #111) and a line from the center
 *    - negative heads: smaller filled circle (0.225 unit), darker negative
 *      color, no letter, no line
 *    - lines: 4 px wide (lineWidth default), origin → head center
 *    - opacities: 0.8 positive / 0.9 negative (StructureScene's axis_options)
 *  Rendered as ONE triangle-strip quad; the fragment shader draws everything
 *  analytically (SDF circles / round-capped segments, 0.75 px edge ramps) so
 *  every edge is antialiased — no 1 px line-list aliasing. Elements composite
 *  back-to-front (painter's algorithm on the rotated z) inside the shader and
 *  the premultiplied result alpha-blends over the scene.
 *
 *  Orientation uses ONLY the camera view ROTATION (upper-3×3 of camera.view),
 *  so the triad spins with the camera but stays pinned to its corner. A head
 *  pointing at the viewer projects toward the widget center — same as the
 *  WebGL gizmo. Shared DISPLAY-space colors from rendering/gizmo.ts are written
 *  verbatim to the non-sRGB target, with NO linear→sRGB encode — encoding would
 *  wash them out.
 *
 *  Always on top: depthCompare:`always`, no depth write, drawn LAST.
 *
 *  Exported so the parity unit test can check the generated WGSL table against
 *  the shared palette. */
export const GIZMO_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};
// Gizmo placement uniform (filled from canvas size + dpr + HUD safe-area):
//   place : xy = widget center in NDC, z = half-extent R in device px,
//           w = unit_px (R / 1.8 — the internal ortho unit in device px).
//   px    : xy = px→NDC scale (2/w, 2/h), z = line half-width in device px,
//           w unused.
struct GizmoU {
  place : vec4<f32>,
  px : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<uniform> giz : GizmoU;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) p : vec2<f32>, // local coords in device px, y-up, origin at center
};

// Shared axis basis + column-major view projection from rendering/gizmo.ts.
${GIZMO_ORIENTATION_WGSL}
// Shared positive-axis palette, generated from rendering/gizmo.ts.
const AXIS_COLORS = array<vec3<f32>, 3>(
${gizmo_wgsl_color_vectors(GIZMO_AXIS_HEX)}
);
// Shared negative-axis palette, generated from rendering/gizmo.ts.
const NEG_AXIS_COLORS = array<vec3<f32>, 3>(
${gizmo_wgsl_color_vectors(GIZMO_NEG_AXIS_HEX)}
);
const LABEL_COLOR = vec3<f32>(0.067, 0.067, 0.067); // labelColor #111
const POS_ALPHA : f32 = 0.8;   // positive-axis opacity (gizmo_props)
const NEG_ALPHA : f32 = 0.9;   // negative-axis opacity (gizmo_props)
// Sphere-layout metrics in internal ortho units (×unit_px → device px).
const HEAD_DIST : f32 = 1.0;    // head center distance from widget center
const POS_R : f32 = 0.35;       // positive head radius (sprite scale 0.7 / 2)
const NEG_R : f32 = 0.225;      // negative head radius (sprite scale 0.45 / 2)
const GLYPH_R : f32 = 0.185;    // letter half-height inside the positive head
const GLYPH_STROKE : f32 = 0.2; // letter stroke half-width, as a fraction of GLYPH_R

// Letter strokes on a [-1,1] template box (y-up), round-capped segments.
// (ax, ay, bx, by) per segment. X = segs 0-1, Y = 2-4, Z = 5-7.
const GLYPH_SEGS = array<vec4<f32>, 8>(
  vec4<f32>(-0.72, -1.0, 0.72, 1.0),  // X diagonal /
  vec4<f32>(-0.72, 1.0, 0.72, -1.0),  // X diagonal \\
  vec4<f32>(-0.72, 1.0, 0.0, 0.05),   // Y left arm
  vec4<f32>(0.72, 1.0, 0.0, 0.05),    // Y right arm
  vec4<f32>(0.0, 0.05, 0.0, -1.0),    // Y stem
  vec4<f32>(-0.62, 1.0, 0.62, 1.0),   // Z top bar
  vec4<f32>(0.62, 1.0, -0.62, -1.0),  // Z diagonal
  vec4<f32>(-0.62, -1.0, 0.62, -1.0), // Z bottom bar
);
const GLYPH_START = array<u32, 3>(0u, 2u, 5u);
const GLYPH_COUNT = array<u32, 3>(2u, 3u, 3u);

// Signed distance to the segment [a,b] (round caps come from the radius the
// caller subtracts).
fn sd_segment(p : vec2<f32>, a : vec2<f32>, b : vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// SDF → coverage with a fixed 0.75 px edge ramp (p is in device px, so no
// fwidth needed — distances ARE pixels).
fn cov(d : f32) -> f32 {
  return clamp(0.5 - d / 0.75, 0.0, 1.0);
}

// src-over: paint (rgb, a) on top of the premultiplied accumulator.
fn over(acc : vec4<f32>, rgb : vec3<f32>, a : f32) -> vec4<f32> {
  return vec4<f32>(rgb * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a));
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VsOut {
  // Full-widget quad as a 4-vert triangle-strip: (-1,-1) (1,-1) (-1,1) (1,1).
  let cx = select(-1.0, 1.0, (vi & 1u) == 1u);
  let cy = select(-1.0, 1.0, (vi & 2u) == 2u);
  let r_px = giz.place.z;
  var out : VsOut;
  out.p = vec2<f32>(cx, cy) * r_px;
  out.clip = vec4<f32>(giz.place.xy + out.p * giz.px.xy, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // Camera view ROTATION only — the triad orients with the camera.
  let unit = giz.place.w;

  // Rotated axes: screen offset (view-space xy, y-up — matches in.p) + depth.
  var head : array<vec2<f32>, 3>;
  var depth : array<f32, 3>;
  for (var i = 0u; i < 3u; i++) {
    let d = project_gizmo_axis(camera.view, i);
    head[i] = d.xy * (HEAD_DIST * unit);
    depth[i] = d.z;
  }

  var acc = vec4<f32>(0.0);

  // ── Axis lines: origin → positive head center, painted behind every head
  // (the WebGL gizmo's line meshes render under its head sprites). ──
  for (var i = 0u; i < 3u; i++) {
    let d = sd_segment(in.p, vec2<f32>(0.0), head[i]) - giz.px.z;
    acc = over(acc, AXIS_COLORS[i], POS_ALPHA * cov(d));
  }

  // ── Heads: 6 balls (±X ±Y ±Z), painter-sorted far → near on rotated z. ──
  // Encode each as axis index i + sign s; z = s·depth[i].
  var order = array<u32, 6>(0u, 1u, 2u, 3u, 4u, 5u); // 0-2 = +XYZ, 3-5 = −XYZ
  var zval : array<f32, 6>;
  for (var k = 0u; k < 6u; k++) {
    let i = k % 3u;
    zval[k] = select(depth[i], -depth[i], k >= 3u);
  }
  // Insertion sort ascending (most negative = farthest = painted first).
  for (var a = 1u; a < 6u; a++) {
    let key = order[a];
    let kz = zval[key];
    var b = a;
    for (; b > 0u && zval[order[b - 1u]] > kz; b--) {
      order[b] = order[b - 1u];
    }
    order[b] = key;
  }

  for (var k = 0u; k < 6u; k++) {
    let id = order[k];
    let i = id % 3u;
    let positive = id < 3u;
    let center = select(-head[i], head[i], positive);
    let radius = select(NEG_R, POS_R, positive) * unit;
    let ball_cov = cov(length(in.p - center) - radius);
    let color = select(NEG_AXIS_COLORS[i], AXIS_COLORS[i], positive);
    let alpha = select(NEG_ALPHA, POS_ALPHA, positive);
    acc = over(acc, color, alpha * ball_cov);

    if (positive) {
      // Letter inside the head, screen-flat. Union of the letter's stroke
      // segments, then painted once (overlapping strokes must not double-blend).
      let g = GLYPH_R * unit;
      let q = (in.p - center) / g;
      var dmin = 1e9;
      let s0 = GLYPH_START[i];
      for (var s = 0u; s < GLYPH_COUNT[i]; s++) {
        let seg = GLYPH_SEGS[s0 + s];
        dmin = min(dmin, sd_segment(q, seg.xy, seg.zw));
      }
      // Back to px, minus the stroke half-width; clip to the ball so AA fringes
      // never poke outside it.
      let letter_cov = min(cov(dmin * g - GLYPH_STROKE * g), ball_cov);
      acc = over(acc, LABEL_COLOR, POS_ALPHA * letter_cov);
    }
  }

  // Premultiplied out; the pipeline blends {one, one-minus-src-alpha}.
  return acc;
}
`

/** WGSL impostor-sphere shader. View-space billboard + per-fragment ray-sphere.
 *  - storage buffers: positions (3N), radii (N), colors (3N linear rgb)
 *  - camera uniform: view + proj (separate) + camPos
 *  Camera sits at the view-space origin, so the eye ray is just normalize(vpos). */
const IMPOSTOR_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};

// GPU supercell uniform (Phase 1). dims = [nx,ny,nz] tiling counts; base_count =
// atoms in the BASE cell. lat0/lat1/lat2 are the base lattice rows a,b,c (xyz in
// .xyz, w pad) — the per-cell offset is ix·a + iy·b + iz·c. Default dims (1,1,1)
// + base_count = the instance count ⇒ atom = inst, zero offset ⇒ identical draw.
struct Supercell {
  dims : vec4<u32>,    // x=nx, y=ny, z=nz, w=base_count
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> radii : array<f32>;
@group(0) @binding(3) var<storage, read> colors : array<f32>;
// Per-atom selection flag (1 = selected). Read in the fragment stage so selected
// atoms get a visible highlight (brighten + rim ring). Always bound (a 4-byte
// placeholder when nothing is selected), so 0 ⇒ unchanged appearance.
@group(0) @binding(4) var<storage, read> selected : array<u32>;
// GPU supercell instancing params. Read ONLY in the vertex stage (decode of
// instance_index into atom + cell offset), so the BGL grants it VERTEX only.
@group(0) @binding(5) var<uniform> supercell : Supercell;
// Sparse ghost-image instance table (packet path, boundary policy
// 'ghost-images'): ghost_sites[i] = the ghost's BASE atom index;
// ghost_images[i] = its ABSOLUTE image offset packed as
// (jx+128) | ((jy+128)<<8) | ((jz+128)<<16) (Int8 components biased into u8
// lanes). Ghost instances draw AFTER the base_count·ncells replica range;
// when none are uploaded the instance count never reaches that range and both
// buffers stay 4-byte placeholders. Read ONLY in vs_main ⇒ VERTEX-only BGL.
@group(0) @binding(6) var<storage, read> ghost_sites : array<u32>;
@group(0) @binding(7) var<storage, read> ghost_images : array<u32>;

// Atom shading uniform — the WebGL atom shader's uniform set, mirrored 1:1 so
// both renderers produce the same pixels. See ResolvedVisualShading (TS side).
struct Shading {
  light_dir : vec4<f32>,  // xyz = view-space headlamp, w = 1 when orthographic
  params0   : vec4<f32>,  // ambient, directional, spec_strength, roughness
  params1   : vec4<f32>,  // metalness, render_style, outline, depth_cueing
  depth_cue : vec4<f32>,  // near, far, bond_outline, pad
  depth_bg  : vec4<f32>,  // LINEAR rgb fade target + pad
  toon      : vec4<f32>,  // shadow_thr, highlight_thr, shadow_brightness, pad
};
@group(0) @binding(8) var<uniform> shading : Shading;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) vc : vec3<f32>,      // view-space sphere center
  @location(1) radius : f32,
  @location(2) color : vec3<f32>,
  @location(3) vpos : vec3<f32>,    // view-space position of this quad corner
  @location(4) @interpolate(flat) sel : u32, // 1 = this atom is selected
  @location(5) quad : vec2<f32>,    // billboard corner in [-1,1]
};

struct FsOut {
  @builtin(frag_depth) depth : f32,
  @location(0) color : vec4<f32>,
};

// Quad corners as a triangle-strip (4 verts): (-1,-1) (1,-1) (-1,1) (1,1)
fn corner_for(vi : u32) -> vec2<f32> {
  let x = select(-1.0, 1.0, (vi & 1u) == 1u);
  let y = select(-1.0, 1.0, (vi & 2u) == 2u);
  return vec2<f32>(x, y);
}

// ACES filmic tonemap — rolls off the HDR key light so glossy highlights read
// soft instead of clipping to white. Same curve as the WebGL atom shader.
fn aces_tonemap(x : vec3<f32>) -> vec3<f32> {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32,
           @builtin(instance_index) inst : u32) -> VsOut {
  // GPU supercell decode: instance = atom-within-base-cell + cell tiling index.
  // base_count = supercell.dims.w; cell = inst / base_count; the per-cell integer
  // (ix,iy,iz) gives the lattice offset ix·a + iy·b + iz·c. When dims = (1,1,1)
  // and base_count = the instance count, atom = inst, cell = 0, offset = 0 ⇒
  // byte-identical to the non-supercell path. Per-atom radii/colors/selected are
  // indexed by atom (NOT inst) so every replica shares the base atom's look.
  let base_count = max(supercell.dims.w, 1u);
  let nx = max(supercell.dims.x, 1u);
  let ny = max(supercell.dims.y, 1u);
  let nz = max(supercell.dims.z, 1u);
  let real_count = base_count * nx * ny * nz;
  var atom : u32;
  var offset : vec3<f32>;
  if (inst < real_count) {
    atom = inst % base_count;
    let cell = inst / base_count;
    let ix = cell % nx;
    let iy = (cell / nx) % ny;
    let iz = cell / (nx * ny);
    offset = f32(ix) * supercell.lat0.xyz
           + f32(iy) * supercell.lat1.xyz
           + f32(iz) * supercell.lat2.xyz;
  } else {
    // Ghost image instance: a BASE atom drawn at an ABSOLUTE image offset
    // (which may lie outside [0, dims)). Radii / colors / selection all index
    // by the base atom, so every ghost shares its base atom's look + highlight.
    let gi = inst - real_count;
    atom = ghost_sites[gi];
    let packed = ghost_images[gi];
    let jx = f32(i32(packed & 0xffu) - 128);
    let jy = f32(i32((packed >> 8u) & 0xffu) - 128);
    let jz = f32(i32((packed >> 16u) & 0xffu) - 128);
    offset = jx * supercell.lat0.xyz
           + jy * supercell.lat1.xyz
           + jz * supercell.lat2.xyz;
  }

  let center = vec3<f32>(
    positions[atom * 3u + 0u],
    positions[atom * 3u + 1u],
    positions[atom * 3u + 2u],
  ) + offset;
  let r = radii[atom];
  let col = vec3<f32>(
    colors[atom * 3u + 0u],
    colors[atom * 3u + 1u],
    colors[atom * 3u + 2u],
  );

  let vc4 = camera.view * vec4<f32>(center, 1.0);
  let vc = vc4.xyz;

  let c = corner_for(vi);
  // Billboard in view space, expanded by the SAME 1.05 the WebGL atom shader
  // uses (enough to clear the silhouette at grazing angles, no more). The
  // fragment stage reconstructs the ray from this exact factor, so the two must
  // stay identical — a mismatch skews the analytic edge coverage.
  let vpos = vc + vec3<f32>(c * r * 1.05, 0.0);
  var clip = camera.proj * vec4<f32>(vpos, 1.0);
  // three.js projectionMatrix uses GL NDC z in [-1,1]; WebGPU clip space needs
  // 0 <= z <= w (NDC z in [0,1]). Remap before returning @builtin(position).
  clip.z = (clip.z + clip.w) * 0.5;

  var out : VsOut;
  out.clip = clip;
  out.vc = vc;
  out.radius = r;
  out.color = col;
  out.vpos = vpos;
  out.sel = selected[atom];
  out.quad = c;
  return out;
}

// Port of the WebGL atom fragment shader
// (src/lib/structure/atoms/AtomManagerInstances.svelte). Every step below has a
// twin there — ray-sphere in view space, analytic edge coverage, the three
// shading branches, the sRGB encode, depth cueing, the outline. Keep them in
// lockstep: any divergence is a visible regression the moment the user toggles
// performance mode.
@fragment
fn fs_main(in : VsOut) -> FsOut {
  let is_ortho = shading.light_dir.w > 0.5;
  let r = in.radius;
  let r2 = r * r;

  // This fragment's view-space position on the billboard. The quad is expanded
  // in view XY only, so z is the sphere-center depth — exactly the WebGL
  // shader's fragViewPos.
  let offset = in.quad * r * 1.05;
  let frag_view_pos = vec3<f32>(in.vc.xy + offset, in.vc.z);
  let ray_dir = normalize(frag_view_pos);

  // Perpendicular eye-ray→center distance. Cross-product form, NOT the algebraic
  // b²−c: that one subtracts two ~|vc|² values and loses precision once centers
  // carry large lattice offsets — i.e. exactly the supercells this mode exists
  // for — which shows up as concentric banding across each sphere. The WebGL
  // path made the same switch for the same reason.
  let d_persp = length(cross(in.vc, ray_dir));
  let d_ortho = length(offset);
  let d = select(d_persp, d_ortho, is_ortho);

  // Analytic ~1px silhouette coverage on the RADIAL distance, fed to
  // alpha-to-coverage so the curved edge antialiases (a hard discard gives MSAA
  // no sub-pixel coverage to work with). fwidth() is evaluated HERE, at top
  // level in uniform control flow, before any branching.
  let coverage = clamp((r - d) / max(fwidth(d), 1e-8) + 0.5, 0.0, 1.0);
  if (coverage <= 0.0) {
    discard;
  }

  // thc clamped so grazing fragments (d slightly > r, inside the coverage band)
  // still resolve to a finite hit point to shade.
  let d2 = d * d;
  let thc = sqrt(max(r2 - min(d2, r2), 0.0));

  var hit_pos : vec3<f32>;
  var normal : vec3<f32>;
  if (is_ortho) {
    // Orthographic: ray direction is −Z, so the perpendicular offset IS the
    // fragment's XY offset from the center.
    hit_pos = vec3<f32>(in.vc.xy + offset, in.vc.z + thc);
    normal = vec3<f32>(offset, thc) / r;
  } else {
    let tca = dot(in.vc, ray_dir);
    hit_pos = (tca - thc) * ray_dir;
    // Normal WITHOUT hit_pos − vc (another large-value subtraction):
    //   hit_pos − vc = −thc·ray_dir − L_perp,  where L_perp = vc − tca·ray_dir
    let l_perp = in.vc - tca * ray_dir;
    normal = normalize(-thc * ray_dir - l_perp);
  }

  let light_dir_view = normalize(shading.light_dir.xyz);
  let view_dir = select(normalize(-hit_pos), vec3<f32>(0.0, 0.0, 1.0), is_ortho);

  let ambient      = shading.params0.x;
  let directional  = shading.params0.y;
  let spec_str     = shading.params0.z;
  let rough        = shading.params0.w;
  let metalness    = shading.params1.x;
  let style        = i32(shading.params1.y + 0.5);
  let outline      = shading.params1.z;
  let depth_cueing = shading.params1.w;

  let base_color = in.color;

  var color : vec3<f32>;
  if (style == 2) {
    // ── Toon: 3-band cel shading (the app's DEFAULT render_style) ──
    let diffuse = dot(normal, light_dir_view);
    if (diffuse > shading.toon.y) {
      color = vec3<f32>(1.0, 1.0, 1.0);
    } else if (diffuse > shading.toon.x) {
      color = base_color;
    } else {
      color = base_color * shading.toon.z;
    }
  } else if (style == 1) {
    // ── Matte / 2.5D / 2D-flat: diffuse-only Lambert, no specular ──
    let diffuse = max(dot(normal, light_dir_view), 0.0);
    color = base_color * (ambient + directional * diffuse);
  } else {
    // ── Glossy / metallic: Cook-Torrance GGX, lit by ambient fill + an HDR
    //    near-head-on key, rolled back to display range by ACES. roughness /
    //    metalness are per-render-style (glossy 0.2/0.0, metallic 0.4/0.4).
    //    matcap has no branch here and resolves to glossy — see the overlay. ──
    let a = rough * rough;
    let a2 = a * a;
    let n_dot_l = max(dot(normal, light_dir_view), 0.0);
    let n_dot_v = max(dot(normal, view_dir), 1e-4);
    let half_dir = normalize(light_dir_view + view_dir);
    let n_dot_h = max(dot(normal, half_dir), 0.0);
    let v_dot_h = max(dot(view_dir, half_dir), 0.0);
    // GGX normal distribution — the tight lobe that makes the small hot spot.
    let dn = (n_dot_h * n_dot_h) * (a2 - 1.0) + 1.0;
    let ggx_d = a2 / (3.14159265 * dn * dn);
    // Smith-Schlick geometry.
    let k = a * 0.5;
    let ggx_g = (n_dot_v / (n_dot_v * (1.0 - k) + k)) * (n_dot_l / (n_dot_l * (1.0 - k) + k));
    // Schlick Fresnel with a metalness-tinted F0: dielectric 0.04, metals
    // reflect their own (element) colour.
    let f0 = mix(vec3<f32>(0.04), base_color, metalness);
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
    let specular = (ggx_d * ggx_g) * fresnel / (4.0 * n_dot_v * n_dot_l + 1e-4);
    // Metals have little/no diffuse — attenuate by (1 − metalness).
    let diffuse_color = base_color * (1.0 - metalness);
    // Energy-conserving Lambert (÷π) on the key, like MeshStandardMaterial;
    // without it the base×key diffuse blows out.
    var lit = diffuse_color * (ambient + directional * n_dot_l * 0.31831)
            + specular * directional * n_dot_l * spec_str;
    // Soft rim shadow at the grazing silhouette — a little volume / AO feel.
    lit = lit * mix(0.6, 1.0, smoothstep(0.0, 0.5, n_dot_v));
    color = aces_tonemap(lit);
  }

  // ── Selection highlight ──────────────────────────────────────────────────
  // Overlay-only affordance (the WebGL view draws separate highlight meshes):
  // brighten the body and add a cyan rim where the eye ray grazes the
  // silhouette. Applied in LINEAR space, before the encode below.
  if (in.sel == 1u) {
    let rim = pow(1.0 - clamp(dot(normal, view_dir), 0.0, 1.0), 2.0);
    let tint = vec3<f32>(0.25, 0.95, 1.0); // bright cyan
    color = mix(color * 1.35 + tint * 0.25, tint, rim * 0.85);
  }

  // Linear → sRGB. Everything past this point is in DISPLAY space — which is
  // why the depth-cue target is encoded too, rather than mixed in linear.
  var rgb = linear_to_srgb(color);

  // Depth cueing (VESTA / 3Dmol-style fog): fade toward the background with
  // view-space depth. ON by default (0.4) in the viewer, and the main thing that
  // gives a dense structure front-to-back separation.
  if (depth_cueing > 0.0) {
    let depth_z = -hit_pos.z;
    let span = max(shading.depth_cue.y - shading.depth_cue.x, 0.01);
    let fade = clamp((depth_z - shading.depth_cue.x) / span, 0.0, 1.0) * depth_cueing;
    rgb = mix(rgb, linear_to_srgb(shading.depth_bg.xyz), fade);
  }

  // Silhouette outline: darken pixels at glancing angles.
  if (outline > 0.0) {
    let silhouette = smoothstep(0.55, 1.0, 1.0 - max(dot(normal, view_dir), 0.0));
    rgb = mix(rgb, vec3<f32>(0.0), silhouette * outline);
  }

  // Correct depth: project the hit point, apply the same GL→WebGPU z remap as
  // the vertex stage, then perspective-divide into NDC z (WebGPU range 0..1).
  let clip_h = camera.proj * vec4<f32>(hit_pos, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  // alpha = coverage feeds alpha-to-coverage; no alpha blending is enabled, so
  // the color target stays opaque.
  out.color = vec4<f32>(rgb, coverage);
  return out;
}
` + LINEAR_TO_SRGB_WGSL

/** WGSL atom PICK shader. Re-runs the SAME impostor sphere ray-trace as
 *  IMPOSTOR_WGSL, INCLUDING the identical GPU-supercell instance decode (Phase 4):
 *  the pass is instanced exactly like the atom draw (atom_count·ncells instances),
 *  so a click in supercell mode hits the right replica. It writes the GLOBAL
 *  instance index + 1 (so 0 stays free for "background") into an R32Uint id buffer
 *  instead of a shaded color; pick() decodes that raw id back to the BASE atom
 *  index. Renders single-sampled (no MSAA) with its own single-sample depth, so
 *  the front-most atom at each pixel wins the depth test and its id is what gets
 *  read back. Only the disk interior is written (the analytic AA band is skipped —
 *  a hard discard is correct for picking, no fractional ids). The fragment writes
 *  the same corrected sphere depth as the color pass so overlapping atoms resolve
 *  by true depth, not draw order. When dims = (1,1,1) the decode collapses to
 *  atom = inst / id = inst + 1 ⇒ byte-identical to the pre-Phase-4 pick. */
const PICK_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};

// GPU supercell uniform (Phase 4). SAME layout as the atom impostor's Supercell:
// dims = [nx,ny,nz,base_count]; lat0/1/2 = base lattice rows a,b,c (xyz + pad).
// Read ONLY in vs_main (decode of instance_index into atom + cell offset), so the
// BGL grants it VERTEX visibility only. Default dims (1,1,1) + base_count = the
// instance count ⇒ atom = inst, cell = 0, zero offset ⇒ identical pick.
struct Supercell {
  dims : vec4<u32>,    // x=nx, y=ny, z=nz, w=base_count
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> radii : array<f32>;
@group(0) @binding(3) var<uniform> supercell : Supercell;
// Sparse ghost-image instance table — SAME layout + decode as the atom
// impostor's bindings 6/7 (see IMPOSTOR_WGSL). Ghost instances draw after the
// base_count·ncells replica range, so their ids (inst + 1) land past it and
// pick() maps them back through the CPU-side ImageInstanceTable. VERTEX-only.
@group(0) @binding(4) var<storage, read> ghost_sites : array<u32>;
@group(0) @binding(5) var<storage, read> ghost_images : array<u32>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) vc : vec3<f32>,
  @location(1) radius : f32,
  @location(2) vpos : vec3<f32>,
  @location(3) @interpolate(flat) id : u32, // global instance_index + 1
};

struct FsOut {
  @builtin(frag_depth) depth : f32,
  @location(0) id : u32,
};

fn corner_for(vi : u32) -> vec2<f32> {
  let x = select(-1.0, 1.0, (vi & 1u) == 1u);
  let y = select(-1.0, 1.0, (vi & 2u) == 2u);
  return vec2<f32>(x, y);
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32,
           @builtin(instance_index) inst : u32) -> VsOut {
  // SAME GPU supercell decode as IMPOSTOR_WGSL.vs_main: instance = atom-within-
  // base-cell + cell tiling index. base_count = supercell.dims.w; the per-cell
  // integer (ix,iy,iz) gives the lattice offset ix·a + iy·b + iz·c. When dims =
  // (1,1,1) and base_count = the instance count, atom = inst, cell = 0, offset =
  // 0 ⇒ center = positions[inst], byte-identical to the pre-Phase-4 pick.
  let base_count = max(supercell.dims.w, 1u);
  let nx = max(supercell.dims.x, 1u);
  let ny = max(supercell.dims.y, 1u);
  let nz = max(supercell.dims.z, 1u);
  let real_count = base_count * nx * ny * nz;
  var atom : u32;
  var offset : vec3<f32>;
  if (inst < real_count) {
    atom = inst % base_count;
    let cell = inst / base_count;
    let ix = cell % nx;
    let iy = (cell / nx) % ny;
    let iz = cell / (nx * ny);
    offset = f32(ix) * supercell.lat0.xyz
           + f32(iy) * supercell.lat1.xyz
           + f32(iz) * supercell.lat2.xyz;
  } else {
    // Ghost image instance (SAME decode as IMPOSTOR_WGSL bindings 6/7).
    let gi = inst - real_count;
    atom = ghost_sites[gi];
    let packed = ghost_images[gi];
    let jx = f32(i32(packed & 0xffu) - 128);
    let jy = f32(i32((packed >> 8u) & 0xffu) - 128);
    let jz = f32(i32((packed >> 16u) & 0xffu) - 128);
    offset = jx * supercell.lat0.xyz
           + jy * supercell.lat1.xyz
           + jz * supercell.lat2.xyz;
  }

  let center = vec3<f32>(
    positions[atom * 3u + 0u],
    positions[atom * 3u + 1u],
    positions[atom * 3u + 2u],
  ) + offset;
  let r = radii[atom];

  let vc4 = camera.view * vec4<f32>(center, 1.0);
  let vc = vc4.xyz;

  let c = corner_for(vi);
  let vpos = vc + vec3<f32>(c * r * 1.5, 0.0);
  var clip = camera.proj * vec4<f32>(vpos, 1.0);
  clip.z = (clip.z + clip.w) * 0.5;

  var out : VsOut;
  out.clip = clip;
  out.vc = vc;
  out.radius = r;
  out.vpos = vpos;
  out.id = inst + 1u;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> FsOut {
  let ro = vec3<f32>(0.0, 0.0, 0.0);
  let rd = normalize(in.vpos);

  let oc = ro - in.vc;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - in.radius * in.radius;
  let disc = b * b - c;
  // Hard silhouette for picking — no AA band (an id can't be fractional).
  if (disc < 0.0) { discard; }
  let t = -b - sqrt(disc);
  if (t < 0.0) { discard; }
  let p = ro + t * rd;

  let clip_h = camera.proj * vec4<f32>(p, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  out.id = in.id;
  return out;
}
`

/** Tiny 1-thread compute: read the atomic bond `count`, clamp to capacity, and
 *  write draw-indirect args [vertex_count, instance_count, first_vertex,
 *  first_instance] so the bond draw uses drawIndirect with zero CPU readback.
 *  Each detected bond renders as TWO half-cylinder instances (half 0 rooted at
 *  atom A, half 1 rooted at atom B), so instance_count = 2 * clamped_bond_count.
 *  The pairs buffer is unchanged (one entry per bond); the bond vertex shader
 *  maps instance_index -> (bond_index = inst>>1, half = inst&1). */
const INDIRECT_ARGS_WGSL = `
struct Args {
  vertex_count : u32,
  instance_count : u32,
  first_vertex : u32,
  first_instance : u32,
};
@group(0) @binding(0) var<storage, read> count : array<u32>;
@group(0) @binding(1) var<storage, read_write> args : Args;

// cfg: x = vertex_count_per_cylinder, y = capacity (clamp), z = ncells (supercell
// tiling product nx·ny·nz). GPU supercell Phase 2 replicates each bond into every
// cell, so the bond draw issues 2 · bond_count · ncells instances (two half-
// cylinders per bond per cell). ncells defaults to 1 ⇒ 2·bond_count, the Phase-1
// single-cell count (byte-identical).
@group(0) @binding(2) var<uniform> cfg : vec3<u32>;
// Clamped bond_count, written here so the bond RENDER vertex shader can decode
// inst → (cell, bond_index, half) without reading the atomic count buffer. The
// render shader needs the SAME clamped value used for instance_count below.
@group(0) @binding(3) var<storage, read_write> bond_meta : array<u32>;

@compute @workgroup_size(1)
fn build_args() {
  let raw = count[0];
  let inst = min(raw, cfg.y);
  let ncells = max(cfg.z, 1u);
  args.vertex_count = cfg.x;
  // two half-cylinders per bond, replicated into every supercell cell.
  args.instance_count = inst * 2u * ncells;
  args.first_vertex = 0u;
  args.first_instance = 0u;
  bond_meta[0] = inst; // clamped bond_count for the render-side decode
}
`

/** Instanced IMPOSTOR-cylinder bond shader. Each detected bond renders as TWO
 *  half instances that meet at the bond midpoint, so PBC (cross-cell) bonds
 *  become two short stubs each rooted at a REAL atom instead of one long cylinder
 *  jutting out of the cell. Instance mapping: bond_index = inst>>1, half = inst&1.
 *  Per bond reads (a, b, jimage_packed) from the pairs buffer (unchanged — one
 *  entry per bond); the imaged partner is shifted by jimage·lattice using the
 *  SAME lattice the compute used.
 *    Let A = pos[a], partnerB = pos[b] + jimage·lattice (A's imaged partner),
 *        B = pos[b], partnerA = pos[a] - jimage·lattice (B's imaged partner).
 *    half 0: cylinder A      -> M0 = (A + partnerB) * 0.5
 *    half 1: cylinder B      -> M1 = (B + partnerA) * 0.5
 *  For CROSS-cell bonds (jimage != 0) this yields the two short stubs above.
 *  For INTRA-cell bonds (jimage = 0) the two halves would be collinear and their
 *  flat midpoint cap planes coincide -> coincident depth -> alpha-to-coverage
 *  z-fight that shows as a faint dotted seam across the cylinder. To avoid it,
 *  intra-cell bonds instead draw ONE full cylinder (half 0: A -> B) and collapse
 *  half 1 to a degenerate offscreen billboard (zero fragments). Jimages use
 *  three biased u8 lanes, preserving the full signed Int8 BaseBondGraph range.
 *
 *  GEOMETRY (impostor, NGL/3Dmol-style — no facets, constant 4 verts/half):
 *  Each half's segment endpoints P0=start, P1=end are transformed to VIEW space
 *  (v0,v1). A camera-facing ribbon quad is built that fully covers the finite
 *  capsule: the quad's long edge runs along the view-space axis â=normalize(v1-v0),
 *  extended past BOTH ends by the radius r so the round caps are inside the quad;
 *  the quad's width is ±r along a camera-facing perpendicular
 *  side=normalize(cross(â, toEye)) (toEye = -mid, eye at origin), with a small
 *  blow-up so the silhouette of the perspective-projected cylinder is never
 *  clipped. The 4 triangle-strip corners map (vi&1)->±side, (vi&2)->P0/P1 end.
 *
 *  The fragment shader ray-traces the FINITE cylinder: eye ray O=0, d=normalize(vpos);
 *  solve the infinite-cylinder quadratic, clamp the body hit's axial projection to
 *  [0,len]; if out of range, intersect the two END-CAP disks (planes at v0,v1 with
 *  normal ∓â, |radial|<=r) so the cylinder is SOLID (no hollow ends — caps are free
 *  from the disk test). No hit anywhere => discard. Lambert shading like the atoms
 *  (0.35 + 0.65·max(dot(N,L),0), same light dir) × grey color. Depth: project the
 *  view-space hit Pv and apply the SAME GL→WebGPU clip-z remap + perspective divide
 *  as the sphere impostor, so bonds share the depth buffer and occlude / are
 *  occluded consistently with atoms. Degenerate (zero-length) halves discard cleanly. */
const BOND_RENDER_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};
// Bond uniform: lattice rows a,b,c (vec3+pad each), edge style, opacity +
// reserved lanes. Endpoint colors are read from binding 7.
struct BondU {
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
  style0 : vec4<f32>, // radius, incomplete mode, length scale, hide incomplete
  style1 : vec4<f32>, // incomplete opacity, reserved rgb
};

// GPU supercell uniform (Phase 2). Same layout as the atom impostor's Supercell:
// dims = [nx,ny,nz,base_count] (base_count unused here — bond_count comes from
// bond_meta), lat0/1/2 = base lattice ROWS a,b,c. The per-cell offset is
// ix·a + iy·b + iz·c. Read ONLY in vs_main (cell decode + partner-cell test).
struct Supercell {
  dims : vec4<u32>,
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> pairs : array<u32>;
@group(0) @binding(3) var<uniform> bond : BondU;
// Clamped bond_count (written by the indirect-args build). Drives the inst decode
// cell = inst / (2·bond_count). Read ONLY in vs_main.
@group(0) @binding(4) var<storage, read> bond_meta : array<u32>;
// GPU supercell instancing params (dims + base lattice). Read ONLY in vs_main.
@group(0) @binding(5) var<uniform> supercell : Supercell;
// The SAME shading uniform the atom impostor binds (see the Shading struct
// there). fs_main reads the view-space headlamp, the specular strength and the
// depth-cue params, so bonds are lit from the same direction as the atoms and
// fade into the same fog. Read ONLY in fs_main.
struct Shading {
  light_dir : vec4<f32>,
  params0   : vec4<f32>,
  params1   : vec4<f32>,
  depth_cue : vec4<f32>,
  depth_bg  : vec4<f32>,
  toon      : vec4<f32>,
};
@group(0) @binding(6) var<uniform> shading : Shading;
// Authoritative base-topology linear RGB buffer. This is the SAME buffer used
// by the atom impostor; no bond-side resolver or duplicate upload exists.
@group(0) @binding(7) var<storage, read> colors : array<f32>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) v0 : vec3<f32>,      // view-space cylinder start (flat)
  @location(1) v1 : vec3<f32>,      // view-space cylinder end   (flat)
  @location(2) radius : f32,        // cylinder radius (flat)
  @location(3) color_start : vec3<f32>,
  @location(4) color_end : vec3<f32>,
  @location(5) vpos : vec3<f32>,    // view-space position of this quad corner
  // 1.0 for CROSS-cell stubs, 0.0 for INTRA-cell full cylinders. Flat-interp.
  // The fragment shader pushes cross-cell stubs slightly BACKWARD in depth so a
  // stub coincident with an intra-cell bond at a shared atom loses the depth tie
  // (intra always wins) — kills the faint alpha-to-coverage dotted seam.
  @location(6) is_stub : f32,
  // Incomplete periodic half-edge opacity. Full and ghost-complete edges use 1.
  @location(7) opacity : f32,
};

struct FsOut {
  @builtin(frag_depth) depth : f32,
  @location(0) color : vec4<f32>,
};

fn atom_pos(i : u32) -> vec3<f32> {
  return vec3<f32>(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
}

fn atom_color(i : u32) -> vec3<f32> {
  return vec3<f32>(colors[i*3u], colors[i*3u+1u], colors[i*3u+2u]);
}

fn studio_env(n : vec3<f32>, key_dir : vec3<f32>) -> vec3<f32> {
  var col = vec3<f32>(0.72);
  let key = max(dot(n, key_dir), 0.0);
  col += vec3<f32>(1.00, 0.97, 0.92) * (key * key) * 0.35;
  let sky = n.y * 0.5 + 0.5;
  col += vec3<f32>(0.06, 0.06, 0.07) * sky;
  return col;
}

fn aces_tonemap(x : vec3<f32>) -> vec3<f32> {
  return clamp(
    (x * (2.51 * x + vec3<f32>(0.03))) /
      (x * (2.43 * x + vec3<f32>(0.59)) + vec3<f32>(0.14)),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32,
           @builtin(instance_index) inst : u32) -> VsOut {
  // ── GPU supercell Phase 2 bond decode ──────────────────────────────────────
  // Bonds are computed ONCE on the base cell (pairs = (a,b,jimage)). Each base
  // bond is replicated into every cell (ix,iy,iz) of the nx·ny·nz supercell, each
  // as TWO half instances (matching the Phase-1 atom replication). Instance
  // layout: inst = cell·(2·bond_count) + bond_index·2 + half.
  //   cell       = inst / (2·bond_count)
  //   local      = inst % (2·bond_count)
  //   bond_index = local >> 1
  //   half       = local & 1
  // When ncells = 1 (dims 1,1,1) cell = 0 and this collapses to the Phase-1
  // mapping bond_index = inst>>1, half = inst&1 — byte-identical.
  let bond_count = max(bond_meta[0], 1u);
  let per_cell = bond_count * 2u;
  let cell = inst / per_cell;
  let local = inst % per_cell;
  let bond_index = local >> 1u;
  let half = local & 1u;

  // Decode the cell index → (ix,iy,iz) and its lattice offset ix·a+iy·b+iz·c.
  let nx = max(supercell.dims.x, 1u);
  let ny = max(supercell.dims.y, 1u);
  let nz = max(supercell.dims.z, 1u);
  let ix = cell % nx;
  let iy = (cell / nx) % ny;
  let iz = cell / (nx * ny);
  let cell_offset = f32(ix) * supercell.lat0.xyz
                  + f32(iy) * supercell.lat1.xyz
                  + f32(iz) * supercell.lat2.xyz;

  let a = pairs[bond_index*3u + 0u];
  let b = pairs[bond_index*3u + 1u];
  let jp = pairs[bond_index*3u + 2u];

  // Unpack the full signed Int8 range from three biased u8 lanes.
  let ji = i32(jp & 255u) - 128;
  let jj = i32((jp >> 8u) & 255u) - 128;
  let jk = i32((jp >> 16u) & 255u) - 128;
  let na = f32(ji);
  let nb = f32(jj);
  let nc = f32(jk);
  let shift = na * bond.lat0.xyz + nb * bond.lat1.xyz + nc * bond.lat2.xyz;

  // A is atom a in THIS cell; partnerB is atom b imaged by jimage (still relative
  // to this cell). Both carry the per-cell offset so every replica is positioned.
  let A = atom_pos(a) + cell_offset;
  let B = atom_pos(b) + cell_offset;
  let partnerB = B + shift;       // A's imaged partner
  let partnerA = A - shift;       // (unused when inside; kept for the stub path)

  // Partner cell = this cell + jimage. If it lies INSIDE [0,nx)×[0,ny)×[0,nz) the
  // partner is a REAL replica atom one cell over → draw a FULL cylinder A→B_real
  // (no spike, it's an actual adjacent atom). Otherwise (true outer boundary) draw
  // the boundary STUB exactly as the single-cell path does.
  let px = i32(ix) + ji;
  let py = i32(iy) + jj;
  let pz = i32(iz) + jk;
  let inside = px >= 0 && px < i32(nx)
            && py >= 0 && py < i32(ny)
            && pz >= 0 && pz < i32(nz);
  // B_real: atom b in the partner cell = base_pos[b] + (px·a + py·b + pz·c). This
  // equals B + shift (= partnerB) whenever the partner cell is in range — the
  // jimage shift IS one cell step — so reuse partnerB as the real adjacent atom.
  let B_real = partnerB;

  // Complete boundary policy packed into supercell.lat0.w by the TS upload:
  //   0 = stub          outside edges stay paired half-stubs
  //   1 = hide          outside edges collapse (no fragments)
  //   2 = ghost-images  outside edges become ONE full cylinder to partnerB,
  //                     where the sparse ghost instance is drawn
  // This applies for ANY visual-supercell dims — no ncells==1 special case.
  let boundary_policy = u32(round(supercell.lat0.w));
  let ghost_complete = (!inside) && boundary_policy == 2u;
  let style_hide_outside = (!inside) && bond.style0.w > 0.5 && !ghost_complete;
  let hide_outside = (!inside) && (boundary_policy == 1u || style_hide_outside);

  // Render as ONE full cylinder when the partner is a real in-range atom OR a
  // sparse ghost. half 0 spans A→partnerB; half 1 collapses. Stub policy keeps
  // the historical two half-cylinders. Hide collapses both halves below.
  let is_full = inside || ghost_complete;

  // FULL: half 0 spans A→B_real; half 1 is collapsed offscreen below.
  // STUB (boundary): half 0 = A→mid(A,partnerB); half 1 = B→mid(B,partnerA) — the
  // two short stubs of the single-cell cross-cell path, shifted by cell_offset.
  let stub_scale = select(
    1.0,
    clamp(bond.style0.z, 0.05, 1.0),
    bond.style0.y > 0.5,
  );
  let cross_start = select(B, A, half == 0u);
  let cross_end_a = A + (partnerB - A) * (0.5 * stub_scale);
  let cross_end_b = B + (partnerA - B) * (0.5 * stub_scale);
  let cross_end = select(cross_end_b, cross_end_a, half == 0u);
  let start = select(cross_start, A, is_full);
  let end = select(cross_end, B_real, is_full);

  // Full cylinders carry A→B endpoint colors; the fragment shader applies the
  // same hard midpoint split as WebGL's two monochrome half-bond instances.
  // True boundary stubs remain monochrome: half 0 is A/A and half 1 is B/B.
  let color_a = atom_color(a);
  let color_b = atom_color(b);
  var color_start = select(color_b, color_a, half == 0u);
  var color_end = color_start;
  if (is_full) {
    color_start = color_a;
    color_end = color_b;
  }

  // Keep the downstream variable name the rest of vs_main uses (is_intra) so the
  // degenerate-half collapse + is_stub flag below are untouched: a full cylinder
  // behaves exactly like an intra-cell bond (half 1 redundant, no depth bias).
  let is_intra = is_full;

  let r = bond.style0.x;

  // Endpoints in VIEW space (eye at origin). The impostor ray-trace + depth all
  // happen in this space.
  let v0 = (camera.view * vec4<f32>(start, 1.0)).xyz;
  let v1 = (camera.view * vec4<f32>(end, 1.0)).xyz;

  // SCREEN-ALIGNED capsule-bounding hull. The old camera-facing ribbon was
  // built from side = cross(axis, to_eye); when the bond axis points at the eye
  // (end-on) that cross product collapses and the quad turns edge-on, leaving
  // the projected cap disk uncovered -> hollow ring. Instead we wrap BOTH
  // endpoint disks with a 6-vertex hull of two screen-aligned squares (each side
  // 2r, in the view-space XY plane the camera looks down -Z). Whatever the bond
  // orientation, each square keeps its full 2r×2r screen footprint, so the cap
  // circle is always fully rasterized; the fragment ray-test discards the slack.
  //
  // The hull is laid out along the bond's SCREEN-PROJECTED direction (so it
  // hugs the capsule for long side-on bonds), with each endpoint's billboard
  // corners anchored at that endpoint's OWN view-space depth -> no perspective
  // clipping of the silhouette at oblique/foreshortened angles.
  let w = r * 1.5; // half-extent per square; slack so grazing silhouette never clips.

  // Screen-space (view XY) direction from v0 to v1. End-on bonds project to a
  // ~zero-length 2D segment -> fall back to +X so the perp axis is well defined;
  // the two squares simply stack into one 2r×2r quad, which is exactly what an
  // end-on cap needs.
  let d2 = v1.xy - v0.xy;
  let d2len = length(d2);
  let sdir = select(vec2<f32>(1.0, 0.0), d2 / max(d2len, 1e-6), d2len > 1e-6);
  let sperp = vec2<f32>(-sdir.y, sdir.x);
  // View-space screen offsets: along the projected axis (so caps extend past the
  // endpoints by w) and across it (capsule width). Both live in the XY plane.
  let off_axis = vec3<f32>(sdir * w, 0.0);
  let off_perp = vec3<f32>(sperp * w, 0.0);

  // 6-vertex triangle-STRIP hull of the two endpoint squares (a capsule-bounding
  // hexagon). The strip's 4 triangles — (0,1,2),(1,2,3),(2,3,4),(3,4,5) — tile a
  // convex hexagon whose 6 corners wrap both squares:
  //   0: v0 - axis - perp        (v0 far-cap, perp -)
  //   1: v0 - axis + perp        (v0 far-cap, perp +)
  //   2: v1       - perp         (v1 body edge, perp -)   [shares v0's near side
  //   3: v0       + perp          via the strip's quad coverage]
  //   4: v1 + axis - perp        (v1 far-cap, perp -)
  //   5: v1 + axis + perp        (v1 far-cap, perp +)
  // Each corner is anchored at its OWN endpoint's view-space depth (v0 vs v1) so
  // perspective foreshortening never clips the silhouette of an oblique long
  // bond. End-on (off_axis along the +X fallback) every corner still sits at
  // ±w, so the union is a full 2w×2w screen square over the cap — solid, no ring.
  var anchor = v0;
  var ax_sign = 0.0;
  var p_sign = -1.0;
  switch vi % 6u {
    case 0u: { anchor = v0; ax_sign = -1.0; p_sign = -1.0; }
    case 1u: { anchor = v0; ax_sign = -1.0; p_sign =  1.0; }
    case 2u: { anchor = v1; ax_sign =  0.0; p_sign = -1.0; }
    case 3u: { anchor = v0; ax_sign =  0.0; p_sign =  1.0; }
    case 4u: { anchor = v1; ax_sign =  1.0; p_sign = -1.0; }
    default: { anchor = v1; ax_sign =  1.0; p_sign =  1.0; }
  }
  let vpos = anchor + ax_sign * off_axis + p_sign * off_perp;

  // Full-edge half 1 is redundant (half 0 already draws the full cylinder),
  // and hide policy suppresses BOTH outside halves. Collapse all 6 strip
  // vertices to one offscreen point so no fragments rasterize (don't rely on a
  // fragment discard). Stub halves are untouched.
  if (hide_outside || (is_intra && half == 1u)) {
    var out_deg : VsOut;
    out_deg.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0); // outside the [-w,w] clip cube
    out_deg.v0 = v0;
    out_deg.v1 = v1;
    out_deg.radius = r;
    out_deg.color_start = color_start;
    out_deg.color_end = color_end;
    out_deg.vpos = vpos;
    out_deg.is_stub = 0.0; // degenerate (discarded) — value irrelevant
    out_deg.opacity = 0.0;
    return out_deg;
  }

  var clip = camera.proj * vec4<f32>(vpos, 1.0);
  // SAME GL->WebGPU NDC z remap as the atom impostor shader.
  clip.z = (clip.z + clip.w) * 0.5;

  var out : VsOut;
  out.clip = clip;
  out.v0 = v0;
  out.v1 = v1;
  out.radius = r;
  out.color_start = color_start;
  out.color_end = color_end;
  out.vpos = vpos;
  // Cross-cell stubs (jimage != 0, !is_intra) get the fragment depth bias.
  out.is_stub = select(1.0, 0.0, is_intra);
  out.opacity = select(clamp(bond.style1.x, 0.0, 1.0), 1.0, is_full);
  return out;
}

@fragment
fn fs_main(in : VsOut) -> FsOut {
  let r = in.radius;
  let pa = in.v0;            // cylinder axis point 0 (view space)
  let ca = in.v1 - in.v0;    // axis vector
  let clen = length(ca);
  // Degenerate (coincident) half: nothing to draw, no NaN.
  if (clen < 1e-6) { discard; }
  let axis = ca / clen;      // unit axis

  // Eye ray: origin at view-space 0, direction toward the interpolated corner.
  let rd = normalize(in.vpos);

  // Infinite-cylinder intersection. Project ray + origin offset off the axis.
  // d_perp = rd - (rd·axis)axis ; oc = O - pa = -pa.
  let oc = -pa;
  let rd_a = dot(rd, axis);
  let oc_a = dot(oc, axis);
  let d_perp = rd - rd_a * axis;
  let oc_perp = oc - oc_a * axis;
  let qa = dot(d_perp, d_perp);
  let qb = 2.0 * dot(d_perp, oc_perp);
  let qc = dot(oc_perp, oc_perp) - r * r;

  var best_t = 1e30;
  var hit_p = vec3<f32>(0.0);
  var hit_n = vec3<f32>(0.0);
  var found = false;

  // Body: solve quadratic, take the nearer positive root whose axial projection
  // lands within [0, clen].
  if (qa > 1e-12) {
    let disc = qb * qb - 4.0 * qa * qc;
    if (disc >= 0.0) {
      let sq = sqrt(disc);
      let inv = 1.0 / (2.0 * qa);
      let t0 = (-qb - sq) * inv;
      let t1 = (-qb + sq) * inv;
      // Try the near root, then the far root (we may be inside the cylinder).
      for (var k = 0; k < 2; k = k + 1) {
        let t = select(t1, t0, k == 0);
        if (t > 0.0 && t < best_t) {
          let p = rd * t;
          let h = dot(p - pa, axis); // axial coordinate along the cylinder
          if (h >= 0.0 && h <= clen) {
            best_t = t;
            hit_p = p;
            let axis_point = pa + axis * h;
            hit_n = normalize(p - axis_point); // radial outward
            found = true;
            break;
          }
        }
      }
    }
  }

  // End-cap disks: planes at pa (normal -axis) and pb (normal +axis), |radial|<=r.
  // Tested independently so a body miss (or a cap-on view) still reads as solid.
  let pb = in.v1;
  for (var c = 0; c < 2; c = c + 1) {
    let cap_center = select(pa, pb, c == 1);
    let cap_n = select(-axis, axis, c == 1);
    let denom = dot(rd, cap_n);
    if (abs(denom) > 1e-6) {
      let t = dot(cap_center, cap_n) / denom; // (cap_center - O)·n / (rd·n), O=0
      if (t > 0.0 && t < best_t) {
        let p = rd * t;
        let radial = p - cap_center;
        if (dot(radial, radial) <= r * r) {
          best_t = t;
          hit_p = p;
          hit_n = cap_n;
          found = true;
        }
      }
    }
  }

  // ── Analytic capsule silhouette coverage (alpha-to-coverage AA) ─────────────
  // The exact body/cap ray-test above sets found (a binary edge); plain MSAA
  // can't smooth that. We deliberately do NOT discard on !found yet — a fragment
  // just outside the solid still lies in the thin silhouette band below and must
  // survive to receive fractional coverage. Build a SMOOTH signed inside-measure
  // of the finite-capsule silhouette and convert it to fractional coverage so
  // alpha-to-coverage AAs the body and cap edges.
  //
  // For the eye ray (origin 0, dir rd) we measure perpendicular distance to the
  // axis SEGMENT [pa,pb] and combine with the two cap planes:
  //   body_inside = r - dist(ray, axis-line)              (radial silhouette)
  //   cap-axial   = clamp the closest-approach axial coord into [0,clen]
  // We sample the ray at its closest approach to the axis line, clamp that
  // point onto the segment, and take measure = r - |closest point on ray to the
  // segment|. This is the standard ray↔segment capsule distance and is a smooth
  // varying of the interpolated rd, so fwidth() yields the screen-space edge
  // width. measure>0 inside the projected capsule, =0 on the silhouette.
  //
  // Closest approach between the eye ray (P=rd*t, t>=0) and the axis line
  // (Q=pa+axis*s): solve the 2x2 least-squares for (t,s) using rd·rd=1.
  let rda = dot(rd, axis);          // = rd_a, reuse-friendly
  let denom_cl = 1.0 - rda * rda;   // = |rd x axis|^2 (rd is unit)
  let w0 = -pa;                     // O - pa, O=0
  let d_w = dot(rd, w0);
  let e_w = dot(axis, w0);
  // t along the ray, s along the axis line, at mutual closest approach.
  var t_cl = 0.0;
  var s_cl = 0.0;
  if (denom_cl > 1e-7) {
    t_cl = (rda * e_w - d_w) / denom_cl;
    s_cl = (e_w - rda * d_w) / denom_cl;
  } else {
    // Ray ~parallel to axis (end-on): project onto the ray.
    t_cl = -d_w;
    s_cl = 0.0;
  }
  t_cl = max(t_cl, 0.0);            // ray only extends forward
  s_cl = clamp(s_cl, 0.0, clen);    // clamp onto the finite axis SEGMENT
  let p_ray = rd * t_cl;            // closest ray point
  let p_seg = pa + axis * s_cl;     // closest segment point
  let gap = length(p_ray - p_seg);  // capsule surface distance proxy
  let measure = r - gap;            // >0 inside silhouette, =0 on edge
  let fw = fwidth(measure);
  let coverage = clamp(measure / max(fw, 1e-8) + 0.5, 0.0, 1.0);

  // Inside the solid (found) → full coverage; only the thin silhouette band gets
  // fractional coverage. If neither the exact solid test nor the analytic band
  // covers this fragment, discard.
  let cov = select(coverage, 1.0, found);
  if (cov <= 0.0) { discard; }

  // For the thin AA band where the exact ray-test missed, fall back to the
  // capsule-surface point for normal + depth so the edge band shades/depths
  // consistently with the solid body.
  if (!found) {
    hit_p = p_ray;
    hit_n = normalize(p_ray - p_seg);
  }

  // Match WebGL's two pure-color half-bond instances: A before the midpoint,
  // B at and after it. Boundary stubs received identical start/end colors above.
  let axial = clamp(dot(hit_p - pa, axis) / clen, 0.0, 1.0);
  let base_color = select(
    in.color_end,
    in.color_start,
    axial < ${BOND_MIDPOINT_SPLIT},
  );

  // WebGL BondManagerInstances studio lighting, kept literal so the two
  // backends share env, specular, Fresnel, rim/floor lift, exposure, tonemap,
  // sRGB encoding, then depth cueing in that order.
  let view_dir = normalize(-hit_p);
  let key_dir = normalize(shading.light_dir.xyz);
  let env = studio_env(hit_n, key_dir);
  let half_dir = normalize(key_dir + view_dir);
  let specular = pow(max(dot(hit_n, half_dir), 0.0), 64.0);
  let NdotV = max(dot(hit_n, view_dir), 0.0);
  let fresnel = pow(1.0 - NdotV, 5.0);
  let rim_mask = smoothstep(0.0, 0.25, NdotV);
  let floor_lift = mix(0.18, 1.0, rim_mask);
  let spec_color = mix(vec3<f32>(1.0), base_color, 0.55);
  let ambient_intensity = 0.8;
  let directional_intensity = 0.3;
  let exposure = ambient_intensity + directional_intensity * 0.5; // fixed 0.95
  var final_color =
    base_color * env * exposure * floor_lift +
    spec_color * specular * directional_intensity * 0.5 * rim_mask * shading.params0.z +
    vec3<f32>(fresnel * 0.08) * rim_mask;
  final_color = aces_tonemap(final_color);

  // Correct depth: project the view-space hit point, apply the SAME GL->WebGPU z
  // remap as the vertex stage, then perspective-divide into NDC z (range 0..1).
  let clip_h = camera.proj * vec4<f32>(hit_p, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  // Cross-cell stub depth bias: where a stub overlaps the START of an intra-cell
  // full cylinder at a shared atom, the two grey surfaces are coincident -> a
  // depth tie -> alpha-to-coverage stipple (faint dotted seam). Push the stub
  // slightly BACKWARD (larger depth) so the intra-cell bond consistently wins the
  // depth test there. Epsilon is tiny enough to be invisible elsewhere but breaks
  // the tie at typical near/far. Intra-cell bonds (is_stub == 0) are NOT biased.
  if (in.is_stub > 0.5) {
    depth = clamp(depth + 1e-4, 0.0, 1.0);
  }

  var out : FsOut;
  out.depth = depth;
  // alpha = coverage feeds alpha-to-coverage; no alpha blending is enabled.
  var rgb = linear_to_srgb(final_color);

  // Depth cueing — the SAME fog the atoms use (shading.params1.w = depth_cueing).
  // Bonds must fade with it too, or they'd float out of the fog the atoms sink
  // into. Encoded fade target, matching the atom shader.
  if (shading.params1.w > 0.0) {
    let depth_z = -hit_p.z;
    let span = max(shading.depth_cue.y - shading.depth_cue.x, 0.01);
    let fade = clamp((depth_z - shading.depth_cue.x) / span, 0.0, 1.0) * shading.params1.w;
    rgb = mix(rgb, linear_to_srgb(shading.depth_bg.xyz), fade);
  }

  // Bond outline is independent of the atom outline in shading.params1.z.
  // Match BondManagerInstances' wider silhouette band and gain.
  if (shading.depth_cue.z > 0.0) {
    let silhouette = smoothstep(0.0, 0.6, 1.0 - NdotV);
    rgb = mix(rgb, vec3<f32>(0.0), silhouette * shading.depth_cue.z * 0.85);
  }

  let alpha = cov * in.opacity;
  if (alpha <= 0.0) { discard; }
  out.color = vec4<f32>(rgb, alpha);
  return out;
}
` + LINEAR_TO_SRGB_WGSL

/** Deterministic snapshot of the renderer's replica/packet state (design §5 +
 *  §7): what the packet channel last consumed, how many instances the atom
 *  draw issues, and the nested GPU bond-pipeline diagnostics. */
export type ReplicaRendererDiagnostics = {
  backend: 'webgpu'
  /** True once the GPUDevice reported loss (Bonds T6): every submission is
   *  stopped, but scene/owner state (ownership, packet versions, active
   *  graph) is RETAINED so the WebGL2+WASM fallback takes over the SAME
   *  packet source — nothing is cleared mid-swap. */
  device_lost: boolean
  /** Bond count of the ACTIVE draw graph (packet-, GPU-, or wasm-produced). */
  active_bond_count: number
  /** Non-null while the dispatch policy refuses the GPU compute path
   *  (periodic thin cell / grid storage budget). Bonds are then routed
   *  through the rust-wasm worker (Bonds T6); the reason persists so hosts
   *  can surface the backend in diagnostics. */
  required_backend: 'periodic-thin-cell' | 'grid-storage-limit' | null
  /** Active writer of shared GPU state; legacy writes invalidate packet cache. */
  ownership: 'legacy' | 'packet'
  /** Base-cell atom count (CPU stays at exactly N sites). */
  base_count: number
  dims: readonly [number, number, number]
  ncells: number
  boundary_policy: BoundaryPolicy
  /** Sparse ghost table size (drawn only under 'ghost-images'). */
  ghost_count: number
  /** Atom-draw instance count: base_count · ncells (+ drawn ghosts). */
  atom_instances: number
  /** Versions of the last packet consumed by set_packet; null before any. */
  packet_versions: {
    topology: number
    bond_graph: number | null
    frame_idx: number
    positions: number
    replicas: number
  } | null
  /** True while a packet-supplied bond graph drives the draw (GPU bond
   *  detection suspended — the packet producer owns re-detection). */
  packet_graph_active: boolean
  bonds: BondGpuDiagnostics
}

export type LargeSystemRenderer = {
  /** Upload a packed camera uniform (Float32Array(20), proj*view layout).
   *  Legacy 9.1 entry point; kept for back-compat. Not used by the impostor
   *  draw (which reads view+proj separately via set_camera_full). */
  set_camera(uniform: Float32Array): void
  /** Upload the full camera uniform (Float32Array(36): view + proj + camPos).
   *  This is what the impostor pipeline binds. */
  set_camera_full(uniform: Float32Array): void
  /** (Re)upload atom storage buffers. positions=3N, radii=N, colors=3N linear
   *  rgb. Buffers grow as needed; count drives the instanced draw. */
  set_atoms(
    positions: Float32Array,
    radii: Float32Array,
    colors: Float32Array,
    count: number,
  ): void
  /** Re-upload ONLY the atom xyz positions for the current trajectory frame.
   *  `count` must match the previously uploaded atom count (same topology). No
   *  radii/colors re-upload, no buffer realloc — the lightweight per-frame path.
   *  Marks bonds dirty so the next render re-runs the GPU bond compute against
   *  the moved atoms. No-op if the buffers haven't been allocated yet (call
   *  set_atoms first to establish topology). */
  set_positions(positions: Float32Array, count: number): void
  /** Set the GPU supercell instancing params (Phase 1). `dims` = [nx,ny,nz]
   *  tiling counts; the atom draw issues `atom_count × nx·ny·nz` sphere instances,
   *  each offset by ix·a + iy·b + iz·c. `base_lattice` is the 9-float row-major
   *  BASE-cell lattice (rows a,b,c — same convention as pack_lattice / set_cell).
   *  dims [1,1,1] (the default) ⇒ ncells 1, zero offset ⇒ the draw is byte-
   *  identical to the non-supercell path. The CPU stays at the base cell; this is
   *  what scales the rendered atom count WITHOUT building N× Site objects.
   *  REPLICA-only invalidation (design §8.2 item 4): refreshes the indirect
   *  draw args from the ACTIVE bond graph — never reruns bond detection. */
  set_supercell(dims: [number, number, number], base_lattice: Float32Array): void
  /** Legacy compatibility toggle: maps false → boundary policy `stub` and true
   *  → `ghost-images`. The latter completes outside bonds to the imaged partner
   *  for ANY replica dims; callers must also provide/draw the corresponding
   *  image atoms (packet mode does so through ImageInstanceTable). REPLICA-only:
   *  the base bond graph is reused, never re-detected. Any call switches shared
   *  state to legacy ownership and invalidates the packet cache. */
  set_show_images(show: boolean): void
  /** Packet-versioned upload channel (design §5): the ONE entry point the
   *  packet flow uses instead of the set_atoms / set_positions / set_supercell
   *  / set_show_images fan-out. Diffs against the last packet with
   *  diff_render_packet and uploads ONLY what its version says moved:
   *  - topology version → base radii/colors (+ buffer realloc, base_count);
   *  - frame version    → base positions + the CURRENT frame lattice (a
   *    fixed-cell frame advance is a single 3N-float upload); marks the bond
   *    graph dirty (GPU-detect path re-runs);
   *  - replica version  → dims / boundary policy / indirect draw counts —
   *    REPLICA-only: never invalidates or re-runs base-cell bond detection;
   *  - bond-graph version → packet-supplied base graph replaces the active
   *    draw graph 1:1 (periodic self-image edges retained) and SUSPENDS the
   *    GPU bond-detect compute while present.
   *  The `images` argument remains for adapter compatibility, but renderer
   *  publication derives the sparse ghost stream from the SAME active
   *  BaseBondGraph (packet-supplied or validated GPU-produced). Caller boundary
   *  metadata is never accepted as a substitute topology source. */
  set_packet(packet: RenderPacket, images: ImageInstanceTable): void
  /** Provide bond-detection inputs. `covalent_radii` is the per-atom COVALENT
   *  radius (N entries, from build_atom_radii — distinct from the display radii
   *  used for sphere size). `lattice` is the 9-float row-major detector matrix
   *  (rows a,b,c). In legacy mode it also owns the bond-render lattice; packet
   *  mode keeps render geometry owned by `frame.lattice`. `options` carries the
   *  bond cutoffs; `periodic` toggles min-image PBC. Marks bonds dirty so the
   *  next render re-runs the compute dispatch — NOT every frame. */
  set_bond_data(
    covalent_radii: Float32Array,
    lattice: Float32Array,
    options: { scale: number; max_bond_dist: number; min_bond_dist: number },
    periodic: boolean,
  ): void
  /** Mirror the viewer's bond visual settings without changing packet/legacy
   *  ownership or invalidating the scientific bond graph. Repeated equal style
   *  values are a no-op. */
  set_bond_style(style: Partial<LargeSystemBondStyle>): void
  /** Provide the per-element-pair bond_distance_rules POST-FILTER inputs (matches
   *  src/lib/structure/scene/visibility.ts). `elem_ids` is the per-atom element id
   *  (N entries) and `rules` is the packed rule buffer (4 floats per rule:
   *  id_a, id_b, min, max with id_a ≤ id_b), both produced by
   *  encode_bond_rules (bond-rules.ts) so their id mapping agrees. Empty `rules`
   *  ⇒ rule_count 0 ⇒ no filtering (behaviour identical to no rules). Marks bonds
   *  dirty so the next render re-runs the compute with the new rules — LIVE update
   *  when the viewer edits a bond distance rule. */
  set_bond_rules(elem_ids: Uint32Array, rules: Float32Array): void
  /** Set the clear (background) color the render pass uses. `rgb` is LINEAR
   *  float [r,g,b] in the SAME space as the atom colors uploaded via set_atoms
   *  (so the background and atoms share one color space — dark atoms keep their
   *  contrast against the viewer's normal background). Alpha stays 1 (opaque).
   *  The clearValue bypasses every fragment shader, so this is sRGB-encoded on
   *  the way in — see linear_to_srgb. */
  set_background(rgb: [number, number, number]): void
  /** Mirror the WebGL viewer's resolved atom-shading state (headlamp, ambient /
   *  directional intensities, render style, depth cueing, outline). Cheap — a
   *  96-byte uniform write — so the caller may call it every frame; it only
   *  uploads when a field actually changed. Returns true when it DID change, so
   *  the caller can mark the frame dirty (depth-cue near/far track the camera,
   *  so this fires on every camera move). */
  set_shading(state: ResolvedVisualShading): boolean
  /** Mirror the DOM-side inputs the corner gizmo's placement needs: the device
   *  pixel ratio (the widget spec — size clamp, offsets, line width — is in CSS
   *  px) and the pane's HUD safe-area insets (the docked-toolbar avoidance the
   *  WebGL gizmo gets as offset:{left: 5+l, bottom: 5+b}). Re-derives and
   *  re-uploads the placement uniform; call on dpr / safe-area change (resize
   *  re-derives on its own). */
  set_gizmo_layout(opts: { dpr?: number; safe_left?: number; safe_bottom?: number }): void
  /** Gate bond detection + bond rendering. When `false`, render() skips BOTH the
   *  GPU bond compute pass AND the bond draw (atoms + cell box still render), so
   *  the overlay shows no bonds — mirroring the WebGL view when the viewer's
   *  `show_bonds` setting (via should_show_bonds) resolves to hidden. Defaults to
   *  true. Flipping it back to true re-enables the compute on the next render
   *  (the caller should also re-push set_bond_data / mark bonds dirty). */
  set_bonds_enabled(enabled: boolean): void
  /** Provide the unit-cell box. `lattice` is the 9-float row-major matrix (rows
   *  a,b,c — same convention as set_bond_data / pack_lattice); pass null (or an
   *  all-zero lattice) for non-periodic structures. `show` gates drawing; `color`
   *  is the linear-RGB cell edge color (alpha is forced to 1). `origin` is the
   *  transformed position of the cell's zero corner. When `show` is true AND the
   *  lattice is non-zero, render() draws the 12 cell edges as thin lines (WebGPU
   *  core line width is 1px) sharing the atom depth buffer. */
  set_cell(
    lattice: Float32Array | null,
    show: boolean,
    color: [number, number, number],
    origin?: readonly [number, number, number],
  ): void
  /** Set which atoms are highlighted as "selected". `indices` is the list of atom
   *  indices (same indexing as the uploaded positions / structure.sites order) to
   *  highlight; pass an empty array to clear. Uploads a per-atom u32 flag buffer
   *  (1 = selected) bound to the atom impostor fragment shader, so selected atoms
   *  render with a distinct highlight (brighten + rim ring) on the next render.
   *  Cheap; safe to call every frame the selection might have changed. */
  set_selection(indices: Uint32Array | number[]): void
  /** GPU atom picking. Renders the atoms once into an offscreen R32Uint id buffer
   *  (single-sampled, depth-tested so the front atom wins), then copies the single
   *  texel at the given DEVICE-pixel (x,y) to a readback buffer and decodes it to
   *  a ReplicaPickResult: `{kind:'atom', base_site, cell, ghost:false}` for a real
   *  replica (cell via the Task-1 atom-major decode), `ghost:true` with the
   *  ABSOLUTE image cell for a sparse ghost instance, and `{kind:'miss',
   *  base_site:-1}` for background. (x,y) are in device pixels (CSS px ×
   *  devicePixelRatio); the caller maps cursor→canvas→device and resolves the
   *  logical/physical site with logical_site_for_pick. */
  pick(x: number, y: number): Promise<ReplicaPickResult>
  /** Deterministic diagnostics of the GPU bond pipeline (design §8.2): the
   *  published graph version, compute dispatch counters, grid sizing +
   *  observed occupancy, raw/capacity pair counts, and overflow/retry state.
   *  Returns a fresh snapshot on every call. */
  debug_bond_state(): BondGpuDiagnostics
  /** Deterministic replica/packet diagnostics: the last packet's versions,
   *  dims / boundary policy / ghost + instance counts, whether a
   *  packet-supplied bond graph drives the draw, and the nested
   *  debug_bond_state() snapshot. Fresh object on every call. */
  get_diagnostics(): ReplicaRendererDiagnostics
  /** Register a host callback fired when ASYNC bond work transitions state
   *  and another render() is needed for the pipeline to make progress: a
   *  validated candidate awaits publication (publish pends), an overflow
   *  retry re-armed the graph (rerun with grown sizing), or the allocation
   *  limit was hit (terminal — lets a dirty-gated host run one settling
   *  frame). Fires ONLY when a candidate's validation readback resolves —
   *  never per render() — so a published graph with nothing pending cannot
   *  keep a host loop awake. Dirty-gated hosts (LargeSystemOverlay's
   *  self-suspending rAF loop) MUST register this and wake on it, or a
   *  static scene's first bond graph starves until the next camera move.
   *  One slot; pass null to unregister. Never fires after destroy(). */
  on_bond_work(cb: (() => void) | null): void
  /** Register a host callback for DEVICE LOSS (Bonds T6). The renderer holds
   *  the ONE `device.lost` subscription for its lease; when it resolves the
   *  renderer first gates every submission channel (render/pick/setters
   *  become no-ops, in-flight readbacks are discarded) while RETAINING all
   *  scene/owner state, then notifies this callback EXACTLY ONCE — the host
   *  swaps to the WebGL2+WASM fallback and invalidates the lease generation.
   *  One slot; a registration arriving after the loss (host raced the event)
   *  is notified immediately, still once in total. Pass null to unregister.
   *  Never fires after destroy(). */
  on_device_lost(cb: ((info?: GPUDeviceLostInfo) => void) | null): void
  /** Run one render pass: publish any validated candidate bond graph, (if the
   *  graph is dirty) dispatch the candidate bond compute, (if replica state is
   *  dirty) rebuild the indirect draw args, then (if atoms present) impostor
   *  sphere draw + (if bonds present) instanced cylinder draw, all sharing one
   *  depth attachment. The bond draw always uses the last COMPLETE graph —
   *  candidates publish only after their overflow-free readback validates. */
  render(): void
  /** Resize the backing canvas + depth texture to device-pixel dimensions. */
  resize(w: number, h: number): void
  /** Tear down GPU resources and unconfigure the context. */
  destroy(): void
}

export function create_large_system_renderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  /** Test seam (Bonds T6): inject the typed rust-wasm bond entry so unit
   *  tests never spawn real workers. Production omits it — the renderer
   *  lazy-imports bond-worker-api's compute_bonds_typed on first use. */
  deps?: {
    compute_bonds_typed?: (input: TypedBondInput) => Promise<ComputeBondsTypedResult>
  },
): LargeSystemRenderer {
  const context = canvas.getContext(`webgpu`)
  if (!context) throw new Error(`WebGPU canvas context unavailable`)
  const format = navigator.gpu.getPreferredCanvasFormat()
  // `opaque` (not `premultiplied`) forces opaque compositing and ignores the
  // canvas alpha, so the overlay fully covers the WebGL canvas beneath it with
  // no bleed-through. Combined with clearValue a=1 + alpha=1 in both fragment
  // shaders, the overlay is a fully opaque replacement when active.
  context.configure({ device, format, alphaMode: `opaque` })

  // Full camera uniform (view + proj + camPos), bound by the impostor pipeline.
  const camera_buffer = device.createBuffer({
    label: `large-system-camera-full`,
    size: CAMERA_FULL_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // GPU supercell uniform (Phase 1), bound to the impostor vertex (binding 5).
  // Defaults to dims (1,1,1) + base_count 0 + zero lattice ⇒ ncells 1, zero
  // offset; the renderer fills base_count from the atom count when atoms upload
  // and overwrites dims/lattice via set_supercell. Initialised to the identity
  // (1,1,1) below so an un-configured overlay draws exactly as before.
  const supercell_buffer = device.createBuffer({
    label: `large-system-supercell`,
    size: SUPERCELL_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // Shared atom/bond shading uniform. The atom impostor binds it at 8; the bond
  // renderer binds the same buffer at 6. Seeded with DEFAULT_SHADING so the
  // first frame is sane before the overlay publishes the viewer's settings.
  const shading_buffer = device.createBuffer({
    label: `large-system-shading`,
    size: SHADING_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  let shading_state = snapshot_shading(DEFAULT_SHADING)

  function upload_shading_uniform(): void {
    const f = pack_shading_uniform(shading_state)
    device.queue.writeBuffer(shading_buffer, 0, f.buffer, f.byteOffset, SHADING_BYTES)
  }
  upload_shading_uniform()
  // Cached supercell dims; ncells = product. Default [1,1,1] ⇒ ncells 1.
  let supercell_dims: [number, number, number] = [1, 1, 1]
  let supercell_ncells = 1
  // Cached base lattice rows (9 floats, rows a,b,c) for the per-cell offset.
  let supercell_lattice = new Float32Array(9)
  // Legacy show-image setter state. Packet mode owns the full boundary_policy
  // union below; legacy `true` maps to ghost-images and `false` to stub.
  let show_image_atoms = false

  // ── Packet-versioned upload channel (visual supercell design §5) ──────────
  // The last packet consumed by set_packet; diff_render_packet against it gates
  // every upload (topology buffers on topology version, positions+lattice on
  // frame version, dims/policy/indirect on replica version). null ⇒ everything
  // uploads on the first packet.
  let last_packet: RenderPacket | null = null
  // The active sparse ghost table. It is always derived from the SAME base bond
  // graph the bond draw consumes; the CPU copy also decodes ghost picks.
  let last_images: ImageInstanceTable | null = null
  const empty_images: ImageInstanceTable = {
    count: 0,
    base_sites: new Uint32Array(0),
    jimages: new Int8Array(0),
  }
  let active_cpu_graph: BaseBondGraph | null = null
  let pending_cpu_graph: BaseBondGraph | null = null
  let active_bond_count = 0
  let active_graph_revision = 0
  let active_ghost_sync_inflight = false
  const graph_readbacks = new Set<GPUBuffer>()
  // Replica boundary policy from the packet. 'ghost-images' draws the sparse
  // ghost instances and maps onto the show_image_atoms bond upgrade flag.
  let boundary_policy: BoundaryPolicy = `stub`
  // Sparse ghost-image instance buffers (impostor bindings 6/7, pick 4/5).
  // 4-byte placeholders keep the bind groups complete before any table uploads;
  // ghost_count === 0 means the draw never reaches the ghost instance range.
  let ghost_count = 0
  let ghost_capacity = 1
  let ghost_sites_buffer: GPUBuffer | null = device.createBuffer({
    label: `large-system-ghost-sites`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  let ghost_images_buffer: GPUBuffer | null = device.createBuffer({
    label: `large-system-ghost-images`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  // True while a PACKET-supplied base bond graph is the active draw graph: the
  // bond draw reads it directly and the GPU bond-detect compute NEVER
  // dispatches (the packet producer owns re-detection — a new bond-graph
  // version re-uploads). Cleared when a packet stops carrying a graph.
  let packet_graph = false
  // Explicit ownership prevents legacy setter fan-out and packet-version
  // caching from silently sharing stale state. Every legacy mutation clears
  // the packet cache; the next same-version packet is therefore a FULL restore.
  let ownership: 'legacy' | 'packet' = `legacy`
  // Generation captured by every async GPU candidate dispatch. Packet-graph
  // enter/exit and legacy↔packet ownership changes bump it; a validation whose
  // token no longer matches is discarded before bond_run.observe/publication.
  let graph_generation = 0

  // Atom storage buffers — lazily (re)created when the atom count grows.
  let positions_buffer: GPUBuffer | null = null
  let radii_buffer: GPUBuffer | null = null
  let colors_buffer: GPUBuffer | null = null
  let atom_capacity = 0 // instances the current buffers can hold
  let atom_count = 0 // instances to draw this frame
  // Initialise the supercell uniform to identity (dims 1,1,1 / zero lattice) so
  // the binding is valid before any set_supercell/set_atoms — ncells 1, zero
  // offset ⇒ the draw is identical to the non-supercell path. Must run AFTER
  // `atom_count` is declared (upload_supercell_uniform reads it) — else TDZ.
  upload_supercell_uniform()
  // Per-atom selection flag buffer (u32 per atom, 1 = selected), bound to the
  // impostor fragment (binding 4). Grows with the atom buffers; a 4-byte minimum
  // keeps the binding valid (and reads as "nothing selected") before any
  // selection is set. Re-created alongside positions when capacity grows.
  let selected_buffer: GPUBuffer | null = null
  let selected_capacity = 0

  // MSAA render targets, sized to the canvas backing store; recreated on resize.
  // - msaa_color: 4× multisampled COLOR target (canvas format). The render pass
  //   draws into this and RESOLVES into the swapchain texture each frame.
  // - depth_texture: 4× multisampled DEPTH target (depth24plus). Must match the
  //   color sampleCount so the pipelines (multisample.count = 4) are valid.
  let msaa_color_texture: GPUTexture | null = null
  let msaa_color_view: GPUTextureView | null = null
  let depth_texture: GPUTexture | null = null
  let depth_view: GPUTextureView | null = null

  // Bind group depends on the storage buffers, so rebuild whenever they change.
  let bind_group: GPUBindGroup | null = null

  // ── Bond resources (milestone 9.3) ──────────────────────────────────────
  // Covalent radii (N) for bond detection — distinct from the display radii.
  let covalent_buffer: GPUBuffer | null = null
  let covalent_capacity = 0
  // Per-atom element ids (N, binding 5) + packed element-pair distance rules
  // (binding 6) for the per-pair bond_distance_rules POST-FILTER in the compute
  // (matches src/lib/structure/scene/visibility.ts). Both default to a 4-byte
  // placeholder so the auto-layout bind group is always complete even before any
  // rules are pushed; with rule_count 0 the shader applies no filtering. The
  // elem-ids buffer grows with the atom count; the rules buffer is re-created on
  // each set_bond_rules (rule arrays are tiny — a few entries).
  let elem_ids_buffer: GPUBuffer | null = null
  let elem_ids_capacity = 0
  let rules_buffer: GPUBuffer | null = null
  let rules_capacity_bytes = 0
  // Packed rules last pushed; read at dispatch to repack Params.rule_count
  // (rules.length / 4). The actual rule floats also live in rules_buffer
  // (binding 6); this cache only drives the Params count + the upload.
  let bond_rules: Float32Array = new Float32Array(0)
  // GPU-resident bond outputs, split ACTIVE vs CANDIDATE (design §8.2): the
  // bond draw only ever reads the ACTIVE graph (the last COMPLETE one); the
  // compute writes into the CANDIDATE, which is swapped in only after its
  // overflow-free readback validates. `pairs` holds capacity*3 u32 (a,b,jimage);
  // the atomic counts are tiny fixed buffers (COPY_SRC so the candidate count
  // can be read back for validation).
  let active_pairs_buffer: GPUBuffer | null = null
  let candidate_pairs_buffer: GPUBuffer | null = null
  let active_pairs_capacity = 0 // pairs the ACTIVE buffer can hold (indirect clamp)
  let candidate_pairs_capacity = 0 // pairs the CANDIDATE buffer can hold
  // ── Uniform-grid (cell-list) buffers (bindings 7/8/9). cell_count tallies atoms
  // per cell (n_cells u32), cell_atoms holds up to cell_stride atom ids per cell
  // (n_cells*stride u32), grid_meta[0] records the max observed per-cell
  // occupancy for lossless cell-overflow detection. Sized from the dispatch
  // plan; grown when it needs more cells/atoms. A 4-byte minimum keeps the
  // bindings valid on the small-N direct path (which never touches them). ──
  let cell_count_buffer: GPUBuffer | null = null
  let cell_atoms_buffer: GPUBuffer | null = null
  let cell_count_cells = 0 // cells the cell_count buffer can hold
  let cell_atoms_slots = 0 // total (cells*stride) slots cell_atoms can hold
  const grid_meta_buffer = device.createBuffer({
    label: `large-system-bond-grid-meta`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  })
  // CPU copy of the current frame's atom xyz (3N), kept ONLY so the non-periodic
  // dispatch plan can compute the atom AABB on the CPU (the periodic plan needs
  // no positions). Updated by set_atoms / set_positions.
  let last_positions: Float32Array | null = null
  let active_count_buffer = device.createBuffer({
    label: `large-system-bond-count-active`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  })
  let candidate_count_buffer = device.createBuffer({
    label: `large-system-bond-count-candidate`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  })
  // Candidate-validation readback: [0] = raw pair count, [1] = max observed
  // cell occupancy. Mapped asynchronously after each candidate dispatch; while
  // a map is in flight no new candidate is dispatched (validation_inflight).
  const validation_readback = device.createBuffer({
    label: `large-system-bond-validation`,
    size: 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  // Deterministic overflow/publication controller (pure state; design §8.2).
  // The pair-capacity allocation limit derives from the device's storage-buffer
  // bound (12 bytes per pair) so growth can never exceed a bindable buffer.
  const bond_run = create_bond_run_controller({
    cell_stride: MAX_PER_CELL,
    pair_capacity: 1024,
    limits: {
      max_pair_capacity: Math.floor(
        (device.limits?.maxStorageBufferBindingSize ?? (1 << 27)) / 12,
      ),
    },
  })
  const indirect_buffer = device.createBuffer({
    label: `large-system-bond-indirect`,
    // draw args: vertex_count, instance_count, first_vertex, first_instance.
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  })
  const bond_params_buffer = device.createBuffer({
    label: `large-system-bond-params`,
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Bond render uniform: lattice rows (3×vec4) + edge style/opacity/color.
  const bond_render_uniform = device.createBuffer({
    label: `large-system-bond-render-uniform`,
    size: BOND_RENDER_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Cell-box render uniform: lattice rows a,b,c + origin + color (5×vec4).
  const cell_uniform = device.createBuffer({
    label: `large-system-cell-uniform`,
    size: CELL_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Gizmo placement uniform: center_ndc (vec4) + scale_ndc (vec4). Filled from
  // the canvas backing size so the triad sits in a fixed pixel-sized corner.
  const gizmo_uniform = device.createBuffer({
    label: `large-system-gizmo-uniform`,
    size: 32, // 2 × vec4
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Cached cell inputs (uploaded only when set_cell changes them).
  let cell_lattice = new Float32Array(9)
  let cell_show = false
  let cell_color: [number, number, number] = [0.5, 0.5, 0.5]
  let cell_origin: [number, number, number] = [0, 0, 0]
  // True once the lattice is non-zero (a periodic structure has been provided).
  let cell_has_lattice = false

  // cfg for the indirect-args build: (verts_per_cylinder, bond capacity, ncells).
  // The build shader clamps the bond count to capacity, doubles it (two half-
  // cylinders per bond), then multiplies by ncells (GPU supercell Phase 2 bond
  // replication) ⇒ instance_count = 2·min(count,capacity)·ncells. ncells defaults
  // to 1 ⇒ the Phase-1 single-cell count. A vec3<u32> uniform is 12 bytes; round
  // the buffer to 16 (uniform buffers bind in 16-byte granularity anyway).
  const indirect_cfg_buffer = device.createBuffer({
    label: `large-system-indirect-cfg`,
    size: 16, // vec3<u32> (12 bytes, padded to 16)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // bond_meta: clamped bond_count written by the indirect-args build, read by the
  // bond RENDER vertex shader to decode inst → (cell, bond_index, half). A tiny
  // 4-byte storage buffer.
  const bond_meta_buffer = device.createBuffer({
    label: `large-system-bond-meta`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  // Detection inputs may be refreshed by set_bond_data even while packet mode
  // owns rendering. Keep its lattice separate so detector updates cannot overwrite
  // the packet frame lattice used to shift periodic bond endpoints.
  let bond_detector_lattice = new Float32Array(9)
  let bond_render_lattice = new Float32Array(9)
  let bond_style = normalize_bond_style()
  let bond_options = { scale: 0, max_bond_dist: 0, min_bond_dist: 0 }
  let bond_periodic = false
  let bond_n = 0 // atom count the detection should range over
  // ── Dirty-kind split (design §8.2 items 4-6). `graph_dirty`: the base bond
  // graph must be re-detected (positions/lattice/topology/rules/options).
  // `replica_dirty`: only the indirect draw args must refresh (supercell
  // tiling / image policy) — NEVER triggers a bond dispatch. Visual changes
  // (camera/background/selection/hover) mark neither. ──
  let graph_dirty = false
  let replica_dirty = false
  // True when the NEXT candidate dispatch starts a fresh invalidation chain
  // (resets the controller's retry counter); overflow retries re-set
  // graph_dirty WITHOUT this flag so the retry budget keeps counting.
  let fresh_graph = false
  // A candidate readback is in flight — no new candidate may dispatch (the
  // single validation_readback buffer can hold only one pending map).
  let validation_inflight = false
  let candidate_graph_sync_inflight = false
  let pending_bond_count = 0
  // A validated (complete) candidate awaits publication on the next render.
  let publish_pending = false
  // Host wake signal (see LargeSystemRenderer.on_bond_work): fired from
  // begin_validation's resolution — the one place async bond state
  // transitions outside a render() call — so a dirty-gated host schedules
  // the frame that publishes / reruns / settles. NOT fired per render.
  let bond_work_cb: (() => void) | null = null
  // The dispatch policy refused the GPU path (periodic thin cell / storage
  // budget): Bonds T6 routes those graphs through the Rust-WASM worker
  // (compute_bonds_typed). While set, the GPU compute never dispatches; the
  // ACTIVE graph stays on screen until the typed result uploads over it.
  let required_backend: 'periodic-thin-cell' | 'grid-storage-limit' | null = null
  // One typed rust-wasm request in flight at a time (latest wins): while set,
  // a still-dirty graph waits — completion wakes the host, whose next render
  // re-dispatches against the newest inputs.
  let wasm_bonds_inflight = false
  let bonds_configured = false // set once set_bond_data has provided inputs
  let validation_generation = 0

  // ── Device-loss transaction (Bonds T6) ─────────────────────────────────
  // Once the GPUDevice reports loss: `device_lost` gates EVERY submission
  // channel (render/pick/setters/readbacks) immediately, scene/owner state is
  // deliberately RETAINED (the WebGL2+WASM fallback takes over the SAME
  // packet source), and the host is notified EXACTLY ONCE via the one-slot
  // callback below.
  let device_lost = false
  let device_lost_info: GPUDeviceLostInfo | undefined = undefined
  let device_lost_cb: ((info?: GPUDeviceLostInfo) => void) | null = null
  let device_loss_notified = false

  function bump_graph_generation(): void {
    graph_generation++
    // A validated-but-not-yet-published graph belongs to the previous owner /
    // graph generation and must never swap in after this transition.
    publish_pending = false
    pending_cpu_graph = null
    pending_bond_count = 0
  }

  /** Switch shared renderer state to the legacy setter channel. Always clear
   *  packet identity caches so a same-object/same-version packet can fully
   *  restore after the legacy mutation. */
  function claim_legacy_ownership(): void {
    last_packet = null
    last_images = null
    ghost_count = 0
    if (ownership === `legacy`) return
    ownership = `legacy`
    boundary_policy = show_image_atoms ? `ghost-images` : `stub`
    bump_graph_generation()
    if (packet_graph) upload_packet_bond_graph(undefined)
    upload_supercell_uniform()
    mark_bond_dirty(classify_bond_dirty(`image-policy`))
  }

  /** Switch to packet ownership. The legacy channel already cleared
   *  last_packet, so the first packet after a legacy mutation diffs as FULL. */
  function claim_packet_ownership(): void {
    if (ownership === `packet`) return
    ownership = `packet`
    bump_graph_generation()
  }

  /** Route a scene-change kind into the dirty flags. `visual` is a no-op. */
  function mark_bond_dirty(kind: BondDirtyKind): void {
    if (kind === `graph`) {
      graph_dirty = true
      fresh_graph = true
    } else if (kind === `replica`) {
      replica_dirty = true
    }
  }
  // Gates the bond compute + bond draw. When false the overlay shows no bonds
  // (atoms + cell still render), mirroring the WebGL view's should_show_bonds.
  // Default true ⇒ unchanged behaviour until the caller threads visibility in.
  let bonds_enabled = true

  // Bind groups rebuilt when the underlying buffers (re)allocate.
  let bond_compute_bg: GPUBindGroup | null = null
  let indirect_bg: GPUBindGroup | null = null
  let bond_render_bg: GPUBindGroup | null = null

  const shader = device.createShaderModule({
    label: `large-system-impostor`,
    code: IMPOSTOR_WGSL,
  })

  const bind_group_layout = device.createBindGroupLayout({
    label: `large-system-impostor-bgl`,
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      // binding 4: per-atom selection flag `selected`. The BUFFER is indexed in
      // vs_main by the DECODED base atom (`selected[atom]`, atom = inst %
      // base_count) -> flat varying `out.sel`, so EVERY supercell replica of a
      // selected base atom glows (the buffer stays BASE-sized). fs_main reads only
      // that varying, never the buffer. So the binding's referencing stage is
      // VERTEX. (A prior layout granted FRAGMENT-only, mismatching vs_main and
      // invalidating the pipeline -> blank overlay.) Granted VERTEX|FRAGMENT —
      // VERTEX is required; FRAGMENT is the highlight stage that plausibly reads
      // it, so OR both per the project's recurrence-proof rule.
      { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `read-only-storage` } },
      // binding 5: GPU supercell uniform. Read ONLY in vs_main (decode of
      // instance_index → atom + lattice offset); fs_main never touches it. Per the
      // project's recurrence-proof rule, grant EXACTLY the stage that reads it —
      // VERTEX only. (A spurious FRAGMENT here would not break, but VERTEX is the
      // precise + minimal visibility the binding requires.)
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
      // bindings 6/7: sparse ghost-image instance table (packet path). Read ONLY
      // in vs_main (instance decode past the replica range) — VERTEX only.
      { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      // binding 8: atom shading uniform (headlamp, ambient/directional, render
      // style, depth cue, outline). Read ONLY in fs_main — the vertex stage does
      // no shading — so FRAGMENT only, per the project's minimal-visibility rule.
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
    ],
  })

  const pipeline = device.createRenderPipeline({
    label: `large-system-impostor-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bind_group_layout] }),
    vertex: { module: shader, entryPoint: `vs_main` },
    fragment: { module: shader, entryPoint: `fs_main`, targets: [{ format }] },
    // Camera-facing billboards must never be back-face culled — winding flips
    // depending on view, so cull nothing.
    primitive: { topology: `triangle-strip`, cullMode: `none` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
    // 4× MSAA. alphaToCoverageEnabled turns the fragment's alpha (= analytic
    // silhouette coverage) into fractional MSAA sample coverage, so the curved
    // sphere edge — defined by ray-miss discard — gets antialiased. The color
    // target stays opaque (no blend); alpha is consumed ONLY as coverage.
    multisample: { count: SAMPLE_COUNT, alphaToCoverageEnabled: true },
  })

  // ── Atom PICK pipeline (id-buffer) ───────────────────────────────────────
  // Re-renders the atoms single-sampled into an R32Uint id texture (atom_index+1)
  // with its own single-sample depth so the front atom wins. Reuses the camera +
  // positions + radii buffers (a subset of the color pass's bind group), with its
  // OWN bind group layout (no colors / selected). pick() runs this pass on demand
  // and copies one texel back to the CPU.
  const PICK_ID_FORMAT: GPUTextureFormat = `r32uint`
  const pick_module = device.createShaderModule({
    label: `large-system-pick`,
    code: PICK_WGSL,
  })
  const pick_bgl = device.createBindGroupLayout({
    label: `large-system-pick-bgl`,
    entries: [
      // binding 0 = camera: read by BOTH vs_main (view+proj billboard) AND
      // fs_main (camera.proj projects the ray-traced view-space hit point for
      // frag_depth). A prior layout granted VERTEX-only, mismatching fs_main and
      // invalidating the pick pipeline ("fragment stage is not in binding
      // visibility") -> the whole frame submit failed (blank overlay). Must be
      // VERTEX|FRAGMENT.
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      // bindings 1-2 (positions, radii) are read only by vs_main — fs_main works
      // off interpolated VsOut varyings — so VERTEX-only.
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      // binding 3 = GPU supercell uniform (Phase 4). Read ONLY in vs_main (instance
      // decode → atom + cell offset), so VERTEX-only — granting FRAGMENT here would
      // mismatch the shader and invalidate the pick pipeline (the same bind-group-
      // visibility rule that bit binding 0 above).
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
      // bindings 4/5: sparse ghost-image instance table (packet path), read ONLY
      // in vs_main — VERTEX only, mirroring the atom impostor's bindings 6/7.
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
    ],
  })
  const pick_pipeline = device.createRenderPipeline({
    label: `large-system-pick-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [pick_bgl] }),
    vertex: { module: pick_module, entryPoint: `vs_main` },
    fragment: { module: pick_module, entryPoint: `fs_main`, targets: [{ format: PICK_ID_FORMAT }] },
    primitive: { topology: `triangle-strip`, cullMode: `none` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
    // Single-sampled — picking needs exact per-pixel ids, no MSAA resolve.
    multisample: { count: 1 },
  })
  // Pick render targets (single-sample), sized to the canvas backing store and
  // recreated on resize alongside the MSAA targets.
  let pick_id_texture: GPUTexture | null = null
  let pick_id_view: GPUTextureView | null = null
  let pick_depth_texture: GPUTexture | null = null
  let pick_depth_view: GPUTextureView | null = null
  let pick_bind_group: GPUBindGroup | null = null
  // 256-byte-aligned readback staging buffer for a single R32Uint texel. WebGPU
  // requires bytesPerRow be a multiple of 256 for texture→buffer copies, so we
  // copy a 1×1 region into a 256-byte buffer and read the first 4 bytes.
  const pick_readback = device.createBuffer({
    label: `large-system-pick-readback`,
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  // Bond-detect compute (BOND_COMPUTE_WGSL). Three entry points share ONE explicit
  // bind-group layout (clear_grid / bin_atoms / detect_bonds) so a single bond
  // compute bind group binds all three pipelines. Bindings: 0 positions, 1 radii,
  // 2 params, 3 out_pairs, 4 out_count, 5 elem_ids, 6 rules, 7 cell_count,
  // 8 cell_atoms, 9 overflow.
  const bond_compute_module = device.createShaderModule({
    label: `large-system-bond-compute`,
    code: BOND_COMPUTE_WGSL,
  })
  const bc_storage = (rw: boolean): GPUBindGroupLayoutEntry[`buffer`] => ({
    type: rw ? `storage` : `read-only-storage`,
  })
  const bond_compute_bgl = device.createBindGroupLayout({
    label: `large-system-bond-compute-bgl`,
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(false) },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(false) },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: `uniform` } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(true) },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(true) },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(false) },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(false) },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(true) },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(true) },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: bc_storage(true) },
    ],
  })
  const bond_compute_layout = device.createPipelineLayout({
    bindGroupLayouts: [bond_compute_bgl],
  })
  const bond_compute_pipeline = device.createComputePipeline({
    label: `large-system-bond-compute-pipeline`,
    layout: bond_compute_layout,
    compute: { module: bond_compute_module, entryPoint: `detect_bonds` },
  })
  const bond_clear_pipeline = device.createComputePipeline({
    label: `large-system-bond-clear-pipeline`,
    layout: bond_compute_layout,
    compute: { module: bond_compute_module, entryPoint: `clear_grid` },
  })
  const bond_bin_pipeline = device.createComputePipeline({
    label: `large-system-bond-bin-pipeline`,
    layout: bond_compute_layout,
    compute: { module: bond_compute_module, entryPoint: `bin_atoms` },
  })
  // Small-N direct all-pairs shader (separate module — the large-N grid shader
  // contains no all-pairs loop). Shares the explicit layout/bind group; it only
  // declares bindings 0-6 and never touches the grid buffers.
  const bond_direct_module = device.createShaderModule({
    label: `large-system-bond-direct`,
    code: BOND_COMPUTE_DIRECT_WGSL,
  })
  const bond_direct_pipeline = device.createComputePipeline({
    label: `large-system-bond-direct-pipeline`,
    layout: bond_compute_layout,
    compute: { module: bond_direct_module, entryPoint: `detect_bonds` },
  })

  // Indirect-args build: read atomic count, write drawIndirect args.
  const indirect_module = device.createShaderModule({
    label: `large-system-indirect-args`,
    code: INDIRECT_ARGS_WGSL,
  })
  const indirect_pipeline = device.createComputePipeline({
    label: `large-system-indirect-args-pipeline`,
    layout: `auto`,
    compute: { module: indirect_module, entryPoint: `build_args` },
  })

  // Bond render: instanced procedural cylinders.
  const bond_render_module = device.createShaderModule({
    label: `large-system-bond-render`,
    code: BOND_RENDER_WGSL,
  })
  const bond_render_bgl = device.createBindGroupLayout({
    label: `large-system-bond-render-bgl`,
    entries: [
      // binding 0 = camera: read by BOTH vs_main (view+proj billboard) AND
      // fs_main (camera.proj for the frag_depth projection of the ray-traced hit
      // point). The impostor-cylinder rewrite moved that projection into the
      // fragment stage, so this binding MUST be visible to FRAGMENT too —
      // otherwise the pipeline is invalid ("entry point's stage is not in the
      // binding visibility") and the whole frame submit fails (blank overlay).
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      // bindings 1-3 (positions, pairs, bond uniform) are read only by vs_main —
      // fs_main works entirely off interpolated VsOut varyings — so VERTEX-only.
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
      // binding 4 = bond_meta (clamped bond_count) and binding 5 = the GPU
      // supercell uniform (dims + base lattice). Both are read ONLY in vs_main
      // (the Phase-2 inst → cell/bond/half decode + partner-cell test); fs_main
      // never touches them. Per the project's recurrence-proof bind-group rule,
      // grant EXACTLY the reading stage — VERTEX only.
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
      // binding 6 = the SAME atom shading uniform. fs_main reads the headlamp,
      // specular strength and depth-cue params from it, so bonds are lit from the
      // same direction as the atoms and fade into the same fog. FRAGMENT only.
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      // binding 7 = authoritative base atom colors, indexed by bond endpoint in
      // vs_main and forwarded as endpoint varyings. VERTEX only.
      { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: `read-only-storage` } },
    ],
  })
  const bond_render_pipeline = device.createRenderPipeline({
    label: `large-system-bond-render-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bond_render_bgl] }),
    vertex: { module: bond_render_module, entryPoint: `vs_main` },
    fragment: { module: bond_render_module, entryPoint: `fs_main`, targets: [{ format }] },
    // Impostor cylinder is a screen-aligned capsule-bounding billboard (6-vert
    // triangle-STRIP hull, matching BOND_VERTS_PER_CYLINDER); the fragment shader
    // ray-traces the smooth capped finite cylinder. cullMode none — the hull
    // winding flips with view, and the impostor is one-sided per-fragment regardless.
    primitive: { topology: `triangle-strip`, cullMode: `none` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
    // 4× MSAA + alpha-to-coverage: same as the atom impostor. The capsule
    // silhouette (body + caps), defined by ray-miss discard, outputs fractional
    // coverage as alpha so the curved/grazing bond edges are smoothly AA'd.
    multisample: { count: SAMPLE_COUNT, alphaToCoverageEnabled: true },
  })

  // Cell-box render: 12 edges as a thin line-list. Binds camera + cell uniform.
  const cell_module = device.createShaderModule({
    label: `large-system-cell-line`,
    code: CELL_LINE_WGSL,
  })
  const cell_bgl = device.createBindGroupLayout({
    label: `large-system-cell-bgl`,
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
    ],
  })
  const cell_pipeline = device.createRenderPipeline({
    label: `large-system-cell-line-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [cell_bgl] }),
    vertex: { module: cell_module, entryPoint: `vs_main` },
    fragment: { module: cell_module, entryPoint: `fs_main`, targets: [{ format }] },
    primitive: { topology: `line-list` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
    // 4× MSAA so the opaque cell lines share the multisampled targets and get
    // geometric edge AA. No alpha-to-coverage — lines aren't silhouette-discard
    // impostors, and the fragment alpha stays 1 (fully opaque).
    multisample: { count: SAMPLE_COUNT },
  })
  const cell_bind_group = device.createBindGroup({
    label: `large-system-cell-bg`,
    layout: cell_bgl,
    entries: [
      { binding: 0, resource: { buffer: camera_buffer } },
      { binding: 1, resource: { buffer: cell_uniform } },
    ],
  })

  // Axis-orientation gizmo: a small corner XYZ triad as a line-list (22 verts:
  // 6 axis + 16 letter-glyph endpoints).
  // Binds the camera (for the view rotation) + the gizmo placement uniform. Runs
  // with depthCompare:`always` + no depth write, drawn LAST, so it is ALWAYS
  // visible (never occluded by atoms/bonds) and never disturbs scene depth.
  const gizmo_module = device.createShaderModule({
    label: `large-system-gizmo`,
    code: GIZMO_WGSL,
  })
  const gizmo_bgl = device.createBindGroupLayout({
    label: `large-system-gizmo-bgl`,
    entries: [
      // binding 0 = camera: the SDF fragment stage extracts the view rotation
      // (fs_main is where all drawing happens now). VERTEX is OR'd in as the
      // plausible future reader, per the project's recurrence-proof rule.
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
      // binding 1 = placement: vs_main positions the quad, fs_main reads the
      // pixel scales — both stages genuinely read it.
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: `uniform` } },
    ],
  })
  const gizmo_pipeline = device.createRenderPipeline({
    label: `large-system-gizmo-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [gizmo_bgl] }),
    vertex: { module: gizmo_module, entryPoint: `vs_main` },
    fragment: {
      module: gizmo_module,
      entryPoint: `fs_main`,
      // The quad covers the whole widget box; everything outside the SDF shapes
      // has alpha 0 and must show the scene through — so this pipeline blends.
      // The shader composites internally and outputs PREMULTIPLIED color, hence
      // src factor `one` (not src-alpha).
      targets: [{
        format,
        blend: {
          color: { srcFactor: `one`, dstFactor: `one-minus-src-alpha`, operation: `add` },
          alpha: { srcFactor: `one`, dstFactor: `one-minus-src-alpha`, operation: `add` },
        },
      }],
    },
    primitive: { topology: `triangle-strip` },
    depthStencil: {
      format: DEPTH_FORMAT,
      // Always visible: never write depth, never fail the depth test. The gizmo
      // overwrites its corner regardless of what atoms/bonds drew there.
      depthWriteEnabled: false,
      depthCompare: `always`,
    },
    // Share the multisampled targets (count must match). No alpha-to-coverage —
    // the SDF coverage feeds alpha BLENDING here, not sample masking.
    multisample: { count: SAMPLE_COUNT },
  })
  const gizmo_bind_group = device.createBindGroup({
    label: `large-system-gizmo-bg`,
    layout: gizmo_bgl,
    entries: [
      { binding: 0, resource: { buffer: camera_buffer } },
      { binding: 1, resource: { buffer: gizmo_uniform } },
    ],
  })

  /** Gizmo layout inputs, mirrored from the DOM side (the renderer only knows
   *  device pixels). dpr converts the CSS-pixel spec below into device px;
   *  safe_left/safe_bottom are the pane's HUD safe-area insets (docked-toolbar
   *  avoidance) — the same hud_safe the WebGL gizmo's offset uses. */
  const gizmo_layout = { dpr: 1, safe_left: 0, safe_bottom: 0 }

  /** Pack + upload the gizmo placement uniform from the canvas backing size +
   *  the DOM layout inputs. Replicates the WebGL widget's box: bottom-left
   *  anchored, responsive size, HUD-safe-area offset. Layout (see GizmoU):
   *  - place.xy: widget CENTER in NDC (x∈[-1,1] right, y∈[-1,1] UP)
   *  - place.z:  half-extent R in device px (the quad spans ±R)
   *  - place.w:  unit_px = R / 1.8 — the widget's internal ortho unit (the
   *    reference gizmo renders a ±1.8 frustum into its box)
   *  - px.xy:    device-px → NDC scale (2/w, 2/h)
   *  - px.z:     axis line HALF-width in device px (lineWidth 4 CSS px / 2) */
  function upload_gizmo_uniform(): void {
    const layout = resolve_gizmo_layout({
      width_device_px: canvas.width,
      height_device_px: canvas.height,
      dpr: gizmo_layout.dpr,
      safe_left_css_px: gizmo_layout.safe_left,
      safe_bottom_css_px: gizmo_layout.safe_bottom,
    })
    const u = new Float32Array(8)
    u[0] = layout.center_ndc[0]
    u[1] = layout.center_ndc[1]
    u[2] = layout.radius_device_px
    u[3] = layout.unit_device_px
    u[4] = layout.pixel_to_ndc[0]
    u[5] = layout.pixel_to_ndc[1]
    u[6] = layout.line_half_width_device_px
    u[7] = 0
    device.queue.writeBuffer(gizmo_uniform, 0, u.buffer, u.byteOffset, 32)
  }

  /** Pack + upload lattice rows, transformed origin, then linear-RGB color. */
  function upload_cell_uniform(): void {
    const u = pack_cell_uniform(cell_lattice, cell_origin, cell_color)
    device.queue.writeBuffer(cell_uniform, 0, u.buffer, u.byteOffset, CELL_BYTES)
  }

  // Indirect-args cfg: (verts_per_cylinder, capacity, ncells). capacity is the
  // ACTIVE pairs buffer's (the indirect build reads the ACTIVE count, so its
  // clamp must match the buffer the bond render reads); refreshed on publication
  // swaps. ncells refreshes when set_supercell changes the tiling; defaults to
  // 1 ⇒ the single-cell instance count.
  function write_indirect_cfg(): void {
    device.queue.writeBuffer(
      indirect_cfg_buffer, 0,
      new Uint32Array([
        BOND_VERTS_PER_CYLINDER,
        active_pairs_capacity,
        Math.max(1, supercell_ncells),
      ]),
    )
  }

  /** Ghost instances appended to the atom + pick draws this frame: the sparse
   *  table size under the 'ghost-images' boundary policy, else 0 (the table
   *  stays uploaded but undrawn — flipping the policy back needs no re-upload). */
  function ghost_draw_count(): number {
    return boundary_policy === `ghost-images` ? ghost_count : 0
  }

  // (Re)create both MSAA render targets (color + depth) at the canvas backing
  // size. Destroy the old textures first so resize never leaks. Both are
  // multisampled at SAMPLE_COUNT — the color resolves into the swapchain, the
  // depth is transient (storeOp:`discard` is fine but we keep `store` for
  // simplicity; nothing reads it after the pass).
  function ensure_targets(w: number, h: number): void {
    const width = Math.max(1, w)
    const height = Math.max(1, h)
    msaa_color_texture?.destroy()
    depth_texture?.destroy()
    msaa_color_texture = device.createTexture({
      label: `large-system-msaa-color`,
      size: { width, height },
      format,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    msaa_color_view = msaa_color_texture.createView()
    depth_texture = device.createTexture({
      label: `large-system-depth`,
      size: { width, height },
      format: DEPTH_FORMAT,
      sampleCount: SAMPLE_COUNT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depth_view = depth_texture.createView()

    // Single-sample PICK targets at the SAME device-pixel size so a (x,y) read
    // maps 1:1 to the color view. The id texture needs COPY_SRC for the readback.
    pick_id_texture?.destroy()
    pick_depth_texture?.destroy()
    pick_id_texture = device.createTexture({
      label: `large-system-pick-id`,
      size: { width, height },
      format: PICK_ID_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    pick_id_view = pick_id_texture.createView()
    pick_depth_texture = device.createTexture({
      label: `large-system-pick-depth`,
      size: { width, height },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    pick_depth_view = pick_depth_texture.createView()
  }
  ensure_targets(canvas.width || 1, canvas.height || 1)
  upload_gizmo_uniform() // seed corner placement from the initial canvas size

  /** Ensure the per-atom selection buffer (binding 4) holds at least `cap`
   *  entries. Created/grown with a 4-byte minimum so the binding is always valid
   *  (reads 0 = nothing selected) before any selection is pushed. */
  function ensure_selected_capacity(cap: number): void {
    const want = Math.max(cap, 1)
    if (want <= selected_capacity && selected_buffer) return
    selected_buffer?.destroy()
    selected_capacity = Math.max(want, Math.ceil(selected_capacity * 2), 1)
    selected_buffer = device.createBuffer({
      label: `large-system-selected`,
      size: Math.max(selected_capacity * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
  }

  function rebuild_bind_group(): void {
    if (!positions_buffer || !radii_buffer || !colors_buffer) {
      bind_group = null
      return
    }
    // binding 4 must exist for the layout; lazily create the placeholder.
    if (!selected_buffer) ensure_selected_capacity(atom_capacity)
    bind_group = device.createBindGroup({
      label: `large-system-impostor-bg`,
      layout: bind_group_layout,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: radii_buffer } },
        { binding: 3, resource: { buffer: colors_buffer } },
        { binding: 4, resource: { buffer: selected_buffer as GPUBuffer } },
        { binding: 5, resource: { buffer: supercell_buffer } },
        // bindings 6/7: sparse ghost instance table (placeholders when empty).
        { binding: 6, resource: { buffer: ghost_sites_buffer as GPUBuffer } },
        { binding: 7, resource: { buffer: ghost_images_buffer as GPUBuffer } },
        { binding: 8, resource: { buffer: shading_buffer } },
      ],
    })
    // Pick pass reuses camera + positions + radii (no colors/selected) PLUS the
    // GPU supercell uniform (Phase 4) so the pick vs decodes the cell identically
    // to the atom draw and clicks hit the right replica, PLUS the ghost table
    // (bindings 4/5) so ghost instances are pickable in the same id space.
    pick_bind_group = device.createBindGroup({
      label: `large-system-pick-bg`,
      layout: pick_bgl,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: radii_buffer } },
        { binding: 3, resource: { buffer: supercell_buffer } },
        { binding: 4, resource: { buffer: ghost_sites_buffer as GPUBuffer } },
        { binding: 5, resource: { buffer: ghost_images_buffer as GPUBuffer } },
      ],
    })
  }

  /** Upload the sparse ghost ImageInstanceTable (design §7.2: ghosts are
   *  (base_site, absolute jimage) instances — NEVER appended sites). Buffers
   *  hold exactly `count` entries (grown geometrically, never dense); jimages
   *  pack 3 biased Int8 lanes into one u32 per ghost. The table reference is
   *  kept CPU-side so pick() can decode ghost instance ids. */
  function upload_ghost_table(images: ImageInstanceTable): void {
    last_images = images
    const count = Math.max(0, images.count | 0)
    ghost_count = count
    if (count === 0) return
    if (count > ghost_capacity || !ghost_sites_buffer || !ghost_images_buffer) {
      ghost_sites_buffer?.destroy()
      ghost_images_buffer?.destroy()
      ghost_capacity = Math.max(count, Math.ceil(ghost_capacity * 2), 1)
      ghost_sites_buffer = device.createBuffer({
        label: `large-system-ghost-sites`,
        size: ghost_capacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      ghost_images_buffer = device.createBuffer({
        label: `large-system-ghost-images`,
        size: ghost_capacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      rebuild_bind_group()
    }
    device.queue.writeBuffer(
      ghost_sites_buffer as GPUBuffer, 0,
      images.base_sites.buffer, images.base_sites.byteOffset, count * 4,
    )
    const packed = new Uint32Array(count)
    for (let gi = 0; gi < count; gi++) {
      packed[gi] = pack_jimage(
        images.jimages[gi * 3],
        images.jimages[gi * 3 + 1],
        images.jimages[gi * 3 + 2],
      )
    }
    device.queue.writeBuffer(
      ghost_images_buffer as GPUBuffer, 0, packed.buffer, 0, count * 4,
    )
  }

  function derive_ghost_table(graph: BaseBondGraph | null): ImageInstanceTable {
    if (!graph || boundary_policy !== `ghost-images`) return empty_images
    return build_image_instance_table(graph, supercell_dims, boundary_policy)
  }

  async function read_gpu_graph(
    source: GPUBuffer,
    count: number,
    version: number,
  ): Promise<BaseBondGraph | null> {
    // Device loss stops ALL submissions — this path encodes a copy + submit.
    if (device_lost) return null
    if (count === 0) {
      return {
        version,
        pairs: new Uint32Array(0),
        jimages: new Int8Array(0),
        kinds: new Uint8Array(0),
        strengths: new Float32Array(0),
      }
    }
    const bytes = count * 3 * 4
    const readback = device.createBuffer({
      label: `large-system-bond-graph-readback`,
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    graph_readbacks.add(readback)
    const encoder = device.createCommandEncoder({ label: `large-system-bond-graph-copy` })
    encoder.copyBufferToBuffer(source, 0, readback, 0, bytes)
    device.queue.submit([encoder.finish()])
    try {
      await readback.mapAsync(GPUMapMode.READ, 0, bytes)
      if (destroyed || device_lost) return null
      const words = new Uint32Array(readback.getMappedRange(0, bytes))
      const pairs = new Uint32Array(count * 2)
      const jimages = new Int8Array(count * 3)
      for (let bi = 0; bi < count; bi++) {
        pairs[bi * 2] = words[bi * 3]
        pairs[bi * 2 + 1] = words[bi * 3 + 1]
        const ji = unpack_jimage(words[bi * 3 + 2])
        jimages[bi * 3] = ji[0]
        jimages[bi * 3 + 1] = ji[1]
        jimages[bi * 3 + 2] = ji[2]
      }
      readback.unmap()
      return {
        version,
        pairs,
        jimages,
        kinds: new Uint8Array(count),
        strengths: new Float32Array(count),
      }
    } catch {
      return null
    } finally {
      graph_readbacks.delete(readback)
      readback.destroy()
    }
  }

  function sync_active_ghost_table(): void {
    if (boundary_policy !== `ghost-images`) {
      upload_ghost_table(empty_images)
      return
    }
    if (active_cpu_graph) {
      upload_ghost_table(derive_ghost_table(active_cpu_graph))
      upload_supercell_uniform()
      return
    }
    if (active_bond_count === 0 || !active_pairs_buffer) {
      upload_ghost_table(empty_images)
      return
    }
    if (active_ghost_sync_inflight) return
    active_ghost_sync_inflight = true
    const revision = active_graph_revision
    const source = active_pairs_buffer
    const count = active_bond_count
    void read_gpu_graph(source, count, revision).then((graph) => {
      active_ghost_sync_inflight = false
      if (destroyed || device_lost) return
      if (revision !== active_graph_revision || !graph) return
      active_cpu_graph = graph
      upload_ghost_table(derive_ghost_table(graph))
      upload_supercell_uniform()
      bond_work_cb?.()
    })
  }

  /** (Re)allocate the atom storage buffers (positions/radii/colors + the
   *  selection flags) to hold at least `n` atoms, growing with headroom.
   *  Returns true when a reallocation happened — buffer CONTENTS are undefined
   *  until re-uploaded, and every bind group referencing them was rebuilt. */
  function ensure_atom_capacity(n: number): boolean {
    if (n <= atom_capacity) return false
    const new_cap = Math.max(n, Math.ceil(atom_capacity * 2), 1)
    positions_buffer?.destroy()
    radii_buffer?.destroy()
    colors_buffer?.destroy()
    positions_buffer = device.createBuffer({
      label: `large-system-positions`,
      size: new_cap * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    radii_buffer = device.createBuffer({
      label: `large-system-radii`,
      size: new_cap * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    colors_buffer = device.createBuffer({
      label: `large-system-colors`,
      size: new_cap * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    atom_capacity = new_cap
    // Grow the selection buffer in lockstep so binding 4 covers every atom.
    // (Newly-grown slots default to 0 = unselected; set_selection re-uploads.)
    ensure_selected_capacity(new_cap)
    rebuild_bind_group()
    // positions_buffer just reallocated ⇒ rebuild the bond bind groups that
    // reference it (they may have been null before, that's fine).
    rebuild_bond_bind_groups()
    return true
  }

  /** Ensure the CANDIDATE pairs buffer holds at least `cap` bonds (the compute
   *  target; grown by overflow retries and the n·16 heuristic) and that an
   *  ACTIVE pairs buffer exists (the draw source; it starts empty — count 0 —
   *  and is only ever replaced by a validated candidate via the publication
   *  swap, so the last complete graph is preserved on every failure). */
  function ensure_pair_buffers(cap: number): void {
    const want = Math.max(cap, 1024)
    let changed = false
    if (want > candidate_pairs_capacity || !candidate_pairs_buffer) {
      candidate_pairs_buffer?.destroy()
      candidate_pairs_capacity = want
      candidate_pairs_buffer = device.createBuffer({
        label: `large-system-bond-pairs-candidate`,
        size: want * 3 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      })
      changed = true
    }
    if (!active_pairs_buffer) {
      active_pairs_capacity = want
      active_pairs_buffer = device.createBuffer({
        label: `large-system-bond-pairs-active`,
        size: want * 3 * 4,
        // COPY_DST so a PACKET-supplied base bond graph can be written into the
        // active buffer directly (upload_packet_bond_graph) — the GPU-detect
        // path itself never CPU-writes it.
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
      changed = true
    }
    if (changed) {
      write_indirect_cfg()
      rebuild_bond_bind_groups()
    }
  }

  /** Grow the ACTIVE pairs buffer so a packet-supplied bond graph of `cap`
   *  bonds fits. Distinct from ensure_pair_buffers (which grows the CANDIDATE
   *  compute target and only ever CREATES the active buffer). */
  function ensure_active_pairs_capacity(cap: number): void {
    if (cap <= active_pairs_capacity && active_pairs_buffer) return
    active_pairs_buffer?.destroy()
    active_pairs_capacity = Math.max(cap, Math.ceil(active_pairs_capacity * 2), 1024)
    active_pairs_buffer = device.createBuffer({
      label: `large-system-bond-pairs-active`,
      size: active_pairs_capacity * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    write_indirect_cfg()
    rebuild_bond_bind_groups()
  }

  /** Upload a PACKET-supplied base bond graph as the ACTIVE draw graph (design
   *  §7.2): pairs pack 1:1 into the bond-render (a, b, jimage) triplet layout —
   *  periodic self-image edges (a === b, jimage ≠ 0) are NEVER filtered — and
   *  the bond count lands in the active count buffer, so the next indirect-args
   *  build (replica_dirty) sizes the draw from it. While a packet graph is
   *  active the GPU bond-detect compute never dispatches; `undefined` clears
   *  that mode and re-arms GPU detection (if configured). */
  function upload_packet_bond_graph(graph: BaseBondGraph | undefined): void {
    if (!graph) {
      if (packet_graph) {
        bump_graph_generation()
        packet_graph = false
        // Clear the drawn count so the stale packet graph vanishes; GPU
        // detection (if set_bond_data configured it) re-runs from scratch.
        device.queue.writeBuffer(active_count_buffer, 0, new Uint32Array([0]))
        active_cpu_graph = null
        active_bond_count = 0
        active_graph_revision++
        sync_active_ghost_table()
        replica_dirty = true
        graph_dirty = true
        fresh_graph = true
      }
      return
    }
    // A new packet graph supersedes every in-flight GPU candidate, including a
    // candidate dispatched before packet ownership was claimed.
    bump_graph_generation()
    const bond_count = graph.pairs.length / 2
    // Bind-group prerequisites: the packet path may never call set_bond_data,
    // so the covalent binding gets a placeholder (the compute never runs while
    // packet_graph is set — only bind-group completeness matters).
    if (!covalent_buffer) {
      covalent_capacity = 1
      covalent_buffer = device.createBuffer({
        label: `large-system-covalent-radii`,
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    }
    ensure_pair_buffers(bond_run.pair_capacity())
    ensure_active_pairs_capacity(Math.max(bond_count, 1))
    // Pack (a, b, jimage) triplets in the shared render format. Three biased
    // u8 lanes preserve every value the Int8Array contract can represent; no
    // scientific topology is silently clamped.
    const packed = new Uint32Array(Math.max(bond_count * 3, 1))
    for (let bi = 0; bi < bond_count; bi++) {
      packed[bi * 3] = graph.pairs[bi * 2]
      packed[bi * 3 + 1] = graph.pairs[bi * 2 + 1]
      packed[bi * 3 + 2] = pack_jimage(
        graph.jimages[bi * 3],
        graph.jimages[bi * 3 + 1],
        graph.jimages[bi * 3 + 2],
      )
    }
    if (bond_count > 0) {
      device.queue.writeBuffer(
        active_pairs_buffer as GPUBuffer, 0, packed.buffer, 0, bond_count * 3 * 4,
      )
    }
    device.queue.writeBuffer(
      active_count_buffer, 0, new Uint32Array([bond_count]),
    )
    rebuild_bond_bind_groups()
    write_indirect_cfg()
    packet_graph = true
    active_cpu_graph = graph
    active_bond_count = bond_count
    active_graph_revision++
    sync_active_ghost_table()
    // A stale GPU-detect candidate must never publish over this graph, and
    // no re-detection may dispatch — the packet producer owns the graph.
    publish_pending = false
    graph_dirty = false
    replica_dirty = true
  }

  /** Publish a VALIDATED candidate graph: swap the candidate pairs+count in as
   *  the active set (the old active becomes the next candidate target) and
   *  re-point every bind group + the indirect clamp at the new roles. Only
   *  complete candidates reach this — see begin_validation(). */
  function swap_bond_graphs(): void {
    const pairs = active_pairs_buffer
    active_pairs_buffer = candidate_pairs_buffer
    candidate_pairs_buffer = pairs
    const cap = active_pairs_capacity
    active_pairs_capacity = candidate_pairs_capacity
    candidate_pairs_capacity = cap
    const count = active_count_buffer
    active_count_buffer = candidate_count_buffer
    candidate_count_buffer = count
    active_bond_count = pending_bond_count
    active_cpu_graph = pending_cpu_graph
    pending_bond_count = 0
    pending_cpu_graph = null
    active_graph_revision++
    sync_active_ghost_table()
    write_indirect_cfg()
    rebuild_bond_bind_groups()
  }

  function begin_candidate_graph_sync(generation: number): void {
    if (candidate_graph_sync_inflight || !candidate_pairs_buffer) return
    candidate_graph_sync_inflight = true
    validation_inflight = true
    const count = pending_bond_count
    const version = bond_run.diagnostics().graph_version
    void read_gpu_graph(candidate_pairs_buffer, count, version).then((graph) => {
      candidate_graph_sync_inflight = false
      validation_inflight = false
      if (destroyed || device_lost) return
      if (generation !== graph_generation || !graph) {
        if (graph_dirty && !packet_graph) bond_work_cb?.()
        return
      }
      pending_cpu_graph = graph
      publish_pending = true
      bond_work_cb?.()
    })
  }

  /** Validate the just-submitted candidate: map the readback (raw pair count +
   *  max cell occupancy) and let the controller decide. Complete ⇒ publish on
   *  the next render. Overflowed ⇒ the controller grew its sizing; re-mark the
   *  graph dirty so the next render reruns (bounded — see the allocation
   *  limits). Allocation limit ⇒ report and KEEP the active graph. */
  function begin_validation(generation: number): void {
    validation_readback.mapAsync(GPUMapMode.READ).then(() => {
      if (destroyed || device_lost) {
        // Teardown OR device loss mid-map: the candidate belongs to a dead
        // device — discard it without observing/publishing anything.
        try {
          validation_readback.unmap()
        } catch {
          /* already torn down */
        }
        validation_inflight = false
        return
      }
      const words = new Uint32Array(validation_readback.getMappedRange())
      const raw_count = words[0]
      const occupancy = words[1]
      validation_readback.unmap()
      if (generation !== graph_generation) {
        validation_inflight = false
        // Ownership / packet-graph state changed after dispatch. The readback
        // belongs to an obsolete candidate: do NOT observe it (which would
        // advance graph_version / overflow state) and do NOT publish it. If the
        // new owner re-armed GPU detection, wake the dirty-gated host exactly
        // once so it can dispatch a fresh-generation candidate.
        if (graph_dirty && !packet_graph) bond_work_cb?.()
        return
      }
      const decision = bond_run.observe({
        raw_count,
        max_observed_occupancy: occupancy,
      })
      if (decision.action === `publish` && !packet_graph) {
        pending_bond_count = raw_count
        if (boundary_policy === `ghost-images`) {
          // Ghost atoms and complete outside bonds must publish from the same
          // graph. Read back only the validated pair payload, then publish both.
          begin_candidate_graph_sync(generation)
          return
        }
        validation_inflight = false
        publish_pending = true
      } else if (decision.action === `retry`) {
        validation_inflight = false
        // The candidate was incomplete (atoms or pairs dropped) — it is never
        // swapped in. Rerun next render with the controller's grown sizing.
        graph_dirty = true
      } else {
        validation_inflight = false
        // Explicit failure, no clamped graph: the ACTIVE graph stays on screen.
        if (decision.action !== `publish`) {
          console.warn(`[large-system] bond compute: ${decision.message}`)
        }
      }
      // Async state transitioned OUTSIDE any render() — wake the host so its
      // dirty-gated loop runs the frame that publishes (publish_pending) or
      // reruns (graph_dirty), or one settling frame (allocation limit).
      // Exactly one signal per resolved validation ⇒ no callback storms.
      bond_work_cb?.()
    }).catch(() => {
      // mapAsync rejects when the buffer is destroyed mid-map (overlay teardown
      // — same race as pick()); swallow it, nothing to validate anymore.
      validation_inflight = false
    })
  }

  /** Ensure the per-atom element-id buffer (binding 5) can hold at least `cap`
   *  ids. Created/grown like the covalent buffer; a 4-byte minimum keeps the
   *  binding valid before any ids are pushed. Rebuilds the bond bind groups when
   *  it reallocates (the compute bind group references it). */
  function ensure_elem_ids_capacity(cap: number): void {
    const want = Math.max(cap, 1)
    if (want <= elem_ids_capacity && elem_ids_buffer) return
    elem_ids_buffer?.destroy()
    elem_ids_capacity = Math.max(want, Math.ceil(elem_ids_capacity * 2), 1)
    elem_ids_buffer = device.createBuffer({
      label: `large-system-bond-elem-ids`,
      size: Math.max(elem_ids_capacity * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    rebuild_bond_bind_groups()
  }

  /** Ensure the packed-rules buffer (binding 6) can hold at least `bytes` bytes.
   *  Re-created (never shrunk) when the rule set grows; a 4-byte minimum keeps
   *  the read-only storage binding non-empty when there are no rules. Rebuilds
   *  the bond bind groups when it reallocates. */
  function ensure_rules_capacity(bytes: number): void {
    const want = Math.max(bytes, 4)
    if (want <= rules_capacity_bytes && rules_buffer) return
    rules_buffer?.destroy()
    rules_capacity_bytes = Math.max(want, Math.ceil(rules_capacity_bytes * 2), 4)
    rules_buffer = device.createBuffer({
      label: `large-system-bond-rules`,
      size: rules_capacity_bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    rebuild_bond_bind_groups()
  }

  /** Ensure the uniform-grid storage buffers (bindings 7/8) can hold `n_cells`
   *  cells and `n_cells * max_per_cell` atom slots. Re-created (never shrunk) when
   *  the grid grows; rebuilds the bond bind groups when they reallocate (the
   *  compute bind group references them). Returns true when a reallocation
   *  happened (so the caller re-fetches the rebuilt bind group). */
  function ensure_grid_capacity(n_cells: number, max_per_cell: number): boolean {
    const want_cells = Math.max(n_cells, 1)
    const want_slots = Math.max(n_cells * max_per_cell, 1)
    let grew = false
    if (want_cells > cell_count_cells || !cell_count_buffer) {
      cell_count_buffer?.destroy()
      cell_count_cells = Math.max(want_cells, Math.ceil(cell_count_cells * 2), 1)
      cell_count_buffer = device.createBuffer({
        label: `large-system-bond-cell-count`,
        size: Math.max(cell_count_cells * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      grew = true
    }
    if (want_slots > cell_atoms_slots || !cell_atoms_buffer) {
      cell_atoms_buffer?.destroy()
      cell_atoms_slots = Math.max(want_slots, Math.ceil(cell_atoms_slots * 2), 1)
      cell_atoms_buffer = device.createBuffer({
        label: `large-system-bond-cell-atoms`,
        size: Math.max(cell_atoms_slots * 4, 4),
        usage: GPUBufferUsage.STORAGE,
      })
      grew = true
    }
    if (grew) rebuild_bond_bind_groups()
    return grew
  }

  /** (Re)build the three bond bind groups. Depends on positions/colors buffers (atom
   *  realloc), covalent_buffer, the active/candidate pairs buffers, and the elem-ids / rules buffers
   *  (bindings 5/6) — any of which may reallocate. The elem-ids / rules buffers
   *  are auto-created here (with a placeholder if never set) so the auto-layout
   *  compute bind group is always complete (bindings 5/6 are declared in the
   *  WGSL). No-op until positions/covalent/pairs are present. */
  function rebuild_bond_bind_groups(): void {
    bond_compute_bg = null
    indirect_bg = null
    bond_render_bg = null
    if (
      !positions_buffer || !colors_buffer || !covalent_buffer || !candidate_pairs_buffer ||
      !active_pairs_buffer
    ) return
    // Bindings 5/6 must exist for the auto-layout bind group; lazily create the
    // placeholders the first time (and avoid recursing back into this fn).
    if (!elem_ids_buffer) {
      elem_ids_capacity = 1
      elem_ids_buffer = device.createBuffer({
        label: `large-system-bond-elem-ids`,
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    }
    if (!rules_buffer) {
      rules_capacity_bytes = 4
      rules_buffer = device.createBuffer({
        label: `large-system-bond-rules`,
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    }
    // Grid buffers (bindings 7/8): lazily create placeholders so the bind group
    // is complete even before the first dispatch sizes them.
    if (!cell_count_buffer) {
      cell_count_cells = 1
      cell_count_buffer = device.createBuffer({
        label: `large-system-bond-cell-count`,
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    }
    if (!cell_atoms_buffer) {
      cell_atoms_slots = 1
      cell_atoms_buffer = device.createBuffer({
        label: `large-system-bond-cell-atoms`,
        size: 4,
        usage: GPUBufferUsage.STORAGE,
      })
    }

    // The compute writes the CANDIDATE graph; the indirect build + bond render
    // read the ACTIVE one — the separation that keeps an incomplete candidate
    // from ever reaching the screen.
    bond_compute_bg = device.createBindGroup({
      label: `large-system-bond-compute-bg`,
      layout: bond_compute_bgl,
      entries: [
        { binding: 0, resource: { buffer: positions_buffer } },
        { binding: 1, resource: { buffer: covalent_buffer } },
        { binding: 2, resource: { buffer: bond_params_buffer } },
        { binding: 3, resource: { buffer: candidate_pairs_buffer } },
        { binding: 4, resource: { buffer: candidate_count_buffer } },
        { binding: 5, resource: { buffer: elem_ids_buffer } },
        { binding: 6, resource: { buffer: rules_buffer } },
        { binding: 7, resource: { buffer: cell_count_buffer } },
        { binding: 8, resource: { buffer: cell_atoms_buffer } },
        { binding: 9, resource: { buffer: grid_meta_buffer } },
      ],
    })
    indirect_bg = device.createBindGroup({
      label: `large-system-indirect-bg`,
      layout: indirect_pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: active_count_buffer } },
        { binding: 1, resource: { buffer: indirect_buffer } },
        { binding: 2, resource: { buffer: indirect_cfg_buffer } },
        // binding 3: bond_meta — the build writes the clamped bond_count here.
        { binding: 3, resource: { buffer: bond_meta_buffer } },
      ],
    })
    bond_render_bg = device.createBindGroup({
      label: `large-system-bond-render-bg`,
      layout: bond_render_bgl,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: active_pairs_buffer } },
        { binding: 3, resource: { buffer: bond_render_uniform } },
        // binding 4: clamped bond_count (Phase-2 inst decode). binding 5: the GPU
        // supercell uniform (dims + base lattice) for the per-cell offset.
        { binding: 4, resource: { buffer: bond_meta_buffer } },
        { binding: 5, resource: { buffer: supercell_buffer } },
        // binding 6: the shared shading uniform — headlamp + specular + fog, so
        // bonds shade consistently with the atoms.
        { binding: 6, resource: { buffer: shading_buffer } },
        // binding 7: the SAME authoritative topology.colors buffer the atom
        // impostor uses. Rebuilt whenever ensure_atom_capacity reallocates it.
        { binding: 7, resource: { buffer: colors_buffer } },
      ],
    })
  }

  /** Pack + upload the bond render uniform: lattice rows plus edge style. */
  /** Upload the GPU supercell uniform: dims (nx,ny,nz,base_count) as u32 + base
   *  lattice rows a,b,c as 3×vec4<f32>. base_count = the current atom_count (the
   *  BASE cell's atom count, since the CPU stays base-cell when GPU-supercell is
   *  active). Stored as ROWS a/b/c (matching pack_lattice's row convention) — the
   *  vertex offset reads supercell.lat{0,1,2}.xyz directly as a/b/c. Re-called by
   *  set_supercell AND set_atoms/set_positions (so base_count tracks the atom
   *  count). The 64-byte buffer: u32×4 (dims) then f32×12 (3 padded rows). */
  function upload_supercell_uniform(): void {
    const buf = new ArrayBuffer(SUPERCELL_BYTES)
    const u32 = new Uint32Array(buf, 0, 4)
    const f32 = new Float32Array(buf, 16, 12)
    u32[0] = Math.max(1, supercell_dims[0] | 0)
    u32[1] = Math.max(1, supercell_dims[1] | 0)
    u32[2] = Math.max(1, supercell_dims[2] | 0)
    // base_count = atoms in the base cell (the instance count is atom_count*ncells,
    // decoded as inst % base_count). 0 atoms ⇒ no draw, value is irrelevant.
    u32[3] = Math.max(0, atom_count)
    const L = supercell_lattice
    // Row a -> lat0.xyz, row b -> lat1.xyz, row c -> lat2.xyz. The lat0.w pad
    // slot carries the complete boundary policy (stub=0, hide=1,
    // ghost-images=2); atom/pick impostors read only .xyz, so it never perturbs
    // replica positions.
    const ghost_graph_ready = active_bond_count === 0 || active_cpu_graph !== null
    const policy_code = boundary_policy === `hide`
      ? 1
      : boundary_policy === `ghost-images` && ghost_graph_ready
      ? 2
      : 0
    f32[0] = L[0]; f32[1] = L[1]; f32[2] = L[2]; f32[3] = policy_code
    f32[4] = L[3]; f32[5] = L[4]; f32[6] = L[5]; f32[7] = 0
    f32[8] = L[6]; f32[9] = L[7]; f32[10] = L[8]; f32[11] = 0
    device.queue.writeBuffer(supercell_buffer, 0, buf, 0, SUPERCELL_BYTES)
  }

  function upload_bond_render_uniform(): void {
    const u = pack_bond_render_uniform(bond_render_lattice, bond_style)
    device.queue.writeBuffer(
      bond_render_uniform,
      0,
      u.buffer,
      u.byteOffset,
      BOND_RENDER_BYTES,
    )
  }

  let destroyed = false

  /** Flip the device-loss gates EXACTLY ONCE. Ordering is transactional:
   *  (1) `device_lost` is set FIRST, so every submission path (render, pick,
   *  setters, async readback continuations) is stopped before anything else
   *  runs; (2) scene/owner state is NOT touched — the last valid packet/graph
   *  owner survives for the fallback handoff; (3) the host is notified once. */
  function mark_device_lost(info?: GPUDeviceLostInfo): void {
    if (device_lost) return
    device_lost = true
    device_lost_info = info
    notify_device_loss()
  }

  /** Deliver the one-shot loss notification. Also called by on_device_lost so
   *  a handler registered AFTER the loss (host raced the event) still hears
   *  it — exactly once in total, never after destroy(). */
  function notify_device_loss(): void {
    if (destroyed || !device_lost || device_loss_notified) return
    const cb = device_lost_cb
    if (!cb) return
    device_loss_notified = true
    cb(device_lost_info)
  }

  // The ONE `device.lost` subscription for this renderer's lease (created
  // once per lease by the host). Mock devices in unit tests provide a
  // controllable promise; fakes without one simply never report loss.
  const device_lost_promise = (device as { lost?: Promise<GPUDeviceLostInfo> }).lost
  if (device_lost_promise && typeof device_lost_promise.then === `function`) {
    void device_lost_promise.then((info) => mark_device_lost(info))
  }

  /** Upload a rust-wasm typed bond table as the ACTIVE draw graph (Bonds T6).
   *  Mirrors upload_packet_bond_graph's buffer path but NEVER flips
   *  `packet_graph` or `ownership` — the graph owner is unchanged. GPU
   *  re-detection stays armed for the next graph-dirty render; the policy
   *  keeps routing here while the cell stays thin / over-budget. */
  function upload_wasm_bond_graph(table: TypedBondTable): void {
    if (destroyed || device_lost) return
    const bond_count = table.pairs.length / 2
    const graph: BaseBondGraph = {
      version: active_graph_revision + 1,
      pairs: table.pairs,
      jimages: table.images,
      kinds: new Uint8Array(bond_count),
      strengths: table.strengths,
    }
    ensure_pair_buffers(bond_run.pair_capacity())
    ensure_active_pairs_capacity(Math.max(bond_count, 1))
    // Pack (a, b, jimage) triplets in the shared render format — the same
    // biased-u8-lane packing the packet upload uses (full Int8 range).
    const packed = new Uint32Array(Math.max(bond_count * 3, 1))
    for (let bi = 0; bi < bond_count; bi++) {
      packed[bi * 3] = table.pairs[bi * 2]
      packed[bi * 3 + 1] = table.pairs[bi * 2 + 1]
      packed[bi * 3 + 2] = pack_jimage(
        table.images[bi * 3],
        table.images[bi * 3 + 1],
        table.images[bi * 3 + 2],
      )
    }
    if (bond_count > 0) {
      device.queue.writeBuffer(
        active_pairs_buffer as GPUBuffer, 0, packed.buffer, 0, bond_count * 3 * 4,
      )
    }
    device.queue.writeBuffer(active_count_buffer, 0, new Uint32Array([bond_count]))
    rebuild_bond_bind_groups()
    write_indirect_cfg()
    active_cpu_graph = graph
    active_bond_count = bond_count
    active_graph_revision++
    sync_active_ghost_table()
    // A validated-but-unpublished GPU candidate predates this graph — it must
    // never swap in over it.
    publish_pending = false
    pending_cpu_graph = null
    pending_bond_count = 0
    replica_dirty = true
  }

  /** Bonds T6: the dispatch policy refused the GPU compute (periodic thin
   *  cell / grid storage budget) — route the graph through the Task-5
   *  rust-wasm worker orchestration instead of any all-pairs GPU fallback.
   *  Returns true when a request was dispatched (caller clears graph_dirty);
   *  false when typed inputs are missing (legacy channel without a packet —
   *  the last complete graph stays on screen, design §8.2). Results are
   *  transactional: a superseded generation (owner change, packet-graph
   *  arrival), device loss, or teardown discards the table — the last valid
   *  graph owner is retained. */
  function dispatch_wasm_bonds(): boolean {
    if (wasm_bonds_inflight) return false
    const numbers = last_packet?.topology.atomic_numbers
    const positions = last_positions
    if (!numbers || numbers.length < bond_n || !positions || bond_n <= 0) return false
    if (positions.length < bond_n * 3) return false
    wasm_bonds_inflight = true
    const generation = graph_generation
    const L = bond_detector_lattice
    const input: TypedBondInput = {
      // compute_typed copies before transfer — these views stay owned here.
      positions: positions.length === bond_n * 3
        ? positions
        : positions.subarray(0, bond_n * 3),
      atomic_numbers: numbers.length === bond_n ? numbers : numbers.subarray(0, bond_n),
      lattice_matrix: bond_periodic
        ? [
          [L[0], L[1], L[2]],
          [L[3], L[4], L[5]],
          [L[6], L[7], L[8]],
        ]
        : null,
      pbc: bond_periodic ? [true, true, true] : null,
      options: { ...bond_options },
    }
    // The injected seam is called synchronously (deterministic tests); the
    // production path lazy-imports the worker orchestration on first use so
    // this renderer never eagerly pulls worker/wasm modules into its graph.
    const request: Promise<ComputeBondsTypedResult> = deps?.compute_bonds_typed
      ? deps.compute_bonds_typed(input)
      : import(`$lib/structure/workers/bond-worker-api`).then((m) =>
        m.compute_bonds_typed(input)
      )
    void request
      .then(({ table }) => {
        wasm_bonds_inflight = false
        if (destroyed || device_lost) return
        if (generation !== graph_generation || packet_graph) {
          // Superseded: a packet graph / ownership change owns the draw now.
          // If detection was re-armed meanwhile, wake the host once so it can
          // dispatch against the new generation.
          if (graph_dirty && !packet_graph) bond_work_cb?.()
          return
        }
        upload_wasm_bond_graph(table)
        // Async state transitioned outside any render(): wake the host so its
        // dirty-gated loop runs the frame that refreshes the indirect args.
        bond_work_cb?.()
      })
      .catch((err) => {
        wasm_bonds_inflight = false
        if (destroyed || device_lost) return
        // Keep the last complete graph on screen (§8.2 preserve-on-failure).
        console.warn(
          `[large-system] rust-wasm bond backend failed — keeping the last graph:`,
          err instanceof Error ? err.message : err,
        )
        if (graph_dirty && !packet_graph) bond_work_cb?.()
      })
    return true
  }

  // Mutable clear color, defaulting to the near-black constant until the caller
  // threads the viewer's background via set_background. Typed as the dict form
  // (not the GPUColor union) so the .r/.g/.b/.a fields are writable.
  const clear_color: GPUColorDict = { ...(CLEAR_COLOR as GPUColorDict) }

  return {
    set_background(rgb: [number, number, number]): void {
      if (destroyed || device_lost) return
      // The clearValue is written into the (non-sRGB) target verbatim — it never
      // passes through a fragment shader — so it must be encoded HERE, or the
      // overlay's background comes out darker than the WebGL canvas's and dark
      // atoms lose the contrast this color was picked to give them.
      clear_color.r = linear_to_srgb(rgb[0])
      clear_color.g = linear_to_srgb(rgb[1])
      clear_color.b = linear_to_srgb(rgb[2])
      clear_color.a = 1
    },
    set_shading(state: ResolvedVisualShading): boolean {
      if (destroyed || device_lost) return false
      if (same_visual_shading(shading_state, state)) return false
      shading_state = snapshot_shading(state)
      upload_shading_uniform()
      return true
    },
    set_gizmo_layout(opts: { dpr?: number; safe_left?: number; safe_bottom?: number }): void {
      if (destroyed || device_lost) return
      if (opts.dpr !== undefined) gizmo_layout.dpr = opts.dpr
      if (opts.safe_left !== undefined) gizmo_layout.safe_left = opts.safe_left
      if (opts.safe_bottom !== undefined) gizmo_layout.safe_bottom = opts.safe_bottom
      upload_gizmo_uniform()
    },
    set_cell(
      lattice: Float32Array | null,
      show: boolean,
      color: [number, number, number],
      origin: readonly [number, number, number] = [0, 0, 0],
    ): void {
      if (destroyed || device_lost) return
      cell_show = show
      cell_color = [color[0], color[1], color[2]]
      cell_origin = [origin[0], origin[1], origin[2]]
      // A null lattice (non-periodic structure) ⇒ no box. Otherwise detect a
      // degenerate all-zero lattice (also no box) so molecules never draw one.
      let nonzero = false
      if (lattice && lattice.length >= 9) {
        cell_lattice = lattice.slice(0, 9)
        for (let i = 0; i < 9; i++) {
          if (Math.abs(cell_lattice[i]) > 1e-12) { nonzero = true; break }
        }
      } else {
        cell_lattice = new Float32Array(9)
      }
      cell_has_lattice = nonzero
      upload_cell_uniform()
    },
    set_camera(uniform: Float32Array): void {
      if (destroyed || device_lost) return
      // Legacy 80-byte (proj*view) upload into the first bytes; harmless — the
      // impostor draw uses set_camera_full. Guard against short/long arrays.
      const bytes = Math.min(uniform.byteLength, CAMERA_UNIFORM_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_camera_full(uniform: Float32Array): void {
      if (destroyed || device_lost) return
      const bytes = Math.min(uniform.byteLength, CAMERA_FULL_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_atoms(
      positions: Float32Array,
      radii: Float32Array,
      colors: Float32Array,
      count: number,
    ): void {
      if (destroyed || device_lost) return
      claim_legacy_ownership()
      atom_count = Math.max(0, count)
      if (atom_count === 0) return

      // (Re)allocate when capacity is insufficient. Storage buffers must be at
      // least the byte length we write; grow with headroom to avoid churn.
      ensure_atom_capacity(atom_count)

      device.queue.writeBuffer(
        positions_buffer as GPUBuffer, 0,
        positions.buffer, positions.byteOffset, atom_count * 3 * 4,
      )
      device.queue.writeBuffer(
        radii_buffer as GPUBuffer, 0,
        radii.buffer, radii.byteOffset, atom_count * 4,
      )
      device.queue.writeBuffer(
        colors_buffer as GPUBuffer, 0,
        colors.buffer, colors.byteOffset, atom_count * 3 * 4,
      )
      // Cache positions for the non-periodic AABB grid plan (see last_positions).
      last_positions = positions
      // base_count in the supercell uniform tracks the atom count (= base cell
      // atoms while GPU-supercell is active). Re-upload so inst decode stays valid.
      upload_supercell_uniform()
      // Positions moved ⇒ the base bond graph must be re-detected.
      mark_bond_dirty(classify_bond_dirty(`positions`))
    },
    set_positions(positions: Float32Array, count: number): void {
      if (destroyed || device_lost) return
      claim_legacy_ownership()
      // Per-frame fast path: requires an existing positions buffer (topology
      // already established by set_atoms). If the count somehow grew past
      // capacity, bail — the caller should re-run set_atoms to reallocate.
      const n = Math.max(0, count)
      if (n === 0 || !positions_buffer || n > atom_capacity) return
      // Never read past the supplied array: the caller guarantees length>=3n in
      // the normal path, but clamp defensively so a short frame can't make
      // writeBuffer throw (it would just upload the atoms it does have).
      const floats = Math.min(n * 3, positions.length)
      if (floats === 0) return
      atom_count = n
      device.queue.writeBuffer(
        positions_buffer, 0,
        positions.buffer, positions.byteOffset, floats * 4,
      )
      // Cache positions for the non-periodic AABB grid plan (see last_positions).
      last_positions = positions
      // Keep base_count in sync if the count changed on the fast path.
      upload_supercell_uniform()
      // Atoms moved ⇒ the base bond graph must be re-detected.
      mark_bond_dirty(classify_bond_dirty(`positions`))
    },
    set_bond_data(
      covalent_radii: Float32Array,
      lattice: Float32Array,
      options: { scale: number; max_bond_dist: number; min_bond_dist: number },
      periodic: boolean,
    ): void {
      if (destroyed || device_lost) return
      bonds_configured = true
      bond_n = covalent_radii.length
      bond_detector_lattice = lattice.slice(0, 9)
      // Legacy mode historically owns both detector and render lattice through
      // this setter. Packet mode owns render geometry through frame.lattice, so
      // detector refreshes must not mutate the displayed periodic shift.
      if (ownership === `legacy`) bond_render_lattice = lattice.slice(0, 9)
      bond_options = { ...options }
      bond_periodic = periodic

      // Capacity heuristic: max(1024, n_atoms * 16). The controller's capacity
      // floor rises with the atom count; never shrinks (avoids churn on tweaks).
      // Overflow retries can still grow it further (nextPow2 of the raw count).
      bond_run.ensure_pair_capacity(Math.max(1024, bond_n * 16))
      ensure_pair_buffers(bond_run.pair_capacity())

      // (Re)allocate the covalent-radii buffer when the atom count grows. It is
      // SEPARATE from the display radii buffer (different radius semantics).
      if (bond_n > covalent_capacity) {
        const new_cap = Math.max(bond_n, Math.ceil(covalent_capacity * 2), 1)
        covalent_buffer?.destroy()
        covalent_buffer = device.createBuffer({
          label: `large-system-covalent-radii`,
          size: new_cap * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        covalent_capacity = new_cap
        rebuild_bond_bind_groups()
      }
      if (bond_n > 0 && covalent_buffer) {
        device.queue.writeBuffer(
          covalent_buffer, 0,
          covalent_radii.buffer, covalent_radii.byteOffset, bond_n * 4,
        )
      }

      // Legacy rendering follows this setter. Packet rendering keeps its frame
      // lattice untouched; the compute Params below still use detector_lattice.
      if (ownership === `legacy`) upload_bond_render_uniform()
      mark_bond_dirty(classify_bond_dirty(`options`))
    },
    set_bond_style(style: Partial<LargeSystemBondStyle>): void {
      if (destroyed || device_lost) return
      const next = normalize_bond_style(style)
      if (
        next.radius === bond_style.radius &&
        next.incomplete_edge_mode === bond_style.incomplete_edge_mode &&
        next.incomplete_edge_length_scale === bond_style.incomplete_edge_length_scale &&
        next.hide_incomplete_bonds === bond_style.hide_incomplete_bonds &&
        next.periodic_bond_opacity === bond_style.periodic_bond_opacity
      ) {
        return
      }
      bond_style = next
      upload_bond_render_uniform()
    },
    set_bond_rules(elem_ids: Uint32Array, rules: Float32Array): void {
      if (destroyed || device_lost) return
      bond_rules = rules

      // Per-atom element ids (binding 5). Grow + upload N entries. When elem_ids
      // is shorter than the atom count the tail keeps its previous/zero id; that
      // can only mis-key atoms with no element (none in practice). Empty elem_ids
      // is fine — with rule_count 0 the buffer is never read.
      if (elem_ids.length > 0) {
        ensure_elem_ids_capacity(elem_ids.length)
        if (elem_ids_buffer) {
          device.queue.writeBuffer(
            elem_ids_buffer, 0,
            elem_ids.buffer, elem_ids.byteOffset, elem_ids.length * 4,
          )
        }
      }

      // Packed rules (binding 6). Grow + upload; empty ⇒ leave the placeholder
      // buffer (rule_count 0 ⇒ the shader skips the scan entirely).
      if (rules.length > 0) {
        ensure_rules_capacity(rules.byteLength)
        if (rules_buffer) {
          device.queue.writeBuffer(
            rules_buffer, 0,
            rules.buffer, rules.byteOffset, rules.byteLength,
          )
        }
      }

      // Rules changed ⇒ re-run the compute so the post-filter is reapplied LIVE.
      mark_bond_dirty(classify_bond_dirty(`rules`))
    },
    set_bonds_enabled(enabled: boolean): void {
      if (destroyed || device_lost) return
      if (enabled === bonds_enabled) return
      bonds_enabled = enabled
      // Turning bonds back on must re-run the compute against the current atoms
      // (the cached pairs may be stale or were never computed while disabled).
      if (enabled) mark_bond_dirty(classify_bond_dirty(`options`))
    },
    set_supercell(dims: [number, number, number], base_lattice: Float32Array): void {
      if (destroyed || device_lost) return
      claim_legacy_ownership()
      supercell_dims = [
        Math.max(1, Math.floor(dims[0])),
        Math.max(1, Math.floor(dims[1])),
        Math.max(1, Math.floor(dims[2])),
      ]
      supercell_ncells = supercell_dims[0] * supercell_dims[1] * supercell_dims[2]
      // Copy the 9-float base lattice (rows a,b,c) — never alias the caller's array.
      supercell_lattice = base_lattice.slice(0, 9)
      if (supercell_lattice.length < 9) {
        const padded = new Float32Array(9)
        padded.set(supercell_lattice)
        supercell_lattice = padded
      }
      upload_supercell_uniform()
      sync_active_ghost_table()
      // REPLICA-only invalidation (design §8.2 item 4): ncells changed ⇒ the
      // bond draw's instance count (2·bond_count·ncells) must be rebuilt, so
      // refresh the cfg uniform and mark the replica state dirty — the next
      // render re-runs ONLY the indirect-args build against the ACTIVE graph.
      // The base bond graph is untouched: no bond dispatch happens.
      write_indirect_cfg()
      mark_bond_dirty(classify_bond_dirty(`supercell`))
    },
    set_show_images(show: boolean): void {
      if (destroyed || device_lost) return
      claim_legacy_ownership()
      const next = !!show
      if (next === show_image_atoms) return
      show_image_atoms = next
      boundary_policy = next ? `ghost-images` : `stub`
      // Re-pack the Supercell uniform's boundary-policy code. REPLICA-only:
      // the bond render reads it per-frame — the base graph is never re-detected.
      upload_supercell_uniform()
      sync_active_ghost_table()
      mark_bond_dirty(classify_bond_dirty(`image-policy`))
    },
    set_packet(packet: RenderPacket, _images: ImageInstanceTable): void {
      if (destroyed || device_lost) return
      claim_packet_ownership()
      const prev = last_packet
      const diff: RenderPacketDiff = prev ? diff_render_packet(prev, packet) : {
        topology_changed: true,
        bond_graph_changed: packet.topology.bond_graph !== undefined,
        frame_changed: true,
        replica_changed: true,
      }
      last_packet = packet
      const topo = packet.topology
      const n = topo.atom_count
      let frame_upload = diff.frame_changed

      // ── Topology version: (re)alloc + upload the base attribute buffers. ──
      if (diff.topology_changed) {
        // atom_count tracks the packet even at 0 (an emptied structure draws
        // nothing — same behaviour as the legacy set_atoms(…, 0) path).
        atom_count = n
      }
      if (diff.topology_changed && n > 0) {
        // A fresh positions buffer holds garbage until the frame branch writes
        // it — force the positions upload even on a frame-version tie.
        if (ensure_atom_capacity(n)) frame_upload = true
        device.queue.writeBuffer(
          radii_buffer as GPUBuffer, 0,
          topo.radii.buffer, topo.radii.byteOffset, n * 4,
        )
        // The packet contract allows rgba (4N) colors; the shader reads rgb
        // triplets, so strip alpha on the (rare, topology-versioned) upload.
        let colors = topo.colors
        if (colors.length === n * 4) {
          const rgb = new Float32Array(n * 3)
          for (let idx = 0; idx < n; idx++) {
            rgb[idx * 3] = colors[idx * 4]
            rgb[idx * 3 + 1] = colors[idx * 4 + 1]
            rgb[idx * 3 + 2] = colors[idx * 4 + 2]
          }
          colors = rgb
        }
        device.queue.writeBuffer(
          colors_buffer as GPUBuffer, 0,
          colors.buffer, colors.byteOffset, n * 3 * 4,
        )
        upload_supercell_uniform() // base_count tracks the packet atom count
        mark_bond_dirty(classify_bond_dirty(`topology`))
      }

      // ── Frame version: base positions + the CURRENT frame lattice, nothing
      // else (a fixed-cell frame advance is a single 3N-float upload). ──
      if (frame_upload && n > 0 && positions_buffer) {
        atom_count = n
        const pos = packet.frame.positions
        const floats = Math.min(n * 3, pos.length)
        if (floats > 0) {
          device.queue.writeBuffer(
            positions_buffer, 0, pos.buffer, pos.byteOffset, floats * 4,
          )
        }
        // Cache positions for the non-periodic AABB grid plan.
        last_positions = pos
        // Variable-cell trajectories carry a new lattice each frame: it drives
        // the replica offsets (supercell uniform) AND the bond compute/render
        // lattice. A static cell compares equal ⇒ zero lattice churn.
        let lattice_moved = false
        for (let idx = 0; idx < 9; idx++) {
          if (supercell_lattice[idx] !== packet.frame.lattice[idx]) {
            lattice_moved = true
            break
          }
        }
        if (lattice_moved) {
          supercell_lattice = packet.frame.lattice.slice(0, 9)
          bond_detector_lattice = packet.frame.lattice.slice(0, 9)
          bond_render_lattice = packet.frame.lattice.slice(0, 9)
          upload_supercell_uniform()
          upload_bond_render_uniform()
        }
        // Atoms moved ⇒ the base bond graph is stale. On the GPU-detect path
        // this re-dispatches; while a packet graph is active render() clears
        // the flag (the packet producer ships the recomputed graph).
        mark_bond_dirty(classify_bond_dirty(`positions`))
      }

      // ── Replica version: dims + boundary policy + indirect counts ONLY —
      // never a bond dispatch (design §5 / §8.2 item 4). ──
      if (diff.replica_changed) {
        const dims = packet.replicas.dims
        supercell_dims = [
          Math.max(1, Math.floor(dims[0])),
          Math.max(1, Math.floor(dims[1])),
          Math.max(1, Math.floor(dims[2])),
        ]
        supercell_ncells = supercell_dims[0] * supercell_dims[1] * supercell_dims[2]
        boundary_policy = packet.replicas.boundary_policy
        // 'ghost-images' maps onto the existing show-images bond upgrade flag
        // (lat0.w): ncells==1 cross-cell stubs become full cylinders reaching
        // the drawn ghost instance.
        show_image_atoms = boundary_policy === `ghost-images`
        upload_supercell_uniform()
        write_indirect_cfg()
        mark_bond_dirty(classify_bond_dirty(`supercell`))
      }

      // ── Bond-graph version: a packet-supplied base graph uploads straight
      // into the active draw buffers (self-image edges retained 1:1). Its ghost
      // stream is derived from that exact graph, never caller boundary metadata.
      if (diff.bond_graph_changed) upload_packet_bond_graph(topo.bond_graph)
      else if (diff.replica_changed) sync_active_ghost_table()
    },
    set_selection(indices: Uint32Array | number[]): void {
      if (destroyed || device_lost) return
      // Build a dense per-atom flag array (1 = selected) over the current atom
      // capacity, then upload. We always rewrite the whole buffer (clearing old
      // selections), so an empty `indices` clears the highlight. Sized to the
      // atom buffer; out-of-range indices are ignored.
      ensure_selected_capacity(Math.max(atom_capacity, 1))
      // rebuild the bind group if the buffer was (re)created without atoms yet.
      if (!bind_group && positions_buffer && radii_buffer && colors_buffer) {
        rebuild_bind_group()
      }
      const n = Math.max(atom_capacity, 1)
      const flags = new Uint32Array(n)
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k]
        if (i >= 0 && i < n) flags[i] = 1
      }
      if (selected_buffer) {
        device.queue.writeBuffer(selected_buffer, 0, flags.buffer, flags.byteOffset, n * 4)
      }
    },
    async pick(x: number, y: number): Promise<ReplicaPickResult> {
      const miss: ReplicaPickResult = {
        kind: `miss`,
        base_site: -1,
        cell: [0, 0, 0],
        ghost: false,
      }
      if (destroyed || device_lost) return miss
      if (atom_count <= 0 || !pick_bind_group || !pick_id_view || !pick_depth_view) {
        return miss
      }
      if (!pick_id_texture) return miss
      // Clamp the requested device pixel to the texture bounds.
      const w = pick_id_texture.width
      const h = pick_id_texture.height
      const px = Math.max(0, Math.min(w - 1, Math.floor(x)))
      const py = Math.max(0, Math.min(h - 1, Math.floor(y)))

      // Visual T5 (T3-review Minor closure): snapshot every decode input AT
      // REQUEST TIME. `mapAsync` yields to the event loop, and a packet/legacy
      // update landing mid-flight (new dims, new atom count, replaced ghost
      // table) must not re-interpret the id rendered by THIS pass.
      const snap_base_count = Math.max(1, atom_count)
      const snap_ncells = Math.max(1, supercell_ncells)
      const snap_dims: [number, number, number] = [
        supercell_dims[0],
        supercell_dims[1],
        supercell_dims[2],
      ]
      const snap_images = last_images
      const snap_ghosts = ghost_draw_count()

      const encoder = device.createCommandEncoder({ label: `large-system-pick` })
      const pass = encoder.beginRenderPass({
        label: `large-system-pick-pass`,
        colorAttachments: [
          {
            view: pick_id_view,
            // 0 = background (no atom). Atom ids are instance_index + 1.
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: `clear`,
            storeOp: `store`,
          },
        ],
        depthStencilAttachment: {
          view: pick_depth_view,
          depthClearValue: 1.0,
          depthLoadOp: `clear`,
          depthStoreOp: `store`,
        },
      })
      pass.setPipeline(pick_pipeline)
      pass.setBindGroup(0, pick_bind_group)
      // GPU supercell (Phase 4): draw atom_count × ncells instances, exactly like
      // the atom render draw, so every replica is pickable. ncells 1 (default /
      // 1×1×1) ⇒ atom_count instances ⇒ inst = atom, byte-identical to before.
      // Ghost instances (packet 'ghost-images' policy) append past the replica
      // range, so their ids land after it and decode via the CPU-side table.
      pass.draw(4, atom_count * snap_ncells + snap_ghosts)
      pass.end()
      // Copy the single picked texel into the 256-byte readback buffer.
      encoder.copyTextureToBuffer(
        { texture: pick_id_texture, origin: { x: px, y: py, z: 0 } },
        { buffer: pick_readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      )
      device.queue.submit([encoder.finish()])

      try {
        await pick_readback.mapAsync(GPUMapMode.READ, 0, 4)
      } catch {
        // The buffer was destroyed before the map resolved. This happens when
        // the overlay is torn down mid-pick — e.g. the user toggles large-system
        // (WebGPU) mode off while a pick is in flight. WebGPU rejects the pending
        // mapAsync with an AbortError ("Buffer was destroyed before mapping was
        // resolved"); swallow it and abort the pick instead of leaking an
        // unhandled rejection. The post-resolve `destroyed` guard below only
        // covers the resolve-then-destroy race, not this reject-on-destroy one.
        return miss
      }
      if (destroyed || device_lost) {
        try { pick_readback.unmap() } catch { /* already torn down */ }
        return miss
      }
      const id = new Uint32Array(pick_readback.getMappedRange(0, 4))[0]
      pick_readback.unmap()
      // id 0 = background ⇒ miss. Otherwise the raw id is GLOBAL instance + 1.
      // Real replicas decode atom-major via the Task-1 oracle
      // (decode_replica_instance): base_site = g % base_count, cell = the
      // replica cell in [0, dims). Ids past base_count·ncells are GHOST
      // instances: they map through the CPU-side ImageInstanceTable to their
      // base site + ABSOLUTE image cell (which may lie outside [0, dims) —
      // logical_site_for_pick wraps it under physical semantics). Every input
      // below is the REQUEST-TIME snapshot, never post-mapAsync state.
      if (id === 0) return miss
      const g = id - 1
      const real_count = snap_base_count * snap_ncells
      if (g >= real_count) {
        const gi = g - real_count
        const table = snap_images
        if (!table || gi >= table.count) return miss
        return {
          kind: `atom`,
          base_site: table.base_sites[gi],
          cell: [
            table.jimages[gi * 3],
            table.jimages[gi * 3 + 1],
            table.jimages[gi * 3 + 2],
          ],
          ghost: true,
        }
      }
      const decoded = decode_replica_instance(g, snap_base_count, snap_dims)
      return {
        kind: `atom`,
        base_site: decoded.atom_index,
        cell: [decoded.cell[0], decoded.cell[1], decoded.cell[2]],
        ghost: false,
      }
    },
    get_diagnostics(): ReplicaRendererDiagnostics {
      return {
        backend: `webgpu`,
        device_lost,
        active_bond_count,
        required_backend,
        ownership,
        base_count: atom_count,
        dims: [supercell_dims[0], supercell_dims[1], supercell_dims[2]],
        ncells: Math.max(1, supercell_ncells),
        boundary_policy,
        ghost_count,
        atom_instances: atom_count * Math.max(1, supercell_ncells) + ghost_draw_count(),
        packet_versions: last_packet
          ? {
            topology: last_packet.topology.version,
            bond_graph: last_packet.topology.bond_graph?.version ?? null,
            frame_idx: last_packet.frame.frame_idx,
            positions: last_packet.frame.positions_version,
            replicas: last_packet.replicas.version,
          }
          : null,
        packet_graph_active: packet_graph,
        bonds: bond_run.diagnostics(),
      }
    },
    render(): void {
      if (destroyed || device_lost) return
      if (!depth_view || !msaa_color_view) ensure_targets(canvas.width || 1, canvas.height || 1)
      const encoder = device.createCommandEncoder({ label: `large-system-frame` })

      // Whether bonds are renderable this frame (visible + inputs present +
      // atoms). bonds_enabled gates BOTH the compute passes below AND the bond
      // draw, so a hidden show_bonds setting skips all bond work entirely. A
      // PACKET-supplied graph is drawable without set_bond_data inputs.
      const bonds_ready =
        bonds_enabled && atom_count > 0 &&
        (packet_graph || (bonds_configured && bond_n > 0)) &&
        !!bond_compute_bg && !!indirect_bg && !!bond_render_bg &&
        !!active_pairs_buffer && !!candidate_pairs_buffer
      let kick_validation = false

      // While a packet-supplied graph is active, graph-dirty marks (frame
      // positions moved, options touched) never dispatch the GPU detect — the
      // packet producer owns re-detection and ships a new bond-graph version.
      if (packet_graph && graph_dirty) graph_dirty = false

      // ── Publish a VALIDATED candidate graph ──────────────────────────────
      // The candidate readback confirmed a COMPLETE run (no cell/pair
      // overflow), so it may replace the active graph. The swap re-points the
      // bind groups; the indirect draw args are rebuilt below (replica_dirty)
      // from the newly active count, in this same submit. Never while a packet
      // graph is active — a stale candidate must not stomp it.
      if (bonds_ready && publish_pending && !packet_graph) {
        if (boundary_policy === `ghost-images` && !pending_cpu_graph) {
          // Policy may have switched from stub to ghosts after validation. Delay
          // the swap until the candidate graph is available for the matching
          // sparse ghost stream.
          publish_pending = false
          begin_candidate_graph_sync(graph_generation)
        } else {
          publish_pending = false
          swap_bond_graphs()
          replica_dirty = true
        }
      }

      // ── Candidate bond compute (only when the GRAPH is dirty) ────────────
      // Runs as a compute pass in THIS encoder, writing the CANDIDATE buffers;
      // the bond draw keeps reading the ACTIVE graph until the candidate's
      // readback validates it as complete — an overflowed (incomplete) run is
      // never published. While a validation is in flight no new candidate is
      // dispatched; a still-dirty graph reruns on a later render (latest wins).
      if (bonds_ready && graph_dirty && !validation_inflight && !packet_graph) {
        // Decide the compute path CPU-side (design §8.2): tiny N ⇒ direct
        // all-pairs; grid-friendly ⇒ uniform grid; periodic thin cell / grid
        // over the storage budget ⇒ REFUSE — those must go to the Rust-WASM
        // worker (wired in Task 6), never to an all-pairs GPU fallback. The
        // active graph stays on screen while refused.
        const plan = plan_bond_dispatch({
          periodic: bond_periodic,
          lattice: bond_detector_lattice,
          max_bond_dist: bond_options.max_bond_dist,
          positions: last_positions ?? new Float32Array(0),
          n: bond_n,
          atom_count: bond_n,
          direct_limit: MAX_DIRECT_ATOMS,
          max_storage_bytes: device.limits?.maxStorageBufferBindingSize ??
            (1 << 27),
        })
        if (plan.kind === `rust-wasm`) {
          if (required_backend !== plan.reason) {
            console.warn(
              `[large-system] bond detection requires the rust-wasm backend ` +
                `(${plan.reason}); GPU path refused — routing through ` +
                `compute_bonds_typed()`,
            )
          }
          required_backend = plan.reason
          // Bonds T6: route the dispatch through the rust-wasm worker. While
          // a request is in flight the graph STAYS dirty (latest wins — the
          // completion wake re-plans against the newest inputs). Missing
          // typed inputs (legacy channel without a packet) clear the flag
          // and keep the last complete graph on screen.
          if (!wasm_bonds_inflight) {
            dispatch_wasm_bonds()
            graph_dirty = false
          }
        } else {
          required_backend = null
          if (fresh_graph) {
            bond_run.begin_graph()
            fresh_graph = false
          }
          const grid = plan.kind === `gpu-grid`
            // Override the plan's fixed per-cell capacity with the controller's
            // (possibly overflow-grown) stride — it's a uniform, no rebuild.
            ? { ...plan.grid, max_per_cell: bond_run.cell_stride() }
            : null
          // Grow the candidate/grid buffers to the controller's sizing. If any
          // reallocate, the bond bind groups were rebuilt — re-read them below.
          ensure_pair_buffers(bond_run.pair_capacity())
          if (grid) ensure_grid_capacity(grid.n_cells, grid.max_per_cell)

          // Reset the candidate's atomic counter + the occupancy record (the
          // CPU zero also covers the direct path, which never writes it), then
          // repack Params (n, capacity, and the grid block vary).
          device.queue.writeBuffer(candidate_count_buffer, 0, new Uint32Array([0]))
          device.queue.writeBuffer(grid_meta_buffer, 0, new Uint32Array([0]))
          device.queue.writeBuffer(
            bond_params_buffer, 0,
            pack_params(bond_n, candidate_pairs_capacity, {
              scale: bond_options.scale,
              max_bond_dist: bond_options.max_bond_dist,
              min_bond_dist: bond_options.min_bond_dist,
              positions: new Float32Array(0), // unused by pack_params
              radii: new Float32Array(0), // unused by pack_params
              lattice: bond_detector_lattice,
              periodic: bond_periodic,
              // rules drives Params.rule_count (rules.length / 4). Empty ⇒ 0 ⇒
              // the shader's rules_keep returns early (no post-filter). The
              // actual rule data lives in the binding-6 storage buffer.
              rules: bond_rules,
            }, grid ?? undefined),
            0, PARAMS_BYTES,
          )
          const cpass = encoder.beginComputePass({
            label: `large-system-bond-compute`,
          })
          cpass.setBindGroup(0, bond_compute_bg as GPUBindGroup)
          if (grid) {
            // Grid path: clear the per-cell counts, bin atoms, then detect.
            cpass.setPipeline(bond_clear_pipeline)
            cpass.dispatchWorkgroups(Math.max(1, Math.ceil(grid.n_cells / 64)))
            cpass.setPipeline(bond_bin_pipeline)
            cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
            cpass.setPipeline(bond_compute_pipeline)
            cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
            bond_run.record_dispatch(
              { clear: true, bin: true, detect: true },
              grid.dims,
            )
          } else {
            // Small-N direct path: a single exact all-pairs pass.
            cpass.setPipeline(bond_direct_pipeline)
            cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
            bond_run.record_dispatch({ detect: true })
          }
          cpass.end()
          // Copy raw count + observed occupancy out for async validation. The
          // indirect-args build is NOT run here — it happens at publication,
          // against the ACTIVE count, so an incomplete candidate can never
          // reach the draw.
          encoder.copyBufferToBuffer(candidate_count_buffer, 0, validation_readback, 0, 4)
          encoder.copyBufferToBuffer(grid_meta_buffer, 0, validation_readback, 4, 4)
          graph_dirty = false
          validation_inflight = true
          validation_generation = graph_generation
          kick_validation = true
        }
      }

      // ── Replica/indirect refresh (supercell tiling, publication) ─────────
      // Rebuild the draw-indirect args from the ACTIVE graph's count — no bond
      // dispatch. This is the whole cost of a replica-factor change.
      if (bonds_ready && replica_dirty) {
        const cpass = encoder.beginComputePass({
          label: `large-system-bond-indirect`,
        })
        cpass.setPipeline(indirect_pipeline)
        cpass.setBindGroup(0, indirect_bg as GPUBindGroup)
        cpass.dispatchWorkgroups(1)
        cpass.end()
        replica_dirty = false
      }

      // Draw into the multisampled color target, RESOLVE into the swapchain
      // texture. storeOp:`store` performs the MSAA→single-sample resolve into
      // resolveTarget at the end of the pass.
      const swapchain_view = context.getCurrentTexture().createView()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: msaa_color_view as GPUTextureView,
            resolveTarget: swapchain_view,
            clearValue: clear_color,
            loadOp: `clear`,
            storeOp: `store`,
          },
        ],
        depthStencilAttachment: {
          view: depth_view as GPUTextureView,
          depthClearValue: 1.0,
          depthLoadOp: `clear`,
          depthStoreOp: `store`,
        },
      })
      if (atom_count > 0 && bind_group) {
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind_group)
        // GPU supercell: atom_count × ncells instances (ncells = nx·ny·nz). The
        // vertex decodes inst → atom (inst % base_count) + cell offset. ncells 1
        // ⇒ atom_count instances, identical to the non-supercell draw. Sparse
        // ghost instances ('ghost-images' packet policy) append past the
        // replica range — 0 outside that policy, so nothing else changes.
        pass.draw(4, atom_count * Math.max(1, supercell_ncells) + ghost_draw_count())
      }
      // Bonds: instanced procedural cylinders, instance count supplied by the
      // indirect buffer the compute wrote (this same submit, or last frame's).
      // Shares the depth attachment with the atom draw ⇒ correct occlusion.
      if (bonds_ready) {
        pass.setPipeline(bond_render_pipeline)
        pass.setBindGroup(0, bond_render_bg as GPUBindGroup)
        pass.drawIndirect(indirect_buffer, 0)
      }
      // Cell box: 12 edges as a thin line-list. Drawn only when toggled on AND a
      // non-zero lattice is present (periodic structure). Shares the depth
      // attachment so atoms in front occlude the wireframe.
      if (cell_show && cell_has_lattice) {
        pass.setPipeline(cell_pipeline)
        pass.setBindGroup(0, cell_bind_group)
        pass.draw(24) // 12 edges × 2 line endpoints
      }
      // Axis-orientation gizmo: drawn LAST with depthCompare:`always` + no depth
      // write so the corner XYZ triad is ALWAYS visible (atoms/bonds never occlude
      // it). Reuses the camera uniform (the shader extracts the view rotation), so
      // it spins with the camera. Always drawn while the overlay is active — no
      // toggle/prop needed; it lives in the corner away from the structure.
      pass.setPipeline(gizmo_pipeline)
      pass.setBindGroup(0, gizmo_bind_group)
      pass.draw(4) // one quad; the fragment shader SDF-draws the whole widget
      pass.end()
      device.queue.submit([encoder.finish()])
      // Kick off the candidate validation AFTER the submit that encoded its
      // readback copies — mapAsync resolves once the GPU work completes.
      if (kick_validation) begin_validation(validation_generation)
    },
    debug_bond_state(): BondGpuDiagnostics {
      return bond_run.diagnostics()
    },
    on_bond_work(cb: (() => void) | null): void {
      bond_work_cb = cb
    },
    on_device_lost(cb: ((info?: GPUDeviceLostInfo) => void) | null): void {
      device_lost_cb = cb
      // Host raced the loss event: deliver the pending notification now —
      // still exactly once in total (notify_device_loss consumes the slot).
      notify_device_loss()
    },
    resize(w: number, h: number): void {
      if (destroyed || device_lost) return
      canvas.width = Math.max(1, Math.floor(w))
      canvas.height = Math.max(1, Math.floor(h))
      ensure_targets(canvas.width, canvas.height)
      // Re-derive the corner gizmo placement for the new canvas size so it stays
      // a constant pixel size in the corner (not stretched by the aspect change).
      upload_gizmo_uniform()
    },
    destroy(): void {
      // NOT gated on device_lost — teardown must still release resources
      // after a loss (buffer.destroy() on a lost device is a safe no-op).
      if (destroyed) return
      destroyed = true
      // Drop the host wake callback: a validation resolving after teardown
      // must not wake a host loop (its destroyed-guard also returns early
      // before observing, so this is belt-and-braces).
      bond_work_cb = null
      // Drop the loss callback too: a device.lost resolving after teardown
      // must not notify a host that already tore this session down.
      device_lost_cb = null
      try {
        context.unconfigure()
      } catch {
        // some implementations / already-lost contexts may throw — ignore
      }
      camera_buffer.destroy()
      supercell_buffer.destroy()
      shading_buffer.destroy()
      positions_buffer?.destroy()
      radii_buffer?.destroy()
      colors_buffer?.destroy()
      selected_buffer?.destroy()
      msaa_color_texture?.destroy()
      depth_texture?.destroy()
      pick_id_texture?.destroy()
      pick_depth_texture?.destroy()
      pick_readback.destroy()
      // Bond resources.
      covalent_buffer?.destroy()
      elem_ids_buffer?.destroy()
      rules_buffer?.destroy()
      active_pairs_buffer?.destroy()
      candidate_pairs_buffer?.destroy()
      cell_count_buffer?.destroy()
      cell_atoms_buffer?.destroy()
      ghost_sites_buffer?.destroy()
      ghost_images_buffer?.destroy()
      grid_meta_buffer.destroy()
      active_count_buffer.destroy()
      candidate_count_buffer.destroy()
      // Destroying while a validation/graph map is pending rejects mapAsync;
      // both async paths swallow teardown and never publish stale state.
      for (const readback of graph_readbacks) readback.destroy()
      graph_readbacks.clear()
      validation_readback.destroy()
      indirect_buffer.destroy()
      bond_meta_buffer.destroy()
      bond_params_buffer.destroy()
      bond_render_uniform.destroy()
      cell_uniform.destroy()
      gizmo_uniform.destroy()
      indirect_cfg_buffer.destroy()
      positions_buffer = null
      radii_buffer = null
      colors_buffer = null
      selected_buffer = null
      pick_id_texture = null
      pick_id_view = null
      pick_depth_texture = null
      pick_depth_view = null
      pick_bind_group = null
      covalent_buffer = null
      elem_ids_buffer = null
      rules_buffer = null
      active_pairs_buffer = null
      candidate_pairs_buffer = null
      cell_count_buffer = null
      cell_atoms_buffer = null
      ghost_sites_buffer = null
      ghost_images_buffer = null
      last_packet = null
      last_images = null
      last_positions = null
      msaa_color_texture = null
      msaa_color_view = null
      depth_texture = null
      depth_view = null
      bind_group = null
      bond_compute_bg = null
      indirect_bg = null
      bond_render_bg = null
    },
  }
}
