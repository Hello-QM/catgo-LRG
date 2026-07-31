import type {
  FrameIndex,
  FramePositionData,
  ParseProgress,
  TrajectoryFrame,
  TrajectoryMetadata,
} from '$lib/trajectory/index'
import { Buffer } from 'node:buffer'
import { open, type FileHandle } from 'node:fs/promises'

const SCAN_BUFFER_SIZE = 8 * 1024 * 1024

/** Persistent random-access handle shared by the local trajectory loaders. */
export class LocalFileReader {
  private handle?: Promise<FileHandle>
  readonly decoder = new TextDecoder()

  constructor(readonly file_path: string, readonly file_size: number) {}

  static async create(file_path: string): Promise<LocalFileReader> {
    const handle = await open(file_path, `r`)
    try {
      const file_size = (await handle.stat()).size
      return new LocalFileReader(file_path, file_size)
    } finally {
      await handle.close()
    }
  }

  async close(): Promise<void> {
    const pending = this.handle
    this.handle = undefined
    if (!pending) return
    try {
      await (await pending).close()
    } catch {
      // Closing an already-closed or concurrently replaced descriptor is safe.
    }
  }

  async read(start: number, end: number): Promise<Buffer> {
    const bounded_start = Math.max(0, Math.min(this.file_size, start))
    const bounded_end = Math.max(bounded_start, Math.min(this.file_size, end))
    const length = bounded_end - bounded_start
    if (length <= 0) return Buffer.alloc(0)

    const output = Buffer.allocUnsafe(length)
    const handle = await this.get_handle()
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(
        output,
        filled,
        length - filled,
        bounded_start + filled,
      )
      if (bytesRead <= 0) break
      filled += bytesRead
    }
    return filled === length ? output : output.subarray(0, filled)
  }

  async read_text(start: number, end: number): Promise<string> {
    return this.decoder.decode(await this.read(start, end))
  }

  private get_handle(): Promise<FileHandle> {
    this.handle ??= open(this.file_path, `r`)
    return this.handle
  }
}

export interface ScannedTextLine {
  byte_offset: number
  bytes: Buffer
}

/**
 * Scan a text file by raw newline boundaries.
 *
 * `candidate_markers` are checked as bytes before a line is decoded, so atom
 * and force rows never become JS strings during indexing. This is the common
 * equivalent of OVITO's format-specific frame finder.
 */
export async function scan_text_lines(
  file_path: string,
  candidate_markers: readonly (string | Buffer)[],
  on_candidate: (line: ScannedTextLine) => void,
  on_progress?: (progress: ParseProgress) => void,
  stage = `Scanning trajectory frames...`,
): Promise<number> {
  const handle = await open(file_path, `r`)
  try {
    const file_size = (await handle.stat()).size
    if (file_size <= 0) throw new Error(`Trajectory file is empty`)
    const markers = candidate_markers.map((marker) =>
      typeof marker === `string` ? Buffer.from(marker) : marker
    )
    const buffer = Buffer.allocUnsafe(Math.min(SCAN_BUFFER_SIZE, file_size))
    let file_position = 0
    let pending = Buffer.alloc(0)
    let pending_offset = 0

    on_progress?.({ current: 0, total: 100, stage })
    while (file_position < file_size) {
      const requested = Math.min(buffer.length, file_size - file_position)
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        file_position,
      )
      if (bytesRead <= 0) break

      const chunk = buffer.subarray(0, bytesRead)
      const combined = pending.length > 0
        ? Buffer.concat([pending, chunk])
        : chunk
      const combined_offset = pending.length > 0 ? pending_offset : file_position

      let cursor = 0
      while (cursor < combined.length) {
        const newline = combined.indexOf(0x0a, cursor)
        if (newline < 0) break
        const line = combined.subarray(cursor, newline)
        if (markers.some((marker) => line.includes(marker))) {
          on_candidate({
            byte_offset: combined_offset + cursor,
            bytes: line,
          })
        }
        cursor = newline + 1
      }

      pending = Buffer.from(combined.subarray(cursor))
      pending_offset = combined_offset + cursor
      file_position += bytesRead
      on_progress?.({
        current: (file_position / file_size) * 100,
        total: 100,
        stage,
      })
    }

    if (
      pending.length > 0 &&
      markers.some((marker) => pending.includes(marker))
    ) {
      on_candidate({ byte_offset: pending_offset, bytes: pending })
    }
    on_progress?.({ current: 100, total: 100, stage })
    return file_size
  } finally {
    await handle.close()
  }
}

/** Find an exact byte marker without depending on newline layout. */
export async function scan_byte_marker_offsets(
  file_path: string,
  marker_text: string,
  on_progress?: (progress: ParseProgress) => void,
  stage = `Scanning trajectory frames...`,
): Promise<{ file_size: number; offsets: number[] }> {
  const handle = await open(file_path, `r`)
  try {
    const file_size = (await handle.stat()).size
    if (file_size <= 0) throw new Error(`Trajectory file is empty`)
    const marker = Buffer.from(marker_text)
    const overlap_size = Math.max(0, marker.length - 1)
    const buffer = Buffer.allocUnsafe(Math.min(SCAN_BUFFER_SIZE, file_size))
    const offsets: number[] = []
    let file_position = 0
    let overlap = Buffer.alloc(0)
    let last_offset = -1

    on_progress?.({ current: 0, total: 100, stage })
    while (file_position < file_size) {
      const requested = Math.min(buffer.length, file_size - file_position)
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requested,
        file_position,
      )
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      const combined = overlap.length > 0
        ? Buffer.concat([overlap, chunk])
        : chunk
      const combined_offset = file_position - overlap.length
      let cursor = 0
      while (cursor <= combined.length - marker.length) {
        const found = combined.indexOf(marker, cursor)
        if (found < 0) break
        const absolute = combined_offset + found
        if (absolute > last_offset) {
          offsets.push(absolute)
          last_offset = absolute
        }
        cursor = found + marker.length
      }
      overlap = overlap_size > 0
        ? Buffer.from(combined.subarray(Math.max(0, combined.length - overlap_size)))
        : Buffer.alloc(0)
      file_position += bytesRead
      on_progress?.({
        current: (file_position / file_size) * 100,
        total: 100,
        stage,
      })
    }
    on_progress?.({ current: 100, total: 100, stage })
    return { file_size, offsets }
  } finally {
    await handle.close()
  }
}

export function build_dense_frame_index(
  offsets: readonly number[],
  file_size: number,
  sample_rate = 1,
): FrameIndex[] {
  const stride = Math.max(1, Math.floor(sample_rate))
  const frames: FrameIndex[] = []
  for (let idx = 0; idx < offsets.length; idx += stride) {
    frames.push({
      frame_number: idx,
      byte_offset: offsets[idx],
      estimated_size: (offsets[idx + 1] ?? file_size) - offsets[idx],
    })
  }
  return frames
}

export function frame_to_position_data(
  frame: TrajectoryFrame,
  topology_changed = false,
): FramePositionData {
  const positions = new Float32Array(frame.structure.sites.length * 3)
  let forces: Float32Array | null = null
  let has_forces = false

  for (let idx = 0; idx < frame.structure.sites.length; idx++) {
    const site = frame.structure.sites[idx]
    const xyz = site.xyz ?? [0, 0, 0]
    positions[idx * 3] = xyz[0]
    positions[idx * 3 + 1] = xyz[1]
    positions[idx * 3 + 2] = xyz[2]
    const force = site.properties?.force
    if (Array.isArray(force) && force.length >= 3) {
      forces ??= new Float32Array(frame.structure.sites.length * 3)
      forces[idx * 3] = Number(force[0])
      forces[idx * 3 + 1] = Number(force[1])
      forces[idx * 3 + 2] = Number(force[2])
      has_forces = true
    }
  }

  const lattice = `lattice` in frame.structure
    ? frame.structure.lattice?.matrix ?? null
    : null
  return {
    step: frame.step,
    positions,
    forces: has_forces ? forces : null,
    lattice,
    metadata: frame.metadata,
    topology_changed,
  }
}

export function numeric_frame_metadata(
  frame: TrajectoryFrame,
  frame_number: number,
  properties?: string[],
): TrajectoryMetadata {
  const numeric = Object.fromEntries(
    Object.entries(frame.metadata ?? {}).filter(
      ([key, value]) =>
        typeof value === `number` && (!properties || properties.includes(key)),
    ),
  ) as Record<string, number>
  return { frame_number, step: frame.step, properties: numeric }
}
