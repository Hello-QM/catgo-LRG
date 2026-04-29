// Multi-frame XYZ / extended XYZ trajectory parser
import type { ElementSymbol } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

export const parse_xyz_trajectory = (content: string): TrajectoryType => {
  const lines = content.trim().split(/\r?\n/)
  const frames: TrajectoryFrame[] = []
  let line_idx = 0

  while (line_idx < lines.length) {
    if (!lines[line_idx]?.trim()) {
      line_idx++
      continue
    }

    const num_atoms = parseInt(lines[line_idx].trim(), 10)
    if (isNaN(num_atoms) || num_atoms <= 0 || line_idx + num_atoms + 1 >= lines.length) {
      line_idx++
      continue
    }

    const comment = lines[++line_idx] || ``
    const metadata: Record<string, unknown> = {}

    // Extract properties efficiently. `\b` word boundaries are critical for
    // the single-letter aliases (E/V/P/T) — without them, `/E.../i` matches
    // the `e` inside "time" in CP2K-style comment lines like
    // `i = 0, time = 0.000, E = -4905.91...` and captures `0.000` before ever
    // reaching the real energy.
    const extractors = {
      step: /\b(?:step|frame|ionic_step)\b\s*[=:]?\s*(\d+)/i,
      energy:
        /\b(?:energy|etot|total_energy|E)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      volume: /\b(?:volume|vol|V)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      pressure: /\b(?:pressure|press|P)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      temperature: /\b(?:temperature|temp|T)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      force_max:
        /\b(?:max_force|force_max|fmax)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      bandgap: /\b(?:bandgap|E_gap|gap)\b\s*[=:]?\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
    }

    const step_match = extractors.step.exec(comment)
    const step = step_match?.[1] ? parseInt(step_match[1]) : frames.length
    Object.entries(extractors).forEach(([key, pattern]) => {
      if (key === `step`) return
      const match = pattern.exec(comment)
      if (match) metadata[key] = parseFloat(match[1])
    })

    // Extract source file path from comment field (used for push-back to remote)
    const source_file_match = comment.match(/comment\s*=\s*"([^"]+)"/i)
    if (source_file_match) {
      metadata.source_file = source_file_match[1]
    }

    // Extract lattice matrix
    const lattice_match = comment.match(/Lattice\s*=\s*"([^"]+)"/i)
    let lattice_matrix: Matrix3x3 | undefined
    if (lattice_match) {
      const values = lattice_match[1].split(/\s+/).map(Number)
      if (values.length === 9) {
        lattice_matrix = [[values[0], values[1], values[2]], [
          values[3],
          values[4],
          values[5],
        ], [values[6], values[7], values[8]]]
        metadata.volume = math.calc_lattice_params(lattice_matrix).volume
      }
    }

    // Parse atoms
    const positions: number[][] = []
    const elements: ElementSymbol[] = []
    const forces: number[][] = []
    const has_forces = comment.includes(`forces:R:3`)

    for (let i = 0; i < num_atoms && ++line_idx < lines.length; i++) {
      const parts = lines[line_idx].trim().split(/\s+/)
      if (parts.length >= 4) {
        elements.push(parts[0] as ElementSymbol)
        positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])])

        if (has_forces && parts.length >= 7) {
          forces.push([parseFloat(parts[4]), parseFloat(parts[5]), parseFloat(parts[6])])
        }
      }
    }
    if (forces.length > 0) {
      metadata.forces = forces
      const magnitudes = forces.map((force) => Math.hypot(...force))
      metadata.force_max = Math.max(...magnitudes)
      // Calculate RMS (root mean square) of force magnitudes
      metadata.force_norm = Math.sqrt(
        magnitudes.reduce((sum, mag) => sum + mag ** 2, 0) / magnitudes.length,
      )
    }
    frames.push(
      create_trajectory_frame(
        positions,
        elements,
        lattice_matrix,
        lattice_matrix ? [true, true, true] : undefined,
        step,
        metadata,
      ),
    )
    line_idx++
  }

  return {
    frames,
    metadata: {
      source_format: `xyz_trajectory`,
      frame_count: frames.length,
      total_atoms: frames[0]?.structure.sites.length || 0,
    },
  }
}
