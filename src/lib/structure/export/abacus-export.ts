/**
 * ABACUS input file generation.
 */
import type { AnyStructure, PymatgenStructure } from '$lib'
import { ATOMIC_WEIGHTS_ABACUS, build_selective_dynamics, type FixAtomParams } from './common-export'

export interface AbacusParams {
  prefix: string
  calculation: 'scf' | 'relax' | 'cell-relax' | 'nscf' | 'md'
  basis_type: 'pw' | 'lcao'
  ecutwfc: number
  kpoints_auto: boolean
  kpoints: [number, number, number]
  kspacing: number
  scf_nmax: number
  scf_thr: number
  smearing_method: 'gauss' | 'mp' | 'fd' | 'fixed'
  smearing_sigma: number
  nspin: 1 | 2 | 4
  dft_functional: string
  mixing_type: 'pulay' | 'broyden' | 'plain'
  mixing_beta: number
  force_thr: number
  stress_thr: number
  relax_nmax: number
  symmetry: -1 | 0 | 1
  cal_force: boolean
  cal_stress: boolean
  out_chg: boolean
  out_band: boolean
  pseudo_dir: string
  orbital_dir: string
  pseudopotentials: Record<string, string>
  orbitals: Record<string, string>
  // MD settings
  md_type: 'nve' | 'nvt' | 'npt'
  md_nstep: number
  md_dt: number
  md_temp: number
  unique_elements: string[]
}

export function gen_abacus_input(
  structure: AnyStructure,
  params: AbacusParams,
  fix_params: FixAtomParams,
): Record<string, string> {
  if (!structure) return {}
  const nt = params.unique_elements.length
  const sites = structure.sites || []
  const aw = ATOMIC_WEIGHTS_ABACUS

  // === INPUT file ===
  const inp: string[] = ['INPUT_PARAMETERS']
  inp.push(`suffix                  ${params.prefix}`)
  inp.push(`ntype                   ${nt}`)
  inp.push(`calculation             ${params.calculation}`)
  inp.push(`basis_type              ${params.basis_type}`)
  inp.push(`ecutwfc                 ${params.ecutwfc}`)
  if (!params.kpoints_auto) inp.push(`kspacing                ${params.kspacing}`)
  inp.push(`scf_nmax                ${params.scf_nmax}`)
  inp.push(`scf_thr                 ${params.scf_thr.toExponential(1)}`)
  inp.push(`smearing_method         ${params.smearing_method}`)
  inp.push(`smearing_sigma          ${params.smearing_sigma}`)
  inp.push(`mixing_type             ${params.mixing_type}`)
  inp.push(`mixing_beta             ${params.mixing_beta}`)
  inp.push(`nspin                   ${params.nspin}`)
  inp.push(`dft_functional          ${params.dft_functional}`)
  inp.push(`symmetry                ${params.symmetry}`)
  inp.push(`pseudo_dir              ${params.pseudo_dir}`)
  if (params.basis_type === 'lcao') inp.push(`orbital_dir             ${params.orbital_dir}`)
  inp.push(`cal_force               ${params.cal_force ? 1 : 0}`)
  inp.push(`cal_stress              ${params.cal_stress ? 1 : 0}`)
  if (params.out_chg) inp.push(`out_chg                 1`)
  if (params.out_band) inp.push(`out_band                1`)
  if (params.calculation === 'relax' || params.calculation === 'cell-relax') {
    inp.push(`relax_nmax              ${params.relax_nmax}`)
    inp.push(`force_thr               ${params.force_thr.toExponential(1)}`)
    if (params.calculation === 'cell-relax') {
      inp.push(`stress_thr              ${params.stress_thr}`)
    }
  }
  if (params.calculation === 'md') {
    inp.push(`md_type                 ${params.md_type === 'nvt' ? 'nhc' : params.md_type}`)
    inp.push(`md_nstep                ${params.md_nstep}`)
    inp.push(`md_dt                   ${params.md_dt}`)
    inp.push(`md_tfirst               ${params.md_temp}`)
    inp.push(`md_tlast                ${params.md_temp}`)
  }

  // === STRU file ===
  const stru: string[] = []
  stru.push('ATOMIC_SPECIES')
  for (const el of params.unique_elements) {
    const pp = params.pseudopotentials[el] || `${el}_ONCV_PBE-1.0.upf`
    stru.push(`${el} ${(aw[el] || 1).toFixed(3)} ${pp}`)
  }
  stru.push('')

  if (params.basis_type === 'lcao') {
    stru.push('NUMERICAL_ORBITAL')
    for (const el of params.unique_elements) {
      const orb = params.orbitals[el] || `${el}_gga_8au_100Ry_2s2p1d.orb`
      stru.push(orb)
    }
    stru.push('')
  }

  const bohr_per_ang = 1.8897259886
  const lat = (structure as PymatgenStructure).lattice
  if (lat?.matrix) {
    stru.push('LATTICE_CONSTANT')
    stru.push(`1.0`)
    stru.push('')
    stru.push('LATTICE_VECTORS')
    for (const v of lat.matrix) {
      stru.push(`${(v[0] * bohr_per_ang).toFixed(10)} ${(v[1] * bohr_per_ang).toFixed(10)} ${(v[2] * bohr_per_ang).toFixed(10)}`)
    }
    stru.push('')
  }

  const sd = build_selective_dynamics(structure, fix_params)
  const hasConstraints = (params.calculation === 'relax' || params.calculation === 'cell-relax') && sd.some(x => !(x[0] && x[1] && x[2]))

  stru.push('ATOMIC_POSITIONS')
  stru.push('Direct')
  for (const el of params.unique_elements) {
    const el_sites = sites.map((s, i) => ({ site: s, idx: i })).filter(x => (x.site.species?.[0]?.element || 'X') === el)
    stru.push('')
    stru.push(el)
    stru.push(`0.0`)
    stru.push(`${el_sites.length}`)
    for (const { site, idx } of el_sites) {
      const c = site.abc || site.xyz
      if (!c) continue
      const line = `${c[0].toFixed(10)} ${c[1].toFixed(10)} ${c[2].toFixed(10)}`
      if (hasConstraints) {
        stru.push(`${line} m ${sd[idx][0] ? 1 : 0} ${sd[idx][1] ? 1 : 0} ${sd[idx][2] ? 1 : 0}`)
      } else {
        stru.push(line)
      }
    }
  }

  // === KPT file ===
  const kpt: string[] = []
  kpt.push('K_POINTS')
  kpt.push('0')
  kpt.push('Gamma')
  const k = params.kpoints_auto ? [4, 4, 4] : params.kpoints
  kpt.push(`${k[0]} ${k[1]} ${k[2]} 0 0 0`)

  return { INPUT: inp.join('\n'), STRU: stru.join('\n'), KPT: kpt.join('\n') }
}
