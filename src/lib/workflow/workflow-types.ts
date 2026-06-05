/** Workflow status values */
export type WorkflowStatus = `draft` | `running` | `completed` | `not_converged` | `failed` | `paused`
export type StepStatus = `pending` | `queued` | `submitting` | `running` | `completed` | `not_converged` | `failed` | `skipped`
export type EdgeType = `sequential` | `parallel` | `conditional`

/** Status colors matching the reference design */
export const STATUS_COLORS: Record<string, string> = {
  pending: `#475569`,
  queued: `#a78bfa`,
  running: `#3b82f6`,
  completed: `#22c55e`,
  not_converged: `#f59e0b`,
  pending_review: `#f59e0b`,
  failed: `#ef4444`,
  skipped: `#64748b`, // neutral slate — dry-run couldn't run this node (NOT a failure)
}

/** A single conditional visibility rule: show when params[key] is in values */
export interface ShowIfCondition {
  key: string
  values: unknown[]
}

/** Typed parameter definition for node config panels */
export interface ParamDef {
  key: string
  label: string
  type: `number` | `string` | `boolean` | `select` | `kpoints` | `text` | `checkbox` | `periodic` | `doping_groups`
  default: unknown
  options?: { label: string; value: unknown; show_if?: ShowIfCondition }[]
  help?: string
  group?: string
  /**
   * Only show this param when the given conditions all match current params.
   * A single condition or array of conditions (all must be satisfied — AND logic).
   */
  show_if?: ShowIfCondition | ShowIfCondition[]
  min?: number
  max?: number
  step?: number
}

export interface NodeDefinition {
  type: string
  label: string
  color: string
  icon: string
  category: string
  /** Physics-domain subcategory for 2-level sidebar grouping (e.g. 'Geometry Optimization') */
  subcategory?: string
  description: string
  inputs: string[]
  outputs: string[]
  is_condition?: boolean
  is_loop?: boolean
  is_merge?: boolean
  /** Fan-out node: takes a list and spawns parallel branches */
  is_fan_out?: boolean
  /** Fan-in node: collects results from parallel branches */
  is_fan_in?: boolean
  default_params: Record<string, unknown>
  /** Rich parameter schema for config panel */
  param_schema?: ParamDef[]
  /** Detailed help/usage text (markdown) */
  help_text?: string
}

/** Top-level sidebar category with optional subcategories */
export interface SidebarCategory {
  id: string
  label: string
  icon: string
  subcategories?: SidebarSubcategory[]
  /** Flat nodes (for categories without subcategories) */
  nodes?: NodeDefinition[]
}

/** Subcategory within a sidebar category */
export interface SidebarSubcategory {
  label: string
  nodes: NodeDefinition[]
}

/** Step execution info from API */
export interface StepInfo {
  id: string
  node_type: string
  label: string
  status: StepStatus
  config_json: string
  hpc_job_id?: string
  hpc_session_id?: string
  hpc_host?: string
  work_dir?: string
  ase_db_id?: number
  result_json: string
  error_message?: string
  started_at?: string
  completed_at?: string
}

/** Per-cluster HPC settings */
export interface ClusterConfig {
  potcar_root: string
  potcar_functional: string
  vasp_command: string
  python_env: string
  default_template: string
  default_job_params: JobScriptParams
  account?: string
  module_loads?: string
  orca_dir?: string
  /** CP2K data directory containing BASIS_MOLOPT / GTH_POTENTIALS / etc.
   *  When set, _generate_cp2k_input_content emits `BASIS_SET_FILE_NAME
   *  ${cp2k_data_dir}/BASIS_MOLOPT` (and same for POTENTIAL_FILE_NAME),
   *  otherwise it falls back to bare filenames (which only resolves when
   *  the cluster has CP2K_DATA_DIR exported in the user's environment). */
  cp2k_data_dir?: string
  /** Override CP2K run command. Default `srun cp2k.popt`; useful when the
   *  cluster only has `cp2k.psmp` or needs explicit hints. */
  cp2k_command?: string
}

/** Run configuration sent to backend */
export interface WorkflowRunConfig {
  execution_mode: `local` | `hpc`
  lmp_command: string
  local_work_dir: string
  default_session_id: string
  job_script_template: string
  cluster_configs: Record<string, ClusterConfig>
  calc_templates: Record<string, string>
  base_work_dir: string
  poll_interval: number
  step_sessions: Record<string, string>
  step_scripts: Record<string, string>
  step_job_params: Record<string, JobScriptParams>
  default_job_params: JobScriptParams
  use_custodian: boolean
  custodian_max_errors: number
  orca_binary?: string
  /**
   * Per-software default params merged into each task's params at submit
   * time by the Scanner (`_merged_config`) + each engine builtin's
   * `config.defaults.{sw}` lookup. CP2K is the first consumer; ORCA used
   * the same pattern as `defaults.orca` already.
   *
   * Key naming inside each sub-object matches what the engine reads from
   * task `params`. For CP2K that's `cutoff` / `rel_cutoff` / `scf_method`
   * (OT vs DIAGONALIZATION) / `max_scf` / `eps_scf`.
   *
   * Cluster-level paths (BASIS_SET_FILE_NAME / POTENTIAL_FILE_NAME /
   * CP2K_DATA_DIR) live on ClusterConfig, not here, so the same set of
   * run-time knobs follows a workflow across machines.
   */
  defaults?: {
    cp2k?: {
      cutoff?: number          // Ry — plane-wave cutoff for the GPW grid
      rel_cutoff?: number      // Ry — Gaussian-fitting reference cutoff
      scf_method?: string      // "OT" (fast, insulators) | "DIAGONALIZATION" (metals)
      max_scf?: number         // SCF iteration limit
      eps_scf?: number         // SCF convergence threshold
    }
    [sw: string]: Record<string, unknown> | undefined
  }
}

export interface JobScriptParams {
  nodes: number
  ntasks: number
  cpus_per_task: number
  walltime: string
  partition?: string
  memory?: string
  account?: string
}

/** Calculation type category (from backend) */
export interface CalcTypeCategory {
  label: string
  node_types: string[]
}

export interface WorkflowRunStatus {
  workflow_id: string
  status: string
  steps: StepInfo[]
  progress: number
}

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  status: WorkflowStatus
  template_id?: string
  project_id?: string | null
  created_at: string
  updated_at: string
  step_count: number
  completed_steps: number
}

export interface WorkflowDetail extends WorkflowSummary {
  graph_json: string
  metadata: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: string
  graph_json: string
}

/** A job script entry (built-in preset or user-created custom) */
export interface JobScript {
  id: string
  name: string
  template: string
  is_builtin: boolean
  cluster_tag: string   // 'shaheen' | 'expanse' | 'generic' | ''
  calc_type: string     // 'vasp_opt' | 'vasp_static' | 'vasp_md' | 'mlp' | 'xtb' | 'sella' | '' (empty = general)
}

/** Sentinel session ID for local (user's machine) execution — no HPC scheduler. */
export const LOCAL_SESSION_ID = `__local__`

/** Declarative engine spec from backend YAML definitions */
export interface EngineParamSpec {
  key: string
  label: string
  type: string
  default?: unknown
  options?: { label: string; value: unknown }[]
  unit?: string
  range?: [number, number]
  help?: string
  group?: string
  show_if?: ShowIfCondition | ShowIfCondition[]
}

export interface EngineSpec {
  engine: string
  label: string
  description: string
  supported_calc_types: string[]
  params: EngineParamSpec[]
  input_files: Record<string, { template?: string; source?: string; format?: string }>
  run_commands: string[]
  output_files: Record<string, string>
  environment?: { modules?: string[] }
  parser?: string
  safety: `safe` | `warn` | `dangerous`
  calc_type_mapping: Record<string, string>
}
