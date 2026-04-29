import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only, cp2k_only, lammps_only, mlp_only, gromacs_only, amber_only,
  INCAR_COMMON, KPOINTS_PARAM,
  VASP_ELECTRONIC_PARAMS, VASP_OUTPUT_PARAMS, VASP_PARALLELIZATION_PARAMS,
  VASP_DISPERSION_PARAMS, VASP_ADVANCED_PARAMS,
  CP2K_DFT_PARAMS, MLP_COMMON_PARAMS,
} from '../common'

export const MD_NODE: NodeDefinition = {
  type: `md`,
  label: `Molecular Dynamics`,
  color: `#8b5cf6`,
  icon: `\u{1F321}\uFE0F`,
  category: `Calculation`,
  description: `Molecular dynamics simulation`,
  inputs: [`structure`, `restart`],
  outputs: [`trajectory`, `energy`, `log`, `restart`],
  default_params: {
    system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, PREC: `Accurate`,
    ALGO: `Fast`, ISMEAR: 0, SIGMA: 0.05, LREAL: `Auto`, NELM: 200, ISPIN: 1, MAGMOM: ``,
    TEBEG: 300, NSW: 5000, POTIM: 1.0, SMASS: 0, kpoints: `4×4×4`,
    LORBIT: 0, LWAVE: false, LCHARG: false, LAECHG: false,
    NPAR: 0, KPAR: 0, NCORE: 4,
    IVDW: 0, LDIPOL: false, IDIPOL: 3,
    NBANDS: 0, NEDOS: 301, ISTART: 0, ICHARG: 0,
  },
  help_text: `**Molecular Dynamics** — Run MD simulations.

Choose system type first, then select a compatible MD engine.

**Periodic:** VASP, CP2K, LAMMPS, GROMACS, MLP
**Molecular:** CP2K, LAMMPS, GROMACS, AMBER, MLP`,
  param_schema: [
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
        { label: `CP2K`, value: `cp2k` },
        { label: `LAMMPS`, value: `lammps` },
        { label: `GROMACS`, value: `gromacs` },
        { label: `AMBER`, value: `amber` },
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
      ...VASP_ELECTRONIC_PARAMS,
      ...VASP_OUTPUT_PARAMS.map(p =>
        p.key === `LORBIT` ? { ...p, default: 0 } :
        p.key === `LCHARG` ? { ...p, default: false } : p
      ),
      ...VASP_DISPERSION_PARAMS,
      ...VASP_PARALLELIZATION_PARAMS,
      ...VASP_ADVANCED_PARAMS,
    ]),
    // ── VASP constant-potential overlay ──
    ...vasp_only([
      {
        key: `constant_potential`, label: `Constant-Potential Method`, type: `select`, default: `none`, group: `Electrochemistry`,
        options: [
          { label: `None (standard NVT)`, value: `none` },
          { label: `TPOT (comet-group)`, value: `tpot` },
          { label: `CP-VASP (yuanyue-liu-group)`, value: `cpvasp` },
        ],
        help: `Constant-potential method for electrochemical AIMD. Maintains fixed electrode potential during MD by dynamically adjusting electron count.`,
      },
      {
        key: `tpot_vtarget`, label: `Target Potential (V vs SHE)`, type: `number`, default: 0.0, group: `Electrochemistry`,
        min: -3.0, max: 3.0, step: 0.1,
        show_if: { key: `constant_potential`, values: [`tpot`] },
        help: `Target electrode potential (V vs SHE). Converted to vacuum scale internally: V_vacuum = V_SHE + 4.6.`,
      },
      {
        key: `tpot_electstep`, label: `Max e\u207B change/step`, type: `number`, default: 0.05, group: `Electrochemistry`,
        min: 0.001, max: 0.5, step: 0.01,
        show_if: { key: `constant_potential`, values: [`tpot`] },
        help: `Maximum electron count change per ionic step (TPOTELECTSTEP). Smaller = more stable but slower convergence.`,
      },
      {
        key: `cpvasp_targetmu`, label: `Target \u03BC (eV)`, type: `number`, default: -4.6, group: `Electrochemistry`,
        min: -8.0, max: 0, step: 0.1,
        show_if: { key: `constant_potential`, values: [`cpvasp`] },
        help: `Target chemical potential (eV). For 0 V vs SHE, use \u03BC = -4.44 eV (work function of SHE).`,
      },
      {
        key: `cpvasp_nescheme`, label: `e\u207B Update Scheme`, type: `select`, default: 5, group: `Electrochemistry`,
        options: [
          { label: `2 \u2014 Capacitor model`, value: 2 },
          { label: `5 \u2014 Exact + eta (recommended)`, value: 5 },
        ],
        show_if: { key: `constant_potential`, values: [`cpvasp`] },
        help: `Electron update scheme. Scheme 5 (exact + eta) recommended for AIMD stability.`,
      },
      {
        key: `LDIPOL`, label: `Dipole Correction`, type: `boolean`, default: false, group: `Slab`,
        help: `Enable dipole correction along z-axis. Recommended for slab models.`,
      },
      {
        key: `frozen_layers`, label: `Frozen Bottom Layers`, type: `number`, default: 0, group: `Slab`,
        min: 0, max: 6, step: 1,
        help: `Number of bottom slab layers to freeze (selective dynamics).`,
      },
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
        help: `Potential type with args (e.g. lj/cut 2.5, eam/alloy, tersoff).`,
      },
      {
        key: `pair_coeff`, label: `Pair Coefficients`, type: `text`, default: `* * 1.0 1.0`, group: `Potential`,
        help: `Potential coefficients per atom-type pair. Format depends on pair_style.`,
      },
      {
        key: `extra_commands`, label: `Extra Commands`, type: `text`, default: ``, group: `Potential`,
        help: `Additional LAMMPS commands after force field (one per line).`,
      },
      {
        key: `units`, label: `Units`, type: `select`, default: `metal`, group: `MD`,
        options: [
          { label: `metal — Å, eV, ps, K, bar`, value: `metal` },
          { label: `real — Å, kcal/mol, fs, K, atm`, value: `real` },
          { label: `lj — reduced LJ units`, value: `lj` },
        ],
        help: `Unit system: metal=Å/eV/ps, real=Å/kcal·mol\u207B\u00B9/fs, lj=reduced units.`,
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
    // ── AMBER MD params ──
    ...amber_only([
      {
        key: `topology_file`, label: `Topology File (prmtop)`, type: `text`, default: ``, group: `Input Files`,
        help: `Absolute path to AMBER topology file (.prmtop) on HPC. Must be pre-built with tleap/parmed.`,
      },
      {
        key: `restart_file`, label: `Restart File (rst7)`, type: `text`, default: ``, group: `Input Files`,
        help: `Absolute path to AMBER restart/coordinate file (.rst7/.ncrst) on HPC.`,
      },
      {
        key: `nstlim`, label: `MD Steps`, type: `number`, default: 5000000, group: `MD`,
        min: 1000, max: 100000000, step: 100000,
        help: `Total number of MD time steps (nstlim).`,
      },
      {
        key: `dt`, label: `Timestep (ps)`, type: `number`, default: 0.0001, group: `MD`,
        min: 0.00001, max: 0.004, step: 0.0001,
        help: `MD time step in ps. 0.0001 ps (0.1 fs) typical for ML/MM; 0.002 ps (2 fs) for classical with SHAKE.`,
      },
      {
        key: `irest`, label: `Restart`, type: `select`, default: 1, group: `MD`,
        options: [
          { label: `Yes \u2014 continue from restart`, value: 1 },
          { label: `No \u2014 fresh start`, value: 0 },
        ],
        help: `irest=1: continue MD from restart file. irest=0: start fresh (ignore velocities in rst7).`,
      },
      {
        key: `ntt`, label: `Thermostat`, type: `select`, default: 0, group: `Thermostat`,
        options: [
          { label: `0 \u2014 NVE (no thermostat)`, value: 0 },
          { label: `1 \u2014 Berendsen weak-coupling`, value: 1 },
          { label: `2 \u2014 Andersen-like`, value: 2 },
          { label: `3 \u2014 Langevin`, value: 3 },
        ],
        help: `Temperature control. 0=NVE, 1=Berendsen, 2=Andersen, 3=Langevin (gamma_ln required).`,
      },
      {
        key: `temp0`, label: `Temperature (K)`, type: `number`, default: 300, group: `Thermostat`,
        min: 1, max: 5000, step: 10,
        show_if: { key: `ntt`, values: [1, 2, 3] },
        help: `Target temperature (K) for thermostat.`,
      },
      {
        key: `gamma_ln`, label: `Langevin Collision Freq (ps\u207B\u00B9)`, type: `number`, default: 2.0, group: `Thermostat`,
        min: 0.1, max: 100, step: 0.5,
        show_if: { key: `ntt`, values: [3] },
        help: `Langevin collision frequency (gamma_ln). 2.0 ps\u207B\u00B9 typical.`,
      },
      {
        key: `ntb`, label: `Periodic Boundary`, type: `select`, default: 0, group: `Boundary`,
        options: [
          { label: `0 \u2014 No PBC (gas phase / enzyme)`, value: 0 },
          { label: `1 \u2014 Constant volume (NVT/NVE)`, value: 1 },
          { label: `2 \u2014 Constant pressure (NPT)`, value: 2 },
        ],
        help: `Periodic boundary conditions. 0 for gas-phase or enzyme QM/MM, 1 for NVT, 2 for NPT.`,
      },
      {
        key: `cut`, label: `Cutoff (\u00C5)`, type: `number`, default: 9999.0, group: `Boundary`,
        min: 5, max: 9999, step: 1,
        help: `Non-bonded cutoff (\u00C5). Use 9999.0 for no-PBC (ntb=0). Use 10.0 for PBC.`,
      },
      {
        key: `ntc`, label: `SHAKE`, type: `select`, default: 1, group: `Constraints`,
        options: [
          { label: `1 \u2014 No SHAKE`, value: 1 },
          { label: `2 \u2014 SHAKE bonds with H`, value: 2 },
          { label: `3 \u2014 SHAKE all bonds`, value: 3 },
        ],
        help: `SHAKE constraint. 1=no SHAKE (use with ML/MM), 2=H bonds only, 3=all bonds.`,
      },
      // ── ML/MM Settings ──
      {
        key: `use_mlp`, label: `Enable ML Potential (ML/MM)`, type: `checkbox`, default: true, group: `ML/MM`,
        help: `Enable ML potential (ifmlp=1). When on, &mlp namelist is written with MACE/ANI model settings.`,
      },
      {
        key: `mlp_model`, label: `ML Model`, type: `select`, default: `macepol_l`, group: `ML/MM`,
        options: [
          { label: `MACE-POL Large`, value: `macepol_l` },
          { label: `MACE-POL Medium`, value: `macepol_m` },
          { label: `MACE-POL Small`, value: `macepol_s` },
          { label: `MACE-OMol v2`, value: `maceomol_v2` },
          { label: `MACE-OFF23 Large`, value: `mace_off23_large` },
          { label: `MACE-OFF23 Medium`, value: `mace_off23_medium` },
          { label: `MACE-OFF23 Small`, value: `mace_off23_small` },
          { label: `AIMNet2`, value: `aimnet2` },
          { label: `AIMNet2 NSE`, value: `aimnet2nse` },
          { label: `ANI-2x`, value: `ani2x` },
          { label: `ANI-1 XNR`, value: `ani1_xnr` },
          { label: `SpookyNet`, value: `spookynet` },
          { label: `Egret-S`, value: `egret_s` },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `Neural network potential model. MACE-POL for polarizable ML/MM; MACE-OFF23 for organic; ANI/AIMNet2 for small molecules.`,
      },
      {
        key: `animask`, label: `ML Region Mask`, type: `text`, default: ``, group: `ML/MM`,
        show_if: { key: `use_mlp`, values: [true] },
        help: `AMBER atom mask for ML region (e.g. "@7-21,28-42"). Atoms in this mask are treated with the ML potential; others use MM force field.`,
      },
      {
        key: `mlp_shake`, label: `SHAKE in ML Region`, type: `select`, default: 1, group: `ML/MM`,
        options: [
          { label: `0 \u2014 No SHAKE`, value: 0 },
          { label: `1 \u2014 SHAKE H bonds`, value: 1 },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `SHAKE constraints in ML region. 0=off, 1=constrain X-H bonds.`,
      },
      {
        key: `gpu_id`, label: `GPU ID`, type: `number`, default: 0, group: `ML/MM`,
        min: 0, max: 7, step: 1,
        show_if: { key: `use_mlp`, values: [true] },
        help: `GPU device ID for ML potential evaluation.`,
      },
      {
        key: `mlp_embedding`, label: `Embedding Type`, type: `select`, default: 2, group: `ML/MM Advanced`,
        options: [
          { label: `0 \u2014 None`, value: 0 },
          { label: `1 \u2014 Mechanical embedding`, value: 1 },
          { label: `2 \u2014 Electrostatic embedding`, value: 2 },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `QM/MM embedding scheme. 2 (electrostatic) includes MM point charges in ML region.`,
      },
      {
        key: `mlp_multipole`, label: `Multipole Order`, type: `select`, default: 1, group: `ML/MM Advanced`,
        options: [
          { label: `0 \u2014 Charges only`, value: 0 },
          { label: `1 \u2014 Charges + dipoles`, value: 1 },
          { label: `2 \u2014 Charges + dipoles + quadrupoles`, value: 2 },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `Multipole expansion order for ML/MM electrostatic interactions.`,
      },
      {
        key: `mlp_polar`, label: `Polarization`, type: `select`, default: 2, group: `ML/MM Advanced`,
        options: [
          { label: `0 \u2014 Off`, value: 0 },
          { label: `1 \u2014 Induced dipoles`, value: 1 },
          { label: `2 \u2014 Full polarization`, value: 2 },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `Polarization scheme. 2 = full self-consistent induced dipoles from ML potential.`,
      },
      {
        key: `adjust_q`, label: `Charge Adjustment`, type: `select`, default: 1, group: `ML/MM Advanced`,
        options: [
          { label: `0 \u2014 No adjustment`, value: 0 },
          { label: `1 \u2014 Adjust ML charges to match MM`, value: 1 },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `Adjust ML atomic charges to maintain total charge consistency with MM region.`,
      },
      {
        key: `model_path`, label: `Model Directory (HPC)`, type: `text`, default: ``, group: `ML/MM Advanced`,
        show_if: { key: `use_mlp`, values: [true] },
        help: `Absolute path to ML model directory on HPC (contains .pt files). If empty, uses $MODEL_PATH environment variable.`,
      },
      // ── Output ──
      {
        key: `ntpr`, label: `Energy Output (steps)`, type: `number`, default: 1000, group: `Output`,
        min: 1, max: 100000, step: 100,
        help: `Print energy info every ntpr steps to mdout.`,
      },
      {
        key: `ntwx`, label: `Trajectory Output (steps)`, type: `number`, default: 10000, group: `Output`,
        min: 100, max: 1000000, step: 1000,
        help: `Write coordinates to trajectory (mdcrd/nc) every ntwx steps.`,
      },
      {
        key: `ntwv`, label: `Velocity Output (steps)`, type: `number`, default: 0, group: `Output`,
        min: 0, max: 1000000, step: 1000,
        help: `Write velocities every ntwv steps (0=off). Needed for electric field analysis.`,
      },
      {
        key: `ntwr`, label: `Restart Output (steps)`, type: `number`, default: 100000, group: `Output`,
        min: 1000, max: 10000000, step: 10000,
        help: `Write restart file every ntwr steps for crash recovery.`,
      },
      // ── Custom mdin override ──
      {
        key: `custom_mdin`, label: `Custom mdin`, type: `text`, default: ``, group: `Advanced`,
        help: `Full custom mdin content. When provided, all above parameters are ignored and this text is used as-is.`,
      },
    ]),
  ],
}
