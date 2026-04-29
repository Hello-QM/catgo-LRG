/**
 * LAMMPS input file generation (local fallback).
 */
import type { AnyStructure, PymatgenStructure } from '$lib'
import { ATOMIC_WEIGHTS_SMALL, type FixAtomParams } from './common-export'

// ====== LAMMPS Stage Types ======
export type LmpStageType = 'minimize' | 'nve' | 'nvt' | 'npt' | 'temp' | 'deform' | 'press' | 'vac'

export type LmpStage = {
  id: number
  stage_type: LmpStageType
  run_steps: number
  temperature?: number
  pressure?: number
  tdamp?: number
  pdamp?: number
  temp_start?: number
  temp_end?: number
  deform_rate?: [number, number, number]
  target_pressure?: number
  vacancy_index?: number
}

export const LMP_STAGE_PRESETS = [
  { name: 'Minimize', type: 'minimize' as LmpStageType, default_steps: 1000 },
  { name: 'NVT', type: 'nvt' as LmpStageType, default_steps: 5000 },
  { name: 'NPT', type: 'npt' as LmpStageType, default_steps: 5000 },
  { name: 'NVE', type: 'nve' as LmpStageType, default_steps: 5000 },
  { name: 'Temp Ramp', type: 'temp' as LmpStageType, default_steps: 5000 },
  { name: 'Deform', type: 'deform' as LmpStageType, default_steps: 5000 },
  { name: 'Press', type: 'press' as LmpStageType, default_steps: 5000 },
] as const

export function make_lmp_preset(preset: 'equil' | 'anneal' | 'melt-quench'): { stages: LmpStage[]; next_id: number } {
  let stages: LmpStage[]
  if (preset === 'equil') {
    stages = [
      { id: 1, stage_type: 'minimize', run_steps: 1000 },
      { id: 2, stage_type: 'nvt', run_steps: 5000, temperature: 300, tdamp: 100 },
      { id: 3, stage_type: 'npt', run_steps: 5000, temperature: 300, pressure: 1.0, tdamp: 100, pdamp: 1000 }
    ]
  } else if (preset === 'anneal') {
    stages = [
      { id: 1, stage_type: 'minimize', run_steps: 1000 },
      { id: 2, stage_type: 'nvt', run_steps: 5000, temperature: 300, tdamp: 100 },
      { id: 3, stage_type: 'temp', run_steps: 10000, temp_start: 300, temp_end: 800, tdamp: 100 },
      { id: 4, stage_type: 'nvt', run_steps: 5000, temperature: 800, tdamp: 100 },
      { id: 5, stage_type: 'temp', run_steps: 10000, temp_start: 800, temp_end: 300, tdamp: 100 }
    ]
  } else {
    stages = [
      { id: 1, stage_type: 'nvt', run_steps: 5000, temperature: 300, tdamp: 100 },
      { id: 2, stage_type: 'nvt', run_steps: 20000, temperature: 2500, tdamp: 100 },
      { id: 3, stage_type: 'nvt', run_steps: 20000, temperature: 300, tdamp: 100 }
    ]
  }
  return { stages, next_id: stages.length + 1 }
}

export interface LammpsLocalParams {
  prefix: string
  units: 'metal' | 'real' | 'lj'
  atom_style: 'atomic' | 'charge'
  boundary: string
  simulation_type: 'minimize' | 'nve' | 'nvt' | 'npt'
  pair_style: string
  pair_coeff: string
  min_style: string
  etol: number
  ftol: number
  maxiter: number
  timestep: number
  temperature: number
  pressure: number
  run_steps: number
  tdamp: number
  pdamp: number
  thermo_freq: number
  dump_freq: number
  unique_elements: string[]
}

export function gen_lammps_local(
  structure: AnyStructure,
  params: LammpsLocalParams,
  fix_params: FixAtomParams,
): { input: string; data: string } {
  if (!structure) return { input: '', data: '' }
  const n = structure.sites?.length || 0, nt = params.unique_elements.length
  const e2t: Record<string, number> = {}; params.unique_elements.forEach((e, i) => e2t[e] = i + 1)
  const aw = ATOMIC_WEIGHTS_SMALL
  // Data
  const dl: string[] = [`# LAMMPS data for ${params.prefix}`, '', `${n} atoms`, `${nt} atom types`, '']
  if ((structure as PymatgenStructure).lattice?.matrix) {
    const m = (structure as PymatgenStructure).lattice.matrix
    const a = m[0], b = m[1], c = m[2]

    const xhi = Math.sqrt(a[0]**2 + a[1]**2 + a[2]**2)
    const xy = (b[0]*a[0] + b[1]*a[1] + b[2]*a[2]) / xhi
    const yhi = Math.sqrt(b[0]**2 + b[1]**2 + b[2]**2 - xy**2)
    const xz = (c[0]*a[0] + c[1]*a[1] + c[2]*a[2]) / xhi
    const yz = (b[0]*c[0] + b[1]*c[1] + b[2]*c[2] - xy*xz) / yhi
    const zhi = Math.sqrt(c[0]**2 + c[1]**2 + c[2]**2 - xz**2 - yz**2)

    const isTriclinic = Math.abs(xy) > 1e-8 || Math.abs(xz) > 1e-8 || Math.abs(yz) > 1e-8

    dl.push(`0.0 ${xhi.toFixed(10)} xlo xhi`)
    dl.push(`0.0 ${yhi.toFixed(10)} ylo yhi`)
    dl.push(`0.0 ${zhi.toFixed(10)} zlo zhi`)

    if (isTriclinic) {
      dl.push(`${xy.toFixed(10)} ${xz.toFixed(10)} ${yz.toFixed(10)} xy xz yz`)
    }
  }
  dl.push('', 'Masses', '')
  params.unique_elements.forEach((e, i) => dl.push(`${i+1} ${(aw[e]||1).toFixed(4)} # ${e}`))
  dl.push('', 'Atoms # atomic', '')

  // Transform coordinates to LAMMPS system for triclinic cells
  const hasLattice = (structure as PymatgenStructure).lattice?.matrix
  let transformMatrix: number[][] | null = null
  if (hasLattice) {
    const m = (structure as PymatgenStructure).lattice.matrix
    const a = m[0], b = m[1], c = m[2]

    const xhi = Math.sqrt(a[0]**2 + a[1]**2 + a[2]**2)
    const xy = (b[0]*a[0] + b[1]*a[1] + b[2]*a[2]) / xhi
    const yhi = Math.sqrt(b[0]**2 + b[1]**2 + b[2]**2 - xy**2)
    const xz = (c[0]*a[0] + c[1]*a[1] + c[2]*a[2]) / xhi
    const yz = (b[0]*c[0] + b[1]*c[1] + b[2]*c[2] - xy*xz) / yhi

    transformMatrix = [
      [1/xhi, -xy/(xhi*yhi), 0],
      [0, 1/yhi, 0],
      [0, -yz/(yhi*yhi), 1/Math.sqrt(c[0]**2 + c[1]**2 + c[2]**2 - xz**2 - yz**2)]
    ]
  }

  structure.sites?.forEach((s, i) => {
    const e = s.species?.[0]?.element || 'X', [x, y, z] = s.xyz || [0, 0, 0]
    let lx = x, ly = y, lz = z
    if (transformMatrix) {
      lx = transformMatrix[0][0]*x + transformMatrix[0][1]*y + transformMatrix[0][2]*z
      ly = transformMatrix[1][0]*x + transformMatrix[1][1]*y + transformMatrix[1][2]*z
      lz = transformMatrix[2][0]*x + transformMatrix[2][1]*y + transformMatrix[2][2]*z
    }
    dl.push(`${i+1} ${e2t[e]||1} ${lx.toFixed(10)} ${ly.toFixed(10)} ${lz.toFixed(10)}`)
  })
  // Input
  const il: string[] = [`# LAMMPS input for ${params.prefix}`, '', `units ${params.units}`, `atom_style ${params.atom_style}`, `boundary ${params.boundary}`, '', `read_data ${params.prefix}.data`, '', `pair_style ${params.pair_style}`, params.pair_coeff ? `pair_coeff ${params.pair_coeff}` : `pair_coeff * * <POTENTIAL> ${params.unique_elements.join(' ')}`, '', 'neighbor 2.0 bin', 'neigh_modify every 1 delay 0 check yes', '']
  const fixed = new Set<number>()
  if (fix_params.fix_mode === 'selected') fix_params.selected_indices.forEach(i => fixed.add(i))
  else if (fix_params.fix_mode === 'z_below') structure.sites?.forEach((s, i) => { if (s.xyz && s.xyz[2] < fix_params.fix_z_threshold) fixed.add(i) })
  fix_params.constrained_atoms_info.details.forEach(d => fixed.add(d.idx))
  if (fixed.size > 0) {
    const sortedIds = [...fixed].map(i => i + 1).sort((a, b) => a - b)
    const chunkSize = 20
    il.push(`# Fixed atoms: ${sortedIds.length} atoms`)
    for (let i = 0; i < sortedIds.length; i += chunkSize) {
      const chunk = sortedIds.slice(i, i + chunkSize)
      il.push(`group fixed id ${chunk.join(' ')}`)
    }
    il.push('group mobile subtract all fixed', '')
  }
  il.push(`thermo ${params.thermo_freq}`, 'thermo_style custom step temp pe ke etotal press vol', '')
  if (params.simulation_type === 'minimize') {
    il.push(`min_style ${params.min_style}`)
    if (fixed.size > 0) il.push('fix freeze fixed setforce 0.0 0.0 0.0')
    il.push(`minimize ${params.etol} ${params.ftol} ${params.maxiter} ${params.maxiter*10}`)
  } else {
    il.push(`timestep ${params.timestep}`)
    if (params.simulation_type !== 'nve') il.push(`velocity all create ${params.temperature} 12345 dist gaussian`)
    il.push(`dump 1 all custom ${params.dump_freq} ${params.prefix}.dump id type x y z`)
    const g = fixed.size > 0 ? 'mobile' : 'all'
    if (fixed.size > 0) il.push('fix freeze fixed setforce 0.0 0.0 0.0')
    if (params.simulation_type === 'nvt') il.push(`fix 1 ${g} nvt temp ${params.temperature} ${params.temperature} ${params.tdamp}`)
    else if (params.simulation_type === 'npt') il.push(`fix 1 ${g} npt temp ${params.temperature} ${params.temperature} ${params.tdamp} iso ${params.pressure} ${params.pressure} ${params.pdamp}`)
    else il.push('fix 1 all nve')
    il.push(`run ${params.run_steps}`)
  }
  il.push('', `write_data ${params.prefix}_final.data`)
  return { input: il.join('\n'), data: dl.join('\n') }
}
