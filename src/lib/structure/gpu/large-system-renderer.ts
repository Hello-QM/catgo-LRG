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
import { BOND_COMPUTE_WGSL } from '$lib/structure/gpu/bond-compute.wgsl'
import { pack_params, PARAMS_BYTES } from '$lib/structure/gpu/bond-compute'
import { plan_grid, type GridPlan } from '$lib/structure/gpu/bond-grid'

/** Camera uniform (legacy 9.1): 20 floats (proj*view + camPos + pad) = 80 bytes. */
const CAMERA_UNIFORM_BYTES = 80

/** Camera uniform (9.2 impostor): view(16) + proj(16) + camPos vec3 + pad = 36
 *  floats = 144 bytes. Matches pack_camera_full's layout. */
const CAMERA_FULL_BYTES = 144

/** GPU supercell uniform (Phase 1): dims vec4<u32> (nx,ny,nz,base_count) + base
 *  lattice rows a,b,c as 3×vec4<f32> = 4 vec4 = 64 bytes. */
const SUPERCELL_BYTES = 64


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

/** Fixed bond cylinder radius (Å). Small constant; tunable. Uploaded to the
 *  bond render shader as part of its uniform so it can be retuned without a
 *  shader edit. */
const BOND_RADIUS = 0.16

/** Neutral bond color (linear rgb). Half-A/half-B coloring is a later milestone. */
const BOND_COLOR: [number, number, number] = [0.7, 0.7, 0.7]

/** Default clear color when no background is threaded in: a distinct dark
 *  background (near-black, faint blue tint) so flipping the toggle visibly
 *  swaps which canvas paints. Overridden by set_background to match the WebGL
 *  viewer's actual canvas background (so dark atoms keep their contrast). */
const CLEAR_COLOR: GPUColor = { r: 0.02, g: 0.03, b: 0.05, a: 1 }

const DEPTH_FORMAT: GPUTextureFormat = `depth24plus`

/** MSAA sample count for the overlay. 4× MSAA + alpha-to-coverage gives the
 *  impostor silhouettes (defined by fragment discard / ray-miss) smooth,
 *  analytically-AA'd edges that match the WebGL view's `antialias:true`. Both
 *  the color and depth render targets are multisampled at this count; the color
 *  target resolves into the swapchain texture each frame. */
const SAMPLE_COUNT = 4

/** WGSL cell-box line shader. Draws the 12 edges of the parallelepiped spanned
 *  by lattice vectors a,b,c as a `line-list` (24 vertices = 12 edges × 2 ends).
 *  Corners are generated in the vertex shader from a lattice uniform: the cell
 *  spans from origin 0 to a+b+c, in the SAME coordinate space as the atom
 *  positions (atoms render at raw site.xyz; the WebGL Lattice box likewise spans
 *  origin→a+b+c within the shared scene group — see Lattice.svelte's
 *  lattice_center = 0.5·(a+b+c) applied to an origin-centered box), so no extra
 *  centering offset is needed.
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
// Cell uniform: lattice rows a,b,c (vec3+pad each) + color (rgb + pad).
struct CellU {
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
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
  return fa * cell.lat0.xyz + fb * cell.lat1.xyz + fc * cell.lat2.xyz;
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
  return vec4<f32>(in.color, 1.0);
}
`

/** WGSL axis-orientation gizmo shader. Draws a small camera-oriented XYZ triad
 *  (X=red, Y=green, Z=blue) pinned to a fixed SCREEN CORNER, sized in constant
 *  pixels, independent of zoom / structure scale. It replaces the WebGL Gizmo
 *  widget (which is gone when WebGL is suspended in overlay mode).
 *
 *  Geometry: a line-list of 22 vertices.
 *    - verts 0..5  = the 3 axis lines (3 axes × 2 endpoints): axis index = vi/2
 *      selects the unit axis (+X/+Y/+Z); the low bit picks origin vs. axis tip.
 *    - verts 6..21 = 16 LETTER-GLYPH endpoints (8 line segments × 2): tiny X/Y/Z
 *      letters drawn at each axis tip, color-matched to the axis. X=2 segments,
 *      Y=3, Z=3. Each glyph vertex offsets from its axis' PROJECTED tip by a 2D
 *      template coordinate scaled to a small constant pixel size — the letters
 *      stay SCREEN-FLAT (no 3D rotation), facing the viewer at the tip.
 *  Orientation of the AXES uses ONLY the camera view ROTATION (upper-3×3 of
 *  camera.view, NOT its translation), so the triad spins with the camera like an
 *  orientation indicator. The rotated axis' XY (screen plane; camera looks down
 *  -Z in view space) is scaled to a small NDC region and offset to the corner.
 *  The corner center + per-pixel NDC scale (aspect-corrected so the region is
 *  square in pixels) come from a uniform the renderer fills from the canvas size.
 *
 *  Depth: the gizmo must ALWAYS be visible (never occluded by atoms/bonds). Its
 *  pipeline runs with depthCompare:`always` + depthWriteEnabled:false, and it is
 *  drawn LAST in the pass, so it overwrites the corner regardless of scene depth. */
const GIZMO_WGSL = `
struct Camera {
  view : mat4x4<f32>,
  proj : mat4x4<f32>,
  cam_pos : vec4<f32>,
};
// Gizmo placement uniform:
//   center_ndc : corner anchor in clip/NDC space (xy), z/w unused.
//   scale_ndc  : per-unit-axis NDC half-extent (x,y) — y carries the aspect
//                correction so the triad is square in pixels.
struct GizmoU {
  center_ndc : vec4<f32>,
  scale_ndc : vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<uniform> giz : GizmoU;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec3<f32>,
};

// Axis unit vectors and their (linear-ish) colors. X red, Y green, Z blue.
const AXES = array<vec3<f32>, 3>(
  vec3<f32>(1.0, 0.0, 0.0),
  vec3<f32>(0.0, 1.0, 0.0),
  vec3<f32>(0.0, 0.0, 1.0),
);
const AXIS_COLORS = array<vec3<f32>, 3>(
  vec3<f32>(0.85, 0.10, 0.10),
  vec3<f32>(0.10, 0.70, 0.10),
  vec3<f32>(0.10, 0.10, 0.85),
);

// Letter-glyph templates as 2D line segments on a [-1,1] square, screen-aligned.
// 8 segments = 16 endpoints (glyph verts 0..15 = gizmo verts 6..21):
//   X (axis 0): segs 0,1 -> two crossing diagonals.
//   Y (axis 1): segs 2,3,4 -> two upper arms to center + stem down.
//   Z (axis 2): segs 5,6,7 -> top bar, diagonal, bottom bar.
const GLYPH_PTS = array<vec2<f32>, 16>(
  // X: (-1,-1)->(1,1), (-1,1)->(1,-1)
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0),
  // Y: (-1,1)->(0,0), (1,1)->(0,0), (0,0)->(0,-1)
  vec2<f32>(-1.0, 1.0), vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(0.0, -1.0),
  // Z: (-1,1)->(1,1), (1,1)->(-1,-1), (-1,-1)->(1,-1)
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0),
);
// Which axis (tip + color) each of the 16 glyph endpoints belongs to.
const GLYPH_AXIS = array<u32, 16>(
  0u, 0u, 0u, 0u,                 // X: 2 segs
  1u, 1u, 1u, 1u, 1u, 1u,         // Y: 3 segs
  2u, 2u, 2u, 2u, 2u, 2u,         // Z: 3 segs
);
// Glyph half-size in pixels (the template [-1,1] maps to +-GLYPH_PX). Sat past
// the axis tip by GLYPH_TIP_SCALE so the letter clears the arrow end.
const GLYPH_PX : f32 = 9.0;
const GLYPH_TIP_SCALE : f32 = 1.18;
// Mirrors the TS-side GIZMO_PX: scale_ndc spans GIZMO_PX pixels per unit axis, so
// dividing GLYPH_PX by it converts the glyph half-size into the same NDC scale.
const GIZMO_PX_F : f32 = 120.0;

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VsOut {
  // Camera view ROTATION only (upper-3x3 of camera.view). Drop translation so
  // the triad rotates with the camera but stays pinned to the corner.
  let rot = mat3x3<f32>(
    camera.view[0].xyz,
    camera.view[1].xyz,
    camera.view[2].xyz,
  );

  // The glyph half-size in NDC reuses the per-axis pixel scale (scale_ndc spans
  // GIZMO_PX), so a GLYPH_PX template is square in pixels and not skewed.
  let glyph_ndc = vec2<f32>(
    giz.scale_ndc.x * (GLYPH_PX / GIZMO_PX_F),
    giz.scale_ndc.y * (GLYPH_PX / GIZMO_PX_F),
  );

  var out : VsOut;

  if (vi < 6u) {
    // --- Axis lines: 3 axes x 2 endpoints (origin -> rotated tip). ---
    let axis_i = vi / 2u;            // 0=X, 1=Y, 2=Z
    let is_tip = (vi & 1u) == 1u;    // segment: origin -> tip
    let dir = rot * AXES[axis_i];    // rotated axis in view space (camera looks -Z)
    let tip_off = vec2<f32>(dir.x * giz.scale_ndc.x, dir.y * giz.scale_ndc.y);
    let off = select(vec2<f32>(0.0, 0.0), tip_off, is_tip);
    let pos = giz.center_ndc.xy + off;
    out.clip = vec4<f32>(pos, 0.0, 1.0);
    out.color = AXIS_COLORS[axis_i];
    return out;
  }

  // --- Letter glyphs: verts 6..21 -> glyph endpoints 0..15. ---
  let gvi = vi - 6u;
  let axis_i = GLYPH_AXIS[gvi];
  // Projected axis tip in NDC, pushed slightly BEYOND the tip so the letter sits
  // past the arrow end (along the rotated axis' screen direction).
  let dir = rot * AXES[axis_i];
  let tip_off = vec2<f32>(dir.x * giz.scale_ndc.x, dir.y * giz.scale_ndc.y);
  let tip_pos = giz.center_ndc.xy + tip_off * GLYPH_TIP_SCALE;
  // Screen-flat template offset (NO 3D rotation): the letter faces the viewer.
  let t = GLYPH_PTS[gvi];
  let pos = tip_pos + vec2<f32>(t.x * glyph_ndc.x, t.y * glyph_ndc.y);
  out.clip = vec4<f32>(pos, 0.0, 1.0);
  out.color = AXIS_COLORS[axis_i];
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
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

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) vc : vec3<f32>,      // view-space sphere center
  @location(1) radius : f32,
  @location(2) color : vec3<f32>,
  @location(3) vpos : vec3<f32>,    // view-space position of this quad corner
  @location(4) @interpolate(flat) sel : u32, // 1 = this atom is selected
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
  let atom = inst % base_count;
  let cell = inst / base_count;
  let nx = max(supercell.dims.x, 1u);
  let ny = max(supercell.dims.y, 1u);
  let ix = cell % nx;
  let iy = (cell / nx) % ny;
  let iz = cell / (nx * ny);
  let offset = f32(ix) * supercell.lat0.xyz
             + f32(iy) * supercell.lat1.xyz
             + f32(iz) * supercell.lat2.xyz;

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
  // Billboard in view space; bump radius slightly so the silhouette isn't clipped.
  let vpos = vc + vec3<f32>(c * r * 1.5, 0.0);
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
  return out;
}

@fragment
fn fs_main(in : VsOut) -> FsOut {
  // Eye at view-space origin; ray through the interpolated view-space position.
  let ro = vec3<f32>(0.0, 0.0, 0.0);
  let rd = normalize(in.vpos);

  // Ray-sphere intersection: |ro + t*rd - vc|^2 = radius^2
  let oc = ro - in.vc;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - in.radius * in.radius;
  let disc = b * b - c;

  // ── Analytic silhouette coverage (alpha-to-coverage AA) ────────────────────
  // disc = r^2 - d_perp^2 where d_perp is the eye-ray's perpendicular distance
  // to the center: >0 inside the disk, =0 exactly on the silhouette. This is a
  // SMOOTH varying of the interpolated ray (in.vpos), so fwidth() gives the
  // screen-space width of the silhouette band. coverage ramps 0->1 across that
  // ~1px band; output as alpha so alpha-to-coverage turns it into fractional
  // MSAA sample coverage -> smooth curved edges (plain MSAA can't smooth a
  // hard discard edge).
  let fw = fwidth(disc);
  let coverage = clamp(disc / max(fw, 1e-8) + 0.5, 0.0, 1.0);
  if (coverage <= 0.0) {
    discard;
  }
  // Near hit. In the thin edge band disc may be ~0 (sqrt≈0), so the hit point
  // sits on the silhouette — its depth is the right value for that band.
  let t = -b - sqrt(max(disc, 0.0)); // near hit
  if (t < 0.0) {
    discard;
  }
  let p = ro + t * rd;            // view-space hit point
  let n = normalize(p - in.vc);   // surface normal

  let light_dir = normalize(vec3<f32>(0.3, 0.5, 0.8));
  let lighting = 0.35 + 0.65 * max(dot(n, light_dir), 0.0);

  // Correct depth: project the hit point, apply the same GL->WebGPU z remap as
  // the vertex stage, then perspective-divide into NDC z (WebGPU range 0..1).
  let clip_h = camera.proj * vec4<f32>(p, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var shaded = in.color * lighting;
  // ── Selection highlight ──────────────────────────────────────────────────
  // Selected atoms (sel == 1) get a clearly-distinct look: brighten the body and
  // add a bright cyan-tinted RIM where the eye ray grazes the silhouette (rim is
  // strong when the surface normal is near-perpendicular to the view direction —
  // i.e. 1 - |n·view|). This reads as a glowing outline ring on the sphere,
  // matching the "this atom is selected" affordance of the WebGL view. Non-
  // selected atoms (sel == 0) are untouched.
  if (in.sel == 1u) {
    let view_dir = normalize(-p);            // toward the eye (eye at origin)
    let rim = pow(1.0 - clamp(dot(n, view_dir), 0.0, 1.0), 2.0);
    let highlight_tint = vec3<f32>(0.25, 0.95, 1.0); // bright cyan
    // Brighten the body and mix toward the tint at the rim.
    shaded = mix(shaded * 1.35 + highlight_tint * 0.25, highlight_tint, rim * 0.85);
  }

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  // alpha = coverage feeds alpha-to-coverage; no alpha blending is enabled, so
  // the color target stays opaque.
  out.color = vec4<f32>(shaded, coverage);
  return out;
}
`

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
  let atom = inst % base_count;
  let cell = inst / base_count;
  let nx = max(supercell.dims.x, 1u);
  let ny = max(supercell.dims.y, 1u);
  let ix = cell % nx;
  let iy = (cell / nx) % ny;
  let iz = cell / (nx * ny);
  let offset = f32(ix) * supercell.lat0.xyz
             + f32(iy) * supercell.lat1.xyz
             + f32(iz) * supercell.lat2.xyz;

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
 *  half 1 to a degenerate offscreen billboard (zero fragments). Detection:
 *  jimage (0,0,0) packs to (0+1)|((0+1)<<2)|((0+1)<<4) = 21u.
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
// Bond uniform: lattice columns a,b,c (transposed, vec3+pad each) + radius.
struct BondU {
  lat0 : vec4<f32>,
  lat1 : vec4<f32>,
  lat2 : vec4<f32>,
  radius_color : vec4<f32>, // x=radius, yzw=color
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

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) v0 : vec3<f32>,      // view-space cylinder start (flat)
  @location(1) v1 : vec3<f32>,      // view-space cylinder end   (flat)
  @location(2) radius : f32,        // cylinder radius (flat)
  @location(3) color : vec3<f32>,
  @location(4) vpos : vec3<f32>,    // view-space position of this quad corner
  // 1.0 for CROSS-cell stubs, 0.0 for INTRA-cell full cylinders. Flat-interp.
  // The fragment shader pushes cross-cell stubs slightly BACKWARD in depth so a
  // stub coincident with an intra-cell bond at a shared atom loses the depth tie
  // (intra always wins) — kills the faint alpha-to-coverage dotted seam.
  @location(5) is_stub : f32,
};

struct FsOut {
  @builtin(frag_depth) depth : f32,
  @location(0) color : vec4<f32>,
};

fn atom_pos(i : u32) -> vec3<f32> {
  return vec3<f32>(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
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

  // Unpack jimage {-1,0,1} from (na+1)|((nb+1)<<2)|((nc+1)<<4).
  let ji = i32(jp & 3u) - 1;
  let jj = i32((jp >> 2u) & 3u) - 1;
  let jk = i32((jp >> 4u) & 3u) - 1;
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

  // show_images flag (viewer's show_image_atoms) packed into lat0.w by the TS
  // upload (1=on). When ON and we are in the NON-supercell path (ncells==1), a
  // cross-cell bond's imaged partner B+jimage·lattice coincides with a DISPLAYED
  // PBC image atom → upgrade the boundary STUB to a FULL cylinder reaching it, so
  // image atoms gain bonds (matching the WebGL view). Supercell mode (ncells>1)
  // is left to the Phase-2 partner-cell-in-range logic untouched.
  let ncells = nx * ny * nz;
  let show_images = supercell.lat0.w > 0.5;
  let image_full = (!inside) && ncells == 1u && show_images;

  // Render as ONE full cylinder when the partner is a real in-range atom (half 0:
  // A→B_real, half 1 degenerate) — same single-full-cylinder path the Phase-1
  // single-cell code used for intra-cell (jimage=0) bonds. When ncells=1, only
  // jimage=0 is ever inside [0,1)³, so this is exactly the old is_intra branch.
  // image_full upgrades a ncells==1 cross-cell boundary stub to that same full
  // path (endpoint partnerB = the displayed image atom) when show_images is on.
  let is_full = inside || image_full;

  // FULL: half 0 spans A→B_real; half 1 is collapsed offscreen below.
  // STUB (boundary): half 0 = A→mid(A,partnerB); half 1 = B→mid(B,partnerA) — the
  // two short stubs of the single-cell cross-cell path, shifted by cell_offset.
  let cross_start = select(B, A, half == 0u);
  let cross_mid = select((B + partnerA) * 0.5, (A + partnerB) * 0.5, half == 0u);
  let start = select(cross_start, A, is_full);
  let end = select(cross_mid, B_real, is_full);

  // Keep the downstream variable name the rest of vs_main uses (is_intra) so the
  // degenerate-half collapse + is_stub flag below are untouched: a full cylinder
  // behaves exactly like an intra-cell bond (half 1 redundant, no depth bias).
  let is_intra = is_full;

  let r = bond.radius_color.x;

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

  // Intra-cell half 1 is redundant (half 0 already draws the full A->B cylinder):
  // collapse ALL 6 strip vertices to the same offscreen clip position so the
  // billboard has zero area and rasterizes no fragments (don't rely on fragment
  // discard alone). Cross-cell halves are untouched.
  if (is_intra && half == 1u) {
    var out_deg : VsOut;
    out_deg.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0); // outside the [-w,w] clip cube
    out_deg.v0 = v0;
    out_deg.v1 = v1;
    out_deg.radius = r;
    out_deg.color = bond.radius_color.yzw;
    out_deg.vpos = vpos;
    out_deg.is_stub = 0.0; // degenerate (discarded) — value irrelevant
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
  out.color = bond.radius_color.yzw;
  out.vpos = vpos;
  // Cross-cell stubs (jimage != 0, !is_intra) get the fragment depth bias.
  out.is_stub = select(1.0, 0.0, is_intra);
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

  let light_dir = normalize(vec3<f32>(0.3, 0.5, 0.8));
  let lighting = 0.35 + 0.65 * max(dot(hit_n, light_dir), 0.0);

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
  out.color = vec4<f32>(in.color * lighting, cov);
  return out;
}
`

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
   *  what scales the rendered atom count WITHOUT building N× Site objects. */
  set_supercell(dims: [number, number, number], base_lattice: Float32Array): void
  /** Toggle whether DISPLAYED PBC image atoms exist (the viewer's
   *  `show_image_atoms`, non-supercell only). When true, cross-cell bonds
   *  (jimage != 0) in the ncells==1 path are drawn as FULL cylinders reaching the
   *  imaged partner (B + jimage·lattice) — exactly where the displayed image atom
   *  sits — so image atoms gain bonds (matching the WebGL view). When false (the
   *  default) those bonds stay HALF-stubs (the "PBC bond too long, show half"
   *  behaviour). NEVER affects supercell mode (ncells>1) — there the Phase-2
   *  partner-cell-in-range logic is authoritative. Marks bonds dirty so the next
   *  render re-emits with the new flag. */
  set_show_images(show: boolean): void
  /** Provide bond-detection inputs. `covalent_radii` is the per-atom COVALENT
   *  radius (N entries, from build_atom_radii — distinct from the display radii
   *  used for sphere size). `lattice` is the 9-float row-major matrix (rows
   *  a,b,c), the SAME one the compute + bond render use. `options` carries the
   *  bond cutoffs; `periodic` toggles min-image PBC. Marks bonds dirty so the
   *  next render re-runs the compute dispatch — NOT every frame. */
  set_bond_data(
    covalent_radii: Float32Array,
    lattice: Float32Array,
    options: { tolerance: number; max_bond_dist: number; min_dist: number },
    periodic: boolean,
  ): void
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
   *  contrast against the viewer's normal background). Alpha stays 1 (opaque). */
  set_background(rgb: [number, number, number]): void
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
   *  is the linear-RGB cell edge color (alpha is forced to 1). When `show` is true
   *  AND the lattice is non-zero, render() draws the 12 cell edges as thin lines
   *  (WebGPU core line width is 1px) sharing the atom depth buffer (occluded by
   *  atoms in front). */
  set_cell(
    lattice: Float32Array | null,
    show: boolean,
    color: [number, number, number],
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
   *  texel at the given DEVICE-pixel (x,y) to a readback buffer and returns the
   *  atom index under that pixel, or -1 for background. (x,y) are in device pixels
   *  (CSS px × devicePixelRatio); the caller maps cursor→canvas→device. */
  pick(x: number, y: number): Promise<number>
  /** Run one render pass: clear + (if bonds dirty) bond compute + indirect-args
   *  build, then (if atoms present) impostor sphere draw + (if bonds present)
   *  instanced cylinder draw, all sharing one depth attachment. */
  render(): void
  /** Resize the backing canvas + depth texture to device-pixel dimensions. */
  resize(w: number, h: number): void
  /** Tear down GPU resources and unconfigure the context. */
  destroy(): void
}

export function create_large_system_renderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
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
  // Cached supercell dims; ncells = product. Default [1,1,1] ⇒ ncells 1.
  let supercell_dims: [number, number, number] = [1, 1, 1]
  let supercell_ncells = 1
  // Cached base lattice rows (9 floats, rows a,b,c) for the per-cell offset.
  let supercell_lattice = new Float32Array(9)
  // Whether DISPLAYED PBC image atoms exist (viewer's show_image_atoms). Packed
  // into the Supercell uniform's lat0.w pad slot (the atom impostor reads only
  // .xyz, so this never perturbs it). Read in BOND_RENDER_WGSL to upgrade the
  // ncells==1 cross-cell STUB to a FULL cylinder reaching the displayed image
  // atom. Default false ⇒ stubs ⇒ zero change.
  let show_image_atoms = false

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
  // GPU-resident bond outputs. `pairs` holds capacity*3 u32 (a,b,jimage); the
  // atomic count + indirect-args are tiny fixed buffers.
  let pairs_buffer: GPUBuffer | null = null
  let bond_capacity = 0 // pairs the current pairs buffer can hold
  // ── Uniform-grid (cell-list) buffers (bindings 7/8/9). cell_count tallies atoms
  // per cell (n_cells u32), cell_atoms holds up to max_per_cell atom ids per cell
  // (n_cells*max u32), overflow is a single u32 flag. Sized from the grid plan;
  // grown when the plan needs more cells/atoms. A 4-byte minimum keeps the
  // bindings valid in the fallback (use_grid=0) path. ──
  let cell_count_buffer: GPUBuffer | null = null
  let cell_atoms_buffer: GPUBuffer | null = null
  let cell_count_cells = 0 // cells the cell_count buffer can hold
  let cell_atoms_slots = 0 // total (cells*max) slots cell_atoms can hold
  const overflow_buffer = device.createBuffer({
    label: `large-system-bond-overflow`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  // Last grid plan (recomputed at dispatch from the current bond inputs).
  let grid_plan: GridPlan | null = null
  // CPU copy of the current frame's atom xyz (3N), kept ONLY so the non-periodic
  // grid plan can compute the atom AABB on the CPU (the periodic plan needs no
  // positions). Updated by set_atoms / set_positions. For periodic structures this
  // is still cached but never read by plan_grid.
  let last_positions: Float32Array | null = null
  const count_buffer = device.createBuffer({
    label: `large-system-bond-count`,
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
  // Bond render uniform: lattice columns (transposed, 3×vec4) + (radius,color).
  const bond_render_uniform = device.createBuffer({
    label: `large-system-bond-render-uniform`,
    size: 64, // 4 × vec4
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Cell-box render uniform: lattice rows a,b,c (3×vec4) + color (vec4).
  const cell_uniform = device.createBuffer({
    label: `large-system-cell-uniform`,
    size: 64, // 4 × vec4
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
  // Cached bond inputs, re-uploaded only when set_bond_data changes them.
  let bond_lattice = new Float32Array(9)
  let bond_options = { tolerance: 0, max_bond_dist: 0, min_dist: 0 }
  let bond_periodic = false
  let bond_n = 0 // atom count the detection should range over
  // True when the bond inputs (or atoms) changed and the compute must re-run.
  let bonds_dirty = false
  let bonds_configured = false // set once set_bond_data has provided inputs
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
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
    ],
  })
  const gizmo_pipeline = device.createRenderPipeline({
    label: `large-system-gizmo-pipeline`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [gizmo_bgl] }),
    vertex: { module: gizmo_module, entryPoint: `vs_main` },
    fragment: { module: gizmo_module, entryPoint: `fs_main`, targets: [{ format }] },
    primitive: { topology: `line-list` },
    depthStencil: {
      format: DEPTH_FORMAT,
      // Always visible: never write depth, never fail the depth test. The gizmo
      // overwrites its corner regardless of what atoms/bonds drew there.
      depthWriteEnabled: false,
      depthCompare: `always`,
    },
    // Share the multisampled targets (count must match). No alpha-to-coverage —
    // opaque colored lines.
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

  /** Fixed pixel geometry of the corner gizmo. The triad region is ~2·GIZMO_PX
   *  wide (each axis reaches GIZMO_PX from the origin), placed GIZMO_MARGIN_PX in
   *  from the bottom-left corner — matching the WebGL Gizmo's offset:{left,bottom}. */
  const GIZMO_PX = 120
  const GIZMO_MARGIN_PX = 28

  /** Pack + upload the gizmo placement uniform from the canvas backing size.
   *  - center_ndc: bottom-left corner anchor in NDC. NDC x∈[-1,1] (right), y∈
   *    [-1,1] (UP). Pixel→NDC: dx_ndc = 2·px/width, dy_ndc = 2·px/height. We seat
   *    the triad ORIGIN one (margin + axis reach) in from the bottom-left so the
   *    whole triad stays on-screen whatever its rotation.
   *  - scale_ndc: per-unit-axis half-extent. x = 2·GIZMO_PX/width; y =
   *    2·GIZMO_PX/height (independent per-axis pixel scale ⇒ square in pixels,
   *    aspect-corrected — a unit axis reaches exactly GIZMO_PX pixels either way). */
  function upload_gizmo_uniform(): void {
    const w = Math.max(1, canvas.width)
    const h = Math.max(1, canvas.height)
    const inset = GIZMO_MARGIN_PX + GIZMO_PX
    const cx = -1 + (2 * inset) / w // from the LEFT edge
    const cy = -1 + (2 * inset) / h // from the BOTTOM edge (NDC y up)
    const sx = (2 * GIZMO_PX) / w
    const sy = (2 * GIZMO_PX) / h
    const u = new Float32Array(8)
    u[0] = cx; u[1] = cy; u[2] = 0; u[3] = 0
    u[4] = sx; u[5] = sy; u[6] = 0; u[7] = 0
    device.queue.writeBuffer(gizmo_uniform, 0, u.buffer, u.byteOffset, 32)
  }

  /** Pack + upload the cell render uniform: lattice rows a,b,c (each a vec3 + pad)
   *  then color (rgb + pad). Same row convention as the bond render uniform. */
  function upload_cell_uniform(): void {
    const u = new Float32Array(16)
    const L = cell_lattice
    u[0] = L[0]; u[1] = L[1]; u[2] = L[2]; u[3] = 0
    u[4] = L[3]; u[5] = L[4]; u[6] = L[5]; u[7] = 0
    u[8] = L[6]; u[9] = L[7]; u[10] = L[8]; u[11] = 0
    u[12] = cell_color[0]; u[13] = cell_color[1]; u[14] = cell_color[2]; u[15] = 1
    device.queue.writeBuffer(cell_uniform, 0, u.buffer, u.byteOffset, 64)
  }

  // Indirect-args cfg: (verts_per_cylinder, capacity, ncells). capacity is
  // refreshed when the pairs buffer (re)allocates; ncells when set_supercell
  // changes the tiling. ncells defaults to 1 ⇒ the single-cell instance count.
  function write_indirect_cfg(): void {
    device.queue.writeBuffer(
      indirect_cfg_buffer, 0,
      new Uint32Array([
        BOND_VERTS_PER_CYLINDER,
        bond_capacity,
        Math.max(1, supercell_ncells),
      ]),
    )
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
      ],
    })
    // Pick pass reuses camera + positions + radii (no colors/selected) PLUS the
    // GPU supercell uniform (Phase 4) so the pick vs decodes the cell identically
    // to the atom draw and clicks hit the right replica.
    pick_bind_group = device.createBindGroup({
      label: `large-system-pick-bg`,
      layout: pick_bgl,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: radii_buffer } },
        { binding: 3, resource: { buffer: supercell_buffer } },
      ],
    })
  }

  /** Grow the GPU-resident pairs buffer to hold at least `cap` bonds. Heuristic
   *  capacity is chosen by the caller (set_atoms): max(1024, n_atoms*16). */
  function ensure_pairs_capacity(cap: number): void {
    if (cap <= bond_capacity && pairs_buffer) return
    pairs_buffer?.destroy()
    bond_capacity = Math.max(cap, 1024)
    pairs_buffer = device.createBuffer({
      label: `large-system-bond-pairs`,
      size: bond_capacity * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    write_indirect_cfg()
    rebuild_bond_bind_groups()
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

  /** (Re)build the three bond bind groups. Depends on positions_buffer (atom
   *  realloc), covalent_buffer, pairs_buffer, and the elem-ids / rules buffers
   *  (bindings 5/6) — any of which may reallocate. The elem-ids / rules buffers
   *  are auto-created here (with a placeholder if never set) so the auto-layout
   *  compute bind group is always complete (bindings 5/6 are declared in the
   *  WGSL). No-op until positions/covalent/pairs are present. */
  function rebuild_bond_bind_groups(): void {
    bond_compute_bg = null
    indirect_bg = null
    bond_render_bg = null
    if (!positions_buffer || !covalent_buffer || !pairs_buffer) return
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

    bond_compute_bg = device.createBindGroup({
      label: `large-system-bond-compute-bg`,
      layout: bond_compute_bgl,
      entries: [
        { binding: 0, resource: { buffer: positions_buffer } },
        { binding: 1, resource: { buffer: covalent_buffer } },
        { binding: 2, resource: { buffer: bond_params_buffer } },
        { binding: 3, resource: { buffer: pairs_buffer } },
        { binding: 4, resource: { buffer: count_buffer } },
        { binding: 5, resource: { buffer: elem_ids_buffer } },
        { binding: 6, resource: { buffer: rules_buffer } },
        { binding: 7, resource: { buffer: cell_count_buffer } },
        { binding: 8, resource: { buffer: cell_atoms_buffer } },
        { binding: 9, resource: { buffer: overflow_buffer } },
      ],
    })
    indirect_bg = device.createBindGroup({
      label: `large-system-indirect-bg`,
      layout: indirect_pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: count_buffer } },
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
        { binding: 2, resource: { buffer: pairs_buffer } },
        { binding: 3, resource: { buffer: bond_render_uniform } },
        // binding 4: clamped bond_count (Phase-2 inst decode). binding 5: the GPU
        // supercell uniform (dims + base lattice) for the per-cell offset.
        { binding: 4, resource: { buffer: bond_meta_buffer } },
        { binding: 5, resource: { buffer: supercell_buffer } },
      ],
    })
  }

  /** Pack + upload the bond render uniform: lattice columns (TRANSPOSED to match
   *  the compute's column layout) + (radius, color). */
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
    // slot carries show_image_atoms (1=on) for the bond render's ncells==1 full-
    // to-image-atom path; the atom impostor reads only .xyz so it is unaffected.
    f32[0] = L[0]; f32[1] = L[1]; f32[2] = L[2]; f32[3] = show_image_atoms ? 1 : 0
    f32[4] = L[3]; f32[5] = L[4]; f32[6] = L[5]; f32[7] = 0
    f32[8] = L[6]; f32[9] = L[7]; f32[10] = L[8]; f32[11] = 0
    device.queue.writeBuffer(supercell_buffer, 0, buf, 0, SUPERCELL_BYTES)
  }

  function upload_bond_render_uniform(): void {
    const u = new Float32Array(16)
    const L = bond_lattice
    // Same transpose pack_params uses: column k = lattice row k.
    u[0] = L[0]; u[1] = L[1]; u[2] = L[2]; u[3] = 0
    u[4] = L[3]; u[5] = L[4]; u[6] = L[5]; u[7] = 0
    u[8] = L[6]; u[9] = L[7]; u[10] = L[8]; u[11] = 0
    u[12] = BOND_RADIUS
    u[13] = BOND_COLOR[0]; u[14] = BOND_COLOR[1]; u[15] = BOND_COLOR[2]
    device.queue.writeBuffer(bond_render_uniform, 0, u.buffer, u.byteOffset, 64)
  }

  let destroyed = false

  // Mutable clear color, defaulting to the near-black constant until the caller
  // threads the viewer's background via set_background. Typed as the dict form
  // (not the GPUColor union) so the .r/.g/.b/.a fields are writable.
  const clear_color: GPUColorDict = { ...(CLEAR_COLOR as GPUColorDict) }

  return {
    set_background(rgb: [number, number, number]): void {
      if (destroyed) return
      clear_color.r = rgb[0]
      clear_color.g = rgb[1]
      clear_color.b = rgb[2]
      clear_color.a = 1
    },
    set_cell(
      lattice: Float32Array | null,
      show: boolean,
      color: [number, number, number],
    ): void {
      if (destroyed) return
      cell_show = show
      cell_color = [color[0], color[1], color[2]]
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
      if (destroyed) return
      // Legacy 80-byte (proj*view) upload into the first bytes; harmless — the
      // impostor draw uses set_camera_full. Guard against short/long arrays.
      const bytes = Math.min(uniform.byteLength, CAMERA_UNIFORM_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_camera_full(uniform: Float32Array): void {
      if (destroyed) return
      const bytes = Math.min(uniform.byteLength, CAMERA_FULL_BYTES)
      device.queue.writeBuffer(camera_buffer, 0, uniform.buffer, uniform.byteOffset, bytes)
    },
    set_atoms(
      positions: Float32Array,
      radii: Float32Array,
      colors: Float32Array,
      count: number,
    ): void {
      if (destroyed) return
      atom_count = Math.max(0, count)
      if (atom_count === 0) return

      // (Re)allocate when capacity is insufficient. Storage buffers must be at
      // least the byte length we write; grow with headroom to avoid churn.
      if (atom_count > atom_capacity) {
        const new_cap = Math.max(atom_count, Math.ceil(atom_capacity * 2), 1)
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
      }

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
      // Positions moved ⇒ bonds must be recomputed next render.
      bonds_dirty = true
    },
    set_positions(positions: Float32Array, count: number): void {
      if (destroyed) return
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
      // Atoms moved ⇒ bonds must be recomputed against the new positions.
      bonds_dirty = true
    },
    set_bond_data(
      covalent_radii: Float32Array,
      lattice: Float32Array,
      options: { tolerance: number; max_bond_dist: number; min_dist: number },
      periodic: boolean,
    ): void {
      if (destroyed) return
      bonds_configured = true
      bond_n = covalent_radii.length
      bond_lattice = lattice.slice(0, 9)
      bond_options = { ...options }
      bond_periodic = periodic

      // Capacity heuristic: max(1024, n_atoms * 16). Pairs buffer + indirect cfg
      // grow with the atom count; never shrink (avoids churn on tweaks).
      ensure_pairs_capacity(Math.max(1024, bond_n * 16))

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

      // Upload the bond render uniform (lattice + radius/color) now; the compute
      // Params is repacked at dispatch time (it also needs capacity).
      upload_bond_render_uniform()
      bonds_dirty = true
    },
    set_bond_rules(elem_ids: Uint32Array, rules: Float32Array): void {
      if (destroyed) return
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
      bonds_dirty = true
    },
    set_bonds_enabled(enabled: boolean): void {
      if (destroyed) return
      if (enabled === bonds_enabled) return
      bonds_enabled = enabled
      // Turning bonds back on must re-run the compute against the current atoms
      // (the cached pairs may be stale or were never computed while disabled).
      if (enabled) bonds_dirty = true
    },
    set_supercell(dims: [number, number, number], base_lattice: Float32Array): void {
      if (destroyed) return
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
      // ncells changed ⇒ the bond draw's instance count (2·bond_count·ncells) must
      // be rebuilt. Refresh the cfg uniform and mark bonds dirty so the next render
      // re-runs the indirect-args build with the new ncells (and re-emits the per-
      // cell bond replicas). A static scene would otherwise keep the old count.
      write_indirect_cfg()
      bonds_dirty = true
    },
    set_show_images(show: boolean): void {
      if (destroyed) return
      const next = !!show
      if (next === show_image_atoms) return
      show_image_atoms = next
      // Re-pack the Supercell uniform (lat0.w flag) and re-emit bonds so the
      // ncells==1 cross-cell halves switch between stub and full-to-image.
      upload_supercell_uniform()
      bonds_dirty = true
    },
    set_selection(indices: Uint32Array | number[]): void {
      if (destroyed) return
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
    async pick(x: number, y: number): Promise<number> {
      if (destroyed) return -1
      if (atom_count <= 0 || !pick_bind_group || !pick_id_view || !pick_depth_view) {
        return -1
      }
      if (!pick_id_texture) return -1
      // Clamp the requested device pixel to the texture bounds.
      const w = pick_id_texture.width
      const h = pick_id_texture.height
      const px = Math.max(0, Math.min(w - 1, Math.floor(x)))
      const py = Math.max(0, Math.min(h - 1, Math.floor(y)))

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
      pass.draw(4, atom_count * Math.max(1, supercell_ncells))
      pass.end()
      // Copy the single picked texel into the 256-byte readback buffer.
      encoder.copyTextureToBuffer(
        { texture: pick_id_texture, origin: { x: px, y: py, z: 0 } },
        { buffer: pick_readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      )
      device.queue.submit([encoder.finish()])

      await pick_readback.mapAsync(GPUMapMode.READ, 0, 4)
      if (destroyed) {
        try { pick_readback.unmap() } catch { /* already torn down */ }
        return -1
      }
      const id = new Uint32Array(pick_readback.getMappedRange(0, 4))[0]
      pick_readback.unmap()
      // id 0 = background ⇒ -1. Otherwise the raw id is GLOBAL instance + 1; the
      // global instance is atom + cell·base_count, so the BASE atom index is
      // (id - 1) % base_count. The CPU holds the BASE cell (displayed_structure IS
      // the base cell in supercell mode), so base_atom indexes displayed_structure
      // .sites directly — the caller (handle_overlay_pick) needs no change. With
      // 1×1×1 (ncells 1) base_count = atom_count and g < atom_count, so base_atom =
      // g — byte-identical to the pre-Phase-4 `id - 1`.
      if (id === 0) return -1
      const g = id - 1
      const base_count = Math.max(1, atom_count)
      return g % base_count
    },
    render(): void {
      if (destroyed) return
      if (!depth_view || !msaa_color_view) ensure_targets(canvas.width || 1, canvas.height || 1)
      const encoder = device.createCommandEncoder({ label: `large-system-frame` })

      // Whether bonds are renderable this frame (visible + inputs present +
      // atoms). bonds_enabled gates BOTH the compute pass below AND the bond
      // draw, so a hidden show_bonds setting skips all bond work entirely.
      const bonds_ready =
        bonds_enabled && bonds_configured && atom_count > 0 && bond_n > 0 &&
        !!bond_compute_bg && !!indirect_bg && !!bond_render_bg && !!pairs_buffer

      // ── Bond compute (only when dirty) ───────────────────────────────────
      // Runs as a compute pass in THIS encoder, before the render pass, so the
      // pairs/indirect writes are visible to the bond draw in the same submit.
      // Cached by `bonds_dirty`: structure/option/atom changes flip it; a static
      // scene re-uses last frame's GPU-resident pairs with no recompute.
      if (bonds_ready && bonds_dirty) {
        // Plan the uniform grid from the current bond inputs + this frame's atom
        // positions (non-periodic AABB needs them). For periodic small cells the
        // plan's use_grid is false ⇒ the shader takes the O(N²) fallback.
        grid_plan = plan_grid({
          periodic: bond_periodic,
          lattice: bond_lattice,
          max_bond_dist: bond_options.max_bond_dist,
          positions: last_positions ?? new Float32Array(0),
          n: bond_n,
        })
        // Grow the grid buffers if this plan needs more cells/atom slots. If they
        // reallocate, the bond compute bind group was rebuilt — re-fetch it below.
        ensure_grid_capacity(grid_plan.n_cells, grid_plan.max_per_cell)

        // Reset the atomic counter + overflow flag, then repack Params (n,
        // capacity, and the grid block vary).
        device.queue.writeBuffer(count_buffer, 0, new Uint32Array([0]))
        device.queue.writeBuffer(overflow_buffer, 0, new Uint32Array([0]))
        device.queue.writeBuffer(
          bond_params_buffer, 0,
          pack_params(bond_n, bond_capacity, {
            tolerance: bond_options.tolerance,
            max_bond_dist: bond_options.max_bond_dist,
            min_dist: bond_options.min_dist,
            positions: new Float32Array(0), // unused by pack_params
            radii: new Float32Array(0), // unused by pack_params
            lattice: bond_lattice,
            periodic: bond_periodic,
            // rules drives Params.rule_count (rules.length / 4). Empty ⇒ 0 ⇒ the
            // shader's rules_keep returns early (no post-filter), identical to no
            // rules. The actual rule data lives in the binding-6 storage buffer.
            rules: bond_rules,
          }, grid_plan),
          0, PARAMS_BYTES,
        )
        const cpass = encoder.beginComputePass({ label: `large-system-bond-compute` })
        cpass.setBindGroup(0, bond_compute_bg as GPUBindGroup)
        // Grid path: clear the per-cell counts, then bin atoms, then detect. The
        // clear/bin passes are skipped on the fallback (detect ignores the grid).
        if (grid_plan.use_grid) {
          cpass.setPipeline(bond_clear_pipeline)
          cpass.dispatchWorkgroups(Math.max(1, Math.ceil(grid_plan.n_cells / 64)))
          cpass.setPipeline(bond_bin_pipeline)
          cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
        }
        cpass.setPipeline(bond_compute_pipeline)
        cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
        // Build draw-indirect args from the atomic count (no CPU readback).
        cpass.setPipeline(indirect_pipeline)
        cpass.setBindGroup(0, indirect_bg as GPUBindGroup)
        cpass.dispatchWorkgroups(1)
        cpass.end()
        bonds_dirty = false
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
        // ⇒ atom_count instances, identical to the non-supercell draw.
        pass.draw(4, atom_count * Math.max(1, supercell_ncells))
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
      pass.draw(22) // 6 axis verts (3 axes × 2) + 16 letter-glyph verts (8 segs × 2)
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    resize(w: number, h: number): void {
      if (destroyed) return
      canvas.width = Math.max(1, Math.floor(w))
      canvas.height = Math.max(1, Math.floor(h))
      ensure_targets(canvas.width, canvas.height)
      // Re-derive the corner gizmo placement for the new canvas size so it stays
      // a constant pixel size in the corner (not stretched by the aspect change).
      upload_gizmo_uniform()
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      try {
        context.unconfigure()
      } catch {
        // some implementations / already-lost contexts may throw — ignore
      }
      camera_buffer.destroy()
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
      pairs_buffer?.destroy()
      cell_count_buffer?.destroy()
      cell_atoms_buffer?.destroy()
      overflow_buffer.destroy()
      count_buffer.destroy()
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
      pairs_buffer = null
      cell_count_buffer = null
      cell_atoms_buffer = null
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
