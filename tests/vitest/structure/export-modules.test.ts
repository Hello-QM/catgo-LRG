/**
 * Tests for structure export modules:
 *   common-export, qe-export, orca-export, gaussian-export, abacus-export, lammps-export
 */
import type { AnyStructure } from '$lib'
import type { PymatgenStructure } from '$lib/structure'
import {
  ATOMIC_MASSES,
  MAGMOM_DATABASE,
  MAGMOM_DEFAULT,
  build_selective_dynamics,
  download_file,
  generate_magmom_string,
  get_atom_mass,
  get_constrained_atoms_info,
  get_unique_elements,
  parse_index_range,
  type FixAtomParams,
} from '$lib/structure/export/common-export'
import { gen_abacus_input, type AbacusParams } from '$lib/structure/export/abacus-export'
import { gen_qe_local, gen_dos_input, type QEParams, type QEDosParams } from '$lib/structure/export/qe-export'
import { gen_orca_input, type OrcaParams } from '$lib/structure/export/orca-export'
import { generate_gaussian_input, apply_gaussian_preset, type GaussianParams } from '$lib/structure/export/gaussian-export'
import { gen_lammps_local, make_lmp_preset, type LammpsLocalParams } from '$lib/structure/export/lammps-export'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

/** Minimal periodic structure: NaCl-like with 2 atoms */
const nacl_structure: PymatgenStructure = {
  sites: [
    {
      species: [{ element: `Na` as any, occu: 1, oxidation_state: 1 }],
      abc: [0.0, 0.0, 0.0] as any,
      xyz: [0.0, 0.0, 0.0] as any,
      label: `Na`,
      properties: {},
    },
    {
      species: [{ element: `Cl` as any, occu: 1, oxidation_state: -1 }],
      abc: [0.5, 0.5, 0.5] as any,
      xyz: [2.81, 2.81, 2.81] as any,
      label: `Cl`,
      properties: {},
    },
  ],
  lattice: {
    matrix: [
      [5.62, 0.0, 0.0],
      [0.0, 5.62, 0.0],
      [0.0, 0.0, 5.62],
    ] as any,
    pbc: [true, true, true] as any,
    a: 5.62, b: 5.62, c: 5.62,
    alpha: 90, beta: 90, gamma: 90,
    volume: 177.504,
  },
}

/** Small molecule (water) without lattice — used for molecular codes */
const h2o_molecule: AnyStructure = {
  sites: [
    {
      species: [{ element: `O` as any, occu: 1, oxidation_state: -2 }],
      abc: [0, 0, 0] as any,
      xyz: [0.0, 0.0, 0.117] as any,
      label: `O`,
      properties: {},
    },
    {
      species: [{ element: `H` as any, occu: 1, oxidation_state: 1 }],
      abc: [0, 0, 0] as any,
      xyz: [0.0, 0.757, -0.469] as any,
      label: `H`,
      properties: {},
    },
    {
      species: [{ element: `H` as any, occu: 1, oxidation_state: 1 }],
      abc: [0, 0, 0] as any,
      xyz: [0.0, -0.757, -0.469] as any,
      label: `H`,
      properties: {},
    },
  ],
}

/** Fe structure for magmom testing */
const fe_structure: AnyStructure = {
  sites: [
    { species: [{ element: `Fe` as any, occu: 1, oxidation_state: 0 }], abc: [0, 0, 0] as any, xyz: [0, 0, 0] as any, label: `Fe`, properties: {} },
    { species: [{ element: `Fe` as any, occu: 1, oxidation_state: 0 }], abc: [0.5, 0.5, 0.5] as any, xyz: [1.43, 1.43, 1.43] as any, label: `Fe`, properties: {} },
    { species: [{ element: `O` as any, occu: 1, oxidation_state: -2 }], abc: [0.25, 0.25, 0.25] as any, xyz: [0.71, 0.71, 0.71] as any, label: `O`, properties: {} },
  ],
}

/** Default fix params (no constraints) */
const no_fix: FixAtomParams = {
  fix_mode: `none`,
  fix_z_threshold: 0,
  selected_indices: [],
  constrained_atoms_info: { count: 0, details: [] },
}

// ===========================================================================
// common-export.ts
// ===========================================================================
describe(`common-export`, () => {
  describe(`get_atom_mass`, () => {
    it(`returns correct mass for known elements`, () => {
      expect(get_atom_mass(`Fe`)).toBe(ATOMIC_MASSES[`Fe`])
      expect(get_atom_mass(`O`)).toBe(15.999)
      expect(get_atom_mass(`H`)).toBe(1.008)
    })

    it(`returns 0 for unknown elements`, () => {
      expect(get_atom_mass(`Uue`)).toBe(0)
      expect(get_atom_mass(``)).toBe(0)
    })
  })

  describe(`parse_index_range`, () => {
    it(`parses single indices (1-based input to 0-based output)`, () => {
      expect(parse_index_range(`1`, 10)).toEqual(new Set([0]))
      expect(parse_index_range(`3`, 10)).toEqual(new Set([2]))
    })

    it(`parses comma-separated indices`, () => {
      expect(parse_index_range(`1,3,5`, 10)).toEqual(new Set([0, 2, 4]))
    })

    it(`parses range expressions`, () => {
      expect(parse_index_range(`1-3`, 10)).toEqual(new Set([0, 1, 2]))
      expect(parse_index_range(`2-5`, 10)).toEqual(new Set([1, 2, 3, 4]))
    })

    it(`parses mixed ranges and single indices`, () => {
      expect(parse_index_range(`1-3,7,9-10`, 10)).toEqual(new Set([0, 1, 2, 6, 8, 9]))
    })

    it(`clamps to max_idx`, () => {
      const result = parse_index_range(`1-100`, 5)
      expect(result).toEqual(new Set([0, 1, 2, 3, 4]))
    })

    it(`returns empty set for empty string`, () => {
      expect(parse_index_range(``, 10)).toEqual(new Set())
      expect(parse_index_range(`   `, 10)).toEqual(new Set())
    })

    it(`ignores out-of-range indices`, () => {
      expect(parse_index_range(`0`, 5)).toEqual(new Set())  // 0-1 = -1, filtered
      expect(parse_index_range(`20`, 5)).toEqual(new Set())
    })
  })

  describe(`get_unique_elements`, () => {
    it(`extracts unique sorted elements from structure`, () => {
      expect(get_unique_elements(nacl_structure)).toEqual([`Cl`, `Na`])
    })

    it(`returns sorted unique elements for duplicates`, () => {
      expect(get_unique_elements(fe_structure)).toEqual([`Fe`, `O`])
    })

    it(`returns empty for null/undefined structure`, () => {
      expect(get_unique_elements(null as any)).toEqual([])
      expect(get_unique_elements({ sites: [] } as any)).toEqual([])
    })
  })

  describe(`get_constrained_atoms_info`, () => {
    it(`returns empty for unconstrained structure`, () => {
      const info = get_constrained_atoms_info(nacl_structure)
      expect(info.count).toBe(0)
      expect(info.details).toEqual([])
    })

    it(`detects constrained atoms`, () => {
      const constrained: AnyStructure = {
        sites: [
          { species: [{ element: `Fe` as any, occu: 1, oxidation_state: 0 }], abc: [0, 0, 0] as any, xyz: [0, 0, 0] as any, label: `Fe`, properties: { selective_dynamics: [false, false, false] } },
          { species: [{ element: `O` as any, occu: 1, oxidation_state: 0 }], abc: [0.5, 0.5, 0.5] as any, xyz: [1, 1, 1] as any, label: `O`, properties: { selective_dynamics: [true, true, true] } },
        ],
      }
      const info = get_constrained_atoms_info(constrained)
      expect(info.count).toBe(1)
      expect(info.details[0].element).toBe(`Fe`)
      expect(info.details[0].constraint).toEqual([false, false, false])
    })
  })

  describe(`generate_magmom_string`, () => {
    it(`uses database values for magnetic elements`, () => {
      const result = generate_magmom_string(fe_structure, {})
      // Fe appears twice, O once
      expect(result).toContain(`2*${MAGMOM_DATABASE[`Fe`].toFixed(3)}`)
      expect(result).toContain(`1*${MAGMOM_DEFAULT.toFixed(3)}`)
    })

    it(`uses overrides when provided`, () => {
      const result = generate_magmom_string(fe_structure, { Fe: 5.0 })
      expect(result).toContain(`2*5.000`)
    })

    it(`returns empty for null structure`, () => {
      expect(generate_magmom_string(null as any, {})).toBe(``)
    })
  })

  describe(`build_selective_dynamics`, () => {
    it(`returns all-true for fix_mode=none`, () => {
      const sd = build_selective_dynamics(nacl_structure, no_fix)
      expect(sd).toEqual([[true, true, true], [true, true, true]])
    })

    it(`fixes selected indices`, () => {
      const fix: FixAtomParams = { ...no_fix, fix_mode: `selected`, selected_indices: [0] }
      const sd = build_selective_dynamics(nacl_structure, fix)
      expect(sd[0]).toEqual([false, false, false])
      expect(sd[1]).toEqual([true, true, true])
    })

    it(`fixes atoms below z threshold`, () => {
      const fix: FixAtomParams = { ...no_fix, fix_mode: `z_below`, fix_z_threshold: 1.0 }
      const sd = build_selective_dynamics(nacl_structure, fix)
      // Na at z=0 should be fixed, Cl at z=2.81 should be free
      expect(sd[0]).toEqual([false, false, false])
      expect(sd[1]).toEqual([true, true, true])
    })
  })

  describe(`download_file`, () => {
    it(`routes through the shared download() helper (Tauri-aware native save)`, () => {
      // download_file delegates to io/fetch download(), which uses the native
      // save override (globalThis.download) in the desktop app — a raw
      // <a download> click is a no-op in WebKitGTK.
      const dl = vi.fn()
      ;(globalThis as Record<string, unknown>).download = dl
      download_file(`test content`, `test.txt`)
      expect(dl).toHaveBeenCalledWith(`test content`, `test.txt`, `text/plain`)
      delete (globalThis as Record<string, unknown>).download
    })
  })
})

// ===========================================================================
// qe-export.ts
// ===========================================================================
describe(`qe-export`, () => {
  const default_qe_params: QEParams = {
    calculation: `scf`,
    prefix: `nacl`,
    ecutwfc: 50,
    ecutrho: 400,
    kpoints_auto: true,
    kpoints: [4, 4, 4],
    kspacing: 0.05,
    degauss: 0.01,
    conv_thr: 1e-6,
    forc_conv_thr: 1e-4,
    press: 0,
    coord_type: `crystal`,
    pseudo_dir: `./pseudo/`,
    pseudopotentials: { Na: `Na.upf`, Cl: `Cl.upf` },
    disk_io: `low`,
    wf_collect: true,
    tprnfor: true,
    tstress: true,
    unique_elements: [`Na`, `Cl`],
  }

  it(`generates valid QE SCF input`, () => {
    const output = gen_qe_local(nacl_structure, default_qe_params, no_fix)
    expect(output).toContain(`&CONTROL`)
    expect(output).toContain(`calculation = 'scf'`)
    expect(output).toContain(`prefix = 'nacl'`)
    expect(output).toContain(`ecutwfc = 50`)
    expect(output).toContain(`ATOMIC_SPECIES`)
    expect(output).toContain(`Na`)
    expect(output).toContain(`Cl`)
    expect(output).toContain(`CELL_PARAMETERS {angstrom}`)
    expect(output).toContain(`ATOMIC_POSITIONS {crystal}`)
    expect(output).toContain(`K_POINTS automatic`)
  })

  it(`includes IONS block for relax calculations`, () => {
    const relax_params = { ...default_qe_params, calculation: `relax` as const }
    const output = gen_qe_local(nacl_structure, relax_params, no_fix)
    expect(output).toContain(`&IONS`)
    expect(output).toContain(`ion_dynamics = 'bfgs'`)
    expect(output).toContain(`forc_conv_thr`)
  })

  it(`includes CELL block for vc-relax`, () => {
    const vc_params = { ...default_qe_params, calculation: `vc-relax` as const }
    const output = gen_qe_local(nacl_structure, vc_params, no_fix)
    expect(output).toContain(`&CELL`)
    expect(output).toContain(`cell_dynamics = 'bfgs'`)
  })

  it(`adds selective dynamics flags for relax with fixed atoms`, () => {
    const fix: FixAtomParams = { ...no_fix, fix_mode: `selected`, selected_indices: [0] }
    const relax_params = { ...default_qe_params, calculation: `relax` as const }
    const output = gen_qe_local(nacl_structure, relax_params, fix)
    // Fixed atom should have 0 0 0 flags
    expect(output).toMatch(/Na\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+0 0 0/)
  })

  it(`returns empty string for null structure`, () => {
    expect(gen_qe_local(null as any, default_qe_params, no_fix)).toBe(``)
  })

  it(`generates DOS input`, () => {
    const dos_params: QEDosParams = { prefix: `nacl`, emin: -10, emax: 10, deltae: 0.01 }
    const output = gen_dos_input(dos_params)
    expect(output).toContain(`&DOS`)
    expect(output).toContain(`prefix = 'nacl'`)
    expect(output).toContain(`emin = -10`)
    expect(output).toContain(`emax = 10`)
    expect(output).toContain(`deltae = 0.01`)
  })
})

// ===========================================================================
// orca-export.ts
// ===========================================================================
describe(`orca-export`, () => {
  const default_orca_params: OrcaParams = {
    run_type: `SP`,
    method: `DFT`,
    functional: `B3LYP`,
    functional_custom: ``,
    wavefunction: ``,
    uno_enabled: false,
    uco_enabled: false,
    basis: `def2-SVP`,
    charge: 0,
    multiplicity: 1,
    opt_convergence: `Opt`,
    use_cartesian: false,
    frozen_mode: `none`,
    frozen_z: 0,
    md_initvel: 300,
    md_run: 1000,
    cim_method: `DLPNO-CCSD(T)`,
    cim_thresh: 0.03,
    selected_indices: [],
  }

  it(`generates SP input with DFT method`, () => {
    const output = gen_orca_input(h2o_molecule, default_orca_params)
    expect(output).toContain(`! SP B3LYP def2-SVP`)
    expect(output).toContain(`* xyz 0 1`)
    expect(output).toContain(`O`)
    expect(output).toContain(`H`)
    expect(output).toMatch(/\*$/)  // ends with closing *
  })

  it(`generates Opt input with frozen atoms`, () => {
    const opt_params: OrcaParams = {
      ...default_orca_params,
      run_type: `Opt`,
      frozen_mode: `selected`,
      selected_indices: [0],
    }
    const output = gen_orca_input(h2o_molecule, opt_params)
    expect(output).toContain(`! Opt`)
    expect(output).toContain(`> Constraints`)
    expect(output).toContain(`{ C 0 C }`)
  })

  it(`generates MD input`, () => {
    const md_params: OrcaParams = { ...default_orca_params, run_type: `MD` }
    const output = gen_orca_input(h2o_molecule, md_params)
    expect(output).toContain(`%md`)
    expect(output).toContain(`Initvel 300_K`)
    expect(output).toContain(`Run 1000`)
  })

  it(`generates CIM input`, () => {
    const cim_params: OrcaParams = { ...default_orca_params, run_type: `CIM` }
    const output = gen_orca_input(h2o_molecule, cim_params)
    expect(output).toContain(`! CIM DLPNO-CCSD(T)`)
    expect(output).toContain(`%cim`)
    expect(output).toContain(`CIMTHRESH 0.03`)
  })

  it(`supports custom functional`, () => {
    const params: OrcaParams = { ...default_orca_params, functional: `other`, functional_custom: `PBE0` }
    const output = gen_orca_input(h2o_molecule, params)
    expect(output).toContain(`! SP PBE0 def2-SVP`)
  })

  it(`includes UNO/UCO keywords`, () => {
    const params: OrcaParams = { ...default_orca_params, uno_enabled: true, uco_enabled: true }
    const output = gen_orca_input(h2o_molecule, params)
    expect(output).toContain(`UNO`)
    expect(output).toContain(`UCO`)
  })

  it(`returns empty for null structure`, () => {
    expect(gen_orca_input(null as any, default_orca_params)).toBe(``)
  })
})

// ===========================================================================
// gaussian-export.ts
// ===========================================================================
describe(`gaussian-export`, () => {
  const default_gaussian_params: GaussianParams = {
    prefix: `h2o`,
    job_type: `opt`,
    method: `B3LYP`,
    basis: `6-31G*`,
    charge: 0,
    multiplicity: 1,
    nproc: 4,
    mem: `4GB`,
    chk: true,
    dispersion: `none`,
    solvation: `none`,
    solvent: `Water`,
    td_nstates: 10,
    pop: `none`,
    nosymm: false,
    out_wfn: `none`,
    title: `water optimization`,
    extra_keywords: ``,
  }

  it(`generates valid Gaussian opt input`, () => {
    const result = generate_gaussian_input(h2o_molecule, default_gaussian_params)
    expect(Object.keys(result)).toEqual([`h2o.gjf`])
    const content = result[`h2o.gjf`]
    expect(content).toContain(`%chk=h2o.chk`)
    expect(content).toContain(`%nproc=4`)
    expect(content).toContain(`%mem=4GB`)
    expect(content).toContain(`#p B3LYP/6-31G* Opt`)
    expect(content).toContain(`water optimization`)
    expect(content).toContain(`0 1`)
    expect(content).toContain(`O`)
    expect(content).toContain(`H`)
  })

  it(`includes dispersion keyword`, () => {
    const params = { ...default_gaussian_params, dispersion: `EmpiricalDispersion=GD3BJ` }
    const content = Object.values(generate_gaussian_input(h2o_molecule, params))[0]
    expect(content).toContain(`EmpiricalDispersion=GD3BJ`)
  })

  it(`includes solvation keywords`, () => {
    const params = { ...default_gaussian_params, solvation: `scrf`, solvent: `Water` }
    const content = Object.values(generate_gaussian_input(h2o_molecule, params))[0]
    expect(content).toContain(`SCRF=(SMD,Solvent=Water)`)
  })

  it(`generates TD-DFT input`, () => {
    const params = { ...default_gaussian_params, job_type: `td` as const }
    const content = Object.values(generate_gaussian_input(h2o_molecule, params))[0]
    expect(content).toContain(`TD(NStates=10)`)
  })

  it(`generates TS search input`, () => {
    const params = { ...default_gaussian_params, job_type: `ts` as const }
    const content = Object.values(generate_gaussian_input(h2o_molecule, params))[0]
    expect(content).toContain(`Opt=(CalcFC,TS,NoEigen)`)
  })

  it(`throws for null structure`, () => {
    expect(() => generate_gaussian_input(null as any, default_gaussian_params)).toThrow(`No structure`)
  })

  describe(`apply_gaussian_preset`, () => {
    it(`returns correct quick_opt preset`, () => {
      const p = apply_gaussian_preset(`quick_opt`)
      expect(p.job_type).toBe(`opt`)
      expect(p.method).toBe(`B3LYP`)
      expect(p.basis).toBe(`6-31G*`)
    })

    it(`returns correct accurate preset`, () => {
      const p = apply_gaussian_preset(`accurate`)
      expect(p.job_type).toBe(`opt_freq`)
      expect(p.dispersion).toContain(`GD3BJ`)
    })

    it(`returns correct td_dft preset`, () => {
      const p = apply_gaussian_preset(`td_dft`)
      expect(p.job_type).toBe(`td`)
      expect(p.td_nstates).toBe(10)
    })

    it(`returns correct ts_search preset`, () => {
      const p = apply_gaussian_preset(`ts_search`)
      expect(p.job_type).toBe(`ts`)
    })
  })
})

// ===========================================================================
// abacus-export.ts
// ===========================================================================
describe(`abacus-export`, () => {
  const default_abacus_params: AbacusParams = {
    prefix: `nacl`,
    calculation: `scf`,
    basis_type: `pw`,
    ecutwfc: 80,
    kpoints_auto: true,
    kpoints: [4, 4, 4],
    kspacing: 0.05,
    scf_nmax: 100,
    scf_thr: 1e-7,
    smearing_method: `gauss`,
    smearing_sigma: 0.01,
    nspin: 1,
    dft_functional: `PBE`,
    mixing_type: `pulay`,
    mixing_beta: 0.4,
    force_thr: 1e-4,
    stress_thr: 0.5,
    relax_nmax: 50,
    symmetry: 1,
    cal_force: true,
    cal_stress: true,
    out_chg: false,
    out_band: false,
    pseudo_dir: `./pseudo/`,
    orbital_dir: `./orb/`,
    pseudopotentials: { Na: `Na_ONCV_PBE-1.0.upf`, Cl: `Cl_ONCV_PBE-1.0.upf` },
    orbitals: {},
    md_type: `nvt`,
    md_nstep: 1000,
    md_dt: 1.0,
    md_temp: 300,
    unique_elements: [`Na`, `Cl`],
  }

  it(`generates INPUT, STRU, and KPT files`, () => {
    const result = gen_abacus_input(nacl_structure, default_abacus_params, no_fix)
    expect(result).toHaveProperty(`INPUT`)
    expect(result).toHaveProperty(`STRU`)
    expect(result).toHaveProperty(`KPT`)
  })

  it(`INPUT contains correct parameters`, () => {
    const { INPUT } = gen_abacus_input(nacl_structure, default_abacus_params, no_fix)
    expect(INPUT).toContain(`INPUT_PARAMETERS`)
    expect(INPUT).toContain(`calculation             scf`)
    expect(INPUT).toContain(`basis_type              pw`)
    expect(INPUT).toContain(`ecutwfc                 80`)
    expect(INPUT).toContain(`dft_functional          PBE`)
  })

  it(`STRU contains atomic species and positions`, () => {
    const { STRU } = gen_abacus_input(nacl_structure, default_abacus_params, no_fix)
    expect(STRU).toContain(`ATOMIC_SPECIES`)
    expect(STRU).toContain(`Na`)
    expect(STRU).toContain(`Cl`)
    expect(STRU).toContain(`LATTICE_VECTORS`)
    expect(STRU).toContain(`ATOMIC_POSITIONS`)
    expect(STRU).toContain(`Direct`)
  })

  it(`KPT contains k-point grid`, () => {
    const { KPT } = gen_abacus_input(nacl_structure, default_abacus_params, no_fix)
    expect(KPT).toContain(`K_POINTS`)
    expect(KPT).toContain(`Gamma`)
    expect(KPT).toContain(`4 4 4 0 0 0`)
  })

  it(`includes relax settings for relax calculation`, () => {
    const relax_params = { ...default_abacus_params, calculation: `relax` as const }
    const { INPUT } = gen_abacus_input(nacl_structure, relax_params, no_fix)
    expect(INPUT).toContain(`relax_nmax`)
    expect(INPUT).toContain(`force_thr`)
  })

  it(`includes MD settings`, () => {
    const md_params = { ...default_abacus_params, calculation: `md` as const }
    const { INPUT } = gen_abacus_input(nacl_structure, md_params, no_fix)
    expect(INPUT).toContain(`md_nstep                1000`)
    expect(INPUT).toContain(`md_dt                   1`)
    expect(INPUT).toContain(`md_tfirst               300`)
  })

  it(`includes LCAO orbital section when basis_type is lcao`, () => {
    const lcao_params = { ...default_abacus_params, basis_type: `lcao` as const, orbitals: { Na: `Na_orb.orb`, Cl: `Cl_orb.orb` } }
    const { INPUT, STRU } = gen_abacus_input(nacl_structure, lcao_params, no_fix)
    expect(INPUT).toContain(`orbital_dir`)
    expect(STRU).toContain(`NUMERICAL_ORBITAL`)
    expect(STRU).toContain(`Na_orb.orb`)
  })

  it(`adds selective dynamics for relax with fixed atoms`, () => {
    const fix: FixAtomParams = { ...no_fix, fix_mode: `selected`, selected_indices: [0] }
    const relax_params = { ...default_abacus_params, calculation: `relax` as const }
    const { STRU } = gen_abacus_input(nacl_structure, relax_params, fix)
    expect(STRU).toContain(`m 0 0 0`)
  })

  it(`returns empty object for null structure`, () => {
    expect(gen_abacus_input(null as any, default_abacus_params, no_fix)).toEqual({})
  })
})

// ===========================================================================
// lammps-export.ts
// ===========================================================================
describe(`lammps-export`, () => {
  const default_lammps_params: LammpsLocalParams = {
    prefix: `nacl`,
    units: `metal`,
    atom_style: `atomic`,
    boundary: `p p p`,
    simulation_type: `minimize`,
    pair_style: `eam/alloy`,
    pair_coeff: ``,
    min_style: `cg`,
    etol: 1e-6,
    ftol: 1e-8,
    maxiter: 10000,
    timestep: 0.001,
    temperature: 300,
    pressure: 1.0,
    run_steps: 5000,
    tdamp: 100,
    pdamp: 1000,
    thermo_freq: 100,
    dump_freq: 1000,
    unique_elements: [`Na`, `Cl`],
  }

  it(`generates input and data files`, () => {
    const { input, data } = gen_lammps_local(nacl_structure, default_lammps_params, no_fix)
    expect(input).toBeTruthy()
    expect(data).toBeTruthy()
  })

  it(`data file contains header and atoms`, () => {
    const { data } = gen_lammps_local(nacl_structure, default_lammps_params, no_fix)
    expect(data).toContain(`2 atoms`)
    expect(data).toContain(`2 atom types`)
    expect(data).toContain(`Masses`)
    expect(data).toContain(`Atoms # atomic`)
    expect(data).toContain(`xlo xhi`)
    expect(data).toContain(`ylo yhi`)
    expect(data).toContain(`zlo zhi`)
  })

  it(`input file contains simulation commands`, () => {
    const { input } = gen_lammps_local(nacl_structure, default_lammps_params, no_fix)
    expect(input).toContain(`units metal`)
    expect(input).toContain(`atom_style atomic`)
    expect(input).toContain(`boundary p p p`)
    expect(input).toContain(`read_data nacl.data`)
    expect(input).toContain(`pair_style eam/alloy`)
    expect(input).toContain(`min_style cg`)
    expect(input).toContain(`minimize`)
  })

  it(`generates NVT input`, () => {
    const nvt_params = { ...default_lammps_params, simulation_type: `nvt` as const }
    const { input } = gen_lammps_local(nacl_structure, nvt_params, no_fix)
    expect(input).toContain(`fix 1 all nvt temp 300 300 100`)
    expect(input).toContain(`run 5000`)
    expect(input).toContain(`dump`)
  })

  it(`generates NPT input`, () => {
    const npt_params = { ...default_lammps_params, simulation_type: `npt` as const }
    const { input } = gen_lammps_local(nacl_structure, npt_params, no_fix)
    expect(input).toContain(`fix 1 all npt`)
    expect(input).toContain(`iso 1 1 1000`)
  })

  it(`handles fixed atoms in input`, () => {
    const fix: FixAtomParams = { ...no_fix, fix_mode: `selected`, selected_indices: [0] }
    const { input } = gen_lammps_local(nacl_structure, default_lammps_params, fix)
    expect(input).toContain(`group fixed id 1`)
    expect(input).toContain(`group mobile subtract all fixed`)
    expect(input).toContain(`fix freeze fixed setforce 0.0 0.0 0.0`)
  })

  it(`returns empty for null structure`, () => {
    const { input, data } = gen_lammps_local(null as any, default_lammps_params, no_fix)
    expect(input).toBe(``)
    expect(data).toBe(``)
  })

  describe(`make_lmp_preset`, () => {
    it(`creates equil preset with 3 stages`, () => {
      const { stages, next_id } = make_lmp_preset(`equil`)
      expect(stages).toHaveLength(3)
      expect(stages[0].stage_type).toBe(`minimize`)
      expect(stages[1].stage_type).toBe(`nvt`)
      expect(stages[2].stage_type).toBe(`npt`)
      expect(next_id).toBe(4)
    })

    it(`creates anneal preset with 5 stages`, () => {
      const { stages } = make_lmp_preset(`anneal`)
      expect(stages).toHaveLength(5)
      expect(stages[2].stage_type).toBe(`temp`)
      expect(stages[2].temp_start).toBe(300)
      expect(stages[2].temp_end).toBe(800)
    })

    it(`creates melt-quench preset`, () => {
      const { stages } = make_lmp_preset(`melt-quench`)
      expect(stages).toHaveLength(3)
      expect(stages[1].temperature).toBe(2500)
    })
  })
})
