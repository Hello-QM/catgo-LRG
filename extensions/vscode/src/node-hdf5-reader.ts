import type { ElementSymbol, Pbc } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type {
  FrameIndex,
  FrameLoader,
  FramePositionData,
  ParseProgress,
  TrajectoryFrame,
  TrajectoryMetadata,
} from '$lib/trajectory/index'
import {
  convert_atomic_numbers,
  create_trajectory_frame,
} from '$lib/trajectory/parsers/common'
import { stat } from 'node:fs/promises'
import { build_dense_frame_index } from './node-file-reader'

type H5Dataset = {
  shape: number[]
  to_array(): unknown
  slice(ranges: unknown[]): unknown
}

type H5Group = {
  keys(): string[]
  get(name: string): H5Dataset | H5Group | null
}

type H5File = H5Group & { close(): void }

interface H5Module {
  ready: Promise<unknown>
  File: new (path: string, mode: string) => H5File
}

const is_dataset = (value: H5Dataset | H5Group | null): value is H5Dataset =>
  Boolean(value && typeof (value as H5Dataset).to_array === `function`)

const is_group = (value: H5Dataset | H5Group | null): value is H5Group =>
  Boolean(value && typeof (value as H5Group).keys === `function` && !is_dataset(value))

const as_numbers = (value: unknown): number[] => {
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number | bigint>, Number)
  }
  if (Array.isArray(value)) return value.flat(Infinity).map(Number)
  return []
}

const as_strings = (value: unknown): string[] => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return []
  return Array.from(value as ArrayLike<unknown>, (item) =>
    typeof item === `string` ? item.trim() : String(item).trim()
  )
}

const get_dataset = (root: H5Group, path: string): H5Dataset | null => {
  const item = root.get(path) ?? root.get(`/${path}`)
  return is_dataset(item) ? item : null
}

/**
 * h5wasm's Node build uses NODERAWFS and HDF5 hyperslab slicing. Consequently
 * the original file stays on disk and only positions[frame, :, :] (plus small
 * cell/energy arrays) crosses into JavaScript.
 */
export class NodeHDF5FrameLoader implements FrameLoader {
  private reference_numbers?: number[]

  private constructor(
    private readonly file: H5File,
    private readonly file_size: number,
    private readonly positions: H5Dataset,
    private readonly numbers: H5Dataset | null,
    private readonly cells: H5Dataset | null,
    private readonly energies: H5Dataset | null,
    private readonly forces: H5Dataset | null,
    private readonly total_frames: number,
    private readonly num_atoms: number,
    private readonly static_elements?: ElementSymbol[],
    private readonly direct_positions = false,
    private readonly vasp_energies = false,
  ) {}

  static async create(
    file_path: string,
    _filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeHDF5FrameLoader> {
    on_progress?.({ current: 0, total: 100, stage: `Opening HDF5 datasets...` })
    const h5 = await import(`h5wasm/node`) as unknown as H5Module
    await h5.ready
    const file = new h5.File(file_path, `r`)
    try {
      const vasp_group = `intermediate/ion_dynamics`
      const vasp_positions = get_dataset(file, `${vasp_group}/position_ions`)
      const positions = vasp_positions ?? find_dataset(file, [`positions`, `position_ions`])
      if (!positions || ![2, 3].includes(positions.shape.length)) {
        throw new Error(`HDF5: missing positions dataset shaped [frames, atoms, 3]`)
      }
      const total_frames = positions.shape.length === 3 ? positions.shape[0] : 1
      const num_atoms = positions.shape.at(-2) ?? 0
      if (total_frames <= 0 || num_atoms <= 0 || positions.shape.at(-1) !== 3) {
        throw new Error(`HDF5: invalid positions shape [${positions.shape.join(`, `)}]`)
      }
      const numbers = find_dataset(file, [`atomic_numbers`, `numbers`, `Z`, `species`])
      let static_elements: ElementSymbol[] | undefined
      if (!numbers) {
        const ion_types = get_dataset(file, `input/poscar/ion_types`)
        const ion_counts = get_dataset(file, `input/poscar/number_ion_types`)
        if (ion_types && ion_counts) {
          const types = as_strings(ion_types.to_array())
          const counts = as_numbers(ion_counts.to_array())
          const expanded = types.flatMap((element, idx) =>
            Array(Math.max(0, Math.floor(counts[idx] ?? 0))).fill(element as ElementSymbol)
          )
          if (expanded.length === num_atoms) static_elements = expanded
        }
      }
      const vasp_cells = get_dataset(file, `${vasp_group}/lattice_vectors`)
      const vasp_energies = get_dataset(file, `${vasp_group}/energies`)
      const loader = new NodeHDF5FrameLoader(
        file,
        (await stat(file_path)).size,
        positions,
        numbers,
        vasp_cells ?? find_dataset(file, [`cell`, `cells`, `lattice`, `lattice_vectors`]),
        vasp_energies ?? find_dataset(file, [`potential_energy`, `energy`, `energies`]),
        get_dataset(file, `${vasp_group}/forces`) ?? find_dataset(file, [`forces`, `force`]),
        total_frames,
        num_atoms,
        static_elements,
        Boolean(vasp_positions),
        Boolean(vasp_energies),
      )
      on_progress?.({
        current: 100,
        total: 100,
        stage: `Indexed ${total_frames} HDF5 frames`,
      })
      return loader
    } catch (error) {
      file.close()
      throw error
    }
  }

  dispose(): void {
    this.file.close()
  }

  async get_total_frames(_data: string | ArrayBuffer): Promise<number> {
    return this.total_frames
  }

  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    // HDF5 frames are logical hyperslabs, not contiguous byte ranges. The
    // ordinal is still a stable O(1) index consumed by the viewer.
    const offsets = Array.from({ length: this.total_frames }, (_, idx) => idx)
    const result = build_dense_frame_index(offsets, this.file_size, sample_rate)
      .map((entry) => ({
        ...entry,
        byte_offset: entry.frame_number,
        estimated_size: Math.ceil(this.file_size / this.total_frames),
      }))
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${this.total_frames} HDF5 frames`,
    })
    return result
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const decoded = this.decode_frame(frame_number)
    if (!decoded) return null
    return create_trajectory_frame(
      decoded.positions,
      this.static_elements ?? convert_atomic_numbers(decoded.numbers),
      decoded.lattice,
      decoded.pbc,
      frame_number,
      decoded.metadata,
      decoded.forces,
    )
  }

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const decoded = this.decode_frame(frame_number)
    if (!decoded) return null
    const reference = this.get_numbers(0)
    const topology_changed =
      decoded.numbers.length !== reference.length ||
      decoded.numbers.some((value, idx) => value !== reference[idx])
    return {
      step: frame_number,
      positions: Float32Array.from(decoded.positions.flat()),
      forces: decoded.forces ? Float32Array.from(decoded.forces.flat()) : null,
      lattice: decoded.lattice ?? null,
      metadata: decoded.metadata,
      topology_changed,
    }
  }

  async extract_plot_metadata(
    _data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<TrajectoryMetadata[]> {
    const stride = Math.max(1, Math.floor(options?.sample_rate ?? 1))
    const include_energy = !options?.properties || options.properties.includes(`energy`)
    const result: TrajectoryMetadata[] = []
    for (let idx = 0; idx < this.total_frames; idx += stride) {
      const energy = include_energy ? this.get_energy(idx) : undefined
      result.push({
        frame_number: idx,
        step: idx,
        properties: Number.isFinite(energy) ? { energy: energy as number } : {},
      })
      if (idx % Math.max(stride, 1000) === 0) {
        on_progress?.({
          current: (idx / this.total_frames) * 100,
          total: 100,
          stage: `Extracting HDF5 metadata: ${idx}`,
        })
      }
    }
    on_progress?.({ current: 100, total: 100, stage: `Metadata ready` })
    return result
  }

  private get_frame_values(dataset: H5Dataset, frame_number: number): number[] {
    if (
      dataset.shape.length === 2 &&
      (
        dataset === this.positions ||
        dataset === this.cells ||
        dataset === this.forces
      )
    ) {
      return as_numbers(dataset.to_array())
    }
    const selected_frame = dataset.shape[0] === 1 ? 0 : frame_number
    const ranges = dataset.shape.map((_, axis) =>
      axis === 0 ? [selected_frame, selected_frame + 1] : []
    )
    return as_numbers(dataset.slice(ranges))
  }

  private get_numbers(frame_number: number): number[] {
    if (!this.numbers) {
      this.reference_numbers ??= Array(this.num_atoms).fill(0)
      return this.reference_numbers
    }
    if (this.numbers.shape.length === 1) {
      this.reference_numbers ??= as_numbers(this.numbers.to_array())
      return this.reference_numbers
    }
    return this.get_frame_values(this.numbers, frame_number)
  }

  private get_scalar(dataset: H5Dataset | null, frame_number: number): number | undefined {
    if (!dataset) return undefined
    const selected_frame = dataset.shape[0] === 1 ? 0 : frame_number
    const values = dataset.shape.length === 1
      ? as_numbers(dataset.slice([[selected_frame, selected_frame + 1]]))
      : this.get_frame_values(dataset, selected_frame)
    return values[0]
  }

  private get_energy(frame_number: number): number | undefined {
    if (!this.energies) return undefined
    if (!this.vasp_energies) return this.get_scalar(this.energies, frame_number)
    const values = this.get_frame_values(this.energies, frame_number)
    return values.at(-1)
  }

  private decode_frame(frame_number: number): {
    positions: number[][]
    numbers: number[]
    lattice?: Matrix3x3
    pbc: Pbc
    forces?: number[][]
    metadata: Record<string, unknown>
  } | null {
    if (frame_number < 0 || frame_number >= this.total_frames) return null
    const positions_flat = this.get_frame_values(this.positions, frame_number)
    if (positions_flat.length !== this.num_atoms * 3) {
      throw new Error(`HDF5 frame ${frame_number} has invalid positions`)
    }
    let positions = Array.from(
      { length: this.num_atoms },
      (_, idx) => positions_flat.slice(idx * 3, idx * 3 + 3),
    )
    const numbers = this.get_numbers(frame_number)
    if (numbers.length !== this.num_atoms) {
      throw new Error(
        `HDF5 frame ${frame_number} has ${this.num_atoms} positions for ${numbers.length} atoms`,
      )
    }

    const cell_flat = this.cells
      ? this.get_frame_values(this.cells, frame_number)
      : []
    const lattice = cell_flat.length === 9
      ? [
        cell_flat.slice(0, 3),
        cell_flat.slice(3, 6),
        cell_flat.slice(6, 9),
      ] as Matrix3x3
      : undefined
    if (this.direct_positions && lattice) {
      const lattice_t = math.transpose_3x3_matrix(lattice)
      positions = positions.map((abc) =>
        math.mat3x3_vec3_multiply(lattice_t, abc as [number, number, number])
      )
    }
    const force_flat = this.forces
      ? this.get_frame_values(this.forces, frame_number)
      : []
    const forces = force_flat.length === positions_flat.length
      ? Array.from(
        { length: this.num_atoms },
        (_, idx) => force_flat.slice(idx * 3, idx * 3 + 3),
      )
      : undefined
    const metadata: Record<string, unknown> = {}
    const energy = this.get_energy(frame_number)
    if (Number.isFinite(energy)) metadata.energy = energy
    if (lattice) metadata.volume = math.calc_lattice_params(lattice).volume
    if (forces) metadata.forces = forces

    return {
      positions,
      numbers,
      lattice,
      pbc: lattice ? [true, true, true] : [false, false, false],
      forces,
      metadata,
    }
  }
}

function find_dataset(root: H5Group, names: readonly string[]): H5Dataset | null {
  const wanted = new Set(names)
  const walk = (group: H5Group): H5Dataset | null => {
    for (const name of group.keys()) {
      const item = group.get(name)
      if (wanted.has(name) && is_dataset(item)) return item
      if (is_group(item)) {
        const nested = walk(item)
        if (nested) return nested
      }
    }
    return null
  }
  return walk(root)
}
