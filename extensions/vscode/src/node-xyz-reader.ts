// File-backed XYZ/extXYZ trajectory reader for the VS Code extension host.
//
// OVITO's importer scans a multi-frame text file once to record frame byte
// offsets, then seeks to and parses only the requested frame. Mirroring that
// architecture here avoids workspace.fs.readFile() + whole-file UTF-8 decode,
// which otherwise keeps both a 300 MB byte buffer and a 300 MB JS string alive.

import type {
  FrameIndex,
  FrameLoader,
  FramePositionData,
  ParseProgress,
  TrajectoryFrame,
  TrajectoryMetadata,
} from '$lib/trajectory/index'
import { TrajFrameReader } from '$lib/trajectory/parsers/frame-loader'
import { Buffer } from 'node:buffer'
import { open, type FileHandle } from 'node:fs/promises'

const SCAN_BUFFER_SIZE = 8 * 1024 * 1024
const COMMENT_READ_SIZE = 4096

export interface XYZFileIndex {
  file_size: number
  /** Frame starts plus one EOF sentinel. */
  offsets: number[]
}

/**
 * Scan raw bytes without decoding atom lines.
 *
 * At a frame boundary only the short integer atom-count line is interpreted;
 * the following comment + N atom lines are counted by newline. This keeps the
 * scan allocation-free apart from the small per-frame offsets array.
 */
export async function scan_xyz_file(
  file_path: string,
  on_progress?: (progress: ParseProgress) => void,
): Promise<XYZFileIndex> {
  const handle = await open(file_path, `r`)
  try {
    const file_size = (await handle.stat()).size
    if (file_size <= 0) throw new Error(`XYZ file is empty`)

    const offsets: number[] = []
    const buffer = Buffer.allocUnsafe(Math.min(SCAN_BUFFER_SIZE, file_size))
    let file_position = 0
    let line_start = 0
    let line_has_bytes = false
    let lines_remaining = 0
    let complete_frame_count = 0

    let header_value = 0
    let header_has_digit = false
    let header_trailing_space = false
    let header_invalid = false

    const reset_header = (): void => {
      header_value = 0
      header_has_digit = false
      header_trailing_space = false
      header_invalid = false
    }

    const consume_header_bytes = (
      chunk: Buffer,
      start: number,
      end: number,
    ): void => {
      // Header lines are normally only a few bytes. Atom/comment lines never
      // enter this loop; Buffer.indexOf() skips them in native code.
      for (let idx = start; idx < end; idx++) {
        const byte = chunk[idx]
        const is_space = byte === 0x20 || byte === 0x09 || byte === 0x0d
        if (byte >= 0x30 && byte <= 0x39) {
          if (header_trailing_space) {
            header_invalid = true
          } else {
            header_has_digit = true
            header_value = header_value * 10 + byte - 0x30
            if (!Number.isSafeInteger(header_value)) header_invalid = true
          }
        } else if (is_space) {
          if (header_has_digit) header_trailing_space = true
        } else {
          header_invalid = true
        }
      }
    }

    const finish_line = (): void => {
      if (lines_remaining > 0) {
        lines_remaining -= 1
        if (lines_remaining === 0) complete_frame_count = offsets.length
      } else if (
        header_has_digit &&
        !header_invalid &&
        Number.isSafeInteger(header_value) &&
        header_value > 0
      ) {
        offsets.push(line_start)
        // One comment line followed by N atom lines.
        lines_remaining = header_value + 1
      }
      reset_header()
      line_has_bytes = false
    }

    on_progress?.({ current: 0, total: 100, stage: `Scanning XYZ frames...` })

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
      let cursor = 0
      while (cursor < bytesRead) {
        const newline = chunk.indexOf(0x0a, cursor)
        const segment_end = newline < 0 ? bytesRead : newline
        if (segment_end > cursor) {
          line_has_bytes = true
          if (lines_remaining === 0) {
            consume_header_bytes(chunk, cursor, segment_end)
          }
        }
        if (newline < 0) break
        finish_line()
        line_start = file_position + newline + 1
        cursor = newline + 1
      }

      file_position += bytesRead
      on_progress?.({
        current: (file_position / file_size) * 100,
        total: 100,
        stage: `Scanning XYZ frames...`,
      })
    }

    // A final line does not have to end in '\n'.
    if (line_has_bytes) finish_line()

    // Drop a truncated final frame whose declared comment/atom lines were not
    // all present.
    let data_end = file_size
    if (lines_remaining > 0) {
      data_end = offsets[complete_frame_count] ?? file_size
      offsets.length = complete_frame_count
    }
    if (offsets.length === 0) {
      throw new Error(`No complete XYZ frames found`)
    }
    offsets.push(data_end)
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${offsets.length - 1} XYZ frames`,
    })
    return { file_size, offsets }
  } finally {
    await handle.close()
  }
}

export class NodeXYZFrameLoader implements FrameLoader {
  private readonly parser: TrajFrameReader
  private readonly decoder = new TextDecoder()
  private file_handle?: Promise<FileHandle>

  constructor(
    private readonly file_path: string,
    private readonly filename: string,
    private readonly index: XYZFileIndex,
  ) {
    this.parser = new TrajFrameReader(filename)
  }

  static async create(
    file_path: string,
    filename: string,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<NodeXYZFrameLoader> {
    return new NodeXYZFrameLoader(
      file_path,
      filename,
      await scan_xyz_file(file_path, on_progress),
    )
  }

  async dispose(): Promise<void> {
    const pending = this.file_handle
    this.file_handle = undefined
    if (!pending) return
    try {
      await (await pending).close()
    } catch {
      // Closing an already-closed or concurrently replaced descriptor is safe.
    }
  }

  async get_total_frames(_data: string | ArrayBuffer): Promise<number> {
    return this.index.offsets.length - 1
  }

  async build_frame_index(
    _data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    const total_frames = this.index.offsets.length - 1
    const stride = Math.max(1, Math.floor(sample_rate))
    const frames: FrameIndex[] = []
    for (let frame_number = 0; frame_number < total_frames; frame_number += stride) {
      frames.push({
        frame_number,
        byte_offset: this.index.offsets[frame_number],
        estimated_size:
          this.index.offsets[frame_number + 1] - this.index.offsets[frame_number],
      })
    }
    on_progress?.({
      current: 100,
      total: 100,
      stage: `Indexed ${total_frames} XYZ frames`,
    })
    return frames
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    const chunk = await this.read_frame_text(frame_number)
    return chunk === null
      ? null
      : this.parser.load_xyz_frame_chunk(chunk, frame_number)
  }

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<FramePositionData | null> {
    const chunk = await this.read_frame_text(frame_number)
    return chunk === null
      ? null
      : this.parser.load_xyz_frame_positions_chunk(chunk, frame_number)
  }

  async extract_plot_metadata(
    _data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<TrajectoryMetadata[]> {
    const total_frames = this.index.offsets.length - 1
    const sample_rate = Math.max(1, Math.floor(options?.sample_rate ?? 1))
    const properties = options?.properties
    const metadata: TrajectoryMetadata[] = []

    for (let frame_number = 0; frame_number < total_frames; frame_number += sample_rate) {
      const comment = await this.read_comment(frame_number)
      const item = this.parser.parse_xyz_metadata(comment, frame_number)
      if (properties) {
        item.properties = Object.fromEntries(
          Object.entries(item.properties).filter(([key]) => properties.includes(key)),
        )
      }
      metadata.push(item)
      if (frame_number % Math.max(sample_rate, 500) === 0) {
        on_progress?.({
          current: (frame_number / total_frames) * 100,
          total: 100,
          stage: `Extracting: ${frame_number}`,
        })
      }
    }
    on_progress?.({ current: 100, total: 100, stage: `Metadata ready` })
    return metadata
  }

  private get_file_handle(): Promise<FileHandle> {
    this.file_handle ??= open(this.file_path, `r`)
    return this.file_handle
  }

  private async read_range(start: number, end: number): Promise<Buffer> {
    const length = end - start
    if (length <= 0) return Buffer.alloc(0)
    const output = Buffer.allocUnsafe(length)
    const handle = await this.get_file_handle()
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(
        output,
        filled,
        length - filled,
        start + filled,
      )
      if (bytesRead <= 0) break
      filled += bytesRead
    }
    return filled === length ? output : output.subarray(0, filled)
  }

  private async read_frame_text(frame_number: number): Promise<string | null> {
    const offsets = this.index.offsets
    if (frame_number < 0 || frame_number + 1 >= offsets.length) return null
    const bytes = await this.read_range(
      offsets[frame_number],
      offsets[frame_number + 1],
    )
    return this.decoder.decode(bytes)
  }

  private async read_comment(frame_number: number): Promise<string> {
    const offsets = this.index.offsets
    if (frame_number < 0 || frame_number + 1 >= offsets.length) return ``
    const start = offsets[frame_number]
    const end = offsets[frame_number + 1]
    let prefix_end = Math.min(end, start + COMMENT_READ_SIZE)

    while (true) {
      const bytes = await this.read_range(start, prefix_end)
      const first_newline = bytes.indexOf(0x0a)
      const second_newline = first_newline < 0
        ? -1
        : bytes.indexOf(0x0a, first_newline + 1)
      if (first_newline >= 0 && (second_newline >= 0 || prefix_end === end)) {
        const comment_end = second_newline >= 0 ? second_newline : bytes.length
        return this.decoder.decode(bytes.subarray(first_newline + 1, comment_end)).trim()
      }
      if (prefix_end >= end) return ``
      prefix_end = Math.min(end, prefix_end + COMMENT_READ_SIZE)
    }
  }
}
