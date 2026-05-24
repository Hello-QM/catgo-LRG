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

/** Radial segments of the procedural cylinder. The side wall is a closed
 *  triangle-strip: 2 verts per segment boundary, (SEG+1) boundaries. */
const BOND_SEGMENTS = 12
const BOND_VERTS_PER_CYLINDER = (BOND_SEGMENTS + 1) * 2

/** Fixed bond cylinder radius (Å). Small constant; tunable. Uploaded to the
 *  bond render shader as part of its uniform so it can be retuned without a
 *  shader edit. */
const BOND_RADIUS = 0.16

/** Neutral bond color (linear rgb). Half-A/half-B coloring is a later milestone. */
const BOND_COLOR: [number, number, number] = [0.7, 0.7, 0.7]

/** A distinct dark background so flipping the toggle visibly swaps which canvas
 *  paints. Near-black with a faint blue tint. */
const CLEAR_COLOR: GPUColor = { r: 0.02, g: 0.03, b: 0.05, a: 1 }

const DEPTH_FORMAT: GPUTextureFormat = `depth24plus`

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

/** Instanced procedural-cylinder bond shader. Each detected bond renders as TWO
 *  half-cylinder instances that meet at the bond midpoint, so PBC (cross-cell)
 *  bonds become two short stubs each rooted at a REAL atom instead of one long
 *  cylinder jutting out of the cell. Instance mapping: bond_index = inst>>1,
 *  half = inst&1. Per bond reads (a, b, jimage_packed) from the pairs buffer
 *  (unchanged — one entry per bond); the imaged partner is shifted by
 *  jimage·lattice using the SAME lattice the compute used.
 *    Let A = pos[a], partnerB = pos[b] + jimage·lattice (A's imaged partner),
 *        B = pos[b], partnerA = pos[a] - jimage·lattice (B's imaged partner).
 *    half 0: cylinder A      -> M0 = (A + partnerB) * 0.5
 *    half 1: cylinder B      -> M1 = (B + partnerA) * 0.5
 *  For intra-cell bonds (jimage = 0) partnerB = B and partnerA = A, so
 *  M0 = M1 = (A+B)/2 and the two halves join into a seamless full cylinder.
 *  Verts trace a unit side-wall triangle-strip oriented to the half's axis and
 *  scaled to span start→end with a fixed radius. Depth uses the SAME GL→WebGPU
 *  clip-z remap as the atom impostor so bonds share the depth buffer and occlude
 *  / are occluded correctly. */
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
  @location(0) vnormal : vec3<f32>, // view-space surface normal for shading
  @location(1) color : vec3<f32>,
};

const SEG : u32 = ${BOND_SEGMENTS}u;
const PI2 : f32 = 6.28318530718;

fn atom_pos(i : u32) -> vec3<f32> {
  return vec3<f32>(positions[i*3u], positions[i*3u+1u], positions[i*3u+2u]);
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32,
           @builtin(instance_index) inst : u32) -> VsOut {
  // Two half-cylinder instances per bond: bond_index = inst>>1, half = inst&1.
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

  // Orthonormal basis around this half's axis start->end.
  let axis = end - start;
  let len = length(axis);
  let dir = select(vec3<f32>(0.0, 0.0, 1.0), axis / max(len, 1e-6), len > 1e-6);
  let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(dir.y) > 0.9);
  let tangent = normalize(cross(up, dir));
  let bitangent = cross(dir, tangent);

  // Side-wall triangle-strip: pairs of (bottom, top) ring verts.
  let seg = vi >> 1u;             // 0..SEG
  let is_top = (vi & 1u) == 1u;   // alternate bottom/top
  let ang = f32(seg) / f32(SEG) * PI2;
  let radial = cos(ang) * tangent + sin(ang) * bitangent;
  let base = select(start, end, is_top);
  let world = base + radial * bond.radius_color.x;

  let vpos4 = camera.view * vec4<f32>(world, 1.0);
  var clip = camera.proj * vpos4;
  // SAME GL->WebGPU NDC z remap as the atom impostor shader.
  clip.z = (clip.z + clip.w) * 0.5;

  // View-space normal for lambert shading (radial direction in view space).
  let vn4 = camera.view * vec4<f32>(radial, 0.0);

  var out : VsOut;
  out.clip = clip;
  out.vnormal = normalize(vn4.xyz);
  out.color = bond.radius_color.yzw;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let light_dir = normalize(vec3<f32>(0.3, 0.5, 0.8));
  let lighting = 0.35 + 0.65 * max(dot(normalize(in.vnormal), light_dir), 0.0);
  return vec4<f32>(in.color * lighting, 1.0);
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
  context.configure({ device, format, alphaMode: `premultiplied` })

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
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: `uniform` } },
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
    // Closed side-wall strip; cull nothing so thin cylinders never vanish.
    primitive: { topology: `triangle-strip`, cullMode: `none` },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: `less`,
    },
  })

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

  return {
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
            clearValue: CLEAR_COLOR,
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
