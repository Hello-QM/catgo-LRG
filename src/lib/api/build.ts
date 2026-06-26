/**
 * API client for structure build/manipulation endpoints.
 * Used by workflow build nodes (defect, supercell, strain, doping, intercalation).
 */

import { API_BASE } from './config'

// === Types ===

export interface BuildResult {
  structures: Record<string, unknown>[]  // pymatgen Structure.as_dict()
  labels: string[]
  count: number
}

export interface DefectParams {
  structure: Record<string, unknown>  // pymatgen Structure dict
  defect_type: 'vacancy' | 'substitution' | 'interstitial'
  site_index: number
  substitute_element?: string
  supercell?: string
}

export interface SupercellParams {
  structure: Record<string, unknown>
  scaling: string
}

export interface StrainParams {
  structure: Record<string, unknown>
  strain_type: 'uniaxial' | 'biaxial' | 'hydrostatic' | 'shear'
  axis?: string
  magnitude: number
  n_steps?: number
}

export interface DopingParams {
  structure: Record<string, unknown>
  dopant: string
  host_element: string
  concentration?: number
  enumerate?: boolean
  target_indices?: number[]
}

export interface IntercalationParams {
  structure: Record<string, unknown>
  species: string
  position?: string
  n_intercalants?: number
}

export interface SubstitutionGroup {
  target_indices: number[]
  replacement_elements: string[]
}

export interface SubstitutionParams {
  structure: Record<string, unknown>
  groups: SubstitutionGroup[]
  max_structures?: number
}

export interface RandomDopant {
  element: string
  count: number
}

export interface RandomSubstitutionParams {
  structure: Record<string, unknown>
  host_element?: string        // pool = all sites of this element
  target_indices?: number[]    // OR explicit candidate pool (overrides host_element)
  dopants: RandomDopant[]
  n_samples?: number
  deduplicate?: boolean
  seed?: number | null
  max_structures?: number
}

// === Helper ===

async function handle_response<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Build operation failed: ${detail}`)
  }
  return response.json()
}

// === API Functions ===

export async function create_defect(params: DefectParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/defect`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function create_supercell(params: SupercellParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/supercell`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function apply_strain(params: StrainParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/strain`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function create_doping(params: DopingParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/doping`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function create_intercalation(params: IntercalationParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/intercalation`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function combinatorial_substitution(params: SubstitutionParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/substitution`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}

export async function random_substitution(params: RandomSubstitutionParams): Promise<BuildResult> {
  const response = await fetch(`${API_BASE}/build/random-substitution`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(params),
  })
  return handle_response(response)
}
