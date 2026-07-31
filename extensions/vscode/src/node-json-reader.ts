import type { ElementSymbol } from '$lib'
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
import { create_trajectory_frame } from '$lib/trajectory/parsers/common'
import { parse_json_trajectory } from '$lib/trajectory/parsers/json'
import { Buffer } from 'node:buffer'
import {
  build_dense_frame_index,
  frame_to_position_data,
  LocalFileReader,
  numeric_frame_metadata,
} from './node-file-reader'

const SCAN_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_JSON_HEADER_BYTES = 16 * 1024 * 1024

interface JSONFileIndex {
  file_size: number
  starts: number[]
  ends: number[]
  mode: `frames` | `coords`
  elements?: ElementSymbol[]
  lattice?: Matrix3x3
}

function find_array_after_key(prefix: Buffer, key: string): number {
  const marker = Buffer.from(JSON.stringify(key))
  let cursor = 0
  while (cursor < prefix.length) {
    const found = prefix.indexOf(marker, cursor)
    if (found < 0) return -1
    let pos = found + marker.length
    while (pos < prefix.length && /\s/.test(String.fromCharCode(prefix[pos]))) pos++
    if (prefix[pos] !== 0x3a) {
      cursor = found + marker.length
      continue
    }
    pos++
    while (pos < prefix.length && /\s/.test(String.fromCharCode(prefix[pos]))) pos++
    if (prefix[pos] === 0x5b) return pos
    cursor = found + marker.length
  }
  return -1
}

function extract_named_json_value(header: string, key: string): unknown {
  const marker = JSON.stringify(key)
  let cursor = header.indexOf(marker)
  while (cursor >= 0) {
    let pos = cursor + marker.length
    while (/\s/.test(header[pos] ?? ``)) pos++
    if (header[pos] !== `:`) {
      cursor = header.indexOf(marker, cursor + marker.length)
      continue
    }
    pos++
    while (/\s/.test(header[pos] ?? ``)) pos++
    const start = pos
    const first = header[pos]
    if (first !== `[` && first !== `{`) return undefined
    const stack = [first]
    let in_string = false
    let escaped = false
    for (pos++; pos < header.length; pos++) {
      const char = header[pos]
      if (in_string) {
        if (char === `"` && !escaped) in_string = false
        if (char === `\\` && !escaped) escaped = true
        else escaped = false
        continue
      }
      if (char === `"`) in_string = true
      else if (char === `[` || char === `{`) stack.push(char)
      else if (char === `]` || char === `}`) {
        stack.pop()
        if (stack.length === 0) return JSON.parse(header.slice(start, pos + 1))
      }
    }
    return undefined
  }
  return undefined
}

async function scan_json_array(
  reader: LocalFileReader,
  array_start: number,
  on_progress?: (progress: ParseProgress) => void,
): Promise<{ starts: number[]; ends: number[] }> {
  const starts: number[] = []
  const ends: number[] = []
  let depth = 0
  let item_start = -1
  let in_string = false
  let escaped = false
  let done = false

  for (let chunk_start = array_start; chunk_start < reader.file_size && !done;) {
    const chunk_end = Math.min(reader.file_size, chunk_start + SCAN_CHUNK_BYTES)
    const chunk = await reader.read(chunk_start, chunk_end)
    for (let idx = 0; idx < chunk.length; idx++) {
      const byte = chunk[idx]
      const absolute = chunk_start + idx
      if (in_string) {
        if (byte === 0x22 && !escaped) in_string = false
        if (byte === 0x5c && !escaped) escaped = true
        else escaped = false
        continue
      }
      if (byte === 0x22) {
        in_string = true
        continue
      }
      if (byte === 0x5b || byte === 0x7b) {
        if (depth === 1 && item_start < 0) item_start = absolute
        depth++
        continue
      }
      if (byte === 0x5d || byte === 0x7d) {
        if (depth === 2 && item_start >= 0) {
          starts.push(item_start)
          ends.push(absolute + 1)
          item_start = -1
        }
        depth--
        if (depth === 0) {
          done = true
          break
        }
      }
    }
    chunk_start = chunk_end
    on_progress?.({
      current: ((chunk_start - array_start) / Math.max(1, reader.file_size - array_start)) * 100,
      total: 100,
      stage: `Scanning JSON frames...`,
    })
  }
  if (!done || starts.length === 0) throw new Error(`JSON trajectory has no complete frames`)
  return { starts, ends }
}

async function scan_json_file(
  file_path: string,
  on_progress?: (progress: ParseProgress) => void,
): Promise<JSONFileIndex> {
  const reader = await LocalFileReader.create(file_path)
  try {
    const prefix = await reader.read(0, Math.min(reader.file_size, MAX_JSON_HEADER_BYTES))
    let first = 0
    while (first < prefix.length && /\s/.test(String.fromCharCode(prefix[first]))) first++
    let mode: JSONFileIndex[`mode`] = `frames`
    let array_start = prefix[first] === 0x5b ? first : find_array_after_key(prefix, `frames`)
    if (array_start < 0) {
      array_start = find_array_after_key(prefix, `coords`)
      mode = `coords`
    }
    if (array_start < 0) {
      throw new Error(`JSON trajectory frame array is beyond the 16 MiB header window`)
    }
    const spans = await scan_json_array(reader, array_start, on_progress)
    const index: JSONFileIndex = {
      file_size: reader.file_size,
      starts: spans.starts,
      ends: spans.ends,
      mode,
    }
    if (mode === `coords`) {
      const header = prefix.subarray(0, array_start).toString(`utf8`)
      const species = extract_named_json_value(header, `species`)
      const lattice = extract_named_json_value(header, `lattice`)
      if (!Array.isArray(species) || !Array.isArray(lattice) || lattice.length !== 3) {
        throw new Error(`pymatgen JSON trajectory is missing species or lattice`)
      }
      index.elements = species.map((item) =>
        (typeof item === `object` && item && `element` in item
          ? String((item as { element: unknown }).element)
          : String(item)) as ElementSymbol
      )
      index.lattice = lattice as Matrix3x3
    }
    on_progress?.({ current: 100, total: 100, stage: `Indexed ${spans.starts.length} JSON frames` })
    return index
  } finally {
    await reader.close()
  }
}

export class NodeJSONFrameLoader implements FrameLoader {
  private readonly reader: LocalFileReader
  private reference_topology?: string

  private constructor(
    private readonly filename: string,
    private readonly index: JSONFileIndex,
    file_path: string,
  ) {
    this.reader = new LocalFileReader(file_path, index.file_size)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeJSONFrameLoader> {
    return new NodeJSONFrameLoader(
      filename,
      await scan_json_file(file_path, on_progress),
      file_path,
    )
  }

  dispose(): Promise<void> {
    return this.reader.close()
  }

  async get_total_frames(): Promise<number> {
    return this.index.starts.length
  }

  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    const frames = build_dense_frame_index(
      this.index.starts,
      this.index.file_size,
      sample_rate,
    ).map((entry) => ({
      ...entry,
      estimated_size: this.index.ends[entry.frame_number] - entry.byte_offset,
    }))
    on_progress?.({ current: 100, total: 100, stage: `Indexed ${this.index.starts.length} JSON frames` })
    return frames
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const start = this.index.starts[frame_number]
    const end = this.index.ends[frame_number]
    if (start === undefined || end === undefined) return null
    const raw = JSON.parse(await this.reader.read_text(start, end))
    if (this.index.mode === `frames`) {
      return parse_json_trajectory([raw], this.filename).frames[0] ?? null
    }
    if (!Array.isArray(raw) || !this.index.lattice || !this.index.elements) return null
    const lattice_t = math.transpose_3x3_matrix(this.index.lattice)
    const positions = raw.map((abc) =>
      math.mat3x3_vec3_multiply(lattice_t, abc as [number, number, number])
    )
    return create_trajectory_frame(
      positions,
      this.index.elements,
      this.index.lattice,
      [true, true, true],
      frame_number,
      {},
    )
  }

  async load_frame_positions(
    data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const frame = await this.load_frame(data, frame_number)
    if (!frame) return null
    const topology = frame.structure.sites.map((site) =>
      site.species.map((species) => species.element).join(`+`)
    ).join(`,`)
    if (this.reference_topology === undefined) {
      const reference = frame_number === 0 ? frame : await this.load_frame(data, 0)
      this.reference_topology = reference?.structure.sites.map((site) =>
        site.species.map((species) => species.element).join(`+`)
      ).join(`,`) ?? topology
    }
    return frame_to_position_data(frame, topology !== this.reference_topology)
  }

  async extract_plot_metadata(
    data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<TrajectoryMetadata[]> {
    const stride = Math.max(1, Math.floor(options?.sample_rate ?? 1))
    const metadata: TrajectoryMetadata[] = []
    for (let idx = 0; idx < this.index.starts.length; idx += stride) {
      const frame = await this.load_frame(data, idx)
      if (frame) metadata.push(numeric_frame_metadata(frame, idx, options?.properties))
    }
    on_progress?.({ current: 100, total: 100, stage: `Metadata ready` })
    return metadata
  }
}
