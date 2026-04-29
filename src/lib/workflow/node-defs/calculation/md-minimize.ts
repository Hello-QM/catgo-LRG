import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  lammps_only, mlp_only, gromacs_only, amber_only,
  MLP_COMMON_PARAMS,
} from '../common'

export const MD_MINIMIZE_NODE: NodeDefinition = {
  type: `md_minimize`,
  label: `MD Minimize`,
  color: `#6366f1`,
  icon: `⬇️`,
  category: `Calculation`,
  description: `Energy minimization with MD engines`,
  inputs: [`structure`, `restart`],
  outputs: [`trajectory`, `energy`, `log`, `restart`],
  default_params: {
    system_type: `periodic`, software: `lammps`,
  },
  help_text: `**MD Minimize** — Energy minimization using classical MD / ML force fields.

Minimize structure energy before running MD to remove bad contacts, relieve strain, or find local minima.

**Periodic:** LAMMPS, GROMACS, MLP
**Molecular:** LAMMPS, GROMACS, AMBER, MLP`,
  param_schema: [
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `lammps`, group: `Software`,
      options: [
        { label: `LAMMPS`, value: `lammps` },
        { label: `GROMACS`, value: `gromacs` },
        { label: `AMBER`, value: `amber` },
        { label: `MLP`, value: `mlp` },
      ],
      help: `Minimization engine. Options are filtered by system type.`,
    },
    // ── Packmol pre-step ──
    {
      key: `packmol_enabled`, label: `Build Box with Packmol`, type: `checkbox`, default: false, group: `Packmol`,
      help: `Enable packmol to pack molecules into a simulation box before MD minimization.`,
    },
    {
      key: `packmol_components`, label: `Mixture (JSON)`, type: `text`, default: ``, group: `Packmol`,
      show_if: { key: `packmol_enabled`, values: [true] },
      help: `Optional. Multi-component box: JSON array. Each entry uses "count" plus either "smiles" (Open Babel) or "input":"structure" for an uploaded template. When several Structure Input nodes connect to the same structure port, use "template_index": 0, 1, … for each species. Example SMILES: [{"count":100,"smiles":"O"},{"count":50,"smiles":"CCO"}]. Example files: [{"count":100,"input":"structure","template_index":0},{"count":50,"input":"structure","template_index":1}]. Leave empty if using Packmol file counts only or single-species mode.`,
    },
    {
      key: `packmol_file_counts`, label: `Packmol file counts (JSON)`, type: `text`, default: ``, group: `Packmol`,
      show_if: { key: `packmol_enabled`, values: [true] },
      help: `Optional shortcut when Mixture JSON is empty: JSON array of copy counts in the same order as structures wired to the **structure** port (handle in‑0). Connect multiple Structure Input nodes into that one port; e.g. [100, 50] = 100× first template, 50× second. Each template may be MOL2, XYZ, PDB, CIF, POSCAR, or CatGo JSON — the engine normalizes to PDB for Packmol then builds LAMMPS data (and force-field conversion when enabled). Restart uses in‑1 only.`,
    },
    {
      key: `packmol_n_molecules`, label: `Number of Molecules`, type: `number`, default: 100, group: `Packmol`,
      min: 1, max: 100000, step: 10,
      show_if: { key: `packmol_enabled`, values: [true] },
      help: `Single-species mode only (Mixture JSON empty): how many copies of the connected structure to pack.`,
    },
    {
      key: `packmol_density`, label: `Density (g/cm³)`, type: `number`, default: 1.0, group: `Packmol`,
      min: 0.1, max: 3.0, step: 0.1,
      show_if: { key: `packmol_enabled`, values: [true] },
      help: `Target mass density. Cubic box edge is computed from total mass and this density.`,
    },
    {
      key: `packmol_tolerance`, label: `Packmol tolerance (Å)`, type: `number`, default: 2.0, group: `Packmol`,
      min: 0.5, max: 5.0, step: 0.1,
      show_if: { key: `packmol_enabled`, values: [true] },
      help: `Minimum distance between atomic centers (Packmol tolerance). Increase slightly if packing fails to converge.`,
    },
    // ── LAMMPS minimize params ──
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
        help: `Apply GAFF2/OPLS force field to molecular structure (PDB input required).`,
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
        key: `units`, label: `Units`, type: `select`, default: `metal`, group: `Minimization`,
        options: [
          { label: `metal — Å, eV, ps, K, bar`, value: `metal` },
          { label: `real — Å, kcal/mol, fs, K, atm`, value: `real` },
          { label: `lj — reduced LJ units`, value: `lj` },
        ],
        help: `Unit system: metal=Å/eV/ps, real=Å/kcal·mol⁻¹/fs, lj=reduced units.`,
      },
      {
        key: `min_style`, label: `Minimizer`, type: `select`, default: `cg`, group: `Minimization`,
        options: [
          { label: `cg — Conjugate Gradient`, value: `cg` },
          { label: `sd — Steepest Descent`, value: `sd` },
          { label: `hftn — Hessian-Free Truncated Newton`, value: `hftn` },
          { label: `fire — FIRE (Fast Inertial Relaxation Engine)`, value: `fire` },
          { label: `quickmin — Damped dynamics`, value: `quickmin` },
        ],
        help: `Minimization algorithm. CG is robust and default. FIRE is good for far-from-minimum structures.`,
      },
      {
        key: `etol`, label: `Energy Tolerance`, type: `number`, default: 1.0e-6, group: `Minimization`,
        min: 0, max: 0.01, step: 1e-6,
        help: `Stopping tolerance for energy change (dimensionless). 0 to disable.`,
      },
      {
        key: `ftol`, label: `Force Tolerance`, type: `number`, default: 1.0e-6, group: `Minimization`,
        min: 0, max: 0.01, step: 1e-6,
        help: `Stopping tolerance for force (force units). 0 to disable.`,
      },
      {
        key: `maxiter`, label: `Max Iterations`, type: `number`, default: 10000, group: `Minimization`,
        min: 100, max: 1000000, step: 1000,
        help: `Maximum number of minimization iterations.`,
      },
      {
        key: `maxeval`, label: `Max Force Evaluations`, type: `number`, default: 100000, group: `Minimization`,
        min: 1000, max: 10000000, step: 10000,
        help: `Maximum number of force/energy evaluations.`,
      },
    ]),
    // ── GROMACS minimize params ──
    ...gromacs_only([
      {
        key: `force_field`, label: `Force Field`, type: `select`, default: `amber99sb-ildn`, group: `ForceField`,
        options: [
          { label: `AMBER99SB-ILDN`, value: `amber99sb-ildn` },
          { label: `CHARMM36`, value: `charmm36` },
          { label: `OPLS-AA`, value: `oplsaa` },
        ],
        help: `Molecular mechanics force field.`,
      },
      {
        key: `water_model`, label: `Water Model`, type: `select`, default: `tip3p`, group: `ForceField`,
        options: [
          { label: `TIP3P`, value: `tip3p` },
          { label: `SPC/E`, value: `spce` },
          { label: `TIP4P`, value: `tip4p` },
        ],
        help: `Explicit water model.`,
      },
      {
        key: `integrator`, label: `Minimizer`, type: `select`, default: `steep`, group: `Minimization`,
        options: [
          { label: `steep — Steepest Descent`, value: `steep` },
          { label: `cg — Conjugate Gradient`, value: `cg` },
          { label: `l-bfgs — L-BFGS`, value: `l-bfgs` },
        ],
        help: `Minimization algorithm. Steepest descent is robust for initial relaxation; CG for refinement.`,
      },
      {
        key: `nsteps`, label: `Max Steps`, type: `number`, default: 50000, group: `Minimization`,
        min: 1000, max: 1000000, step: 5000,
        help: `Maximum number of minimization steps.`,
      },
      {
        key: `emtol`, label: `Force Tolerance (kJ/mol/nm)`, type: `number`, default: 100.0, group: `Minimization`,
        min: 1, max: 10000, step: 10,
        help: `Maximum force convergence criterion. 100 kJ/mol/nm is typical for pre-MD minimization; use 10 for careful minimization.`,
      },
      {
        key: `emstep`, label: `Initial Step Size (nm)`, type: `number`, default: 0.01, group: `Minimization`,
        min: 0.001, max: 0.1, step: 0.001,
        help: `Initial step size for minimization. Reduced automatically during the run.`,
      },
      {
        key: `coulombtype`, label: `Electrostatics`, type: `select`, default: `PME`, group: `Interactions`,
        options: [
          { label: `PME (recommended)`, value: `PME` },
          { label: `Cut-off`, value: `Cut-off` },
        ],
        help: `Long-range electrostatics. PME required for charged/periodic systems.`,
      },
      {
        key: `rcoulomb`, label: `Coulomb Cutoff (nm)`, type: `number`, default: 1.0, group: `Interactions`,
        min: 0.8, max: 2.0, step: 0.1,
        help: `Real-space Coulomb cutoff distance (nm).`,
      },
      {
        key: `rvdw`, label: `VdW Cutoff (nm)`, type: `number`, default: 1.0, group: `Interactions`,
        min: 0.8, max: 2.0, step: 0.1,
        help: `Van der Waals cutoff distance (nm).`,
      },
    ]),
    // ── AMBER minimize params ──
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
        help: `Convergence criterion for RMS gradient (kcal/mol/Å).`,
      },
      {
        key: `ntb`, label: `Periodic Boundary`, type: `select`, default: 0, group: `Boundary`,
        options: [
          { label: `0 — No PBC (gas phase)`, value: 0 },
          { label: `1 — Constant volume`, value: 1 },
        ],
        help: `Periodic boundary conditions. 0 for gas-phase/non-periodic, 1 for periodic.`,
      },
      {
        key: `cut`, label: `Cutoff (Å)`, type: `number`, default: 9999.0, group: `Boundary`,
        min: 5, max: 9999, step: 1,
        help: `Non-bonded cutoff (Å). Use 9999.0 for no-PBC (ntb=0), 10.0 for PBC.`,
      },
      {
        key: `use_mlp`, label: `Enable ML Potential`, type: `checkbox`, default: false, group: `ML/MM`,
        help: `Enable ML potential for minimization (ifmlp=1).`,
      },
      {
        key: `mlp_model`, label: `ML Model`, type: `select`, default: `macepol_l`, group: `ML/MM`,
        options: [
          { label: `MACE-POL Large`, value: `macepol_l` },
          { label: `MACE-POL Medium`, value: `macepol_m` },
          { label: `MACE-POL Small`, value: `macepol_s` },
          { label: `MACE-OMol v2`, value: `maceomol_v2` },
          { label: `ANI-2x`, value: `ani2x` },
        ],
        show_if: { key: `use_mlp`, values: [true] },
        help: `Neural network potential model for ML/MM minimization.`,
      },
      {
        key: `animask`, label: `ML Region Mask`, type: `text`, default: ``, group: `ML/MM`,
        show_if: { key: `use_mlp`, values: [true] },
        help: `AMBER atom mask for ML region (e.g. "@7-21,28-42").`,
      },
      {
        key: `custom_mdin`, label: `Custom mdin`, type: `text`, default: ``, group: `Advanced`,
        help: `Full custom mdin content. When provided, all above parameters are ignored.`,
      },
    ]),
    // ── MLP minimize params ──
    ...mlp_only([
      ...MLP_COMMON_PARAMS,
      {
        key: `relax_cell`, label: `Relax Cell`, type: `boolean`, default: false, group: `Optimizer`,
        help: `Also optimize cell shape and volume (ExpCellFilter). Enable for bulk optimization.`,
      },
      {
        key: `optimizer`, label: `Optimizer`, type: `select`, default: `FIRE`, group: `Optimizer`,
        options: [
          { label: `FIRE`, value: `FIRE` },
          { label: `BFGS`, value: `BFGS` },
          { label: `LBFGS`, value: `LBFGS` },
        ],
        help: `FIRE is robust for far-from-equilibrium structures. BFGS is faster near minima.`,
      },
      {
        key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.01, group: `Optimizer`,
        min: 0.001, max: 0.5, step: 0.005,
        help: `Max force convergence (eV/Å). 0.01 standard for ML potentials.`,
      },
      {
        key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `Optimizer`,
        min: 10, max: 5000, step: 50,
        help: `Maximum optimization steps.`,
      },
    ]),
  ],
}
