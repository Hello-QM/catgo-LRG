/**
 * Static data constants and type definitions extracted from Sidebar.svelte.
 */

import type { FileBrowseItem } from '$lib/api/project'

// ========== File extension sets ==========
export const STRUCTURE_EXTS = new Set([`.cif`, `.poscar`, `.vasp`, `.xyz`, `.extxyz`, `.json`, `.pdb`, `.mol`, `.mol2`, `.sdf`, `.cube`, `.cub`])
export const DB_FILE_EXTS = new Set([`.db`, `.sqlite`, `.sqlite3`])
export const CHGCAR_PATTERNS = /^(CHGCAR|AECCAR0|AECCAR1|AECCAR2|LOCPOT|ELFCAR|PARCHG)$/i

// ========== LocalStorage key ==========
export const LAST_DB_KEY = `catgo-last-db-path`

// ========== Interfaces ==========
export interface LocalFile {
  path: string
  name: string
  content?: string // present for structures/molecules (eager raw)
  url?: string     // present for trajectories (lazy url)
}

export interface DbWorkflow {
  id: string
  name: string
  status: string
  project_id: string | null
  step_count: number
  completed_steps: number
}

export interface DbResult {
  id: number
  formula: string
  label: string
  energy: number | null
  step_id: string
  node_type: string
}

export interface WfNodeInfo {
  id: string
  type: string
  label: string
  icon: string
}

export type CtxTarget =
  | { type: `project`; id: string }
  | { type: `workflow`; wf: DbWorkflow }
  | { type: `result`; result: DbResult; parent_id: string }
