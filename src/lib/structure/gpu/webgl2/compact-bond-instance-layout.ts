import {
  cell_count_of,
  type ReplicaDims,
} from './atom-replica-renderer'

export const COMPACT_BOND_TOPOLOGY_BYTES = 2 * 4 + 3

export type CompactBondInstance = {
  bond_index: number
  half: 0 | 1
  cell_index: number
  cell: [number, number, number]
}

export function decode_compact_bond_instance(
  instance_index: number,
  dims: ReplicaDims,
  out?: CompactBondInstance,
): CompactBondInstance {
  if (!Number.isInteger(instance_index) || instance_index < 0) {
    throw new RangeError(`instance_index must be a non-negative integer`)
  }
  const nx = dims[0] > 0 ? dims[0] : 1
  const ny = dims[1] > 0 ? dims[1] : 1
  const cell_count = cell_count_of(dims)
  const group_size = 2 * cell_count
  const bond_index = Math.floor(instance_index / group_size)
  const within_bond = instance_index % group_size
  const half = Math.floor(within_bond / cell_count) as 0 | 1
  const cell_index = within_bond % cell_count
  const cell: [number, number, number] = [
    cell_index % nx,
    Math.floor(cell_index / nx) % ny,
    Math.floor(cell_index / (nx * ny)),
  ]
  if (out) {
    out.bond_index = bond_index
    out.half = half
    out.cell_index = cell_index
    out.cell[0] = cell[0]
    out.cell[1] = cell[1]
    out.cell[2] = cell[2]
    return out
  }
  return { bond_index, half, cell_index, cell }
}
