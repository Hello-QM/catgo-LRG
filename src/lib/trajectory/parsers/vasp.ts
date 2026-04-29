// VASP XDATCAR trajectory parser
import type { ElementSymbol, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

export const parse_vasp_xdatcar = (content: string, filename?: string): TrajectoryType => {
  const lines = content.trim().split(/\r?\n/)
  if (lines.length < 10) throw new Error(`XDATCAR file too short`)

  const scale = parseFloat(lines[1])
  if (isNaN(scale)) throw new Error(`Invalid scale factor`)

  const lattice_matrix = lines.slice(2, 5).map((line) =>
    line.trim().split(/\s+/).map((x) => parseFloat(x) * scale)
  ) as Matrix3x3

  const element_names = lines[5].trim().split(/\s+/)
  const element_counts = lines[6].trim().split(/\s+/).map(Number)
  const elements: ElementSymbol[] = element_names.flatMap((name, idx) =>
    Array(element_counts[idx]).fill(name as ElementSymbol)
  )

  const frames: TrajectoryFrame[] = []
  let line_idx = 7

  while (line_idx < lines.length) {
    const config_line = lines.find((line, idx) =>
      idx >= line_idx && line.includes(`Direct configuration=`)
    )
    if (!config_line) break

    line_idx = lines.indexOf(config_line) + 1
    const step_match = config_line.match(/configuration=\s*(\d+)/)
    const step = step_match ? parseInt(step_match[1]) : frames.length + 1

    const positions = []
    for (let idx = 0; idx < elements.length && line_idx < lines.length; idx++) {
      const coords = lines[line_idx].trim().split(/\s+/).slice(0, 3).map(Number)
      if (coords.length === 3 && !coords.some(isNaN)) {
        positions.push(
          math.mat3x3_vec3_multiply(
            math.transpose_3x3_matrix(lattice_matrix),
            coords as Vec3,
          ),
        )
      }
      line_idx++
    }

    if (positions.length === elements.length) {
      frames.push(create_trajectory_frame(
        positions,
        elements,
        lattice_matrix,
        [true, true, true],
        step,
        { volume: math.calc_lattice_params(lattice_matrix).volume },
      ))
    }
  }

  return {
    frames,
    metadata: {
      filename,
      source_format: `vasp_xdatcar`,
      frame_count: frames.length,
      total_atoms: elements.length,
      periodic_boundary_conditions: [true, true, true],
      elements: element_names,
      element_counts,
    },
  }
}
