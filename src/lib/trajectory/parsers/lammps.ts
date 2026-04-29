// LAMMPS dump trajectory parser
import type { ElementSymbol, Pbc } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

export const parse_lammps_dump = (content: string, filename?: string): TrajectoryType => {
  const lines = content.trim().split(/\r?\n/)
  const frames: TrajectoryFrame[] = []
  let i = 0
  let frame_number = 0

  // Helper to parse atom types to element symbols
  // LAMMPS uses numeric types; we'll map common ones
  const type_to_element: Record<number, ElementSymbol> = {
    1: `H`, 2: `He`, 3: `Li`, 4: `Be`, 5: `B`, 6: `C`, 7: `N`, 8: `O`, 9: `F`, 10: `Ne`,
    11: `Na`, 12: `Mg`, 13: `Al`, 14: `Si`, 15: `P`, 16: `S`, 17: `Cl`, 18: `Ar`,
    26: `Fe`, 28: `Ni`, 29: `Cu`, 47: `Ag`, 79: `Au`,
  }

  const get_element = (atom_type: number): ElementSymbol => {
    return type_to_element[atom_type] || `X${atom_type}` as ElementSymbol
  }

  while (i < lines.length) {
    // Find ITEM: TIMESTEP
    while (i < lines.length && !lines[i]?.includes(`ITEM: TIMESTEP`)) {
      i++
    }
    if (i >= lines.length) break

    i++  // Skip "ITEM: TIMESTEP"
    if (i >= lines.length) break
    const timestep = parseInt(lines[i]?.trim() || `0`)
    i++

    // ITEM: NUMBER OF ATOMS
    while (i < lines.length && !lines[i]?.includes(`ITEM: NUMBER OF ATOMS`)) {
      i++
    }
    if (i >= lines.length) break
    i++
    const natoms = parseInt(lines[i]?.trim() || `0`)
    i++

    // ITEM: BOX BOUNDS
    let lattice_matrix: Matrix3x3 | undefined
    let pbc: Pbc | undefined
    while (i < lines.length && !lines[i]?.includes(`ITEM: BOX`)) {
      i++
    }
    if (i < lines.length) {
      i++
      // Parse box bounds (orthogonal or triclinic)
      const bounds: number[][] = []
      for (let j = 0; j < 3 && i < lines.length; j++) {
        const parts = lines[i]?.trim().split(/\s+/).map(Number) || []
        if (parts.length >= 2) {
          bounds.push(parts)
        }
        i++
      }

      // Create lattice matrix from bounds (assuming orthogonal for now)
      if (bounds.length === 3) {
        const lx = bounds[0][1] - bounds[0][0]
        const ly = bounds[1][1] - bounds[1][0]
        const lz = bounds[2][1] - bounds[2][0]
        lattice_matrix = [
          [lx, 0, 0],
          [0, ly, 0],
          [0, 0, lz],
        ]
        pbc = [true, true, true]
      }
    }

    // ITEM: ATOMS
    while (i < lines.length && !lines[i]?.includes(`ITEM: ATOMS`)) {
      i++
    }
    if (i >= lines.length) break
    i++

    // Parse atom header to get column indices
    const header_line = lines[i - 1] || ``
    const headers = header_line.replace(`ITEM: ATOMS`, ``).trim().split(/\s+/)

    // Find column indices
    const type_idx = headers.indexOf(`type`)
    const x_idx = headers.indexOf(`x`)
    const y_idx = headers.indexOf(`y`)
    const z_idx = headers.indexOf(`z`)

    // Parse atoms
    const positions: number[][] = []
    const elements: ElementSymbol[] = []

    for (let j = 0; j < natoms && i < lines.length; j++) {
      const parts = lines[i]?.trim().split(/\s+/) || []
      i++

      if (x_idx >= 0 && y_idx >= 0 && z_idx >= 0 &&
          parts.length > Math.max(x_idx, y_idx, z_idx)) {
        const x = parseFloat(parts[x_idx])
        const y = parseFloat(parts[y_idx])
        const z = parseFloat(parts[z_idx])

        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
          positions.push([x, y, z])

          // Get element from atom type
          if (type_idx >= 0) {
            const atom_type = parseInt(parts[type_idx])
            elements.push(get_element(atom_type))
          } else {
            elements.push(`X` as any)
          }
        }
      }
    }

    if (positions.length === natoms) {
      const metadata: Record<string, unknown> = { timestep }
      if (lattice_matrix) {
        metadata.volume = math.calc_lattice_params(lattice_matrix).volume
      }
      frames.push(create_trajectory_frame(
        positions,
        elements,
        lattice_matrix,
        pbc,
        frame_number,
        metadata,
      ))
      frame_number++
    }
  }

  return {
    frames,
    metadata: {
      filename,
      source_format: `lammps_dump`,
      frame_count: frames.length,
      total_atoms: frames[0]?.structure.sites.length || 0,
      periodic_boundary_conditions: (frames[0]?.structure as any)?.lattice ? [true, true, true] : [false, false, false],
    },
  }
}
