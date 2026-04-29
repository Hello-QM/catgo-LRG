// Gaussian output trajectory parser
import type { ElementSymbol } from '$lib'
import { atomic_number_to_symbol } from '$lib/composition/parse'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

// Hartree to eV conversion factor
const HARTREE_TO_EV = 27.211386245988
// Hartree/Bohr to eV/A conversion factor
const HARTREE_BOHR_TO_EV_A = 51.42206313

export const parse_gaussian_output = (content: string, filename?: string): TrajectoryType => {
  const lines = content.split(/\r?\n/)

  // Pass 1: collect all data separately
  const energies: number[] = []
  const max_forces: number[] = []
  const rms_forces: number[] = []
  const geometries: { positions: number[][]; elements: ElementSymbol[] }[] = []

  let idx = 0
  while (idx < lines.length) {
    const line = lines[idx]

    // SCF energy
    if (line.includes(`SCF Done`)) {
      const m = line.match(/=\s+([-+]?\d+\.\d+)/)
      if (m) energies.push(parseFloat(m[1]))
    }

    // Force convergence (Maximum Force / RMS Force lines with values)
    if (line.includes(`Maximum Force`) && !line.includes(`Threshold`)) {
      const m = line.match(/Maximum Force\s+([\d.]+)\s+([\d.]+)/)
      if (m) max_forces.push(parseFloat(m[1]))
    }
    if (line.includes(`RMS     Force`) && !line.includes(`Threshold`)) {
      const m = line.match(/RMS     Force\s+([\d.]+)\s+([\d.]+)/)
      if (m) rms_forces.push(parseFloat(m[1]))
    }

    // Geometry blocks: "Standard orientation:" or "Input orientation:"
    if (line.includes(`Standard orientation:`) || line.includes(`Input orientation:`)) {
      const atom_start = idx + 5 // skip header (dashes, columns, dashes)
      const positions: number[][] = []
      const elements: ElementSymbol[] = []
      let j = atom_start
      while (j < lines.length && !lines[j].includes(`-----`)) {
        const parts = lines[j].trim().split(/\s+/)
        if (parts.length >= 6) {
          const anum = parseInt(parts[1], 10)
          const sym = (atomic_number_to_symbol[anum] || `X`) as ElementSymbol
          elements.push(sym)
          positions.push([parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5])])
        }
        j++
      }
      if (positions.length > 0) {
        geometries.push({ positions, elements })
      }
    }

    idx++
  }

  if (geometries.length === 0) {
    throw new Error(`No geometry found in Gaussian output`)
  }

  // Pass 2: associate data with frames
  // Gaussian output order: geometry[i] -> SCF energy[i] -> forces[i] -> geometry[i+1]
  // So energies[i] and forces[i] belong to geometry[i], but there may be
  // more geometries than forces (initial geometry has no preceding forces)
  const frames: TrajectoryFrame[] = geometries.map((geom, step) => {
    const metadata: Record<string, unknown> = {}

    // Energy: use latest available (handles multiple SCF cycles per geometry)
    if (step < energies.length) {
      metadata.energy = energies[step] * HARTREE_TO_EV
    }

    // Forces: typically N geometries but N-1 force entries (initial has none)
    // forces[i] belongs to geometry[i] (forces computed on that geometry)
    if (step < max_forces.length) {
      metadata.force_max = max_forces[step] * HARTREE_BOHR_TO_EV_A
    }
    if (step < rms_forces.length) {
      metadata.force_rms = rms_forces[step] * HARTREE_BOHR_TO_EV_A
    }

    return create_trajectory_frame(
      geom.positions,
      geom.elements,
      undefined, // no lattice (molecular calc)
      undefined,
      step,
      metadata,
    )
  })

  return {
    frames,
    metadata: {
      source_format: `gaussian_output`,
      frame_count: frames.length,
      total_atoms: frames[0]?.structure.sites.length || 0,
      filename,
    },
  }
}
