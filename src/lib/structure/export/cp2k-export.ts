/**
 * CP2K input file generation.
 */
import type { AnyStructure, PymatgenStructure } from '$lib'
import { parse_index_range, type FixAtomParams } from './common-export'

// ====== CP2K Valence Electron Counts ======
export const CP2K_VALENCE: Record<string, number> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 3, C: 4, N: 5, O: 6, F: 7, Ne: 8,
  Na: 9, Mg: 10, Al: 3, Si: 4, P: 5, S: 6, Cl: 7, Ar: 8,
  K: 9, Ca: 10, Sc: 11, Ti: 12, V: 13, Cr: 14, Mn: 15, Fe: 16, Co: 17, Ni: 18, Cu: 11, Zn: 12,
  Ga: 13, Ge: 4, As: 5, Se: 6, Br: 7, Kr: 8,
  Rb: 9, Sr: 10, Y: 11, Zr: 12, Nb: 13, Mo: 14, Ru: 16, Rh: 17, Pd: 18, Ag: 11, Cd: 12,
  In: 13, Sn: 4, Sb: 5, Te: 6, I: 7, Xe: 8,
  Cs: 9, Ba: 10, La: 11, Ce: 12, W: 14, Re: 15, Os: 16, Ir: 17, Pt: 18, Au: 11, Hg: 12,
  Tl: 13, Pb: 4, Bi: 5,
}

export function get_cp2k_valence(el: string): number {
  return CP2K_VALENCE[el] || 4
}

/** Determine the reference functional name for VDW parameters */
export function cp2k_ref_functional(functional: string): string {
  const map: Record<string, string> = {
    BLYP: 'BLYP', revPBE: 'revPBE', PBEsol: 'PBEsol', BP86: 'BP86',
    RPBE: 'RPBE', TPSS: 'TPSS', revTPSS: 'revTPSS', r2SCAN: 'r2SCAN', SCAN: 'SCAN',
  }
  return map[functional] || 'PBE'
}

/** Check if functional is a hybrid functional */
export function cp2k_is_hybrid(f: string): boolean {
  return ['PBE0', 'B3LYP', 'HSE06', 'BHandHLYP'].includes(f)
}

export type CP2KRunType = 'energy' | 'energy_force' | 'geo_opt' | 'cell_opt' | 'md' | 'vibrational_analysis' | 'linear_response'
export type CP2KFunctional = 'PBE' | 'BLYP' | 'SCAN' | 'PBE0' | 'B3LYP' | 'revPBE' | 'PBEsol' | 'BP86' | 'RPBE' | 'TPSS' | 'revTPSS' | 'r2SCAN' | 'HSE06' | 'BHandHLYP'

export type CP2KPreset = 'quick' | 'accurate' | 'surface' | 'md_equil' | 'metal' | 'hybrid'

export interface CP2KParams {
  prefix: string
  run_type: CP2KRunType
  functional: CP2KFunctional
  basis_set: string
  cutoff: number
  rel_cutoff: number
  scf_method: 'OT' | 'DIAG'
  scf_eps: number
  max_scf: number
  ot_precond: 'FULL_KINETIC' | 'FULL_ALL' | 'FULL_SINGLE_INVERSE'
  ot_minimizer: 'DIIS' | 'CG' | 'BROYDEN'
  outer_scf: boolean
  outer_max_scf: number
  outer_eps: number
  smearing: boolean
  smearing_method: 'FERMI_DIRAC' | 'ENERGY_WINDOW'
  electronic_temperature: number
  added_mos: number
  vdw: 'none' | 'DFTD3(BJ)' | 'DFTD3' | 'DFTD2' | 'DFTD4'
  periodic: 'XYZ' | 'XY' | 'XZ' | 'YZ' | 'X' | 'Y' | 'Z' | 'NONE'
  charge: number
  multiplicity: number
  uks: boolean
  kpoints_enabled: boolean
  kpoints_nx: number
  kpoints_ny: number
  kpoints_nz: number
  dftpu_enabled: boolean
  dftpu_settings: Record<string, { l: number; u_minus_j: number }>
  // Fixed atoms
  fix_elements: string[]
  fix_indices_str: string
  // Cell repetitions
  cell_rep_x: number
  cell_rep_y: number
  cell_rep_z: number
  // Fine grid
  fine_grid_xc: boolean
  // Print options
  print_level: 'LOW' | 'MEDIUM' | 'HIGH'
  print_moments: boolean
  print_orbital_energies: boolean
  output_overlap_csr: boolean
  output_ks_csr: boolean
  epr_hyperfine: boolean
  // External electric field
  efield_enabled: boolean
  efield_x: number
  efield_y: number
  efield_z: number
  // Magnetization
  magnetization: Record<string, number>
  // Coordinates
  center_coords: boolean
  coord_from_file: boolean
  coord_file_name: string
  // GEO_OPT
  geo_optimizer: 'BFGS' | 'LBFGS' | 'CG'
  geo_max_force: number
  geo_max_iter: number
  // CELL_OPT
  cell_opt_max_iter: number
  cell_opt_pressure: number
  // MD
  md_ensemble: 'NVE' | 'NVT' | 'NPT_I'
  md_steps: number
  md_timestep: number
  md_temperature: number
  md_thermostat: 'NOSE' | 'CSVR'
  md_timecon: number
  // Advanced
  cdft_enabled: boolean
  lrigpw: boolean
  ls_scf: boolean
  poisson_solver: 'PERIODIC' | 'ANALYTIC' | 'MT' | 'WAVELET' | 'IMPLICIT'
  surf_dipole: 'NONE' | 'SURF_DIP' | 'BERRY'
  unique_elements: string[]
}

export function apply_cp2k_preset(preset: CP2KPreset): Partial<CP2KParams> {
  if (preset === 'quick') {
    return {
      run_type: 'energy', functional: 'PBE', basis_set: 'DZVP-MOLOPT-SR-GTH',
      cutoff: 300, rel_cutoff: 40, scf_eps: 1e-5, max_scf: 200, scf_method: 'OT', vdw: 'none',
    }
  } else if (preset === 'accurate') {
    return {
      run_type: 'energy', functional: 'PBE', basis_set: 'TZV2P-MOLOPT-GTH',
      cutoff: 600, rel_cutoff: 60, scf_eps: 1e-7, max_scf: 500, scf_method: 'OT', vdw: 'DFTD3(BJ)',
    }
  } else if (preset === 'surface') {
    return {
      run_type: 'geo_opt', functional: 'PBE', basis_set: 'DZVP-MOLOPT-SR-GTH',
      cutoff: 400, rel_cutoff: 50, scf_eps: 1e-6, scf_method: 'OT', vdw: 'DFTD3(BJ)',
      geo_max_force: 4.5e-4, periodic: 'XYZ',
    }
  } else if (preset === 'md_equil') {
    return {
      run_type: 'md', functional: 'PBE', basis_set: 'DZVP-MOLOPT-SR-GTH',
      cutoff: 400, rel_cutoff: 50, scf_eps: 1e-5, scf_method: 'OT', vdw: 'DFTD3(BJ)',
      md_ensemble: 'NVT', md_steps: 5000, md_timestep: 0.5, md_temperature: 300,
      md_thermostat: 'CSVR', md_timecon: 50,
    }
  } else if (preset === 'metal') {
    return {
      run_type: 'geo_opt', functional: 'PBE', basis_set: 'DZVP-MOLOPT-SR-GTH',
      cutoff: 400, rel_cutoff: 50, scf_eps: 1e-6, scf_method: 'DIAG',
      smearing: true, smearing_method: 'FERMI_DIRAC', electronic_temperature: 300,
      added_mos: 50, vdw: 'DFTD3(BJ)',
    }
  } else {
    return {
      run_type: 'energy', functional: 'PBE0', basis_set: 'DZVP-MOLOPT-SR-GTH',
      cutoff: 400, rel_cutoff: 50, scf_eps: 1e-6, scf_method: 'OT', vdw: 'DFTD3(BJ)',
    }
  }
}

export function gen_cp2k_local(
  structure: AnyStructure,
  params: CP2KParams,
  fix_params: FixAtomParams,
): string {
  if (!structure) return ''
  const lines: string[] = []
  const ncenter = structure.sites?.length || 0
  const run_type_map: Record<string, string> = {
    energy: 'ENERGY', energy_force: 'ENERGY_FORCE', geo_opt: 'GEO_OPT', cell_opt: 'CELL_OPT', md: 'MD',
    vibrational_analysis: 'VIBRATIONAL_ANALYSIS', linear_response: 'LINEAR_RESPONSE',
  }
  const run_type = run_type_map[params.run_type] || 'ENERGY'

  const potential_prefix = ['BLYP', 'B3LYP', 'BP86', 'BHandHLYP'].includes(params.functional) ? 'GTH-BLYP' : (params.functional as string) === 'PADE' ? 'GTH-PADE' : 'GTH-PBE'

  let eps_scf = params.scf_eps
  let eps_default = '1.0E-12'
  if (params.run_type === 'energy' || params.run_type === 'energy_force') {
    eps_default = '1.0E-11'
  } else if (params.run_type === 'vibrational_analysis' || params.run_type === 'linear_response') {
    if (eps_scf > 1e-7) eps_scf = 1e-7
    eps_default = '1.0E-14'
  } else if (params.run_type === 'md') {
    eps_default = '1.0E-10'
  }

  // &GLOBAL
  lines.push(`&GLOBAL`)
  lines.push(`  PROJECT ${params.prefix}`)
  lines.push(`  RUN_TYPE ${run_type}`)
  lines.push(`  PRINT_LEVEL ${params.print_level}`)
  lines.push(`&END GLOBAL`)
  lines.push(``)

  // &FORCE_EVAL
  lines.push(`&FORCE_EVAL`)
  lines.push(`  METHOD Quickstep`)
  if (params.run_type === 'cell_opt' || (params.run_type === 'md' && params.md_ensemble === 'NPT_I')) {
    lines.push(`  STRESS_TENSOR ANALYTICAL`)
  }
  lines.push(`  &DFT`)
  lines.push(`    BASIS_SET_FILE_NAME BASIS_MOLOPT`)
  lines.push(`    POTENTIAL_FILE_NAME GTH_POTENTIALS`)
  if (params.lrigpw) {
    lines.push(`    BASIS_SET_FILE_NAME BASIS_LRIGPW_AUXMOLOPT`)
  }
  lines.push(`    CHARGE ${params.charge}`)
  if (params.multiplicity !== 1) lines.push(`    MULTIPLICITY ${params.multiplicity}`)
  const has_magnetization = Object.values(params.magnetization).some(v => v !== 0)
  if (params.uks || params.multiplicity > 1 || has_magnetization) lines.push(`    UKS`)
  if (params.dftpu_enabled) lines.push(`    PLUS_U_METHOD MULLIKEN`)
  if (params.surf_dipole === 'SURF_DIP') {
    lines.push(`    SURFACE_DIPOLE_CORRECTION T`)
    lines.push(`    SURF_DIP_DIR Z`)
  }

  // &MGRID
  lines.push(`    &MGRID`)
  lines.push(`      CUTOFF ${params.cutoff}`)
  lines.push(`      REL_CUTOFF ${params.rel_cutoff}`)
  lines.push(`      NGRIDS 4`)
  lines.push(`    &END MGRID`)

  // &QS
  lines.push(`    &QS`)
  lines.push(`      EPS_DEFAULT ${eps_default}`)
  if (params.lrigpw) {
    lines.push(`      METHOD LRIGPW`)
    lines.push(`      &LRIGPW`)
    lines.push(`        LRI_OVERLAP_MATRIX AUTOSELECT`)
    lines.push(`      &END LRIGPW`)
  }
  if (params.ls_scf) lines.push(`      LS_SCF`)
  if (params.run_type === 'md') {
    lines.push(`      EXTRAPOLATION ASPC`)
    lines.push(`      EXTRAPOLATION_ORDER 3`)
  }
  lines.push(`    &END QS`)

  // SCF
  if (params.ls_scf) {
    lines.push(`    &LS_SCF`)
    lines.push(`      PURIFICATION_METHOD TRS4`)
    lines.push(`      EPS_FILTER 1E-7`)
    lines.push(`      EPS_SCF 5E-6`)
    lines.push(`      MAX_SCF 40`)
    lines.push(`      S_PRECONDITIONER ATOMIC`)
    lines.push(`    &END LS_SCF`)
  } else {
    lines.push(`    &SCF`)
    lines.push(`      SCF_GUESS ATOMIC`)
    lines.push(`      EPS_SCF ${eps_scf.toExponential(1).toUpperCase()}`)
    if (params.scf_method === 'DIAG') {
      lines.push(`      MAX_SCF 128`)
      const is_uks = params.uks || params.multiplicity > 1 || has_magnetization
      if (params.added_mos > 0) {
        if (is_uks) {
          lines.push(`      ADDED_MOS ${params.added_mos} ${params.added_mos}`)
        } else {
          lines.push(`      ADDED_MOS ${params.added_mos}`)
        }
      }
      lines.push(`      &DIAGONALIZATION`)
      lines.push(`        ALGORITHM STANDARD`)
      lines.push(`      &END DIAGONALIZATION`)
      if (params.smearing) {
        lines.push(`      &SMEAR ON`)
        lines.push(`        METHOD ${params.smearing_method}`)
        lines.push(`        ELECTRONIC_TEMPERATURE [K] ${params.electronic_temperature}`)
        lines.push(`      &END SMEAR`)
      }
      lines.push(`      &MIXING`)
      lines.push(`        METHOD BROYDEN_MIXING`)
      lines.push(`        ALPHA 0.4`)
      lines.push(`        NBROYDEN 8`)
      lines.push(`      &END MIXING`)
    } else {
      if (params.outer_scf) {
        lines.push(`      MAX_SCF 25`)
      } else {
        lines.push(`      MAX_SCF ${params.max_scf}`)
      }
      lines.push(`      &OT`)
      if (ncenter < 300) {
        lines.push(`        PRECONDITIONER ${params.ot_precond === 'FULL_KINETIC' ? 'FULL_ALL' : params.ot_precond}`)
      } else {
        lines.push(`        PRECONDITIONER ${params.ot_precond}`)
      }
      lines.push(`        MINIMIZER ${params.ot_minimizer}`)
      lines.push(`        LINESEARCH 2PNT`)
      lines.push(`        ALGORITHM STRICT`)
      lines.push(`      &END OT`)
    }
    if (params.outer_scf && params.scf_method === 'OT') {
      lines.push(`      &OUTER_SCF`)
      lines.push(`        MAX_SCF ${params.outer_max_scf}`)
      lines.push(`        EPS_SCF ${params.outer_eps.toExponential(1).toUpperCase()}`)
      lines.push(`      &END OUTER_SCF`)
    }
    if (params.run_type === 'vibrational_analysis' || params.run_type === 'md') {
      lines.push(`      &PRINT`)
      lines.push(`        &RESTART OFF`)
      lines.push(`        &END RESTART`)
      lines.push(`      &END PRINT`)
    } else {
      lines.push(`      &PRINT`)
      lines.push(`        &RESTART`)
      lines.push(`          BACKUP_COPIES 0`)
      lines.push(`        &END RESTART`)
      lines.push(`      &END PRINT`)
    }
    lines.push(`    &END SCF`)
  }

  // &XC
  lines.push(`    &XC`)
  const f = params.functional
  if (['PBE', 'BLYP'].includes(f)) {
    lines.push(`      &XC_FUNCTIONAL ${f}`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'SCAN') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &LIBXC`)
    lines.push(`          FUNCTIONAL MGGA_X_SCAN`)
    lines.push(`        &END LIBXC`)
    lines.push(`        &LIBXC`)
    lines.push(`          FUNCTIONAL MGGA_C_SCAN`)
    lines.push(`        &END LIBXC`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'r2SCAN') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &LIBXC`)
    lines.push(`          FUNCTIONAL MGGA_X_R2SCAN`)
    lines.push(`        &END LIBXC`)
    lines.push(`        &LIBXC`)
    lines.push(`          FUNCTIONAL MGGA_C_R2SCAN`)
    lines.push(`        &END LIBXC`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'revPBE') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &PBE`)
    lines.push(`          PARAMETRIZATION REVPBE`)
    lines.push(`        &END PBE`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'PBEsol') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &PBE`)
    lines.push(`          PARAMETRIZATION PBESOL`)
    lines.push(`        &END PBE`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'RPBE') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &GGA_X_RPBE`)
    lines.push(`        &END GGA_X_RPBE`)
    lines.push(`        &GGA_C_PBE`)
    lines.push(`        &END GGA_C_PBE`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'BP86') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &BECKE88`)
    lines.push(`        &END BECKE88`)
    lines.push(`        &P86C`)
    lines.push(`        &END P86C`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'TPSS') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &TPSS`)
    lines.push(`        &END TPSS`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'revTPSS') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &TPSS`)
    lines.push(`          FUNCTIONAL REVTPSS`)
    lines.push(`        &END TPSS`)
    lines.push(`      &END XC_FUNCTIONAL`)
  } else if (f === 'PBE0') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &PBE`)
    lines.push(`          SCALE_X 0.75`)
    lines.push(`          SCALE_C 1.0`)
    lines.push(`        &END PBE`)
    lines.push(`      &END XC_FUNCTIONAL`)
    lines.push(`      &HF`)
    lines.push(`        FRACTION 0.25`)
    lines.push(`        &SCREENING`)
    lines.push(`          EPS_SCHWARZ 1.0E-6`)
    lines.push(`        &END SCREENING`)
    lines.push(`      &END HF`)
  } else if (f === 'B3LYP') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &B3LYP`)
    lines.push(`        &END B3LYP`)
    lines.push(`      &END XC_FUNCTIONAL`)
    lines.push(`      &HF`)
    lines.push(`        FRACTION 0.20`)
    lines.push(`        &SCREENING`)
    lines.push(`          EPS_SCHWARZ 1.0E-6`)
    lines.push(`        &END SCREENING`)
    lines.push(`      &END HF`)
  } else if (f === 'HSE06') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &PBE`)
    lines.push(`          SCALE_X 0.0`)
    lines.push(`          SCALE_C 1.0`)
    lines.push(`        &END PBE`)
    lines.push(`        &XWPBE`)
    lines.push(`          SCALE_X -0.25`)
    lines.push(`          SCALE_X0 1.0`)
    lines.push(`          OMEGA 0.11`)
    lines.push(`        &END XWPBE`)
    lines.push(`      &END XC_FUNCTIONAL`)
    lines.push(`      &HF`)
    lines.push(`        FRACTION 0.25`)
    lines.push(`        &SCREENING`)
    lines.push(`          EPS_SCHWARZ 1.0E-6`)
    lines.push(`        &END SCREENING`)
    lines.push(`        &INTERACTION_POTENTIAL`)
    lines.push(`          POTENTIAL_TYPE SHORTRANGE`)
    lines.push(`          OMEGA 0.11`)
    lines.push(`        &END INTERACTION_POTENTIAL`)
    lines.push(`      &END HF`)
  } else if (f === 'BHandHLYP') {
    lines.push(`      &XC_FUNCTIONAL`)
    lines.push(`        &BECKE88`)
    lines.push(`          SCALE_X 0.5`)
    lines.push(`        &END BECKE88`)
    lines.push(`        &LYP_ADIABATIC`)
    lines.push(`        &END LYP_ADIABATIC`)
    lines.push(`      &END XC_FUNCTIONAL`)
    lines.push(`      &HF`)
    lines.push(`        FRACTION 0.50`)
    lines.push(`        &SCREENING`)
    lines.push(`          EPS_SCHWARZ 1.0E-6`)
    lines.push(`        &END SCREENING`)
    lines.push(`      &END HF`)
  }

  // VDW
  if (params.vdw !== 'none') {
    lines.push(`      &VDW_POTENTIAL`)
    if (params.vdw === 'DFTD4') {
      lines.push(`        POTENTIAL_TYPE PAIR_POTENTIAL`)
      lines.push(`        &PAIR_POTENTIAL`)
      lines.push(`          TYPE DFTD4`)
      lines.push(`          REFERENCE_FUNCTIONAL ${cp2k_ref_functional(params.functional)}`)
      lines.push(`        &END PAIR_POTENTIAL`)
    } else {
      lines.push(`        POTENTIAL_TYPE PAIR_POTENTIAL`)
      lines.push(`        &PAIR_POTENTIAL`)
      lines.push(`          TYPE ${params.vdw}`)
      lines.push(`          REFERENCE_FUNCTIONAL ${cp2k_ref_functional(params.functional)}`)
      lines.push(`          R_CUTOFF 15`)
      lines.push(`          PARAMETER_FILE_NAME dftd3.dat`)
      lines.push(`        &END PAIR_POTENTIAL`)
    }
    lines.push(`      &END VDW_POTENTIAL`)
  }
  if (params.fine_grid_xc) {
    lines.push(`      &XC_GRID`)
    lines.push(`        XC_DERIV SPLINE2`)
    lines.push(`        XC_SMOOTH_RHO NN10`)
    lines.push(`      &END XC_GRID`)
  }
  lines.push(`    &END XC`)

  // &POISSON
  lines.push(`    &POISSON`)
  if (params.poisson_solver !== 'PERIODIC') {
    lines.push(`      POISSON_SOLVER ${params.poisson_solver}`)
  } else {
    lines.push(`      POISSON_SOLVER PERIODIC`)
  }
  lines.push(`      PERIODIC ${params.poisson_solver === 'PERIODIC' ? 'XYZ' : params.periodic}`)
  lines.push(`    &END POISSON`)

  // External electric field
  if (params.efield_enabled && (params.efield_x !== 0 || params.efield_y !== 0 || params.efield_z !== 0)) {
    lines.push(`    &PERIODIC_EFIELD`)
    lines.push(`      INTENSITY ${Math.sqrt(params.efield_x**2 + params.efield_y**2 + params.efield_z**2).toExponential(4)}`)
    lines.push(`      POLARISATION ${params.efield_x} ${params.efield_y} ${params.efield_z}`)
    lines.push(`    &END PERIODIC_EFIELD`)
  }

  // &KPOINTS
  if (params.kpoints_enabled && params.periodic !== 'NONE') {
    lines.push(`    &KPOINTS`)
    lines.push(`      SCHEME MONKHORST-PACK ${params.kpoints_nx} ${params.kpoints_ny} ${params.kpoints_nz}`)
    lines.push(`    &END KPOINTS`)
  }

  // &PRINT (DFT level)
  const has_dft_print = params.run_type === 'energy' || params.run_type === 'energy_force' || params.print_moments || params.print_orbital_energies || params.output_overlap_csr || params.output_ks_csr || params.epr_hyperfine || params.dftpu_enabled
  if (has_dft_print) {
    lines.push(`    &PRINT`)
    if (params.run_type === 'energy' || params.run_type === 'energy_force') {
      lines.push(`      &E_DENSITY_CUBE OFF`)
      lines.push(`      &END E_DENSITY_CUBE`)
      lines.push(`      &MO_CUBES OFF`)
      lines.push(`        NHOMO 1`)
      lines.push(`        NLUMO 1`)
      lines.push(`      &END MO_CUBES`)
    }
    if (params.print_moments) {
      lines.push(`      &MOMENTS`)
      lines.push(`        PERIODIC .FALSE.`)
      lines.push(`      &END MOMENTS`)
    }
    if (params.print_orbital_energies) {
      lines.push(`      &MO`)
      lines.push(`        ENERGIES T`)
      lines.push(`        OCCUPATION_NUMBERS T`)
      lines.push(`        COEFFICIENTS F`)
      lines.push(`        &EACH`)
      lines.push(`          QS_SCF 0`)
      lines.push(`        &END EACH`)
      lines.push(`      &END MO`)
    }
    if (params.output_overlap_csr) {
      lines.push(`      &OVERLAP_CONDITION`)
      lines.push(`        1-NORM .TRUE.`)
      lines.push(`      &END OVERLAP_CONDITION`)
    }
    if (params.epr_hyperfine) {
      lines.push(`      &HYPERFINE_COUPLING_TENSOR`)
      lines.push(`      &END HYPERFINE_COUPLING_TENSOR`)
    }
    if (params.dftpu_enabled) {
      lines.push(`      #&PLUS_U`)
      lines.push(`      #  &EACH`)
      lines.push(`      #    QS_SCF 1`)
      lines.push(`      #  &END EACH`)
      lines.push(`      #&END PLUS_U`)
    }
    lines.push(`    &END PRINT`)
  }

  lines.push(`  &END DFT`)

  // &PRINT at FORCE_EVAL level
  if (params.run_type === 'energy_force' || params.run_type === 'cell_opt') {
    lines.push(`  &PRINT`)
    if (params.run_type === 'energy_force') lines.push(`    &FORCES ON`)
    if (params.run_type === 'energy_force') lines.push(`    &END FORCES`)
    if (params.run_type === 'cell_opt') lines.push(`    &STRESS_TENSOR ON`)
    if (params.run_type === 'cell_opt') lines.push(`    &END STRESS_TENSOR`)
    lines.push(`  &END PRINT`)
  }

  // &SUBSYS
  lines.push(`  &SUBSYS`)

  // CELL
  const lat = (structure as PymatgenStructure).lattice?.matrix
  if (lat) {
    lines.push(`    &CELL`)
    lines.push(`      A ${lat[0][0].toFixed(8)} ${lat[0][1].toFixed(8)} ${lat[0][2].toFixed(8)}`)
    lines.push(`      B ${lat[1][0].toFixed(8)} ${lat[1][1].toFixed(8)} ${lat[1][2].toFixed(8)}`)
    lines.push(`      C ${lat[2][0].toFixed(8)} ${lat[2][1].toFixed(8)} ${lat[2][2].toFixed(8)}`)
    lines.push(`      PERIODIC ${params.poisson_solver === 'PERIODIC' ? 'XYZ' : params.periodic}`)
    if (params.cell_rep_x > 1 || params.cell_rep_y > 1 || params.cell_rep_z > 1) {
      lines.push(`      MULTIPLE_UNIT_CELL ${params.cell_rep_x} ${params.cell_rep_y} ${params.cell_rep_z}`)
    }
    lines.push(`    &END CELL`)
  }

  // TOPOLOGY
  const needs_topology = (params.cell_rep_x > 1 || params.cell_rep_y > 1 || params.cell_rep_z > 1) || params.center_coords || (params.coord_from_file && params.coord_file_name)
  if (needs_topology) {
    lines.push(`    &TOPOLOGY`)
    if (params.cell_rep_x > 1 || params.cell_rep_y > 1 || params.cell_rep_z > 1) {
      lines.push(`      MULTIPLE_UNIT_CELL ${params.cell_rep_x} ${params.cell_rep_y} ${params.cell_rep_z}`)
    }
    if (params.center_coords && params.run_type !== 'vibrational_analysis') {
      lines.push(`      &CENTER_COORDINATES`)
      lines.push(`      &END CENTER_COORDINATES`)
    }
    if (params.coord_from_file && params.coord_file_name) {
      lines.push(`      COORD_FILE_NAME ${params.coord_file_name}`)
      lines.push(`      COORD_FILE_FORMAT XYZ`)
    }
    lines.push(`    &END TOPOLOGY`)
  }

  // COORD
  if (!params.coord_from_file || !params.coord_file_name) {
    lines.push(`    &COORD`)
    for (const site of (structure.sites || [])) {
      const el = site.species?.[0]?.element || 'X'
      const [x, y, z] = site.xyz || [0, 0, 0]
      lines.push(`      ${el} ${x.toFixed(8)} ${y.toFixed(8)} ${z.toFixed(8)}`)
    }
    lines.push(`    &END COORD`)
  }

  // KIND for each element
  for (const el of params.unique_elements) {
    lines.push(`    &KIND ${el}`)
    lines.push(`      ELEMENT ${el}`)
    lines.push(`      BASIS_SET ${params.basis_set}`)
    lines.push(`      POTENTIAL ${potential_prefix}-q${get_cp2k_valence(el)}`)
    if (params.lrigpw) {
      lines.push(`      BASIS_SET LRI_AUX LRI-DZVP-MOLOPT-GTH-MEDIUM`)
    }
    if (params.dftpu_enabled && params.dftpu_settings[el]) {
      const u = params.dftpu_settings[el]
      lines.push(`      &DFT_PLUS_U`)
      lines.push(`        L ${u.l}`)
      lines.push(`        U_MINUS_J [eV] ${u.u_minus_j.toFixed(2)}`)
      lines.push(`      &END DFT_PLUS_U`)
    }
    if (params.magnetization[el] !== undefined && params.magnetization[el] !== 0) {
      lines.push(`      MAGNETIZATION ${params.magnetization[el].toFixed(1)}`)
    }
    lines.push(`    &END KIND`)
  }

  lines.push(`  &END SUBSYS`)
  lines.push(`&END FORCE_EVAL`)

  // &MOTION
  const motion_types = ['geo_opt', 'cell_opt', 'md']
  if (motion_types.includes(params.run_type)) {
    lines.push(``)
    lines.push(`&MOTION`)

    if (params.run_type === 'geo_opt') {
      lines.push(`  &GEO_OPT`)
      lines.push(`    OPTIMIZER ${params.geo_optimizer}`)
      lines.push(`    MAX_FORCE ${params.geo_max_force.toExponential(1).toUpperCase()}`)
      lines.push(`    MAX_ITER ${params.geo_max_iter}`)
      lines.push(`  &END GEO_OPT`)
    } else if (params.run_type === 'cell_opt') {
      lines.push(`  &CELL_OPT`)
      lines.push(`    MAX_ITER ${params.cell_opt_max_iter}`)
      lines.push(`    EXTERNAL_PRESSURE ${params.cell_opt_pressure.toFixed(1)}`)
      lines.push(`  &END CELL_OPT`)
    } else if (params.run_type === 'md') {
      lines.push(`  &MD`)
      lines.push(`    ENSEMBLE ${params.md_ensemble}`)
      lines.push(`    STEPS ${params.md_steps}`)
      lines.push(`    TIMESTEP ${params.md_timestep}`)
      lines.push(`    TEMPERATURE ${params.md_temperature}`)
      if (params.md_ensemble !== 'NVE') {
        lines.push(`    &THERMOSTAT`)
        lines.push(`      TYPE ${params.md_thermostat}`)
        lines.push(`      &${params.md_thermostat}`)
        lines.push(`        TIMECON ${params.md_timecon}`)
        lines.push(`      &END ${params.md_thermostat}`)
        lines.push(`    &END THERMOSTAT`)
      }
      lines.push(`  &END MD`)
    }

    // Fixed atoms
    const constraint_map = new Map<number, [boolean, boolean, boolean]>()
    function merge_fix(idx: number, sd: [boolean, boolean, boolean]) {
      const existing = constraint_map.get(idx)
      if (existing) {
        constraint_map.set(idx, [existing[0] && sd[0], existing[1] && sd[1], existing[2] && sd[2]])
      } else {
        constraint_map.set(idx, [...sd])
      }
    }
    if (fix_params.fix_mode === 'selected') fix_params.selected_indices.forEach(i => merge_fix(i, [false, false, false]))
    else if (fix_params.fix_mode === 'z_below') structure.sites?.forEach((s, i) => { if (s.xyz && s.xyz[2] < fix_params.fix_z_threshold) merge_fix(i, [false, false, false]) })
    fix_params.constrained_atoms_info.details.forEach(d => merge_fix(d.idx, d.constraint))
    if (params.fix_elements.length > 0) {
      structure.sites?.forEach((s, i) => {
        const el = s.species?.[0]?.element || ''
        if (params.fix_elements.includes(el)) merge_fix(i, [false, false, false])
      })
    }
    if (params.fix_indices_str.trim()) {
      const idx_set = parse_index_range(params.fix_indices_str, structure.sites?.length || 0)
      idx_set.forEach(i => merge_fix(i, [false, false, false]))
    }
    if (constraint_map.size > 0) {
      const groups = new Map<string, number[]>()
      for (const [idx, sd] of constraint_map) {
        let comp = ''
        if (!sd[0]) comp += 'X'
        if (!sd[1]) comp += 'Y'
        if (!sd[2]) comp += 'Z'
        if (!comp) continue
        if (!groups.has(comp)) groups.set(comp, [])
        groups.get(comp)!.push(idx)
      }
      if (groups.size > 0) {
        lines.push(`  &CONSTRAINT`)
        for (const [comp, indices] of groups) {
          lines.push(`    &FIXED_ATOMS`)
          lines.push(`      COMPONENTS_TO_FIX ${comp}`)
          lines.push(`      LIST ${indices.map(i => i + 1).sort((a, b) => a - b).join(' ')}`)
          lines.push(`    &END FIXED_ATOMS`)
        }
        lines.push(`  &END CONSTRAINT`)
      }
    }

    // PRINT
    lines.push(`  &PRINT`)
    lines.push(`    &TRAJECTORY`)
    lines.push(`      &EACH`)
    lines.push(`        ${run_type} 1`)
    lines.push(`      &END EACH`)
    lines.push(`    &END TRAJECTORY`)
    lines.push(`    &RESTART`)
    lines.push(`      &EACH`)
    lines.push(`        ${run_type} 50`)
    lines.push(`      &END EACH`)
    lines.push(`    &END RESTART`)
    lines.push(`  &END PRINT`)

    lines.push(`&END MOTION`)
  }

  // &VIBRATIONAL_ANALYSIS
  if (params.run_type === 'vibrational_analysis') {
    lines.push(``)
    lines.push(`&VIBRATIONAL_ANALYSIS`)
    lines.push(`  DX 0.01`)
    lines.push(`  NPROC_REP 1`)
    lines.push(`  TC_PRESSURE 101325`)
    lines.push(`  TC_TEMPERATURE 298.15`)
    lines.push(`  THERMOCHEMISTRY`)
    if (!params.kpoints_enabled || (params.kpoints_nx === 1 && params.kpoints_ny === 1 && params.kpoints_nz === 1)) {
      lines.push(`  INTENSITIES T`)
    } else {
      lines.push(`  INTENSITIES F`)
    }
    if (params.periodic !== 'NONE') {
      lines.push(`  FULLY_PERIODIC T`)
    }
    lines.push(`&END VIBRATIONAL_ANALYSIS`)
  }

  return lines.join('\n')
}
