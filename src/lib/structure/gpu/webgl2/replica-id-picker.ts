/**
 * Collision-free uint32 IDs for replica GPU picking.
 *
 * The integer render target stores one scalar ID. Zero is the clear value/miss;
 * real atom instances, bond instances, and sparse ghost instances occupy three
 * disjoint contiguous ranges. The codec stores only scalar range metadata. It
 * never constructs per-instance matrices, colors, or CPU hitbox objects.
 *
 * `ReplicaPickScene` (below) is the WebGL2 integer GPU ID pass over that
 * codec: base-sized divisor attributes replicate in the vertex shader exactly
 * like the visual replica renderers, the fragment writes the encoded ID into
 * a 1×1 RGBA8 target, and the CPU decodes one readback pixel. No per-replica
 * CPU expansion, no invisible hitbox meshes.
 */

import * as THREE from 'three'
import type {
  ImageInstanceTable,
  RenderPacket,
  ReplicaLayout,
  ReplicaPickResult,
  ReplicaSemantics,
} from '$lib/structure/scene/render-packet'
import { diff_render_packet } from '$lib/structure/scene/render-packet'
import {
  build_image_instance_table,
  decode_replica_instance,
  logical_site_for_pick,
} from '$lib/structure/scene/replica-layout'
import {
  render_pick_pixel,
  type PickPixelRenderer,
} from '$lib/structure/gpu-picker'
import { VISUAL_RADIUS_SCALE } from '$lib/structure/atoms/atom-instanced-renderer'
import {
  ensure_instanced_attr,
  rebind_instance_divisors_if_needed,
} from './atom-replica-renderer'
import { BOUNDARY_POLICY_CODE } from './bond-replica-renderer'
import { SharedPositionTexture } from './shared-position-texture'

export const REPLICA_PICK_MISS_ID = 0
export const REPLICA_PICK_MAX_ID = 0xffff_ffff

export type ReplicaIdCodecOptions = {
  base_atom_count: number
  base_bond_count: number
  replicas: ReplicaLayout
  ghost_count: number
}

/** Scalar-only range metadata suitable for an R32UI-style render target. */
export type ReplicaIdCodec = Readonly<{
  base_atom_count: number
  base_bond_count: number
  replica_count: number
  ghost_count: number
  atom_instance_count: number
  bond_instance_count: number
  atom_first_id: number
  bond_first_id: number
  ghost_first_id: number
  max_id: number
  dim_x: number
  dim_y: number
  dim_z: number
  semantics: ReplicaSemantics
}>

function assert_uint32_count(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > REPLICA_PICK_MAX_ID) {
    throw new RangeError(
      `replica ID codec: ${name} must be an integer in [0, ` +
        `${REPLICA_PICK_MAX_ID}], got ${value}`,
    )
  }
}

function assert_replica_dims(
  dims: readonly [number, number, number],
): [number, number, number, number] {
  const [nx, ny, nz] = dims
  if (
    !Number.isInteger(nx) || !Number.isInteger(ny) || !Number.isInteger(nz) ||
    nx < 1 || ny < 1 || nz < 1
  ) {
    throw new RangeError(
      `replica ID codec: replica dims must be positive integers, got ` +
        `[${nx}, ${ny}, ${nz}]`,
    )
  }
  const replica_count = nx * ny * nz
  if (!Number.isSafeInteger(replica_count) || replica_count > REPLICA_PICK_MAX_ID) {
    throw new RangeError(
      `replica ID codec: replica dims exceed uint32 capacity, got ` +
        `[${nx}, ${ny}, ${nz}]`,
    )
  }
  return [nx, ny, nz, replica_count]
}

function checked_instance_count(
  label: string,
  base_count: number,
  replica_count: number,
): number {
  const count = base_count * replica_count
  if (!Number.isSafeInteger(count) || count > REPLICA_PICK_MAX_ID) {
    throw new RangeError(
      `replica ID codec: ${label} instance count exceeds uint32 capacity`,
    )
  }
  return count
}

/**
 * Build constant-size range metadata. Capacity includes the reserved zero miss
 * ID, so the number of encoded instances may be at most 2^32 - 1.
 */
export function create_replica_id_codec(
  options: ReplicaIdCodecOptions,
): ReplicaIdCodec {
  const { base_atom_count, base_bond_count, replicas, ghost_count } = options
  assert_uint32_count('base_atom_count', base_atom_count)
  assert_uint32_count('base_bond_count', base_bond_count)
  assert_uint32_count('ghost_count', ghost_count)

  const [dim_x, dim_y, dim_z, replica_count] = assert_replica_dims(replicas.dims)
  const atom_instance_count = checked_instance_count(
    'atom',
    base_atom_count,
    replica_count,
  )
  const bond_instance_count = checked_instance_count(
    'bond',
    base_bond_count,
    replica_count,
  )

  if (replicas.semantics === 'physical-distinct-sites') {
    const expected = atom_instance_count
    if (!replicas.physical_site_map || replicas.physical_site_map.length !== expected) {
      throw new RangeError(
        `replica ID codec: physical_site_map length must equal atom instance ` +
          `count (${expected})`,
      )
    }
  } else if (replicas.physical_site_map !== undefined) {
    throw new RangeError(
      `replica ID codec: visual-shared-base must not carry a physical_site_map`,
    )
  }

  const total = atom_instance_count + bond_instance_count + ghost_count
  if (!Number.isSafeInteger(total) || total > REPLICA_PICK_MAX_ID) {
    throw new RangeError(
      `replica ID codec: encoded picks exceed uint32 capacity ` +
        `(${total} > ${REPLICA_PICK_MAX_ID})`,
    )
  }

  const atom_first_id = 1
  const bond_first_id = atom_first_id + atom_instance_count
  const ghost_first_id = bond_first_id + bond_instance_count
  return Object.freeze({
    base_atom_count,
    base_bond_count,
    replica_count,
    ghost_count,
    atom_instance_count,
    bond_instance_count,
    atom_first_id,
    bond_first_id,
    ghost_first_id,
    max_id: total,
    dim_x,
    dim_y,
    dim_z,
    semantics: replicas.semantics,
  })
}

function encode_range_id(
  label: string,
  first_id: number,
  count: number,
  instance_index: number,
): number {
  if (!Number.isInteger(instance_index) || instance_index < 0 || instance_index >= count) {
    throw new RangeError(
      `replica ID codec: ${label} instance index ${instance_index} is outside ` +
        `[0, ${count})`,
    )
  }
  return first_id + instance_index
}

export function encode_replica_atom_id(
  codec: ReplicaIdCodec,
  instance_index: number,
): number {
  return encode_range_id(
    'atom',
    codec.atom_first_id,
    codec.atom_instance_count,
    instance_index,
  )
}

export function encode_replica_bond_id(
  codec: ReplicaIdCodec,
  instance_index: number,
): number {
  return encode_range_id(
    'bond',
    codec.bond_first_id,
    codec.bond_instance_count,
    instance_index,
  )
}

export function encode_replica_ghost_id(
  codec: ReplicaIdCodec,
  ghost_index: number,
): number {
  return encode_range_id('ghost', codec.ghost_first_id, codec.ghost_count, ghost_index)
}

function miss(): ReplicaPickResult {
  return {
    kind: 'miss',
    base_site: -1,
    cell: [0, 0, 0],
    ghost: false,
  }
}

function layout_matches(codec: ReplicaIdCodec, replicas: ReplicaLayout): boolean {
  if (
    replicas.dims[0] !== codec.dim_x ||
    replicas.dims[1] !== codec.dim_y ||
    replicas.dims[2] !== codec.dim_z ||
    replicas.semantics !== codec.semantics
  ) {
    return false
  }
  if (replicas.semantics === 'physical-distinct-sites') {
    return replicas.physical_site_map !== undefined &&
      replicas.physical_site_map.length === codec.atom_instance_count
  }
  return replicas.physical_site_map === undefined
}

function valid_image_table(
  images: ImageInstanceTable | undefined,
  codec: ReplicaIdCodec,
): images is ImageInstanceTable {
  return images !== undefined &&
    Number.isInteger(images.count) &&
    images.count === codec.ghost_count &&
    images.base_sites.length === images.count &&
    images.jimages.length === images.count * 3
}

/** Decode one uint32 render-target value into the canonical replica pick type. */
export function decode_replica_pick_id(
  encoded_id: number,
  codec: ReplicaIdCodec,
  replicas: ReplicaLayout,
  images?: ImageInstanceTable,
): ReplicaPickResult {
  if (
    !Number.isInteger(encoded_id) || encoded_id <= REPLICA_PICK_MISS_ID ||
    encoded_id > codec.max_id || encoded_id > REPLICA_PICK_MAX_ID ||
    !layout_matches(codec, replicas)
  ) {
    return miss()
  }

  if (encoded_id < codec.bond_first_id) {
    const instance_index = encoded_id - codec.atom_first_id
    const decoded = decode_replica_instance(
      instance_index,
      codec.base_atom_count,
      replicas.dims,
    )
    return {
      kind: 'atom',
      base_site: decoded.atom_index,
      cell: [decoded.cell[0], decoded.cell[1], decoded.cell[2]],
      ghost: false,
    }
  }

  if (encoded_id < codec.ghost_first_id) {
    const instance_index = encoded_id - codec.bond_first_id
    const decoded = decode_replica_instance(
      instance_index,
      codec.base_bond_count,
      replicas.dims,
    )
    return {
      kind: 'bond',
      base_site: decoded.atom_index,
      cell: [decoded.cell[0], decoded.cell[1], decoded.cell[2]],
      ghost: false,
    }
  }

  if (!valid_image_table(images, codec)) return miss()
  const ghost_index = encoded_id - codec.ghost_first_id
  if (ghost_index < 0 || ghost_index >= images.count) return miss()
  const base_site = images.base_sites[ghost_index]
  if (base_site >= codec.base_atom_count) return miss()
  const offset = ghost_index * 3
  return {
    kind: 'atom',
    base_site,
    cell: [
      images.jimages[offset],
      images.jimages[offset + 1],
      images.jimages[offset + 2],
    ],
    ghost: true,
  }
}

/** Decode and apply the canonical visual-shared/physical-distinct resolution. */
export function logical_site_for_replica_pick_id(
  encoded_id: number,
  codec: ReplicaIdCodec,
  replicas: ReplicaLayout,
  images?: ImageInstanceTable,
): number {
  return logical_site_for_pick(
    decode_replica_pick_id(encoded_id, codec, replicas, images),
    replicas,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WebGL2 integer GPU ID pass over the codec (Visual T5).
// ─────────────────────────────────────────────────────────────────────────────

/** One decoded scene pick: the canonical result plus the resolved logical
 *  site (`visual-shared-base` folds every replica to its base site;
 *  `physical-distinct-sites` yields the unique physical id). */
export type ScenePickResult = {
  pick: ReplicaPickResult
  logical_site: number
}

export type ReplicaPickAction =
  | { type: 'atom'; site_idx: number }
  | { type: 'bond'; filtered_idx: number }

/**
 * Map one scene pick onto the viewer's selection surfaces.
 *
 * - atom + `visual-shared-base`     → ONE base selection flag: the logical
 *                                     site indexes `site_ids` (base-sized), so
 *                                     every replica cell resolves to the same
 *                                     site id.
 * - atom + `physical-distinct-sites`→ the distinct physical id, unmapped.
 * - bond                            → the base bond GRAPH index routed through
 *                                     `slot_to_filtered_idx`; orphan (-1),
 *                                     out-of-range, or missing maps degrade to
 *                                     null (no hit), mirroring the decorator
 *                                     hitbox contract.
 */
export function resolve_replica_pick_action(
  picked: ScenePickResult,
  semantics: ReplicaSemantics,
  site_ids: ArrayLike<number> | null,
  slot_to_filtered_idx: Int32Array | null,
): ReplicaPickAction | null {
  const { pick, logical_site } = picked
  if (pick.kind === 'miss' || logical_site < 0) return null
  if (pick.kind === 'bond') {
    if (slot_to_filtered_idx === null) return null
    const graph_index = pick.base_site
    if (graph_index < 0 || graph_index >= slot_to_filtered_idx.length) return null
    const filtered_idx = slot_to_filtered_idx[graph_index]
    return filtered_idx < 0 ? null : { type: 'bond', filtered_idx }
  }
  if (semantics === 'physical-distinct-sites') {
    return { type: 'atom', site_idx: logical_site }
  }
  if (site_ids !== null) {
    if (logical_site >= site_ids.length) return null
    return { type: 'atom', site_idx: site_ids[logical_site] }
  }
  return { type: 'atom', site_idx: logical_site }
}

const ALL_CHANGED = {
  topology_changed: true,
  bond_graph_changed: true,
  frame_changed: true,
  replica_changed: true,
}

const EMPTY_TABLE: ImageInstanceTable = {
  count: 0,
  base_sites: new Uint32Array(0),
  jimages: new Int8Array(0),
}

// Integer ID → RGBA8 bytes. Shader int math is 32-bit signed, so encodable
// ids cap at 2^31 - 1 — far beyond any real instance count and validated
// against uint32 capacity by the codec anyway.
const ENCODE_PICK_ID = /* glsl */ `
  vec4 encode_pick_id(int id) {
    return vec4(
      float(id & 0xFF),
      float((id >> 8) & 0xFF),
      float((id >> 16) & 0xFF),
      float((id >> 24) & 0xFF)
    ) / 255.0;
  }
`

// Billboard expansion identical to the visual atom impostor (1.05 pad).
const PICK_SPHERE_VERTEX_TAIL = /* glsl */ `
  vQuadCoord = position.xy;
  vec4 view_center = modelViewMatrix * vec4(replica_pos, 1.0);
  vCenter = view_center.xyz;
  vec3 view_pos = view_center.xyz;
  view_pos.xy += position.xy * vRadius * 1.05;
  gl_Position = projectionMatrix * vec4(view_pos, 1.0);
`

const PICK_POSITION_TEXTURE = /* glsl */ `
  uniform sampler2D uPosTex;
  uniform int uPosTexWidth;

  vec3 fetchBasePosition(float site) {
    int idx = int(site + 0.5);
    ivec2 uv = ivec2(idx % uPosTexWidth, idx / uPosTexWidth);
    return texelFetch(uPosTex, uv, 0).xyz;
  }
`

// Main atom replica pick draw: base attributes at divisor = cell count. The
// shader folds the WebGL2 base-outer instance order into the codec's
// atom-major ID: base = gl_InstanceID / uCellCount, cell = gl_InstanceID %
// uCellCount, id = uAtomFirstId + base + uBaseCount · cell.
const ATOM_PICK_VERTEX_SHADER = /* glsl */ `
  attribute float instanceSite;
  attribute float instanceRadius;
  uniform mat3 uLattice;
  uniform ivec3 uDims;
  uniform int uCellCount;
  uniform int uBaseCount;
  uniform int uAtomFirstId;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec2 vQuadCoord;
  flat varying vec4 vPickColor;
  ${ENCODE_PICK_ID}
  ${PICK_POSITION_TEXTURE}

  void main() {
    int cell_index = gl_InstanceID % uCellCount;
    int base_index = gl_InstanceID / uCellCount;
    vPickColor = encode_pick_id(uAtomFirstId + base_index + uBaseCount * cell_index);
    int ix = cell_index % uDims.x;
    int iy = (cell_index / uDims.x) % uDims.y;
    int iz = cell_index / (uDims.x * uDims.y);
    vec3 replica_pos = fetchBasePosition(instanceSite) +
      uLattice * vec3(float(ix), float(iy), float(iz));
    vRadius = instanceRadius;
    ${PICK_SPHERE_VERTEX_TAIL}
  }
`

// Sparse ghost pick draw: divisor-1 attributes, one instance per deduplicated
// (base_site, absolute image) of the SAME `build_image_instance_table` the
// visual atom renderer draws — positional index parity is what makes
// `uGhostFirstId + gl_InstanceID` decode through the codec's ghost range.
const GHOST_PICK_VERTEX_SHADER = /* glsl */ `
  attribute float ghostBaseSite;
  attribute vec3 ghostImage;
  attribute float ghostRadius;
  uniform mat3 uLattice;
  uniform int uGhostFirstId;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec2 vQuadCoord;
  flat varying vec4 vPickColor;
  ${ENCODE_PICK_ID}
  ${PICK_POSITION_TEXTURE}

  void main() {
    vPickColor = encode_pick_id(uGhostFirstId + gl_InstanceID);
    vec3 replica_pos = fetchBasePosition(ghostBaseSite) + uLattice * ghostImage;
    vRadius = ghostRadius;
    ${PICK_SPHERE_VERTEX_TAIL}
  }
`

// Hard-silhouette ray-sphere pick fragment: no AA (ids can't be fractional),
// analytic depth so atom/bond pick occlusion matches the visual pass.
const SPHERE_PICK_FRAGMENT_SHADER = /* glsl */ `
  uniform bool uIsOrthographic;
  uniform mat4 projectionMatrix;
  varying vec3 vCenter;
  varying float vRadius;
  varying vec2 vQuadCoord;
  flat varying vec4 vPickColor;
  out vec4 fragColor;

  void main() {
    vec3 hit_pos;
    float r2 = vRadius * vRadius;
    if (uIsOrthographic) {
      vec2 offset = vQuadCoord * vRadius * 1.05;
      float d2 = dot(offset, offset);
      if (d2 > r2) discard;
      hit_pos = vec3(vCenter.xy + offset, vCenter.z + sqrt(r2 - d2));
    } else {
      vec3 frag_view = vec3(vCenter.xy + vQuadCoord * vRadius * 1.05, vCenter.z);
      vec3 ray_dir = normalize(frag_view);
      vec3 cr = cross(vCenter, ray_dir);
      float d2 = dot(cr, cr);
      if (d2 > r2) discard;
      float tca = dot(vCenter, ray_dir);
      hit_pos = (tca - sqrt(r2 - d2)) * ray_dir;
    }
    vec4 clip_pos = projectionMatrix * vec4(hit_pos, 1.0);
    gl_FragDepth = (clip_pos.z / clip_pos.w) * 0.5 + 0.5;
    fragColor = vPickColor;
  }
`

// Bond replica pick draw: per-bond base attributes at divisor = twice the cell
// count, the SAME boundary-policy geometry as the visual bond renderer, and
// BOTH half instances of one bond folding to ONE bond-graph ID:
// group_size = 2 * uCellCount, bond = gl_InstanceID / group_size,
// id = uBondFirstId + bond + uBaseBondCount · cell_index.
const BOND_PICK_VERTEX_SHADER = /* glsl */ `
  attribute vec2 a_site;
  attribute vec3 a_jimage;
  uniform mat3 uLattice;
  uniform ivec3 uDims;
  uniform int uCellCount;
  uniform int uPolicy;
  uniform float uStubScale;
  uniform float uBondRadius;
  uniform int uBondFirstId;
  uniform int uBaseBondCount;
  flat varying vec4 vPickColor;
  flat varying vec3 vImpBase;
  flat varying vec3 vImpAxis;
  flat varying float vImpRadiusSq;
  flat varying float vImpLen;
  flat varying float vImpCollapse;
  ${ENCODE_PICK_ID}
  ${PICK_POSITION_TEXTURE}

  void main() {
    int group_size = 2 * uCellCount;
    int within_bond = gl_InstanceID % group_size;
    int half_index = within_bond / uCellCount;
    int cell_index = within_bond % uCellCount;
    int bond_index = gl_InstanceID / group_size;
    vPickColor = encode_pick_id(uBondFirstId + bond_index + uBaseBondCount * cell_index);
    ivec3 cell = ivec3(
      cell_index % uDims.x,
      (cell_index / uDims.x) % uDims.y,
      cell_index / (uDims.x * uDims.y)
    );
    vec3 pa = fetchBasePosition(a_site.x);
    vec3 pb = fetchBasePosition(a_site.y);
    ivec3 jimage = ivec3(round(a_jimage));
    bool is_b_half = half_index == 1;
    ivec3 probe = is_b_half ? cell - jimage : cell + jimage;
    bool inside = all(greaterThanEqual(probe, ivec3(0))) &&
      all(lessThan(probe, uDims));
    vec3 anchor = (is_b_half ? pb : pa) + uLattice * vec3(cell);
    vec3 partner = (is_b_half ? pa : pb) + uLattice * vec3(probe);
    bool collapse = !inside && (uPolicy == 1 || (uPolicy == 2 && is_b_half));
    vec3 d = partner - anchor;
    vec3 tip = anchor + d * 0.5;
    if (!inside && uPolicy == 0) tip = anchor + d * (0.5 * uStubScale);
    vec3 seg = tip - anchor;
    float seg_len = length(seg);
    collapse = collapse || !(seg_len > 1e-6);
    vImpCollapse = collapse ? 1.0 : 0.0;
    if (collapse) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
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
    float pad = uBondRadius * 1.3;
    float za = position.z * 0.5 + 0.5;
    vec3 corner = anchor + xb * (position.x * pad) + zb * (position.y * pad) +
      dir * (za * seg_len);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(corner, 1.0);
    vImpBase = (modelViewMatrix * vec4(anchor, 1.0)).xyz;
    vImpAxis = (modelViewMatrix * vec4(seg, 0.0)).xyz;
    vImpLen = length(vImpAxis);
    float view_r = uBondRadius * length(modelViewMatrix[0].xyz);
    vImpRadiusSq = view_r * view_r;
  }
`

// Hard ray-cylinder pick fragment — the visual renderer's proven intersection
// math minus lighting/AA, ID color out, analytic depth.
/**
 * Ray-cylinder intersection adapted from OVITO Basic
 * commit 0b2cdccef7452bf28212e15daf9df2dc7a545bcc.
 * Copyright 2026 OVITO GmbH, Germany. Used under the MIT option.
 * Full permission notice and CatGo modifications: THIRD_PARTY_NOTICES.md.
 */
const BOND_PICK_FRAGMENT_SHADER = /* glsl */ `
  uniform mat4 projectionMatrix;
  uniform mat4 uInvProjection;
  uniform vec4 uViewport;
  flat varying vec4 vPickColor;
  flat varying vec3 vImpBase;
  flat varying vec3 vImpAxis;
  flat varying float vImpRadiusSq;
  flat varying float vImpLen;
  flat varying float vImpCollapse;
  out vec4 fragColor;

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
    vec3 n = cross(rd, A);
    float ln = length(n);
    vec3 RC = ray_origin - B;
    vec3 hit;

    if (ln < 1e-7 * vImpLen) {
      float t = dot(RC, rd);
      float v = dot(RC, RC);
      if (v - t * t > vImpRadiusSq) discard;
      hit = ray_origin - t * rd;
    } else {
      n /= ln;
      float dd = dot(RC, n);
      dd *= dd;
      if (dd > vImpRadiusSq) discard;
      float t = dot(cross(A, RC), n) / ln;
      float s = abs(sqrt(vImpRadiusSq - dd) / dot(cross(n, A), rd) * vImpLen);
      float tnear = t - s;
      hit = ray_origin + tnear * rd;
      float anear = dot(hit - B, A) / len2;
      if (anear < 0.0 || anear > 1.0) {
        float tfar = t + s;
        vec3 farp = ray_origin + tfar * rd;
        float afar = dot(farp - B, A) / len2;
        if (anear < 0.0 && afar > 0.0) {
          hit = ray_origin + (tnear + (anear / (anear - afar)) * 2.0 * s) * rd;
        } else if (anear > 1.0 && afar < 1.0) {
          hit = ray_origin + (tnear + ((anear - 1.0) / (anear - afar)) * 2.0 * s) * rd;
        } else {
          discard;
        }
      }
    }

    vec4 proj = projectionMatrix * vec4(hit, 1.0);
    float dz = (proj.z / proj.w + 1.0) * 0.5;
    if (dz < 0.0 || dz > 1.0) discard;
    gl_FragDepth = dz;
    fragColor = vPickColor;
  }
`

export type ReplicaPickSyncOptions = {
  /** Visual bond cylinder radius — pick geometry matches what's drawn. */
  bond_radius?: number
  /** Stub length multiplier for the 'stub' boundary policy. */
  stub_scale?: number
  /** Structure rotation (Euler xyz) + pivot, matching the scene group. */
  rotation?: readonly [number, number, number]
  pivot?: readonly [number, number, number]
}

const MISS_PICK: ReplicaPickResult = Object.freeze({
  kind: 'miss' as const,
  base_site: -1,
  cell: [0, 0, 0] as const,
  ghost: false,
})

/**
 * WebGL2 replica pick scene — an integer GPU ID pass mirroring the visual
 * replica renderers' instancing (divisor attributes, replica decode in the
 * vertex stage, boundary-policy geometry) with codec-encoded IDs as color.
 *
 * Owns only BASE-sized topology resources: site IDs and radii are N floats,
 * bonds are B entries, and ghosts are the sparse O(surface) table.
 * Positions come from the visible draw's shared texture. There is NO
 * instanceMatrix, per-replica CPU compose, or picker position upload.
 *
 * Ghost-side bond halves (the visual renderers' sparse second bond draw) are
 * intentionally not pickable — they overlap the pickable ghost atom at the
 * same image, so the atom wins that sliver.
 */
export class ReplicaPickScene {
  readonly scene = new THREE.Scene()
  readonly atom_mesh: THREE.Mesh
  readonly bond_mesh: THREE.Mesh
  readonly ghost_mesh: THREE.Mesh
  readonly atom_material: THREE.ShaderMaterial
  readonly bond_material: THREE.ShaderMaterial
  readonly ghost_material: THREE.ShaderMaterial
  readonly renderer: THREE.WebGLRenderer

  #atom_geometry = new THREE.InstancedBufferGeometry()
  #bond_geometry = new THREE.InstancedBufferGeometry()
  #ghost_geometry = new THREE.InstancedBufferGeometry()
  #quad: THREE.PlaneGeometry
  #box: THREE.BoxGeometry
  #target = new THREE.WebGLRenderTarget(1, 1)
  #pixel = new Uint8Array(4)

  #prev: RenderPacket | null = null
  #codec: ReplicaIdCodec | null = null
  #layout: ReplicaLayout | null = null
  #images: ImageInstanceTable = EMPTY_TABLE

  // Base-sized topology-only CPU mirrors.
  #atom_sites = new Float32Array(0)
  #radii = new Float32Array(0)
  #bond_capacity = 0
  #bond_count = 0
  #sites = new Float32Array(0)
  #jimages = new Int8Array(0)
  #positions: SharedPositionTexture
  #release_positions: () => void

  // Sparse ghost attribute arrays (capacity-grown, count = live span).
  #ghost_sites = new Float32Array(0)
  #ghost_images = new Float32Array(0)
  #ghost_radii = new Float32Array(0)

  // Rotation-about-pivot chain: T(+pivot) · R · T(−pivot).
  #pivot_group = new THREE.Group()
  #rotation_group = new THREE.Group()
  #offset_group = new THREE.Group()

  constructor(options: {
    renderer: THREE.WebGLRenderer
    positions: SharedPositionTexture
  }) {
    this.renderer = options.renderer
    this.#positions = options.positions
    this.#release_positions = options.positions.register(`picker`)
    this.#quad = new THREE.PlaneGeometry(2, 2, 1, 1)
    this.#box = new THREE.BoxGeometry(2, 2, 2)
    for (const geometry of [this.#atom_geometry, this.#ghost_geometry]) {
      geometry.setIndex(this.#quad.getIndex())
      geometry.setAttribute('position', this.#quad.getAttribute('position'))
      geometry.instanceCount = 0
    }
    this.#bond_geometry.setIndex(this.#box.getIndex())
    this.#bond_geometry.setAttribute('position', this.#box.getAttribute('position'))
    this.#bond_geometry.instanceCount = 0

    // Shared uniform OBJECTS — one write updates every pick draw.
    const shared = {
      uLattice: { value: new THREE.Matrix3() },
      uDims: { value: new Int32Array([1, 1, 1]) },
      uCellCount: { value: 1 },
      uPosTex: { value: this.#positions.texture },
      uPosTexWidth: { value: this.#positions.texture.image.width },
    }
    this.atom_material = new THREE.ShaderMaterial({
      vertexShader: ATOM_PICK_VERTEX_SHADER,
      fragmentShader: SPHERE_PICK_FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      blending: THREE.NoBlending,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uLattice: shared.uLattice,
        uDims: shared.uDims,
        uCellCount: shared.uCellCount,
        uPosTex: shared.uPosTex,
        uPosTexWidth: shared.uPosTexWidth,
        uBaseCount: { value: 0 },
        uAtomFirstId: { value: 1 },
        uIsOrthographic: { value: false },
      },
    })
    this.ghost_material = new THREE.ShaderMaterial({
      vertexShader: GHOST_PICK_VERTEX_SHADER,
      fragmentShader: SPHERE_PICK_FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      blending: THREE.NoBlending,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uLattice: shared.uLattice,
        uPosTex: shared.uPosTex,
        uPosTexWidth: shared.uPosTexWidth,
        uGhostFirstId: { value: 1 },
        uIsOrthographic: this.atom_material.uniforms.uIsOrthographic,
      },
    })
    this.bond_material = new THREE.ShaderMaterial({
      vertexShader: BOND_PICK_VERTEX_SHADER,
      fragmentShader: BOND_PICK_FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      blending: THREE.NoBlending,
      transparent: false,
      depthWrite: true,
      uniforms: {
        uLattice: shared.uLattice,
        uDims: shared.uDims,
        uCellCount: shared.uCellCount,
        uPosTex: shared.uPosTex,
        uPosTexWidth: shared.uPosTexWidth,
        uPolicy: { value: BOUNDARY_POLICY_CODE.stub },
        uStubScale: { value: 0.5 },
        uBondRadius: { value: 0.15 },
        uBondFirstId: { value: 1 },
        uBaseBondCount: { value: 0 },
        uInvProjection: { value: new THREE.Matrix4() },
        // The pick pass renders a 1×1 target — the viewport is constant.
        uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
    })

    this.atom_mesh = new THREE.Mesh(this.#atom_geometry, this.atom_material)
    this.bond_mesh = new THREE.Mesh(this.#bond_geometry, this.bond_material)
    this.ghost_mesh = new THREE.Mesh(this.#ghost_geometry, this.ghost_material)
    let atom_seen_revision = 0
    this.atom_mesh.onBeforeRender = (webgl_renderer) => {
      rebind_instance_divisors_if_needed(
        this.atom_mesh,
        webgl_renderer,
        () => atom_seen_revision,
        (revision) => atom_seen_revision = revision,
      )
    }
    let bond_seen_revision = 0
    this.bond_mesh.onBeforeRender = (webgl_renderer) => {
      rebind_instance_divisors_if_needed(
        this.bond_mesh,
        webgl_renderer,
        () => bond_seen_revision,
        (revision) => bond_seen_revision = revision,
      )
    }
    for (const mesh of [this.atom_mesh, this.bond_mesh, this.ghost_mesh]) {
      mesh.frustumCulled = false
      mesh.raycast = () => {}
      this.#offset_group.add(mesh)
    }
    this.#rotation_group.add(this.#offset_group)
    this.#pivot_group.add(this.#rotation_group)
    this.scene.add(this.#pivot_group)
  }

  get codec(): ReplicaIdCodec | null {
    return this.#codec
  }

  get images(): ImageInstanceTable {
    return this.#images
  }

  /** Apply a render packet — minimal work per `diff_render_packet` category. */
  sync(packet: RenderPacket, opts: ReplicaPickSyncOptions = {}): void {
    const prev = this.#prev
    const diff = prev === null ? ALL_CHANGED : diff_render_packet(prev, packet)
    const frame_identity_changed = prev === null || prev.frame !== packet.frame
    const lattice_changed = diff.topology_changed || diff.frame_changed ||
      frame_identity_changed
    this.atom_material.uniforms.uPosTexWidth.value =
      this.#positions.texture.image.width
    this.#prev = packet
    this.#layout = packet.replicas

    const graph_changed = diff.topology_changed || diff.bond_graph_changed
    const ghosts_changed = graph_changed || diff.replica_changed

    if (ghosts_changed) {
      const graph = packet.topology.bond_graph
      this.#images = graph !== undefined
        ? build_image_instance_table(
          graph,
          packet.replicas.dims,
          packet.replicas.boundary_policy,
        )
        : EMPTY_TABLE
    }
    if (ghosts_changed || diff.replica_changed || diff.topology_changed) {
      const graph = packet.topology.bond_graph
      try {
        this.#codec = create_replica_id_codec({
          base_atom_count: packet.topology.atom_count,
          base_bond_count: graph !== undefined ? graph.pairs.length / 2 : 0,
          replicas: packet.replicas,
          ghost_count: this.#images.count,
        })
      } catch {
        // Capacity/contract violation — picks miss until a sane packet lands.
        this.#codec = null
      }
      this.#apply_codec_uniforms()
    }

    if (diff.topology_changed) this.#rebuild_radii(packet)
    if (diff.topology_changed || diff.replica_changed) this.#apply_replicas(packet)
    if (lattice_changed) {
      ;(this.atom_material.uniforms.uLattice.value as THREE.Matrix3)
        .fromArray(packet.frame.lattice as unknown as number[])
    }
    if (graph_changed) this.#rebuild_bond_attrs(packet)
    if (graph_changed || diff.replica_changed) this.#apply_bond_replicas(packet)
    if (ghosts_changed) this.#rebuild_ghosts(packet)

    if (opts.bond_radius !== undefined) {
      this.bond_material.uniforms.uBondRadius.value = opts.bond_radius
    }
    if (opts.stub_scale !== undefined) {
      this.bond_material.uniforms.uStubScale.value = opts.stub_scale
    }
    const [rx, ry, rz] = opts.rotation ?? [0, 0, 0]
    const [px, py, pz] = opts.pivot ?? [0, 0, 0]
    this.#rotation_group.rotation.set(rx, ry, rz)
    this.#pivot_group.position.set(px, py, pz)
    this.#offset_group.position.set(-px, -py, -pz)
  }

  /**
   * Pick at NDC coordinates. The codec, replica layout, and image table are
   * snapshotted AT REQUEST TIME (before the render/readback), never re-read
   * from mutable post-render state — the T3-review async-decode contract.
   */
  pick(
    renderer: PickPixelRenderer,
    camera: THREE.Camera,
    ndc_x: number,
    ndc_y: number,
  ): ScenePickResult {
    const codec = this.#codec
    const layout = this.#layout
    const images = this.#images
    if (codec === null || layout === null) {
      return { pick: { ...MISS_PICK, cell: [0, 0, 0] }, logical_site: -1 }
    }
    this.atom_material.uniforms.uIsOrthographic.value =
      (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true
    render_pick_pixel(
      renderer,
      camera,
      this.scene,
      this.#target,
      ndc_x,
      ndc_y,
      this.#pixel,
      0,
      (pick_cam) => {
        ;(this.bond_material.uniforms.uInvProjection.value as THREE.Matrix4)
          .copy(pick_cam.projectionMatrixInverse)
      },
    )
    const id = (this.#pixel[0] | (this.#pixel[1] << 8) | (this.#pixel[2] << 16) |
      (this.#pixel[3] << 24)) >>> 0
    const pick = decode_replica_pick_id(id, codec, layout, images)
    return { pick, logical_site: logical_site_for_pick(pick, layout) }
  }

  #apply_codec_uniforms(): void {
    const codec = this.#codec
    this.atom_material.uniforms.uBaseCount.value = codec?.base_atom_count ?? 0
    this.atom_material.uniforms.uAtomFirstId.value = codec?.atom_first_id ?? 1
    this.bond_material.uniforms.uBondFirstId.value = codec?.bond_first_id ?? 1
    this.bond_material.uniforms.uBaseBondCount.value = codec?.base_bond_count ?? 0
    this.ghost_material.uniforms.uGhostFirstId.value = codec?.ghost_first_id ?? 1
  }

  #rebuild_radii(packet: RenderPacket): void {
    const { atom_count: n, radii } = packet.topology
    if (this.#radii.length !== n) {
      this.#atom_sites = new Float32Array(n)
      this.#radii = new Float32Array(n)
    }
    for (let idx = 0; idx < n; idx++) {
      this.#atom_sites[idx] = idx
      // Same on-screen size as the visual replica impostor.
      this.#radii[idx] = radii[idx] * VISUAL_RADIUS_SCALE
    }
    const attr = this.#atom_geometry.getAttribute('instanceRadius')
    if (attr) attr.needsUpdate = true
  }

  #apply_replicas(packet: RenderPacket): void {
    const dims = packet.replicas.dims
    const nx = dims[0] > 0 ? dims[0] : 1
    const ny = dims[1] > 0 ? dims[1] : 1
    const nz = dims[2] > 0 ? dims[2] : 1
    const cc = nx * ny * nz
    ensure_instanced_attr(
      this.#atom_geometry,
      'instanceSite',
      this.#atom_sites,
      1,
      cc,
    )
    ensure_instanced_attr(this.#atom_geometry, 'instanceRadius', this.#radii, 1, cc)
    this.#atom_geometry.instanceCount = packet.topology.atom_count * cc
    const dims_val = this.atom_material.uniforms.uDims.value as Int32Array
    dims_val[0] = nx
    dims_val[1] = ny
    dims_val[2] = nz
    this.atom_material.uniforms.uCellCount.value = cc
  }

  #rebuild_bond_attrs(packet: RenderPacket): void {
    const graph = packet.topology.bond_graph
    const bond_count = graph !== undefined ? graph.pairs.length / 2 : 0
    if (bond_count > this.#bond_capacity) {
      this.#bond_capacity = Math.max(
        bond_count,
        Math.ceil(this.#bond_capacity * 1.5),
      )
      this.#sites = new Float32Array(this.#bond_capacity * 2)
      this.#jimages = new Int8Array(this.#bond_capacity * 3)
    }
    this.#bond_count = bond_count
    if (graph === undefined || bond_count === 0) return
    this.#sites.set(graph.pairs, 0)
    this.#jimages.set(graph.jimages, 0)
    for (const name of ['a_site', 'a_jimage']) {
      const attribute = this.#bond_geometry.getAttribute(name) as
        | THREE.InstancedBufferAttribute
        | undefined
      if (!attribute) continue
      attribute.addUpdateRange(0, bond_count * attribute.itemSize)
      attribute.needsUpdate = true
    }
  }

  #apply_bond_replicas(packet: RenderPacket): void {
    const dims = packet.replicas.dims
    const cc = (dims[0] > 0 ? dims[0] : 1) * (dims[1] > 0 ? dims[1] : 1) *
      (dims[2] > 0 ? dims[2] : 1)
    const group_size = 2 * cc
    ensure_instanced_attr(
      this.#bond_geometry,
      'a_site',
      this.#sites,
      2,
      group_size,
      true,
    )
    ensure_instanced_attr(
      this.#bond_geometry,
      'a_jimage',
      this.#jimages,
      3,
      group_size,
      true,
    )
    this.#bond_geometry.instanceCount = this.#bond_count * group_size
    this.bond_material.uniforms.uPolicy.value =
      BOUNDARY_POLICY_CODE[packet.replicas.boundary_policy]
  }

  #rebuild_ghosts(packet: RenderPacket): void {
    const table = this.#images
    const count = table.count
    if (count === 0 && !this.#ghost_geometry.getAttribute('ghostBaseSite')) {
      // No ghosts and no attributes yet — nothing to (re)build or upload.
      this.#ghost_geometry.instanceCount = 0
      this.ghost_mesh.visible = false
      return
    }
    if (this.#ghost_radii.length < count) {
      const capacity = Math.max(count, this.#ghost_radii.length * 2, 16)
      this.#ghost_sites = new Float32Array(capacity)
      this.#ghost_images = new Float32Array(capacity * 3)
      this.#ghost_radii = new Float32Array(capacity)
      this.#ghost_geometry.setAttribute(
        'ghostBaseSite',
        new THREE.InstancedBufferAttribute(this.#ghost_sites, 1, false, 1),
      )
      this.#ghost_geometry.setAttribute(
        'ghostImage',
        new THREE.InstancedBufferAttribute(this.#ghost_images, 3, false, 1),
      )
      this.#ghost_geometry.setAttribute(
        'ghostRadius',
        new THREE.InstancedBufferAttribute(this.#ghost_radii, 1, false, 1),
      )
    }
    const { radii } = packet.topology
    for (let idx = 0; idx < count; idx++) {
      const site = table.base_sites[idx]
      this.#ghost_sites[idx] = site
      this.#ghost_images[idx * 3] = table.jimages[idx * 3]
      this.#ghost_images[idx * 3 + 1] = table.jimages[idx * 3 + 1]
      this.#ghost_images[idx * 3 + 2] = table.jimages[idx * 3 + 2]
      this.#ghost_radii[idx] = radii[site] * VISUAL_RADIUS_SCALE
    }
    for (const name of ['ghostBaseSite', 'ghostImage', 'ghostRadius']) {
      const attribute = this.#ghost_geometry.getAttribute(
        name,
      ) as THREE.InstancedBufferAttribute
      ;(attribute as unknown as { count: number }).count = count
      attribute.needsUpdate = true
    }
    this.#ghost_geometry.instanceCount = count
    delete (this.#ghost_geometry as unknown as { _maxInstanceCount?: number })
      ._maxInstanceCount
    this.ghost_mesh.visible = count > 0
  }

  dispose(): void {
    this.#atom_geometry.dispose()
    this.#bond_geometry.dispose()
    this.#ghost_geometry.dispose()
    this.#quad.dispose()
    this.#box.dispose()
    this.atom_material.dispose()
    this.bond_material.dispose()
    this.ghost_material.dispose()
    this.#release_positions()
    this.#target.dispose()
  }
}
