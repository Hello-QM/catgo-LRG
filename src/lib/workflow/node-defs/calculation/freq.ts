import type { NodeDefinition } from '../../workflow-types'
import {
  SYSTEM_TYPE_PARAM,
  vasp_only, cp2k_only, orca_only, gaussian_only, mlp_only,
  INCAR_COMMON, KPOINTS_PARAM,
  VASP_ELECTRONIC_PARAMS, VASP_OUTPUT_PARAMS, VASP_PARALLELIZATION_PARAMS,
  VASP_DISPERSION_PARAMS, VASP_ADVANCED_PARAMS,
  CP2K_DFT_PARAMS, ORCA_QC_PARAMS, GAUSSIAN_QC_PARAMS,
} from '../common'

export const FREQ_NODE: NodeDefinition = {
  type: `freq`,
  label: `Frequency`,
  color: `#c026d3`,
  icon: `\u3030\uFE0F`,
  category: `Calculation`,
  description: `Vibrational frequency calculation`,
  inputs: [`structure`],
  outputs: [`frequencies`, `zpe`],
  default_params: {
    system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, PREC: `Accurate`,
    ALGO: `Fast`, ISMEAR: 0, SIGMA: 0.05, LREAL: `.FALSE.`, NELM: 200, ISPIN: 1, MAGMOM: ``,
    IBRION: 5, NFREE: 2, POTIM: 0.015, kpoints: `1×1×1`,
    LORBIT: 11, LWAVE: false, LCHARG: false, LAECHG: false,
    NPAR: 0, KPAR: 0, NCORE: 0,
    IVDW: 0, LDIPOL: false, IDIPOL: 3,
    NBANDS: 0, NEDOS: 301, ISTART: 0, ICHARG: 0,
    freeze_mode: `adsorbate`,
    freeze_z_below: 0,
    freeze_elements: ``, freeze_indices: ``,
    freeze_layers: 0, freeze_invert: false,
  },
  help_text: `**Frequency Calculation** — Vibrational analysis.

Computes vibrational frequencies by finite differences of forces.
Used for ZPE corrections, thermodynamics, and TS verification.

**Gibbs correction:** If enabled, outputs G_corr = ZPE + dH(T) - TdS.
Combine with E_DFT from upstream geo_opt/single_point: **G = E_DFT + G_corr**

**Periodic:** VASP, CP2K
**Molecular:** ORCA, Gaussian, CP2K`,
  param_schema: [
    {
      key: `system_name`, label: `System Name`, type: `string`, default: ``,
      group: `General`,
      help: `Name for this system (e.g. "slab+OH"). Propagated to downstream Gibbs Energy node for the free energy diagram.`,
    },
    {
      key: `freeze_mode`, label: `Freeze Mode`, type: `select`, default: `adsorbate`,
      group: `Freeze Atoms`,
      options: [
        { label: `Adsorbate only (fix slab) — recommended`, value: `adsorbate` },
        { label: `None (all atoms vibrate)`, value: `none` },
        { label: `Manual (select in 3D)`, value: `manual` },
        { label: `By Height (z range)`, value: `z_range` },
        { label: `By Element`, value: `element` },
        { label: `By Index`, value: `indices` },
        { label: `By Layers (bottom N)`, value: `layers` },
      ],
      help: `Select which atoms to freeze (F F F in POSCAR). Frozen atoms are excluded from vibrational analysis. For an adsorbate on a slab, use "Adsorbate only" — it fixes the entire slab and vibrates only the adsorbate (the standard harmonic-adsorbate approximation). Requires the structure to come through an Adsorbate node (which tags the adsorbate atoms).`,
    },
    {
      key: `freeze_z_below`, label: `Freeze z below (Å)`, type: `number`, default: 0,
      group: `Freeze Atoms`, min: 0, max: 100, step: 0.1,
      show_if: { key: `freeze_mode`, values: [`z_range`] },
      help: `Freeze all atoms with Cartesian z-coordinate below this value. Atoms above this height will vibrate.`,
    },
    {
      key: `freeze_elements`, label: `Freeze Elements`, type: `string`, default: ``,
      group: `Freeze Atoms`,
      show_if: { key: `freeze_mode`, values: [`element`] },
      help: `Comma-separated element symbols to freeze, e.g. "Ru,O". All atoms of these elements will be frozen.`,
    },
    {
      key: `freeze_indices`, label: `Frozen Atom Indices`, type: `string`, default: ``,
      group: `Freeze Atoms`,
      show_if: { key: `freeze_mode`, values: [`indices`, `manual`] },
      help: `Comma-separated atom indices to freeze (0-based), e.g. "0,1,2,3,4,5". Use ranges like "0-31" for consecutive atoms. In Manual mode, use the "Edit Frozen Atoms" button above to select in 3D.`,
    },
    {
      key: `freeze_layers`, label: `Freeze Bottom Layers`, type: `number`, default: 0,
      group: `Freeze Atoms`, min: 0, max: 20, step: 1,
      show_if: { key: `freeze_mode`, values: [`layers`] },
      help: `Number of bottom atomic layers to freeze. Layers are detected by z-coordinate grouping.`,
    },
    {
      key: `freeze_invert`, label: `Invert Selection`, type: `boolean`, default: false,
      group: `Freeze Atoms`,
      show_if: { key: `freeze_mode`, values: [`z_range`, `element`, `indices`, `layers`, `manual`] },
      help: `Invert: instead of freezing the selected atoms, freeze everything EXCEPT them (i.e. only selected atoms vibrate).`,
    },
    SYSTEM_TYPE_PARAM,
    {
      key: `software`, label: `Software`, type: `select`, default: `vasp`, group: `Software`,
      options: [
        { label: `VASP`, value: `vasp` },
        { label: `CP2K`, value: `cp2k` },
        { label: `ORCA`, value: `orca` },
        { label: `Gaussian`, value: `gaussian` },
        { label: `ML Potential`, value: `mlp` },
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
      { ...KPOINTS_PARAM, default: `1×1×1` },
      ...VASP_ELECTRONIC_PARAMS,
      ...VASP_OUTPUT_PARAMS.map(p =>
        p.key === `LCHARG` ? { ...p, default: false } : p
      ),
      ...VASP_DISPERSION_PARAMS,
      ...VASP_PARALLELIZATION_PARAMS.map(p =>
        p.key === `NCORE` ? { ...p, default: 0, min: 0, help: `NCORE for freq: 0 = do not set (recommended). VASP IBRION=5 requires NPAR=1, setting NCORE may conflict.` } : p
      ),
      ...VASP_ADVANCED_PARAMS,
    ]),
    // ── CP2K freq params ──
    ...cp2k_only([
      ...CP2K_DFT_PARAMS.map(p =>
        p.key === `eps_scf` ? { ...p, default: `1e-7` } : p
      ),
    ]),
    // ── ORCA freq params ──
    ...orca_only(ORCA_QC_PARAMS),
    // ── MLP freq params ──
    ...mlp_only([
      {
        key: `model`, label: `ML Model`, type: `select`, default: `MACE`, group: `MLP`,
        options: [
          { label: `MACE (Universal)`, value: `MACE` },
          { label: `CHGNet`, value: `CHGNet` },
          { label: `M3GNet`, value: `M3GNet` },
        ],
        help: `Machine learning potential to use for force evaluation.`,
      },
      {
        key: `nfree`, label: `Displacement Type`, type: `select`, default: 2, group: `MLP`,
        options: [
          { label: `2 — Central differences (recommended)`, value: 2 },
          { label: `4 — 4-point stencil (more accurate)`, value: 4 },
        ],
        help: `Finite-difference stencil: 2=central (faster), 4=four-point (more accurate).`,
      },
      {
        key: `delta`, label: `Displacement (A)`, type: `number`, default: 0.01, group: `MLP`,
        min: 0.001, max: 0.1, step: 0.001,
        help: `Displacement amplitude in Angstroms for finite differences. 0.01 A is standard for ML potentials.`,
      },
    ]),
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
}
