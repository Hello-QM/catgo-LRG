import type { BondPair } from '$lib'
import type { BaseBondGraph } from './scene/render-packet'
import type { TypedBondTable } from './workers/bond-worker-runtime'

function assert_graph_lengths(graph: BaseBondGraph): number {
  if (graph.pairs.length % 2 !== 0) {
    throw new Error(
      `BaseBondGraph pairs length ${graph.pairs.length} must be even`,
    )
  }
  const bond_count = graph.pairs.length / 2
  if (graph.jimages.length !== bond_count * 3) {
    throw new Error(
      `BaseBondGraph jimage length ${graph.jimages.length} must equal ` +
        `${bond_count * 3}`,
    )
  }
  if (graph.kinds.length !== bond_count) {
    throw new Error(
      `BaseBondGraph kinds length ${graph.kinds.length} must equal ${bond_count}`,
    )
  }
  if (graph.strengths.length !== bond_count) {
    throw new Error(
      `BaseBondGraph strengths length ${graph.strengths.length} must equal ` +
        `${bond_count}`,
    )
  }
  return bond_count
}

function assert_typed_table_lengths(table: TypedBondTable): number {
  if (table.pairs.length % 2 !== 0) {
    throw new Error(`TypedBondTable pairs length ${table.pairs.length} must be even`)
  }
  const bond_count = table.pairs.length / 2
  if (table.images.length !== bond_count * 3) {
    throw new Error(
      `TypedBondTable images length ${table.images.length} must equal ` +
        `${bond_count * 3}`,
    )
  }
  if (table.lengths.length !== bond_count) {
    throw new Error(
      `TypedBondTable lengths length ${table.lengths.length} must equal ` +
        `${bond_count}`,
    )
  }
  if (table.strengths.length !== bond_count) {
    throw new Error(
      `TypedBondTable strengths length ${table.strengths.length} must equal ` +
        `${bond_count}`,
    )
  }
  return bond_count
}

export function typed_table_to_base_bond_graph(
  table: TypedBondTable,
  version: number,
): BaseBondGraph {
  const bond_count = assert_typed_table_lengths(table)
  return {
    version,
    pairs: table.pairs,
    jimages: table.images,
    kinds: new Uint8Array(bond_count),
    strengths: table.strengths,
  }
}

export function bond_pairs_to_base_bond_graph(
  bonds: readonly BondPair[],
  version: number,
): BaseBondGraph {
  const bond_count = bonds.length
  const pairs = new Uint32Array(bond_count * 2)
  const jimages = new Int8Array(bond_count * 3)
  const kinds = new Uint8Array(bond_count)
  const strengths = new Float32Array(bond_count)

  for (let idx = 0; idx < bond_count; idx++) {
    const bond = bonds[idx]
    if (!Array.isArray(bond.jimage) || bond.jimage.length !== 3) {
      throw new Error(`BondPair jimage at index ${idx} must have length 3`)
    }
    pairs[idx * 2] = bond.site_idx_1
    pairs[idx * 2 + 1] = bond.site_idx_2
    jimages[idx * 3] = bond.jimage[0]
    jimages[idx * 3 + 1] = bond.jimage[1]
    jimages[idx * 3 + 2] = bond.jimage[2]
    strengths[idx] = bond.strength
  }

  return { version, pairs, jimages, kinds, strengths }
}

function lexicographically_less(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  if (ax !== bx) return ax < bx
  if (ay !== by) return ay < by
  return az < bz
}

function hash_bytes(
  bytes: Uint8Array,
  seed: number,
  multiplier: number,
): number {
  let hash = seed >>> 0
  for (let idx = 0; idx < bytes.length; idx++) {
    hash = Math.imul(hash ^ bytes[idx], multiplier) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  return hash >>> 0
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, `0`)
}

export function hash_base_bond_graph(graph: BaseBondGraph): string {
  const bond_count = assert_graph_lengths(graph)
  const record = new ArrayBuffer(28)
  const view = new DataView(record)
  const bytes = new Uint8Array(record)
  let xor_a = 0
  let sum_a = 0
  let xor_b = 0
  let sum_b = 0

  for (let idx = 0; idx < bond_count; idx++) {
    let site_a = graph.pairs[idx * 2]
    let site_b = graph.pairs[idx * 2 + 1]
    let jx = graph.jimages[idx * 3]
    let jy = graph.jimages[idx * 3 + 1]
    let jz = graph.jimages[idx * 3 + 2]

    if (site_a > site_b) {
      const swap = site_a
      site_a = site_b
      site_b = swap
      jx = -jx
      jy = -jy
      jz = -jz
    } else if (
      site_a === site_b &&
      lexicographically_less(-jx, -jy, -jz, jx, jy, jz)
    ) {
      jx = -jx
      jy = -jy
      jz = -jz
    }

    view.setUint32(0, site_a, true)
    view.setUint32(4, site_b, true)
    view.setInt32(8, jx, true)
    view.setInt32(12, jy, true)
    view.setInt32(16, jz, true)
    view.setUint32(20, graph.kinds[idx], true)
    view.setFloat32(24, graph.strengths[idx], true)

    const hash_a = hash_bytes(bytes, 0x811c9dc5, 0x01000193)
    const hash_b = hash_bytes(bytes, 0x9e3779b9, 0x27d4eb2d)
    xor_a = (xor_a ^ hash_a) >>> 0
    sum_a = (sum_a + hash_a) >>> 0
    xor_b = (xor_b ^ hash_b) >>> 0
    sum_b = (sum_b + hash_b) >>> 0
  }

  return [
    hex32(xor_a),
    hex32(sum_a),
    hex32(xor_b),
    hex32(sum_b),
    hex32(bond_count),
  ].join(``)
}
