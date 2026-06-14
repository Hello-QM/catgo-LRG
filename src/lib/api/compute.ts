/**
 * API service for CatGo computation server.
 * Handles structure optimization with WebSocket progress and HTTP fallback.
 */

import type { AnyStructure, PymatgenStructure } from '$lib/structure'

function format_error_detail(detail: unknown): string {
  if (typeof detail === `string`) return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === `object` && d?.msg) {
          const loc = Array.isArray(d.loc) ? d.loc.join(`.`) : ``
          return loc ? `${d.msg} (${loc})` : d.msg
        }
        return JSON.stringify(d)
      })
      .join(`; `)
  }
  return JSON.stringify(detail)
}

export type CalculatorType = 'emt' | 'xtb' | 'mace' | 'chgnet' | 'm3gnet'

export type XTBMethod = 'GFN2-xTB' | 'GFN1-xTB' | 'GFN0-xTB' | 'GFN-FF' | 'IPEA1-xTB'

export interface XTBParams {
  method?: XTBMethod
  accuracy?: number
  electronic_temperature?: number
  max_iterations?: number
}

export interface MACEParams {
  model?: 'small' | 'medium' | 'large' | 'custom'
  model_path?: string // Path to custom MACE model file (.model)
  device?: 'cpu' | 'cuda'
}

export interface CalculatorParams {
  xtb?: XTBParams
  mace?: MACEParams
}

export type ServerOptimizerType = 'bfgs' | 'sella_min' | 'sella_ts' | 'irc'

export interface SellaParams {
  delta0?: number
  sigma_inc?: number
  sigma_dec?: number
  rho_inc?: number
  rho_dec?: number
}

export interface IRCParams {
  dx?: number
  eta?: number
  gamma?: number
}

export interface CalculatorInfo {
  available: boolean
  name: string
  description: string
  supported_elements: string[] | null
}

export interface OptimizationProgress {
  type: 'progress' | 'complete' | 'error' | 'cancelled'
  step: number
  total_steps: number
  energy: number
  fmax: number
  converged?: boolean
  message?: string
  structure?: AnyStructure
}

export interface OptimizationConfig {
  calculator: CalculatorType
  calculator_params?: CalculatorParams
  optimizer?: ServerOptimizerType
  sella_params?: SellaParams
  irc_params?: IRCParams
  fmax: number
  steps: number
  optimize_cell: boolean
  mobile_indices?: number[] // Indices of atoms allowed to move
  extract_fragment?: boolean // If true, extract selected atoms as fragment
}

export interface OptimizationResult {
  success: boolean
  structure?: AnyStructure
  message: string
  initial_energy?: number
  final_energy?: number
  steps_taken?: number
}

import { API_BASE as _DEFAULT_API, WS_BASE as _DEFAULT_WS } from './config'
import { isMobile } from './transport'

// Default API base URL - can be overridden
let API_BASE = _DEFAULT_API
let WS_BASE = _DEFAULT_WS

/**
 * Configure the API base URL.
 */
export function setApiBase(httpBase: string, wsBase?: string): void {
  API_BASE = httpBase
  WS_BASE = wsBase ?? httpBase.replace(/^http/, `ws`)
}

/**
 * Get current API base URL.
 */
export function getApiBase(): { http: string; ws: string } {
  return { http: API_BASE, ws: WS_BASE }
}

/**
 * Fetch available calculators from the server.
 */
export async function fetchCalculators(): Promise<Record<string, CalculatorInfo>> {
  const response = await fetch(`${API_BASE}/optimize/calculators`)
  if (!response.ok) {
    throw new Error(`Failed to fetch calculators: ${response.statusText}`)
  }
  const data = await response.json()
  return data.calculators
}

/**
 * Check if the compute server is available.
 */
export async function checkServerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE.replace(/\/api$/, ``)}/health`, {
      method: `GET`,
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * HTTP-based optimization (non-streaming fallback).
 */
export async function optimizeStructure(
  structure: AnyStructure,
  config: OptimizationConfig,
  onProgress?: (progress: { current: number; total: number; stage: string }) => void,
): Promise<OptimizationResult> {
  onProgress?.({ current: 0, total: config.steps, stage: `Starting optimization...` })

  const response = await fetch(`${API_BASE}/optimize/structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      structure,
      calculator: config.calculator,
      calculator_params: config.calculator_params,
      optimizer: config.optimizer,
      sella_params: config.sella_params,
      irc_params: config.irc_params,
      fmax: config.fmax,
      steps: config.steps,
      optimize_cell: config.optimize_cell,
      mobile_indices: config.mobile_indices,
      extract_fragment: config.extract_fragment,
      return_trajectory: false,
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(format_error_detail(error.detail) || `Optimization failed: ${response.statusText}`)
  }

  const result = await response.json()
  onProgress?.({ current: result.steps_taken, total: config.steps, stage: `Complete` })

  return {
    success: result.success,
    structure: result.structure,
    message: result.message,
    initial_energy: result.initial_energy,
    final_energy: result.final_energy,
    steps_taken: result.steps_taken,
  }
}

/**
 * WebSocket connection for real-time optimization progress.
 */
export interface WSConnection {
  /** Request cancellation of the optimization */
  cancel: () => void
  /** Disconnect the WebSocket */
  disconnect: () => void
  /** Check if WebSocket is connected */
  isConnected: () => boolean
}

export interface WSCallbacks {
  onProgress: (progress: OptimizationProgress) => void
  onComplete: (result: OptimizationProgress) => void
  onError: (error: Error) => void
  onCancel?: () => void
  onConnected?: () => void
  onDisconnected?: () => void
}

/**
 * Connect to optimization WebSocket for real-time progress.
 */
export function connectOptimizationWS(
  structure: AnyStructure,
  config: OptimizationConfig,
  callbacks: WSCallbacks,
): WSConnection {
  // No backend on mobile — this WebSocket would hang in SYN_SENT with no connect
  // timeout. Fail fast with an inert connection instead.
  if (isMobile()) {
    callbacks.onError(new Error(`Optimization is unavailable on mobile (no backend)`))
    return { cancel: () => {}, disconnect: () => {}, isConnected: () => false }
  }
  const request_id = `opt_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const ws_url = `${WS_BASE}/optimize/ws`

  let ws: WebSocket | null = null
  let cancelled = false
  let connected = false

  try {
    ws = new WebSocket(ws_url)
  } catch (_err) {
    callbacks.onError(new Error(`Failed to create WebSocket connection`))
    return {
      cancel: () => {},
      disconnect: () => {},
      isConnected: () => false,
    }
  }

  ws.onopen = () => {
    connected = true
    callbacks.onConnected?.()

    // Send start request
    ws?.send(
      JSON.stringify({
        action: `start`,
        payload: {
          structure,
          calculator: config.calculator,
          calculator_params: config.calculator_params,
          optimizer: config.optimizer,
          sella_params: config.sella_params,
          irc_params: config.irc_params,
          fmax: config.fmax,
          steps: config.steps,
          optimize_cell: config.optimize_cell,
          mobile_indices: config.mobile_indices,
          extract_fragment: config.extract_fragment,
          request_id,
        },
      }),
    )
  }

  ws.onmessage = (event) => {
    try {
      console.log(`WebSocket message received:`, event.data)
      const data: OptimizationProgress = JSON.parse(event.data)

      switch (data.type) {
        case `progress`:
          callbacks.onProgress(data)
          break
        case `complete`:
          callbacks.onComplete(data)
          ws?.close()
          break
        case `cancelled`:
          callbacks.onCancel?.()
          ws?.close()
          break
        case `error`:
          callbacks.onError(new Error(data.message || `Optimization error`))
          ws?.close()
          break
      }
    } catch (err) {
      console.error(`Failed to parse WebSocket message:`, event.data, err)
      callbacks.onError(new Error(`Failed to parse server message`))
    }
  }

  ws.onerror = (event) => {
    console.error(`WebSocket error:`, event)
    if (!cancelled) {
      callbacks.onError(new Error(`WebSocket connection error`))
    }
  }

  ws.onclose = (event) => {
    console.log(
      `WebSocket closed: code=${event.code}, reason=${event.reason}, wasClean=${event.wasClean}`,
    )
    connected = false
    callbacks.onDisconnected?.()
  }

  return {
    cancel: () => {
      cancelled = true
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: `cancel`, request_id }))
      }
    },
    disconnect: () => {
      cancelled = true
      ws?.close()
    },
    isConnected: () => connected,
  }
}

/**
 * High-level optimization function that tries WebSocket first, falls back to HTTP.
 */
export function runOptimization(
  structure: AnyStructure,
  config: OptimizationConfig,
  callbacks: {
    onProgress: (progress: OptimizationProgress) => void
    onComplete: (result: OptimizationResult) => void
    onError: (error: Error) => void
  },
): WSConnection {
  // No backend on mobile. The WS guard in connectOptimizationWS fails fast, but
  // its onError below would then fall back to optimizeStructure() — a plain fetch
  // to the dead backend that hangs. Short-circuit here too.
  if (isMobile()) {
    callbacks.onError(new Error(`Optimization is unavailable on mobile (no backend)`))
    return { cancel: () => {}, disconnect: () => {}, isConnected: () => false }
  }
  // Try WebSocket first
  const connection = connectOptimizationWS(structure, config, {
    onProgress: callbacks.onProgress,
    onComplete: (progress) => {
      callbacks.onComplete({
        success: true,
        structure: progress.structure,
        message: progress.message ||
          (progress.converged ? `Converged` : `Max steps reached`),
        final_energy: progress.energy,
        steps_taken: progress.step,
      })
    },
    onError: async (wsError) => {
      // Fall back to HTTP if WebSocket fails
      console.warn(`WebSocket failed, falling back to HTTP:`, wsError.message)
      try {
        const result = await optimizeStructure(structure, config, (p) => {
          callbacks.onProgress({
            type: `progress`,
            step: p.current,
            total_steps: p.total,
            energy: 0,
            fmax: 0,
          })
        })
        callbacks.onComplete(result)
      } catch (httpError) {
        callbacks.onError(
          httpError instanceof Error ? httpError : new Error(String(httpError)),
        )
      }
    },
    onCancel: () => {
      callbacks.onComplete({
        success: false,
        message: `Optimization cancelled`,
      })
    },
  })

  return connection
}

// ====== VASP Input Generation ======

export type VASPCalculationType =
  | 'opt'
  | 'scf'
  | 'freq'
  | 'bader'
  | 'dos'
  | 'ddec'
  | 'elf'
  | 'md'
  | 'slow_growth'
export type VASPOptimizerType = 'standard' | 'vtst_fire' | 'quasi_newton'

export type ConstantPotentialMethod = 'none' | 'tpot' | 'cpvasp'

export interface VASPInputRequest {
  structure: PymatgenStructure
  calculation_type?: VASPCalculationType
  constant_potential?: ConstantPotentialMethod
  optimizer?: VASPOptimizerType
  encut?: number
  prec?: string
  gga?: string
  ediff?: number
  ismear?: number
  sigma?: number
  ispin?: number
  magmom?: string
  isif?: number
  nsw?: number
  ediffg?: number
  potim?: number
  ivdw?: number
  lwave?: boolean
  lcharg?: boolean
  lorbit?: number
  nedos?: number
  nfree?: number
  kpoints?: number[][]
  kspacing?: number
  system_title?: string
  nelect?: number
  custom_incar?: Record<string, string | number | boolean>
  fixed_indices?: number[]
  fixed_z_below?: number
  // Slow-growth MD
  mdalgo?: number
  smass?: number
  tebeg?: number
  teend?: number
  nblock?: number
  lblueout?: boolean
  increm?: string
  iconst_content?: string
  // TPOT (constant potential)
  tpot_vtarget?: number
  tpot_vdiff?: number
  tpot_vrate?: number
  tpot_vratelim?: number
  tpot_vratedamp?: number
  tpot_vediff?: number
  tpot_electstep?: number
  tpot_dynvrate?: boolean
  tpot_truevaclevel?: boolean
  tpot_gcenergy?: boolean
  tpot_gcionic?: boolean
  // TPOT VASPsol solvation
  tpot_eb_k?: number
  tpot_lambda_d_k?: number
  tpot_core_c?: number
  tpot_tau?: number
  // CP-VASP (constant potential + VASPsol)
  cpvasp_targetmu?: number
  cpvasp_nescheme?: number
  cpvasp_neadjust?: number
  cpvasp_fermiconverge?: number
  cpvasp_cap_max?: number
  cpvasp_t_eta?: number
  cpvasp_eta_length?: number
  cpvasp_lsol?: boolean
  cpvasp_isol?: number
  cpvasp_c_molar?: number
  cpvasp_r_ion?: number
}

export interface VASPInputFiles {
  incar: string
  poscar: string
  kpoints: string
  iconst?: string
  incar_nelect?: string
  potcar_info: {
    elements: string[]
    note: string
  }
  calculation_type: VASPCalculationType
  notes?: string
}

/**
 * Generate VASP input files (INCAR, POSCAR, KPOINTS).
 */
export async function generateVASPInputs(
  request: VASPInputRequest,
): Promise<VASPInputFiles> {
  const response = await fetch(`${API_BASE}/vasp/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`VASP generation failed: ${error}`)
  }

  return response.json()
}

/**
 * Get available VASP calculation types with descriptions.
 */
export async function getVASPCalculationTypes(): Promise<Record<string, string>> {
  const response = await fetch(`${API_BASE}/vasp/calculation-types`)
  if (!response.ok) throw new Error('Failed to fetch VASP calculation types')
  return response.json()
}

/**
 * Get available VASP optimizer types with descriptions.
 */
export async function getVASPOptimizerTypes(): Promise<Record<string, string>> {
  const response = await fetch(`${API_BASE}/vasp/optimizer-types`)
  if (!response.ok) throw new Error('Failed to fetch VASP optimizer types')
  return response.json()
}

// ====== Slow-growth REPORT post-processing ======

export interface SlowGrowthUploadResponse {
  session_id: string
  total_steps: number
  num_constraints: number
  constraints: number[]
  has_blue_moon: boolean
}

export interface SlowGrowthConstraintData {
  b_cnt: number
  step: number[]
  cv: number[]
  dcv: number[]
  dA_dxsi: number[]
  delta_F: number[]
  // Blue Moon fields
  cv_target: number[]
  cv_actual: number[]
  cv_diff: number[]
  lambda_val: number[]
  z_inv_sqrt: number[]
  GkT: number[]
  mean_force: number[]
}

export interface SlowGrowthBarrierAnalysis {
  total_delta_F: number
  total_delta_F_kcal: number
  max_F: number
  max_F_cv: number
  min_F: number
  min_F_cv: number
  barrier_forward: number
  barrier_forward_kcal: number
  barrier_reverse: number
  barrier_reverse_kcal: number
  cv_start: number
  cv_end: number
  num_steps: number
}

export interface SlowGrowthAnalysisResponse {
  session_id: string
  total_steps: number
  num_constraints: number
  has_blue_moon: boolean
  constraints: SlowGrowthConstraintData[]
  barriers: SlowGrowthBarrierAnalysis[]
}

/**
 * Upload a VASP REPORT file for slow-growth post-processing.
 */
export async function uploadSlowGrowthReport(
  file: File,
): Promise<SlowGrowthUploadResponse> {
  const formData = new FormData()
  formData.append(`file`, file)
  const response = await fetch(`${API_BASE}/vasp/report/upload`, {
    method: `POST`,
    body: formData,
  })
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`REPORT upload failed: ${error}`)
  }
  return response.json()
}

/**
 * Upload REPORT content as text (for HPC remote files).
 */
export async function uploadSlowGrowthReportText(
  content: string,
): Promise<SlowGrowthUploadResponse> {
  const response = await fetch(`${API_BASE}/vasp/report/upload-text`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`REPORT upload failed: ${error}`)
  }
  return response.json()
}

/**
 * Get slow-growth analysis data for all constraints.
 */
export async function getSlowGrowthAnalysis(
  session_id: string,
): Promise<SlowGrowthAnalysisResponse> {
  const response = await fetch(`${API_BASE}/vasp/report/${session_id}`)
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Analysis failed: ${error}`)
  }
  return response.json()
}

// ====== ORCA Input Generation ======

export type ORCAMethod = 'HF' | 'B3LYP' | 'PBE' | 'CCSD' | 'MP2'
export type ORCABasisSet = 'STO-3G' | '6-31G' | '6-311G' | 'cc-pVDZ' | 'cc-pVTZ'
export type ORCAOptType = 'MinSteps' | 'Freq' | 'TS'

export interface ORCAInputRequest {
  structure?: PymatgenStructure
  method?: ORCAMethod
  basis_set?: ORCABasisSet
  opt_type?: ORCAOptType
  num_cores?: number
  max_iterations?: number
  charge?: number
  multiplicity?: number
}

export interface ORCAInputFiles {
  inp: string
  notes?: string
}

export interface OrcaNebInputRequest {
  structure_reactant?: PymatgenStructure
  structure_product?: PymatgenStructure
  method?: ORCAMethod
  basis?: ORCABasisSet
  nimages?: number
  spring_k?: number
  ts_opt?: boolean
  neb_cycles?: number
  num_cores?: number
  charge?: number
  multiplicity?: number
}

export interface OrcaNebInputFiles {
  inp: string
  reactant_xyz: string
  product_xyz: string
  notes?: string
}

export interface OrcaIrcInputRequest {
  structure?: PymatgenStructure
  external_ts_file?: string  // e.g., "NEB-TS_converged.xyz" from previous NEB-TS calculation
  method?: ORCAMethod
  basis?: ORCABasisSet
  max_iterations?: number
  num_cores?: number
  charge?: number
  multiplicity?: number
}

export interface OrcaIrcInputFiles {
  inp: string
  ts_xyz: string
  notes?: string
}

/**
 * Generate ORCA input file (.inp) for a structure.
 */
export async function generateOrcaInputs(
  request: ORCAInputRequest,
): Promise<ORCAInputFiles> {
  const response = await fetch(`${API_BASE}/orca/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`ORCA generation failed: ${error}`)
  }

  return response.json()
}

/**
 * Generate ORCA NEB-TS input file for transition state search.
 */
export async function generateOrcaNebInputs(
  request: OrcaNebInputRequest,
): Promise<OrcaNebInputFiles> {
  const response = await fetch(`${API_BASE}/orca/generate-neb-ts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`ORCA NEB-TS generation failed: ${error}`)
  }

  return response.json()
}

/**
 * Generate ORCA IRC input file for intrinsic reaction coordinate.
 */
export async function generateOrcaIrcInputs(
  request: OrcaIrcInputRequest,
): Promise<OrcaIrcInputFiles> {
  const response = await fetch(`${API_BASE}/orca/generate-irc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`ORCA IRC generation failed: ${error}`)
  }

  return response.json()
}
