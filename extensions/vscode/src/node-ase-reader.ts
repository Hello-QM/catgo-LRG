import type { ElementSymbol, Pbc } from '$lib'
import type { Matrix3x3 } from '$lib/math'
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
import {
  build_dense_frame_index,
  LocalFileReader,
  numeric_frame_metadata,
} from './node-file-reader'

type NdArrayRef = { ndarray: [number[], string, number] }
type ASEFrameData = Record<string, unknown> & {
  cell?: number[][] | NdArrayRef
  pbc?: Pbc
  calculator?: Record<string, unknown>
  info?: Record<string, unknown>
}

interface ASEFileIndex {
  file_size: number
  offsets: number[]
}

const DTYPE_BYTES: Record<string, number> = {
  int64: 8,
  int32: 4,
  float64: 8,
  float32: 4,
}

const is_ndarray_ref = (value: unknown): value is NdArrayRef =>
  Boolean(
    value &&
      typeof value === `object` &&
      Array.isArray((value as NdArrayRef).ndarray) &&
      (value as NdArrayRef).ndarray.length === 3,
  )

const flatten_numeric = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const flat = value.flat(Infinity).map(Number)
  return flat.every(Number.isFinite) ? flat : undefined
}

export async function scan_ase_file(file_path: string): Promise<ASEFileIndex> {
  const reader = await LocalFileReader.create(file_path)
  try {
    if (reader.file_size < 48) throw new Error(`Invalid ASE trajectory header`)
    const header = await reader.read(0, 48)
    if (header.subarray(0, 8).toString(`utf8`) !== `- of Ulm`) {
      throw new Error(`Invalid ASE trajectory signature`)
    }
    const n_items = Number(header.readBigInt64LE(32))
    const offsets_pos = Number(header.readBigInt64LE(40))
    if (
      !Number.isSafeInteger(n_items) ||
      n_items <= 0 ||
      !Number.isSafeInteger(offsets_pos) ||
      offsets_pos < 0 ||
      offsets_pos + n_items * 8 > reader.file_size
    ) {
      throw new Error(`Invalid ASE trajectory frame table`)
    }
    const table = await reader.read(offsets_pos, offsets_pos + n_items * 8)
    const offsets = Array.from(
      { length: n_items },
      (_, idx) => Number(table.readBigInt64LE(idx * 8)),
    )
    if (
      offsets.some((offset) =>
        !Number.isSafeInteger(offset) || offset < 0 || offset >= reader.file_size
      )
    ) {
      throw new Error(`ASE trajectory contains invalid frame offsets`)
    }
    return { file_size: reader.file_size, offsets }
  } finally {
    await reader.close()
  }
}

/**
 * ASE ULM already stores a frame-offset table in its header. This loader reads
 * that table (usually a few kilobytes), then seeks directly to each frame JSON
 * and ndarray payload instead of copying the complete .traj into an ArrayBuffer.
 */
export class NodeASEFrameLoader implements FrameLoader {
  private readonly reader: LocalFileReader
  private reference_numbers?: number[]
  private reference_elements?: ElementSymbol[]

  private constructor(
    private readonly filename: string,
    private readonly index: ASEFileIndex,
    file_path: string,
  ) {
    this.reader = new LocalFileReader(file_path, index.file_size)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeASEFrameLoader> {
    on_progress?.({ current: 0, total: 100, stage: `Reading ASE frame table...` })
    const index = await scan_ase_file(file_path)
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${index.offsets.length} ASE frames`,
    })
    return new NodeASEFrameLoader(filename, index, file_path)
  }

  dispose(): Promise<void> {
    return this.reader.close()
  }

  async get_total_frames(_data: string | ArrayBuffer): Promise<number> {
    return this.index.offsets.length
  }

  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    const frames = build_dense_frame_index(
      this.index.offsets,
      this.index.file_size,
      sample_rate,
    )
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${this.index.offsets.length} ASE frames`,
    })
    return frames
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    const {
      positions,
      numbers,
      lattice,
      pbc,
      forces,
      metadata,
    } = decoded
    return create_trajectory_frame(
      positions,
      convert_atomic_numbers(numbers),
      lattice,
      pbc,
      frame_number,
      metadata,
      forces,
    )
  }

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    const positions = Float32Array.from(decoded.positions.flat())
    const forces = decoded.forces
      ? Float32Array.from(decoded.forces.flat())
      : null
    const reference = await this.get_reference_numbers()
    const topology_changed =
      decoded.numbers.length !== reference.length ||
      decoded.numbers.some((value, idx) => value !== reference[idx])
    return {
      step: frame_number,
      positions,
      forces,
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
    const result: TrajectoryMetadata[] = []
    for (let idx = 0; idx < this.index.offsets.length; idx += stride) {
      const frame = await this.load_frame(``, idx)
      if (frame) {
        result.push(numeric_frame_metadata(frame, idx, options?.properties))
      }
      if (idx % Math.max(stride, 500) === 0) {
        on_progress?.({
          current: (idx / this.index.offsets.length) * 100,
          total: 100,
          stage: `Extracting ASE metadata: ${idx}`,
        })
      }
    }
    on_progress?.({ current: 100, total: 100, stage: `Metadata ready` })
    return result
  }

  private async read_frame_json(frame_number: number): Promise<ASEFrameData | null> {
    const frame_offset = this.index.offsets[frame_number]
    if (frame_offset === undefined) return null
    const length_bytes = await this.reader.read(frame_offset, frame_offset + 8)
    if (length_bytes.length !== 8) return null
    const json_length = Number(length_bytes.readBigInt64LE(0))
    if (
      !Number.isSafeInteger(json_length) ||
      json_length <= 0 ||
      frame_offset + 8 + json_length > this.index.file_size
    ) {
      throw new Error(`Invalid ASE frame ${frame_number} JSON length`)
    }
    const json = await this.reader.read_text(
      frame_offset + 8,
      frame_offset + 8 + json_length,
    )
    return JSON.parse(json) as ASEFrameData
  }

  private async read_ndarray(ref: NdArrayRef): Promise<number[]> {
    const [shape, dtype, offset] = ref.ndarray
    const count = shape.reduce((product, value) => product * value, 1)
    const byte_width = DTYPE_BYTES[dtype]
    if (
      !byte_width ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(offset)
    ) {
      throw new Error(`Unsupported ASE ndarray ${dtype} [${shape.join(`,`)}]`)
    }
    const bytes = await this.reader.read(offset, offset + count * byte_width)
    if (bytes.length !== count * byte_width) {
      throw new Error(`Truncated ASE ndarray at byte ${offset}`)
    }
    const values = new Array<number>(count)
    for (let idx = 0; idx < count; idx++) {
      const pos = idx * byte_width
      switch (dtype) {
        case `int64`:
          values[idx] = Number(bytes.readBigInt64LE(pos))
          break
        case `int32`:
          values[idx] = bytes.readInt32LE(pos)
          break
        case `float64`:
          values[idx] = bytes.readDoubleLE(pos)
          break
        case `float32`:
          values[idx] = bytes.readFloatLE(pos)
          break
      }
    }
    return values
  }

  private async resolve_numeric(value: unknown): Promise<number[] | undefined> {
    if (is_ndarray_ref(value)) return this.read_ndarray(value)
    return flatten_numeric(value)
  }

  private async get_reference_numbers(): Promise<number[]> {
    if (this.reference_numbers) return this.reference_numbers
    const first = await this.read_frame_json(0)
    if (!first) throw new Error(`ASE trajectory has no first frame`)
    const ref = first[`numbers.`] ?? first.numbers
    const numbers = await this.resolve_numeric(ref)
    if (!numbers) throw new Error(`ASE trajectory is missing atomic numbers`)
    this.reference_numbers = numbers
    this.reference_elements = convert_atomic_numbers(numbers)
    return numbers
  }

  private async decode_frame(frame_number: number): Promise<{
    positions: number[][]
    numbers: number[]
    lattice?: Matrix3x3
    pbc: Pbc
    forces?: number[][]
    metadata: Record<string, unknown>
  } | null> {
    const data = await this.read_frame_json(frame_number)
    if (!data) return null

    const positions_flat = await this.resolve_numeric(
      data[`positions.`] ?? data.positions,
    )
    if (!positions_flat || positions_flat.length % 3 !== 0) {
      throw new Error(`ASE frame ${frame_number} has invalid positions`)
    }
    const positions = Array.from(
      { length: positions_flat.length / 3 },
      (_, idx) => positions_flat.slice(idx * 3, idx * 3 + 3),
    )

    const frame_numbers = await this.resolve_numeric(
      data[`numbers.`] ?? data.numbers,
    )
    const numbers = frame_numbers ?? await this.get_reference_numbers()
    if (numbers.length !== positions.length) {
      throw new Error(
        `ASE frame ${frame_number} has ${positions.length} positions for ${numbers.length} atoms`,
      )
    }
    if (frame_number === 0) {
      this.reference_numbers = numbers
      this.reference_elements = convert_atomic_numbers(numbers)
    }

    const cell_flat = await this.resolve_numeric(data[`cell.`] ?? data.cell)
    const lattice = cell_flat?.length === 9
      ? [
        cell_flat.slice(0, 3),
        cell_flat.slice(3, 6),
        cell_flat.slice(6, 9),
      ] as Matrix3x3
      : undefined
    const calculator = data.calculator ?? {}
    const forces_flat = await this.resolve_numeric(
      calculator[`forces.`] ?? calculator.forces,
    )
    const forces = forces_flat?.length === positions_flat.length
      ? Array.from(
        { length: positions.length },
        (_, idx) => forces_flat.slice(idx * 3, idx * 3 + 3),
      )
      : undefined

    const metadata: Record<string, unknown> = { step: frame_number }
    for (const source of [calculator, data.info ?? {}]) {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === `number` || typeof value === `string` || typeof value === `boolean`) {
          metadata[key] = value
        }
      }
    }
    if (forces) metadata.forces = forces

    return {
      positions,
      numbers,
      lattice,
      pbc: Array.isArray(data.pbc) ? data.pbc : [true, true, true],
      forces,
      metadata,
    }
  }
}
