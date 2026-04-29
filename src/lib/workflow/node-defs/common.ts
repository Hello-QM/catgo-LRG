import type { ParamDef, ShowIfCondition } from '../workflow-types'

// ====== Software periodicity classification ======

/** Which system types each software supports: 'periodic', 'molecular', or both */
export const SOFTWARE_PERIODICITY: Record<string, (`periodic` | `molecular`)[]> = {
  vasp: [`periodic`],
  cp2k: [`periodic`, `molecular`],
  orca: [`molecular`],
  gaussian: [`molecular`],
  xtb: [`periodic`, `molecular`],
  mlp: [`periodic`, `molecular`],
  lammps: [`periodic`, `molecular`],
  gromacs: [`periodic`, `molecular`],
  amber: [`molecular`],
  sella: [`periodic`, `molecular`],
}

export const SYSTEM_TYPE_PARAM: ParamDef = {
  key: `system_type`, label: `System Type`, type: `select`, default: `periodic`, group: `Software`,
  options: [
    { label: `Periodic (crystal/slab/bulk)`, value: `periodic` },
    { label: `Molecular (cluster/molecule)`, value: `molecular` },
  ],
  help: `Periodic systems use plane-wave codes (VASP, QE). Molecular systems use localized basis codes (Gaussian, ORCA). Some codes (CP2K, xTB, MLP) support both.`,
}

// ====== show_if helper functions ======

/**
 * Merge a software show_if condition into each param without overwriting any
 * existing nested show_if conditions. Result is always a ShowIfCondition[].
 */
function with_software(sw: string, params: ParamDef[]): ParamDef[] {
  const cond: ShowIfCondition = { key: `software`, values: [sw] }
  return params.map(p => {
    if (!p.show_if) return { ...p, show_if: cond }
    const existing = Array.isArray(p.show_if) ? p.show_if : [p.show_if]
    return { ...p, show_if: [...existing, cond] }
  })
}

/** Restrict params to only show when software === 'vasp' */
export function vasp_only(params: ParamDef[]): ParamDef[] {
  return with_software(`vasp`, params)
}

export function cp2k_only(params: ParamDef[]): ParamDef[] {
  return with_software(`cp2k`, params)
}

export function orca_only(params: ParamDef[]): ParamDef[] {
  return with_software(`orca`, params)
}

export function xtb_only(params: ParamDef[]): ParamDef[] {
  return with_software(`xtb`, params)
}

export function mlp_only(params: ParamDef[]): ParamDef[] {
  return with_software(`mlp`, params)
}

export function lammps_only(params: ParamDef[]): ParamDef[] {
  return with_software(`lammps`, params)
}

export function gaussian_only(params: ParamDef[]): ParamDef[] {
  return with_software(`gaussian`, params)
}

export function gromacs_only(params: ParamDef[]): ParamDef[] {
  return with_software(`gromacs`, params)
}

export function amber_only(params: ParamDef[]): ParamDef[] {
  return params.map(p => ({ ...p, show_if: { key: `software`, values: [`amber`] } }))
}

export function sella_show(params: ParamDef[]): ParamDef[] {
  return with_software(`sella`, params)
}

// ====== Reusable param groups ======

export const INCAR_COMMON: ParamDef[] = [
  {
    key: `ENCUT`, label: `Cutoff Energy (eV)`, type: `number`, default: 520,
    group: `INCAR`, min: 200, max: 900, step: 10,
    help: `Plane-wave energy cutoff. Higher = more accurate but slower. 520 eV is standard for most VASP PAW potentials.`,
  },
  {
    key: `EDIFF`, label: `SCF Convergence`, type: `select`, default: `1e-5`, group: `INCAR`,
    options: [
      { label: `1e-4 (loose)`, value: `1e-4` },
      { label: `1e-5 (standard)`, value: `1e-5` },
      { label: `1e-6 (tight)`, value: `1e-6` },
      { label: `1e-7 (very tight)`, value: `1e-7` },
    ],
    help: `Energy convergence criterion for the electronic self-consistency loop.`,
  },
  {
    key: `PREC`, label: `Precision`, type: `select`, default: `Accurate`, group: `INCAR`,
    options: [
      { label: `Low`, value: `Low` },
      { label: `Normal`, value: `Normal` },
      { label: `Accurate`, value: `Accurate` },
      { label: `Single`, value: `Single` },
    ],
    help: `Affects FFT grids and projection operators. Use Accurate for production runs.`,
  },
]

/** VASP electronic structure parameters (smearing, algorithm, spin) */
export const VASP_ELECTRONIC_PARAMS: ParamDef[] = [
  {
    key: `ALGO`, label: `Electronic Algorithm`, type: `select`, default: `Fast`, group: `Electronic`,
    options: [
      { label: `Fast`, value: `Fast` },
      { label: `Normal`, value: `Normal` },
      { label: `VeryFast`, value: `VeryFast` },
      { label: `All`, value: `All` },
      { label: `Damped`, value: `Damped` },
    ],
    help: `Electronic minimization algorithm. Fast=Davidson+RMM-DIIS (default). All=conjugate gradient (hybrids). Damped=difficult convergence.`,
  },
  {
    key: `ISMEAR`, label: `Smearing`, type: `select`, default: 0, group: `Electronic`,
    options: [
      { label: `Tetrahedron w/ Blöchl (-5)`, value: -5 },
      { label: `Fermi (-1)`, value: -1 },
      { label: `Gaussian (0)`, value: 0 },
      { label: `MP Order 1 (1)`, value: 1 },
      { label: `MP Order 2 (2)`, value: 2 },
    ],
    help: `Electronic smearing method. Use Gaussian (0) for molecules/slabs, MP (1) for metals, Tetrahedron (-5) for DOS/accurate energies.`,
  },
  {
    key: `SIGMA`, label: `Smearing Width (eV)`, type: `number`, default: 0.05, group: `Electronic`,
    min: 0.001, max: 1.0, step: 0.01,
    help: `Smearing width in eV. 0.05 for insulators, 0.2 for metals. Not used with tetrahedron method (ISMEAR=-5).`,
  },
  {
    key: `LREAL`, label: `Real-Space Projection`, type: `select`, default: `Auto`, group: `Electronic`,
    options: [
      { label: `Auto`, value: `Auto` },
      { label: `.TRUE.`, value: `.TRUE.` },
      { label: `.FALSE.`, value: `.FALSE.` },
    ],
    help: `Projection in real space (faster for large cells) or reciprocal space (more accurate). Auto lets VASP decide.`,
  },
  {
    key: `NELM`, label: `Max SCF Iterations`, type: `number`, default: 200, group: `Electronic`,
    min: 10, max: 500, step: 10,
    help: `Maximum number of electronic self-consistency steps. Increase for difficult convergence.`,
  },
  {
    key: `ISPIN`, label: `Spin Polarization`, type: `select`, default: 1, group: `Electronic`,
    options: [
      { label: `Non-spin-polarized (1)`, value: 1 },
      { label: `Spin-polarized (2)`, value: 2 },
    ],
    help: `Enable spin polarization. Required for magnetic systems (Fe, Co, Ni, Mn, etc.).`,
  },
  {
    key: `MAGMOM`, label: `Magnetic Moments`, type: `string`, default: ``, group: `Electronic`,
    help: `Per-atom initial magnetic moments, e.g. '4*5.0 4*0.6'. Only used with ISPIN=2. Leave empty for VASP default.`,
  },
]

/** VASP output control parameters */
export const VASP_OUTPUT_PARAMS: ParamDef[] = [
  {
    key: `LORBIT`, label: `Orbital Projection`, type: `select`, default: 11, group: `Output`,
    options: [
      { label: `None (0)`, value: 0 },
      { label: `Standard (1)`, value: 1 },
      { label: `Phase factors (5)`, value: 5 },
      { label: `Projected DOS (10)`, value: 10 },
      { label: `Projected DOS + lm-decomposed (11)`, value: 11 },
      { label: `Phase-decomposed (12)`, value: 12 },
    ],
    help: `Write projected DOS and orbital character to DOSCAR/PROCAR. 11 is recommended for most analyses.`,
  },
  {
    key: `LWAVE`, label: `Write WAVECAR`, type: `boolean`, default: false, group: `Output`,
    help: `Write wavefunction file. Required for restart or hybrid functional calculations. Large file size.`,
  },
  {
    key: `LCHARG`, label: `Write CHGCAR`, type: `boolean`, default: true, group: `Output`,
    help: `Write charge density file. Required for non-SCF calculations (DOS, band structure).`,
  },
  {
    key: `LAECHG`, label: `Write AE Charge Density`, type: `boolean`, default: false, group: `Output`,
    help: `Write all-electron charge density (AECCAR files). Required for Bader charge analysis.`,
  },
]

/** VASP parallelization parameters */
export const VASP_PARALLELIZATION_PARAMS: ParamDef[] = [
  {
    key: `NPAR`, label: `NPAR`, type: `number`, default: 0, group: `Parallelization`,
    min: 0, max: 128,
    help: `Number of bands treated in parallel. 0=auto. Typically sqrt(total cores). Mutually exclusive with NCORE.`,
  },
  {
    key: `KPAR`, label: `KPAR`, type: `number`, default: 0, group: `Parallelization`,
    min: 0, max: 128,
    help: `Number of k-points treated in parallel. Must divide total k-points evenly. 0=auto.`,
  },
  {
    key: `NCORE`, label: `NCORE`, type: `number`, default: 4, group: `Parallelization`,
    min: 1, max: 128,
    help: `Number of cores per orbital band. Typical: 4-8. Mutually exclusive with NPAR.`,
  },
]

/** VASP dispersion / vdW correction parameters */
export const VASP_DISPERSION_PARAMS: ParamDef[] = [
  {
    key: `IVDW`, label: `vdW Correction`, type: `select`, default: 0, group: `Dispersion`,
    options: [
      { label: `None (0)`, value: 0 },
      { label: `DFT-D3 (11)`, value: 11 },
      { label: `DFT-D3(BJ) (12)`, value: 12 },
      { label: `DFT-D4 (13)`, value: 13 },
    ],
    help: `Van der Waals dispersion correction. D3(BJ) recommended for most systems.`,
  },
  {
    key: `LDIPOL`, label: `Dipole Correction`, type: `boolean`, default: false, group: `Dispersion`,
    help: `Apply dipole correction for asymmetric slabs or molecules in a box.`,
  },
  {
    key: `IDIPOL`, label: `Dipole Direction`, type: `select`, default: 3, group: `Dispersion`,
    options: [
      { label: `x (1)`, value: 1 },
      { label: `y (2)`, value: 2 },
      { label: `z (3)`, value: 3 },
      { label: `All directions (4)`, value: 4 },
    ],
    help: `Direction of dipole correction. Only used with LDIPOL=true. 3=z-axis (slabs), 4=all (molecules).`,
  },
]

/** VASP advanced / miscellaneous parameters */
export const VASP_ADVANCED_PARAMS: ParamDef[] = [
  {
    key: `NBANDS`, label: `NBANDS`, type: `number`, default: 0, group: `Advanced`,
    min: 0, max: 5000,
    help: `Number of bands. 0=auto (VASP default). Increase for unoccupied states (optical, GW).`,
  },
  {
    key: `NEDOS`, label: `NEDOS`, type: `number`, default: 301, group: `Advanced`,
    min: 100, max: 10000, step: 100,
    help: `Number of grid points for DOS. Higher = smoother DOS plots. 301 is default, 2001 for publication.`,
  },
  {
    key: `ISTART`, label: `ISTART`, type: `select`, default: 0, group: `Advanced`,
    options: [
      { label: `0 — New calculation`, value: 0 },
      { label: `1 — Restart from WAVECAR`, value: 1 },
      { label: `2 — Restart (constant basis)`, value: 2 },
    ],
    help: `Job start mode. 0=new, 1=continue from WAVECAR (orbitals), 2=restart with same basis set.`,
  },
  {
    key: `ICHARG`, label: `ICHARG`, type: `select`, default: 0, group: `Advanced`,
    options: [
      { label: `0 — From initial wavefunctions`, value: 0 },
      { label: `1 — From CHGCAR`, value: 1 },
      { label: `2 — Superposition of atoms`, value: 2 },
      { label: `11 — Non-SCF from CHGCAR (DOS/bands)`, value: 11 },
    ],
    help: `Initial charge density. 0=from wavefunctions, 1=from CHGCAR, 2=atomic superposition, 11=non-SCF (bands/DOS).`,
  },
]

export const KPOINTS_PARAM: ParamDef = {
  key: `kpoints`, label: `K-Points Grid`, type: `kpoints`, default: `4×4×4`, group: `KPOINTS`,
  help: `Monkhorst-Pack k-point mesh for Brillouin zone sampling. Denser grids = more accurate. Use odd numbers for Gamma-centered grids.`,
}

/** @deprecated Use VASP_OUTPUT_PARAMS + VASP_PARALLELIZATION_PARAMS instead */
export const PARALLELIZATION_PARAMS: ParamDef[] = [
  ...VASP_OUTPUT_PARAMS.filter(p => [`LWAVE`, `LCHARG`].includes(p.key)),
  ...VASP_PARALLELIZATION_PARAMS.filter(p => p.key === `NCORE`),
]

// ====== CP2K common params ======

export const CP2K_DFT_PARAMS: ParamDef[] = [
  {
    key: `functional`, label: `XC Functional`, type: `select`, default: `PBE`, group: `DFT`,
    options: [
      { label: `PBE (GGA)`, value: `PBE` },
      { label: `BLYP (GGA)`, value: `BLYP` },
      { label: `revPBE (GGA)`, value: `revPBE` },
      { label: `PBEsol (GGA)`, value: `PBEsol` },
      { label: `SCAN (meta-GGA)`, value: `SCAN` },
      { label: `r2SCAN (meta-GGA)`, value: `r2SCAN` },
      { label: `PBE0 (Hybrid)`, value: `PBE0` },
      { label: `B3LYP (Hybrid)`, value: `B3LYP` },
      { label: `HSE06 (Hybrid)`, value: `HSE06` },
    ],
    help: `Exchange-correlation functional. PBE is the most common for solids.`,
  },
  {
    key: `basis_set`, label: `Basis Set`, type: `select`, default: `DZVP-MOLOPT-SR-GTH`, group: `DFT`,
    options: [
      { label: `DZVP-MOLOPT-SR-GTH (solids)`, value: `DZVP-MOLOPT-SR-GTH` },
      { label: `DZVP-MOLOPT-GTH (molecules)`, value: `DZVP-MOLOPT-GTH` },
      { label: `TZVP-MOLOPT-GTH (accurate)`, value: `TZVP-MOLOPT-GTH` },
      { label: `TZV2P-MOLOPT-GTH (high accuracy)`, value: `TZV2P-MOLOPT-GTH` },
    ],
    help: `Gaussian basis set. SR (short-range) variants are optimized for periodic systems.`,
  },
  {
    key: `cutoff`, label: `CUTOFF (Ry)`, type: `number`, default: 350, group: `DFT`,
    min: 200, max: 1200, step: 50,
    help: `Plane-wave cutoff for the auxiliary grid. Higher = more accurate.`,
  },
  {
    key: `rel_cutoff`, label: `REL_CUTOFF (Ry)`, type: `number`, default: 50, group: `DFT`,
    min: 30, max: 120, step: 10,
    help: `Relative cutoff controlling which grid level Gaussians are mapped to.`,
  },
  {
    key: `scf_method`, label: `SCF Method`, type: `select`, default: `OT`, group: `SCF`,
    options: [
      { label: `OT (Orbital Transformation)`, value: `OT` },
      { label: `Diagonalization (metals)`, value: `DIAG` },
    ],
    help: `OT is faster for insulators. Diag required for metals and smearing.`,
  },
  {
    key: `eps_scf`, label: `EPS_SCF`, type: `select`, default: `1e-6`, group: `SCF`,
    options: [
      { label: `1e-5 (loose)`, value: `1e-5` },
      { label: `1e-6 (standard)`, value: `1e-6` },
      { label: `1e-7 (tight)`, value: `1e-7` },
    ],
    help: `SCF convergence threshold. 1e-6 standard, 1e-7 for frequencies/properties.`,
  },
  {
    key: `vdw`, label: `Dispersion Correction`, type: `select`, default: `none`, group: `DFT`,
    options: [
      { label: `None`, value: `none` },
      { label: `DFT-D3(BJ)`, value: `DFTD3(BJ)` },
      { label: `DFT-D3`, value: `DFTD3` },
      { label: `DFT-D4`, value: `DFTD4` },
    ],
    help: `Van der Waals dispersion correction. D3(BJ) is recommended.`,
  },
  {
    key: `charge`, label: `Net Charge`, type: `number`, default: 0, group: `Advanced`, min: -10, max: 10, step: 1,
    help: `Total system charge. 0=neutral, positive=cation, negative=anion.`,
  },
  {
    key: `uks`, label: `Spin Polarized (UKS)`, type: `boolean`, default: false, group: `Advanced`,
    help: `Unrestricted Kohn-Sham for open-shell / spin-polarized systems.`,
  },
  {
    key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `Advanced`, min: 1, max: 12, step: 1,
    help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
  },
  {
    key: `cp2k_command`, label: `CP2K Executable`, type: `string`, default: `cp2k.psmp`, group: `Advanced`,
    help: `CP2K executable command (e.g., cp2k.psmp, cp2k.popt).`,
  },
]

// ====== ORCA common params ======

export const ORCA_QC_PARAMS: ParamDef[] = [
  {
    key: `method`, label: `Method`, type: `select`, default: `B3LYP`, group: `Quantum`,
    options: [
      { label: `HF`, value: `HF` },
      { label: `B3LYP`, value: `B3LYP` },
      { label: `PBE`, value: `PBE` },
      { label: `PBE0`, value: `PBE0` },
      { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
      { label: `CCSD`, value: `CCSD` },
      { label: `CCSD(T)`, value: `CCSD(T)` },
      { label: `MP2`, value: `MP2` },
      { label: `DLPNO-CCSD(T)`, value: `DLPNO-CCSD(T)` },
    ],
    help: `Quantum chemistry method. r2SCAN-3c recommended for speed, DLPNO-CCSD(T) for benchmark accuracy.`,
  },
  {
    key: `basis`, label: `Basis Set`, type: `select`, default: `def2-SVP`, group: `Quantum`,
    options: [
      { label: `STO-3G`, value: `STO-3G` },
      { label: `6-31G`, value: `6-31G` },
      { label: `6-311G`, value: `6-311G` },
      { label: `cc-pVDZ`, value: `cc-pVDZ` },
      { label: `cc-pVTZ`, value: `cc-pVTZ` },
      { label: `def2-SVP`, value: `def2-SVP` },
      { label: `def2-TZVP`, value: `def2-TZVP` },
      { label: `def2-TZVPP`, value: `def2-TZVPP` },
    ],
    help: `Basis set. def2 family recommended for ORCA. def2-SVP for screening, def2-TZVP for production.`,
  },
  {
    key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
    help: `Total charge of the system.`,
  },
  {
    key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
    min: 1, max: 12, step: 1,
    help: `Spin multiplicity (1=singlet, 2=doublet, 3=triplet, etc).`,
  },
  {
    key: `maxiter`, label: `Max SCF Iterations`, type: `number`, default: 125, group: `SCF`,
    min: 10, max: 500, step: 25,
    help: `Maximum SCF iterations. Increase for difficult convergence (e.g. transition metals).`,
  },
  {
    key: `grid`, label: `Integration Grid`, type: `select`, default: `DefGrid2`, group: `SCF`,
    options: [
      { label: `DefGrid1 (coarse)`, value: `DefGrid1` },
      { label: `DefGrid2 (standard)`, value: `DefGrid2` },
      { label: `DefGrid3 (fine)`, value: `DefGrid3` },
    ],
    help: `DFT integration grid accuracy. DefGrid2 standard, DefGrid3 for tight convergence or meta-GGA.`,
  },
  {
    key: `dispersion`, label: `Dispersion`, type: `select`, default: `none`, group: `SCF`,
    options: [
      { label: `None`, value: `none` },
      { label: `D3BJ (recommended)`, value: `D3BJ` },
      { label: `D3`, value: `D3` },
      { label: `D4`, value: `D4` },
    ],
    help: `Empirical dispersion correction. D3BJ recommended for non-covalent interactions.`,
  },
]

// ====== xTB common params ======

export const XTB_METHOD_PARAMS: ParamDef[] = [
  {
    key: `method`, label: `xTB Method`, type: `select`, default: `GFN2-xTB`, group: `Method`,
    options: [
      { label: `GFN2-xTB (recommended)`, value: `GFN2-xTB` },
      { label: `GFN1-xTB`, value: `GFN1-xTB` },
      { label: `GFN0-xTB`, value: `GFN0-xTB` },
      { label: `GFN-FF`, value: `GFN-FF` },
      { label: `IPEA1-xTB`, value: `IPEA1-xTB` },
    ],
    help: `Semi-empirical tight-binding method.`,
  },
  {
    key: `accuracy`, label: `Accuracy`, type: `number`, default: 1.0, group: `Method`,
    min: 0.1, max: 3.0, step: 0.1,
    help: `Numerical accuracy parameter. Lower = tighter (1.0 is standard).`,
  },
  {
    key: `electronic_temperature`, label: `Electronic Temperature (K)`, type: `number`, default: 300, group: `Method`,
    min: 0, max: 10000, step: 100,
    help: `Electronic temperature for Fermi smearing. Higher values improve SCF convergence for metallic systems.`,
  },
]

// ====== MLP common params ======

export const MLP_MODEL_PARAM: ParamDef = {
  key: `model`, label: `ML Model`, type: `select`, default: `MACE`, group: `Model`,
  options: [
    { label: `MACE-MP (recommended)`, value: `MACE` },
    { label: `CHGNet`, value: `CHGNet` },
    { label: `M3GNet`, value: `M3GNet` },
  ],
  help: `Pre-trained universal potential to use.`,
}

export const MLP_DEVICE_PARAM: ParamDef = {
  key: `device`, label: `Device`, type: `select`, default: `auto`, group: `Model`,
  options: [
    { label: `Auto (CUDA if available)`, value: `auto` },
    { label: `CPU`, value: `cpu` },
    { label: `CUDA GPU`, value: `cuda` },
  ],
  help: `Which device to run the ML potential on. "Auto" picks CUDA if available on the execution node, else falls back to CPU.`,
}

export const MLP_MODEL_PATH_PARAM: ParamDef = {
  key: `model_path`, label: `Custom Model Path (optional)`, type: `string`, default: ``, group: `Model`,
  help: `Absolute path to a fine-tuned MACE .model checkpoint on the execution node. Leave empty to use the default mace-mp-0 medium foundation model.`,
}

/** Bundle of MLP params — use this in node defs instead of MLP_MODEL_PARAM alone. */
export const MLP_COMMON_PARAMS: ParamDef[] = [
  MLP_MODEL_PARAM,
  MLP_DEVICE_PARAM,
  MLP_MODEL_PATH_PARAM,
]

// ====== Gaussian common params ======

export const GAUSSIAN_QC_PARAMS: ParamDef[] = [
  {
    key: `method`, label: `Method`, type: `select`, default: `B3LYP`, group: `Method`,
    options: [
      { label: `HF`, value: `HF` },
      { label: `B3LYP`, value: `B3LYP` },
      { label: `PBE1PBE (PBE0)`, value: `PBE1PBE` },
      { label: `M06-2X`, value: `M062X` },
      { label: `\u03C9B97X-D`, value: `wB97XD` },
      { label: `MP2`, value: `MP2` },
      { label: `CCSD(T)`, value: `CCSD(T)` },
    ],
    help: `Level of theory. B3LYP general-purpose, M06-2X for thermochemistry, \u03C9B97X-D includes dispersion.`,
  },
  {
    key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G(d)`, group: `Method`,
    options: [
      { label: `STO-3G (minimal)`, value: `STO-3G` },
      { label: `6-31G(d)`, value: `6-31G(d)` },
      { label: `6-31+G(d,p)`, value: `6-31+G(d,p)` },
      { label: `6-311+G(2d,p)`, value: `6-311+G(2d,p)` },
      { label: `cc-pVDZ`, value: `cc-pVDZ` },
      { label: `cc-pVTZ`, value: `cc-pVTZ` },
      { label: `def2-SVP`, value: `def2SVP` },
      { label: `def2-TZVP`, value: `def2TZVP` },
    ],
    help: `6-31G(d) standard. Add + for diffuse functions (anions), (d,p) for polarization on H.`,
  },
  {
    key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
    help: `Total molecular charge.`,
  },
  {
    key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
    min: 1, max: 12, step: 1,
    help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
  },
  {
    key: `solvent`, label: `Solvent Model`, type: `select`, default: `none`, group: `Environment`,
    options: [
      { label: `None (gas phase)`, value: `none` },
      { label: `PCM (water)`, value: `SCRF=(PCM,Solvent=Water)` },
      { label: `SMD (water)`, value: `SCRF=(SMD,Solvent=Water)` },
      { label: `PCM (DMSO)`, value: `SCRF=(PCM,Solvent=DMSO)` },
    ],
    help: `Implicit solvation. PCM=polarizable continuum, SMD=density-based (better free energies).`,
  },
  {
    key: `dispersion`, label: `Dispersion`, type: `select`, default: `none`, group: `Method`,
    options: [
      { label: `None`, value: `none` },
      { label: `GD3BJ (recommended)`, value: `GD3BJ` },
      { label: `GD3`, value: `GD3` },
    ],
    help: `Empirical dispersion correction. GD3BJ recommended for non-covalent interactions.`,
  },
]
