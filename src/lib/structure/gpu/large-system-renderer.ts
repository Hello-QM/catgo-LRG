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

/** Camera uniform (legacy 9.1): 20 floats (proj*view + camPos + pad) = 80 bytes. */
const CAMERA_UNIFORM_BYTES = 80

/** Camera uniform (9.2 impostor): view(16) + proj(16) + camPos vec3 + pad = 36
 *  floats = 144 bytes. Matches pack_camera_full's layout. */
const CAMERA_FULL_BYTES = 144

/** Bond Params uniform (BOND_COMPUTE_WGSL): 80 bytes, packed via pack_params. */
const BOND_PARAMS_BYTES = 80

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

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> radii : array<f32>;
@group(0) @binding(3) var<storage, read> colors : array<f32>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) vc : vec3<f32>,      // view-space sphere center
  @location(1) radius : f32,
  @location(2) color : vec3<f32>,
  @location(3) vpos : vec3<f32>,    // view-space position of this quad corner
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
  let center = vec3<f32>(
    positions[inst * 3u + 0u],
    positions[inst * 3u + 1u],
    positions[inst * 3u + 2u],
  );
  let r = radii[inst];
  let col = vec3<f32>(
    colors[inst * 3u + 0u],
    colors[inst * 3u + 1u],
    colors[inst * 3u + 2u],
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
  if (disc < 0.0) {
    discard;
  }
  let t = -b - sqrt(disc); // near hit
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

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  out.color = vec4<f32>(in.color * lighting, 1.0);
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

// uniforms: x = vertex_count_per_cylinder, y = capacity (clamp)
@group(0) @binding(2) var<uniform> cfg : vec2<u32>;

@compute @workgroup_size(1)
fn build_args() {
  let raw = count[0];
  let inst = min(raw, cfg.y);
  args.vertex_count = cfg.x;
  args.instance_count = inst * 2u; // two half-cylinders per bond
  args.first_vertex = 0u;
  args.first_instance = 0u;
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
 *  For intra-cell bonds (jimage = 0) partnerB = B and partnerA = A, so
 *  M0 = M1 = (A+B)/2 and the two halves join into a seamless full cylinder.
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

@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<storage, read> positions : array<f32>;
@group(0) @binding(2) var<storage, read> pairs : array<u32>;
@group(0) @binding(3) var<uniform> bond : BondU;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) v0 : vec3<f32>,      // view-space cylinder start (flat)
  @location(1) v1 : vec3<f32>,      // view-space cylinder end   (flat)
  @location(2) radius : f32,        // cylinder radius (flat)
  @location(3) color : vec3<f32>,
  @location(4) vpos : vec3<f32>,    // view-space position of this quad corner
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
  // Two half instances per bond: bond_index = inst>>1, half = inst&1.
  let bond_index = inst >> 1u;
  let half = inst & 1u;

  let a = pairs[bond_index*3u + 0u];
  let b = pairs[bond_index*3u + 1u];
  let jp = pairs[bond_index*3u + 2u];

  // Unpack jimage {-1,0,1} from (na+1)|((nb+1)<<2)|((nc+1)<<4).
  let na = f32(i32(jp & 3u) - 1);
  let nb = f32(i32((jp >> 2u) & 3u) - 1);
  let nc = f32(i32((jp >> 4u) & 3u) - 1);
  let shift = na * bond.lat0.xyz + nb * bond.lat1.xyz + nc * bond.lat2.xyz;

  let A = atom_pos(a);
  let B = atom_pos(b);
  // A's imaged partner is B + jimage·lattice; B's imaged partner is A - jimage·lattice.
  let partnerB = B + shift;
  let partnerA = A - shift;

  // half 0: A -> midpoint of (A, partnerB);  half 1: B -> midpoint of (B, partnerA).
  // Intra-cell (jimage=0): partnerB=B, partnerA=A => both midpoints = (A+B)/2,
  // so the two halves join into a seamless full cylinder.
  let start = select(B, A, half == 0u);
  let mid = select((B + partnerA) * 0.5, (A + partnerB) * 0.5, half == 0u);
  let end = mid;

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

  if (!found) { discard; }

  let light_dir = normalize(vec3<f32>(0.3, 0.5, 0.8));
  let lighting = 0.35 + 0.65 * max(dot(hit_n, light_dir), 0.0);

  // Correct depth: project the view-space hit point, apply the SAME GL->WebGPU z
  // remap as the vertex stage, then perspective-divide into NDC z (range 0..1).
  let clip_h = camera.proj * vec4<f32>(hit_p, 1.0);
  let remapped_z = (clip_h.z + clip_h.w) * 0.5;

  var out : FsOut;
  out.depth = clamp(remapped_z / clip_h.w, 0.0, 1.0);
  out.color = vec4<f32>(in.color * lighting, 1.0);
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
  /** Set the clear (background) color the render pass uses. `rgb` is LINEAR
   *  float [r,g,b] in the SAME space as the atom colors uploaded via set_atoms
   *  (so the background and atoms share one color space — dark atoms keep their
   *  contrast against the viewer's normal background). Alpha stays 1 (opaque). */
  set_background(rgb: [number, number, number]): void
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

  // Atom storage buffers — lazily (re)created when the atom count grows.
  let positions_buffer: GPUBuffer | null = null
  let radii_buffer: GPUBuffer | null = null
  let colors_buffer: GPUBuffer | null = null
  let atom_capacity = 0 // instances the current buffers can hold
  let atom_count = 0 // instances to draw this frame

  // Depth texture, sized to the canvas; recreated on resize.
  let depth_texture: GPUTexture | null = null
  let depth_view: GPUTextureView | null = null

  // Bind group depends on the storage buffers, so rebuild whenever they change.
  let bind_group: GPUBindGroup | null = null

  // ── Bond resources (milestone 9.3) ──────────────────────────────────────
  // Covalent radii (N) for bond detection — distinct from the display radii.
  let covalent_buffer: GPUBuffer | null = null
  let covalent_capacity = 0
  // GPU-resident bond outputs. `pairs` holds capacity*3 u32 (a,b,jimage); the
  // atomic count + indirect-args are tiny fixed buffers.
  let pairs_buffer: GPUBuffer | null = null
  let bond_capacity = 0 // pairs the current pairs buffer can hold
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
    size: BOND_PARAMS_BYTES,
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
  // Cached cell inputs (uploaded only when set_cell changes them).
  let cell_lattice = new Float32Array(9)
  let cell_show = false
  let cell_color: [number, number, number] = [0.5, 0.5, 0.5]
  // True once the lattice is non-zero (a periodic structure has been provided).
  let cell_has_lattice = false

  // cfg for the indirect-args build: (verts_per_cylinder, bond capacity). The
  // build shader clamps the bond count to capacity then doubles it, so the draw
  // issues instance_count = 2*min(count,capacity) (two half-cylinders per bond).
  const indirect_cfg_buffer = device.createBuffer({
    label: `large-system-indirect-cfg`,
    size: 8, // vec2<u32>
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  // Cached bond inputs, re-uploaded only when set_bond_data changes them.
  let bond_lattice = new Float32Array(9)
  let bond_options = { tolerance: 0, max_bond_dist: 0, min_dist: 0 }
  let bond_periodic = false
  let bond_n = 0 // atom count the detection should range over
  // True when the bond inputs (or atoms) changed and the compute must re-run.
  let bonds_dirty = false
  let bonds_configured = false // set once set_bond_data has provided inputs

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
  })

  // Bond-detect compute (the already-validated BOND_COMPUTE_WGSL). auto layout
  // matches bond-compute.ts: 0 positions, 1 radii, 2 params, 3 out_pairs,
  // 4 out_count.
  const bond_compute_module = device.createShaderModule({
    label: `large-system-bond-compute`,
    code: BOND_COMPUTE_WGSL,
  })
  const bond_compute_pipeline = device.createComputePipeline({
    label: `large-system-bond-compute-pipeline`,
    layout: `auto`,
    compute: { module: bond_compute_module, entryPoint: `detect_bonds` },
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
  })
  const cell_bind_group = device.createBindGroup({
    label: `large-system-cell-bg`,
    layout: cell_bgl,
    entries: [
      { binding: 0, resource: { buffer: camera_buffer } },
      { binding: 1, resource: { buffer: cell_uniform } },
    ],
  })

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

  // Static indirect-args cfg: (verts_per_cylinder, capacity) — capacity is
  // refreshed when the pairs buffer (re)allocates.
  function write_indirect_cfg(): void {
    device.queue.writeBuffer(
      indirect_cfg_buffer, 0,
      new Uint32Array([BOND_VERTS_PER_CYLINDER, bond_capacity]),
    )
  }

  function ensure_depth(w: number, h: number): void {
    depth_texture?.destroy()
    depth_texture = device.createTexture({
      label: `large-system-depth`,
      size: { width: Math.max(1, w), height: Math.max(1, h) },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    depth_view = depth_texture.createView()
  }
  ensure_depth(canvas.width || 1, canvas.height || 1)

  function rebuild_bind_group(): void {
    if (!positions_buffer || !radii_buffer || !colors_buffer) {
      bind_group = null
      return
    }
    bind_group = device.createBindGroup({
      label: `large-system-impostor-bg`,
      layout: bind_group_layout,
      entries: [
        { binding: 0, resource: { buffer: camera_buffer } },
        { binding: 1, resource: { buffer: positions_buffer } },
        { binding: 2, resource: { buffer: radii_buffer } },
        { binding: 3, resource: { buffer: colors_buffer } },
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

  /** (Re)build the three bond bind groups. Depends on positions_buffer (atom
   *  realloc), covalent_buffer, and pairs_buffer — any of which may reallocate.
   *  No-op until all are present. */
  function rebuild_bond_bind_groups(): void {
    bond_compute_bg = null
    indirect_bg = null
    bond_render_bg = null
    if (!positions_buffer || !covalent_buffer || !pairs_buffer) return

    bond_compute_bg = device.createBindGroup({
      label: `large-system-bond-compute-bg`,
      layout: bond_compute_pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: positions_buffer } },
        { binding: 1, resource: { buffer: covalent_buffer } },
        { binding: 2, resource: { buffer: bond_params_buffer } },
        { binding: 3, resource: { buffer: pairs_buffer } },
        { binding: 4, resource: { buffer: count_buffer } },
      ],
    })
    indirect_bg = device.createBindGroup({
      label: `large-system-indirect-bg`,
      layout: indirect_pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: count_buffer } },
        { binding: 1, resource: { buffer: indirect_buffer } },
        { binding: 2, resource: { buffer: indirect_cfg_buffer } },
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
      ],
    })
  }

  /** Pack + upload the bond render uniform: lattice columns (TRANSPOSED to match
   *  the compute's column layout) + (radius, color). */
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
    render(): void {
      if (destroyed) return
      if (!depth_view) ensure_depth(canvas.width || 1, canvas.height || 1)
      const encoder = device.createCommandEncoder({ label: `large-system-frame` })

      // Whether bonds are renderable this frame (inputs present + atoms).
      const bonds_ready =
        bonds_configured && atom_count > 0 && bond_n > 0 &&
        !!bond_compute_bg && !!indirect_bg && !!bond_render_bg && !!pairs_buffer

      // ── Bond compute (only when dirty) ───────────────────────────────────
      // Runs as a compute pass in THIS encoder, before the render pass, so the
      // pairs/indirect writes are visible to the bond draw in the same submit.
      // Cached by `bonds_dirty`: structure/option/atom changes flip it; a static
      // scene re-uses last frame's GPU-resident pairs with no recompute.
      if (bonds_ready && bonds_dirty) {
        // Reset the atomic counter, then repack Params (n, capacity vary).
        device.queue.writeBuffer(count_buffer, 0, new Uint32Array([0]))
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
          }),
          0, PARAMS_BYTES,
        )
        const cpass = encoder.beginComputePass({ label: `large-system-bond-compute` })
        cpass.setPipeline(bond_compute_pipeline)
        cpass.setBindGroup(0, bond_compute_bg as GPUBindGroup)
        cpass.dispatchWorkgroups(Math.max(1, Math.ceil(bond_n / 64)))
        // Build draw-indirect args from the atomic count (no CPU readback).
        cpass.setPipeline(indirect_pipeline)
        cpass.setBindGroup(0, indirect_bg as GPUBindGroup)
        cpass.dispatchWorkgroups(1)
        cpass.end()
        bonds_dirty = false
      }

      const view = context.getCurrentTexture().createView()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
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
        pass.draw(4, atom_count) // triangle-strip quad, one instance per atom
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
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    resize(w: number, h: number): void {
      if (destroyed) return
      canvas.width = Math.max(1, Math.floor(w))
      canvas.height = Math.max(1, Math.floor(h))
      ensure_depth(canvas.width, canvas.height)
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
      depth_texture?.destroy()
      // Bond resources.
      covalent_buffer?.destroy()
      pairs_buffer?.destroy()
      count_buffer.destroy()
      indirect_buffer.destroy()
      bond_params_buffer.destroy()
      bond_render_uniform.destroy()
      cell_uniform.destroy()
      indirect_cfg_buffer.destroy()
      positions_buffer = null
      radii_buffer = null
      colors_buffer = null
      covalent_buffer = null
      pairs_buffer = null
      depth_texture = null
      depth_view = null
      bind_group = null
      bond_compute_bg = null
      indirect_bg = null
      bond_render_bg = null
    },
  }
}
