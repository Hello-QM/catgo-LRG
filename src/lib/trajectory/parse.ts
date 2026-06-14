// Parsing functions for trajectory data from various formats
// This file delegates to format-specific parsers in ./parsers/ and provides
// the main entry points: parse_trajectory_data, parse_trajectory_async, etc.
import type { AnyStructure } from '$lib'
import { is_binary } from '$lib'
import {
  COMPRESSION_EXTENSIONS_REGEX,
  CONFIG_DIRS_REGEX,
  MD_SIM_EXCLUDE_REGEX,
  TRAJ_EXTENSIONS_REGEX,
  TRAJ_FALLBACK_EXTENSIONS_REGEX,
  TRAJ_KEYWORDS_SIMPLE_REGEX,
  XDATCAR_REGEX,
} from '$lib/constants'
import { parse_xyz } from '$lib/structure/parse'
import type {
  FrameLoader,
  ParseProgress,
  TrajectoryFrame,
  TrajectoryMetadata,
  TrajectoryType,
} from './index'

// Re-export everything from parsers so existing imports from './parse' keep working
export {
  count_xyz_frames,
  convert_atomic_numbers,
  create_structure,
  create_trajectory_frame,
  get_inverse_matrix,
  INDEX_SAMPLE_RATE,
  LARGE_FILE_THRESHOLD,
  MAX_BIN_FILE_SIZE,
  MAX_METADATA_SIZE,
  MAX_SAFE_STRING_LENGTH,
  MAX_TEXT_FILE_SIZE,
  read_ndarray_from_view,
  strip_compression,
  TrajFrameReader,
} from './parsers'
export type { LoadingOptions } from './parsers'

import {
  count_xyz_frames,
  INDEX_SAMPLE_RATE,
  LARGE_FILE_THRESHOLD,
  TrajFrameReader,
} from './parsers'
import type { LoadingOptions } from './parsers'
import { parse_ase_trajectory } from './parsers/ase'
import { parse_gaussian_output } from './parsers/gaussian'
import { parse_torch_sim_hdf5 } from './parsers/hdf5'
import { parse_json_trajectory } from './parsers/json'
import { parse_lammps_dump } from './parsers/lammps'
import { parse_vasp_outcar, parse_vasp_xdatcar } from './parsers/vasp'
import { parse_xyz_trajectory } from './parsers/xyz'

// Unified format detection
const FORMAT_PATTERNS = {
  ase: (data: unknown, filename?: string) => {
    if (!filename?.toLowerCase().endsWith(`.traj`) || !(data instanceof ArrayBuffer)) {
      return false
    }
    const view = new Uint8Array(data.slice(0, 24))
    return [0x2d, 0x20, 0x6f, 0x66, 0x20, 0x55, 0x6c, 0x6d].every((byte, idx) =>
      view[idx] === byte
    )
  },

  hdf5: (data: unknown, filename?: string) => {
    const has_ext = filename?.toLowerCase().match(/\.(h5|hdf5)$/)
    if (!has_ext || !(data instanceof ArrayBuffer) || data.byteLength < 8) return false
    const signature = new Uint8Array(data.slice(0, 8))
    return [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a].every((b, idx) =>
      signature[idx] === b
    )
  },

  vasp: (data: string, filename?: string) => {
    const basename = filename?.toLowerCase().split(`/`).pop() || ``
    if (basename === `xdatcar` || basename.startsWith(`xdatcar`)) return true
    const lines = data.trim().split(/\r?\n/)
    return lines.length >= 10 &&
      lines.some((line) => line.includes(`Direct configuration=`)) &&
      !isNaN(parseFloat(lines[1])) &&
      lines.slice(2, 5).every((line) => line.trim().split(/\s+/).length === 3)
  },
  // OUTCAR with 2+ ionic steps is a trajectory; a single-step OUTCAR stays a
  // static structure (handled by the structure parser).
  outcar: (data: string, filename?: string) => {
    const basename = filename?.toLowerCase().split(`/`).pop() || ``
    const looks_outcar = basename.includes(`outcar`) ||
      (data.includes(`direct lattice vectors`) && data.includes(`TOTAL-FORCE`))
    if (!looks_outcar) return false
    let count = 0
    let idx = 0
    while (count < 2 && (idx = data.indexOf(`TOTAL-FORCE`, idx)) !== -1) { count++; idx += 11 }
    return count >= 2
  },

  xyz_multi: (data: string, filename?: string) => {
    const lower = filename?.toLowerCase() ?? ``
    const base = lower.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
    if (!/\.(xyz|extxyz)$/.test(base)) return false
    return count_xyz_frames(data) >= 2
  },

  lammps_dump: (data: string, filename?: string) => {
    const lower = filename?.toLowerCase() ?? ``
    const base = lower.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
    if (!/\.(dump|lammpstrj)$/.test(base)) return false
    return data.includes(`ITEM: TIMESTEP`) && data.includes(`ITEM: NUMBER OF ATOMS`)
  },

  gaussian_output: (data: string, filename?: string) => {
    const lower = filename?.toLowerCase() ?? ``
    const base = lower.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
    if (!/\.(out|log)$/.test(base)) return false
    // Require at least one Gaussian signature in the content
    return /Gaussian,\s*Inc\./.test(data) || /Entering Gaussian System/.test(data)
  },
} as const

// Check if file is a trajectory (supports both filename-only and content-based detection)
export function is_trajectory_file(filename: string, content?: string): boolean {
  if (CONFIG_DIRS_REGEX.test(filename)) return false
  let base_name = filename.toLowerCase()
  while (COMPRESSION_EXTENSIONS_REGEX.test(base_name)) {
    base_name = base_name.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  }

  // For xyz/extxyz files, use content-based detection if available
  if (/\.(xyz|extxyz)$/i.test(base_name)) {
    if (content) return count_xyz_frames(content) >= 2
    // Use filename-based detection for auto-render (compressed or not)
    return TRAJ_KEYWORDS_SIMPLE_REGEX.test(base_name)
  }

  // LAMMPS dump files
  if (/\.(dump|lammpstrj)$/i.test(base_name)) {
    if (content) return content.includes(`ITEM: TIMESTEP`) && content.includes(`ITEM: NUMBER OF ATOMS`)
    return true
  }

  // Gaussian output files (.out/.log) — require content signature
  if (/\.(out|log)$/i.test(base_name) && content) {
    if (/Gaussian,\s*Inc\./.test(content) || /Entering Gaussian System/.test(content)) {
      return true
    }
  }

  // vasprun.xml — trajectory if has multiple ionic steps
  if (/\.xml$/i.test(base_name)) {
    if (content) {
      // Count <calculation> occurrences — 2+ means trajectory
      let count = 0
      let idx = 0
      while (count < 2) {
        idx = content.indexOf(`<calculation>`, idx)
        if (idx === -1) break
        count++
        idx += 13
      }
      return count >= 2
    }
    return false // Without content, can't determine — treat as structure
  }

  // OUTCAR — trajectory only when it has 2+ ionic steps (else a static structure)
  if (/(^|[._-])outcar(\.|$)/i.test(base_name) || base_name === `outcar`) {
    if (content) {
      let count = 0
      let idx = 0
      while (count < 2 && (idx = content.indexOf(`TOTAL-FORCE`, idx)) !== -1) { count++; idx += 11 }
      return count >= 2
    }
    return false
  }

  // Always detect these specific trajectory formats
  if (TRAJ_EXTENSIONS_REGEX.test(base_name) || XDATCAR_REGEX.test(base_name)) return true

  // Special exclusion for generic md_simulation pattern with certain extensions
  if (MD_SIM_EXCLUDE_REGEX.test(base_name)) return false

  // .h5/.hdf5 files are always binary trajectory files
  if (/\.(h5|hdf5)$/i.test(base_name)) return true

  // For other extensions, require both keywords and specific extensions
  return TRAJ_KEYWORDS_SIMPLE_REGEX.test(base_name) &&
    TRAJ_FALLBACK_EXTENSIONS_REGEX.test(base_name)
}

// Main parsing entry point - simplified
export async function parse_trajectory_data(
  data: unknown,
  filename?: string,
): Promise<TrajectoryType> {
  if (data instanceof ArrayBuffer) {
    if (FORMAT_PATTERNS.ase(data, filename)) return parse_ase_trajectory(data, filename)
    if (FORMAT_PATTERNS.hdf5(data, filename)) {
      return await parse_torch_sim_hdf5(data, filename)
    }
    throw new Error(`Unsupported binary format${filename ? `: ${filename}` : ``}`)
  }

  if (typeof data === `string`) {
    const content = data.trim()
    if (FORMAT_PATTERNS.xyz_multi(content, filename)) return parse_xyz_trajectory(content)
    if (FORMAT_PATTERNS.vasp(content, filename)) {
      return parse_vasp_xdatcar(content, filename)
    }
    if (FORMAT_PATTERNS.outcar(content, filename)) {
      return parse_vasp_outcar(content, filename)
    }
    if (FORMAT_PATTERNS.lammps_dump(content, filename)) {
      return parse_lammps_dump(content, filename)
    }
    if (FORMAT_PATTERNS.gaussian_output(content, filename)) {
      return parse_gaussian_output(content, filename)
    }

    // vasprun.xml trajectory — convert to extxyz then parse
    if (filename?.toLowerCase().endsWith(`.xml`) && content.includes(`<modeling`)) {
      const { parse_vasprun_trajectory } = await import(`$lib/structure/parse`)
      const extxyz = parse_vasprun_trajectory(content)
      if (extxyz) return parse_xyz_trajectory(extxyz)
    }

    // Single XYZ fallback
    if (filename?.toLowerCase().match(/\.(?:xyz|extxyz)$/)) {
      try {
        const structure = parse_xyz(content)
        if (structure) {
          return {
            frames: [{ structure, step: 0, metadata: {} }],
            metadata: { source_format: `single_xyz`, frame_count: 1 },
          }
        }
      } catch { /* ignore */ }
    }

    try {
      data = JSON.parse(content)
    } catch {
      throw new Error(`Unsupported text format`)
    }
  }

  if (!data || typeof data !== `object`) throw new Error(`Invalid data format`)

  // Handle JSON formats (arrays, pymatgen, object with frames, single structure)
  return parse_json_trajectory(data as object, filename)
}

export function get_unsupported_format_message(
  filename: string,
  content: string,
): string | null {
  const lower = filename.toLowerCase()
  const formats = [
    { extensions: [`.nc`, `.netcdf`], name: `NetCDF`, tool: `MDAnalysis` },
    { extensions: [`.dcd`], name: `DCD`, tool: `MDAnalysis` },
    { extensions: [`.xtc`], name: `XTC`, tool: `MDTraj` },
    { extensions: [`.trr`], name: `TRR`, tool: `MDTraj` },
  ]

  for (const { extensions, name, tool } of formats) {
    if (extensions.some((ext) => lower.endsWith(ext))) {
      return `🚫 ${name} format not supported\nConvert with ${tool} first`
    }
  }

  return is_binary(content)
    ? `🚫 Binary format not supported${filename ? `: ${filename}` : ``}`
    : null
}

// Unified async parser with streaming support
export async function parse_trajectory_async(
  data: ArrayBuffer | string,
  filename: string,
  on_progress?: (progress: ParseProgress) => void,
  options: LoadingOptions = {},
): Promise<TrajectoryType> {
  const {
    use_indexing,
    index_sample_rate = INDEX_SAMPLE_RATE,
    extract_plot_metadata = true,
  } = options

  const update_progress = (current: number, stage: string) =>
    on_progress?.({ current, total: 100, stage })

  try {
    update_progress(0, `Detecting format...`)

    const data_size = data instanceof ArrayBuffer ? data.byteLength : data.length
    const is_large_file = data_size > LARGE_FILE_THRESHOLD
    const should_use_indexing = use_indexing ?? is_large_file

    if (is_large_file) {
      update_progress(5, `Large file detected (${Math.round(data_size / 1024 / 1024)}MB)`)
    }

    // Use indexed loading for supported large files
    if (should_use_indexing && filename.toLowerCase().match(/\.(xyz|extxyz|traj)$/)) {
      return await parse_with_unified_loader(data, filename, {
        index_sample_rate,
        extract_plot_metadata,
      }, on_progress)
    }

    // Fallback to direct parsing
    update_progress(10, `Parsing trajectory...`)
    const result = await parse_trajectory_data(data, filename)

    update_progress(100, `Complete`)
    return result
  } catch (error) {
    const error_message = error instanceof Error ? error.message : `Unknown error`
    update_progress(100, `Error: ${error_message}`)
    throw error
  }
}

// Unified frame loading using new TrajFrameReader
async function parse_with_unified_loader(
  data: string | ArrayBuffer,
  filename: string,
  options: { index_sample_rate: number; extract_plot_metadata: boolean },
  on_progress?: (progress: ParseProgress) => void,
): Promise<TrajectoryType> {
  const { index_sample_rate, extract_plot_metadata } = options
  const loader = new TrajFrameReader(filename)

  on_progress?.({ current: 10, total: 100, stage: `Counting frames...` })
  const total_frames = await loader.get_total_frames(data)

  on_progress?.({ current: 20, total: 100, stage: `Building frame index...` })
  const frame_index = await loader.build_frame_index(
    data,
    index_sample_rate,
    (progress) => {
      const adjusted = 20 + (progress.current / 100) * 30
      on_progress?.({
        current: adjusted,
        total: 100,
        stage: `Building index: ${progress.stage}`,
      })
    },
  )

  on_progress?.({ current: 50, total: 100, stage: `Loading initial frames...` })
  const initial_frame_count = Math.min(10, total_frames)
  const frame_promises = Array.from(
    { length: initial_frame_count },
    (_, idx) => loader.load_frame(data, idx),
  )
  const loaded_frames = await Promise.all(frame_promises)
  const frames = loaded_frames.filter((frame): frame is TrajectoryFrame => frame !== null)

  let plot_metadata: TrajectoryMetadata[] | undefined
  if (extract_plot_metadata) {
    on_progress?.({ current: 70, total: 100, stage: `Extracting plot metadata...` })
    try {
      plot_metadata = await loader.extract_plot_metadata(
        data,
        { sample_rate: 1 },
        (progress) => {
          const adjusted = 70 + (progress.current / 100) * 20
          on_progress?.({
            current: adjusted,
            total: 100,
            stage: `Extracting: ${progress.stage}`,
          })
        },
      )
    } catch (error) {
      console.warn(`Failed to extract plot metadata:`, error)
    }
  }

  const stage = `Ready: ${total_frames} frames indexed`
  on_progress?.({ current: 100, total: 100, stage })

  return {
    frames,
    metadata: {
      source_format: filename.toLowerCase().endsWith(`.traj`)
        ? `ase_trajectory`
        : `xyz_trajectory`,
      frame_count: total_frames,
    },
    total_frames,
    indexed_frames: frame_index,
    plot_metadata,
    is_indexed: true,
  }
}

// Factory function for frame loader (simplified)
export function create_frame_loader(filename: string): FrameLoader {
  if (!filename.toLowerCase().match(/\.(xyz|extxyz|traj)$/)) {
    throw new Error(`Unsupported format for frame loading: ${filename}`)
  }
  return new TrajFrameReader(filename)
}

// Backward compatibility exports
export const XYZFrameLoader = TrajFrameReader
export const ASEFrameLoader = TrajFrameReader

export async function load_binary_traj(
  resp: Response,
  type: string,
  fallback = false,
): Promise<ArrayBuffer | string> {
  try {
    // Read binary from a clone so the original can be used for text fallback
    return await resp.clone().arrayBuffer()
  } catch (err1) {
    if (fallback) {
      console.warn(`Binary load failed for ${type}, using text:`, err1)
      try {
        return await resp.text()
      } catch (err2) {
        console.error(`Fallback to text also failed for ${type}:`, err2)
      }
    }
    throw new Error(`Failed to load ${type} as binary: ${err1}`)
  }
}
