// VASP XDATCAR trajectory parser
import type { ElementSymbol, Pbc, Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

// A parsed XDATCAR header block: scale, lattice (already scaled), element
// names + counts. NPT runs repeat this block before every frame; constant-cell
// runs write it only once at the top.
interface XdatcarHeader {
  lattice: Matrix3x3
  element_names: string[]
  element_counts: number[]
  elements: ElementSymbol[]
}

const WHITESPACE = /\s+/

/** Parse one 3x3 lattice from `lines[start..start+3]`, multiplied by `scale`. */
function parse_lattice(lines: string[], start: number, scale: number): Matrix3x3 {
  const m: number[][] = []
  for (let r = 0; r < 3; r++) {
    const parts = lines[start + r].trim().split(WHITESPACE)
    m.push([
      parseFloat(parts[0]) * scale,
      parseFloat(parts[1]) * scale,
      parseFloat(parts[2]) * scale,
    ])
  }
  return m as Matrix3x3
}

/**
 * Parse a header block starting at `line_idx` (the title line). Returns the
 * header plus the index of the line immediately after the counts line, or
 * null if the block at `line_idx` is not a valid header (so the caller can
 * tell a "frame separator" from a "repeated NPT header").
 *
 *   line_idx       : title (free text)
 *   line_idx + 1   : scale factor (single float)
 *   line_idx + 2..4: lattice vectors
 *   line_idx + 5   : element names (e.g. "O H")
 *   line_idx + 6   : element counts (e.g. "64 128")
 */
function parse_header(lines: string[], line_idx: number): { header: XdatcarHeader; next: number } | null {
  if (line_idx + 6 >= lines.length) return null
  const scale = parseFloat(lines[line_idx + 1])
  if (!Number.isFinite(scale)) return null

  // Lattice rows must be three numeric triples.
  for (let r = 2; r <= 4; r++) {
    const parts = lines[line_idx + r].trim().split(WHITESPACE)
    if (parts.length < 3 || parts.slice(0, 3).some((p) => !Number.isFinite(parseFloat(p)))) {
      return null
    }
  }
  const lattice = parse_lattice(lines, line_idx + 2, scale)

  const element_names = lines[line_idx + 5].trim().split(WHITESPACE)
  const element_counts = lines[line_idx + 6].trim().split(WHITESPACE).map(Number)
  // Counts line must be all positive integers and match the names count.
  if (
    element_names.length === 0 ||
    element_counts.length !== element_names.length ||
    element_counts.some((c) => !Number.isInteger(c) || c <= 0)
  ) {
    return null
  }

  const elements: ElementSymbol[] = element_names.flatMap((name, idx) =>
    Array(element_counts[idx]).fill(name as ElementSymbol)
  )
  return { header: { lattice, element_names, element_counts, elements }, next: line_idx + 7 }
}

export const parse_vasp_xdatcar = (content: string, filename?: string): TrajectoryType => {
  const lines = content.split(/\r?\n/)
  if (lines.length < 8) throw new Error(`XDATCAR file too short`)

  // The top header is mandatory. For constant-cell runs it is the only one;
  // for NPT runs an identical block precedes every "configuration=" line, and
  // we re-read it each time so the per-frame cell is honored instead of being
  // silently dropped.
  const top = parse_header(lines, 0)
  if (!top) throw new Error(`XDATCAR: could not parse header (scale / lattice / element lines)`)

  const pbc: Pbc = [true, true, true]
  const frames: TrajectoryFrame[] = []
  const warnings: string[] = []

  // Cache the transpose per distinct lattice. Coordinates are fractional and
  // converted via `frac · latticeᵀ`; recomputing the transpose for every atom
  // (the old code's hot-loop cost) is pure waste when the cell is constant.
  let active = top.header
  let active_lattice_T = math.transpose_3x3_matrix(active.lattice)

  let i = top.next
  let auto_step = 0

  // Single forward pass — O(total lines). Each iteration either consumes a
  // repeated NPT header or one configuration block. No re-scanning from the
  // top (the old find()/indexOf() made this O(frames × lines) and could jump
  // back to the first frame when two configuration lines were identical).
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === ``) { i++; continue }

    // NPT: a repeated header block appears before the next configuration line.
    // Detect it in place (no rescan) by trying to parse a header right here.
    if (!line.includes(`configuration=`)) {
      const rep = parse_header(lines, i)
      if (rep) {
        active = rep.header
        active_lattice_T = math.transpose_3x3_matrix(active.lattice)
        i = rep.next
        continue
      }
      // Not a header and not a configuration line — skip stray line.
      i++
      continue
    }

    // Configuration line: read the next n_atoms coordinate lines.
    const step_match = line.match(/configuration=\s*(\d+)/)
    const step = step_match ? parseInt(step_match[1], 10) : auto_step + 1
    auto_step = step
    i++

    const n_atoms = active.elements.length
    const positions: number[][] = []
    for (let a = 0; a < n_atoms; a++) {
      if (i >= lines.length) break
      const parts = lines[i].trim().split(WHITESPACE)
      i++
      if (parts.length < 3) continue
      const fx = parseFloat(parts[0])
      const fy = parseFloat(parts[1])
      const fz = parseFloat(parts[2])
      if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) continue
      positions.push(
        math.mat3x3_vec3_multiply(active_lattice_T, [fx, fy, fz] as Vec3),
      )
    }

    if (positions.length === n_atoms) {
      frames.push(create_trajectory_frame(
        positions,
        active.elements,
        active.lattice,
        pbc,
        step,
        { volume: math.calc_lattice_params(active.lattice).volume },
      ))
    } else if (positions.length > 0) {
      // Don't silently drop a short frame — surface it so the user knows the
      // file was truncated rather than seeing a frame count that's quietly off.
      warnings.push(`frame ${step}: expected ${n_atoms} atoms, got ${positions.length} (truncated?)`)
    }
  }

  if (frames.length === 0) {
    throw new Error(`XDATCAR: no configuration frames found`)
  }

  return {
    frames,
    metadata: {
      filename,
      source_format: `vasp_xdatcar`,
      frame_count: frames.length,
      total_atoms: top.header.elements.length,
      periodic_boundary_conditions: pbc,
      elements: top.header.element_names,
      element_counts: top.header.element_counts,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  }
}
