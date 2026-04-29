/**
 * ORCA input file generation.
 */
import type { AnyStructure } from '$lib'

export const BASIS_SET_RECOMMENDATIONS: Record<string, Record<'economy' | 'production', string>> = {
  'DFT (geometry)': { economy: 'def2-SVP', production: 'def2-TZVP' },
  'DFT (energy)': { economy: 'def2-TZVP', production: 'def2-QZVP' },
  'MP2': { economy: 'cc-pVDZ', production: 'cc-pVTZ' },
  'CCSD(T)': { economy: 'cc-pVTZ', production: 'cc-pVQZ' },
  'F12': { economy: 'cc-pVDZ-F12', production: 'cc-pVTZ-F12' },
  'Heavy elements': { economy: 'SARC-ZORA-TZVP', production: 'SARC2-ZORA-QZVP' },
}

export interface OrcaParams {
  run_type: string
  method: string
  functional: string
  functional_custom: string
  wavefunction: string
  uno_enabled: boolean
  uco_enabled: boolean
  basis: string
  charge: number
  multiplicity: number
  opt_convergence: string
  use_cartesian: boolean
  frozen_mode: 'none' | 'selected' | 'z_below'
  frozen_z: number
  md_initvel: number
  md_run: number
  cim_method: string
  cim_thresh: number
  selected_indices: number[]
}

export function gen_orca_input(structure: AnyStructure, params: OrcaParams): string {
  if (!structure) return ''

  const lines: string[] = []
  const keywords: string[] = [params.run_type]

  if (params.run_type === 'CIM') {
    keywords.push(params.cim_method)
    keywords.push('cc-pVDZ')
    keywords.push('cc-pVDZ/C')
  } else {
    if (params.method === 'DFT') {
      const functional = params.functional === 'other' ? params.functional_custom : params.functional
      if (functional) keywords.push(functional)
      if (params.wavefunction) keywords.push(params.wavefunction)
    } else {
      keywords.push(params.method)
      if (params.wavefunction) keywords.push(params.wavefunction)
    }

    if (params.basis) keywords.push(params.basis)

    if (params.uno_enabled) keywords.push('UNO')
    if (params.uco_enabled) keywords.push('UCO')

    if (params.run_type === 'Opt') {
      if (params.opt_convergence && params.opt_convergence !== 'Opt') {
        keywords.push(params.opt_convergence)
      }
      if (params.use_cartesian) keywords.push('COpt')
    }
  }

  lines.push(`! ${keywords.join(' ')}`)
  lines.push('')

  if (params.run_type === 'MD') {
    lines.push('%md')
    lines.push(`  Initvel ${params.md_initvel}_K`)
    lines.push(`  Run ${params.md_run}`)
    lines.push('end')
    lines.push('')
  }

  if (params.run_type === 'CIM') {
    lines.push('%cim')
    lines.push(`  CIMTHRESH ${params.cim_thresh}`)
    lines.push('end')
    lines.push('')
  }

  lines.push(`* xyz ${params.charge} ${params.multiplicity}`)

  const sites = structure.sites || []
  for (const site of sites) {
    const el = site.species?.[0]?.element || 'X'
    const [x, y, z] = site.xyz || [0, 0, 0]
    lines.push(`${el}    ${x.toFixed(6)}    ${y.toFixed(6)}    ${z.toFixed(6)}`)
  }

  if ((params.run_type === 'Opt' || params.run_type === 'MD') && params.frozen_mode !== 'none') {
    const frozen_indices = new Set<number>()

    if (params.frozen_mode === 'selected') {
      params.selected_indices.forEach(i => frozen_indices.add(i))
    } else if (params.frozen_mode === 'z_below') {
      sites.forEach((s, i) => {
        if (s.xyz && s.xyz[2] < params.frozen_z) frozen_indices.add(i)
      })
    }

    if (frozen_indices.size > 0) {
      lines.push('  > Constraints')
      for (const idx of Array.from(frozen_indices).sort((a, b) => a - b)) {
        lines.push(`    { C ${idx} C }`)
      }
      lines.push('  end')
    }
  }

  lines.push('*')

  return lines.join('\n')
}
