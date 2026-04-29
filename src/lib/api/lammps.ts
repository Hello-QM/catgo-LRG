/**
 * API client for LAMMPS MD execution endpoints.
 *
 * Supports local and HPC execution modes for LAMMPS simulations.
 */

const DEFAULT_SERVER = `http://localhost:8000`

// ============================================================================
// Types
// ============================================================================

export type ExecutionMode = `local` | `hpc`

export type LammpsJobStatus = `pending` | `running` | `completed` | `failed` | `cancelled`

export interface ThermoData {
  step: number
  temp?: number
  press?: number
  pe?: number
  ke?: number
  etotal?: number
  vol?: number
}

export interface LammpsRunRequest {
  input_script: string
  data_file: string
  potential_file?: string
  restart_file?: string  // base64-encoded restart file for continuing simulation
  write_restart?: boolean
  execution_mode: ExecutionMode
  lmp_command?: string
  hpc_session_id?: string
  job_name?: string
  work_dir?: string
  nodes?: number
  ntasks?: number
  walltime?: string
}

export interface LammpsJobStatusResponse {
  job_id: string
  status: LammpsJobStatus
  message: string
  started_at?: string
  completed_at?: string
  exit_code?: number
}

export interface LammpsResults {
  job_id: string
  status: LammpsJobStatus
  success: boolean
  message: string
  log_file?: string
  trajectory_file?: string
  final_data_file?: string
  restart_filename?: string
  restart_size?: number
  thermo_data: ThermoData[]
  error_output?: string
  output_files: string[]
}

// ============================================================================
// Generic POST request
// ============================================================================

async function post<TReq, TRes>(
  endpoint: string,
  params: TReq,
  server_url: string,
): Promise<TRes> {
  const response = await fetch(`${server_url}${endpoint}`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${endpoint} failed: ${detail}`)
  }

  return response.json()
}

async function get<TRes>(endpoint: string, server_url: string): Promise<TRes> {
  const response = await fetch(`${server_url}${endpoint}`)

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${endpoint} failed: ${detail}`)
  }

  return response.json()
}

async function del<TRes>(endpoint: string, server_url: string): Promise<TRes> {
  const response = await fetch(`${server_url}${endpoint}`, {
    method: `DELETE`,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${endpoint} failed: ${detail}`)
  }

  return response.json()
}

// ============================================================================
// LAMMPS Execution Endpoints
// ============================================================================

export async function run_lammps(
  params: LammpsRunRequest,
  server_url = DEFAULT_SERVER,
): Promise<LammpsJobStatusResponse> {
  return post(`/lammps/run`, params, server_url)
}

export async function get_lammps_status(
  job_id: string,
  server_url = DEFAULT_SERVER,
): Promise<LammpsJobStatusResponse> {
  return get(`/lammps/status/${job_id}`, server_url)
}

export async function get_lammps_results(
  job_id: string,
  server_url = DEFAULT_SERVER,
): Promise<LammpsResults> {
  return get(`/lammps/results/${job_id}`, server_url)
}

export async function cancel_lammps_job(
  job_id: string,
  server_url = DEFAULT_SERVER,
): Promise<{ job_id: string; cancelled: boolean; message: string }> {
  return del(`/lammps/jobs/${job_id}`, server_url)
}

export async function list_lammps_jobs(
  server_url = DEFAULT_SERVER,
): Promise<{
  jobs: Array<{
    job_id: string
    status: LammpsJobStatus
    execution_mode: string
    started_at?: string
    completed_at?: string
  }>
}> {
  return get(`/lammps/jobs`, server_url)
}

// ============================================================================
// Polling utilities
// ============================================================================

export interface PollOptions {
  interval?: number // milliseconds between polls
  timeout?: number // maximum time to wait in milliseconds
  on_progress?: (status: LammpsJobStatusResponse) => void
}

export async function poll_until_complete(
  job_id: string,
  server_url = DEFAULT_SERVER,
  options: PollOptions = {},
): Promise<LammpsJobStatusResponse> {
  const { interval = 2000, timeout = 3600000, on_progress } = options
  const start_time = Date.now()

  while (Date.now() - start_time < timeout) {
    const status = await get_lammps_status(job_id, server_url)
    on_progress?.(status)

    if (status.status === `completed` || status.status === `failed` || status.status === `cancelled`) {
      return status
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(`Polling timeout for job ${job_id}`)
}

export async function run_and_wait(
  params: LammpsRunRequest,
  server_url = DEFAULT_SERVER,
  poll_options?: PollOptions,
): Promise<{ status: LammpsJobStatusResponse; results: LammpsResults }> {
  const run_response = await run_lammps(params, server_url)
  const final_status = await poll_until_complete(run_response.job_id, server_url, poll_options)
  const results = await get_lammps_results(run_response.job_id, server_url)
  return { status: final_status, results }
}

// ============================================================================
// Polymer-Specific Types
// ============================================================================

export type PolymerType = `PE` | `PP` | `PS` | `PMMA` | `PET` | `PA6`
export type Tacticity = `isotactic` | `syndiotactic` | `atactic`
export type PolymerForceField = `opls` | `pcff` | `compass` | `dreiding` | `trappe`

export interface PolymerBuildRequest {
  polymer_type: PolymerType
  chain_length: number
  tacticity: Tacticity
  force_field: PolymerForceField
  density: number
  box_size?: [number, number, number]
  seed?: number
}

export interface PolymerBuildResponse {
  success: boolean
  structure?: any
  data_file?: string
  input_script?: string
  n_chains: number
  n_monomers: number
  density: number
  message: string
  warnings: string[]
}

export interface CrosslinkRequest {
  polymer_structure: any
  crosslinker_type: `sulfur` | `peroxide` | `radiation` | `epoxy`
  crosslink_density: number
  target_atoms?: string[]
  min_distance: number
  max_distance: number
}

export interface CrosslinkResponse {
  success: boolean
  structure?: any
  n_crosslinks: number
  crosslink_positions: [number, number, number][]
  message: string
}

export interface GlassTransitionRequest {
  polymer_structure: any
  temp_min: number
  temp_max: number
  temp_step: number
  equil_steps: number
  prod_steps: number
  cooling_rate: number
}

export interface GlassTransitionResponse {
  success: boolean
  tg_estimate?: number
  density_profile: Array<{ temp: number; density: number }>
  script: string
  message: string
}

export interface DeformationRequest {
  polymer_structure: any
  deformation_type: `uniaxial` | `biaxial` | `shear_xy` | `shear_xz` | `compression`
  strain_rate: number
  max_strain: number
  temperature: number
  deform_axis?: `x` | `y` | `z`
}

// ============================================================================
// Polymer API Endpoints
// ============================================================================

export async function get_polymer_monomers(
  server_url = DEFAULT_SERVER,
): Promise<{
  monomers: Record<string, { repeat_unit: string; description: string }>
  force_fields: Record<string, { name: string; description: string; typical_polymers: string[] }>
}> {
  return get(`/lammps/polymer/monomers`, server_url)
}

export async function build_polymer(
  params: PolymerBuildRequest,
  server_url = DEFAULT_SERVER,
): Promise<PolymerBuildResponse> {
  return post(`/lammps/polymer/build`, params, server_url)
}

export async function crosslink_polymer(
  params: CrosslinkRequest,
  server_url = DEFAULT_SERVER,
): Promise<CrosslinkResponse> {
  return post(`/lammps/polymer/crosslink`, params, server_url)
}

export async function calculate_glass_transition(
  params: GlassTransitionRequest,
  server_url = DEFAULT_SERVER,
): Promise<GlassTransitionResponse> {
  return post(`/lammps/polymer/tg`, params, server_url)
}

export async function deform_polymer(
  params: DeformationRequest,
  server_url = DEFAULT_SERVER,
): Promise<{ success: boolean; script: string; job_id?: string }> {
  return post(`/lammps/polymer/deform`, params, server_url)
}

// ============================================================================
// Polymer Workflow Types
// ============================================================================

export type WorkflowMode = `polymer_kg` | `all_atom` | `custom`

export interface PolymerWorkflowRequest {
  structure: any
  prefix?: string
  pair_style: string
  pair_coeff: string
  bond_style: string
  bond_coeff: string
  workflow_mode: WorkflowMode
  temperature: number
  pressure: number
  timestep: number
  gen_steps_nvt: number
  gen_steps_npt: number
  equil_steps: number
  prod_steps: number
  prod_dump_freq: number
  units: string
  atom_style: string
}

export interface PolymerWorkflowResponse {
  success: boolean
  input_script: string
  data_file: string
  stages: Array<{ name: string; ensemble: string; steps: number }>
  message: string
  warnings: string[]
}

export async function generate_polymer_workflow(
  params: PolymerWorkflowRequest,
  server_url = DEFAULT_SERVER,
): Promise<PolymerWorkflowResponse> {
  return post(`/lammps/polymer/workflow`, params, server_url)
}
