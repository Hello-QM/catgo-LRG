/**
 * WebGL2 atom replica impostors — the visual-supercell fast path (design §7.1
 * of docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md).
 *
 * One plain `THREE.Mesh` over an `InstancedBufferGeometry` draws
 * `N × nx·ny·nz` billboard sphere impostors:
 *
 * - Base attributes (position / radius / color) stay N-sized and bind with
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
 * - Play / pause / scrub reuse the same geometry and material: a frame update
 *   rewrites the base position buffer in place plus the lattice uniform. No
 *   mesh reconstruction, no impostor/mesh switching.
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
import { VISUAL_RADIUS_SCALE } from '../../atoms/atom-instanced-renderer'
import type {
  ImageInstanceTable,
  RenderPacket,
  RenderPacketDiff,
} from '../../scene/render-packet'
import { diff_render_packet } from '../../scene/render-packet'
import { build_image_instance_table } from '../../scene/replica-layout'

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
 * (Re)bind an instanced attribute on `geometry`. Reuses the existing
 * attribute object when both the backing array identity and the divisor are
 * unchanged; otherwise swaps in a fresh `InstancedBufferAttribute` sharing
 * the given array. The swap on divisor change is deliberate: three's binding
 * state caches the vertex-attrib divisor per attribute OBJECT, so mutating
 * `meshPerAttribute` in place would leave a stale GL divisor.
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
  ) {
    existing.needsUpdate = true
    return existing
  }
  const attr = new THREE.InstancedBufferAttribute(array, item_size, false, divisor)
  if (dynamic) attr.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute(name, attr)
  // three caches `_maxInstanceCount` from the first instanced attribute it
  // sees — clear it so a divisor / size change can never clamp the draw.
  delete (geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount
  return attr
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

// Main replica draw: base attributes at divisor = cell count, replica cell
// decoded from gl_InstanceID, translation from the CURRENT lattice uniform
// (uLattice columns are the lattice rows a, b, c — Matrix3.fromArray of the
// row-major 9-float frame lattice).
const REPLICA_VERTEX_SHADER = /* glsl */ `
  attribute vec3 instancePosition;
  attribute float instanceRadius;
  attribute vec3 instanceAtomColor;
  uniform mat3 uLattice;
  uniform ivec3 uDims;
  uniform int uCellCount;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec3 vColor;
  varying vec2 vQuadCoord;

  void main() {
    int cell_index = gl_InstanceID % uCellCount;
    int ix = cell_index % uDims.x;
    int iy = (cell_index / uDims.x) % uDims.y;
    int iz = cell_index / (uDims.x * uDims.y);
    vec3 replica_pos = instancePosition +
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
  attribute vec3 ghostPosition;
  attribute vec3 ghostImage;
  attribute float ghostRadius;
  attribute vec3 ghostColor;
  uniform mat3 uLattice;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec3 vColor;
  varying vec2 vQuadCoord;

  void main() {
    vec3 replica_pos = ghostPosition + uLattice * ghostImage;
    vColor = ghostColor;
    vRadius = ghostRadius;
    ${VERTEX_TAIL}
  }
`

// Ray-sphere impostor fragment (GLSL3 — explicit fragColor output, analytic
// gl_FragDepth). The intersection uses the cross-product formulation copied
// from AtomManagerInstances: the algebraic form loses precision for large
// view-space centers (periodic replicas!) and shows concentric banding.
const FRAGMENT_SHADER = /* glsl */ `
  uniform bool uIsOrthographic;
  uniform vec3 uLightDir;
  uniform float uAmbientIntensity;
  uniform float uDirectionalIntensity;
  uniform float uOpacityScale;
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
    float diffuse = max(dot(normal, light_dir), 0.0);
    vec3 half_dir = normalize(light_dir + view_dir);
    float spec = pow(max(dot(normal, half_dir), 0.0), 48.0);
    vec3 color = vColor * (uAmbientIntensity + uDirectionalIntensity * diffuse) +
      vec3(0.5) * spec * uDirectionalIntensity;
    fragColor = vec4(linear_to_srgb(color), uOpacityScale * coverage);
  }
`

export type AtomReplicaOptions = {
  ambient_light?: number
  directional_light?: number
  /** Opacity multiplier for ghost-image atoms (sparse second draw). */
  ghost_opacity?: number
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

  // Base-sized CPU mirrors of the instanced attributes (N / 3N floats).
  #positions = new Float32Array(0)
  #radii = new Float32Array(0)
  #colors = new Float32Array(0)

  #ghost_table: ImageInstanceTable = EMPTY_TABLE
  #ghost_positions = new Float32Array(0)
  #ghost_images = new Float32Array(0)
  #ghost_radii = new Float32Array(0)
  #ghost_colors = new Float32Array(0)

  constructor(options: AtomReplicaOptions = {}) {
    this.#quad = new THREE.PlaneGeometry(2, 2, 1, 1)
    for (const geometry of [this.#geometry, this.#ghost_geometry]) {
      geometry.setIndex(this.#quad.getIndex())
      geometry.setAttribute(`position`, this.#quad.getAttribute(`position`))
      geometry.instanceCount = 0
    }

    const shared_uniforms = {
      uLattice: { value: new THREE.Matrix3() },
      uIsOrthographic: { value: false },
      uLightDir: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
      uAmbientIntensity: { value: options.ambient_light ?? 0.7 },
      uDirectionalIntensity: { value: options.directional_light ?? 0.3 },
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
      transparent: true,
      depthWrite: true,
      uniforms: {
        // Shared uniform OBJECTS — one write updates both draws.
        ...shared_uniforms,
        uOpacityScale: { value: options.ghost_opacity ?? 1 },
      },
    })

    this.mesh = new THREE.Mesh(this.#geometry, this.material)
    this.ghost_mesh = new THREE.Mesh(this.#ghost_geometry, this.ghost_material)
    for (const mesh of [this.mesh, this.ghost_mesh]) {
      mesh.frustumCulled = false
      // Picking is a GPU ID pass (design §7.3), never a CPU quad raycast.
      mesh.raycast = () => {}
    }
    this.ghost_mesh.visible = false
  }

  /** Apply a render packet. Minimal work per `diff_render_packet` category. */
  update(packet: RenderPacket): void {
    const prev = this.#prev
    const diff = prev === null ? ALL_CHANGED : diff_render_packet(prev, packet)
    this.#prev = packet

    if (diff.topology_changed) this.#rebuild_topology(packet)
    if (diff.topology_changed || diff.replica_changed) this.#apply_replicas(packet)
    if (diff.topology_changed || diff.frame_changed) this.#upload_frame(packet)

    const ghosts_changed = diff.topology_changed || diff.bond_graph_changed ||
      diff.replica_changed
    if (ghosts_changed) this.#rebuild_ghosts(packet)
    if (ghosts_changed || diff.frame_changed) this.#upload_ghost_positions(packet)
  }

  #rebuild_topology(packet: RenderPacket): void {
    const { atom_count: n, radii, colors } = packet.topology
    if (this.#positions.length !== n * 3) {
      this.#positions = new Float32Array(n * 3)
      this.#radii = new Float32Array(n)
      this.#colors = new Float32Array(n * 3)
    }
    const color_stride = colors.length === n * 4 ? 4 : 3
    for (let idx = 0; idx < n; idx++) {
      // Same on-screen size as the legacy instanced path (VISUAL_RADIUS_SCALE).
      this.#radii[idx] = radii[idx] * VISUAL_RADIUS_SCALE
      const src = idx * color_stride
      this.#colors[idx * 3] = colors[src]
      this.#colors[idx * 3 + 1] = colors[src + 1]
      this.#colors[idx * 3 + 2] = colors[src + 2]
    }
  }

  #apply_replicas(packet: RenderPacket): void {
    const dims = packet.replicas.dims
    const cc = cell_count_of(dims)
    ensure_instanced_attr(this.#geometry, `instancePosition`, this.#positions, 3, cc, true)
    ensure_instanced_attr(this.#geometry, `instanceRadius`, this.#radii, 1, cc)
    ensure_instanced_attr(this.#geometry, `instanceAtomColor`, this.#colors, 3, cc)
    this.#geometry.instanceCount = packet.topology.atom_count * cc
    const dims_val = this.material.uniforms.uDims.value as Int32Array
    dims_val[0] = dims[0]
    dims_val[1] = dims[1]
    dims_val[2] = dims[2]
    this.material.uniforms.uCellCount.value = cc
  }

  #upload_frame(packet: RenderPacket): void {
    this.#positions.set(packet.frame.positions)
    const attr = this.#geometry.getAttribute(`instancePosition`)
    if (attr) attr.needsUpdate = true
    // CURRENT frame lattice — the only thing a variable-cell frame touches.
    const lattice = this.material.uniforms.uLattice.value as THREE.Matrix3
    lattice.fromArray(packet.frame.lattice as unknown as number[])
  }

  #rebuild_ghosts(packet: RenderPacket): void {
    const graph = packet.topology.bond_graph
    const { dims, boundary_policy } = packet.replicas
    const table = graph !== undefined && boundary_policy === `ghost-images`
      ? build_image_instance_table(graph, dims, boundary_policy)
      : EMPTY_TABLE
    this.#ghost_table = table
    const count = table.count
    if (this.#ghost_radii.length !== count) {
      this.#ghost_positions = new Float32Array(count * 3)
      this.#ghost_images = new Float32Array(count * 3)
      this.#ghost_radii = new Float32Array(count)
      this.#ghost_colors = new Float32Array(count * 3)
    }
    const { radii, colors, atom_count } = packet.topology
    const color_stride = colors.length === atom_count * 4 ? 4 : 3
    for (let idx = 0; idx < count; idx++) {
      const site = table.base_sites[idx]
      this.#ghost_images[idx * 3] = table.jimages[idx * 3]
      this.#ghost_images[idx * 3 + 1] = table.jimages[idx * 3 + 1]
      this.#ghost_images[idx * 3 + 2] = table.jimages[idx * 3 + 2]
      this.#ghost_radii[idx] = radii[site] * VISUAL_RADIUS_SCALE
      const src = site * color_stride
      this.#ghost_colors[idx * 3] = colors[src]
      this.#ghost_colors[idx * 3 + 1] = colors[src + 1]
      this.#ghost_colors[idx * 3 + 2] = colors[src + 2]
    }
    const geometry = this.#ghost_geometry
    ensure_instanced_attr(geometry, `ghostPosition`, this.#ghost_positions, 3, 1, true)
    ensure_instanced_attr(geometry, `ghostImage`, this.#ghost_images, 3, 1)
    ensure_instanced_attr(geometry, `ghostRadius`, this.#ghost_radii, 1, 1)
    ensure_instanced_attr(geometry, `ghostColor`, this.#ghost_colors, 3, 1)
    geometry.instanceCount = count
    this.ghost_mesh.visible = count > 0
  }

  #upload_ghost_positions(packet: RenderPacket): void {
    const table = this.#ghost_table
    if (table.count === 0) return
    const positions = packet.frame.positions
    for (let idx = 0; idx < table.count; idx++) {
      const site = table.base_sites[idx] * 3
      this.#ghost_positions[idx * 3] = positions[site]
      this.#ghost_positions[idx * 3 + 1] = positions[site + 1]
      this.#ghost_positions[idx * 3 + 2] = positions[site + 2]
    }
    const attr = this.#ghost_geometry.getAttribute(`ghostPosition`)
    if (attr) attr.needsUpdate = true
  }

  dispose(): void {
    this.#geometry.dispose()
    this.#ghost_geometry.dispose()
    this.#quad.dispose()
    this.material.dispose()
    this.ghost_material.dispose()
  }
}
