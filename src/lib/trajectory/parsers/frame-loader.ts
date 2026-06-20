// Unified Frame Loader - handles on-demand frame loading for indexed trajectories
import type { ElementSymbol } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type {
  FrameIndex,
  FrameLoader,
  ParseProgress,
  TrajectoryFrame,
  TrajectoryMetadata,
} from '../index'
import {
  convert_atomic_numbers,
  create_trajectory_frame,
  MAX_METADATA_SIZE,
  MAX_SAFE_STRING_LENGTH,
  read_ndarray_from_view,
} from './common'

export class TrajFrameReader implements FrameLoader {
  private format: `xyz` | `ase`
  private global_numbers?: number[] // For ASE trajectories
  // Cached per-frame character offsets into the XYZ source string.
  // Length = n_frames + 1; frame i spans [offsets[i], offsets[i + 1]).
  // Built once via a single newline-walking pass (NO whole-file split),
  // then reused for counting / indexing / random frame access so large
  // trajectories never re-split the 100s-of-MB string on the main thread.
  private xyz_offsets?: number[]
  private xyz_offsets_src?: string

  constructor(private readonly filename: string) {
    this.format = filename.toLowerCase().endsWith(`.traj`) ? `ase` : `xyz`
  }

  fork(): FrameLoader {
    return new TrajFrameReader(this.filename)
  }

  /**
   * Build (and cache) frame start offsets for an XYZ string in a single pass.
   *
   * Walks line boundaries with `indexOf('\n')` instead of
   * `data.split(/\r?\n/)`, so it never allocates a multi-million-element line
   * array or copies the whole file via `.trim()`. Only the per-frame count
   * line is sliced+parsed; the comment + atom lines are skipped by offset.
   */
  private ensure_xyz_offsets(data: string): number[] {
    if (this.xyz_offsets && this.xyz_offsets_src === data) return this.xyz_offsets

    const n = data.length
    const offsets: number[] = []
    let pos = 0

    while (pos < n) {
      let nl = data.indexOf(`\n`, pos)
      if (nl === -1) nl = n
      const header = data.slice(pos, nl).trim()
      if (!header) { // blank line between frames
        pos = nl + 1
        continue
      }

      const num_atoms = parseInt(header, 10)
      if (isNaN(num_atoms) || num_atoms <= 0) { // not a frame header — skip line
        pos = nl + 1
        continue
      }

      const frame_start = pos
      // Advance over: count line + comment line + num_atoms atom lines.
      const lines_to_skip = 2 + num_atoms
      let p = pos
      let complete = true
      for (let k = 0; k < lines_to_skip; k++) {
        let e = data.indexOf(`\n`, p)
        if (e === -1) { // EOF
          if (k < lines_to_skip - 1) complete = false // truncated final frame
          p = n
          break
        }
        p = e + 1
      }
      if (!complete) break

      offsets.push(frame_start)
      pos = p
    }

    offsets.push(n) // end sentinel
    this.xyz_offsets = offsets
    this.xyz_offsets_src = data
    return offsets
  }

  // async needed to satisfy FrameLoader interface
  // deno-lint-ignore require-await
  async get_total_frames(
    data: string | ArrayBuffer,
  ): Promise<number> {
    if (this.format === `xyz`) {
      if (data instanceof ArrayBuffer) throw new Error(`XYZ loader requires text data`)
      return this.ensure_xyz_offsets(data).length - 1
    } else {
      if (!(data instanceof ArrayBuffer)) {
        throw new Error(`ASE loader requires binary data`)
      }
      const view = new DataView(data)
      return Number(view.getBigInt64(32, true)) // n_items from header
    }
  }

  async build_frame_index(
    data: string | ArrayBuffer,
    sample_rate: number,
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<FrameIndex[]> {
    const total_frames = await this.get_total_frames(data)
    const frame_index: FrameIndex[] = []

    // Progress reporter that never lets a throwing callback break indexing.
    const report = (current: number, stage: string): void => {
      if (!on_progress) return
      try {
        on_progress({ current, total: 100, stage })
      } catch {
        /* a misbehaving progress callback must not abort the index build */
      }
    }
    // ~10 updates across the run so callers always see progress climb past 0.
    const step = Math.max(1, Math.floor(total_frames / 10))

    if (this.format === `xyz`) {
      // Offsets are character indices into the source string (built once,
      // cached). `byte_offset`/`estimated_size` here carry char offset/length
      // — used only for slicing the same string and for display.
      const offsets = this.ensure_xyz_offsets(data as string)

      for (let current_frame = 0; current_frame < total_frames; current_frame++) {
        if (current_frame % sample_rate === 0) {
          frame_index.push({
            frame_number: current_frame,
            byte_offset: offsets[current_frame],
            estimated_size: offsets[current_frame + 1] - offsets[current_frame],
          })
        }
        if (current_frame % step === 0) {
          report((current_frame / total_frames) * 100, `Indexing: ${current_frame}`)
        }
      }
    } else {
      // ASE indexing
      const view = new DataView(data as ArrayBuffer)
      const offsets_pos = Number(view.getBigInt64(40, true))

      for (let i = 0; i < total_frames; i += sample_rate) {
        const frame_offset = Number(view.getBigInt64(offsets_pos + i * 8, true))
        frame_index.push({
          frame_number: i,
          byte_offset: frame_offset,
          estimated_size: 0,
        })
        if (i % step === 0) {
          report((i / total_frames) * 100, `Indexing ASE: ${i}`)
        }
      }
    }

    report(100, `Indexed ${total_frames} frames`)
    return frame_index
  }

  // async needed to satisfy FrameLoader interface
  // deno-lint-ignore require-await
  async load_frame(
    data: string | ArrayBuffer,
    frame_number: number,
  ): Promise<TrajectoryFrame | null> {
    if (this.format === `xyz`) return this.load_xyz_frame(data as string, frame_number)
    else return this.load_ase_frame(data as ArrayBuffer, frame_number)
  }

  async extract_plot_metadata(
    data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
    on_progress?: (progress: ParseProgress) => void,
  ): Promise<TrajectoryMetadata[]> {
    const { sample_rate = 1, properties } = options || {}
    const metadata_list: TrajectoryMetadata[] = []
    const total_frames = await this.get_total_frames(data)

    if (this.format === `xyz`) {
      const data_str = data as string
      const offsets = this.ensure_xyz_offsets(data_str)

      for (let current_frame = 0; current_frame < total_frames; current_frame++) {
        if (current_frame % sample_rate === 0) {
          // Comment is the 2nd line of the frame; slice just that line
          // instead of materialising the whole atom block.
          const start = offsets[current_frame]
          const first_nl = data_str.indexOf(`\n`, start)
          const second_nl = first_nl === -1
            ? -1
            : data_str.indexOf(`\n`, first_nl + 1)
          const comment = first_nl === -1
            ? ``
            : data_str.slice(first_nl + 1, second_nl === -1 ? undefined : second_nl)
              .trim()

          const frame_metadata = this.parse_xyz_metadata(comment, current_frame)

          if (properties) {
            const filtered = Object.fromEntries(
              Object.entries(frame_metadata.properties).filter(([key]) =>
                properties.includes(key)
              ),
            )
            frame_metadata.properties = filtered
          }

          metadata_list.push(frame_metadata)
        }

        if (on_progress && current_frame % 5000 === 0) {
          on_progress({
            current: (current_frame / total_frames) * 100,
            total: 100,
            stage: `Extracting: ${current_frame}`,
          })
        }
      }
    } else if (this.format === `ase`) {
      // ASE metadata extraction
      const view = new DataView(data as ArrayBuffer)
      const n_items = Number(view.getBigInt64(32, true))
      const offsets_pos = Number(view.getBigInt64(40, true))

      for (let i = 0; i < n_items; i += sample_rate) {
        try {
          const frame_offset = Number(view.getBigInt64(offsets_pos + i * 8, true))
          const json_length = Number(view.getBigInt64(frame_offset, true))

          if (json_length > MAX_METADATA_SIZE) {
            console.warn(
              `Skipping large frame ${i}: ${Math.round(json_length / 1024 / 1024)}MB`,
            )
            continue
          }

          const frame_data = JSON.parse(new TextDecoder().decode(
            new Uint8Array(data as ArrayBuffer, frame_offset + 8, json_length),
          ))

          const frame_metadata = this.parse_ase_metadata(frame_data, i)

          if (properties) {
            const filtered = Object.fromEntries(
              Object.entries(frame_metadata.properties).filter(([key]) =>
                properties.includes(key)
              ),
            )
            frame_metadata.properties = filtered
          }

          metadata_list.push(frame_metadata)

          if (on_progress && i % 5000 === 0) {
            on_progress({
              current: (i / n_items) * 100,
              total: 100,
              stage: `Extracting ASE: ${i}/${n_items}`,
            })
          }
        } catch (error) {
          console.warn(`Failed to extract metadata from ASE frame ${i}:`, error)
          continue
        }
      }
    }

    return metadata_list
  }

  private load_xyz_frame(
    data: string,
    frame_number: number,
  ): TrajectoryFrame | null {
    // O(1) random access: slice only this frame's bytes via the cached
    // offset index, then split the small chunk (not the whole file).
    const offsets = this.ensure_xyz_offsets(data)
    if (frame_number < 0 || frame_number + 1 >= offsets.length) return null

    const chunk = data.slice(offsets[frame_number], offsets[frame_number + 1])
    const lines = chunk.split(/\r?\n/)

    // First non-empty line is the atom count (offset points at it, but stay
    // defensive about stray leading blanks).
    let head = 0
    while (head < lines.length && !lines[head]?.trim()) head++
    const num_atoms = parseInt(lines[head]?.trim(), 10)
    if (isNaN(num_atoms) || head + num_atoms + 1 >= lines.length) return null

    const comment = lines[head + 1] || ``
    const positions: number[][] = []
    const elements: ElementSymbol[] = []

    for (let i = 0; i < num_atoms; i++) {
      const parts = lines[head + 2 + i]?.trim().split(/\s+/)
      if (parts?.length >= 4) {
        elements.push(parts[0] as ElementSymbol)
        positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])])
      }
    }

    const metadata = this.parse_xyz_metadata(comment, frame_number)
    return create_trajectory_frame(
      positions,
      elements,
      undefined,
      undefined,
      frame_number,
      metadata.properties,
    )
  }

  private load_ase_frame(
    data: ArrayBuffer,
    frame_number: number,
  ): TrajectoryFrame | null {
    // ASE frame loading with proper ndarray support
    try {
      const view = new DataView(data)
      const n_items = Number(view.getBigInt64(32, true))
      const offsets_pos = Number(view.getBigInt64(40, true))

      if (frame_number >= n_items) return null

      const frame_offset = Number(view.getBigInt64(offsets_pos + frame_number * 8, true))
      const json_length = Number(view.getBigInt64(frame_offset, true))

      const frame_data = JSON.parse(new TextDecoder().decode(
        new Uint8Array(data, frame_offset + 8, json_length),
      ))

      // Extract positions with proper ndarray handling
      const positions_ref = frame_data[`positions.`] || frame_data.positions
      const positions = positions_ref?.ndarray
        ? read_ndarray_from_view(view, positions_ref)
        : positions_ref as number[][]

      // Extract atomic numbers with proper ndarray handling
      const numbers_ref = frame_data[`numbers.`] || frame_data.numbers ||
        this.global_numbers
      const numbers: number[] = numbers_ref?.ndarray
        ? read_ndarray_from_view(view, numbers_ref).flat()
        : numbers_ref as number[]

      if (numbers) this.global_numbers = numbers
      if (!numbers || !positions) throw new Error(`Missing atomic numbers or positions`)

      // Extract cell and calculate volume if present
      const cell = frame_data.cell as Matrix3x3 | undefined
      const metadata: Record<string, unknown> = {
        step: frame_number,
        ...(frame_data.calculator || {}),
        ...(frame_data.info || {}),
      }

      // Calculate volume from cell matrix if available
      if (cell && Array.isArray(cell) && cell.length === 3) {
        try {
          metadata.volume = Math.abs(math.det_3x3(cell))
        } catch (error) {
          console.warn(`Failed to calculate volume for frame ${frame_number}:`, error)
        }
      }

      return create_trajectory_frame(
        positions,
        convert_atomic_numbers(numbers),
        cell,
        frame_data.pbc || [true, true, true],
        frame_number,
        metadata,
      )
    } catch (error) {
      console.warn(`Failed to load ASE frame ${frame_number}:`, error)
      return null
    }
  }

  private parse_xyz_metadata(comment: string, frame_number: number): TrajectoryMetadata {
    const properties: Record<string, number> = {}

    const patterns = {
      energy: /(?:energy|E|etot)\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      volume: /(?:volume|vol|V)\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      pressure: /(?:pressure|press|P)\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      force_max: /(?:max_force|fmax)\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
    }

    Object.entries(patterns).forEach(([key, pattern]) => {
      const match = pattern.exec(comment)
      if (match) properties[key] = parseFloat(match[1])
    })

    const step_match = comment.match(/(?:step|frame)\s*[=:]?\s*(\d+)/i)
    const step = step_match ? parseInt(step_match[1]) : frame_number

    return { frame_number, step, properties }
  }

  private parse_ase_metadata(
    frame_data: Record<string, unknown>,
    frame_number: number,
  ): TrajectoryMetadata {
    const properties: Record<string, number> = {}
    const step = frame_number

    // Extract calculator properties (energies, etc.)
    if (frame_data.calculator && typeof frame_data.calculator === `object`) {
      const calculator = frame_data.calculator as Record<string, unknown>
      const calc_properties = [
        `energy`,
        `potential_energy`,
        `kinetic_energy`,
        `total_energy`,
      ]

      for (const prop of calc_properties) {
        if (prop in calculator && typeof calculator[prop] === `number`) {
          properties[prop] = calculator[prop] as number
        }
      }
    }

    // Extract info properties (forces, stress, etc.)
    if (frame_data.info && typeof frame_data.info === `object`) {
      const info = frame_data.info as Record<string, unknown>
      const info_properties = [
        `force_max`,
        `force_norm`,
        `stress_max`,
        `stress_frobenius`,
        `pressure`,
        `temperature`,
      ]

      for (const prop of info_properties) {
        if (prop in info && typeof info[prop] === `number`) {
          properties[prop] = info[prop] as number
        }
      }
    }

    // Calculate volume from cell if present
    if (frame_data.cell && Array.isArray(frame_data.cell)) {
      const cell = frame_data.cell as number[][]
      if (cell.length === 3 && cell[0]?.length === 3) {
        try {
          properties.volume = Math.abs(math.det_3x3(cell as Matrix3x3))
        } catch (error) {
          console.warn(`Failed to calculate volume for ASE frame ${frame_number}:`, error)
        }
      }
    }

    return { frame_number, step, properties }
  }
}
