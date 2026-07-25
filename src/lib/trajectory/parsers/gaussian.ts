// Gaussian output trajectory parser
import type { ElementSymbol } from '$lib'
import { atomic_number_to_symbol } from '$lib/composition/parse'
import type { TrajectoryFrame, TrajectoryType } from '../index'
import { create_trajectory_frame } from './common'

// Hartree to eV conversion factor
const HARTREE_TO_EV = 27.211386245988
// Hartree/Bohr to eV/A conversion factor
const HARTREE_BOHR_TO_EV_A = 51.42206313

type GaussianGeometry = { positions: number[][]; elements: ElementSymbol[] }
type GaussianIrcRecord = {
  point: number
  path: number
  geometry: GaussianGeometry
  energy: number
}

const parse_orientation_blocks = (
  lines: string[],
  orientation: `Standard orientation:` | `Input orientation:`,
): GaussianGeometry[] => {
  const geometries: GaussianGeometry[] = []

  for (let idx = 0; idx < lines.length; idx++) {
    if (!lines[idx].includes(orientation)) continue

    const positions: number[][] = []
    const elements: ElementSymbol[] = []
    let atom_idx = idx + 5
    while (atom_idx < lines.length && !lines[atom_idx].includes(`-----`)) {
      const parts = lines[atom_idx].trim().split(/\s+/)
      if (parts.length >= 6) {
        const atomic_number = parseInt(parts[1], 10)
        elements.push((atomic_number_to_symbol[atomic_number] || `X`) as ElementSymbol)
        positions.push([
          parseFloat(parts[3]),
          parseFloat(parts[4]),
          parseFloat(parts[5]),
        ])
      }
      atom_idx++
    }
    if (positions.length > 0) geometries.push({ positions, elements })
  }

  return geometries
}

const parse_checkpoint_geometry = (content: string): GaussianGeometry | undefined => {
  const match = content.match(
    /Redundant internal coordinates[^\r\n]*\r?\n([\s\S]*?)Recover connectivity data from disk\./,
  )
  if (!match) return undefined

  const positions: number[][] = []
  const elements: ElementSymbol[] = []
  for (const line of match[1].split(/\r?\n/)) {
    const parts = line.split(`,`).map((part) => part.trim())
    const element_match = parts[0]?.match(/^([A-Za-z]{1,2})/)
    if (!element_match || parts.length < 5) continue

    const position = parts.slice(2, 5).map((value) => parseFloat(value))
    if (position.some((value) => !Number.isFinite(value))) continue
    elements.push(element_match[1] as ElementSymbol)
    positions.push(position)
  }

  return positions.length > 0 ? { positions, elements } : undefined
}

const parse_scf_energies = (content: string): number[] =>
  [...content.matchAll(
    /SCF Done:\s*E\(.+?\)\s*=\s*([-+]?\d+(?:\.\d+)?(?:[DE][-+]?\d+)?)/gi,
  )].map((match) => parseFloat(match[1].replace(/[dD]/, `E`)))

const parse_irc_reaction_coordinates = (content: string): number[] => {
  const summary = content.match(
    /Summary of reaction path following([\s\S]*?)Total number of points:/,
  )
  if (!summary) return []

  const coordinates: number[] = []
  for (const line of summary[1].split(/\r?\n/)) {
    const match = line.match(
      /^\s*\d+\s+[-+]?\d+(?:\.\d+)?(?:[DE][-+]?\d+)?\s+([-+]?\d+(?:\.\d+)?(?:[DE][-+]?\d+)?)/i,
    )
    if (match) coordinates.push(parseFloat(match[1].replace(/[dD]/, `E`)))
  }
  return coordinates
}

const parse_irc_records = (
  content: string,
  lines: string[],
): GaussianIrcRecord[] | undefined => {
  const marker_matches = [...content.matchAll(
    /Point Number:\s*(\d+)\s+Path Number:\s*(\d+)/g,
  )]
  if (marker_matches.length === 0) return undefined

  const has_input_orientation = lines.some((line) => line.includes(`Input orientation:`))
  const preferred_orientation = has_input_orientation
    ? `Input orientation:`
    : `Standard orientation:`
  const checkpoint_geometry = parse_checkpoint_geometry(content)
  const checkpoint_energy_match = content.match(
    /Energy From Chk\s*=\s*([-+]?\d+(?:\.\d+)?(?:[DE][-+]?\d+)?)/i,
  )
  const checkpoint_energy = checkpoint_energy_match
    ? parseFloat(checkpoint_energy_match[1].replace(/[dD]/, `E`))
    : undefined
  const irc_start = content.lastIndexOf(`IRC-IRC-IRC-`, marker_matches[0].index)

  const records: GaussianIrcRecord[] = []
  for (let idx = 0; idx < marker_matches.length; idx++) {
    const marker = marker_matches[idx]
    const previous_marker = marker_matches[idx - 1]
    const interval_start = previous_marker?.index === undefined
      ? Math.max(0, irc_start)
      : previous_marker.index + previous_marker[0].length
    if (marker.index === undefined) return undefined

    const interval = content.slice(interval_start, marker.index)
    const point = Number(marker[1])
    const path = Number(marker[2])
    const geometry = parse_orientation_blocks(
      interval.split(/\r?\n/),
      preferred_orientation,
    ).at(-1) ?? (point === 0 ? checkpoint_geometry : undefined)
    const energy = parse_scf_energies(interval).at(-1)
      ?? (point === 0 ? checkpoint_energy : undefined)
    if (!geometry || energy === undefined || (path !== 1 && path !== 2)) return undefined

    records.push({ point, path, geometry, energy })
  }

  return records
}

const parse_gaussian_irc = (
  content: string,
  lines: string[],
  filename?: string,
): TrajectoryType | undefined => {
  if (!content.includes(`IRC-IRC-IRC-`)) return undefined

  const records = parse_irc_records(content, lines)
  if (!records) return undefined

  // IRC output is written as Path 1 from TS outward, followed by Path 2 from
  // TS outward. A physical trajectory must instead run endpoint -> TS -> endpoint.
  const path_one = records.filter(({ path }) => path === 1)
  const path_two = records.filter(({ path }) => path === 2)
  if (path_one.length + path_two.length !== records.length) return undefined

  const ordered_records = [...path_two.reverse(), ...path_one]
  const point_count = records.length
  const reaction_coordinates = parse_irc_reaction_coordinates(content)

  const frames = ordered_records.map((record, step) => {
    const metadata: Record<string, unknown> = {
      energy: record.energy * HARTREE_TO_EV,
      irc_path: record.path,
      irc_point: record.point,
      is_transition_state: record.point === 0,
    }
    if (reaction_coordinates.length === point_count) {
      metadata.reaction_coordinate = reaction_coordinates[step]
    }

    return create_trajectory_frame(
      record.geometry.positions,
      record.geometry.elements,
      undefined,
      undefined,
      step,
      metadata,
    )
  })

  return {
    frames,
    metadata: {
      source_format: `gaussian_output`,
      calculation_type: `irc`,
      frame_count: frames.length,
      total_atoms: frames[0]?.structure.sites.length || 0,
      filename,
    },
  }
}

export const parse_gaussian_output = (content: string, filename?: string): TrajectoryType => {
  const lines = content.split(/\r?\n/)
  const irc_trajectory = parse_gaussian_irc(content, lines, filename)
  if (irc_trajectory) return irc_trajectory

  // Pass 1: collect all data separately
  const energies = parse_scf_energies(content)
  const max_forces: number[] = []
  const rms_forces: number[] = []
  const geometries: { positions: number[][]; elements: ElementSymbol[] }[] = []
  const has_standard_orientation = lines.some((line) => line.includes(`Standard orientation:`))

  let idx = 0
  while (idx < lines.length) {
    const line = lines[idx]

    // Force convergence (Maximum Force / RMS Force lines with values)
    if (line.includes(`Maximum Force`) && !line.includes(`Threshold`)) {
      const m = line.match(/Maximum Force\s+([\d.]+)\s+([\d.]+)/)
      if (m) max_forces.push(parseFloat(m[1]))
    }
    if (line.includes(`RMS     Force`) && !line.includes(`Threshold`)) {
      const m = line.match(/RMS     Force\s+([\d.]+)\s+([\d.]+)/)
      if (m) rms_forces.push(parseFloat(m[1]))
    }

    // Prefer Standard orientation; only use Input orientation when no Standard block exists.
    const is_geometry_orientation = has_standard_orientation
      ? line.includes(`Standard orientation:`)
      : line.includes(`Input orientation:`)
    if (is_geometry_orientation) {
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
