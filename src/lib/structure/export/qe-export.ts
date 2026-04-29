/**
 * Quantum ESPRESSO input file generation.
 */
import type { AnyStructure, PymatgenStructure } from '$lib'
import { ATOMIC_WEIGHTS_SMALL, build_selective_dynamics, type FixAtomParams } from './common-export'

export interface QEParams {
  calculation: 'scf' | 'relax' | 'vc-relax' | 'nscf' | 'bands'
  prefix: string
  ecutwfc: number
  ecutrho: number
  kpoints_auto: boolean
  kpoints: [number, number, number]
  kspacing: number
  degauss: number
  conv_thr: number
  forc_conv_thr: number
  press: number
  coord_type: 'crystal' | 'angstrom'
  pseudo_dir: string
  pseudopotentials: Record<string, string>
  disk_io: 'none' | 'low' | 'medium' | 'high'
  wf_collect: boolean
  tprnfor: boolean
  tstress: boolean
  unique_elements: string[]
}

export interface QEDosParams {
  prefix: string
  emin: number
  emax: number
  deltae: number
}

export function gen_qe_local(
  structure: AnyStructure,
  params: QEParams,
  fix_params: FixAtomParams,
): string {
  if (!structure) return ''
  const n = structure.sites?.length || 0, nt = params.unique_elements.length
  const lines: string[] = []
  const aw = ATOMIC_WEIGHTS_SMALL
  lines.push('&CONTROL', `   calculation = '${params.calculation}'`, `   prefix = '${params.prefix}'`, `   pseudo_dir = '${params.pseudo_dir}'`, `   outdir = './tmp/'`, `   disk_io = '${params.disk_io}'`)
  if (params.wf_collect) lines.push(`   wf_collect = .true.`)
  lines.push(`   tprnfor = ${params.tprnfor ? '.true.' : '.false.'}`, `   tstress = ${params.tstress ? '.true.' : '.false.'}`)
  if (params.calculation === 'relax' || params.calculation === 'vc-relax') lines.push(`   forc_conv_thr = ${params.forc_conv_thr.toExponential(1)}`)
  lines.push('/', '', '&SYSTEM', `   ibrav = 0`, `   nat = ${n}`, `   ntyp = ${nt}`, `   ecutwfc = ${params.ecutwfc}`, `   ecutrho = ${params.ecutrho}`, `   occupations = 'smearing'`, `   smearing = 'mv'`, `   degauss = ${params.degauss}`, '/', '', '&ELECTRONS', `   conv_thr = ${params.conv_thr.toExponential(1)}`, `   mixing_beta = 0.7`, '/', '')
  if (params.calculation === 'relax' || params.calculation === 'vc-relax') lines.push('&IONS', `   ion_dynamics = 'bfgs'`, '/', '')
  if (params.calculation === 'vc-relax') lines.push('&CELL', `   cell_dynamics = 'bfgs'`, `   press = ${params.press}`, '/', '')
  lines.push('ATOMIC_SPECIES')
  for (const el of params.unique_elements) lines.push(`   ${el} ${(aw[el] || 1).toFixed(3)} ${params.pseudopotentials[el] || `<${el}.upf>`}`)
  lines.push('', 'K_POINTS automatic', `   ${params.kpoints_auto ? '4 4 4' : params.kpoints.join(' ')}  0 0 0`, '')
  if ((structure as PymatgenStructure).lattice?.matrix) {
    lines.push('CELL_PARAMETERS {angstrom}')
    for (const v of (structure as PymatgenStructure).lattice.matrix) lines.push(`   ${v[0].toFixed(10)} ${v[1].toFixed(10)} ${v[2].toFixed(10)}`)
    lines.push('')
  }
  const sites = structure.sites || []
  const sd = build_selective_dynamics(structure, fix_params)
  const hasC = sd.some(x => !(x[0] && x[1] && x[2])) && (params.calculation === 'relax' || params.calculation === 'vc-relax')
  lines.push(`ATOMIC_POSITIONS {${params.coord_type}}`)
  sites.forEach((s, i) => {
    const el = s.species?.[0]?.element || 'X', c = params.coord_type === 'crystal' ? s.abc : s.xyz
    if (c) lines.push(`   ${el} ${c[0].toFixed(10)} ${c[1].toFixed(10)} ${c[2].toFixed(10)}${hasC ? `   ${sd[i][0]?1:0} ${sd[i][1]?1:0} ${sd[i][2]?1:0}` : ''}`)
  })
  return lines.join('\n')
}

export function gen_dos_input(params: QEDosParams): string {
  return `&DOS\n   prefix = '${params.prefix}'\n   outdir = './tmp/'\n   fildos = '${params.prefix}.dos'\n   emin = ${params.emin}\n   emax = ${params.emax}\n   deltae = ${params.deltae}\n/`
}
