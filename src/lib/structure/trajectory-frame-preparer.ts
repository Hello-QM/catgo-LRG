import type {
  AnyStructure,
  BondDistanceRule,
  BondPair,
  Crystal,
  Site,
  Vec3,
} from '$lib'
import type { BondingStrategy } from './bonding'
import { apply_bond_distance_rules } from './bond-distance-rules'
import type { RenderPacket } from './scene/render-packet'
import {
  bond_pairs_to_base_bond_graph,
  hash_base_bond_graph,
  typed_table_to_base_bond_graph,
} from './trajectory-bond-graph'
import {
  prepared_frame_byte_size,
  type PreparedTrajectoryFrame,
} from './trajectory-prepared-frame'
import {
  compute_bonds_async,
  compute_trajectory_frame_typed,
  pack_trajectory_positions_worker,
} from './workers/bond-worker-api'

export type TrajectoryFrameSource = {
  frame_idx: number
  positions: Float32Array
  forces: Float32Array | null
  lattice: number[][] | null
  positions_version: number
  topology_stable: boolean
}

export type ExactFramePrepareInput = {
  packet: RenderPacket
  source: TrajectoryFrameSource
  structure: AnyStructure
  strategy: BondingStrategy
  options: Record<string, number>
  pbc: [boolean, boolean, boolean] | null
  distance_rules: readonly BondDistanceRule[]
  rules_version: string
  graph_version: number
}

function flatten_lattice(
  lattice: number[][] | null,
  fallback: Float32Array,
): Float32Array {
  if (
    lattice?.length === 3 &&
    lattice.every((row) => Array.isArray(row) && row.length === 3)
  ) {
    return new Float32Array([
      ...lattice[0],
      ...lattice[1],
      ...lattice[2],
    ])
  }
  return fallback
}

function inverse_3x3(matrix: number[][]): number[][] | null {
  const [a, b, c] = matrix[0]
  const [d, e, f] = matrix[1]
  const [g, h, i] = matrix[2]
  const det = a * (e * i - f * h) -
    b * (d * i - f * g) +
    c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  const scale = 1 / det
  return [
    [
      (e * i - f * h) * scale,
      (c * h - b * i) * scale,
      (b * f - c * e) * scale,
    ],
    [
      (f * g - d * i) * scale,
      (a * i - c * g) * scale,
      (c * d - a * f) * scale,
    ],
    [
      (d * h - e * g) * scale,
      (b * g - a * h) * scale,
      (a * e - b * d) * scale,
    ],
  ]
}

/** Build the exact per-frame structure used by object-worker strategies. */
export function build_exact_trajectory_overlay(
  structure: AnyStructure,
  positions: Float32Array,
  frame_lattice: number[][] | null,
): AnyStructure {
  const base_lattice = (structure as Crystal).lattice
  const matrix = frame_lattice?.length === 3
    ? frame_lattice
    : base_lattice?.matrix ?? null
  const inverse = matrix ? inverse_3x3(matrix) : null
  const position_count = Math.floor(positions.length / 3)
  const sites: Site[] = structure.sites.map((original, idx) => {
    if (idx >= position_count) return original
    const offset = idx * 3
    const xyz: Vec3 = [
      positions[offset],
      positions[offset + 1],
      positions[offset + 2],
    ]
    if (!inverse) return { ...original, xyz }
    const [x, y, z] = xyz
    const abc: Vec3 = [
      x * inverse[0][0] + y * inverse[1][0] + z * inverse[2][0],
      x * inverse[0][1] + y * inverse[1][1] + z * inverse[2][1],
      x * inverse[0][2] + y * inverse[1][2] + z * inverse[2][2],
    ]
    return { ...original, xyz, abc }
  })
  if (frame_lattice?.length === 3 && base_lattice) {
    return {
      ...structure,
      sites,
      lattice: { ...base_lattice, matrix: frame_lattice },
    } as AnyStructure
  }
  return { ...structure, sites } as AnyStructure
}

function numeric_session_id(input: ExactFramePrepareInput): number {
  const text = [
    input.packet.topology.version,
    input.rules_version,
    input.pbc?.map(Number).join(``) ?? `none`,
    JSON.stringify(input.options),
  ].join(`|`)
  let hash = 0x811c9dc5
  for (let idx = 0; idx < text.length; idx++) {
    hash = Math.imul(hash ^ text.charCodeAt(idx), 0x01000193)
  }
  return hash >>> 0
}

function rule_lattice(
  lattice: number[][] | null,
  pbc: [boolean, boolean, boolean] | null,
): [Vec3, Vec3, Vec3] | null {
  if (!lattice || lattice.length !== 3) return null
  const axes = pbc ?? [true, true, true]
  if (!axes.some(Boolean)) return null
  return lattice.map((row, idx) =>
    axes[idx] ? [...row] as Vec3 : [0, 0, 0]
  ) as [Vec3, Vec3, Vec3]
}

function exact_object_bonds(
  input: ExactFramePrepareInput,
  detected: readonly BondPair[],
  overlay: AnyStructure,
): BondPair[] {
  return apply_bond_distance_rules(
    overlay,
    rule_lattice(input.source.lattice, input.pbc),
    detected,
    input.distance_rules,
    input.source.positions,
  )
}

export async function prepare_exact_trajectory_frame(
  input: ExactFramePrepareInput,
): Promise<PreparedTrajectoryFrame> {
  const started = performance.now()
  const { packet: raw, source } = input
  if (source.positions.length !== raw.topology.atom_count * 3) {
    throw new Error(
      `Trajectory frame ${source.frame_idx} has ${source.positions.length} ` +
        `position values for ${raw.topology.atom_count} atoms`,
    )
  }

  let graph
  let gpu_positions_rgba: Float32Array
  const typed_fast_path = input.strategy === `atom_radii` &&
    input.distance_rules.length === 0 &&
    source.topology_stable &&
    raw.topology.atomic_numbers.length === raw.topology.atom_count &&
    raw.topology.atomic_numbers.every((atomic_number) => atomic_number > 0)

  if (typed_fast_path) {
    const result = await compute_trajectory_frame_typed({
      session: {
        id: numeric_session_id(input),
        atomic_numbers: raw.topology.atomic_numbers,
        pbc: input.pbc,
        options: input.options,
      },
      positions: source.positions,
      lattice_matrix: source.lattice,
    })
    graph = typed_table_to_base_bond_graph(result.table, input.graph_version)
    gpu_positions_rgba = result.gpu_positions_rgba
  } else {
    const overlay = build_exact_trajectory_overlay(
      input.structure,
      source.positions,
      source.lattice,
    )
    const detected = await compute_bonds_async(
      overlay,
      input.strategy,
      input.options,
    )
    const bonds = exact_object_bonds(input, detected, overlay)
    graph = bond_pairs_to_base_bond_graph(bonds, input.graph_version)
    gpu_positions_rgba = await pack_trajectory_positions_worker(source.positions)
  }

  const packet: RenderPacket = {
    topology: { ...raw.topology, bond_graph: graph },
    frame: {
      ...raw.frame,
      frame_idx: source.frame_idx,
      positions_version: source.positions_version,
      positions: source.positions,
      lattice: flatten_lattice(source.lattice, raw.frame.lattice),
    },
    replicas: raw.replicas,
  }
  return {
    key: {
      owner: raw.frame.owner,
      frame_idx: source.frame_idx,
      positions_version: source.positions_version,
      topology_version: raw.topology.version,
      rules_version: input.rules_version,
    },
    packet,
    graph,
    gpu_positions_rgba,
    forces: source.forces,
    graph_hash: hash_base_bond_graph(graph),
    byte_size: prepared_frame_byte_size(
      packet,
      gpu_positions_rgba,
      source.forces,
    ),
    compute_ms: performance.now() - started,
  }
}
