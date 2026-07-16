/**
 * Render-packet builder — assembles ONE `RenderPacket` per effective frame
 * (owner structure, trajectory positions + version, current lattice, visual
 * replica dims) with single-slot memoization: unchanged inputs return the
 * previous sub-objects untouched, so `diff_render_packet` reports exactly
 * what moved. In particular a replica-factor change reuses the topology and
 * frame objects and must never invalidate base-cell bond detection (design
 * §5), and a plain frame advance reuses topology and replicas.
 *
 * The packet path NEVER appends PBC image sites to the structure: the
 * topology keeps exactly N sites and the frame exactly 3N position floats —
 * visual replication and ghost images are GPU instancing concerns. Ghost
 * atoms travel separately as the sparse `ImageInstanceTable` (see
 * `image_sites_to_instance_table` in pbc-image-atoms.ts and
 * `build_image_instance_table` in replica-layout.ts).
 *
 * Periodic self-image edges (`a === b` with non-zero jimage) are VALID and
 * are converted 1:1 into the bond graph — no starburst filtering here
 * (design §7.2; single-atom primitive cells have only such bonds).
 *
 * Pure module — no Svelte / Three.js / Threlte imports.
 *
 * Design: docs/superpowers/specs/2026-07-16-trajectory-supercell-gpu-impostor-design.md
 */

import covalent_radii_data from '$lib/element/single_bond_covalent_radii.json'
import type { AnyStructure, Site } from '$lib/structure'
import type {
  BaseBondGraph,
  BaseTopology,
  BoundaryPolicy,
  FrameGeometry,
  RenderPacket,
  ReplicaLayout,
} from './render-packet'
import { assert_render_packet } from './render-packet'

/** Base-cell bond connectivity entry, as produced by the bond controller. */
export type PacketBondConnectivity = {
  site_idx_1: number
  site_idx_2: number
  strength?: number
  jimage?: readonly [number, number, number]
}

export type RenderPacketInput = {
  /** Base scientific frame — the packet owner. Sites are NEVER image-expanded. */
  structure: AnyStructure
  /** Trajectory frame positions (3N floats, consumed zero-copy). Falls back
   *  to the base site xyz when absent or size-mismatched. */
  frame_positions?: Float32Array | null
  /** Variable-cell CURRENT frame lattice (rows a,b,c). Falls back to the
   *  structure lattice; molecules get the identity so translations degrade
   *  gracefully. */
  frame_lattice?: ReadonlyArray<ReadonlyArray<number>> | null
  frame_idx?: number
  positions_version?: number
  /** Base-cell bond connectivity, converted 1:1 (self-image edges retained). */
  bond_connectivity?: ReadonlyArray<PacketBondConnectivity> | null
  /** Visual replica dims. Defaults to [1,1,1] (no replication). */
  dims?: readonly [number, number, number]
  boundary_policy?: BoundaryPolicy
  /** Optional per-atom color floats (3N or 4N, consumed zero-copy). Color
   *  resolution (palettes, overrides) is an adapter concern — defaults to
   *  white until the consuming renderer supplies the resolved buffer. */
  colors?: Float32Array | null
  /** Optional per-atom radii (N, consumed zero-copy). Defaults to
   *  single-bond covalent radii in Å (fallback 1.0). */
  radii?: Float32Array | null
}

type ElementRow = { atomic_number?: number; covalent_radius_pm?: number }
const element_table = covalent_radii_data as Record<string, ElementRow | undefined>

/** Per-structure derived base attributes (identity-memoized in the builder). */
type TopologyCore = {
  atom_count: number
  site_ids: Uint32Array
  atomic_numbers: Uint8Array
  radii: Float32Array
  colors: Float32Array
  /** Base-site xyz fallback used when no trajectory frame buffer is given. */
  site_positions: Float32Array
}

function majority_element(site: Site | undefined): string | null {
  const species = site?.species
  if (!species || species.length === 0) return null
  let majority = species[0]
  for (let sp = 1; sp < species.length; sp++) {
    if (species[sp].occu > majority.occu) majority = species[sp]
  }
  return majority.element ?? null
}

function build_topology_core(
  structure: AnyStructure,
  colors_in: Float32Array | null,
  radii_in: Float32Array | null,
): TopologyCore {
  const sites = structure.sites
  const n = sites.length
  const site_ids = new Uint32Array(n)
  const atomic_numbers = new Uint8Array(n)
  const site_positions = new Float32Array(n * 3)
  const use_radii_in = radii_in !== null && radii_in.length === n
  const radii = use_radii_in ? radii_in : new Float32Array(n)
  const use_colors_in = colors_in !== null &&
    (colors_in.length === n * 3 || colors_in.length === n * 4)
  const colors = use_colors_in ? colors_in : new Float32Array(n * 3).fill(1)
  for (let idx = 0; idx < n; idx++) {
    site_ids[idx] = idx
    const site = sites[idx]
    const xyz = site?.xyz
    if (xyz) {
      site_positions[idx * 3] = xyz[0]
      site_positions[idx * 3 + 1] = xyz[1]
      site_positions[idx * 3 + 2] = xyz[2]
    }
    const elem = majority_element(site)
    const row = elem ? element_table[elem] : undefined
    const z = row?.atomic_number
    atomic_numbers[idx] = typeof z === `number` && z >= 1 && z <= 255 ? z : 0
    if (!use_radii_in) {
      const pm = row?.covalent_radius_pm
      radii[idx] = typeof pm === `number` && pm > 0 ? pm / 100 : 1
    }
  }
  return { atom_count: n, site_ids, atomic_numbers, radii, colors, site_positions }
}

function build_bond_graph(
  connectivity: ReadonlyArray<PacketBondConnectivity>,
  version: number,
): BaseBondGraph {
  const n = connectivity.length
  const pairs = new Uint32Array(n * 2)
  const jimages = new Int8Array(n * 3)
  const kinds = new Uint8Array(n)
  const strengths = new Float32Array(n)
  for (let idx = 0; idx < n; idx++) {
    const conn = connectivity[idx]
    pairs[idx * 2] = conn.site_idx_1
    pairs[idx * 2 + 1] = conn.site_idx_2
    const ji = conn.jimage
    if (ji) {
      jimages[idx * 3] = ji[0]
      jimages[idx * 3 + 1] = ji[1]
      jimages[idx * 3 + 2] = ji[2]
    }
    strengths[idx] = conn.strength ?? 1
  }
  return { version, pairs, jimages, kinds, strengths }
}

const IDENTITY_LATTICE: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Resolve the effective 9-float row-major lattice into `out`. Priority:
 *  frame lattice (variable-cell trajectories) → structure lattice →
 *  identity (molecules). */
function resolve_lattice(
  frame_lattice: ReadonlyArray<ReadonlyArray<number>> | null | undefined,
  structure: AnyStructure,
  out: number[],
): void {
  const rows = frame_lattice && frame_lattice.length === 3
    ? frame_lattice
    : (structure as { lattice?: { matrix?: number[][] } }).lattice?.matrix
  if (rows && rows.length === 3) {
    for (let r = 0; r < 3; r++) {
      out[r * 3] = rows[r][0]
      out[r * 3 + 1] = rows[r][1]
      out[r * 3 + 2] = rows[r][2]
    }
    return
  }
  for (let idx = 0; idx < 9; idx++) out[idx] = IDENTITY_LATTICE[idx]
}

function lattice_equals(lattice: Float32Array, values: number[]): boolean {
  for (let idx = 0; idx < 9; idx++) {
    if (lattice[idx] !== Math.fround(values[idx])) return false
  }
  return true
}

/**
 * Create a packet builder with single-slot memoization. One builder per
 * viewer pane: `build` returns the SAME packet object while its inputs are
 * unchanged, and reuses every unchanged sub-object (topology / frame /
 * replicas keep their versions) when only part of the input moved.
 */
export function create_render_packet_builder(): {
  build: (input: RenderPacketInput) => RenderPacket
} {
  let version_counter = 0

  let core: TopologyCore | null = null
  let core_structure: AnyStructure | null = null
  let core_colors_in: Float32Array | null = null
  let core_radii_in: Float32Array | null = null
  let core_version = 0

  let bond_graph: BaseBondGraph | undefined
  let graph_connectivity: ReadonlyArray<PacketBondConnectivity> | null = null

  let topology: BaseTopology | null = null
  let frame: FrameGeometry | null = null
  let replicas: ReplicaLayout | null = null
  let packet: RenderPacket | null = null

  const lattice_scratch: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  function build(input: RenderPacketInput): RenderPacket {
    const structure = input.structure
    const colors_in = input.colors ?? null
    const radii_in = input.radii ?? null

    // ── topology core: per-structure base attributes ──
    if (
      core === null || core_structure !== structure ||
      core_colors_in !== colors_in || core_radii_in !== radii_in
    ) {
      core = build_topology_core(structure, colors_in, radii_in)
      core_structure = structure
      core_colors_in = colors_in
      core_radii_in = radii_in
      core_version = ++version_counter
      topology = null // force topology shell rebuild
    }

    // ── bond graph: identity-memoized on the connectivity array ──
    const connectivity = input.bond_connectivity ?? null
    if (connectivity !== graph_connectivity) {
      bond_graph = connectivity === null
        ? undefined
        : build_bond_graph(connectivity, ++version_counter)
      graph_connectivity = connectivity
      topology = null
    }

    if (topology === null) {
      topology = {
        version: core_version,
        atom_count: core.atom_count,
        site_ids: core.site_ids,
        atomic_numbers: core.atomic_numbers,
        radii: core.radii,
        colors: core.colors,
        bond_graph,
      }
    }

    // ── frame geometry: zero-copy positions + current lattice ──
    const frame_positions = input.frame_positions ?? null
    const positions =
      frame_positions !== null && frame_positions.length === core.atom_count * 3
        ? frame_positions
        : core.site_positions
    const frame_idx = input.frame_idx ?? 0
    const positions_version = input.positions_version ?? 0
    resolve_lattice(input.frame_lattice, structure, lattice_scratch)
    if (
      frame === null || frame.owner !== structure ||
      frame.frame_idx !== frame_idx ||
      frame.positions_version !== positions_version ||
      frame.positions !== positions ||
      !lattice_equals(frame.lattice, lattice_scratch)
    ) {
      frame = {
        owner: structure,
        frame_idx,
        positions_version,
        positions,
        lattice: Float32Array.from(lattice_scratch),
      }
    }

    // ── replica layout: visual-shared-base only (true Build supercells are
    //    a separate explicit operation channel — design §9) ──
    const dims = input.dims ?? [1, 1, 1]
    const boundary_policy = input.boundary_policy ?? `stub`
    if (
      replicas === null || replicas.dims[0] !== dims[0] ||
      replicas.dims[1] !== dims[1] || replicas.dims[2] !== dims[2] ||
      replicas.boundary_policy !== boundary_policy
    ) {
      replicas = {
        version: ++version_counter,
        dims: [dims[0], dims[1], dims[2]],
        boundary_policy,
        semantics: `visual-shared-base`,
      }
    }

    if (
      packet === null || packet.topology !== topology ||
      packet.frame !== frame || packet.replicas !== replicas
    ) {
      packet = { topology, frame, replicas }
      assert_render_packet(packet)
    }
    return packet
  }

  return { build }
}
