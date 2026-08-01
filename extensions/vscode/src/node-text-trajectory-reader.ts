import type { ElementSymbol, Pbc, Vec3 } from '$lib'
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
  create_trajectory_frame,
} from '$lib/trajectory/parsers/common'
import { parse_gaussian_output } from '$lib/trajectory/parsers/gaussian'
import { parse_lammps_dump } from '$lib/trajectory/parsers/lammps'
import type { Buffer } from 'node:buffer'
import {
  build_dense_frame_index,
  frame_to_position_data,
  LocalFileReader,
  numeric_frame_metadata,
  scan_byte_marker_offsets,
  scan_text_lines,
} from './node-file-reader'

const WHITESPACE = /\s+/

abstract class NodeIndexedTextFrameLoader implements FrameLoader {
  protected readonly reader: LocalFileReader
  private reference_topology?: string

  protected constructor(
    protected readonly filename: string,
    protected readonly offsets: number[],
    file_path: string,
    file_size: number,
  ) {
    this.reader = new LocalFileReader(file_path, file_size)
  }

  dispose(): Promise<void> {
    return this.reader.close()
  }

  async get_total_frames(_data: string | ArrayBuffer): Promise<number> {
    return this.offsets.length
  }

  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    const result = build_dense_frame_index(
      this.offsets,
      this.reader.file_size,
      sample_rate,
    )
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${this.offsets.length} frames`,
    })
    return result
  }

  abstract load_frame(
    data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null>

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const frame = await this.load_frame(``, frame_number)
    if (!frame) return null
    const topology = frame.structure.sites.map((site) =>
      site.species.map((species) => species.element).join(`+`)
    ).join(`,`)
    this.reference_topology ??= topology
    return frame_to_position_data(frame, topology !== this.reference_topology)
  }

  async extract_plot_metadata(
    _data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<TrajectoryMetadata[]> {
    const stride = Math.max(1, Math.floor(options?.sample_rate ?? 1))
    const result: TrajectoryMetadata[] = []
    for (let idx = 0; idx < this.offsets.length; idx += stride) {
      const frame = await this.load_frame(``, idx)
      if (frame) {
        result.push(numeric_frame_metadata(frame, idx, options?.properties))
      }
      if (idx % Math.max(stride, 500) === 0) {
        on_progress?.({
          current: (idx / this.offsets.length) * 100,
          total: 100,
          stage: `Extracting metadata: ${idx}`,
        })
      }
    }
    on_progress?.({ current: 100, total: 100, stage: `Metadata ready` })
    return result
  }

  protected read_frame_text(
    frame_number: number,
    max_bytes = Number.POSITIVE_INFINITY,
  ): Promise<string> | null {
    const start = this.offsets[frame_number]
    if (start === undefined) return null
    const end = Math.min(
      this.offsets[frame_number + 1] ?? this.reader.file_size,
      start + max_bytes,
    )
    return this.reader.read_text(start, end)
  }
}

export class NodeLammpsFrameLoader extends NodeIndexedTextFrameLoader {
  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeLammpsFrameLoader> {
    const offsets: number[] = []
    const file_size = await scan_text_lines(
      file_path,
      [`ITEM: TIMESTEP`],
      ({ byte_offset, bytes }) => {
        if (bytes.toString(`utf8`).trim() === `ITEM: TIMESTEP`) {
          offsets.push(byte_offset)
        }
      },
      on_progress,
      `Scanning LAMMPS timesteps...`,
    )
    if (offsets.length === 0) throw new Error(`LAMMPS dump: no timesteps found`)
    return new NodeLammpsFrameLoader(filename, offsets, file_path, file_size)
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const pending = this.read_frame_text(frame_number)
    if (!pending) return null
    const parsed = parse_lammps_dump(await pending, this.filename)
    const frame = parsed.frames[0]
    if (!frame) return null
    const timestep = Number(frame.metadata?.timestep)
    frame.step = Number.isFinite(timestep) ? timestep : frame_number
    return frame
  }
}

export class NodeGaussianFrameLoader extends NodeIndexedTextFrameLoader {
  private constructor(
    filename: string,
    offsets: number[],
    file_path: string,
    file_size: number,
    private readonly irc_records?: {
      start: number
      end: number
      point: number
      path: number
    }[],
  ) {
    super(filename, offsets, file_path, file_size)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeGaussianFrameLoader> {
    const standard: number[] = []
    const input: number[] = []
    const irc_markers: {
      offset: number
      end: number
      point: number
      path: number
    }[] = []
    let irc_start: number | undefined
    const file_size = await scan_text_lines(
      file_path,
      [
        `Standard orientation:`,
        `Input orientation:`,
        `IRC-IRC-IRC-`,
        `Point Number:`,
      ],
      ({ byte_offset, bytes }) => {
        const line = bytes.toString(`utf8`)
        if (line.includes(`Standard orientation:`)) standard.push(byte_offset)
        if (line.includes(`Input orientation:`)) input.push(byte_offset)
        if (line.includes(`IRC-IRC-IRC-`) && irc_start === undefined) {
          irc_start = byte_offset
        }
        const point_match = line.match(
          /Point Number:\s*(\d+)\s+Path Number:\s*(\d+)/,
        )
        if (point_match) {
          irc_markers.push({
            offset: byte_offset,
            end: byte_offset + bytes.length + 1,
            point: Number(point_match[1]),
            path: Number(point_match[2]),
          })
        }
      },
      on_progress,
      `Scanning Gaussian geometries...`,
    )
    if (irc_start !== undefined && irc_markers.length > 0) {
      const records = irc_markers.map((marker, idx) => ({
        // Point metadata is printed after its geometry. The first record may
        // obtain the TS geometry from the checkpoint section before IRC starts.
        start: idx === 0 ? 0 : irc_markers[idx - 1].offset,
        end: Math.min(file_size, marker.end),
        point: marker.point,
        path: marker.path,
      }))
      const ordered = [
        ...records.filter(({ path }) => path === 2).reverse(),
        ...records.filter(({ path }) => path === 1),
      ]
      if (ordered.length !== records.length) {
        throw new Error(`Gaussian IRC: invalid path numbering`)
      }
      return new NodeGaussianFrameLoader(
        filename,
        ordered.map(({ start }) => start),
        file_path,
        file_size,
        ordered,
      )
    }
    const offsets = standard.length > 0 ? standard : input
    if (offsets.length === 0) throw new Error(`Gaussian output: no geometry frames found`)
    return new NodeGaussianFrameLoader(filename, offsets, file_path, file_size)
  }

  override async build_frame_index(
    data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    if (!this.irc_records) {
      return super.build_frame_index(data, sample_rate, on_progress)
    }
    const stride = Math.max(1, Math.floor(sample_rate))
    const result = this.irc_records.flatMap((record, frame_number) =>
      frame_number % stride === 0
        ? [{
          frame_number,
          byte_offset: record.start,
          estimated_size: record.end - record.start,
        }]
        : []
    )
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${this.irc_records.length} Gaussian IRC frames`,
    })
    return result
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const irc = this.irc_records?.[frame_number]
    if (irc) {
      const parsed = parse_gaussian_output(
        await this.reader.read_text(irc.start, irc.end),
        this.filename,
      )
      const frame = parsed.frames.at(-1)
      if (!frame) return null
      frame.step = frame_number
      frame.metadata = {
        ...frame.metadata,
        irc_path: irc.path,
        irc_point: irc.point,
        is_transition_state: irc.point === 0,
      }
      return frame
    }
    const pending = this.read_frame_text(frame_number, 32 * 1024 * 1024)
    if (!pending) return null
    const parsed = parse_gaussian_output(await pending, this.filename)
    const frame = parsed.frames[0]
    if (!frame) return null
    frame.step = frame_number
    return frame
  }
}

export class NodeOrcaFrameLoader extends NodeIndexedTextFrameLoader {
  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeOrcaFrameLoader> {
    const offsets: number[] = []
    const file_size = await scan_text_lines(
      file_path,
      [`CARTESIAN COORDINATES (ANGSTROEM)`],
      ({ byte_offset, bytes }) => {
        if (bytes.includes(`CARTESIAN COORDINATES (ANGSTROEM)`)) {
          offsets.push(byte_offset)
        }
      },
      on_progress,
      `Scanning ORCA geometries...`,
    )
    if (offsets.length === 0) throw new Error(`ORCA output: no geometries found`)
    return new NodeOrcaFrameLoader(filename, offsets, file_path, file_size)
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const pending = this.read_frame_text(frame_number, 16 * 1024 * 1024)
    if (!pending) return null
    const text = await pending
    const positions: number[][] = []
    const elements: ElementSymbol[] = []
    let started = false
    for (const line of text.split(/\r?\n/).slice(1)) {
      const match = line.match(
        /^\s*([A-Z][a-z]?)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)\s+([-+\d.eEdD]+)(?:\s|$)/,
      )
      if (!match) {
        if (started) break
        continue
      }
      started = true
      const xyz = match.slice(2, 5).map((value) =>
        Number(value.replace(/[dD]/g, `e`))
      )
      if (xyz.some((value) => !Number.isFinite(value))) continue
      elements.push(match[1] as ElementSymbol)
      positions.push(xyz)
    }
    if (positions.length === 0) return null
    const energy_match = text.match(
      /FINAL SINGLE POINT ENERGY\s+([-+\d.eEdD]+)/,
    )
    const energy = Number(energy_match?.[1].replace(/[dD]/g, `e`))
    return create_trajectory_frame(
      positions,
      elements,
      undefined,
      [false, false, false],
      frame_number,
      Number.isFinite(energy) ? { energy } : {},
    )
  }
}

interface XdatcarHeader {
  lattice: Matrix3x3
  element_names: string[]
  element_counts: number[]
  elements: ElementSymbol[]
}

export class NodeXdatcarFrameLoader extends NodeIndexedTextFrameLoader {
  private constructor(
    filename: string,
    offsets: number[],
    file_path: string,
    file_size: number,
    private readonly top_header: XdatcarHeader,
  ) {
    super(filename, offsets, file_path, file_size)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeXdatcarFrameLoader> {
    const offsets: number[] = []
    const file_size = await scan_text_lines(
      file_path,
      [`configuration=`],
      ({ byte_offset, bytes }) => {
        if (bytes.includes(`configuration=`)) offsets.push(byte_offset)
      },
      on_progress,
      `Scanning XDATCAR configurations...`,
    )
    if (offsets.length === 0) throw new Error(`XDATCAR: no configurations found`)
    const reader = new LocalFileReader(file_path, file_size)
    try {
      const prefix = await reader.read_text(0, Math.min(offsets[0], 64 * 1024))
      const top_header = find_last_xdatcar_header(prefix)
      if (!top_header) throw new Error(`XDATCAR: invalid header`)
      return new NodeXdatcarFrameLoader(
        filename,
        offsets,
        file_path,
        file_size,
        top_header,
      )
    } finally {
      await reader.close()
    }
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    return create_trajectory_frame(
      decoded.positions,
      decoded.header.elements,
      decoded.header.lattice,
      [true, true, true],
      decoded.step,
      decoded.metadata,
    )
  }

  override async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    const top = this.top_header.elements
    const current = decoded.header.elements
    const topology_changed =
      top.length !== current.length ||
      current.some((element, idx) => element !== top[idx])
    return {
      step: decoded.step,
      positions: Float32Array.from(decoded.positions.flat()),
      forces: null,
      lattice: decoded.header.lattice,
      metadata: decoded.metadata,
      topology_changed,
    }
  }

  private async decode_frame(frame_number: number): Promise<{
    positions: number[][]
    header: XdatcarHeader
    step: number
    metadata: Record<string, unknown>
  } | null> {
    const start = this.offsets[frame_number]
    if (start === undefined) return null
    let header = this.top_header
    if (frame_number > 0) {
      // NPT XDATCAR repeats its seven-line header immediately before each
      // configuration. Only inspect a small backward window; never re-read the
      // preceding frame's coordinates.
      const before = await this.reader.read_text(
        Math.max(0, start - 64 * 1024),
        start,
      )
      header = find_last_xdatcar_header(before) ?? header
    }
    const end = this.offsets[frame_number + 1] ?? this.reader.file_size
    const text = await this.reader.read_text(start, end)
    const lines = text.split(/\r?\n/)
    const step_match = lines[0]?.match(/configuration=\s*(\d+)/)
    const step = step_match ? Number(step_match[1]) : frame_number
    const lattice_t = math.transpose_3x3_matrix(header.lattice)
    const positions: number[][] = []
    for (let idx = 1; idx < lines.length && positions.length < header.elements.length; idx++) {
      const values = lines[idx].trim().split(WHITESPACE).slice(0, 3).map(Number)
      if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
        continue
      }
      positions.push(math.mat3x3_vec3_multiply(lattice_t, values as Vec3))
    }
    if (positions.length !== header.elements.length) {
      throw new Error(
        `XDATCAR frame ${frame_number}: expected ${header.elements.length} atoms, got ${positions.length}`,
      )
    }
    return {
      positions,
      header,
      step,
      metadata: { volume: math.calc_lattice_params(header.lattice).volume },
    }
  }
}

interface OutcarIndex {
  file_size: number
  offsets: number[]
  lattice_offsets: (number | undefined)[]
}

export class NodeOutcarFrameLoader extends NodeIndexedTextFrameLoader {
  private constructor(
    filename: string,
    index: OutcarIndex,
    file_path: string,
    private readonly elements: ElementSymbol[],
  ) {
    super(filename, index.offsets, file_path, index.file_size)
    this.lattice_offsets = index.lattice_offsets
  }

  private readonly lattice_offsets: (number | undefined)[]

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeOutcarFrameLoader> {
    const offsets: number[] = []
    const lattice_offsets: (number | undefined)[] = []
    let latest_lattice: number | undefined
    const file_size = await scan_text_lines(
      file_path,
      [`direct lattice vectors`, `POSITION`, `TOTAL-FORCE`],
      ({ byte_offset, bytes }) => {
        const line = bytes.toString(`utf8`)
        if (line.includes(`direct lattice vectors`)) latest_lattice = byte_offset
        if (line.includes(`POSITION`) && line.includes(`TOTAL-FORCE`)) {
          offsets.push(byte_offset)
          lattice_offsets.push(latest_lattice)
        }
      },
      on_progress,
      `Scanning OUTCAR ionic steps...`,
    )
    if (offsets.length === 0) throw new Error(`OUTCAR: no ionic steps found`)
    const reader = new LocalFileReader(file_path, file_size)
    try {
      const prefix = await reader.read_text(0, Math.min(offsets[0], 8 * 1024 * 1024))
      const elements = parse_outcar_elements(prefix)
      if (elements.length === 0) throw new Error(`OUTCAR: could not determine elements`)
      return new NodeOutcarFrameLoader(
        filename,
        { file_size, offsets, lattice_offsets },
        file_path,
        elements,
      )
    } finally {
      await reader.close()
    }
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    return create_trajectory_frame(
      decoded.positions,
      this.elements,
      decoded.lattice,
      [true, true, true],
      frame_number,
      decoded.metadata,
      decoded.forces,
    )
  }

  override async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    return {
      step: frame_number,
      positions: Float32Array.from(decoded.positions.flat()),
      forces: Float32Array.from(decoded.forces.flat()),
      lattice: decoded.lattice,
      metadata: decoded.metadata,
      topology_changed: false,
    }
  }

  private async decode_frame(frame_number: number): Promise<{
    positions: number[][]
    forces: number[][]
    lattice: Matrix3x3
    metadata: Record<string, unknown>
  } | null> {
    const start = this.offsets[frame_number]
    if (start === undefined) return null
    const lattice_offset = this.lattice_offsets[frame_number]
    if (lattice_offset === undefined) {
      throw new Error(`OUTCAR frame ${frame_number}: no lattice found`)
    }
    const lattice_text = await this.reader.read_text(
      lattice_offset,
      Math.min(this.reader.file_size, lattice_offset + 4096),
    )
    const lattice_lines = lattice_text.split(/\r?\n/)
    const lattice = lattice_lines.slice(1, 4).map((line) =>
      line.trim().split(WHITESPACE).slice(0, 3).map(Number)
    ) as Matrix3x3
    if (
      lattice.length !== 3 ||
      lattice.some((row) => row.length !== 3 || row.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error(`OUTCAR frame ${frame_number}: invalid lattice`)
    }

    const max_frame_bytes = Math.max(
      16 * 1024 * 1024,
      this.elements.length * 256 + 4 * 1024 * 1024,
    )
    const end = Math.min(
      this.offsets[frame_number + 1] ?? this.reader.file_size,
      start + max_frame_bytes,
    )
    const text = await this.reader.read_text(start, end)
    const lines = text.split(/\r?\n/)
    const positions: number[][] = []
    const forces: number[][] = []
    for (let idx = 1; idx < lines.length && positions.length < this.elements.length; idx++) {
      const trimmed = lines[idx].trim()
      if (!trimmed || trimmed.startsWith(`---`)) continue
      const values = trimmed.split(WHITESPACE).slice(0, 6).map(Number)
      if (values.length < 6 || values.some((value) => !Number.isFinite(value))) {
        if (positions.length > 0) break
        continue
      }
      positions.push(values.slice(0, 3))
      forces.push(values.slice(3, 6))
    }
    if (positions.length !== this.elements.length) {
      throw new Error(
        `OUTCAR frame ${frame_number}: expected ${this.elements.length} atoms, got ${positions.length}`,
      )
    }

    const sigma = text.match(/energy\(sigma->0\)\s*=\s*([-\d.eE+]+)/)
    const toten = text.match(/free\s+energy\s+TOTEN\s*=\s*([-\d.eE+]+)/)
    const energy = Number(sigma?.[1] ?? toten?.[1])
    const metadata: Record<string, unknown> = {
      volume: math.calc_lattice_params(lattice).volume,
      forces,
    }
    if (Number.isFinite(energy)) metadata.energy = energy
    return { positions, forces, lattice, metadata }
  }
}

export class NodeVasprunFrameLoader extends NodeIndexedTextFrameLoader {
  private constructor(
    filename: string,
    offsets: number[],
    file_path: string,
    file_size: number,
    private readonly elements: ElementSymbol[],
    private readonly move_mask?: boolean[],
  ) {
    super(filename, offsets, file_path, file_size)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeVasprunFrameLoader> {
    const scan = await scan_byte_marker_offsets(
      file_path,
      `<calculation`,
      on_progress,
      `Scanning vasprun.xml ionic steps...`,
    )
    const { file_size, offsets } = scan
    if (offsets.length === 0) throw new Error(`vasprun.xml: no calculations found`)
    const reader = new LocalFileReader(file_path, file_size)
    try {
      const prefix = await reader.read_text(0, Math.min(offsets[0], 16 * 1024 * 1024))
      const elements = parse_vasprun_elements(prefix)
      if (elements.length === 0) {
        throw new Error(`vasprun.xml: could not determine atom elements`)
      }
      const move_mask = parse_vasprun_move_mask(prefix, elements.length)
      return new NodeVasprunFrameLoader(
        filename,
        offsets,
        file_path,
        file_size,
        elements,
        move_mask,
      )
    } finally {
      await reader.close()
    }
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    return create_trajectory_frame(
      decoded.positions,
      this.elements,
      decoded.lattice,
      [true, true, true],
      frame_number,
      decoded.metadata,
      decoded.forces,
      this.move_mask,
    )
  }

  override async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const decoded = await this.decode_frame(frame_number)
    if (!decoded) return null
    return {
      step: frame_number,
      positions: Float32Array.from(decoded.positions.flat()),
      forces: decoded.forces ? Float32Array.from(decoded.forces.flat()) : null,
      lattice: decoded.lattice,
      metadata: decoded.metadata,
      topology_changed: false,
    }
  }

  private async decode_frame(frame_number: number): Promise<{
    positions: number[][]
    forces?: number[][]
    lattice: Matrix3x3
    metadata: Record<string, unknown>
  } | null> {
    const pending = this.read_frame_text(frame_number)
    if (!pending) return null
    const raw = await pending
    const close = raw.indexOf(`</calculation>`)
    const calculation = close >= 0 ? raw.slice(0, close + 14) : raw
    const lattice_rows = extract_vasprun_varray(calculation, `basis`)
    const fractional = extract_vasprun_varray(calculation, `positions`)
    if (lattice_rows.length !== 3 || fractional.length !== this.elements.length) {
      throw new Error(`vasprun.xml frame ${frame_number}: invalid structure`)
    }
    const lattice = lattice_rows as Matrix3x3
    const lattice_t = math.transpose_3x3_matrix(lattice)
    const positions = fractional.map((abc) =>
      math.mat3x3_vec3_multiply(lattice_t, abc as Vec3)
    )
    const force_rows = extract_vasprun_varray(calculation, `forces`)
    const forces = force_rows.length === this.elements.length ? force_rows : undefined
    const energy = extract_vasprun_energy(calculation)
    const metadata: Record<string, unknown> = {
      volume: math.calc_lattice_params(lattice).volume,
    }
    if (Number.isFinite(energy)) metadata.energy = energy
    if (forces) metadata.forces = forces
    return { positions, forces, lattice, metadata }
  }
}

function parse_xdatcar_header(lines: string[], start: number): XdatcarHeader | null {
  if (start < 0 || start + 6 >= lines.length) return null
  const scale = Number(lines[start + 1]?.trim())
  if (!Number.isFinite(scale)) return null
  const lattice = lines.slice(start + 2, start + 5).map((line) =>
    line.trim().split(WHITESPACE).slice(0, 3).map((value) => Number(value) * scale)
  ) as Matrix3x3
  if (
    lattice.length !== 3 ||
    lattice.some((row) => row.length !== 3 || row.some((value) => !Number.isFinite(value)))
  ) return null
  const element_names = lines[start + 5].trim().split(WHITESPACE)
  const element_counts = lines[start + 6].trim().split(WHITESPACE).map(Number)
  if (
    element_names.length === 0 ||
    element_names.length !== element_counts.length ||
    element_counts.some((count) => !Number.isInteger(count) || count <= 0)
  ) return null
  const elements = element_names.flatMap((name, idx) =>
    Array(element_counts[idx]).fill(name as ElementSymbol)
  )
  return { lattice, element_names, element_counts, elements }
}

function find_last_xdatcar_header(text: string): XdatcarHeader | null {
  const lines = text.split(/\r?\n/)
  for (let start = lines.length - 7; start >= 0; start--) {
    const header = parse_xdatcar_header(lines, start)
    if (header) return header
  }
  return null
}

function parse_outcar_elements(prefix: string): ElementSymbol[] {
  const species: string[] = []
  for (const match of prefix.matchAll(/VRHFIN\s*=\s*([A-Za-z]+)/g)) {
    if (!species.includes(match[1])) species.push(match[1])
  }
  if (species.length === 0) {
    for (const match of prefix.matchAll(/^\s*POTCAR:\s+\S+\s+([A-Za-z]+)/gm)) {
      if (!species.includes(match[1])) species.push(match[1])
    }
  }
  const counts_match = prefix.match(/ions per type\s*=\s*(.+)$/m)
  const counts = counts_match?.[1].trim().split(WHITESPACE).map(Number) ?? []
  if (
    species.length === 0 ||
    counts.length !== species.length ||
    counts.some((count) => !Number.isInteger(count) || count <= 0)
  ) return []
  return species.flatMap((name, idx) =>
    Array(counts[idx]).fill(name as ElementSymbol)
  )
}

function parse_vasprun_elements(prefix: string): ElementSymbol[] {
  const atoms = prefix.match(
    /<array\b[^>]*name\s*=\s*["']atoms["'][^>]*>([\s\S]*?)<\/array>/i,
  )?.[1]
  if (!atoms) return []
  const elements: ElementSymbol[] = []
  for (const match of atoms.matchAll(/<rc\b[^>]*>\s*<c\b[^>]*>\s*([^<\s]+)/gi)) {
    elements.push(match[1] as ElementSymbol)
  }
  return elements
}

function parse_vasprun_move_mask(prefix: string, num_atoms: number): boolean[] | undefined {
  const initial = prefix.match(
    /<structure\b[^>]*name\s*=\s*["'](?:initialpos|initial_positions)["'][^>]*>([\s\S]*?)<\/structure>/i,
  )?.[1]
  if (!initial) return undefined
  const rows = extract_vasprun_varray(initial, `selective`)
  if (rows.length !== num_atoms) return undefined
  return rows.map((row) => row.some(Boolean))
}

function extract_vasprun_varray(content: string, name: string): number[][] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
  const body = content.match(
    new RegExp(
      `<varray\\b[^>]*name\\s*=\\s*["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/varray>`,
      `i`,
    ),
  )?.[1]
  if (!body) return []
  const rows: number[][] = []
  for (const match of body.matchAll(/<v\b[^>]*>([\s\S]*?)<\/v>/gi)) {
    const values = match[1].trim().split(WHITESPACE).map((value) => {
      if (/^[Tt]$/.test(value)) return 1
      if (/^[Ff]$/.test(value)) return 0
      return Number(value)
    })
    if (values.length > 0 && values.every((value) => Number.isFinite(value))) {
      rows.push(values)
    }
  }
  return rows
}

function extract_vasprun_energy(content: string): number | undefined {
  const energy = content.match(/<energy\b[^>]*>([\s\S]*?)<\/energy>/i)?.[1]
  if (!energy) return undefined
  for (const name of [`e_fr_energy`, `e_0_energy`, `e_wo_entrp`]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
    const match = energy.match(
      new RegExp(`<i\\b[^>]*name\\s*=\\s*["']${escaped}["'][^>]*>\\s*([^<\\s]+)`, `i`),
    )
    const value = Number(match?.[1])
    if (Number.isFinite(value)) return value
  }
  return undefined
}

export type NodeTextTrajectoryLoader =
  | NodeLammpsFrameLoader
  | NodeGaussianFrameLoader
  | NodeOrcaFrameLoader
  | NodeXdatcarFrameLoader
  | NodeOutcarFrameLoader
  | NodeVasprunFrameLoader

export async function create_node_text_trajectory_loader(
  file_path: string,
  filename: string,
  on_progress?: (progress: ParseProgress) => void,
): Promise<NodeTextTrajectoryLoader | null> {
  const lower = filename.toLowerCase()
  if (/\.(?:dump|lammpstrj)$/.test(lower)) {
    return NodeLammpsFrameLoader.create(file_path, filename, on_progress)
  }
  if (/(?:^|[._-])xdatcar(?:[._-]|$)/i.test(filename)) {
    return NodeXdatcarFrameLoader.create(file_path, filename, on_progress)
  }
  if (/(?:^|[._-])outcar(?:[._-]|$)/i.test(filename)) {
    return NodeOutcarFrameLoader.create(file_path, filename, on_progress)
  }
  if (/vasprun.*\.xml$/i.test(filename)) {
    return NodeVasprunFrameLoader.create(file_path, filename, on_progress)
  }
  if (/\.(?:out|log)$/i.test(filename)) {
    const reader = await LocalFileReader.create(file_path)
    try {
      const prefix = await reader.read_text(0, Math.min(reader.file_size, 512 * 1024))
      if (
        prefix.includes(`CARTESIAN COORDINATES (ANGSTROEM)`) ||
        prefix.includes(`O   R   C   A`)
      ) {
        return NodeOrcaFrameLoader.create(file_path, filename, on_progress)
      }
    } finally {
      await reader.close()
    }
    return NodeGaussianFrameLoader.create(file_path, filename, on_progress)
  }
  return null
}
