import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only,
  INCAR_COMMON, KPOINTS_PARAM, PARALLELIZATION_PARAMS,
} from '../common'

export const SLOW_GROWTH_NODE: NodeDefinition = {
  type: `slow_growth`,
  label: `Slow-Growth AIMD`,
  color: `#dc2626`,
  icon: `\u{1F525}`,
  category: `Calculation`,
  description: `Slow-growth thermodynamic integration (constrained AIMD)`,
  inputs: [`structure`, `restart`],
  outputs: [`trajectory`, `energy`, `report`, `restart`],
  default_params: {
    system_type: `periodic`,
    software: `vasp`,
    ENCUT: 400,
    EDIFF: `1e-4`,
    TEBEG: 300,
    NSW: 10000,
    POTIM: 1.0,
    SMASS: 0,
    lblueout: true,
    increm: `-0.005`,
    iconst_content: ``,
    constant_potential: `none`,
  },
  help_text: `**Slow-Growth AIMD** — Thermodynamic integration via constrained molecular dynamics.

A collective variable (CV, e.g. C-N bond distance) is linearly varied over NSW steps using ICONST constraints. The free energy gradient is extracted from the REPORT file (LBLUEOUT=.TRUE.).

**Typical workflow:** Geometry Opt → AIMD Equilibration → Slow-Growth

**Key parameters:**
- **ICONST**: Defines the constraint (atom indices + type)
- **INCREM**: CV change rate per step (negative = decrease distance)
- **Constant-potential**: Optional TPOT or CP-VASP overlay for electrochemistry`,
  param_schema: [
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
      ],
      help: `Slow-growth thermodynamic integration is only supported by VASP.`,
    },
    // ── Constraint definition ──
    ...vasp_only([
      {
        key: `iconst_content`, label: `ICONST Content`, type: `text`, default: ``, group: `Constraint`,
        help: `Content of the ICONST file defining geometric constraints. Example for C-N bond distance:
R 45 67 0
Where R = bond distance, 45/67 = atom indices (1-based), 0 = constraint status.
Use the C-N coupling network tool to generate templates.`,
      },
      {
        key: `increm`, label: `INCREM (CV rate)`, type: `text`, default: `-0.005`, group: `Constraint`,
        help: `Change in collective variable per MD step. Negative = decrease distance (bond formation).
Typical: -0.005 to -0.01 \u00C5/step for bond formation. Corresponds to the constraint in ICONST.`,
      },
      {
        key: `lblueout`, label: `LBLUEOUT`, type: `boolean`, default: true, group: `Constraint`,
        help: `Write Blue Moon ensemble data to REPORT file. Must be TRUE for slow-growth analysis.`,
      },
    ]),
    // ── VASP MD params ──
    ...vasp_only([
      ...INCAR_COMMON.map(p => p.key === `ENCUT` ? { ...p, default: 400, help: `${p.help} 400 eV typical for AIMD (balance speed vs accuracy).` } : p)
                     .map(p => p.key === `EDIFF` ? { ...p, default: `1e-4`, help: `${p.help} 1e-4 typical for AIMD.` } : p),
      {
        key: `TEBEG`, label: `Temperature (K)`, type: `number`, default: 300, group: `INCAR`,
        min: 1, max: 5000, step: 50,
        help: `MD temperature (K). 300 K for room temperature electrochemistry. Velocities initialized from Maxwell-Boltzmann distribution.`,
      },
      {
        key: `NSW`, label: `MD Steps`, type: `number`, default: 10000, group: `INCAR`,
        min: 1000, max: 100000, step: 1000,
        help: `Total number of MD steps. For slow-growth, determines the CV range covered: total \u0394CV = NSW \u00D7 INCREM.`,
      },
      {
        key: `POTIM`, label: `Timestep (fs)`, type: `number`, default: 1.0, group: `INCAR`,
        min: 0.1, max: 5.0, step: 0.5,
        help: `MD time step (fs). 1.0 fs typical for AIMD. Use 0.5 fs if light elements (H) present.`,
      },
      {
        key: `SMASS`, label: `Thermostat (SMASS)`, type: `select`, default: 0, group: `INCAR`,
        options: [
          { label: `-1 \u2014 NVE (no thermostat)`, value: -1 },
          { label: `0 \u2014 Nos\u00E9-Hoover NVT`, value: 0 },
          { label: `3 \u2014 Langevin NVT`, value: 3 },
        ],
        help: `Thermostat for slow-growth. Nos\u00E9-Hoover NVT (0) recommended for constant-temperature electrochemistry.`,
      },
      KPOINTS_PARAM,
      ...PARALLELIZATION_PARAMS,
    ]),
    // ── Constant-potential overlay ──
    ...vasp_only([
      {
        key: `constant_potential`, label: `Constant-Potential Method`, type: `select`, default: `none`, group: `Electrochemistry`,
        options: [
          { label: `None (standard NVT)`, value: `none` },
          { label: `TPOT (comet-group)`, value: `tpot` },
          { label: `CP-VASP (yuanyue-liu-group)`, value: `cpvasp` },
        ],
        help: `Constant-potential method for electrochemical simulations. TPOT and CP-VASP maintain fixed electrode potential during AIMD.`,
      },
      {
        key: `tpot_vtarget`, label: `Target Potential (V vs SHE)`, type: `number`, default: 0.0, group: `Electrochemistry`,
        min: -3.0, max: 3.0, step: 0.1,
        show_if: { key: `constant_potential`, values: [`tpot`, `cpvasp`] },
        help: `Target electrode potential in V vs SHE. 0 V = standard hydrogen electrode. Negative = reductive conditions.`,
      },
      {
        key: `tpot_fermi`, label: `Initial Fermi Level (eV)`, type: `number`, default: -4.6, group: `Electrochemistry`,
        min: -10, max: 0, step: 0.1,
        show_if: { key: `constant_potential`, values: [`tpot`, `cpvasp`] },
        help: `Initial Fermi level of the slab (eV). Determines starting NELECT. Obtain from a prior static calculation.`,
      },
    ]),
    // ── Slab-specific ──
    ...vasp_only([
      {
        key: `LDIPOL`, label: `Dipole Correction`, type: `boolean`, default: true, group: `Slab`,
        help: `Enable dipole correction along z-axis. Recommended for slab models with asymmetric surfaces.`,
      },
      {
        key: `frozen_layers`, label: `Frozen Bottom Layers`, type: `number`, default: 2, group: `Slab`,
        min: 0, max: 6, step: 1,
        help: `Number of bottom slab layers to freeze (selective dynamics). 2 typical for 4-layer slab.`,
      },
    ]),
  ],
}
