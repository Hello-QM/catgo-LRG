import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only, cp2k_only, orca_only, xtb_only, mlp_only, gaussian_only, amber_only,
  INCAR_COMMON, KPOINTS_PARAM,
  VASP_ELECTRONIC_PARAMS, VASP_OUTPUT_PARAMS, VASP_PARALLELIZATION_PARAMS,
  VASP_DISPERSION_PARAMS, VASP_ADVANCED_PARAMS,
  CP2K_DFT_PARAMS, ORCA_QC_PARAMS, XTB_METHOD_PARAMS, MLP_COMMON_PARAMS, GAUSSIAN_QC_PARAMS,
} from '../common'

export const GEO_OPT_NODE: NodeDefinition = {
  type: `geo_opt`,
  label: `Geometry Optimization`,
  color: `#3b82f6`,
  icon: `\u26A1`,
  category: `Calculation`,
  description: `Optimize atomic positions (ions only)`,
  inputs: [`structure`],
  outputs: [`structure`, `energy`],
  default_params: {
    system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, PREC: `Accurate`,
    ALGO: `Fast`, ISMEAR: 0, SIGMA: 0.05, LREAL: `Auto`, NELM: 200, ISPIN: 1, MAGMOM: ``,
    ISIF: 2, NSW: 200, EDIFFG: -0.02, IBRION: 2, kpoints: `4×4×4`,
    LORBIT: 11, LWAVE: false, LCHARG: false, LAECHG: false,
    NPAR: 0, KPAR: 0, NCORE: 4,
    IVDW: 0, LDIPOL: false, IDIPOL: 3,
    NBANDS: 0, NEDOS: 301, ISTART: 0, ICHARG: 0,
    frozen_layers: 0, double_relax: false,
    relax_cell: false, optimizer: `BFGS`, max_steps: 500,
  },
  help_text: `**Geometry Optimization** — Relax atomic positions.

Choose system type first — periodic (crystal/slab) or molecular (cluster/molecule) — then select a compatible software.

**Periodic:** VASP, CP2K, xTB, MLP
**Molecular:** ORCA, Gaussian, CP2K, xTB, MLP, AMBER`,
  param_schema: [
    {
      key: `system_name`, label: `System Name`, type: `string`, default: ``,
      group: `General`,
      help: `Name for this system (e.g. "slab+OH", "bulk TiO₂"). Propagated to downstream Gibbs Energy node for the free energy diagram.`,
    },
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
        { label: `CP2K`, value: `cp2k` },
        { label: `ORCA`, value: `orca` },
        { label: `Gaussian`, value: `gaussian` },
        { label: `xTB`, value: `xtb` },
        { label: `MLP`, value: `mlp` },
        { label: `AMBER`, value: `amber` },
      ],
      help: `Calculation engine to use. Options are filtered by system type.`,
    },
    // ── VASP params ──
    ...vasp_only([
      ...INCAR_COMMON,
      {
        key: `ISIF`, label: `Stress Tensor / Relax Mode`, type: `select`, default: 2, group: `INCAR`,
        options: [
          { label: `2 — Fix cell, relax ions (slabs)`, value: 2 },
          { label: `3 — Full relax: ions + cell + volume (bulk)`, value: 3 },
          { label: `4 — Relax ions + cell shape (fix volume)`, value: 4 },
          { label: `7 — Relax volume only`, value: 7 },
        ],
        help: `Controls which degrees of freedom are relaxed. ISIF=2 for slabs, ISIF=3 for bulk.`,
      },
      {
        key: `NSW`, label: `Max Ionic Steps`, type: `number`, default: 200, group: `INCAR`,
        min: 1, max: 999, step: 10,
        help: `Maximum number of ionic relaxation steps.`,
      },
      {
        key: `EDIFFG`, label: `Force Convergence (eV/Å)`, type: `number`, default: -0.02, group: `INCAR`,
        min: -1, max: 0, step: 0.005,
        help: `Negative = force criterion (recommended). |EDIFFG| = max force per atom. -0.02 is standard.`,
      },
      {
        key: `IBRION`, label: `Optimizer`, type: `select`, default: 2, group: `INCAR`,
        options: [
          { label: `CG (2) — Conjugate Gradient`, value: 2 },
          { label: `Quasi-Newton (1) — RMM-DIIS`, value: 1 },
          { label: `VTST FIRE (3) — Requires VTST patch`, value: 3 },
        ],
        help: `Optimization algorithm. CG is robust and default. Quasi-Newton is faster near minima.`,
      },
      KPOINTS_PARAM,
      ...VASP_ELECTRONIC_PARAMS,
      ...VASP_OUTPUT_PARAMS.map(p =>
        p.key === `LCHARG` ? { ...p, default: false } : p
      ),
      ...VASP_DISPERSION_PARAMS,
      ...VASP_PARALLELIZATION_PARAMS,
      ...VASP_ADVANCED_PARAMS,
      {
        key: `frozen_layers`, label: `Frozen Bottom Layers`, type: `number`, default: 0, group: `Slab`,
        min: 0, max: 6, step: 1,
        help: `Number of bottom layers to freeze (Selective Dynamics). 0 = all atoms free.`,
      },
      {
        key: `double_relax`, label: `Double Relaxation`, type: `boolean`, default: false, group: `Advanced`,
        help: `Run VASP twice sequentially (atomate2 DoubleRelaxMaker pattern). Better convergence for large structural changes.`,
      },
    ]),
    // ── CP2K params ──
    ...cp2k_only([
      ...CP2K_DFT_PARAMS,
      {
        key: `geo_opt_optimizer`, label: `Optimizer`, type: `select`, default: `BFGS`, group: `GeoOpt`,
        options: [
          { label: `BFGS`, value: `BFGS` },
          { label: `LBFGS`, value: `LBFGS` },
          { label: `CG`, value: `CG` },
        ],
        help: `BFGS=quasi-Newton (fast near minimum), LBFGS=low-memory, CG=conjugate gradient (robust).`,
      },
      {
        key: `geo_opt_max_iter`, label: `Max Steps`, type: `number`, default: 200, group: `GeoOpt`,
        min: 10, max: 999, step: 10,
        help: `Maximum geometry optimization iterations.`,
      },
      {
        key: `geo_opt_max_force`, label: `Max Force (Ha/bohr)`, type: `number`, default: 4.5e-4, group: `GeoOpt`,
        min: 1e-5, max: 0.01, step: 1e-4,
        help: `Max force convergence (Ha/bohr). Default 4.5e-4.`,
      },
    ]),
    // ── ORCA params ──
    ...orca_only([
      ...ORCA_QC_PARAMS,
      {
        key: `opt_type`, label: `Optimization Type`, type: `select`, default: `MinSteps`, group: `Optimization`,
        options: [
          { label: `Min Steps (default)`, value: `MinSteps` },
          { label: `Calculate Frequencies`, value: `Freq` },
        ],
        help: `MinSteps=geometry opt only, Freq=also run frequency analysis after optimization.`,
      },
    ]),
    // ── xTB params ──
    ...xtb_only([
      ...XTB_METHOD_PARAMS,
      {
        key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
        min: 0.001, max: 0.5, step: 0.005,
        help: `Max force criterion (eV/Å). 0.01=standard, 0.001=tight for TS.`,
      },
      {
        key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `Optimizer`,
        min: 10, max: 5000, step: 50,
        help: `Maximum optimization steps.`,
      },
    ]),
    // ── MLP params ──
    ...mlp_only([
      ...MLP_COMMON_PARAMS,
      {
        key: `relax_cell`, label: `Relax Cell`, type: `boolean`, default: false, group: `Optimizer`,
        help: `Also optimize cell shape and volume (ExpCellFilter). Enable for bulk optimization to find equilibrium lattice constants. Disable for slabs/molecules.`,
      },
      {
        key: `mlp_optimizer`, label: `Optimizer`, type: `select`, default: `BFGS`, group: `Optimizer`,
        options: [
          { label: `BFGS`, value: `BFGS` },
          { label: `LBFGS`, value: `LBFGS` },
          { label: `FIRE`, value: `FIRE` },
        ],
        help: `Optimization algorithm. BFGS is default. LBFGS uses less memory for large systems. FIRE is robust for far-from-equilibrium structures.`,
      },
      {
        key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
        min: 0.001, max: 0.5, step: 0.005,
        help: `Max force convergence (eV/Å). ML potentials converge fast; 0.01 standard.`,
      },
      {
        key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `Optimizer`,
        min: 10, max: 5000, step: 50,
        help: `Maximum optimization steps.`,
      },
    ]),
    // ── Gaussian params ──
    ...gaussian_only([
      ...GAUSSIAN_QC_PARAMS,
      {
        key: `opt_convergence`, label: `Convergence`, type: `select`, default: `Opt`, group: `Optimization`,
        options: [
          { label: `Default (Opt)`, value: `Opt` },
          { label: `Tight (Opt=Tight)`, value: `Opt=Tight` },
          { label: `Very Tight (Opt=VeryTight)`, value: `Opt=VeryTight` },
        ],
        help: `Optimization convergence criteria. Tight recommended for small molecules.`,
      },
      {
        key: `max_cycles`, label: `Max Cycles`, type: `number`, default: 100, group: `Optimization`,
        min: 10, max: 500, step: 10,
        help: `Maximum optimization cycles.`,
      },
    ]),
    // ── AMBER minimization params ──
    ...amber_only([
      {
        key: `topology_file`, label: `Topology File (prmtop)`, type: `text`, default: ``, group: `Input Files`,
        help: `Absolute path to AMBER topology file (.prmtop) on HPC.`,
      },
      {
        key: `restart_file`, label: `Coordinate File (rst7)`, type: `text`, default: ``, group: `Input Files`,
        help: `Absolute path to AMBER coordinate file (.rst7/.inpcrd) on HPC.`,
      },
      {
        key: `maxcyc`, label: `Max Cycles`, type: `number`, default: 5000, group: `Minimization`,
        min: 100, max: 100000, step: 500,
        help: `Maximum minimization cycles (maxcyc).`,
      },
      {
        key: `ncyc`, label: `Steepest Descent Steps`, type: `number`, default: 2500, group: `Minimization`,
        min: 0, max: 50000, step: 100,
        help: `First ncyc steps use steepest descent, then switch to conjugate gradient.`,
      },
      {
        key: `drms`, label: `RMS Gradient Tolerance`, type: `number`, default: 0.0001, group: `Minimization`,
        min: 0.000001, max: 0.1, step: 0.0001,
        help: `Convergence criterion for RMS gradient (kcal/mol/\u00C5).`,
      },
      {
        key: `use_mlp`, label: `Enable ML Potential`, type: `checkbox`, default: false, group: `ML/MM`,
        help: `Enable ML potential for minimization (ifmlp=1).`,
      },
      {
        key: `custom_mdin`, label: `Custom mdin`, type: `text`, default: ``, group: `Advanced`,
        help: `Full custom mdin content. When provided, all above parameters are ignored.`,
      },
    ]),
  ],
}
