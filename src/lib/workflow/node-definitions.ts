import type { NodeDefinition, ParamDef, ShowIfCondition, SidebarCategory } from './workflow-types'
import { MD_MINIMIZE_NODE } from './node-defs/calculation/md-minimize'
import { UVVIS_NODE } from './node-defs/calculation/uvvis'
import { adsorbate_place } from './node-defs/utility/adsorbate-place'
import { t, seed_i18n_module } from '$lib/i18n/index.svelte'
import en_workflow from '$lib/i18n/en/workflow'
import zh_workflow from '$lib/i18n/zh/workflow'

// Workflow translations must be available SYNCHRONOUSLY: this module calls
// t() at load time to build the param-def consts below. The async
// load_i18n_module('workflow') resolved after evaluation, freezing raw keys
// like "workflow.node_group_software" into group/label fields (rendered as
// "WORKFLOW.NODE_GROUP_*" in the config panel).
seed_i18n_module('workflow', { en: en_workflow, zh: zh_workflow })

// ── Single-source-of-truth migration ─────────────────────────────────────────

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
  sella: [`periodic`, `molecular`],
}

const SYSTEM_TYPE_PARAM: ParamDef = {
  key: `system_type`, label: 'workflow.node_system_type_label', type: `select`, default: `periodic`, group: 'workflow.node_group_software',
  options: [
    { label: 'workflow.node_system_type_periodic', value: `periodic` },
    { label: 'workflow.node_system_type_molecular', value: `molecular` },
  ],
  help: 'workflow.node_system_type_help',
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
function vasp_only(params: ParamDef[]): ParamDef[] {
  return with_software(`vasp`, params)
}

function cp2k_only(params: ParamDef[]): ParamDef[] {
  return with_software(`cp2k`, params)
}

function orca_only(params: ParamDef[]): ParamDef[] {
  return with_software(`orca`, params)
}

function xtb_only(params: ParamDef[]): ParamDef[] {
  return with_software(`xtb`, params)
}

function mlp_only(params: ParamDef[]): ParamDef[] {
  return with_software(`mlp`, params)
}

function lammps_only(params: ParamDef[]): ParamDef[] {
  return with_software(`lammps`, params)
}

function gaussian_only(params: ParamDef[]): ParamDef[] {
  return with_software(`gaussian`, params)
}

function gromacs_only(params: ParamDef[]): ParamDef[] {
  return with_software(`gromacs`, params)
}

function sella_show(params: ParamDef[]): ParamDef[] {
  return with_software(`sella`, params)
}

// ====== Reusable param groups ======

const INCAR_COMMON: ParamDef[] = [
  {
    key: `ENCUT`, label: 'workflow.node_encut_label', type: `number`, default: 520,
    group: 'workflow.node_group_incar', min: 200, max: 900, step: 10,
    help: 'workflow.node_encut_help',
  },
  {
    key: `EDIFF`, label: 'workflow.node_ediff_label', type: `select`, default: `1e-5`, group: 'workflow.node_group_incar',
    options: [
      { label: 'workflow.node_ediff_loose', value: `1e-4` },
      { label: 'workflow.node_ediff_standard', value: `1e-5` },
      { label: 'workflow.node_ediff_tight', value: `1e-6` },
      { label: 'workflow.node_ediff_very_tight', value: `1e-7` },
    ],
    help: 'workflow.node_ediff_help',
  },
  {
    key: `ISMEAR`, label: 'workflow.node_ismear_label', type: `select`, default: 0, group: 'workflow.node_group_incar',
    options: [
      { label: 'workflow.node_ismear_gaussian', value: 0 },
      { label: 'workflow.node_ismear_mp', value: 1 },
      { label: 'workflow.node_ismear_tetrahedron', value: -5 },
    ],
    help: 'workflow.node_ismear_help',
  },
  {
    key: `ISPIN`, label: 'workflow.node_ispin_label', type: `select`, default: 2, group: 'workflow.node_group_incar',
    options: [
      { label: 'workflow.node_ispin_no', value: 1 },
      { label: 'workflow.node_ispin_yes', value: 2 },
    ],
    help: 'workflow.node_ispin_help',
  },
  {
    key: `PREC`, label: 'workflow.node_prec_label', type: `select`, default: `Accurate`, group: 'workflow.node_group_incar',
    options: [
      { label: 'workflow.node_prec_normal', value: `Normal` },
      { label: 'workflow.node_prec_accurate', value: `Accurate` },
    ],
    help: 'workflow.node_prec_help',
  },
]

const KPOINTS_PARAM: ParamDef = {
  key: `kpoints`, label: 'workflow.node_kpoints_label', type: `kpoints`, default: `4×4×4`, group: 'workflow.node_group_kpoints',
  help: 'workflow.node_kpoints_help',
}

const PARALLELIZATION_PARAMS: ParamDef[] = [
  {
    key: `NCORE`, label: `NCORE`, type: `number`, default: 4, group: 'workflow.node_group_advanced', min: 1, max: 128,
    help: 'workflow.node_ncore_help',
  },
  {
    key: `LWAVE`, label: 'workflow.node_lwave_label', type: `boolean`, default: false, group: 'workflow.node_group_advanced',
    help: 'workflow.node_lwave_help',
  },
  {
    key: `LCHARG`, label: 'workflow.node_lcharg_label', type: `boolean`, default: true, group: 'workflow.node_group_advanced',
    help: 'workflow.node_lcharg_help',
  },
]

// ====== CP2K common params ======

const CP2K_DFT_PARAMS: ParamDef[] = [
  {
    key: `functional`, label: 'workflow.node_xc_functional_label', type: `select`, default: `PBE`, group: 'workflow.node_group_dft',
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
    help: 'workflow.node_xc_functional_help',
  },
  {
    key: `basis_set`, label: 'workflow.node_basis_set_label', type: `select`, default: `DZVP-MOLOPT-SR-GTH`, group: 'workflow.node_group_dft',
    options: [
      { label: `DZVP-MOLOPT-SR-GTH (solids)`, value: `DZVP-MOLOPT-SR-GTH` },
      { label: `DZVP-MOLOPT-GTH (molecules)`, value: `DZVP-MOLOPT-GTH` },
      { label: `TZVP-MOLOPT-GTH (accurate)`, value: `TZVP-MOLOPT-GTH` },
      { label: `TZV2P-MOLOPT-GTH (high accuracy)`, value: `TZV2P-MOLOPT-GTH` },
    ],
    help: 'workflow.node_basis_set_help',
  },
  {
    key: `cutoff`, label: 'workflow.node_cutoff_ry_label', type: `number`, default: 350, group: 'workflow.node_group_dft',
    min: 200, max: 1200, step: 50,
    help: 'workflow.node_cutoff_ry_help',
  },
  {
    key: `rel_cutoff`, label: 'workflow.node_rel_cutoff_ry_label', type: `number`, default: 50, group: 'workflow.node_group_dft',
    min: 30, max: 120, step: 10,
    help: 'workflow.node_rel_cutoff_ry_help',
  },
  {
    key: `scf_method`, label: 'workflow.node_scf_method_label', type: `select`, default: `OT`, group: 'workflow.node_group_scf',
    options: [
      { label: 'workflow.node_scf_method_ot', value: `OT` },
      { label: 'workflow.node_scf_method_diag', value: `DIAG` },
    ],
    help: 'workflow.node_scf_method_help',
  },
  {
    key: `eps_scf`, label: `EPS_SCF`, type: `select`, default: `1e-6`, group: 'workflow.node_group_scf',
    options: [
      { label: 'workflow.node_ediff_loose', value: `1e-5` },
      { label: 'workflow.node_ediff_standard', value: `1e-6` },
      { label: 'workflow.node_ediff_tight', value: `1e-7` },
    ],
    help: 'workflow.node_eps_scf_help',
  },
  {
    key: `vdw`, label: 'workflow.node_dispersion_correction_label', type: `select`, default: `none`, group: 'workflow.node_group_dft',
    options: [
      { label: 'workflow.node_none', value: `none` },
      { label: `DFT-D3(BJ)`, value: `DFTD3(BJ)` },
      { label: `DFT-D3`, value: `DFTD3` },
      { label: `DFT-D4`, value: `DFTD4` },
    ],
    help: 'workflow.node_dispersion_correction_help',
  },
  {
    key: `charge`, label: 'workflow.node_net_charge_label', type: `number`, default: 0, group: 'workflow.node_group_advanced', min: -10, max: 10, step: 1,
    help: 'workflow.node_net_charge_help',
  },
  {
    key: `uks`, label: 'workflow.node_uks_label', type: `boolean`, default: false, group: 'workflow.node_group_advanced',
    help: 'workflow.node_uks_help',
  },
  {
    key: `multiplicity`, label: 'workflow.node_multiplicity_label', type: `number`, default: 1, group: 'workflow.node_group_advanced', min: 1, max: 12, step: 1,
    help: 'workflow.node_multiplicity_help',
  },
  {
    key: `cp2k_command`, label: 'workflow.node_cp2k_executable_label', type: `string`, default: `cp2k.psmp`, group: 'workflow.node_group_advanced',
    help: 'workflow.node_cp2k_executable_help',
  },
]

// ====== ORCA common params ======

const ORCA_QC_PARAMS: ParamDef[] = [
  {
    key: `method`, label: 'workflow.node_method_label', type: `select`, default: `B3LYP`, group: 'workflow.node_group_quantum',
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
      { label: `PBEh-3c`, value: `PBEh-3c` },
      { label: `B2PLYP`, value: `B2PLYP` },
      { label: `CCSD`, value: `CCSD` },
      { label: `CCSD(T)`, value: `CCSD(T)` },
      { label: `MP2`, value: `MP2` },
      { label: `DLPNO-CCSD(T)`, value: `DLPNO-CCSD(T)` },
    ],
    help: 'workflow.node_method_help',
  },
  {
    key: `basis`, label: 'workflow.node_basis_set_label', type: `select`, default: `def2-SVP`, group: 'workflow.node_group_quantum',
    options: [
      { label: 'workflow.node_orca_basis_none_composite', value: `` },
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
    help: 'workflow.node_orca_basis_help',
  },
  {
    key: `wavefunction`, label: 'workflow.node_wavefunction_label', type: `select`, default: ``, group: 'workflow.node_group_quantum',
    options: [
      { label: 'workflow.node_wavefunction_auto', value: `` },
      { label: `RHF`, value: `RHF` },
      { label: `UHF`, value: `UHF` },
      { label: `ROHF`, value: `ROHF` },
      { label: `RKS`, value: `RKS` },
      { label: `UKS`, value: `UKS` },
      { label: `ROKS`, value: `ROKS` },
    ],
    help: 'workflow.node_wavefunction_help',
  },
  {
    key: `dispersion`, label: 'workflow.node_dispersion_label', type: `select`, default: `none`, group: 'workflow.node_group_quantum',
    options: [
      { label: 'workflow.node_none', value: `none` },
      { label: `D2`, value: `D2` },
      { label: 'workflow.node_dispersion_d3_bj_damping', value: `D3` },
      { label: 'workflow.node_dispersion_d3bj_recommended', value: `D3BJ` },
      { label: 'workflow.node_dispersion_d3zero', value: `D3ZERO` },
      { label: 'workflow.node_dispersion_d30', value: `D30` },
      { label: 'workflow.node_dispersion_d3tz', value: `D3TZ` },
      { label: 'workflow.node_dispersion_d4_newer', value: `D4` },
      { label: 'workflow.node_dispersion_novdw', value: `NOVDW` },
    ],
    help: 'workflow.node_dispersion_help',
  },
  {
    key: `three_body_dispersion`, label: 'workflow.node_three_body_dispersion_label', type: `boolean`, default: false, group: 'workflow.node_group_quantum',
    show_if: { key: `dispersion`, values: [`D2`, `D3`, `D3BJ`, `D3ZERO`, `D30`, `D3TZ`] },
    help: 'workflow.node_three_body_dispersion_help',
  },
  {
    key: `charge`, label: 'workflow.node_charge_label', type: `number`, default: 0, group: 'workflow.node_group_system',
    help: 'workflow.node_charge_help',
  },
  {
    key: `multiplicity`, label: 'workflow.node_multiplicity_label', type: `number`, default: 1, group: 'workflow.node_group_system',
    help: 'workflow.node_multiplicity_help',
  },
  {
    key: `uno`, label: 'workflow.node_uno_label', type: `boolean`, default: false, group: `Output`,
    help: 'workflow.node_uno_help',
  },
  {
    key: `uco`, label: 'workflow.node_uco_label', type: `boolean`, default: false, group: `Output`,
    help: 'workflow.node_uco_help',
  },
  {
    key: `num_cores`, label: 'workflow.node_num_cores_label', type: `number`, default: 4, group: `Parallelization`,
    min: 1, max: 256, step: 1,
    help: 'workflow.node_num_cores_help',
  },
  {
    key: `max_core_mb`, label: 'workflow.node_max_core_mb_label', type: `number`, default: 4000, group: `Parallelization`,
    min: 256, max: 64000, step: 256,
    help: 'workflow.node_max_core_mb_help',
  },
]

// ====== xTB common params ======

const XTB_METHOD_PARAMS: ParamDef[] = [
  {
    key: `method`, label: 'workflow.node_xtb_method_label', type: `select`, default: `GFN2-xTB`, group: 'workflow.node_group_method',
    options: [
      { label: `GFN2-xTB (recommended)`, value: `GFN2-xTB` },
      { label: `GFN1-xTB`, value: `GFN1-xTB` },
      { label: `GFN0-xTB`, value: `GFN0-xTB` },
      { label: `GFN-FF`, value: `GFN-FF` },
      { label: `IPEA1-xTB`, value: `IPEA1-xTB` },
    ],
    help: 'workflow.node_xtb_method_help',
  },
  {
    key: `accuracy`, label: 'workflow.node_accuracy_label', type: `number`, default: 1.0, group: 'workflow.node_group_method',
    min: 0.1, max: 3.0, step: 0.1,
    help: 'workflow.node_accuracy_help',
  },
  {
    key: `electronic_temperature`, label: 'workflow.node_electronic_temperature_label', type: `number`, default: 300, group: 'workflow.node_group_method',
    min: 0, max: 10000, step: 100,
    help: 'workflow.node_electronic_temperature_help',
  },
]

// ====== MLP common params ======

const MLP_MODEL_PARAM: ParamDef = {
  key: `model`, label: 'workflow.node_ml_model_label', type: `select`, default: `MACE`, group: 'workflow.node_group_model',
  options: [
    { label: `MACE-MP (recommended)`, value: `MACE` },
    { label: `CHGNet`, value: `CHGNet` },
    { label: `M3GNet`, value: `M3GNet` },
  ],
  help: 'workflow.node_ml_model_help',
}

const MLP_DEVICE_PARAM: ParamDef = {
  key: `device`, label: 'workflow.node_device_label', type: `select`, default: `auto`, group: 'workflow.node_group_model',
  options: [
    { label: `Auto (CUDA if available)`, value: `auto` },
    { label: `CPU`, value: `cpu` },
    { label: `CUDA GPU`, value: `cuda` },
  ],
  help: 'workflow.node_device_help',
}

const MLP_MODEL_PATH_PARAM: ParamDef = {
  key: `model_path`, label: 'workflow.node_model_path_label', type: `string`, default: ``, group: 'workflow.node_group_model',
  help: 'workflow.node_model_path_help',
}

/** Local bundle mirroring MLP_COMMON_PARAMS from node-defs/common.ts. */
const MLP_COMMON_PARAMS: ParamDef[] = [
  MLP_MODEL_PARAM,
  MLP_DEVICE_PARAM,
  MLP_MODEL_PATH_PARAM,
]

// ====== Gaussian common params ======

const GAUSSIAN_QC_PARAMS: ParamDef[] = [
  {
    key: `method`, label: 'workflow.node_method_label', type: `select`, default: `B3LYP`, group: 'workflow.node_group_method',
    options: [
      { label: `HF`, value: `HF` },
      { label: `B3LYP`, value: `B3LYP` },
      { label: `PBE1PBE (PBE0)`, value: `PBE1PBE` },
      { label: `M06-2X`, value: `M062X` },
      { label: `ωB97X-D`, value: `wB97XD` },
      { label: `MP2`, value: `MP2` },
      { label: `CCSD(T)`, value: `CCSD(T)` },
    ],
    help: `Level of theory. B3LYP general-purpose, M06-2X for thermochemistry, ωB97X-D includes dispersion.`,
  },
  {
    key: `basis`, label: 'workflow.node_basis_set_label', type: `select`, default: `6-31G(d)`, group: 'workflow.node_group_method',
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
    key: `charge`, label: 'workflow.node_charge_label', type: `number`, default: 0, group: 'workflow.node_group_system',
    help: 'workflow.node_charge_help',
  },
  {
    key: `multiplicity`, label: 'workflow.node_multiplicity_label', type: `number`, default: 1, group: 'workflow.node_group_system',
    min: 1, max: 12, step: 1,
    help: 'workflow.node_multiplicity_help',
  },
  {
    key: `solvent`, label: 'workflow.node_solvent_model_label', type: `select`, default: `none`, group: 'workflow.node_group_environment',
    options: [
      { label: `None (gas phase)`, value: `none` },
      { label: `PCM (water)`, value: `SCRF=(PCM,Solvent=Water)` },
      { label: `SMD (water)`, value: `SCRF=(SMD,Solvent=Water)` },
      { label: `PCM (DMSO)`, value: `SCRF=(PCM,Solvent=DMSO)` },
    ],
    help: 'workflow.node_solvent_model_help',
  },
  {
    key: `dispersion`, label: 'workflow.node_dispersion_label', type: `select`, default: `none`, group: 'workflow.node_group_method',
    options: [
      { label: 'workflow.node_none', value: `none` },
      { label: `GD3BJ (recommended)`, value: `GD3BJ` },
      { label: `GD3`, value: `GD3` },
    ],
    help: `Empirical dispersion correction. GD3BJ recommended for non-covalent interactions.`,
  },
]


// ====================================================================
//  NODE DEFINITIONS — organized by task type (not software)
// ====================================================================

export const NODE_DEFINITIONS: Record<string, NodeDefinition> = {
  // === Input ===
  structure_input: {
    type: `structure_input`,
    get label() { return t('workflow.node_structure_input_label') },
    color: `#64748b`,
    icon: `\u{1F4C2}`,
    category: `Input`,
    get description() { return t('workflow.node_structure_input_description') },
    inputs: [],
    outputs: [`structure`],
    default_params: {},
    get help_text() { return t('workflow.node_structure_input_help') },
    param_schema: [],
  },

  // ================================================================
  //  UNIFIED CALCULATION NODES
  // ================================================================

  // ─── Geometry Optimization ───
  geo_opt: {
    type: `geo_opt`,
    get label() { return t('workflow.node_geometry_optimization_label') },
    color: `#3b82f6`,
    icon: `\u26A1`,
    category: `Calculation`,
    get description() { return t('workflow.node_geometry_optimization_description') },
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: { system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 2, NSW: 200, kpoints: `4×4×4` },
    get help_text() { return t('workflow.node_geometry_optimization_help') },
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: 'workflow.node_group_software', type: `select`, default: `vasp`, group: 'workflow.node_group_software',
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
    ],
  },

  // ─── Single Point ───
  single_point: {
    type: `single_point`,
    get label() { return t('workflow.node_single_point_label') },
    color: `#6366f1`,
    icon: `\u{1F52C}`,
    category: `Calculation`,
    get description() { return t('workflow.node_single_point_description') },
    inputs: [`structure`],
    outputs: [`energy`, `dos`, `band`],
    default_params: { system_type: `periodic`, software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISMEAR: -5, LORBIT: 11 },
    get help_text() { return t('workflow.node_single_point_help') },
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: 'workflow.node_group_software', type: `select`, default: `vasp`, group: 'workflow.node_group_software',
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
          { label: `ORCA`, value: `orca` },
          { label: `Gaussian`, value: `gaussian` },
          { label: `xTB`, value: `xtb` },
          { label: `ML Potential`, value: `mlp` },
        ],
        help: `Calculation engine to use. Options are filtered by system type.`,
      },
      // ── MLP single-point params ──
      ...mlp_only([
        ...MLP_COMMON_PARAMS,
      ]),
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
    get label() { return t('workflow.node_cell_optimization_label') },
    color: `#0f766e`,
    icon: `\u{1F4D0}`,
    category: `Calculation`,
    get description() { return t('workflow.node_cell_optimization_description') },
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: { software: `vasp`, ENCUT: 520, EDIFF: `1e-6`, ISIF: 3, kpoints: `9×9×9` },
    get help_text() { return t('workflow.node_cell_optimization_help') },
    param_schema: [
      {
        key: `software`, label: 'workflow.node_group_software', type: `select`, default: `vasp`, group: 'workflow.node_group_software',
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
    get label() { return t('workflow.node_molecular_dynamics_label') },
    color: `#8b5cf6`,
    icon: `\u{1F321}\uFE0F`,
    category: `Calculation`,
    get description() { return t('workflow.node_molecular_dynamics_description') },
    inputs: [`structure`, `restart`],
    outputs: [`trajectory`, `energy`, `log`, `restart`],
    default_params: { system_type: `periodic`, software: `vasp`, TEBEG: 300, NSW: 5000, POTIM: 1.0, SMASS: 0 },
    get help_text() { return t('workflow.node_molecular_dynamics_help') },
    param_schema: [
      SYSTEM_TYPE_PARAM,
      {
        key: `software`, label: 'workflow.node_group_software', type: `select`, default: `vasp`, group: 'workflow.node_group_software',
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
          key: `potential_type`, label: `Potential Type`, type: `select`, default: `forcefield`, group: `Potential`,
          options: [
            { label: `Force Field (GAFF2/OPLS-AA)`, value: `forcefield` },
            { label: `Custom (manual input)`, value: `custom` },
          ],
          help: `Force Field: auto-assigns pair/bond/angle from the selected FF. Custom: enter all potential parameters manually.`,
        },
        // ── Force Field Options (shown when potential_type = forcefield) ──
        {
          key: `forcefield`, label: `Force Field`, type: `select`, default: `gaff2`, group: `Force Field`,
          options: [
            { label: `GAFF2 (organic molecules)`, value: `gaff2` },
            { label: `GAFF (older version)`, value: `gaff` },
            { label: `OPLS-AA`, value: `oplsaa` },
            { label: `COMPASS`, value: `compass` },
          ],
          show_if: { key: `potential_type`, values: [`forcefield`] },
          help: `Force field type. GAFF2 recommended for organic molecules.`,
        },
        {
          key: `charge_method`, label: `Charge Method`, type: `select`, default: `gasteiger`, group: `Force Field`,
          options: [
            { label: `Gasteiger (fast)`, value: `gasteiger` },
            { label: `AM1-BCC (accurate, slow)`, value: `am1bcc` },
            { label: `Zero (testing)`, value: `zero` },
          ],
          show_if: { key: `potential_type`, values: [`forcefield`] },
          help: `Partial charge calculation method. Gasteiger is fast; AM1-BCC requires AmberTools.`,
        },
        {
          key: `solvate`, label: `Add Solvent`, type: `checkbox`, default: false, group: `Solvation`,
          show_if: { key: `potential_type`, values: [`forcefield`] },
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
        // ── Custom Pair Style (shown when potential_type = custom) ──
        {
          key: `pair_style`, label: `Pair Style`, type: `text`, default: `lj/cut 2.5`, group: `Custom Potential`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `LAMMPS pair_style with args (e.g. lj/cut 2.5, eam/alloy, tersoff).`,
        },
        {
          key: `pair_coeff`, label: `Pair Coefficients`, type: `text`, default: `* * 1.0 1.0`, group: `Custom Potential`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `pair_coeff lines, one per line. Format depends on pair_style.`,
        },
        {
          key: `bond_style`, label: `Bond Style`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `LAMMPS bond_style command (e.g. harmonic, fene, class2). Leave blank if not applicable.`,
        },
        {
          key: `bond_coeff`, label: `Bond Coefficients`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `bond_coeff lines, one per line (e.g. 1 350.0 1.54).`,
        },
        {
          key: `angle_style`, label: `Angle Style`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `LAMMPS angle_style command (e.g. harmonic, class2). Leave blank if not applicable.`,
        },
        {
          key: `angle_coeff`, label: `Angle Coefficients`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `angle_coeff lines, one per line (e.g. 1 60.0 109.5).`,
        },
        {
          key: `dihedral_style`, label: `Dihedral Style`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `LAMMPS dihedral_style command (e.g. opls, harmonic, charmm). Leave blank if not applicable.`,
        },
        {
          key: `dihedral_coeff`, label: `Dihedral Coefficients`, type: `text`, default: ``, group: `Molecular Interactions`,
          show_if: { key: `potential_type`, values: [`custom`] },
          help: `dihedral_coeff lines, one per line.`,
        },
        {
          key: `extra_commands`, label: `Extra Commands`, type: `text`, default: ``, group: `Extra`,
          help: `Additional LAMMPS commands inserted after the potential block (one per line). Available in both Force Field and Manual paths.`,
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
          min: 0.00001, max: 100, step: 0.005,
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

  // ─── MD Minimize ───
  md_minimize: MD_MINIMIZE_NODE,

  // ─── Adsorbate placement (migrated to node-defs/) ───
  // Source: src/lib/workflow/node-defs/utility/adsorbate-place.ts.
  // The schema (species enum, site enum) is built at module-load time from
  // server/data/adsorbates.json so it stays in sync with the workflow
  // engine + MCP `list_presets`.
  adsorbate_place,

  // ─── UV-Vis Spectroscopy ───
  uvvis: UVVIS_NODE,

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
        key: `software`, label: 'workflow.node_group_software', type: `select`, default: `vasp`, group: 'workflow.node_group_software',
        options: [
          { label: `VASP`, value: `vasp` },
          { label: `CP2K`, value: `cp2k` },
          { label: `ORCA`, value: `orca` },
          { label: `Gaussian`, value: `gaussian` },
          { label: `ML Potential`, value: `mlp` },
        ],
        help: `Calculation engine to use. Options are filtered by system type.`,
      },
      // ── MLP freq params ──
      ...mlp_only([
        ...MLP_COMMON_PARAMS,
        {
          key: `delta`, label: `Displacement (Å)`, type: `number`, default: 0.01, group: `Vibrations`,
          min: 0.001, max: 0.1, step: 0.005,
          help: `Finite difference displacement in Å. Default 0.01 Å.`,
        },
        {
          key: `nfree`, label: `Stencil Points`, type: `select`, default: 2, group: `Vibrations`,
          options: [
            { label: `2 — Central differences (±)`, value: 2 },
            { label: `4 — Four-point stencil`, value: 4 },
          ],
          help: `Number of displacement points per direction. 2=central differences (default).`,
        },
        {
          key: `freeze_mode`, label: `Freeze Mode`, type: `select`, default: `none`, group: `Freeze Atoms`,
          options: [
            { label: `None (all atoms vibrate)`, value: `none` },
            { label: `By Element`, value: `element` },
            { label: `By z-coordinate`, value: `z_range` },
            { label: `Bottom N Layers`, value: `layers` },
            { label: `By Atom Index`, value: `indices` },
          ],
          help: `Select which atoms to freeze (not displace) during frequency calculation. For surfaces, freeze bulk atoms so only adsorbate + top layer vibrate.`,
        },
        {
          key: `freeze_z_below`, label: `Freeze z below (Å)`, type: `number`, default: 0, group: `Freeze Atoms`,
          min: 0, max: 100, step: 0.1,
          show_if: { key: `freeze_mode`, values: [`z_range`] },
          help: `Freeze all atoms with z-coordinate below this value.`,
        },
        {
          key: `freeze_elements`, label: `Freeze Elements`, type: `string`, default: ``, group: `Freeze Atoms`,
          show_if: { key: `freeze_mode`, values: [`element`] },
          help: `Comma-separated element symbols to freeze, e.g. "Ni,O".`,
        },
        {
          key: `freeze_indices`, label: `Frozen Atom Indices`, type: `string`, default: ``, group: `Freeze Atoms`,
          show_if: { key: `freeze_mode`, values: [`indices`] },
          help: `Comma-separated atom indices to freeze (0-based), e.g. "0-31".`,
        },
        {
          key: `freeze_layers`, label: `Freeze Bottom Layers`, type: `number`, default: 0, group: `Freeze Atoms`,
          min: 0, max: 20, step: 1,
          show_if: { key: `freeze_mode`, values: [`layers`] },
          help: `Number of bottom atomic layers to freeze.`,
        },
        {
          key: `freeze_invert`, label: `Invert Selection`, type: `boolean`, default: false, group: `Freeze Atoms`,
          show_if: { key: `freeze_mode`, values: [`z_range`, `element`, `indices`, `layers`] },
          help: `Invert: freeze everything EXCEPT the selected atoms (only selected atoms vibrate).`,
        },
      ]),
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
    default_params: { system_type: `molecular`, software: `sella`, calculator: `xtb`, calculator_method: `GFN2-xTB`, fmax: 0.01, order: 1 },
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
          { label: `MLP NEB (MACE/CHGNet)`, value: `mlp` },
        ],
      },
      // ── MLP NEB params ──
      ...mlp_only([
        ...MLP_COMMON_PARAMS,
        {
          key: `nimages`, label: `NEB Images`, type: `number`, default: 8, group: `NEB`,
          min: 3, max: 20, step: 1,
          help: `Number of intermediate images along the reaction path.`,
        },
        {
          key: `fmax`, label: `Force Convergence (eV/Å)`, type: `number`, default: 0.05, group: `NEB`,
          min: 0.01, max: 0.5, step: 0.01,
          help: `Max force criterion for NEB convergence.`,
        },
        {
          key: `max_steps`, label: `Max Steps`, type: `number`, default: 500, group: `NEB`,
          min: 50, max: 5000, step: 50,
          help: `Maximum NEB optimization steps.`,
        },
        {
          key: `climb`, label: `Climbing Image`, type: `boolean`, default: true, group: `NEB`,
          help: `Enable climbing image NEB to refine the transition state.`,
        },
        {
          key: `mlp_optimizer`, label: `Optimizer`, type: `select`, default: `FIRE`, group: `NEB`,
          options: [
            { label: `FIRE`, value: `FIRE` },
            { label: `LBFGS`, value: `LBFGS` },
          ],
          help: `Optimizer for NEB path relaxation. FIRE is robust for NEB.`,
        },
      ]),
      // ── Sella params ──
      ...sella_show([
        {
          key: `calculator`, label: `Calculator`, type: `select`, default: `xtb`, group: `Calculator`,
          options: [
            { label: `VASP (DFT, highest accuracy)`, value: `vasp` },
            { label: `ORCA (quantum chemistry)`, value: `orca` },
            { label: `xTB (fast, semi-empirical)`, value: `xtb` },
            { label: `MACE-MP`, value: `mace` },
            { label: `CHGNet`, value: `chgnet` },
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
            { label: `PBEh-3c (composite, no basis needed)`, value: `PBEh-3c` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `DFT/HF method for ORCA. r2SCAN-3c/PBEh-3c are composite methods (basis auto-included).`,
        },
        {
          key: `orca_basis`, label: `Basis Set`, type: `select`, default: `6-31G*`, group: `ORCA Calculator`,
          show_if: { key: `calculator`, values: [`orca`] },
          options: [
            { label: `(none — composite method)`, value: `` },
            { label: `STO-3G`, value: `STO-3G` },
            { label: `6-31G`, value: `6-31G` },
            { label: `6-31G*`, value: `6-31G*` },
            { label: `def2-SVP`, value: `def2-SVP` },
            { label: `def2-TZVP`, value: `def2-TZVP` },
            { label: `cc-pVDZ`, value: `cc-pVDZ` },
            { label: `cc-pVTZ`, value: `cc-pVTZ` },
          ],
          help: `Not used for composite methods like r2SCAN-3c/PBEh-3c.`,
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
            { label: `PBEh-3c`, value: `PBEh-3c` },
            { label: `B2PLYP`, value: `B2PLYP` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
        },
        {
          key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
          options: [
            { label: `(none — composite method)`, value: `` },
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
          help: `Basis set. def2 family recommended for ORCA. def2-SVP for screening, def2-TZVP for production.`,
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
          key: `dispersion`, label: `Dispersion`, type: `select`, default: `none`, group: `SCF`,
          options: [
            { label: `None`, value: `none` },
            { label: `D2`, value: `D2` },
            { label: `D3 (BJ damping)`, value: `D3` },
            { label: `D3BJ (recommended)`, value: `D3BJ` },
            { label: `D3ZERO (zero damping)`, value: `D3ZERO` },
            { label: `D30 (= D3ZERO)`, value: `D30` },
            { label: `D3TZ (triple-ζ params, D3ZERO only)`, value: `D3TZ` },
            { label: `D4 (BJ + ATM, newer)`, value: `D4` },
            { label: `NOVDW (disable D corrections)`, value: `NOVDW` },
          ],
          help: `ORCA simple-input dispersion keyword. D3BJ is the typical default for DFT functionals; D4 is newer and BJ-damped by default. NOVDW explicitly disables dispersion. See ORCA manual §3.4.1.`,
        },
        {
          key: `three_body_dispersion`, label: `Three-body term (ABC/ATM)`, type: `boolean`, default: false, group: `SCF`,
          show_if: { key: `dispersion`, values: [`D2`, `D3`, `D3BJ`, `D3ZERO`, `D30`, `D3TZ`] },
          help: `Adds the three-body Axilrod-Teller-Muto (ATM) term to the route line as 'ABC'. Only relevant for D3 variants — D4 already includes ATM by default.`,
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
          key: `num_cores`, label: `CPU Cores`, type: `number`, default: 4, group: `Parallelization`,
          min: 1, max: 256, step: 1,
          help: `Number of CPU cores for ORCA parallel execution.`,
        },
        {
          key: `max_core_mb`, label: `Memory per Core (MB)`, type: `number`, default: 4000, group: `Parallelization`,
          min: 256, max: 64000, step: 256,
          help: `Maximum memory per core in MB.`,
        },
        {
          key: `nimages`, label: `Number of Images`, type: `number`, default: 8, group: `NEB`, min: 4, max: 20,
          help: `NEB images between reactant/product. 8-12 typical; more=smoother path.`,
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
            { label: `PBEh-3c`, value: `PBEh-3c` },
            { label: `B2PLYP`, value: `B2PLYP` },
            { label: `CCSD`, value: `CCSD` },
            { label: `MP2`, value: `MP2` },
          ],
          help: `Quantum chemistry method. r2SCAN-3c recommended for speed.`,
        },
        {
          key: `basis`, label: `Basis Set`, type: `select`, default: `6-31G`, group: `Quantum`,
          options: [
            { label: `(none — composite method)`, value: `` },
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
          help: `Basis set. def2 family recommended for ORCA. def2-SVP for screening, def2-TZVP for production.`,
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
          key: `dispersion`, label: `Dispersion`, type: `select`, default: `none`, group: `SCF`,
          options: [
            { label: `None`, value: `none` },
            { label: `D2`, value: `D2` },
            { label: `D3 (BJ damping)`, value: `D3` },
            { label: `D3BJ (recommended)`, value: `D3BJ` },
            { label: `D3ZERO (zero damping)`, value: `D3ZERO` },
            { label: `D30 (= D3ZERO)`, value: `D30` },
            { label: `D3TZ (triple-ζ params, D3ZERO only)`, value: `D3TZ` },
            { label: `D4 (BJ + ATM, newer)`, value: `D4` },
            { label: `NOVDW (disable D corrections)`, value: `NOVDW` },
          ],
          help: `ORCA simple-input dispersion keyword. D3BJ is the typical default for DFT functionals; D4 is newer and BJ-damped by default. NOVDW explicitly disables dispersion. See ORCA manual §3.4.1.`,
        },
        {
          key: `three_body_dispersion`, label: `Three-body term (ABC/ATM)`, type: `boolean`, default: false, group: `SCF`,
          show_if: { key: `dispersion`, values: [`D2`, `D3`, `D3BJ`, `D3ZERO`, `D30`, `D3TZ`] },
          help: `Adds the three-body Axilrod-Teller-Muto (ATM) term to the route line as 'ABC'. Only relevant for D3 variants — D4 already includes ATM by default.`,
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
          key: `num_cores`, label: `CPU Cores`, type: `number`, default: 4, group: `Parallelization`,
          min: 1, max: 256, step: 1,
          help: `Number of CPU cores for ORCA parallel execution.`,
        },
        {
          key: `max_core_mb`, label: `Memory per Core (MB)`, type: `number`, default: 4000, group: `Parallelization`,
          min: 256, max: 64000, step: 256,
          help: `Maximum memory per core in MB.`,
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

  // ================================================================
  //  TOOLS
  // ================================================================

  slab_gen: {
    type: `slab_gen`,
    label: `Slab Gen`,
    color: `#0e7490`,
    icon: `\u{1F52A}`,
    category: `Tools`,
    description: `Cut surface slab from bulk`,
    inputs: [`structure`],
    outputs: [`structure`],
    default_params: { miller: `1,1,1`, layers: 4, vacuum: 15.0, supercell: `2×2` },
    help_text: `**Slab Generator** — Cut a surface from the optimized bulk.

Creates a surface slab by selecting Miller indices, number of layers, and vacuum thickness.`,
    param_schema: [
      {
        key: `miller`, label: `Miller Indices`, type: `string`, default: `1,1,1`, group: `Slab`,
        help: `Surface orientation (h,k,l). Examples: 1,1,1 for FCC(111), 1,0,0 for (100).`,
      },
      {
        key: `layers`, label: `Number of Layers`, type: `number`, default: 4, group: `Slab`,
        min: 2, max: 12, step: 1,
      },
      {
        key: `vacuum`, label: `Vacuum (Å)`, type: `number`, default: 15.0, group: `Slab`,
        min: 10, max: 30, step: 1,
      },
      {
        key: `supercell`, label: `Supercell`, type: `string`, default: `2×2`, group: `Slab`,
        help: `Lateral supercell expansion. Format: NxM (e.g., 2×2, 3×3).`,
      },
    ],
  },

  batch_slab_gen: {
    type: `batch_slab_gen`,
    label: `Batch Slab Gen`,
    color: `#0ea5e9`,
    icon: `\u{1F4CA}`,
    category: `Tools`,
    description: `Generate multiple slabs from one bulk with different (miller, layers) combinations`,
    inputs: [`structure`],
    outputs: [`structures`],
    is_fan_out: true,
    default_params: {
      combinations: `[[1,1,1,4],[1,1,1,6],[1,1,1,8],[1,0,0,4],[1,0,0,6],[1,0,0,8],[1,1,0,4],[1,1,0,6],[1,1,0,8],[2,1,1,4],[2,1,1,6],[2,1,1,8]]`,
      vacuum: 15.0, supercell_a: 1, supercell_b: 1, center_slab: true,
    },
    help_text: `**Batch Slab Gen** \u2014 Generate multiple slabs from a single bulk structure for surface energy screening.

Each combination is **[h, k, l, layers]** or **[h, k, l, layers, vacuum]**.

Default: 4 facets (111, 100, 110, 211) \u00D7 3 thicknesses (4, 6, 8 layers) = 12 slabs.`,
    param_schema: [
      {
        key: `combinations`, label: `Slab Combinations`, type: `text`,
        default: `[[1,1,1,4],[1,1,1,6],[1,1,1,8],[1,0,0,4],[1,0,0,6],[1,0,0,8],[1,1,0,4],[1,1,0,6],[1,1,0,8],[2,1,1,4],[2,1,1,6],[2,1,1,8]]`,
        group: `Slabs`,
        help: `JSON array of [h, k, l, layers] tuples. Each generates one slab.`,
      },
      { key: `vacuum`, label: `Default Vacuum (\u00C5)`, type: `number`, default: 15.0, group: `Slabs`, min: 5, max: 50, step: 1 },
      { key: `supercell_a`, label: `Supercell a`, type: `number`, default: 1, group: `Supercell`, min: 1, max: 6, step: 1 },
      { key: `supercell_b`, label: `Supercell b`, type: `number`, default: 1, group: `Supercell`, min: 1, max: 6, step: 1 },
      { key: `center_slab`, label: `Center Slab`, type: `boolean`, default: true, group: `Supercell` },
    ],
  },

  batch_coverage_gen: {
    type: `batch_coverage_gen`,
    label: `Coverage Sweep`,
    color: `#06b6d4`,
    icon: `\u{1F4CA}`,
    category: `Tools`,
    description: `Generate slab+adsorbate structures at different coverages for coverage-dependent adsorption studies`,
    inputs: [`structure`],
    outputs: [`structures`],
    is_fan_out: true,
    default_params: {
      species: `H`, coverages: `[1, 2, 4, 8, 16]`, site: `hollow`, n_surface_sites: 16, height: 1.0,
    },
    help_text: `**Coverage Sweep** — Generate multiple slab+adsorbate structures at varying coverages.

Each coverage count places N adsorbate atoms on the slab surface. The downstream Geo Opt node
relaxes each configuration, and Coverage Analysis computes E_ads/adsorbate vs coverage (\u03B8).

**Workflow:** batch_coverage_gen \u2192 Geo Opt (batch) \u2192 Coverage Analysis`,
    param_schema: [
      { key: `species`, label: `Adsorbate Species`, type: `string`, default: `H`, group: `Adsorbate`,
        help: `Element or molecule to place (H, OH, O, CO, etc.)` },
      { key: `coverages`, label: `Adsorbate Counts`, type: `text`, default: `[1, 2, 4, 8, 16]`, group: `Coverage`,
        help: `JSON array of adsorbate counts to test. Each generates one slab+nX structure.` },
      { key: `site`, label: `Site Type`, type: `select`, default: `hollow`, group: `Coverage`,
        options: [
          { label: `Hollow (FCC/HCP)`, value: `hollow` },
          { label: `On-top`, value: `ontop` },
          { label: `Bridge`, value: `bridge` },
        ],
        help: `Preferred adsorption site type.` },
      { key: `n_surface_sites`, label: `Surface Sites per Cell`, type: `number`, default: 16, group: `Coverage`,
        min: 1, max: 100, step: 1,
        help: `Total number of surface adsorption sites. Used to compute coverage \u03B8 = n_ads / n_sites.` },
      { key: `height`, label: `Height (\u00C5)`, type: `number`, default: 1.0, group: `Adsorbate`,
        min: 0.5, max: 4.0, step: 0.1,
        help: `Height of adsorbate above the surface site.` },
    ],
  },

  doping_gen: {
    type: `doping_gen`,
    label: `Doping Gen`,
    color: `#059669`,
    icon: `\u{1F9EA}`,
    category: `Tools`,
    description: `Generate doped surface variants`,
    inputs: [`structure`],
    outputs: [`structure`],
    default_params: { dopant: `Fe`, count: 1, target_element: ``, site_strategy: `symmetry` },
    help_text: `**Doping Generator** — Create substitutionally doped surface variants.

Replaces surface atoms with dopant elements. Supports symmetry-aware deduplication to avoid redundant calculations.`,
    param_schema: [
      {
        key: `dopant`, label: `Dopant Element`, type: `string`, default: `Fe`, group: `Doping`,
        help: `Element to substitute. Comma-separated for multiple dopants (e.g., Fe,Co,Ni).`,
      },
      {
        key: `target_element`, label: `Target Element`, type: `string`, default: ``, group: `Doping`,
        help: `Element to replace. Leave empty to auto-detect surface metal.`,
      },
      {
        key: `count`, label: `Substitutions`, type: `number`, default: 1, group: `Doping`,
        min: 1, max: 4, step: 1,
        help: `Number of atoms to replace per candidate.`,
      },
      {
        key: `site_strategy`, label: `Site Selection`, type: `select`, default: `symmetry`, group: `Doping`,
        options: [
          { label: `Symmetry-unique sites`, value: `symmetry` },
          { label: `Surface layer only`, value: `surface` },
          { label: `All sites`, value: `all` },
        ],
      },
      {
        key: `deduplicate`, label: `Deduplicate`, type: `boolean`, default: true, group: `Doping`,
        help: `Remove symmetry-equivalent doped structures.`,
      },
    ],
  },

  polymer_build: {
    type: `polymer_build`,
    label: `Polymer Build`,
    color: `#f97316`,
    icon: `\u{1F9F6}`,
    category: `Tools`,
    description: `Build polymer chain structure`,
    inputs: [],
    outputs: [`structure`],
    default_params: {
      polymer_type: `PE`,
      chain_length: 100,
      tacticity: `atactic`,
      force_field: `opls`,
      density: 0.85,
    },
    help_text: `**Polymer Chain Builder** — Generate polymer chains for MD simulation.`,
    param_schema: [
      {
        key: `polymer_type`, label: `Polymer Type`, type: `select`, default: `PE`, group: `Polymer`,
        options: [
          { label: `Polyethylene (PE)`, value: `PE` },
          { label: `Polypropylene (PP)`, value: `PP` },
          { label: `Polystyrene (PS)`, value: `PS` },
          { label: `PMMA`, value: `PMMA` },
          { label: `PET`, value: `PET` },
          { label: `Nylon-6 (PA6)`, value: `PA6` },
        ],
      },
      {
        key: `chain_length`, label: `Chain Length`, type: `number`, default: 100, group: `Polymer`,
        min: 10, max: 10000, step: 10,
      },
      {
        key: `tacticity`, label: `Tacticity`, type: `select`, default: `atactic`, group: `Polymer`,
        options: [
          { label: `Isotactic`, value: `isotactic` },
          { label: `Syndiotactic`, value: `syndiotactic` },
          { label: `Atactic`, value: `atactic` },
        ],
      },
      {
        key: `force_field`, label: `Force Field`, type: `select`, default: `opls`, group: `Force Field`,
        options: [
          { label: `OPLS-AA`, value: `opls` },
          { label: `PCFF`, value: `pcff` },
          { label: `COMPASS`, value: `compass` },
          { label: `Dreiding`, value: `dreiding` },
          { label: `traPPE-UA`, value: `trappe` },
        ],
      },
      {
        key: `density`, label: `Target Density (g/cm³)`, type: `number`, default: 0.85, group: `Packing`,
        min: 0.1, max: 2.0, step: 0.05,
      },
      {
        key: `n_chains`, label: `Number of Chains`, type: `number`, default: 1, group: `Packing`,
        min: 1, max: 100, step: 1,
      },
      {
        key: `seed`, label: `Random Seed`, type: `number`, default: 42, group: `Advanced`,
        min: 1, max: 999999, step: 1,
      },
    ],
  },

  polymer_crosslink: {
    type: `polymer_crosslink`,
    label: `Crosslink`,
    color: `#ea580c`,
    icon: `\u{1F5E9}`,
    category: `Tools`,
    description: `Create crosslinked polymer network`,
    inputs: [`structure`],
    outputs: [`structure`],
    default_params: {
      crosslinker_type: `sulfur`,
      crosslink_density: 0.05,
      min_distance: 4.0,
      max_distance: 6.0,
    },
    help_text: `**Polymer Crosslinking** — Create covalent crosslinks between polymer chains.`,
    param_schema: [
      {
        key: `crosslinker_type`, label: `Crosslinker Type`, type: `select`, default: `sulfur`, group: `Crosslink`,
        options: [
          { label: `Sulfur (vulcanization)`, value: `sulfur` },
          { label: `Peroxide`, value: `peroxide` },
          { label: `Radiation`, value: `radiation` },
          { label: `Epoxy-amine`, value: `epoxy` },
        ],
      },
      {
        key: `crosslink_density`, label: `Crosslink Density`, type: `number`, default: 0.05, group: `Crosslink`,
        min: 0.0, max: 1.0, step: 0.01,
      },
      {
        key: `min_distance`, label: `Min Distance (Å)`, type: `number`, default: 4.0, group: `Geometry`,
        min: 2.0, max: 10.0, step: 0.5,
      },
      {
        key: `max_distance`, label: `Max Distance (Å)`, type: `number`, default: 6.0, group: `Geometry`,
        min: 3.0, max: 15.0, step: 0.5,
      },
      {
        key: `target_atoms`, label: `Target Elements`, type: `text`, default: `C,H`, group: `Selection`,
        help: `Comma-separated elements to crosslink (e.g., 'C,H,S')`,
      },
    ],
  },

  reference_mol: {
    type: `reference_mol`,
    label: `Ref Molecule`,
    color: `#475569`,
    icon: `\u2697\uFE0F`,
    category: `Tools`,
    description: `Gas-phase reference molecule energy`,
    inputs: [],
    outputs: [`energy`, `frequencies`],
    default_params: { molecules: `N2,H2,NH3`, box_size: 20.0 },
    help_text: `**Reference Molecule** — Gas-phase energy for thermodynamics.

Calculates the total energy of isolated gas-phase molecules in a large box.`,
    param_schema: [
      {
        key: `molecules`, label: `Molecules`, type: `string`, default: `N2,H2,NH3`, group: `Input`,
        help: `Comma-separated list of molecules to calculate.`,
      },
      {
        key: `box_size`, label: `Box Size (Å)`, type: `number`, default: 20.0, group: `Input`,
        min: 15.0, max: 30.0, step: 1.0,
      },
    ],
  },

  // ================================================================
  //  SPECIALIZED
  // ================================================================

  polymer_md: {
    type: `polymer_md`,
    label: `Polymer MD`,
    color: `#b91c1c`,
    icon: `\u{1F9EA}`,
    category: `Tools`,
    description: `Multi-stage polymer MD workflow (Kremer-Grest)`,
    inputs: [`structure`, `restart`],
    outputs: [`trajectory`, `log`, `restart`],
    default_params: {
      execution_mode: `local`,
      workflow_mode: `polymer_kg`,
      pair_style: `lj/cut 2.5`,
      pair_coeff: `* * 1.0 1.0`,
      bond_style: `fene`,
      bond_coeff: `1 30.0 1.5 1.0 1.0`,
      temperature: 298.15,
      pressure: 1.0,
      timestep: 0.005,
      gen_steps_nvt: 5000,
      gen_steps_npt: 50000,
      equil_steps: 100000,
      prod_steps: 100000,
      prod_dump_freq: 1000,
    },
    help_text: `**Polymer MD** — Multi-stage molecular dynamics for polymer systems.

Runs a complete polymer MD workflow using LAMMPS with multiple sequential stages.`,
    param_schema: [
      {
        key: `workflow_mode`, label: `Workflow Mode`, type: `select`, default: `polymer_kg`, group: `Workflow`,
        options: [
          { label: `Kremer-Grest (bead-spring)`, value: `polymer_kg` },
          { label: `All-Atom Polymer`, value: `all_atom` },
          { label: `Custom Multi-Stage`, value: `custom` },
        ],
      },
      {
        key: `execution_mode`, label: `Execution Mode`, type: `select`, default: `local`, group: `Execution`,
        options: [
          { label: `Local (fast, small systems)`, value: `local` },
          { label: `HPC Cluster (production)`, value: `hpc` },
        ],
      },
      {
        key: `lmp_command`, label: `LAMMPS Command`, type: `text`, default: `lmp_serial`, group: `Execution`,
      },
      {
        key: `pair_style`, label: `Pair Style`, type: `select`, default: `lj/cut 2.5`, group: `Potential`,
        options: [
          { label: `Lennard-Jones (lj/cut)`, value: `lj/cut 2.5` },
          { label: `OPLS-AA (opls)`, value: `opls` },
          { label: `PCFF (pcff)`, value: `pcff` },
          { label: `COMPASS (class2)`, value: `class2` },
        ],
      },
      {
        key: `pair_coeff`, label: `Pair Coefficients`, type: `text`, default: `* * 1.0 1.0`, group: `Potential`,
      },
      {
        key: `bond_style`, label: `Bond Style`, type: `select`, default: `fene`, group: `Potential`,
        options: [
          { label: `FENE (Kremer-Grest)`, value: `fene` },
          { label: `Harmonic`, value: `harmonic` },
          { label: `Class2`, value: `class2` },
        ],
      },
      {
        key: `bond_coeff`, label: `Bond Coefficients`, type: `text`, default: `1 30.0 1.5 1.0 1.0`, group: `Potential`,
      },
      {
        key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
        min: 1, max: 10000, step: 10,
      },
      {
        key: `pressure`, label: `Pressure (atm)`, type: `number`, default: 1.0, group: `MD`,
        min: 0, max: 1000, step: 0.1,
      },
      {
        key: `timestep`, label: `Timestep (ps)`, type: `number`, default: 0.001, group: `MD`,
        min: 0.0001, max: 0.01, step: 0.0005,
      },
      {
        key: `gen_steps_nvt`, label: `Generation NVT Steps`, type: `number`, default: 5000, group: `Stages`,
        min: 1000, max: 100000, step: 1000,
      },
      {
        key: `gen_steps_npt`, label: `Generation NPT Steps`, type: `number`, default: 50000, group: `Stages`,
        min: 1000, max: 1000000, step: 10000,
      },
      {
        key: `equil_steps`, label: `Equilibration Steps`, type: `number`, default: 100000, group: `Stages`,
        min: 1000, max: 10000000, step: 10000,
      },
      {
        key: `prod_steps`, label: `Production Steps`, type: `number`, default: 100000, group: `Stages`,
        min: 1000, max: 10000000, step: 10000,
      },
      {
        key: `prod_dump_freq`, label: `Production Dump Freq`, type: `number`, default: 1000, group: `Output`,
        min: 100, max: 100000, step: 100,
      },
      {
        key: `write_restart`, label: `Write Restart File`, type: `boolean`, default: true, group: `Output`,
      },
    ],
  },

  glass_transition: {
    type: `glass_transition`,
    label: `Tg Calculation`,
    color: `#db2777`,
    icon: `\u{1F321}\u{1F4C8}`,
    category: `Tools`,
    description: `Calculate glass transition temperature`,
    inputs: [`structure`],
    outputs: [`tg`, `density_profile`],
    default_params: {
      temp_min: 100,
      temp_max: 500,
      temp_step: 20,
      cooling_rate: 1.0,
    },
    help_text: `**Glass Transition Temperature (Tg)** — Calculate via cooling simulation.`,
    param_schema: [
      {
        key: `temp_min`, label: `Min Temperature (K)`, type: `number`, default: 100, group: `Temperature`,
        min: 50, max: 300, step: 10,
      },
      {
        key: `temp_max`, label: `Max Temperature (K)`, type: `number`, default: 500, group: `Temperature`,
        min: 300, max: 1000, step: 10,
      },
      {
        key: `temp_step`, label: `Temperature Step (K)`, type: `number`, default: 20, group: `Temperature`,
        min: 5, max: 100, step: 5,
      },
      {
        key: `cooling_rate`, label: `Cooling Rate (K/ns)`, type: `number`, default: 1.0, group: `Temperature`,
        min: 0.1, max: 100, step: 0.1,
      },
      {
        key: `equil_steps`, label: `Equilibration Steps`, type: `number`, default: 10000, group: `MD`,
        min: 1000, max: 100000, step: 1000,
      },
      {
        key: `prod_steps`, label: `Production Steps`, type: `number`, default: 5000, group: `MD`,
        min: 500, max: 50000, step: 500,
      },
    ],
  },

  polymer_deform: {
    type: `polymer_deform`,
    label: `Polymer Deform`,
    color: `#c026d3`,
    icon: `\u21C4`,
    category: `Tools`,
    description: `Apply deformation to polymer (stress-strain)`,
    inputs: [`structure`],
    outputs: [`trajectory`, `stress_strain`],
    default_params: {
      deformation_type: `uniaxial`,
      strain_rate: 1e8,
      max_strain: 1.0,
      temperature: 300,
    },
    help_text: `**Polymer Deformation** — Apply mechanical deformation for stress-strain curves.`,
    param_schema: [
      {
        key: `deformation_type`, label: `Deformation Type`, type: `select`, default: `uniaxial`, group: `Deformation`,
        options: [
          { label: `Uniaxial (tension)`, value: `uniaxial` },
          { label: `Biaxial`, value: `biaxial` },
          { label: `Shear (xy)`, value: `shear_xy` },
          { label: `Shear (xz)`, value: `shear_xz` },
          { label: `Compression`, value: `compression` },
        ],
      },
      {
        key: `strain_rate`, label: `Strain Rate (1/s)`, type: `number`, default: 1e8, group: `Deformation`,
        min: 1e6, max: 1e10, step: 1e7,
      },
      {
        key: `max_strain`, label: `Max Strain`, type: `number`, default: 1.0, group: `Deformation`,
        min: 0.1, max: 5.0, step: 0.1,
      },
      {
        key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
        min: 100, max: 600, step: 10,
      },
      {
        key: `deform_axis`, label: `Deform Axis`, type: `select`, default: `x`, group: `Deformation`,
        options: [
          { label: `X-axis`, value: `x` },
          { label: `Y-axis`, value: `y` },
          { label: `Z-axis`, value: `z` },
        ],
      },
    ],
  },

  // ================================================================
  //  LOGIC
  // ================================================================

  condition: {
    type: `condition`,
    label: `Condition`,
    color: `#f59e0b`,
    icon: `\u25C7`,
    category: `Logic`,
    description: `Branch based on condition (convergence check, energy threshold)`,
    inputs: [`input_a`, `input_b`],
    outputs: [`true_out`, `false_out`],
    is_condition: true,
    default_params: { field: `energy_diff`, op: `<`, value: `0.01` },
    help_text: `**Condition Node** — Branching logic.

Evaluates a condition on the result of a parent step and routes the workflow.`,
    param_schema: [
      {
        key: `field`, label: `Field to Check`, type: `select`, default: `energy_diff`, group: `Condition`,
        options: [
          { label: `Energy Difference`, value: `energy_diff` },
          { label: `Max Force`, value: `max_force` },
          { label: `Convergence Flag`, value: `converged` },
          { label: `Number of Steps`, value: `n_steps` },
        ],
      },
      {
        key: `op`, label: `Operator`, type: `select`, default: `<`, group: `Condition`,
        options: [
          { label: `< (less than)`, value: `<` },
          { label: `> (greater than)`, value: `>` },
          { label: `== (equals)`, value: `==` },
          { label: `!= (not equals)`, value: `!=` },
        ],
      },
      { key: `value`, label: `Threshold`, type: `string`, default: `0.01`, group: `Condition` },
    ],
  },

  loop: {
    type: `loop`,
    label: `Loop`,
    color: `#f97316`,
    icon: `\u{1F501}`,
    category: `Logic`,
    description: `Iterate over multiple structures or conditions`,
    inputs: [`collection`],
    outputs: [`each_item`, `completed`],
    is_loop: true,
    default_params: { variable: `structure`, max_iter: 10 },
    help_text: `**Loop Node** — Iterate over a collection.`,
    param_schema: [
      {
        key: `variable`, label: `Loop Variable`, type: `select`, default: `structure`, group: `Loop`,
        options: [
          { label: `Structure`, value: `structure` },
          { label: `Parameter`, value: `parameter` },
        ],
      },
      {
        key: `max_iter`, label: `Max Iterations`, type: `number`, default: 10, group: `Loop`,
        min: 1, max: 100, step: 1,
      },
    ],
  },

  merge: {
    type: `merge`,
    label: `Merge / Barrier`,
    color: `#a855f7`,
    icon: `\u2B1B`,
    category: `Logic`,
    description: `Wait for all inputs before continuing`,
    inputs: [`input_a`, `input_b`, `input_c`],
    outputs: [`merged`],
    is_merge: true,
    default_params: {},
    help_text: `**Merge / Barrier Node** — Synchronization point. Waits for ALL connected inputs to complete.`,
    param_schema: [],
  },

  // ================================================================
  //  ANALYSIS
  // ================================================================

  dos_analysis: {
    type: `dos_analysis`,
    label: `DOS Analysis`,
    color: `#db2777`,
    icon: `\u{1F4CA}`,
    category: `Analysis`,
    description: `Density of states analysis from VASP output`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { source: `parent_step`, d_band: true },
    help_text: `**DOS Analysis** — Density of states post-processing.`,
    param_schema: [
      { key: `source`, label: `Data Source`, type: `select`, default: `parent_step`, group: `Analysis`,
        options: [
          { label: `From parent step output`, value: `parent_step` },
          { label: `From remote file`, value: `remote` },
        ],
      },
      { key: `d_band`, label: `Compute d-Band Center`, type: `boolean`, default: true, group: `Analysis` },
      { key: `atom_indices`, label: `Atom Indices`, type: `string`, default: ``, group: `Analysis`,
        help: `Comma-separated atom indices for PDOS (empty = all atoms).` },
    ],
  },

  cohp_analysis: {
    type: `cohp_analysis`,
    label: `COHP Analysis`,
    color: `#c026d3`,
    icon: `\u{1F517}`,
    category: `Analysis`,
    description: `Crystal Orbital Hamilton Population analysis`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { source: `parent_step` },
    help_text: `**COHP Analysis** — Chemical bonding analysis.`,
    param_schema: [
      { key: `source`, label: `Data Source`, type: `select`, default: `parent_step`, group: `Analysis`,
        options: [
          { label: `From parent step output`, value: `parent_step` },
          { label: `From remote file`, value: `remote` },
        ],
      },
      { key: `bond_pairs`, label: `Bond Pairs`, type: `string`, default: ``, group: `Analysis`,
        help: `Specific bond pairs to analyze (e.g., "Fe-N,Fe-O"). Empty = all pairs.` },
    ],
  },

  md_analysis: {
    type: `md_analysis`,
    label: `MD Analysis`,
    color: `#e879f9`,
    icon: `\u{1F4C8}`,
    category: `Analysis`,
    description: `Molecular dynamics trajectory analysis`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { analyses: `rmsd,rdf` },
    help_text: `**MD Trajectory Analysis** — Post-process molecular dynamics.`,
    param_schema: [
      { key: `analyses`, label: `Analysis Types`, type: `string`, default: `rmsd,rdf`, group: `Analysis`,
        help: `Comma-separated: rmsd, rdf, msd, density, hbonds, angles.` },
      { key: `skip_frames`, label: `Skip Initial Frames`, type: `number`, default: 0, group: `Analysis`,
        min: 0, max: 10000, step: 100 },
    ],
  },

  convergence_check: {
    type: `convergence_check`,
    label: `Convergence`,
    color: `#f472b6`,
    icon: `\u2705`,
    category: `Analysis`,
    description: `Check calculation convergence quality`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { check_type: `energy`, threshold: 1e-4 },
    help_text: `**Convergence Check** — Verify calculation quality.`,
    param_schema: [
      { key: `check_type`, label: `Check Type`, type: `select`, default: `energy`, group: `Convergence`,
        options: [
          { label: `Energy convergence`, value: `energy` },
          { label: `Force convergence`, value: `force` },
          { label: `Geometry convergence`, value: `geometry` },
        ],
      },
      { key: `threshold`, label: `Threshold`, type: `number`, default: 1e-4, group: `Convergence`,
        min: 1e-8, max: 1, step: 1e-4 },
    ],
  },

  energy_compare: {
    type: `energy_compare`,
    label: `Energy Compare`,
    color: `#f43f5e`,
    icon: `\u2696\uFE0F`,
    category: `Analysis`,
    description: `Compare energies between calculations`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { metric: `adsorption_energy` },
    help_text: `**Energy Comparison** — Compute derived energy quantities.`,
    param_schema: [
      { key: `metric`, label: `Energy Metric`, type: `select`, default: `adsorption_energy`, group: `Energy`,
        options: [
          { label: `Adsorption Energy`, value: `adsorption_energy` },
          { label: `Surface Energy`, value: `surface_energy` },
          { label: `Formation Energy`, value: `formation_energy` },
          { label: `Relative Stability`, value: `relative_stability` },
        ],
      },
    ],
  },

  charge_analysis: {
    type: `charge_analysis`,
    label: `Charge Analysis`,
    color: `#fb7185`,
    icon: `\u26A1`,
    category: `Analysis`,
    description: `Bader/DDEC charge analysis`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { method: `bader` },
    help_text: `**Charge Analysis** — Atomic charge decomposition.`,
    param_schema: [
      { key: `method`, label: `Charge Method`, type: `select`, default: `bader`, group: `Charge`,
        options: [
          { label: `Bader (QTAIM)`, value: `bader` },
          { label: `DDEC6`, value: `ddec6` },
        ],
      },
    ],
  },

  electronic: {
    type: `electronic`,
    label: `Electronic`,
    color: `#ec4899`,
    icon: `\u{1F52E}`,
    category: `Analysis`,
    description: `DOS, pCOHP, Bader charge analysis`,
    inputs: [`structure`],
    outputs: [`dos`, `cohp`, `charges`],
    default_params: { analysis: `dos,bader`, NEDOS: 3001 },
    help_text: `**Electronic Structure Analysis** — Run a static calculation with settings optimized for electronic analysis (DOS, Bader, pCOHP).`,
    param_schema: [
      ...INCAR_COMMON,
      {
        key: `analysis`, label: `Analysis Types`, type: `string`, default: `dos,bader`, group: `Analysis`,
        help: `Comma-separated: dos, bader, cohp.`,
      },
      {
        key: `NEDOS`, label: `DOS Points`, type: `number`, default: 3001, group: `INCAR`,
        min: 301, max: 10001, step: 500,
      },
      KPOINTS_PARAM,
      ...PARALLELIZATION_PARAMS,
    ],
  },

  free_energy: {
    type: `free_energy`,
    label: `Free Energy`,
    color: `#dc2626`,
    icon: `\u{1F4CA}`,
    category: `Analysis`,
    description: `Free energy diagram (ΔG)`,
    inputs: [`energies`, `frequencies`, `references`],
    outputs: [`diagram`],
    default_params: { temperature: 298.15, pathway: `distal`, potential: 0.0 },
    help_text: `**Free Energy Diagram** — Compute and plot ΔG along reaction path.`,
    param_schema: [
      {
        key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15, group: `Thermo`,
        min: 100, max: 1000, step: 10,
      },
      {
        key: `pathway`, label: `Reaction Pathway`, type: `select`, default: `distal`, group: `Thermo`,
        options: [
          { label: `Distal`, value: `distal` },
          { label: `Alternating`, value: `alternating` },
          { label: `Enzymatic`, value: `enzymatic` },
          { label: `Custom`, value: `custom` },
        ],
      },
      {
        key: `potential`, label: `Applied Potential (V vs RHE)`, type: `number`, default: 0.0, group: `Thermo`,
        min: -2.0, max: 2.0, step: 0.1,
      },
    ],
  },

  adsorption_energy: {
    type: `adsorption_energy`,
    label: `Adsorption Energy`,
    color: `#dc2626`,
    icon: `\u{1F9F2}`,
    category: `Analysis`,
    description: `Calculate adsorption energy from slab, slab+adsorbate, and reference energies`,
    inputs: [`energies`],
    outputs: [`adsorption_result`],
    default_params: { reference_coefficient: 0.5, include_zpe: true },
    help_text: `**Adsorption Energy** \u2014 Compute E\u2090\u2091\u209B = E(slab+ads) \u2212 E(slab) \u2212 coeff \u00D7 E(ref)

**Connect 2 or 3 parent Geo Opt nodes:**
1. **Slab + adsorbate** relaxation (most atoms \u2192 auto-detected)
2. **Clean slab** relaxation (fewer atoms)
3. **Reference molecule** relaxation (optional, e.g. H\u2082 in a box)

**ZPE Correction (optional):**
Connect Frequency/Vibration nodes as additional parents for ZPE correction:
- E\u2090\u2091\u209B(ZPE) = E\u2090\u2091\u209B + ZPE(slab+ads) \u2212 ZPE(slab) \u2212 coeff \u00D7 ZPE(ref)`,
    param_schema: [
      {
        key: `reference_coefficient`, label: `Reference Coefficient`, type: `number`,
        default: 0.5, min: 0, max: 2, step: 0.1, group: `Calculation`,
        help: `Stoichiometric coefficient for the reference molecule. Use 0.5 for H (from H\u2082), 1.0 for CO, OH, etc.`,
      },
      {
        key: `include_zpe`, label: `Include ZPE Correction`, type: `boolean`,
        default: true, group: `Calculation`,
        help: `Apply zero-point energy correction from connected Frequency/Vibration nodes.`,
      },
    ],
  },

  coverage_analysis: {
    type: `coverage_analysis`,
    label: `Coverage Analysis`,
    color: `#7c3aed`,
    icon: `\u{1F4C8}`,
    category: `Analysis`,
    description: `Compute coverage-dependent adsorption energy with linear fit`,
    inputs: [`energies`],
    outputs: [`coverage_result`],
    default_params: { reference_coefficient: 0.5 },
    help_text: `**Coverage Analysis** — Plot E_ads/adsorbate vs coverage (\u03B8) with linear fit.

**Formula:** E_ads/H = [E(slab+nH) - E(slab) - n \u00D7 coeff \u00D7 E(ref)] / n

Connect: batch geo_opt results + clean slab geo_opt + H\u2082 reference geo_opt.
The node auto-detects which parent is which by atom count and fan-out flag.`,
    param_schema: [
      { key: `reference_coefficient`, label: `Reference Coefficient`, type: `number`,
        default: 0.5, min: 0, max: 2, step: 0.1, group: `Calculation`,
        help: `Stoichiometric coefficient for reference molecule. 0.5 for H (from H\u2082).` },
    ],
  },

  surface_energy: {
    type: `surface_energy`,
    label: `Surface Energy`,
    color: `#0891b2`,
    icon: `\u{1F4D0}`,
    category: `Analysis`,
    description: `Calculate surface energy via linear extrapolation`,
    inputs: [`slab_energies`],
    outputs: [`surface_energy_result`],
    default_params: { grouping: `auto`, surface_area: null, bulk_energy_per_atom: null },
    help_text: `**Surface Energy Analysis** \u2014 Calculate \u03B3 from slab calculations at multiple thicknesses using linear extrapolation.`,
    param_schema: [
      { key: `grouping`, label: `Facet Grouping`, type: `select`, default: `auto`, group: `Surface`,
        options: [{ value: `auto`, label: `Auto-detect from labels` }, { value: `none`, label: `Single fit (all data)` }],
        help: `How to group slabs for separate surface energy calculations.`,
      },
    ],
  },

  wulff_construction: {
    type: `wulff_construction`,
    label: `Wulff Construction`,
    color: `#7c3aed`,
    icon: `\u{1F48E}`,
    category: `Analysis`,
    description: `Predict nanoparticle shape from surface energies`,
    inputs: [`surface_energy_result`],
    outputs: [`wulff_result`],
    default_params: {},
    help_text: `**Wulff Construction** \u2014 Predict equilibrium nanoparticle morphology from per-facet surface energies.`,
    param_schema: [],
  },

  gibbs_energy: {
    type: `gibbs_energy`,
    label: `Gibbs Energy`,
    color: `#059669`,
    icon: `\u{1F321}\uFE0F`,
    category: `Analysis`,
    description: `Compute Gibbs free energy from DFT energy + vibrational frequencies`,
    inputs: [`energy`, `frequencies`],
    outputs: [`gibbs`, `zpe`],
    default_params: { temperature: 298.15 },
    help_text: `**Gibbs Energy** \u2014 G = E(DFT) + ZPE + \u222BCp dT \u2212 TS`,
    param_schema: [
      { key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15, group: `Thermodynamics`,
        min: 1, max: 2000, step: 1, help: `Temperature for thermodynamic corrections.` },
    ],
  },

  her_analysis: {
    type: `her_analysis`,
    label: `HER Analysis`,
    color: `#ea580c`,
    icon: `\u2696\uFE0F`,
    category: `Analysis`,
    description: `Hydrogen evolution competing reaction check`,
    inputs: [`structure`, `energy`],
    outputs: [`selectivity`],
    default_params: {},
    help_text: `**HER Selectivity Analysis** — Check NRR vs HER competition.`,
    param_schema: [],
  },

  analysis: {
    type: `analysis`,
    label: `Analysis`,
    color: `#ec4899`,
    icon: `\u{1F4CA}`,
    category: `Analysis`,
    description: `Post-processing analysis (adsorption energy, etc.)`,
    inputs: [`data`],
    outputs: [`result`],
    default_params: { type: `adsorption_energy` },
    help_text: `**Analysis Node** — Post-processing calculations.`,
    param_schema: [
      {
        key: `type`, label: `Analysis Type`, type: `select`, default: `adsorption_energy`, group: `Analysis`,
        options: [
          { label: `Adsorption Energy`, value: `adsorption_energy` },
          { label: `Surface Energy`, value: `surface_energy` },
          { label: `Work Function`, value: `work_function` },
          { label: `d-Band Center`, value: `d_band_center` },
          { label: `Charge Transfer`, value: `charge_transfer` },
        ],
      },
    ],
  },

  export_data: {
    type: `export_data`,
    label: `Export`,
    color: `#06b6d4`,
    icon: `\u{1F4BE}`,
    category: `Analysis`,
    description: `Export results to file or database`,
    inputs: [`data`],
    outputs: [],
    default_params: { format: `json`, db: `ase.db` },
    help_text: `**Export Node** — Save results.`,
    param_schema: [
      {
        key: `format`, label: `Export Format`, type: `select`, default: `json`, group: `Export`,
        options: [
          { label: `JSON`, value: `json` },
          { label: `CSV`, value: `csv` },
          { label: `CIF`, value: `cif` },
          { label: `POSCAR`, value: `poscar` },
        ],
      },
    ],
  },
}


// ====================================================================
//  NODE TYPE MIGRATION MAP — old type → { type, defaults }
// ====================================================================

export const NODE_TYPE_MIGRATION: Record<string, { type: string; defaults: Record<string, unknown> }> = {
  vasp_relax:   { type: `geo_opt`,      defaults: { software: `vasp` } },
  cp2k_geopt:   { type: `geo_opt`,      defaults: { software: `cp2k` } },
  orca_opt:     { type: `geo_opt`,      defaults: { software: `orca`, system_type: `molecular` } },
  xtb_relax:    { type: `geo_opt`,      defaults: { software: `xtb` } },
  mlp_relax:    { type: `geo_opt`,      defaults: { software: `mlp` } },
  bulk_opt:     { type: `cell_opt`,     defaults: { software: `vasp` } },
  slab_relax:   { type: `geo_opt`,      defaults: { software: `vasp`, ISIF: 2, LDIPOL: true } },

  vasp_static:  { type: `single_point`, defaults: { software: `vasp` } },
  cp2k_static:  { type: `single_point`, defaults: { software: `cp2k` } },
  orca_sp:      { type: `single_point`, defaults: { software: `orca`, system_type: `molecular` } },
  xtb_static:   { type: `single_point`, defaults: { software: `xtb` } },

  cp2k_cellopt: { type: `cell_opt`,     defaults: { software: `cp2k` } },

  vasp_md:      { type: `md`,           defaults: { software: `vasp` } },
  cp2k_md:      { type: `md`,           defaults: { software: `cp2k` } },
  lammps_md:    { type: `md`,           defaults: { software: `lammps` } },
  mlp_md:       { type: `md`,           defaults: { software: `mlp` } },

  frequency:    { type: `freq`,         defaults: { software: `vasp` } },
  cp2k_freq:    { type: `freq`,         defaults: { software: `cp2k` } },
  orca_freq:    { type: `freq`,         defaults: { software: `orca`, system_type: `molecular` } },

  sella_ts:     { type: `ts_search`,    defaults: { software: `sella` } },
  orca_neb_ts:  { type: `ts_search`,    defaults: { software: `orca`, system_type: `molecular` } },

  orca_irc:     { type: `irc`,          defaults: { software: `orca`, system_type: `molecular` } },

  orca_uvvis:   { type: `uvvis`,        defaults: { software: `orca` } },
}


// ====================================================================
//  SIDEBAR & CATEGORY FUNCTIONS
// ====================================================================

/** The unified calc types that are merged into a single "Calculation" palette entry */
export const UNIFIED_CALC_TYPES = new Set([`geo_opt`, `single_point`, `cell_opt`, `md`, `md_minimize`, `freq`, `ts_search`, `irc`, `uvvis`])

/** Ordered list of calc types for the Calculation Type dropdown */
export const CALC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `geo_opt`, label: `Geometry Optimization` },
  { value: `single_point`, get label() { return t('workflow.node_single_point_label') } },
  { value: `cell_opt`, get label() { return t('workflow.node_cell_optimization_label') } },
  { value: `md`, get label() { return t('workflow.node_molecular_dynamics_label') } },
  { value: `md_minimize`, label: `MD Minimize` },
  { value: `freq`, label: `Frequency Analysis` },
  { value: `ts_search`, label: `Transition State Search` },
  { value: `irc`, label: `IRC` },
  { value: `uvvis`, label: `UV-Vis` },
]

/** The unified tool types that are merged into a single "Tools" palette entry */
export const UNIFIED_TOOL_TYPES = new Set([
  `slab_gen`, `doping_gen`, `adsorbate_place`, `batch_coverage_gen`, `polymer_build`,
  `polymer_crosslink`, `reference_mol`, `polymer_md`, `glass_transition`, `polymer_deform`,
])

/** Ordered list of tool types for the Tool Type dropdown */
export const TOOL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `slab_gen`, label: `Slab Gen` },
  { value: `doping_gen`, label: `Doping Gen` },
  { value: `adsorbate_place`, label: `Adsorbate` },
  { value: `batch_coverage_gen`, label: `Coverage Sweep` },
  { value: `polymer_build`, label: `Polymer Build` },
  { value: `polymer_crosslink`, label: `Crosslink` },
  { value: `reference_mol`, label: `Ref Molecule` },
  { value: `polymer_md`, label: `Polymer MD` },
  { value: `glass_transition`, label: `Tg Calculation` },
  { value: `polymer_deform`, label: `Polymer Deform` },
]

/** The unified analysis types that are merged into a single "Analysis" palette entry */
export const UNIFIED_ANALYSIS_TYPES = new Set([
  `dos_analysis`, `cohp_analysis`, `md_analysis`, `convergence_check`,
  `energy_compare`, `charge_analysis`, `electronic`, `free_energy`,
  `gibbs_energy`, `surface_energy`, `wulff_construction`, `adsorption_energy`, `coverage_analysis`,
  `her_analysis`, `analysis`, `export_data`,
])

/** Ordered list of analysis types for the Analysis Type dropdown */
export const ANALYSIS_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: `dos_analysis`, label: `DOS Analysis` },
  { value: `cohp_analysis`, label: `COHP Analysis` },
  { value: `md_analysis`, label: `MD Analysis` },
  { value: `convergence_check`, label: `Convergence Check` },
  { value: `energy_compare`, label: `Energy Compare` },
  { value: `charge_analysis`, label: `Charge Analysis` },
  { value: `electronic`, label: `Electronic Structure` },
  { value: `free_energy`, label: `Free Energy Diagram` },
  { value: `gibbs_energy`, label: `Gibbs Energy` },
  { value: `surface_energy`, label: `Surface Energy` },
  { value: `wulff_construction`, label: `Wulff Construction` },
  { value: `adsorption_energy`, label: `Adsorption Energy` },
  { value: `coverage_analysis`, label: `Coverage Analysis` },
  { value: `her_analysis`, label: `HER Analysis` },
  { value: `analysis`, label: `General Analysis` },
  { value: `export_data`, label: `Export Data` },
]

/** Node categories for the palette sidebar */
export function get_node_categories(): { id: string; label: string; nodes: NodeDefinition[] }[] {
  const cat_order = [`Input`, `Calculation`, `Tools`, `Logic`, `Analysis`]
  const cats: Record<string, NodeDefinition[]> = {}
  for (const def of Object.values(NODE_DEFINITIONS)) {
    if (!cats[def.category]) cats[def.category] = []
    cats[def.category].push(def)
  }
  return cat_order
    .filter((id) => cats[id])
    .map((id) => ({ id, label: id, nodes: cats[id] }))
}

/** 2-level sidebar hierarchy organized by task type */
export function get_sidebar_categories(): SidebarCategory[] {
  const all = Object.values(NODE_DEFINITIONS)
  const by_cat = (cat: string) => all.filter((d) => d.category === cat)

  // Merge all unified calc types into a single "Calculation" palette entry
  const calc_entry: NodeDefinition = {
    type: `geo_opt`,
    get label() { const trans = t('workflow.cat.Calculation'); return trans.startsWith('workflow.') ? 'Calculation' : trans },
    color: `#3b82f6`,
    icon: `\u26A1`,
    category: `Calculation`,
    get description() { const trans = 'workflow.cat.Calculation_desc'; return trans.startsWith('workflow.') ? 'DFT / ML / semi-empirical calculation' : trans },
    inputs: [`structure`],
    outputs: [`structure`, `energy`],
    default_params: NODE_DEFINITIONS[`geo_opt`]?.default_params ?? {},
  }

  // Merge all tool types into a single "Tools" palette entry
  const tools_entry: NodeDefinition = {
    type: `slab_gen`,
    get label() { const trans = t('workflow.cat.Tools'); return trans.startsWith('workflow.') ? 'Tools' : trans },
    color: `#0e7490`,
    icon: `\u{1F6E0}\uFE0F`,
    category: `Tools`,
    get description() { const trans = 'workflow.cat.Tools_desc'; return trans.startsWith('workflow.') ? 'Structure manipulation & building tools' : trans },
    inputs: [`structure`],
    outputs: [`structure`],
    default_params: NODE_DEFINITIONS[`slab_gen`]?.default_params ?? {},
  }

  // Merge all analysis types into a single "Analysis" palette entry
  const analysis_entry: NodeDefinition = {
    type: `dos_analysis`,
    get label() { const trans = t('workflow.cat.Analysis'); return trans.startsWith('workflow.') ? 'Analysis' : trans },
    color: `#db2777`,
    icon: `\u{1F4CA}`,
    category: `Analysis`,
    get description() { const trans = 'workflow.cat.Analysis_desc'; return trans.startsWith('workflow.') ? 'Post-processing & analysis' : trans },
    inputs: [`data`],
    outputs: [`result`],
    default_params: NODE_DEFINITIONS[`dos_analysis`]?.default_params ?? {},
  }

  const categories: SidebarCategory[] = [
    { id: `Input`, get label() { const trans = t('workflow.cat.Input'); return trans.startsWith('workflow.') ? 'Input' : trans }, icon: `\u{1F4C2}`, nodes: by_cat(`Input`) },
    { id: `Calculation`, get label() { const trans = t('workflow.cat.Calculation'); return trans.startsWith('workflow.') ? 'Calculation' : trans }, icon: `\u26A1`, nodes: [calc_entry] },
    { id: `Tools`, get label() { const trans = t('workflow.cat.Tools'); return trans.startsWith('workflow.') ? 'Tools' : trans }, icon: `\u{1F6E0}\uFE0F`, nodes: [tools_entry] },
    { id: `Logic`, get label() { const trans = t('workflow.cat.Logic'); return trans.startsWith('workflow.') ? 'Logic' : trans }, icon: `\u25C7`, nodes: by_cat(`Logic`) },
    { id: `Analysis`, get label() { const trans = t('workflow.cat.Analysis'); return trans.startsWith('workflow.') ? 'Analysis' : trans }, icon: `\u{1F4CA}`, nodes: [analysis_entry] },
  ]

  // Add Plugin category if any plugin nodes exist
  const plugin_nodes = by_cat(`Plugin`)
  if (plugin_nodes.length > 0) {
    categories.push({ id: `Plugin`, get label() { const trans = t('workflow.cat.Plugin'); return trans.startsWith('workflow.') ? 'Plugin' : trans }, icon: `\u{1F9E9}`, nodes: plugin_nodes })
  }

  // Filter out empty categories
  return categories.filter((c) => (c.nodes && c.nodes.length > 0) || (c.subcategories && c.subcategories.length > 0))
}

/** Plugin node definitions fetched from backend */
let _plugin_nodes: Record<string, NodeDefinition> = {}

/**
 * Load plugin node definitions from the backend API.
 * Called on WorkflowEditor mount to merge plugin nodes into NODE_DEFINITIONS.
 * Fetches from both the legacy plugin endpoint and the new ToolRegistry endpoint.
 */
export async function load_plugin_nodes(api_base: string): Promise<void> {
  const _merge_nodes = (data: any) => {
    if (!data?.nodes || !Array.isArray(data.nodes)) return
    for (const def of data.nodes) {
      if (def.type && !NODE_DEFINITIONS[def.type]) {
        NODE_DEFINITIONS[def.type] = def as NodeDefinition
        _plugin_nodes[def.type] = def as NodeDefinition
      }
    }
  }

  // Fetch from both endpoints in parallel — either may be unavailable
  const [legacy, tools] = await Promise.allSettled([
    fetch(`${api_base}/plugins/workflow-nodes`).then(r => r.ok ? r.json() : null),
    fetch(`${api_base}/tools/workflow-nodes`).then(r => r.ok ? r.json() : null),
  ])

  if (legacy.status === `fulfilled` && legacy.value) _merge_nodes(legacy.value)
  if (tools.status === `fulfilled` && tools.value) _merge_nodes(tools.value)
}

/** Check if a node type is from a plugin */
export function is_plugin_node(type: string): boolean {
  return type in _plugin_nodes
}

// ====================================================================
// i18n dynamic patching
// ====================================================================

function patch_node_i18n(node: NodeDefinition) {
  const original_label = node.label
  const original_desc = node.description

  Object.defineProperty(node, 'label', {
    get() {
      const trans = t(`workflow.node.${node.type}.label`)
      return trans.startsWith('workflow.') ? original_label : trans
    },
    enumerable: true,
    configurable: true
  })

  if (original_desc) {
    Object.defineProperty(node, 'description', {
      get() {
        const trans = t(`workflow.node.${node.type}.description`)
        return trans.startsWith('workflow.') ? original_desc : trans
      },
      enumerable: true,
      configurable: true
    })
  }
}

// Patch existing definitions
for (const node of Object.values(NODE_DEFINITIONS)) {
  patch_node_i18n(node)
}

// Patch option lists
const option_lists = [CALC_TYPE_OPTIONS, TOOL_TYPE_OPTIONS, ANALYSIS_TYPE_OPTIONS]
for (const list of option_lists) {
  for (const opt of list) {
    const original_label = opt.label
    Object.defineProperty(opt, 'label', {
      get() {
        const trans = t(`workflow.node.${opt.value}.label`)
        return trans.startsWith('workflow.') ? original_label : trans
      },
      enumerable: true,
      configurable: true
    })
  }
}
