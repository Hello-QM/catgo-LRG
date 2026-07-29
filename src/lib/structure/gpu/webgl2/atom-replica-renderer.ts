/**
 * WebGL2 atom replica impostors — the visual-supercell fast path (design §7.1
 * of docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md).
 *
 * One plain `THREE.Mesh` over an `InstancedBufferGeometry` draws
 * `N × nx·ny·nz` billboard sphere impostors:
 *
 * - Base attributes (site index / radius / color) stay N-sized and bind with
 *   divisor = cell count (`meshPerAttribute`), so each base atom's data feeds
 *   every one of its replicas without an N×cell-count copy. There is NO
 *   `instanceMatrix` — the legacy `InstancedMesh` path allocates one slot per
 *   drawn instance, which is exactly what this path exists to avoid.
 * - `gl_InstanceID % uCellCount` decodes the replica cell (x-fastest, then
 *   y, z — the T1 oracle's cell encoding); the vertex shader translates by
 *   `ix·a + iy·b + iz·c` from the CURRENT frame lattice held in a uniform.
 *   Variable-cell trajectories only ever touch that uniform — the lattice is
 *   never baked into attributes.
 * - `geometry.instanceCount = N × nx·ny·nz`. A replica-factor change updates
 *   the count, the divisor, and two uniforms; it reuses every typed array.
 * - Play / pause / scrub reuse the same geometry and material: atom and bond
 *   shaders fetch positions from one shared RGBA32F texture while the current
 *   lattice stays in a uniform. No mesh reconstruction or position VBO upload.
 * - The `ghost-images` boundary policy renders the T1 `ImageInstanceTable`
 *   as a sparse second draw (divisor-1 attributes, `table.count` instances).
 *
 * Divisor semantics force base-OUTER / cell-INNER instance order
 * (`instance = cell_index + cell_count · base_index`) — the transpose of the
 * atom-major WebGPU order. `decode_webgl2_instance` is the JS mirror of the
 * shader decode; tests pin its cell decode against the T1 oracle.
 *
 * Pure Three.js module — no Svelte imports. Mounted by
 * `WebGLReplicaLayer.svelte`.
 */

import * as THREE from 'three'
import {
  TOON_HIGHLIGHT_THRESHOLD,
  TOON_SHADOW_BRIGHTNESS,
  TOON_SHADOW_THRESHOLD,
  VISUAL_RADIUS_SCALE,
  style_pbr,
} from '../../rendering/visual-state'
import type {
  ImageInstanceTable,
  RenderPacket,
  RenderPacketDiff,
} from '../../scene/render-packet'
import { diff_render_packet } from '../../scene/render-packet'
import { build_image_instance_table } from '../../scene/replica-layout'
import { SharedPositionTexture } from './shared-position-texture'

export type ReplicaDims = readonly [number, number, number]

/** Product of the replica dims, each clamped to >= 1. */
export function cell_count_of(dims: ReplicaDims): number {
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const nz = dims[2] > 0 ? dims[2] : 1
  return nx * ny * nz
}

/** Decoded WebGL2 replica instance (base-outer / cell-inner order). */
export type Webgl2ReplicaInstance = {
  base_index: number
  cell_index: number
  cell: [number, number, number]
}

/**
 * JS mirror of the shader's `gl_InstanceID` decode. WebGL2 attribute divisors
 * advance a base attribute once every `cell_count` instances, so the base
 * index is `floor(instance / cell_count)` and the replica cell index is
 * `instance % cell_count` — decoded x-fastest, then y, z, exactly like the
 * T1 oracle's `decode_replica_instance` cell decode.
 */
export function decode_webgl2_instance(
  instance_index: number,
  dims: ReplicaDims,
  out?: Webgl2ReplicaInstance,
): Webgl2ReplicaInstance {
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const nz = dims[2] > 0 ? dims[2] : 1
  const cc = nx * ny * nz
  const cell_index = instance_index % cc
  const base_index = (instance_index - cell_index) / cc
  const ix = cell_index % nx
  const iy = Math.floor(cell_index / nx) % ny
  const iz = Math.floor(cell_index / (nx * ny))
  if (out) {
    out.base_index = base_index
    out.cell_index = cell_index
    out.cell[0] = ix
    out.cell[1] = iy
    out.cell[2] = iz
    return out
  }
  return { base_index, cell_index, cell: [ix, iy, iz] }
}

/**
 * Compatibility no-op — divisor changes rebind through attribute identity now.
 *
 * Three's WebGLBindingStates cache does NOT include `meshPerAttribute` in its
 * `needsUpdate()` identity check (r181, WebGLBindingStates.js:137-174), so an
 * in-place divisor mutation left the cached VAO stale. This hook used to force
 * a rebind with `WebGLRenderer.resetState()` from `onBeforeRender` — a
 * renderer-GLOBAL reset mid-frame that happened to work on Chrome/ANGLE but
 * vanished the whole draw on other GL stacks (desktop WebKitGTK: atoms
 * disappeared on every visual-supercell factor change until a remount).
 *
 * `ensure_instanced_attr` now REPLACES the attribute object on any divisor
 * change (same backing array), which `needsUpdate()` detects naturally — no
 * render-boundary work is ever required. Retained as an inert export because
 * BondReplicaRenderer and ReplicaIdPicker still wire it into `onBeforeRender`.
 */
export function rebind_instance_divisors_if_needed(
  _mesh: THREE.Mesh,
  _webgl_renderer: THREE.WebGLRenderer,
  _get_seen: () => number,
  _set_seen: (revision: number) => void,
): void {}

/**
 * Bind or update an instanced attribute on `geometry`.
 *
 * - Same array + same divisor → exact no-op (frame updates stay free).
 * - Anything else (new base buffer OR a divisor change) → install a FRESH
 *   attribute object. A fresh identity is the only change Three's
 *   binding-state cache reliably detects (`needsUpdate()` ignores
 *   `meshPerAttribute`), so the VAO is rebuilt naturally on the next draw —
 *   no mid-frame `resetState()` hack. The one-time re-upload this costs on a
 *   divisor change is base-sized (N floats) and factor changes are rare user
 *   actions, never per-frame work.
 */
export function ensure_instanced_attr(
  geometry: THREE.InstancedBufferGeometry,
  name: string,
  array: Float32Array | Int8Array | Uint8Array,
  item_size: number,
  divisor: number,
  dynamic = false,
): THREE.InstancedBufferAttribute {
  const existing = geometry.getAttribute(name) as
    | THREE.InstancedBufferAttribute
    | undefined
  if (
    existing !== undefined && existing.isInstancedBufferAttribute &&
    existing.array === array && existing.meshPerAttribute === divisor
  ) return existing
  const attr = new THREE.InstancedBufferAttribute(array, item_size, false, divisor)
  if (dynamic) attr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute(name, attr)
  // A fresh attribute identity makes Three rebuild the binding naturally.
  // Drop the derived draw clamp so the next binding-state setup recomputes it
  // from the new divisor (it is only computed while undefined).
  delete (geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount
  return attr
}

const SPARSE_GHOST_PAGE_CAPACITY = 256

function sparse_float_attr(
  item_size: number,
  dynamic = false,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(
    new Float32Array(SPARSE_GHOST_PAGE_CAPACITY * item_size),
    item_size,
    false,
    1,
  )
  if (dynamic) attr.setUsage(THREE.DynamicDrawUsage)
  // The typed array is fixed-capacity; count is the page's live logical span.
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

type AtomGhostPage = {
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  sites: THREE.InstancedBufferAttribute
  images: THREE.InstancedBufferAttribute
  radii: THREE.InstancedBufferAttribute
  colors: THREE.InstancedBufferAttribute
}

const EMPTY_TABLE: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

const ALL_CHANGED: RenderPacketDiff = {
  topology_changed: true,
  bond_graph_changed: true,
  frame_changed: true,
  replica_changed: true,
}

// Shared vertex tail: billboard expansion in view space (same recipe as the
// legacy AtomManagerInstances impostor — quad corner scaled by 1.05 to avoid
// grazing-angle clipping).
const VERTEX_TAIL = /* glsl */ `
  vQuadCoord = position.xy;
  vec4 view_center = modelViewMatrix * vec4(replica_pos, 1.0);
  vCenter = view_center.xyz;
  vec3 view_pos = view_center.xyz;
  view_pos.xy += position.xy * vRadius * 1.05;
  gl_Position = projectionMatrix * vec4(view_pos, 1.0);
`

const POSITION_TEXTURE_VERTEX = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform int uPosTexWidth;

  vec3 fetchBasePosition(float site) {
    int idx = int(site + 0.5);
    ivec2 uv = ivec2(idx % uPosTexWidth, idx / uPosTexWidth);
    return texelFetch(uPosTex, uv, 0).xyz;
  }
`

// Main replica draw: base attributes at divisor = cell count, replica cell
// decoded from gl_InstanceID, translation from the CURRENT lattice uniform
// (uLattice columns are the lattice rows a, b, c — Matrix3.fromArray of the
// row-major 9-float frame lattice).
const REPLICA_VERTEX_SHADER = /* glsl */ `
  attribute float instanceSite;
  attribute float instanceRadius;
  attribute vec3 instanceAtomColor;
  uniform mat3 uLattice;
  uniform ivec3 uDims;
  uniform int uCellCount;
  ${POSITION_TEXTURE_VERTEX}
  varying vec3 vCenter;
  varying float vRadius;
  varying vec3 vColor;
  varying vec2 vQuadCoord;

  void main() {
    int cell_index = gl_InstanceID % uCellCount;
    int ix = cell_index % uDims.x;
    int iy = (cell_index / uDims.x) % uDims.y;
    int iz = cell_index / (uDims.x * uDims.y);
    vec3 replica_pos = fetchBasePosition(instanceSite) +
      uLattice * vec3(float(ix), float(iy), float(iz));
    vColor = instanceAtomColor;
    vRadius = instanceRadius;
    ${VERTEX_TAIL}
  }
`

// Sparse ghost second draw: one instance per deduplicated (base_site, image)
// from the T1 ImageInstanceTable. The base position is copied per frame; the
// absolute image offset is static and translated by the SAME current-lattice
// uniform, so variable-cell frames stay correct.
const GHOST_VERTEX_SHADER = /* glsl */ `
  attribute float ghostBaseSite;
  attribute vec3 ghostImage;
  attribute float ghostRadius;
  attribute vec3 ghostColor;
  uniform mat3 uLattice;
  ${POSITION_TEXTURE_VERTEX}
  varying vec3 vCenter;
  varying float vRadius;
  varying vec3 vColor;
  varying vec2 vQuadCoord;

  void main() {
    vec3 replica_pos = fetchBasePosition(ghostBaseSite) + uLattice * ghostImage;
    vColor = ghostColor;
    vRadius = ghostRadius;
    ${VERTEX_TAIL}
  }
`

// Ray-sphere impostor fragment (GLSL3 — explicit fragColor output, analytic
// gl_FragDepth). The intersection uses the cross-product formulation copied
// from AtomManagerInstances: the algebraic form loses precision for large
// view-space centers (periodic replicas!) and shows concentric banding.
//
// Material styles (#533): the packet path must honor Appearance → Material
// exactly like the legacy InstancedMesh path, so the uRenderStyle branches
// (0 glossy/GGX, 1 matte, 2 toon, 3 matcap) are ported verbatim from
// AtomManagerInstances' fragment shader — same uniforms, same constants.
const FRAGMENT_SHADER = /* glsl */ `
  uniform bool uIsOrthographic;
  uniform vec3 uLightDir;
  uniform float uAmbientIntensity;
  uniform float uDirectionalIntensity;
  uniform float uOpacityScale;
  uniform int uRenderStyle;  // 0 = glossy, 1 = matte, 2 = toon, 3 = matcap
  uniform float uShadowThreshold;
  uniform float uHighlightThreshold;
  uniform float uShadowBrightness;
  uniform float uSpecStrength;
  uniform float uRoughness;
  uniform float uMetalness;
  uniform sampler2D uMatcap;
  uniform mat4 projectionMatrix;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec3 vColor;
  varying vec2 vQuadCoord;
  out vec4 fragColor;

  vec3 linear_to_srgb(vec3 linear) {
    return vec3(
      linear.r <= 0.0031308 ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0 / 2.4) - 0.055,
      linear.g <= 0.0031308 ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0 / 2.4) - 0.055,
      linear.b <= 0.0031308 ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0 / 2.4) - 0.055
    );
  }

  // ACES filmic tonemap — rolls off bright specular so glossy highlights read
  // soft/desaturated instead of hard clipped dots (legacy parity).
  vec3 aces_tonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 frag_view = vec3(vCenter.xy + vQuadCoord * vRadius * 1.05, vCenter.z);
    vec3 hit_pos;
    vec3 normal;
    float coverage = 1.0;

    if (uIsOrthographic) {
      vec2 offset = vQuadCoord * vRadius * 1.05;
      float d2 = dot(offset, offset);
      float r2 = vRadius * vRadius;
      float d = length(offset);
      coverage = clamp((vRadius - d) / fwidth(d) + 0.5, 0.0, 1.0);
      if (coverage <= 0.0) discard;
      float thc = sqrt(max(r2 - min(d2, r2), 0.0));
      hit_pos = vec3(vCenter.xy + offset, vCenter.z + thc);
      normal = vec3(offset, thc) / vRadius;
    } else {
      vec3 ray_dir = normalize(frag_view);
      vec3 cr = cross(vCenter, ray_dir);
      float d2 = dot(cr, cr);
      float r2 = vRadius * vRadius;
      float d = sqrt(d2);
      coverage = clamp((vRadius - d) / fwidth(d) + 0.5, 0.0, 1.0);
      if (coverage <= 0.0) discard;
      float tca = dot(vCenter, ray_dir);
      float thc = sqrt(max(r2 - min(d2, r2), 0.0));
      hit_pos = (tca - thc) * ray_dir;
      vec3 l_perp = vCenter - tca * ray_dir;
      normal = normalize(-thc * ray_dir - l_perp);
    }

    vec4 clip_pos = projectionMatrix * vec4(hit_pos, 1.0);
    gl_FragDepth = (clip_pos.z / clip_pos.w) * 0.5 + 0.5;

    vec3 light_dir = normalize(uLightDir);
    vec3 view_dir = uIsOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-hit_pos);
    vec3 base_color = vColor;

    vec3 color;
    if (uRenderStyle == 2) {
      // ── Toon: 3-band cel shading (legacy AtomManagerInstances parity) ──
      float diffuse = dot(normal, light_dir);
      if (diffuse > uHighlightThreshold) {
        color = vec3(1.0, 1.0, 1.0);
      } else if (diffuse > uShadowThreshold) {
        color = base_color;
      } else {
        color = base_color * uShadowBrightness;
      }
    } else if (uRenderStyle == 1) {
      // ── Matte: diffuse-only Lambert, no specular highlight ──
      float diffuse = max(dot(normal, light_dir), 0.0);
      color = base_color * (uAmbientIntensity + uDirectionalIntensity * diffuse);
    } else if (uRenderStyle == 3) {
      // ── MatCap: sample the baked studio sphere by the view-space normal,
      //    tinted by the element colour ──
      vec2 muv = normal.xy * 0.5 + 0.5;
      color = base_color * texture(uMatcap, muv).rgb;
    } else {
      // ── Glossy / Metallic: Cook-Torrance GGX (legacy parity — roughness /
      //    metalness are per-style, ACES rolls the key light back down) ──
      float rough = uRoughness;
      float a = rough * rough;
      float a2 = a * a;
      float NdotL = max(dot(normal, light_dir), 0.0);
      float NdotV = max(dot(normal, view_dir), 1e-4);
      vec3 half_dir = normalize(light_dir + view_dir);
      float NdotH = max(dot(normal, half_dir), 0.0);
      float VdotH = max(dot(view_dir, half_dir), 0.0);
      float dn = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
      float D = a2 / (3.14159265 * dn * dn);
      float k = a * 0.5;
      float G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
      vec3 F0 = mix(vec3(0.04), base_color, uMetalness);
      vec3 F = F0 + (vec3(1.0) - F0) * pow(1.0 - VdotH, 5.0);
      vec3 specular = (D * G) * F / (4.0 * NdotV * NdotL + 1e-4);
      vec3 diffuse_color = base_color * (1.0 - uMetalness);
      vec3 lit = diffuse_color * (uAmbientIntensity + uDirectionalIntensity * NdotL * 0.31831)
        + specular * uDirectionalIntensity * NdotL * uSpecStrength;
      lit *= mix(0.6, 1.0, smoothstep(0.0, 0.5, NdotV));
      color = aces_tonemap(lit);
    }
    fragColor = vec4(linear_to_srgb(color), uOpacityScale * coverage);
  }
`

export type AtomReplicaOptions = {
  positions?: SharedPositionTexture
  ambient_light?: number
  directional_light?: number
  /** Opacity multiplier for ghost-image atoms (sparse second draw). */
  ghost_opacity?: number
}

/** Configure real transparency for a material whose shader alpha includes an
 *  opacity uniform. Opaque draws use alpha-to-coverage for analytic edge AA;
 *  translucent draws use normal blending and disable depth writes/A2C to
 *  avoid double-applying coverage. */
export function set_material_opacity(
  material: THREE.ShaderMaterial,
  uniform_name: string,
  opacity: number,
): void {
  const value = Math.max(0, Math.min(1, opacity))
  material.uniforms[uniform_name].value = value
  const transparent = value < 1
  material.transparent = transparent
  material.depthWrite = !transparent
  material.alphaToCoverage = !transparent
}

export class AtomReplicaRenderer {
  readonly mesh: THREE.Mesh
  readonly ghost_mesh: THREE.Mesh
  readonly material: THREE.ShaderMaterial
  readonly ghost_material: THREE.ShaderMaterial

  #geometry = new THREE.InstancedBufferGeometry()
  #ghost_geometry = new THREE.InstancedBufferGeometry()
  #quad: THREE.PlaneGeometry
  #prev: RenderPacket | null = null
  #positions: SharedPositionTexture
  #release_positions: () => void
  #owns_positions: boolean

  // Base-sized CPU mirrors of topology-only instanced attributes.
  #sites = new Float32Array(0)
  #radii = new Float32Array(0)
  #colors = new Float32Array(0)

  #ghost_pages: AtomGhostPage[] = []

  constructor(options: AtomReplicaOptions = {}) {
    this.#owns_positions = options.positions === undefined
    this.#positions = options.positions ?? new SharedPositionTexture()
    this.#release_positions = this.#positions.register(`atom`)
    this.#quad = new THREE.PlaneGeometry(2, 2, 1, 1)
    for (const geometry of [this.#geometry, this.#ghost_geometry]) {
      geometry.setIndex(this.#quad.getIndex())
      geometry.setAttribute(`position`, this.#quad.getAttribute(`position`))
      geometry.instanceCount = 0
    }

    const default_pbr = style_pbr(`glossy`)
    const shared_uniforms = {
      uPosTex: { value: this.#positions.texture },
      uPosTexWidth: { value: this.#positions.texture.image.width },
      uLattice: { value: new THREE.Matrix3() },
      uIsOrthographic: { value: false },
      uLightDir: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
      uAmbientIntensity: { value: options.ambient_light ?? 0.7 },
      uDirectionalIntensity: { value: options.directional_light ?? 0.3 },
      // Material style (#533) — shared uniform OBJECTS so the main and ghost
      // draws switch styles together. Defaults mirror the legacy material
      // (glossy GGX at roughness 0.2 / metalness 0, toon thresholds from
      // AtomCanvas ToonHighlightMaterial).
      uRenderStyle: { value: 0 },
      uShadowThreshold: { value: TOON_SHADOW_THRESHOLD },
      uHighlightThreshold: { value: TOON_HIGHLIGHT_THRESHOLD },
      uShadowBrightness: { value: TOON_SHADOW_BRIGHTNESS },
      uSpecStrength: { value: 1 },
      uRoughness: { value: default_pbr.roughness },
      uMetalness: { value: default_pbr.metalness },
      uMatcap: { value: null as THREE.Texture | null },
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
        uOpacityScale: { value: 1 },
      },
    })

    this.ghost_material = new THREE.ShaderMaterial({
      vertexShader: GHOST_VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      uniforms: {
        // Shared uniform OBJECTS — one write updates both draws.
        ...shared_uniforms,
        uOpacityScale: { value: 1 },
      },
    })
    this.set_ghost_opacity(options.ghost_opacity ?? 1)

    this.mesh = new THREE.Mesh(this.#geometry, this.material)
    this.ghost_mesh = new THREE.Mesh(this.#ghost_geometry, this.ghost_material)
    this.#ghost_pages.push(
      this.#create_ghost_page(this.#ghost_geometry, this.ghost_mesh),
    )
    for (const mesh of [this.mesh, this.ghost_mesh]) {
      mesh.frustumCulled = false
      // Picking is a GPU ID pass (design §7.3), never a CPU quad raycast.
      mesh.raycast = () => {}
    }
    this.ghost_mesh.visible = false
  }

  /** Live ghost appearance update — no geometry/material reconstruction. */
  set_ghost_opacity(opacity: number): void {
    set_material_opacity(this.ghost_material, `uOpacityScale`, opacity)
  }

  /**
   * Appearance → Material for the packet path (#533). `style` is the shader
   * branch int (0 glossy/GGX, 1 matte, 2 toon, 3 matcap) with the per-style
   * GGX params; `matcap` is the baked studio-sphere texture (only sampled by
   * branch 3). Uniform-only writes on the SHARED objects — main + ghost draws
   * update together, no recompile, no material swap.
   */
  set_render_style(
    style: number,
    pbr: { roughness: number; metalness: number },
    matcap: THREE.Texture | null = null,
  ): void {
    this.material.uniforms.uRenderStyle.value = style
    this.material.uniforms.uRoughness.value = pbr.roughness
    this.material.uniforms.uMetalness.value = pbr.metalness
    if (matcap !== null || style === 3) this.material.uniforms.uMatcap.value = matcap
  }

  /** Glossy specular highlight multiplier (Appearance slider). */
  set_highlight_strength(strength: number): void {
    this.material.uniforms.uSpecStrength.value = strength
  }

  /** Apply a render packet. Minimal work per `diff_render_packet` category. */
  update(packet: RenderPacket): void {
    const prev = this.#prev
    this.#positions.update(packet.frame)
    this.material.uniforms.uPosTexWidth.value =
      this.#positions.texture.image.width
    // Capacity is ground truth: ANY atom-count change must take the full
    // rebuild path, even when packet versions were reused by an upstream
    // producer. Trusting versions alone let a grown frame `positions.set()`
    // into an undersized mirror (RangeError) and wedge the renderer with
    // stale 112-atom buffers — atoms vanished until a remount.
    const capacity_stale = this.#sites.length !== packet.topology.atom_count
    const diff = prev === null || capacity_stale
      ? ALL_CHANGED
      : diff_render_packet(prev, packet)
    const frame_identity_changed = prev === null || prev.frame !== packet.frame
    const lattice_changed = diff.topology_changed || diff.frame_changed ||
      frame_identity_changed
    if (diff.topology_changed) this.#rebuild_topology(packet)
    if (diff.topology_changed || diff.replica_changed) this.#apply_replicas(packet)
    if (lattice_changed) this.#upload_lattice(packet)

    const ghosts_changed = diff.topology_changed || diff.bond_graph_changed ||
      diff.replica_changed
    if (ghosts_changed) this.#rebuild_ghosts(packet)
    // Publish the installed identity only after every packet-owned resource,
    // including the current lattice and ghost topology, has completed.
    this.#prev = packet
  }

  installed_packet(): RenderPacket | null {
    return this.#prev
  }

  #rebuild_topology(packet: RenderPacket): void {
    const { atom_count: n, radii, colors } = packet.topology
    if (this.#sites.length !== n) {
      this.#sites = new Float32Array(n)
      this.#radii = new Float32Array(n)
      this.#colors = new Float32Array(n * 3)
    }
    const color_stride = colors.length === n * 4 ? 4 : 3
    for (let idx = 0; idx < n; idx++) {
      this.#sites[idx] = idx
      // Same on-screen size as the legacy instanced path (VISUAL_RADIUS_SCALE).
      this.#radii[idx] = radii[idx] * VISUAL_RADIUS_SCALE
      const src = idx * color_stride
      this.#colors[idx * 3] = colors[src]
      this.#colors[idx * 3 + 1] = colors[src + 1]
      this.#colors[idx * 3 + 2] = colors[src + 2]
    }
    const radius_attr = this.#geometry.getAttribute(`instanceRadius`)
    const color_attr = this.#geometry.getAttribute(`instanceAtomColor`)
    if (radius_attr) radius_attr.needsUpdate = true
    if (color_attr) color_attr.needsUpdate = true
  }

  #apply_replicas(packet: RenderPacket): void {
    const dims = packet.replicas.dims
    const cc = cell_count_of(dims)
    ensure_instanced_attr(this.#geometry, `instanceSite`, this.#sites, 1, cc)
    ensure_instanced_attr(this.#geometry, `instanceRadius`, this.#radii, 1, cc)
    ensure_instanced_attr(this.#geometry, `instanceAtomColor`, this.#colors, 3, cc)
    this.#geometry.instanceCount = packet.topology.atom_count * cc
    const dims_val = this.material.uniforms.uDims.value as Int32Array
    dims_val[0] = dims[0]
    dims_val[1] = dims[1]
    dims_val[2] = dims[2]
    this.material.uniforms.uCellCount.value = cc
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
  ): AtomGhostPage {
    const sites = sparse_float_attr(1)
    const images = sparse_float_attr(3)
    const radii = sparse_float_attr(1)
    const colors = sparse_float_attr(3)
    geometry.setAttribute(`ghostBaseSite`, sites)
    geometry.setAttribute(`ghostImage`, images)
    geometry.setAttribute(`ghostRadius`, radii)
    geometry.setAttribute(`ghostColor`, colors)
    return { mesh, geometry, sites, images, radii, colors }
  }

  #ensure_ghost_pages(count: number): void {
    const needed = Math.max(1, Math.ceil(count / SPARSE_GHOST_PAGE_CAPACITY))
    while (this.#ghost_pages.length < needed) {
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.setIndex(this.#quad.getIndex())
      geometry.setAttribute(`position`, this.#quad.getAttribute(`position`))
      geometry.instanceCount = 0
      const mesh = new THREE.Mesh(geometry, this.ghost_material)
      mesh.frustumCulled = false
      mesh.raycast = () => {}
      mesh.visible = false
      this.ghost_mesh.add(mesh)
      this.#ghost_pages.push(this.#create_ghost_page(geometry, mesh))
    }
  }

  #rebuild_ghosts(packet: RenderPacket): void {
    const graph = packet.topology.bond_graph
    const { dims, boundary_policy } = packet.replicas
    const table = graph !== undefined && boundary_policy === `ghost-images`
      ? build_image_instance_table(graph, dims, boundary_policy)
      : EMPTY_TABLE
    const count = table.count
    this.#ensure_ghost_pages(count)
    const { radii, colors, atom_count } = packet.topology
    const color_stride = colors.length === atom_count * 4 ? 4 : 3

    for (let page_idx = 0; page_idx < this.#ghost_pages.length; page_idx++) {
      const page = this.#ghost_pages[page_idx]
      const start = page_idx * SPARSE_GHOST_PAGE_CAPACITY
      const used = Math.max(0, Math.min(SPARSE_GHOST_PAGE_CAPACITY, count - start))
      const image = page.images.array as Float32Array
      const sites = page.sites.array as Float32Array
      const radius = page.radii.array as Float32Array
      const color = page.colors.array as Float32Array
      for (let local = 0; local < used; local++) {
        const idx = start + local
        const site = table.base_sites[idx]
        sites[local] = site
        image[local * 3] = table.jimages[idx * 3]
        image[local * 3 + 1] = table.jimages[idx * 3 + 1]
        image[local * 3 + 2] = table.jimages[idx * 3 + 2]
        radius[local] = radii[site] * VISUAL_RADIUS_SCALE
        const src = site * color_stride
        color[local * 3] = colors[src]
        color[local * 3 + 1] = colors[src + 1]
        color[local * 3 + 2] = colors[src + 2]
      }
      for (const attribute of [
        page.sites,
        page.images,
        page.radii,
        page.colors,
      ]) commit_sparse_attr(attribute, used)
      page.geometry.instanceCount = used
      delete (page.geometry as unknown as { _maxInstanceCount?: number })
        ._maxInstanceCount
      page.mesh.visible = used > 0
    }
  }

  dispose(): void {
    this.#geometry.dispose()
    for (const page of this.#ghost_pages) page.geometry.dispose()
    this.#quad.dispose()
    this.material.dispose()
    this.ghost_material.dispose()
    this.#release_positions()
    if (this.#owns_positions) this.#positions.dispose()
  }
}
