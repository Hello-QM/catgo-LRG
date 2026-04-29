import type { NodeDefinition } from '../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only, cp2k_only, orca_only, xtb_only, mlp_only, lammps_only, gaussian_only, gromacs_only, sella_show,
  INCAR_COMMON, KPOINTS_PARAM, PARALLELIZATION_PARAMS,
  CP2K_DFT_PARAMS, ORCA_QC_PARAMS, XTB_METHOD_PARAMS, MLP_COMMON_PARAMS, GAUSSIAN_QC_PARAMS,
} from './common'

// ================================================================
//  UNIFIED CALCULATION NODES
// ================================================================

export const CALCULATION_NODES: Record<string, NodeDefinition> = {

  // ─── Geometry Optimization ───
  geo_opt: {
    type: `geo_opt`,
    label: `Geometry Optimization`,
    color: `#3b82f6`,
    icon: `\u26A1`,
    category: `Calculation`,
    description: `Optimize atomic positions (ions only)`,
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: { system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, kpoints: `4×4×4` },
    help_text: `**Geometry Optimization** — Relax atomic positions.

Choose system type first — periodic (crystal/slab) or molecular (cluster/molecule) — then select a compatible software.

**Periodic:** VASP, CP2K, xTB, MLP
**Molecular:** ORCA, Gaussian, CP2K, xTB, MLP`,
    param_schema: [
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
        {
          key: `LDIPOL`, label: `Dipole Correction`, type: `boolean`, default: false, group: `Slab`,
          help: `Apply dipole correction along z-axis (LDIPOL=T, IDIPOL=3). Essential for asymmetric slabs.`,
        },
        {
          key: `frozen_layers`, label: `Frozen Bottom Layers`, type: `number`, default: 0, group: `Slab`,
          min: 0, max: 6, step: 1,
          help: `Number of bottom layers to freeze (Selective Dynamics). 0 = all atoms free.`,
        },
        {
          key: `double_relax`, label: `Double Relaxation`, type: `boolean`, default: false, group: `Advanced`,
          help: `Run VASP twice sequentially (atomate2 DoubleRelaxMaker pattern). Better convergence for large structural changes.`,
        },
        ...PARALLELIZATION_PARAMS,
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
        {
          key: `opt_convergence`, label: `Convergence`, type: `select`, default: ``, group: `Optimization`,
          options: [
            { label: `ORCA Default (Opt)`, value: `` },
            { label: `LooseOpt`, value: `LooseOpt` },
            { label: `Opt`, value: `Opt` },
            { label: `TightOpt`, value: `TightOpt` },
            { label: `VeryTightOpt`, value: `VeryTightOpt` },
          ],
          help: `Optimization convergence criteria. Tight for small molecules, loose for large systems.`,
        },
        {
          key: `cartesian_opt`, label: `Cartesian Optimization (COpt)`, type: `boolean`, default: false, group: `Optimization`,
          help: `Optimize in Cartesian rather than internal coordinates. Useful for surface/periodic systems.`,
        },
        {
          key: `max_iterations`, label: `Max Iterations`, type: `number`, default: 50, group: `Optimization`,
          min: 10, max: 200,
          help: `Maximum geometry optimization cycles.`,
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
          key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
          min: 0.001, max: 0.5, step: 0.005,
          help: `Max force convergence (eV/Å). ML potentials converge fast; 0.01 standard.`,
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
    ],
  },

  // ─── Single Point ───
  single_point: {
    type: `single_point`,
    label: `Single Point`,
    color: `#6366f1`,
    icon: `\u{1F52C}`,
    category: `Calculation`,
    description: `Single-point energy calculation`,
    inputs: [`structure`],
    outputs: [`energy`, `dos`, `band`],
    default_params: { system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11 },
    help_text: `**Single Point Calculation** — Compute energy at fixed geometry.

Choose system type, then select a compatible software.

Use after geometry optimization for accurate energies, or as input for DOS/band structure analysis.`,
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
          { label: `ORCA`, value: `orca` },
          { label: `Gaussian`, value: `gaussian` },
          { label: `xTB`, value: `xtb` },
        ],
        help: `Calculation engine to use. Options are filtered by system type.`,
      },
      // ── VASP params ──
      ...vasp_only([
        ...INCAR_COMMON,
        {
          key: `LORBIT`, label: `Orbital Projection`, type: `select`, default: 11, group: `INCAR`,
          options: [
            { label: `None (0)`, value: 0 },
            { label: `Projected DOS (11)`, value: 11 },
            { label: `Projected DOS + lm-decomposed (12)`, value: 12 },
          ],
          help: `Write projected DOS and orbital character to DOSCAR/PROCAR.`,
        },
        KPOINTS_PARAM,
        ...PARALLELIZATION_PARAMS,
      ]),
      // ── CP2K params ──
      ...cp2k_only(CP2K_DFT_PARAMS),
      // ── ORCA params ──
      ...orca_only(ORCA_QC_PARAMS),
      // ── Gaussian params ──
      ...gaussian_only(GAUSSIAN_QC_PARAMS),
      // ── xTB params ──
      ...xtb_only(XTB_METHOD_PARAMS),
    ],
  },

  // ─── Cell Optimization ───
  cell_opt: {
    type: `cell_opt`,
    label: `Cell Optimization`,
    color: `#0f766e`,
    icon: `\u{1F4D0}`,
    category: `Calculation`,
    description: `Optimize cell parameters and atomic positions`,
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISIF: 3, kpoints: `9×9×9` },
    help_text: `**Cell Optimization** — Relax both lattice and ionic positions.

Optimizes cell parameters (volume, shape) along with atomic positions.
Use for bulk crystal optimization.`,
    param_schema: [
      {
        key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
        ],
      },
      // ── VASP params ──
      ...vasp_only([
        ...INCAR_COMMON,
        {
          key: `ISIF`, label: `Relax Mode`, type: `select`, default: 3, group: `INCAR`,
          options: [
            { label: `3 — Full relax (recommended)`, value: 3 },
            { label: `4 — Fix volume, relax shape`, value: 4 },
            { label: `7 — Relax volume only`, value: 7 },
          ],
          help: `Cell degrees of freedom: 3=full relax, 4=fix volume relax shape, 7=volume only.`,
        },
        {
          key: `NSW`, label: `Max Ionic Steps`, type: `number`, default: 200, group: `INCAR`,
          min: 1, max: 999, step: 10,
          help: `Maximum ionic relaxation steps.`,
        },
        {
          key: `EDIFFG`, label: `Force Convergence (eV/Å)`, type: `number`, default: -0.01, group: `INCAR`,
          min: -0.5, max: 0, step: 0.005,
          help: `Force convergence: negative = max force per atom (eV/Å). -0.01 is tight.`,
        },
        { ...KPOINTS_PARAM, default: `9×9×9` },
        {
          key: `double_relax`, label: `Double Relaxation`, type: `boolean`, default: true, group: `Advanced`,
          help: `Run twice for better lattice parameter convergence.`,
        },
        ...PARALLELIZATION_PARAMS,
      ]),
      // ── CP2K params ──
      ...cp2k_only([
        ...CP2K_DFT_PARAMS,
        {
          key: `geo_opt_optimizer`, label: `Optimizer`, type: `select`, default: `BFGS`, group: `CellOpt`,
          options: [
            { label: `BFGS`, value: `BFGS` },
            { label: `LBFGS`, value: `LBFGS` },
          ],
          help: `BFGS=quasi-Newton (fast near minimum), LBFGS=low-memory variant.`,
        },
        {
          key: `geo_opt_max_iter`, label: `Max Steps`, type: `number`, default: 200, group: `CellOpt`,
          min: 10, max: 999, step: 10,
          help: `Maximum cell optimization iterations.`,
        },
      ]),
    ],
  },

  // ─── Molecular Dynamics ───
  md: {
    type: `md`,
    label: `Molecular Dynamics`,
    color: `#8b5cf6`,
    icon: `\u{1F321}\uFE0F`,
    category: `Calculation`,
    description: `Molecular dynamics simulation`,
    inputs: [`structure`, `restart`],
    outputs: [`trajectory`, `energy`, `log`, `restart`],
    default_params: { system_type: `periodic`, software: `vasp`, TEBEG: 300, NSW: 5000, POTIM: 1.0, SMASS: 0 },
    help_text: `**Molecular Dynamics** — Run MD simulations.

Choose system type first, then select a compatible MD engine.

**Periodic:** VASP, CP2K, LAMMPS, GROMACS, MLP
**Molecular:** CP2K, LAMMPS, GROMACS, MLP`,
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
          { label: `LAMMPS`, value: `lammps` },
          { label: `GROMACS`, value: `gromacs` },
          { label: `MLP`, value: `mlp` },
        ],
        help: `Calculation engine to use. Options are filtered by system type.`,
      },
      // ── VASP MD params ──
      ...vasp_only([
        ...INCAR_COMMON,
        {
          key: `TEBEG`, label: `Temperature (K)`, type: `number`, default: 300, group: `INCAR`,
          min: 1, max: 5000, step: 50,
          help: `Starting temperature for MD (K). Velocities initialized from Maxwell-Boltzmann distribution at TEBEG.`,
        },
        {
          key: `NSW`, label: `MD Steps`, type: `number`, default: 5000, group: `INCAR`,
          min: 100, max: 100000, step: 1000,
          help: `Total number of MD time steps.`,
        },
        {
          key: `POTIM`, label: `Timestep (fs)`, type: `number`, default: 1.0, group: `INCAR`,
          min: 0.1, max: 5.0, step: 0.5,
          help: `MD time step (fs). 1.0 fs typical; use 0.5 fs for light elements (H).`,
        },
        {
          key: `SMASS`, label: `Thermostat (SMASS)`, type: `select`, default: 0, group: `INCAR`,
          options: [
            { label: `-1 — NVE (no thermostat)`, value: -1 },
            { label: `0 — Nosé-Hoover NVT`, value: 0 },
            { label: `1 — Nosé-Hoover chain`, value: 1 },
            { label: `3 — Langevin NVT`, value: 3 },
          ],
          help: `Thermostat: -1=NVE (constant energy), 0=Nosé-Hoover NVT, 1=chain, 3=Langevin.`,
        },
        KPOINTS_PARAM,
        ...PARALLELIZATION_PARAMS,
      ]),
      // ── CP2K MD params ──
      ...cp2k_only([
        ...CP2K_DFT_PARAMS,
        {
          key: `md_ensemble`, label: `Ensemble`, type: `select`, default: `NVT`, group: `MD`,
          options: [
            { label: `NVE (microcanonical)`, value: `NVE` },
            { label: `NVT (Nosé-Hoover)`, value: `NVT` },
            { label: `NPT_I (variable cell)`, value: `NPT_I` },
          ],
          help: `NVE=microcanonical, NVT=Nosé-Hoover thermostat, NPT_I=isotropic cell fluctuations.`,
        },
        {
          key: `md_steps`, label: `MD Steps`, type: `number`, default: 1000, group: `MD`,
          min: 100, max: 100000, step: 500,
          help: `Total MD integration steps.`,
        },
        {
          key: `md_timestep`, label: `Timestep (fs)`, type: `number`, default: 0.5, group: `MD`,
          min: 0.1, max: 2.0, step: 0.1,
          help: `Time step (fs). 0.5 fs standard for AIMD.`,
        },
        {
          key: `md_temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
          min: 1, max: 5000, step: 50,
          help: `Target temperature (K) for NVT/NPT thermostat.`,
        },
      ]),
      // ── LAMMPS MD params ──
      ...lammps_only([
        {
          key: `execution_mode`, label: `Execution Mode`, type: `select`, default: `local`, group: `Execution`,
          options: [
            { label: `Local (fast, small systems)`, value: `local` },
            { label: `HPC Cluster (production)`, value: `hpc` },
          ],
          help: `local=run on this machine, hpc=submit as cluster job.`,
        },
        {
          key: `lmp_command`, label: `LAMMPS Command`, type: `text`, default: `lmp_serial`, group: `Execution`,
          help: `LAMMPS executable (lmp_serial, lmp_mpi, or full path).`,
        },
        {
          key: `atom_style`, label: `Atom Style`, type: `select`, default: `atomic`, group: `Structure`,
          options: [
            { label: `atomic — metals, simple crystals`, value: `atomic` },
            { label: `full — molecular with bonds + charges`, value: `full` },
            { label: `charge — charged atoms, no bonds`, value: `charge` },
            { label: `molecular — bonds + angles, no charges`, value: `molecular` },
          ],
          help: `Data model: atomic=simple, full=bonds+charges, charge=charges only, molecular=bonds+angles.`,
        },
        {
          key: `use_forcefield`, label: `Use Force Field`, type: `checkbox`, default: false, group: `Force Field`,
          help: `Apply GAFF2/OPLS force field to molecular structure (PDB input required). Converts structure to LAMMPS format with proper atom types and charges.`,
        },
        {
          key: `forcefield`, label: `Force Field`, type: `select`, default: `gaff2`, group: `Force Field`,
          options: [
            { label: `GAFF2 (organic molecules)`, value: `gaff2` },
            { label: `GAFF (older version)`, value: `gaff` },
            { label: `OPLS-AA`, value: `oplsaa` },
            { label: `COMPASS`, value: `compass` },
          ],
          show_if: { key: `use_forcefield`, values: [true] },
          help: `Force field type. GAFF2 recommended for organic molecules.`,
        },
        {
          key: `charge_method`, label: `Charge Method`, type: `select`, default: `gasteiger`, group: `Force Field`,
          options: [
            { label: `Gasteiger (fast)`, value: `gasteiger` },
            { label: `AM1-BCC (accurate, slow)`, value: `am1bcc` },
            { label: `Zero (testing)`, value: `zero` },
          ],
          show_if: { key: `use_forcefield`, values: [true] },
          help: `Partial charge calculation method. Gasteiger is fast; AM1-BCC requires AmberTools.`,
        },
        {
          key: `solvate`, label: `Add Solvent`, type: `checkbox`, default: false, group: `Solvation`,
          show_if: { key: `use_forcefield`, values: [true] },
          help: `Add water solvent box around molecule.`,
        },
        {
          key: `water_model`, label: `Water Model`, type: `select`, default: `tip3p`, group: `Solvation`,
          options: [
            { label: `TIP3P (fast)`, value: `tip3p` },
            { label: `TIP4P (accurate)`, value: `tip4p` },
            { label: `SPC/E`, value: `spce` },
          ],
          show_if: { key: `solvate`, values: [true] },
          help: `Water model for solvent box. TIP3P fastest, TIP4P more accurate.`,
        },
        {
          key: `box_padding`, label: `Box Padding (Å)`, type: `number`, default: 10.0, group: `Solvation`,
          min: 5, max: 20, step: 1,
          show_if: { key: `solvate`, values: [true] },
          help: `Distance between solute and box edge (Å).`,
        },
        {
          key: `pair_style`, label: `Pair Style`, type: `text`, default: `lj/cut 2.5`, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `Potential type with args (e.g. lj/cut 2.5, eam/alloy, tersoff).`,
        },
        {
          key: `pair_coeff`, label: `Pair Coefficients`, type: `text`, default: `* * 1.0 1.0`, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `Potential coefficients per atom-type pair. Format depends on pair_style.`,
        },
        {
          key: `bond_style`, label: `Bond Style`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `LAMMPS bond_style command (e.g. harmonic). Leave blank if not applicable.`,
        },
        {
          key: `bond_coeff`, label: `Bond Coefficients`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `bond_coeff lines, one per line (e.g. 1 350.0 1.54).`,
        },
        {
          key: `angle_style`, label: `Angle Style`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `LAMMPS angle_style command (e.g. harmonic). Leave blank if not applicable.`,
        },
        {
          key: `angle_coeff`, label: `Angle Coefficients`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `angle_coeff lines, one per line (e.g. 1 60.0 109.5).`,
        },
        {
          key: `dihedral_style`, label: `Dihedral Style`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `LAMMPS dihedral_style command (e.g. opls). Leave blank if not applicable.`,
        },
        {
          key: `dihedral_coeff`, label: `Dihedral Coefficients`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `dihedral_coeff lines, one per line.`,
        },
        {
          key: `kspace_style`, label: `KSpace Style`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `Long-range electrostatic solver (e.g. pppm 1e-4). Leave blank to omit.`,
        },
        {
          key: `special_bonds`, label: `Special Bonds`, type: `text`, default: ``, group: `Potential`,
          show_if: { key: `use_forcefield`, values: [false] },
          help: `1-2/1-3/1-4 exclusion weights (e.g. lj/coul 0 0 0.5). Leave blank to omit.`,
        },
        {
          key: `extra_commands`, label: `Extra Commands`, type: `text`, default: ``, group: `Extra`,
          help: `Additional LAMMPS commands inserted after the force field / potential block (one per line).`,
        },
        {
          key: `units`, label: `Units`, type: `select`, default: `metal`, group: `MD`,
          options: [
            { label: `metal — Å, eV, ps, K, bar`, value: `metal` },
            { label: `real — Å, kcal/mol, fs, K, atm`, value: `real` },
            { label: `lj — reduced LJ units`, value: `lj` },
          ],
          help: `Unit system: metal=Å/eV/ps, real=Å/kcal·mol⁻¹/fs, lj=reduced units.`,
        },
        {
          key: `ensemble`, label: `Ensemble`, type: `select`, default: `nvt`, group: `MD`,
          options: [
            { label: `NVE (microcanonical)`, value: `nve` },
            { label: `NVT (constant T)`, value: `nvt` },
            { label: `NPT (constant T, P)`, value: `npt` },
          ],
          help: `NVE=constant energy, NVT=Nosé-Hoover thermostat, NPT=thermostat+barostat.`,
        },
        {
          key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
          min: 1, max: 10000, step: 10,
          help: `Target thermostat temperature (K). Used in NVT/NPT.`,
        },
        {
          key: `pressure`, label: `Pressure (atm)`, type: `number`, default: 1.0, group: `MD`,
          min: 0, max: 1000, step: 0.1,
          help: `Target barostat pressure. Units depend on 'units' setting.`,
        },
        {
          key: `timestep`, label: `Timestep`, type: `number`, default: 0.001, group: `MD`,
          min: 0.00001, max: 100, step: 0.001,
          help: `Timestep in the current unit system. metal: ps (0.001 = 1 fs), real: fs (1.0 typical).`,
        },
        {
          key: `steps`, label: `MD Steps`, type: `number`, default: 10000, group: `MD`,
          min: 100, max: 10000000, step: 1000,
          help: `Total MD integration steps.`,
        },
        {
          key: `dump_freq`, label: `Dump Frequency`, type: `number`, default: 100, group: `Output`,
          min: 1, max: 10000, step: 10,
          help: `Trajectory output frequency: save positions every N steps.`,
        },
        {
          key: `write_restart`, label: `Write Restart File`, type: `boolean`, default: true, group: `Output`,
          help: `Write LAMMPS restart file for continuation runs.`,
        },
      ]),
      // ── MLP MD params ──
      ...mlp_only([
        ...MLP_COMMON_PARAMS,
        {
          key: `temp`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
          min: 1, max: 5000, step: 50,
          help: `Target MD temperature (K) for Langevin thermostat.`,
        },
        {
          key: `steps`, label: `MD Steps`, type: `number`, default: 10000, group: `MD`,
          min: 100, max: 1000000, step: 1000,
          help: `Total MD simulation steps.`,
        },
        {
          key: `timestep`, label: `Timestep (fs)`, type: `number`, default: 1.0, group: `MD`,
          min: 0.1, max: 5.0, step: 0.5,
          help: `MD time step (fs). 1.0 fs typical for MLP-MD.`,
        },
      ]),
      // ── GROMACS MD params ──
      ...gromacs_only([
        {
          key: `force_field`, label: `Force Field`, type: `select`, default: `amber99sb-ildn`, group: `ForceField`,
          options: [
            { label: `AMBER99SB-ILDN`, value: `amber99sb-ildn` },
            { label: `CHARMM36`, value: `charmm36` },
            { label: `OPLS-AA`, value: `oplsaa` },
          ],
          help: `Molecular mechanics force field. AMBER99SB-ILDN for proteins, CHARMM36 for lipids/proteins, OPLS-AA general.`,
        },
        {
          key: `water_model`, label: `Water Model`, type: `select`, default: `tip3p`, group: `ForceField`,
          options: [
            { label: `TIP3P`, value: `tip3p` },
            { label: `SPC/E`, value: `spce` },
            { label: `TIP4P`, value: `tip4p` },
          ],
          help: `Explicit water model. TIP3P fastest, SPC/E better density, TIP4P most accurate.`,
        },
        {
          key: `integrator`, label: `Integrator`, type: `select`, default: `md`, group: `MD`,
          options: [
            { label: `md — leap-frog`, value: `md` },
            { label: `md-vv — velocity Verlet`, value: `md-vv` },
            { label: `sd — stochastic/Langevin`, value: `sd` },
            { label: `steep — steepest descent (minimization)`, value: `steep` },
            { label: `cg — conjugate gradient (minimization)`, value: `cg` },
          ],
          help: `Integration algorithm. md (leap-frog) standard, sd for Langevin thermostat, steep/cg for energy minimization.`,
        },
        {
          key: `nsteps`, label: `Total Steps`, type: `number`, default: 500000, group: `MD`,
          min: 1000, max: 100000000, step: 10000,
          help: `Total number of MD integration steps. With dt=0.002 ps, 500000 steps = 1 ns.`,
        },
        {
          key: `dt`, label: `Time Step (ps)`, type: `number`, default: 0.002, group: `MD`,
          min: 0.0005, max: 0.005, step: 0.0005,
          help: `Integration time step (ps). 0.002 ps (2 fs) with LINCS constraints on H-bonds.`,
        },
        {
          key: `tcoupl`, label: `Thermostat`, type: `select`, default: `v-rescale`, group: `Temperature`,
          options: [
            { label: `v-rescale (recommended)`, value: `v-rescale` },
            { label: `Nosé-Hoover`, value: `nose-hoover` },
            { label: `Berendsen (equilibration only)`, value: `berendsen` },
          ],
          help: `Temperature coupling. v-rescale gives correct canonical ensemble; Berendsen only for equilibration.`,
        },
        {
          key: `ref_t`, label: `Temperature (K)`, type: `number`, default: 300, group: `Temperature`,
          min: 1, max: 1000, step: 5,
          help: `Reference temperature (K) for the thermostat.`,
        },
        {
          key: `tau_t`, label: `Coupling Time (ps)`, type: `number`, default: 0.1, group: `Temperature`,
          min: 0.01, max: 5.0, step: 0.05,
          help: `Temperature coupling time constant (ps). 0.1 ps typical for v-rescale.`,
        },
        {
          key: `pcoupl`, label: `Barostat`, type: `select`, default: `no`, group: `Pressure`,
          options: [
            { label: `None (NVT)`, value: `no` },
            { label: `Parrinello-Rahman (production)`, value: `Parrinello-Rahman` },
            { label: `Berendsen (equilibration)`, value: `berendsen` },
            { label: `C-rescale`, value: `C-rescale` },
          ],
          help: `Pressure coupling. Parrinello-Rahman for production NPT; Berendsen for fast equilibration only.`,
        },
        {
          key: `ref_p`, label: `Pressure (bar)`, type: `number`, default: 1.0, group: `Pressure`,
          min: 0, max: 10000, step: 1,
          help: `Reference pressure (bar). 1 bar = standard conditions.`,
        },
        {
          key: `coulombtype`, label: `Electrostatics`, type: `select`, default: `PME`, group: `Interactions`,
          options: [
            { label: `PME (recommended)`, value: `PME` },
            { label: `Cut-off`, value: `Cut-off` },
          ],
          help: `Long-range electrostatics. PME (Particle Mesh Ewald) required for charged/periodic systems.`,
        },
        {
          key: `rcoulomb`, label: `Coulomb Cutoff (nm)`, type: `number`, default: 1.0, group: `Interactions`,
          min: 0.8, max: 2.0, step: 0.1,
          help: `Real-space Coulomb cutoff distance (nm). 1.0 nm standard with PME.`,
        },
        {
          key: `rvdw`, label: `VdW Cutoff (nm)`, type: `number`, default: 1.0, group: `Interactions`,
          min: 0.8, max: 2.0, step: 0.1,
          help: `Van der Waals cutoff distance (nm). Should match rcoulomb.`,
        },
        {
          key: `constraints`, label: `Constraints`, type: `select`, default: `h-bonds`, group: `Constraints`,
          options: [
            { label: `H-bonds (LINCS)`, value: `h-bonds` },
            { label: `All bonds`, value: `all-bonds` },
            { label: `None`, value: `none` },
          ],
          help: `Bond constraints. h-bonds allows 2 fs timestep; all-bonds allows 4 fs with virtual sites.`,
        },
        {
          key: `nstxout_compressed`, label: `Trajectory Output (steps)`, type: `number`, default: 5000, group: `Output`,
          min: 100, max: 100000, step: 500,
          help: `Write compressed trajectory (xtc) every N steps. 5000 with dt=0.002 = every 10 ps.`,
        },
      ]),
    ],
  },

  // ─── Frequency / Vibrational Analysis ───
  freq: {
    type: `freq`,
    label: `Frequency`,
    color: `#c026d3`,
    icon: `\u3030\uFE0F`,
    category: `Calculation`,
    description: `Vibrational frequency calculation`,
    inputs: [`structure`],
    outputs: [`frequencies`, `zpe`],
    default_params: { system_type: `periodic`, software: `vasp`, IBRION: 5, NFREE: 2, POTIM: 0.015 },
    help_text: `**Frequency Calculation** — Vibrational analysis.

Computes vibrational frequencies by finite differences of forces.
Used for ZPE corrections, thermodynamics, and TS verification.

**Periodic:** VASP, CP2K
**Molecular:** ORCA, Gaussian, CP2K`,
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
          { label: `ORCA`, value: `orca` },
          { label: `Gaussian`, value: `gaussian` },
        ],
        help: `Calculation engine to use. Options are filtered by system type.`,
      },
      // ── VASP freq params ──
      ...vasp_only([
        ...INCAR_COMMON,
        {
          key: `IBRION`, label: `Method`, type: `select`, default: 5, group: `INCAR`,
          options: [
            { label: `5 — Finite Differences`, value: 5 },
            { label: `6 — Finite Differences (all directions)`, value: 6 },
          ],
          help: `Finite-difference method: 5=symmetry-reduced displacements, 6=all atoms/directions.`,
        },
        {
          key: `NFREE`, label: `Displacement Type`, type: `select`, default: 2, group: `INCAR`,
          options: [
            { label: `2 — Central differences (±, recommended)`, value: 2 },
            { label: `4 — 4-point stencil (more accurate)`, value: 4 },
          ],
          help: `Displacement stencil: 2=central differences (±δ), 4=four-point (more accurate).`,
        },
        {
          key: `POTIM`, label: `Displacement (Å)`, type: `number`, default: 0.015, group: `INCAR`,
          min: 0.005, max: 0.05, step: 0.005,
          help: `Displacement amplitude (Å) for finite differences. 0.015 Å is standard.`,
        },
        KPOINTS_PARAM,
        ...PARALLELIZATION_PARAMS,
      ]),
      // ── CP2K freq params ──
      ...cp2k_only([
        ...CP2K_DFT_PARAMS.map(p =>
          p.key === `eps_scf` ? { ...p, default: `1e-7` } : p
        ),
      ]),
      // ── ORCA freq params ──
      ...orca_only(ORCA_QC_PARAMS),
      // ── Gaussian freq params ──
      ...gaussian_only([
        ...GAUSSIAN_QC_PARAMS,
        {
          key: `freq_type`, label: `Frequency Type`, type: `select`, default: `Freq`, group: `Frequency`,
          options: [
            { label: `Standard (Freq)`, value: `Freq` },
            { label: `No Raman (Freq=NoRaman)`, value: `Freq=NoRaman` },
            { label: `Anharmonic (Freq=Anharmonic)`, value: `Freq=Anharmonic` },
          ],
          help: `Freq=standard harmonic, NoRaman=skip Raman intensities (faster), Anharmonic=anharmonic corrections.`,
        },
        {
          key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15, group: `Frequency`,
          min: 1, max: 2000, step: 1,
          help: `Temperature for thermodynamic properties (ZPE, enthalpy, Gibbs free energy).`,
        },
      ]),
    ],
  },

  // ─── UV/Vis Spectroscopy ───
  uvvis: {
    type: `uvvis`,
    label: `UV/Vis Spectroscopy`,
    color: `#7c3aed`,
    icon: `🌈`,
    category: `Calculation`,
    subcategory: `Spectroscopy`,
    description: `Predict UV/Vis absorption spectrum via TD-DFT or STEOM-DLPNO-CCSD`,
    inputs: [`structure`],
    outputs: [`spectrum`, `structure`],
    default_params: { software: `orca`, calc_type: `tddft`, method: `CAM-B3LYP`, basis: `def2-TZVP`, nroots: 10, triplets: false, tda: true, donto: false, solvation: `none`, solvent: `water`, aux_basis: `def2-TZVP/C`, charge: 0, multiplicity: 1, num_cores: 4, max_core_mb: 4000 },
    help_text: `**UV/Vis Spectroscopy** — Predict electronic excitation spectrum.

**TD-DFT:** Fast, widely-used method. CAM-B3LYP and PBE0 recommended for charge-transfer excitations.

**STEOM-DLPNO-CCSD:** High-accuracy post-HF method (ab initio, no functional dependence). More expensive, better for complex systems.

Outputs include transition energies (eV, nm), oscillator strengths, and optional Natural Transition Orbitals (NTOs) for visualization.`,
    param_schema: [
      {
        key: `calc_type`, label: `Calculation Type`, type: `select`, default: `tddft`, group: `Excited States`,
        options: [
          { label: `TD-DFT / TDA`, value: `tddft` },
          { label: `STEOM-DLPNO-CCSD (high-accuracy)`, value: `steom` },
        ],
        help: `TD-DFT is fast and robust. STEOM is more accurate but computationally expensive.`,
      },
      {
        key: `method`, label: `Method / Functional`, type: `select`, default: `CAM-B3LYP`, group: `Quantum`,
        options: [
          { label: `B3LYP`, value: `B3LYP` },
          { label: `PBE0`, value: `PBE0` },
          { label: `CAM-B3LYP (recommended for CT)`, value: `CAM-B3LYP` },
          { label: `wB97X-D`, value: `wB97X-D` },
          { label: `M062X`, value: `M062X` },
          { label: `BHLYP`, value: `BHLYP` },
          { label: `STEOM-DLPNO-CCSD`, value: `STEOM-DLPNO-CCSD`, show_if: { key: `calc_type`, values: [`steom`] } },
        ],
        help: `For TD-DFT, CAM-B3LYP handles charge-transfer excitations well. For STEOM, the method is fixed.`,
      },
      {
        key: `basis`, label: `Basis Set`, type: `select`, default: `def2-TZVP`, group: `Quantum`,
        options: [
          { label: `STO-3G (minimal, fast)`, value: `STO-3G` },
          { label: `6-31G (standard)`, value: `6-31G` },
          { label: `6-31G*`, value: `6-31G*` },
          { label: `6-311G`, value: `6-311G` },
          { label: `6-311+G**`, value: `6-311+G**` },
          { label: `def2-SVP`, value: `def2-SVP` },
          { label: `def2-TZVP (recommended)`, value: `def2-TZVP` },
          { label: `def2-TZVPP (very accurate)`, value: `def2-TZVPP` },
          { label: `def2-QZVP (highest accuracy)`, value: `def2-QZVP` },
          { label: `cc-pVDZ`, value: `cc-pVDZ` },
          { label: `cc-pVTZ`, value: `cc-pVTZ` },
          { label: `cc-pVQZ`, value: `cc-pVQZ` },
        ],
        help: `def2-TZVP is standard for excited-state calculations. Larger basis = better accuracy but slower.`,
      },
      {
        key: `nroots`, label: `Number of Excited States`, type: `number`, default: 10, group: `Excited States`,
        min: 1, max: 100, step: 1,
        help: `How many excited states to calculate. Larger number = more states computed, slower.`,
      },
      {
        key: `triplets`, label: `Include Triplet States`, type: `boolean`, default: false, group: `Excited States`,
        show_if: { key: `calc_type`, values: [`tddft`] },
        help: `Calculate spin-triplet states in addition to singlets. Only for TD-DFT.`,
      },
      {
        key: `tda`, label: `Tamm-Dancoff Approximation`, type: `boolean`, default: true, group: `Excited States`,
        show_if: { key: `calc_type`, values: [`tddft`] },
        help: `Default in ORCA. TDA=true is faster, TDA=false is more expensive but slightly more accurate.`,
      },
      {
        key: `donto`, label: `Natural Transition Orbitals (NTOs)`, type: `boolean`, default: false, group: `Output`,
        help: `Calculate NTOs to visualize orbital transitions. Increases output verbosity.`,
      },
      {
        key: `solvation`, label: `Solvation Model`, type: `select`, default: `none`, group: `Solvation`,
        options: [
          { label: `None (vacuum)`, value: `none` },
          { label: `CPCM (implicit solvent)`, value: `CPCM` },
        ],
        help: `CPCM includes solvent screening of excited states.`,
      },
      {
        key: `solvent`, label: `Solvent`, type: `select`, default: `water`, group: `Solvation`,
        show_if: { key: `solvation`, values: [`CPCM`] },
        options: [
          { label: `Water`, value: `water` },
          { label: `Acetonitrile`, value: `acetonitrile` },
          { label: `Methanol`, value: `methanol` },
          { label: `Ethanol`, value: `ethanol` },
          { label: `DMSO`, value: `dmso` },
          { label: `THF`, value: `thf` },
          { label: `Hexane`, value: `hexane` },
          { label: `Toluene`, value: `toluene` },
          { label: `Dichloromethane`, value: `dichloromethane` },
          { label: `Chloroform`, value: `chloroform` },
        ],
        help: `Common solvents for CPCM.`,
      },
      {
        key: `aux_basis`, label: `Auxiliary Basis (STEOM)`, type: `select`, default: `def2-TZVP/C`, group: `Quantum`,
        show_if: { key: `calc_type`, values: [`steom`] },
        options: [
          { label: `def2-SVP/C`, value: `def2-SVP/C` },
          { label: `def2-TZVP/C (recommended)`, value: `def2-TZVP/C` },
          { label: `cc-pVDZ/C`, value: `cc-pVDZ/C` },
          { label: `cc-pVTZ/C`, value: `cc-pVTZ/C` },
        ],
        help: `Auxiliary basis for STEOM-DLPNO. Must match main basis set family.`,
      },
      {
        key: `wavefunction`, label: `Wavefunction Reference`, type: `select`, default: ``, group: `Quantum`,
        options: [
          { label: `Auto (default)`, value: `` },
          { label: `RHF`, value: `RHF` },
          { label: `UHF`, value: `UHF` },
          { label: `ROHF`, value: `ROHF` },
          { label: `RKS`, value: `RKS` },
          { label: `UKS`, value: `UKS` },
          { label: `ROKS`, value: `ROKS` },
        ],
        help: `Wavefunction type. Auto lets ORCA choose based on multiplicity.`,
      },
      {
        key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
        help: `Total charge of the system.`,
      },
      {
        key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
        help: `Spin multiplicity (1=singlet, 2=doublet, 3=triplet, etc).`,
      },
      {
        key: `num_cores`, label: `Number of Cores`, type: `number`, default: 4, group: `Parallelization`,
        min: 1, max: 256, step: 1,
        help: `Number of parallel cores for ORCA.`,
      },
      {
        key: `max_core_mb`, label: `Max Memory per Core (MB)`, type: `number`, default: 4000, group: `Parallelization`,
        min: 256, max: 64000, step: 256,
        help: `Maximum RAM per core (MB). Adjust for available memory.`,
      },
    ],
  },

  // ─── Transition State Search ───
  ts_search: {
    type: `ts_search`,
    label: `TS Search`,
    color: `#dc2626`,
    icon: `\u{26F0}\uFE0F`,
    category: `Calculation`,
    description: `Transition state search`,
    inputs: [`structure`, `structure_product`],
    outputs: [`structure`, `energy`, `frequencies`, `trajectory`],
    default_params: { system_type: `molecular`, software: `sella`, calculator: `xtb`, calculator_method: `GFN2-xTB`, fmax: 0.01, order: 1, orca_method: `B3LYP`, orca_basis: `6-31G*`, charge: 0, multiplicity: 1, num_cores: 4, max_core_mb: 4000 },
    help_text: `**Transition State Search** — Find saddle points on the PES.

**Software options:**
- **Sella**: Eigenvector-following optimizer (single structure input)
- **ORCA NEB-TS**: Nudged Elastic Band (requires reactant + product)`,
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: `Software`, type: `select`, default: `sella`, group: `Software`,
        options: [
          { label: `Sella`, value: `sella` },
          { label: `ORCA NEB-TS`, value: `orca` },
        ],
      },
      // ── Sella params ──
      ...sella_show([
        {
          key: `calculator`, label: `Calculator`, type: `select`, default: `xtb`, group: `Calculator`,
          options: [
            { label: `VASP (DFT, highest accuracy)`, value: `vasp` },
            { label: `xTB (fast, semi-empirical)`, value: `xtb` },
            { label: `MACE-MP`, value: `mace` },
            { label: `CHGNet`, value: `chgnet` },
            { label: `ORCA (DFT, EnGrad)`, value: `orca` },
          ],
        },
        {
          key: `calculator_method`, label: `xTB Method`, type: `select`, default: `GFN2-xTB`, group: `Calculator`,
          options: [
            { label: `GFN2-xTB (recommended)`, value: `GFN2-xTB` },
            { label: `GFN1-xTB`, value: `GFN1-xTB` },
            { label: `GFN0-xTB`, value: `GFN0-xTB` },
          ],
        },
        {
          key: `ENCUT`, label: `Cutoff Energy (eV)`, type: `number`, default: 520, group: `VASP`,
          min: 200, max: 900, step: 10,
        },
        {
          key: `EDIFF`, label: `SCF Convergence`, type: `select`, default: `1e-5`, group: `VASP`,
          options: [
            { label: `1e-4 (loose)`, value: `1e-4` },
            { label: `1e-5 (standard)`, value: `1e-5` },
            { label: `1e-6 (tight)`, value: `1e-6` },
          ],
        },
        {
          key: `kpoints`, label: `K-Points Grid`, type: `kpoints`, default: `1×1×1`, group: `VASP`,
        },
        {
          key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
          min: 0.001, max: 0.5, step: 0.005,
        },
        {
          key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `Optimizer`,
          min: 10, max: 5000, step: 50,
        },
        {
          key: `order`, label: `Saddle Point Order`, type: `select`, default: 1, group: `Optimizer`,
          options: [
            { label: `1 — First-order (standard TS)`, value: 1 },
            { label: `2 — Second-order`, value: 2 },
          ],
        },
        {
          key: `delta`, label: `Finite Difference Step`, type: `number`, default: 0.01, group: `Advanced`,
          min: 0.001, max: 0.1, step: 0.005,
        },
        {
          key: `gamma`, label: `Damping (gamma)`, type: `number`, default: 0.4, group: `Advanced`,
          min: 0.01, max: 1.0, step: 0.05,
        },
        // ── ORCA calculator params (shown when calculator=orca) ──
        {
          key: `orca_method`, label: `Method`, type: `select`, default: `B3LYP`, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          options: [
            { label: `HF`, value: `HF` },
            { label: `BP86`, value: `BP86` },
            { label: `PBE`, value: `PBE` },
            { label: `B3LYP`, value: `B3LYP` },
            { label: `PBE0`, value: `PBE0` },
            { label: `r2SCAN-3c (composite, no basis needed)`, value: `r2SCAN-3c` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `DFT/HF method for ORCA. r2SCAN-3c is a composite method (basis auto-included).`,
        },
        {
          key: `orca_basis`, label: `Basis Set`, type: `select`, default: `6-31G*`, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          options: [
            { label: `STO-3G`, value: `STO-3G` },
            { label: `6-31G`, value: `6-31G` },
            { label: `6-31G*`, value: `6-31G*` },
            { label: `def2-SVP`, value: `def2-SVP` },
            { label: `def2-TZVP`, value: `def2-TZVP` },
            { label: `cc-pVDZ`, value: `cc-pVDZ` },
            { label: `cc-pVTZ`, value: `cc-pVTZ` },
          ],
          help: `Basis set for ORCA. Ignored for composite methods like r2SCAN-3c (server-side).`,
        },
        {
          key: `charge`, label: `Charge`, type: `number`, default: 0, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          min: -10, max: 10, step: 1,
          help: `Total charge of the system.`,
        },
        {
          key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          min: 1, max: 10, step: 1,
          help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
        },
        {
          key: `num_cores`, label: `CPU Cores`, type: `number`, default: 4, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          min: 1, max: 64, step: 1,
          help: `Number of parallel cores for ORCA (%pal nprocs N end).`,
        },
        {
          key: `max_core_mb`, label: `Memory/Core (MB)`, type: `number`, default: 4000, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          min: 500, max: 32000, step: 500,
          help: `Memory per core in MB for ORCA (%maxcore N end).`,
        },
      ]),
      // ── ORCA NEB-TS params ──
      ...orca_only([
        {
          key: `method`, label: `Method`, type: `select`, default: `r2SCAN-3c`, group: `Quantum`,
          options: [
            { label: `HF`, value: `HF` },
            { label: `BP86`, value: `BP86` },
            { label: `BLYP`, value: `BLYP` },
            { label: `PBE`, value: `PBE` },
            { label: `B3LYP`, value: `B3LYP` },
            { label: `PBE0`, value: `PBE0` },
            { label: `B3PW91`, value: `B3PW91` },
            { label: `M06L`, value: `M06L` },
            { label: `M062X`, value: `M062X` },
            { label: `R2SCAN`, value: `R2SCAN` },
            { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
            { label: `B2PLYP`, value: `B2PLYP` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
        },
        {
          key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
          options: [
            { label: `STO-3G`, value: `STO-3G` },
            { label: `6-31G`, value: `6-31G` },
            { label: `6-31G*`, value: `6-31G*` },
            { label: `6-311G`, value: `6-311G` },
            { label: `6-311+G**`, value: `6-311+G**` },
            { label: `def2-SVP`, value: `def2-SVP` },
            { label: `def2-TZVP`, value: `def2-TZVP` },
            { label: `def2-TZVPP`, value: `def2-TZVPP` },
            { label: `def2-QZVP`, value: `def2-QZVP` },
            { label: `cc-pVDZ`, value: `cc-pVDZ` },
            { label: `cc-pVTZ`, value: `cc-pVTZ` },
            { label: `cc-pVQZ`, value: `cc-pVQZ` },
            { label: `cc-pVDZ-F12`, value: `cc-pVDZ-F12` },
            { label: `cc-pVTZ-F12`, value: `cc-pVTZ-F12` },
          ],
          help: `Basis set for Gaussian functions. 6-31G is standard, def2-TZVP for better accuracy.`,
        },
        {
          key: `wavefunction`, label: `Wavefunction`, type: `select`, default: ``, group: `Quantum`,
          options: [
            { label: `Auto (default)`, value: `` },
            { label: `RHF`, value: `RHF` },
            { label: `UHF`, value: `UHF` },
            { label: `ROHF`, value: `ROHF` },
            { label: `RKS`, value: `RKS` },
            { label: `UKS`, value: `UKS` },
            { label: `ROKS`, value: `ROKS` },
          ],
          help: `Wavefunction reference. Auto lets ORCA choose (RHF for HF, RKS for DFT). Use UHF/UKS for open-shell systems.`,
        },
        {
          key: `nimages`, label: `Number of Images`, type: `number`, default: 8, group: `NEB`, min: 4, max: 20,
          help: `NEB images between reactant/product. 8-12 typical; more=smoother path.`,
        },
        {
          key: `neb_cycles`, label: `Max NEB Iterations`, type: `number`, default: 100, group: `NEB`, min: 10, max: 500,
          help: `Maximum NEB optimization iterations.`,
        },
        {
          key: `uno`, label: `Generate Natural Orbitals (UNO)`, type: `boolean`, default: false, group: `Output`,
          help: `Generate natural orbitals and occupation numbers.`,
        },
        {
          key: `uco`, label: `Corresponding Orbitals (UCO)`, type: `boolean`, default: false, group: `Output`,
          help: `Generate corresponding orbitals.`,
        },
        {
          key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
          help: `Total charge of the system.`,
        },
        {
          key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
          help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
        },
      ]),
    ],
  },

  // ─── IRC ───
  irc: {
    type: `irc`,
    label: `IRC`,
    color: `#d946ef`,
    icon: `\u{1F6E4}\uFE0F`,
    category: `Calculation`,
    description: `Intrinsic reaction coordinate`,
    inputs: [`structure`],
    outputs: [`trajectory`, `structures`],
    default_params: { system_type: `molecular`, software: `orca`, method: `r2SCAN-3c`, basis: `6-31G`, max_iterations: 30 },
    help_text: `**IRC** — Trace reaction path from transition state.

Intrinsic Reaction Coordinate (IRC) follows the steepest descent path from a TS to the nearest minima (reactant and product).`,
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: `Software`, type: `select`, default: `orca`, group: `Software`,
        options: [
          { label: `ORCA`, value: `orca` },
        ],
      },
      // ── ORCA IRC params ──
      ...orca_only([
        {
          key: `method`, label: `Method`, type: `select`, default: `r2SCAN-3c`, group: `Quantum`,
          options: [
            { label: `HF`, value: `HF` },
            { label: `BP86`, value: `BP86` },
            { label: `BLYP`, value: `BLYP` },
            { label: `PBE`, value: `PBE` },
            { label: `B3LYP`, value: `B3LYP` },
            { label: `PBE0`, value: `PBE0` },
            { label: `B3PW91`, value: `B3PW91` },
            { label: `M06L`, value: `M06L` },
            { label: `M062X`, value: `M062X` },
            { label: `R2SCAN`, value: `R2SCAN` },
            { label: `r2SCAN-3c`, value: `r2SCAN-3c` },
            { label: `B2PLYP`, value: `B2PLYP` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
        },
        {
          key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
          options: [
            { label: `STO-3G`, value: `STO-3G` },
            { label: `6-31G`, value: `6-31G` },
            { label: `6-31G*`, value: `6-31G*` },
            { label: `6-311G`, value: `6-311G` },
            { label: `6-311+G**`, value: `6-311+G**` },
            { label: `def2-SVP`, value: `def2-SVP` },
            { label: `def2-TZVP`, value: `def2-TZVP` },
            { label: `def2-TZVPP`, value: `def2-TZVPP` },
            { label: `def2-QZVP`, value: `def2-QZVP` },
            { label: `cc-pVDZ`, value: `cc-pVDZ` },
            { label: `cc-pVTZ`, value: `cc-pVTZ` },
            { label: `cc-pVQZ`, value: `cc-pVQZ` },
            { label: `cc-pVDZ-F12`, value: `cc-pVDZ-F12` },
            { label: `cc-pVTZ-F12`, value: `cc-pVTZ-F12` },
          ],
          help: `Basis set for Gaussian functions. 6-31G is standard, def2-TZVP for better accuracy.`,
        },
        {
          key: `wavefunction`, label: `Wavefunction`, type: `select`, default: ``, group: `Quantum`,
          options: [
            { label: `Auto (default)`, value: `` },
            { label: `RHF`, value: `RHF` },
            { label: `UHF`, value: `UHF` },
            { label: `ROHF`, value: `ROHF` },
            { label: `RKS`, value: `RKS` },
            { label: `UKS`, value: `UKS` },
            { label: `ROKS`, value: `ROKS` },
          ],
          help: `Wavefunction reference. Auto lets ORCA choose (RHF for HF, RKS for DFT). Use UHF/UKS for open-shell systems.`,
        },
        {
          key: `max_iterations`, label: `Max IRC Steps`, type: `number`, default: 30, group: `IRC`, min: 10, max: 100,
          help: `Maximum IRC path-following steps.`,
        },
        {
          key: `uno`, label: `Generate Natural Orbitals (UNO)`, type: `boolean`, default: false, group: `Output`,
          help: `Generate natural orbitals and occupation numbers.`,
        },
        {
          key: `uco`, label: `Corresponding Orbitals (UCO)`, type: `boolean`, default: false, group: `Output`,
          help: `Generate corresponding orbitals.`,
        },
        {
          key: `charge`, label: `Charge`, type: `number`, default: 0, group: `System`,
          help: `Total charge of the system.`,
        },
        {
          key: `multiplicity`, label: `Multiplicity`, type: `number`, default: 1, group: `System`,
          help: `Spin multiplicity (2S+1). 1=singlet, 2=doublet, 3=triplet.`,
        },
      ]),
    ],
  },
}
