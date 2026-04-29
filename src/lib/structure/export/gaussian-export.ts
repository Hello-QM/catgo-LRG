/**
 * Gaussian input file generation.
 */
import type { AnyStructure } from '$lib'

export interface GaussianParams {
  prefix: string
  job_type: 'sp' | 'opt' | 'opt_freq' | 'freq' | 'td' | 'ts'
  method: string
  basis: string
  charge: number
  multiplicity: number
  nproc: number
  mem: string
  chk: boolean
  dispersion: string
  solvation: string
  solvent: string
  td_nstates: number
  pop: string
  nosymm: boolean
  out_wfn: string
  title: string
  extra_keywords: string
}

export type GaussianPreset = 'quick_opt' | 'accurate' | 'td_dft' | 'freq_thermo' | 'solvation' | 'ts_search'

export function apply_gaussian_preset(preset: GaussianPreset): Partial<GaussianParams> {
  if (preset === 'quick_opt') {
    return { job_type: 'opt', method: 'B3LYP', basis: '6-31G*', dispersion: 'none', solvation: 'none' }
  } else if (preset === 'accurate') {
    return { job_type: 'opt_freq', method: 'B3LYP', basis: '6-311+G(d,p)', dispersion: 'EmpiricalDispersion=GD3BJ', solvation: 'none' }
  } else if (preset === 'td_dft') {
    return { job_type: 'td', method: 'B3LYP', basis: '6-31G*', td_nstates: 10, dispersion: 'none' }
  } else if (preset === 'freq_thermo') {
    return { job_type: 'freq', method: 'B3LYP', basis: '6-311+G(d,p)', dispersion: 'EmpiricalDispersion=GD3BJ' }
  } else if (preset === 'solvation') {
    return { job_type: 'opt', method: 'B3LYP', basis: '6-31G*', solvation: 'scrf', solvent: 'Water' }
  } else {
    return { job_type: 'ts', method: 'B3LYP', basis: '6-31G*', extra_keywords: 'opt=(calcfc,ts,noeigen)' }
  }
}

export function generate_gaussian_input(structure: AnyStructure, params: GaussianParams): Record<string, string> {
  if (!structure) throw new Error('No structure')
  const sites = structure.sites
  const job_kw: Record<string, string> = {
    sp: `SP`, opt: `Opt`, opt_freq: `Opt Freq`, freq: `Freq`,
    td: `TD(NStates=${params.td_nstates})`, ts: `Opt=(CalcFC,TS,NoEigen)`,
  }
  let route = `#p ${params.method}/${params.basis} ${job_kw[params.job_type] ?? `SP`}`
  if (params.dispersion !== `none` && params.method !== `wB97XD`) route += ` ${params.dispersion}`
  if (params.solvation === `scrf`) route += ` SCRF=(SMD,Solvent=${params.solvent})`
  if (params.pop !== `none`) route += ` pop=${params.pop}`
  if (params.nosymm) route += ` nosymm`
  if (params.out_wfn !== `none`) route += ` output=${params.out_wfn}`
  if (params.extra_keywords.trim()) route += ` ${params.extra_keywords.trim()}`

  let content = ``
  if (params.chk) content += `%chk=${params.prefix}.chk\n`
  content += `%nproc=${params.nproc}\n%mem=${params.mem}\n${route}\n\n`
  content += `${params.title || params.prefix}\n\n`
  content += `${params.charge} ${params.multiplicity}\n`

  for (const site of sites) {
    const el = site.species?.[0]?.element ?? `X`
    const [x, y, z] = site.xyz ?? [0, 0, 0]
    content += `${el.padEnd(4)} ${x.toFixed(8).padStart(14)} ${y.toFixed(8).padStart(14)} ${z.toFixed(8).padStart(14)}\n`
  }
  content += `\n`
  if (params.out_wfn !== `none`) content += `${params.prefix}.${params.out_wfn}\n\n`

  const fname = `${params.prefix}.gjf`
  return { [fname]: content }
}
