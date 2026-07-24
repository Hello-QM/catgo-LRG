/**
 * WebGL2 bond replica impostors — flat ray-cylinder half-bonds over one base
 * bond graph (design §7.2 of
 * docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md).
 *
 * One plain `THREE.Mesh` over an `InstancedBufferGeometry` draws
 * `2B × nx·ny·nz` half-bond impostors from 2B-sized per-half attributes
 * (divisor = cell count) — no `instanceMatrix`, no CPU matrix compose:
 *
 * - `gl_InstanceID % uCellCount` decodes the replica cell; endpoint positions
 *   come from a base-sized RGBA32F texture (one texel per base atom,
 *   refreshed per frame); the CURRENT frame lattice lives in `uLattice`.
 * - Per replica the shader evaluates `cell + jimage` for the anchored half:
 *   inside → complete half to the midpoint; outside + `stub` → the
 *   configured incomplete edge; outside + `hide` → collapse; outside +
 *   `ghost-images` → the A half draws the complete geometry toward the ghost
 *   image while the ghost-side half comes from the sparse SECOND draw
 *   (`ghost_mesh`, divisor-1 attributes, one instance per oracle 'ghost'
 *   probe). `classify_half_draw` is the JS mirror of that branch — tests pin
 *   it against the T1 oracle `resolve_periodic_edge`.
 * - Periodic self-image edges (`a === b`, jimage ≠ 0) are valid and are never
 *   filtered — single-atom primitive cells only have such bonds.
 * - The impostor is Task-2-style: a unit OBB (BoxGeometry corners in
 *   [-1, 1]³) mapped onto each half-bond in the vertex stage; the fragment
 *   stage ray-casts the true cylinder (flat per-instance frame varyings,
 *   analytic gl_FragDepth, coverage AA).
 *
 * Pure Three.js module — no Svelte imports. Mounted by
 * `WebGLReplicaLayer.svelte`.
 */

import * as THREE from 'three'
import type {
  BaseBondGraph,
  BoundaryPolicy,
  RenderPacket,
  RenderPacketDiff,
} from '../../scene/render-packet'
import { diff_render_packet } from '../../scene/render-packet'
import type { PeriodicBond, ResolvedEdgeState } from '../../scene/replica-layout'
import { resolve_periodic_edge } from '../../scene/replica-layout'
import {
  cell_count_of,
  ensure_instanced_attr,
  rebind_instance_divisors_if_needed,
  set_material_opacity,
  type ReplicaDims,
} from './atom-replica-renderer'
import { SharedPositionTexture } from './shared-position-texture'
import { trajectory_render_diagnostics } from '../../trajectory-render-diagnostics'

/** Shader-side boundary-policy codes (uPolicy). */
export const BOUNDARY_POLICY_CODE: Record<BoundaryPolicy, number> = {
  stub: 0,
  hide: 1,
  'ghost-images': 2,
}

export type HalfDrawKind = 'complete' | 'stub' | 'ghost' | 'omit'

/**
 * JS mirror of the vertex shader's per-replica half classification. Written
 * independently of the T1 oracle so the tests can pin the two against each
 * other:
 *
 * - half 0 (anchored at A, in `cell`) probes `cell + jimage` — exactly
 *   `resolve_periodic_edge`, kind for kind.
 * - half 1 (anchored at B, in `cell`) probes `cell - jimage` for the image
 *   of A it completes. Inside → the complementary half of the complete bond
 *   drawn by half 0 of cell − jimage. Outside → `stub` draws the paired
 *   stub, `hide` collapses, and `ghost-images` ALSO collapses: the T1 image
 *   table only ghosts endpoint-B images (`build_image_instance_table`), so
 *   there is no A-side ghost to bond to.
 */
export function classify_half_draw(
  bond: PeriodicBond,
  cell: ReplicaDims,
  dims: ReplicaDims,
  policy: BoundaryPolicy,
  half: 0 | 1,
): HalfDrawKind {
  const sign = half === 0 ? 1 : -1
  const px = cell[0] + sign * bond.jimage[0]
  const py = cell[1] + sign * bond.jimage[1]
  const pz = cell[2] + sign * bond.jimage[2]
  const inside = px >= 0 && px < dims[0] && py >= 0 && py < dims[1] &&
    pz >= 0 && pz < dims[2]
  if (inside) return 'complete'
  if (policy === 'stub') return 'stub'
  if (policy === 'hide') return 'omit'
  return half === 0 ? 'ghost' : 'omit'
}

/** Sparse ghost-side half-bond table: one entry per (bond, cell) probe the
 *  T1 oracle resolves to 'ghost'. NOT deduplicated (unlike ghost atoms) —
 *  each probe needs its own half toward the shared ghost image. */
export type GhostHalfTable = {
  count: number
  /** 2 × count — (a, b) base endpoint indices. */
  sites: Float32Array
  /** 3 × count — the bond's jimage. */
  jimages: Float32Array
  /** 3 × count — the A endpoint's replica cell. */
  cells: Float32Array
}

const EMPTY_GHOST_TABLE: GhostHalfTable = {
  count: 0,
  sites: new Float32Array(0),
  jimages: new Float32Array(0),
  cells: new Float32Array(0),
}

const SPARSE_GHOST_PAGE_CAPACITY = 256

function sparse_float_attr(item_size: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(
    new Float32Array(SPARSE_GHOST_PAGE_CAPACITY * item_size),
    item_size,
    false,
    1,
  )
  ;(attr as unknown as { count: number }).count = 0
  return attr
}

function commit_sparse_attr(
  attr: THREE.InstancedBufferAttribute,
  count: number,
): void {
  ;(attr as unknown as { count: number }).count = count
  attr.clearUpdateRanges()
  if (count > 0) attr.addUpdateRange(0, count * attr.itemSize)
  attr.needsUpdate = true
}

type BondGhostPage = {
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  sites: THREE.InstancedBufferAttribute
  jimages: THREE.InstancedBufferAttribute
  cells: THREE.InstancedBufferAttribute
  colors: THREE.InstancedBufferAttribute
}

/** Enumerate ghost-side halves through the REAL T1 oracle (allocation-lean
 *  out-record form of `resolve_periodic_edge`). */
export function build_ghost_half_table(
  bond_graph: BaseBondGraph,
  dims: ReplicaDims,
  policy: BoundaryPolicy,
): GhostHalfTable {
  if (policy !== 'ghost-images') return EMPTY_GHOST_TABLE
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const nz = dims[2] > 0 ? dims[2] : 1
  const bond_count = bond_graph.pairs.length / 2
  const sites: number[] = []
  const jimages: number[] = []
  const cells: number[] = []
  const jimage: [number, number, number] = [0, 0, 0]
  const bond: PeriodicBond = { a: 0, b: 0, jimage }
  const cell: [number, number, number] = [0, 0, 0]
  const state: ResolvedEdgeState = {
    kind: 'omit',
    a_cell: [0, 0, 0],
    b_cell: [0, 0, 0],
    ghost: false,
  }
  for (let bi = 0; bi < bond_count; bi++) {
    bond.a = bond_graph.pairs[bi * 2]
    bond.b = bond_graph.pairs[bi * 2 + 1]
    jimage[0] = bond_graph.jimages[bi * 3]
    jimage[1] = bond_graph.jimages[bi * 3 + 1]
    jimage[2] = bond_graph.jimages[bi * 3 + 2]
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          cell[0] = ix
          cell[1] = iy
          cell[2] = iz
          resolve_periodic_edge(bond, cell, dims, policy, state)
          if (state.kind !== 'ghost') continue
          sites.push(bond.a, bond.b)
          jimages.push(jimage[0], jimage[1], jimage[2])
          cells.push(ix, iy, iz)
        }
      }
    }
  }
  return {
    count: sites.length / 2,
    sites: Float32Array.from(sites),
    jimages: Float32Array.from(jimages),
    cells: Float32Array.from(cells),
  }
}

const ALL_CHANGED: RenderPacketDiff = {
  topology_changed: true,
  bond_graph_changed: true,
  frame_changed: true,
  replica_changed: true,
}

// Shared vertex declarations for both draws.
const VERTEX_COMMON = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform int uPosTexWidth;
  uniform mat3 uLattice;
  uniform float uBondRadius;
  varying vec3 vColor;
  flat varying vec3 vImpBase;
  flat varying vec3 vImpAxis;
  flat varying float vImpRadiusSq;
  flat varying float vImpLen;
  flat varying float vImpCollapse;

  vec3 fetchBasePosition(float site) {
    int idx = int(site + 0.5);
    ivec2 uv = ivec2(idx % uPosTexWidth, idx / uPosTexWidth);
    return texelFetch(uPosTex, uv, 0).xyz;
  }
`

// Shared vertex tail: map the unit OBB (position in [-1,1]^3) onto the
// half-cylinder anchor→tip and hand the view-space frame to the ray-cast.
// Expects `anchor`, `tip`, `collapse` from the head.
const VERTEX_TAIL = /* glsl */ `
  vec3 seg = tip - anchor;
  float seg_len = length(seg);
  collapse = collapse || !(seg_len > 1e-6);
  vImpCollapse = collapse ? 1.0 : 0.0;
  if (collapse) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // off-screen (clipped)
    vImpBase = vec3(0.0);
    vImpAxis = vec3(0.0, 0.0, 1.0);
    vImpRadiusSq = 0.0;
    vImpLen = 0.0;
    return;
  }
  vec3 dir = seg / seg_len;
  vec3 ref = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 xb = normalize(cross(ref, dir));
  vec3 zb = cross(xb, dir);
  float pad = uBondRadius * 1.3; // AA shell; the ray-cast uses the true radius
  float za = position.z * 0.5 + 0.5;
  vec3 corner = anchor + xb * (position.x * pad) + zb * (position.y * pad) +
    dir * (za * seg_len);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(corner, 1.0);
  vImpBase = (modelViewMatrix * vec4(anchor, 1.0)).xyz;
  vImpAxis = (modelViewMatrix * vec4(seg, 0.0)).xyz;
  vImpLen = length(vImpAxis);
  float view_r = uBondRadius * length(modelViewMatrix[0].xyz);
  vImpRadiusSq = view_r * view_r;
`

// Main replica draw: per-half base attributes at divisor = cell count;
// gl_InstanceID decodes the replica cell; the boundary policy is evaluated
// per (half, cell) exactly like classify_half_draw / resolve_periodic_edge.
const REPLICA_VERTEX_SHADER = /* glsl */ `
  attribute vec2 a_site;
  attribute vec3 a_jimage;
  attribute float a_half;
  attribute vec3 a_color;
  uniform ivec3 uDims;
  uniform int uCellCount;
  uniform int uPolicy;     // 0 stub, 1 hide, 2 ghost-images
  uniform float uStubScale;
  ${VERTEX_COMMON}

  void main() {
    int cell_index = gl_InstanceID % uCellCount;
    ivec3 cell = ivec3(
      cell_index % uDims.x,
      (cell_index / uDims.x) % uDims.y,
      cell_index / (uDims.x * uDims.y)
    );
    vec3 pa = fetchBasePosition(a_site.x);
    vec3 pb = fetchBasePosition(a_site.y);
    ivec3 jimage = ivec3(round(a_jimage));
    bool is_b_half = a_half > 0.5;
    // Anchor endpoint lives in THIS replica cell; the partner sits at
    // cell + jimage (half A) / cell - jimage (half B).
    ivec3 probe = is_b_half ? cell - jimage : cell + jimage;
    bool inside = all(greaterThanEqual(probe, ivec3(0))) &&
      all(lessThan(probe, uDims));
    vec3 anchor = (is_b_half ? pb : pa) + uLattice * vec3(cell);
    vec3 partner = (is_b_half ? pa : pb) + uLattice * vec3(probe);
    // inside -> complete half to the midpoint. Outside: stub draws the
    // configured incomplete edge; hide collapses; ghost-images draws the A
    // half complete toward the ghost image and collapses the B half (the
    // ghost-side half is the sparse second draw).
    bool collapse = !inside && (uPolicy == 1 || (uPolicy == 2 && is_b_half));
    vec3 d = partner - anchor;
    vec3 tip = anchor + d * 0.5;
    if (!inside && uPolicy == 0) tip = anchor + d * (0.5 * uStubScale);
    vColor = a_color;
    ${VERTEX_TAIL}
  }
`

// Sparse ghost second draw: one instance per (bond, cell) oracle 'ghost'
// probe — the half anchored at the ghost image of endpoint B, meeting the
// main draw's A half at the midpoint. Positions come from the SAME base
// texture; the ghost image translates through the SAME current-lattice
// uniform, so variable-cell frames stay correct with zero table rebuilds.
const GHOST_VERTEX_SHADER = /* glsl */ `
  attribute vec2 g_site;
  attribute vec3 g_jimage;
  attribute vec3 g_cell;
  attribute vec3 g_color;
  ${VERTEX_COMMON}

  void main() {
    vec3 pa = fetchBasePosition(g_site.x) +
      uLattice * g_cell;
    vec3 pb = fetchBasePosition(g_site.y) +
      uLattice * (g_cell + g_jimage);
    vec3 anchor = pb;
    vec3 tip = 0.5 * (pa + pb);
    bool collapse = false;
    vColor = g_color;
    ${VERTEX_TAIL}
  }
`

// Flat ray-cylinder impostor fragment (GLSL3): rebuild the view ray from the
// inverse projection, cast against the half-cylinder frame (flat varyings),
// write analytic gl_FragDepth, silhouette/cap coverage AA. The intersection
// math is the proven recipe from the trajectory bond-impostor path.
/**
 * Ray-cylinder intersection adapted from OVITO Basic
 * commit 0b2cdccef7452bf28212e15daf9df2dc7a545bcc.
 * Copyright 2026 OVITO GmbH, Germany. Used under the MIT option.
 * Full permission notice and CatGo modifications: THIRD_PARTY_NOTICES.md.
 */
const FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uLightDir;
  uniform float uAmbientIntensity;
  uniform float uDirectionalIntensity;
  uniform mat4 projectionMatrix;
  uniform mat4 uInvProjection;
  uniform vec4 uViewport;
  varying vec3 vColor;
  flat varying vec3 vImpBase;
  flat varying vec3 vImpAxis;
  flat varying float vImpRadiusSq;
  flat varying float vImpLen;
  flat varying float vImpCollapse;
  out vec4 fragColor;

  vec3 linear_to_srgb(vec3 linear) {
    return vec3(
      linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0 / 2.4) - 0.055,
      linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0 / 2.4) - 0.055,
      linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0 / 2.4) - 0.055
    );
  }

  void main() {
    if (vImpCollapse > 0.5) discard;

    vec2 ndc = ((gl_FragCoord.xy - uViewport.xy) / uViewport.zw) * 2.0 - 1.0;
    vec4 near = uInvProjection * vec4(ndc, -1.0, 1.0);
    vec4 far = near + uInvProjection[2];
    vec3 ray_origin = near.xyz / near.w;
    vec3 rd = normalize(far.xyz / far.w - ray_origin);

    vec3 A = vImpAxis;
    vec3 B = vImpBase;
    float len2 = vImpLen * vImpLen;
    float r = sqrt(vImpRadiusSq);

    vec3 n = cross(rd, A);
    float ln = length(n);
    vec3 RC = ray_origin - B;
    vec3 hit;
    vec3 nrm;
    float coverage = 1.0;
    float axial = 0.0;

    if (ln < 1e-7 * vImpLen) {
      float t = dot(RC, rd);
      float v = dot(RC, RC);
      if (v - t * t > vImpRadiusSq) discard;
      hit = ray_origin - t * rd;
      nrm = -A;
    } else {
      n /= ln;
      float dd = dot(RC, n);
      dd *= dd;
      float pd = sqrt(dd);
      coverage = clamp((r - pd) / max(fwidth(pd), 1e-6) + 0.5, 0.0, 1.0);
      if (coverage <= 0.0) discard;
      float dc = min(dd, vImpRadiusSq);
      float t = dot(cross(A, RC), n) / ln;
      float s = abs(sqrt(vImpRadiusSq - dc) / dot(cross(n, A), rd) * vImpLen);
      float tnear = t - s;
      hit = ray_origin + tnear * rd;
      float anear = dot(hit - B, A) / len2;
      if (anear >= 0.0 && anear <= 1.0) {
        nrm = hit - (B + anear * A);
        axial = anear;
      } else {
        float tfar = t + s;
        vec3 farp = ray_origin + tfar * rd;
        float afar = dot(farp - B, A) / len2;
        if (anear < 0.0 && afar > 0.0) {
          hit = ray_origin + (tnear + (anear / (anear - afar)) * 2.0 * s) * rd;
          nrm = -A;
        } else if (anear > 1.0 && afar < 1.0) {
          hit = ray_origin + (tnear + ((anear - 1.0) / (anear - afar)) * 2.0 * s) * rd;
          nrm = A;
          axial = 1.0;
        } else discard;
      }
    }

    nrm = normalize(nrm);
    // Cap coverage from the hit's radial distance (side wall used ray-axis).
    if (abs(dot(nrm, normalize(A))) > 0.9) {
      vec3 rad = (hit - B) - A * (dot(hit - B, A) / len2);
      float pdc = length(rad);
      coverage = clamp((r - pdc) / max(fwidth(pdc), 1e-6) + 0.5, 0.0, 1.0);
    }

    vec4 proj = projectionMatrix * vec4(hit, 1.0);
    float dz = (proj.z / proj.w + 1.0) * 0.5;
    if (dz < 0.0 || dz > 1.0) discard;
    gl_FragDepth = dz;

    vec3 light_dir = normalize(uLightDir);
    vec3 view_dir = normalize(-hit);
    float diffuse = max(dot(nrm, light_dir), 0.0);
    vec3 half_dir = normalize(light_dir + view_dir);
    float spec = pow(max(dot(nrm, half_dir), 0.0), 48.0);
    vec3 color = vColor * (uAmbientIntensity + uDirectionalIntensity * diffuse) +
      vec3(0.4) * spec * uDirectionalIntensity;
    fragColor = vec4(linear_to_srgb(color), uOpacity * coverage);
  }
`

export type BondReplicaOptions = {
  positions?: SharedPositionTexture
  bond_radius?: number
  /** Stub length multiplier for the 'stub' boundary policy (VESTA 0.5). */
  stub_scale?: number
  ambient_light?: number
  directional_light?: number
  /** Opacity for the main replica bond draw. */
  opacity?: number
  /** Opacity for ghost-side halves (sparse second draw). */
  ghost_opacity?: number
}

export class BondReplicaRenderer {
  readonly mesh: THREE.Mesh
  readonly ghost_mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  readonly ghost_material: THREE.ShaderMaterial

  #geometry = new THREE.InstancedBufferGeometry()
  #ghost_geometry = new THREE.InstancedBufferGeometry()
  #box: THREE.BoxGeometry
  #prev: RenderPacket | null = null
  #positions: SharedPositionTexture
  #release_positions: () => void
  #owns_positions: boolean

  // Per-half base attributes — capacity-sized CPU mirrors, grow-only.
  // MD playback changes the bond count nearly every frame; reallocating these
  // per count change re-installed 4 fresh attributes per frame, which cost a
  // VAO rebuild + 4 new GL buffers (the old ones were never deleted) + full
  // capacity-size uploads on every played frame (#534). The live span is
  // `#half_count`; `instanceCount` and update ranges cover only that prefix,
  // so a bond-count change is an in-place rewrite on stable identities.
  #half_capacity = 0
  #half_count = 0
  #sites = new Float32Array(0)
  #jimages = new Int8Array(0)
  #halves = new Float32Array(0)
  #colors = new Float32Array(0)

  // Fixed-capacity sparse pages retain every attribute/backing buffer identity;
  // growth appends pages instead of replacing live VBO resources.
  #ghost_pages: BondGhostPage[] = []
  #ghost_before_render!: THREE.Object3D[`onBeforeRender`]

  constructor(options: BondReplicaOptions = {}) {
    this.#owns_positions = options.positions === undefined
    this.#positions = options.positions ?? new SharedPositionTexture()
    this.#release_positions = this.#positions.register(`bond`)
    this.#box = new THREE.BoxGeometry(2, 2, 2)
    for (const geometry of [this.#geometry, this.#ghost_geometry]) {
      geometry.setIndex(this.#box.getIndex())
      geometry.setAttribute(`position`, this.#box.getAttribute(`position`))
      geometry.instanceCount = 0
    }

    const shared_uniforms = {
      uPosTex: { value: this.#positions.texture },
      uPosTexWidth: { value: this.#positions.texture.image.width },
      uLattice: { value: new THREE.Matrix3() },
      uBondRadius: { value: options.bond_radius ?? 0.15 },
      uLightDir: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
      uAmbientIntensity: { value: options.ambient_light ?? 0.8 },
      uDirectionalIntensity: { value: options.directional_light ?? 0.3 },
      uInvProjection: { value: new THREE.Matrix4() },
      uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: REPLICA_VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      transparent: false,
      depthWrite: true,
      alphaToCoverage: true,
      uniforms: {
        ...shared_uniforms,
        uDims: { value: new Int32Array([1, 1, 1]) },
        uCellCount: { value: 1 },
        uPolicy: { value: BOUNDARY_POLICY_CODE.stub },
        uStubScale: { value: options.stub_scale ?? 0.5 },
        uOpacity: { value: 1 },
      },
    })
    this.set_opacity(options.opacity ?? 1)

    this.ghost_material = new THREE.ShaderMaterial({
      vertexShader: GHOST_VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      uniforms: {
        // Shared uniform OBJECTS — one write updates both draws.
        ...shared_uniforms,
        uOpacity: { value: 1 },
      },
    })
    this.set_ghost_opacity(options.ghost_opacity ?? 1)

    this.mesh = new THREE.Mesh(this.#geometry, this.material)
    this.ghost_mesh = new THREE.Mesh(this.#ghost_geometry, this.ghost_material)
    this.#ghost_pages.push(
      this.#create_ghost_page(this.#ghost_geometry, this.ghost_mesh),
    )
    // Camera projection can change while the packet stays static (notably
    // orthographic wheel zoom). Capture the active pass viewport at the main
    // draw boundary before a divisor reset can replace Three's bookkeeping
    // viewport with the render-target default. Ghost pages in the same pass
    // reuse that captured viewport so every fragment ray matches the raw GL
    // viewport restored by the reset helper.
    const pass_viewport = new THREE.Vector4(0, 0, 1, 1)
    let seen_divisor_revision = 0
    const refresh_view: THREE.Object3D[`onBeforeRender`] = (
      _webgl_renderer,
      _scene,
      camera,
    ) => {
      this.set_view(
        camera.projectionMatrixInverse,
        pass_viewport.x,
        pass_viewport.y,
        pass_viewport.z,
        pass_viewport.w,
      )
    }
    this.mesh.onBeforeRender = (
      webgl_renderer,
      scene,
      camera,
      geometry,
      material,
      group,
    ) => {
      webgl_renderer.getCurrentViewport(pass_viewport)
      rebind_instance_divisors_if_needed(
        this.mesh,
        webgl_renderer,
        () => seen_divisor_revision,
        (revision) => seen_divisor_revision = revision,
      )
      refresh_view(webgl_renderer, scene, camera, geometry, material, group)
    }
    this.#ghost_before_render = refresh_view
    this.ghost_mesh.onBeforeRender = refresh_view
    for (const mesh of [this.mesh, this.ghost_mesh]) {
      mesh.frustumCulled = false
      // Picking is a GPU ID pass (design §7.3), never a CPU box raycast.
      mesh.raycast = () => {}
    }
    this.ghost_mesh.visible = false
  }

  /** Apply a render packet. Minimal work per `diff_render_packet` category. */
  update(packet: RenderPacket): void {
    const prev = this.#prev
    this.#positions.update(packet.frame)
    this.material.uniforms.uPosTexWidth.value =
      this.#positions.texture.image.width
    const diff = prev === null ? ALL_CHANGED : diff_render_packet(prev, packet)
    const frame_identity_changed = prev === null || prev.frame !== packet.frame
    const lattice_changed = diff.topology_changed || diff.frame_changed ||
      frame_identity_changed
    this.#prev = packet

    const graph_changed = diff.topology_changed || diff.bond_graph_changed
    let topology_upload_bytes = 0
    if (graph_changed) {
      topology_upload_bytes += this.#rebuild_half_attrs(packet)
    }
    if (graph_changed || diff.replica_changed) this.#apply_replicas(packet)
    if (lattice_changed) this.#upload_lattice(packet)
    if (graph_changed || diff.replica_changed) {
      topology_upload_bytes += this.#rebuild_ghosts(packet)
    }
    if (topology_upload_bytes > 0) {
      trajectory_render_diagnostics.record_topology_upload(
        topology_upload_bytes,
      )
    }
  }

  /** Per-frame camera state for the fragment ray-cast (inverse projection +
   *  drawing-buffer size). Shared by both draws. */
  set_view(
    inv_projection: THREE.Matrix4,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    ;(this.material.uniforms.uInvProjection.value as THREE.Matrix4)
      .copy(inv_projection)
    ;(this.material.uniforms.uViewport.value as THREE.Vector4)
      .set(x, y, width, height)
  }

  set_bond_radius(radius: number): void {
    this.material.uniforms.uBondRadius.value = radius
  }

  set_stub_scale(scale: number): void {
    this.material.uniforms.uStubScale.value = scale
  }

  set_opacity(opacity: number): void {
    set_material_opacity(this.material, `uOpacity`, opacity)
  }

  set_ghost_opacity(opacity: number): void {
    set_material_opacity(this.ghost_material, `uOpacity`, opacity)
  }

  #rebuild_half_attrs(packet: RenderPacket): number {
    const graph = packet.topology.bond_graph
    const bond_count = graph !== undefined ? graph.pairs.length / 2 : 0
    const half_count = bond_count * 2
    if (half_count > this.#half_capacity) {
      // Grow-only ×1.5: a fresh attribute install (and its one-time VAO
      // rebuild + full upload) happens O(log growth) times, never per frame.
      this.#half_capacity = Math.max(
        half_count,
        Math.ceil(this.#half_capacity * 1.5),
      )
      this.#sites = new Float32Array(this.#half_capacity * 2)
      this.#jimages = new Int8Array(this.#half_capacity * 3)
      this.#halves = new Float32Array(this.#half_capacity)
      this.#colors = new Float32Array(this.#half_capacity * 3)
    }
    this.#half_count = half_count
    if (graph === undefined || half_count === 0) return 0
    const { colors, atom_count } = packet.topology
    const color_stride = colors.length === atom_count * 4 ? 4 : 3
    for (let bi = 0; bi < bond_count; bi++) {
      const a = graph.pairs[bi * 2]
      const b = graph.pairs[bi * 2 + 1]
      const i0 = bi * 2
      const i1 = i0 + 1
      this.#sites[i0 * 2] = a
      this.#sites[i0 * 2 + 1] = b
      this.#sites[i1 * 2] = a
      this.#sites[i1 * 2 + 1] = b
      const ji = bi * 3
      for (let k = 0; k < 3; k++) {
        this.#jimages[i0 * 3 + k] = graph.jimages[ji + k]
        this.#jimages[i1 * 3 + k] = graph.jimages[ji + k]
      }
      this.#halves[i0] = 0
      this.#halves[i1] = 1
      // Solid per-half color from the anchor atom (hard mid-split convention).
      const ca = a * color_stride
      const cb = b * color_stride
      for (let k = 0; k < 3; k++) {
        this.#colors[i0 * 3 + k] = colors[ca + k]
        this.#colors[i1 * 3 + k] = colors[cb + k]
      }
    }
    for (const name of [`a_site`, `a_jimage`, `a_half`, `a_color`]) {
      const attribute = this.#geometry.getAttribute(name) as
        | THREE.InstancedBufferAttribute
        | undefined
      if (!attribute) continue
      // Upload only the live prefix. Add WITHOUT clearing: three consumes and
      // clears ranges at draw time and merges overlaps, so multiple syncs
      // between draws accumulate safely (#532 contract).
      attribute.addUpdateRange(0, half_count * attribute.itemSize)
      attribute.needsUpdate = true
    }
    // Bytes in the live prefixes scheduled above: two float site indices,
    // three signed-byte image offsets, one float half selector, and RGB.
    return half_count * (2 * 4 + 3 + 4 + 3 * 4)
  }

  #apply_replicas(packet: RenderPacket): void {
    const dims = packet.replicas.dims
    const cc = cell_count_of(dims)
    ensure_instanced_attr(this.#geometry, `a_site`, this.#sites, 2, cc, true)
    ensure_instanced_attr(this.#geometry, `a_jimage`, this.#jimages, 3, cc, true)
    ensure_instanced_attr(this.#geometry, `a_half`, this.#halves, 1, cc, true)
    ensure_instanced_attr(this.#geometry, `a_color`, this.#colors, 3, cc, true)
    this.#geometry.instanceCount = this.#half_count * cc
    const dims_val = this.material.uniforms.uDims.value as Int32Array
    dims_val[0] = dims[0]
    dims_val[1] = dims[1]
    dims_val[2] = dims[2]
    this.material.uniforms.uCellCount.value = cc
    this.material.uniforms.uPolicy.value =
      BOUNDARY_POLICY_CODE[packet.replicas.boundary_policy]
  }

  #upload_lattice(packet: RenderPacket): void {
    // A same-index variable-cell update can replace only FrameGeometry.lattice.
    // Keep this independent from positions_version so the CURRENT cell always
    // reaches both the main and shared-uniform ghost draw.
    const lattice = this.material.uniforms.uLattice.value as THREE.Matrix3
    lattice.fromArray(packet.frame.lattice as unknown as number[])
  }

  #create_ghost_page(
    geometry: THREE.InstancedBufferGeometry,
    mesh: THREE.Mesh,
  ): BondGhostPage {
    const sites = sparse_float_attr(2)
    const jimages = sparse_float_attr(3)
    const cells = sparse_float_attr(3)
    const colors = sparse_float_attr(3)
    geometry.setAttribute(`g_site`, sites)
    geometry.setAttribute(`g_jimage`, jimages)
    geometry.setAttribute(`g_cell`, cells)
    geometry.setAttribute(`g_color`, colors)
    return { mesh, geometry, sites, jimages, cells, colors }
  }

  #ensure_ghost_pages(count: number): void {
    const needed = Math.max(1, Math.ceil(count / SPARSE_GHOST_PAGE_CAPACITY))
    while (this.#ghost_pages.length < needed) {
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.setIndex(this.#box.getIndex())
      geometry.setAttribute(`position`, this.#box.getAttribute(`position`))
      geometry.instanceCount = 0
      const mesh = new THREE.Mesh(geometry, this.ghost_material)
      mesh.frustumCulled = false
      mesh.onBeforeRender = this.#ghost_before_render
      mesh.raycast = () => {}
      mesh.visible = false
      this.ghost_mesh.add(mesh)
      this.#ghost_pages.push(this.#create_ghost_page(geometry, mesh))
    }
  }

  #rebuild_ghosts(packet: RenderPacket): number {
    const graph = packet.topology.bond_graph
    const { dims, boundary_policy } = packet.replicas
    const table = graph !== undefined
      ? build_ghost_half_table(graph, dims, boundary_policy)
      : EMPTY_GHOST_TABLE
    const count = table.count
    this.#ensure_ghost_pages(count)
    const { colors, atom_count } = packet.topology
    const color_stride = colors.length === atom_count * 4 ? 4 : 3

    for (let page_idx = 0; page_idx < this.#ghost_pages.length; page_idx++) {
      const page = this.#ghost_pages[page_idx]
      const start = page_idx * SPARSE_GHOST_PAGE_CAPACITY
      const used = Math.max(0, Math.min(SPARSE_GHOST_PAGE_CAPACITY, count - start))
      const sites = page.sites.array as Float32Array
      const jimages = page.jimages.array as Float32Array
      const cells = page.cells.array as Float32Array
      const page_colors = page.colors.array as Float32Array
      for (let local = 0; local < used; local++) {
        const idx = start + local
        sites[local * 2] = table.sites[idx * 2]
        sites[local * 2 + 1] = table.sites[idx * 2 + 1]
        for (let axis = 0; axis < 3; axis++) {
          jimages[local * 3 + axis] = table.jimages[idx * 3 + axis]
          cells[local * 3 + axis] = table.cells[idx * 3 + axis]
        }
        // Ghost-side half is anchored at endpoint B's image → B's color.
        const src = table.sites[idx * 2 + 1] * color_stride
        page_colors[local * 3] = colors[src]
        page_colors[local * 3 + 1] = colors[src + 1]
        page_colors[local * 3 + 2] = colors[src + 2]
      }
      for (const attribute of [
        page.sites,
        page.jimages,
        page.cells,
        page.colors,
      ]) commit_sparse_attr(attribute, used)
      page.geometry.instanceCount = used
      delete (page.geometry as unknown as { _maxInstanceCount?: number })
        ._maxInstanceCount
      page.mesh.visible = used > 0
    }
    // Every live ghost prefix updates 11 Float32 values across four buffers.
    return count * 11 * Float32Array.BYTES_PER_ELEMENT
  }

  dispose(): void {
    this.#geometry.dispose()
    for (const page of this.#ghost_pages) page.geometry.dispose()
    this.#box.dispose()
    this.material.dispose()
    this.ghost_material.dispose()
    this.#release_positions()
    if (this.#owns_positions) this.#positions.dispose()
  }
}
