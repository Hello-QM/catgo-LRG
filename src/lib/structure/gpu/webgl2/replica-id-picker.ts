/**
 * Collision-free uint32 IDs for replica GPU picking.
 *
 * The integer render target stores one scalar ID. Zero is the clear value/miss;
 * real atom instances, bond instances, and sparse ghost instances occupy three
 * disjoint contiguous ranges. The codec stores only scalar range metadata. It
 * never constructs per-instance matrices, colors, or CPU hitbox objects.
 */

import type {
  ImageInstanceTable,
  ReplicaLayout,
  ReplicaPickResult,
} from '$lib/structure/scene/render-packet'
import {
  decode_replica_instance,
  logical_site_for_pick,
} from '$lib/structure/scene/replica-layout'

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
  return replicas.dims[0] === codec.dim_x &&
    replicas.dims[1] === codec.dim_y &&
    replicas.dims[2] === codec.dim_z
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
