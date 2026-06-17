/**
 * Pane / tab types and pure helper functions — extracted from App.svelte.
 *
 * These are non-reactive, pure functions that operate on pane and tab data.
 */

import type { AnyStructure } from '$lib'
import type { PaneNode, TerminalLeafState } from './pane-tree'
import { create_empty_leaf, create_terminal_leaf } from './pane-tree'

// ========== Types ==========

export interface PaneState {
  mode: 'structure' | 'workflow'
  workflow_id?: string
  workflow_compact?: boolean
  structure: AnyStructure | undefined
  saveable_structure: AnyStructure | undefined
  trajectory: unknown
  is_trajectory_mode: boolean
  cube_file: File | null
  selected_sites: number[]
  current_step_idx: number
  modified: boolean
  initial_site_count: number
  initial_structure_ref: AnyStructure | null
  raw_traj_b64: string
  raw_traj_format: string
  initial_panel?: `hpc` | `chat` | `terminal`
  open_plugin_hub?: number
  /** Remote file origin for "push structure back" feature */
  remote_origin?: { session_id: string; file_path: string } | null
  /** Local filesystem path this structure was loaded from */
  local_file_path?: string | null
  /** Filename of the loaded structure file */
  source_filename?: string | null
  /** Which viewer renders this pane. Absent/'native' = Three.js viewer. */
  viewer_kind?: 'native' | 'molstar'
  /** Raw file text for Mol* (bio files bypass pymatgen parsing). */
  bio_raw_content?: string
  /** Mol* format string ('pdb' | 'mmcif') for loadStructureFromData. */
  bio_format?: string
}

/**
 * One imported structure held in a tab's structure-library sidebar.
 * Parsed eagerly (see desktop/App.svelte ingest_one): a multi-frame file
 * (vasprun/.traj/.extxyz/.h5) becomes a SINGLE entry with is_trajectory:true.
 */
export interface LibraryEntry {
  id: string
  /** Display name (post-decompression basename) */
  filename: string
  /** Tauri abs path or webkitRelativePath, for tooltip / re-resolve */
  source_path?: string | null
  /** Lowercased extension / detected format */
  format: string
  structure: AnyStructure | undefined
  trajectory?: unknown
  is_trajectory: boolean
  cube_file?: File | null
  raw_traj_b64?: string
  raw_traj_format?: string
  viewer_kind?: 'native' | 'molstar'
  bio_raw_content?: string
  bio_format?: string
}

export interface StructureTabState {
  root: PaneNode
  active_leaf_id: string
  close_confirm_leaf_id: string | null
  /** Leaf currently maximized/zoomed to fill the tab workspace, or null. */
  maximized_leaf_id: string | null
  /** Per-tab structure library (sidebar). Cleared automatically on tab close. */
  library: LibraryEntry[]
  active_library_id: string | null
}

// ========== Pure Functions ==========

export function get_pane_label(pane: PaneState): string {
  if (pane.mode === 'workflow') return `Workflow`
  if (!pane.structure && !pane.trajectory && !pane.cube_file) return `Empty`
  if (pane.structure?.sites?.length) {
    const counts: Record<string, number> = {}
    for (const site of pane.structure.sites) {
      const el = Array.isArray(site.species) ? site.species[0]?.element : (site.species as string)
      if (el) counts[el] = (counts[el] || 0) + 1
    }
    const formula = Object.entries(counts).map(([el, n]) => n > 1 ? `${el}${n}` : el).join(``)
    if (formula) return formula
  }
  if (pane.trajectory) return `Trajectory`
  if (pane.cube_file) return `Cube File`
  return `Structure`
}

export function create_empty_pane(): PaneState {
  return { mode: 'structure', structure: undefined, saveable_structure: undefined, trajectory: null, is_trajectory_mode: false, cube_file: null, selected_sites: [], current_step_idx: 0, modified: false, initial_site_count: 0, initial_structure_ref: null, raw_traj_b64: '', raw_traj_format: '', remote_origin: null, local_file_path: null, source_filename: null, open_plugin_hub: 0 }
}

export function pane_has_content(p: PaneState): boolean {
  return p.mode === 'workflow' || !!(p.structure || p.trajectory || p.cube_file)
}

export function content_to_base64(content: string | ArrayBuffer): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function create_tab_state(): StructureTabState {
  const root = create_empty_leaf()
  return {
    root,
    active_leaf_id: root.id,
    close_confirm_leaf_id: null,
    maximized_leaf_id: null,
    library: [],
    active_library_id: null,
  }
}

/** Like create_tab_state, but the root leaf holds a terminal (for a "+Terminal" tab). */
export function create_terminal_tab_state(opts?: Partial<TerminalLeafState>): StructureTabState {
  const root = create_terminal_leaf(opts)
  return {
    root,
    active_leaf_id: root.id,
    close_confirm_leaf_id: null,
    maximized_leaf_id: null,
    library: [],
    active_library_id: null,
  }
}

/**
 * Derive a chemical formula string from a structure's sites array.
 * Used as an auto-generated name for save dialogs and tab labels.
 */
export function auto_name(structure: Record<string, unknown>): string {
  const sites = (structure as { sites?: Array<{ species?: Array<{ element?: string }>; label?: string }> }).sites
  if (!sites?.length) return `structure`
  const counts: Record<string, number> = {}
  for (const s of sites) {
    const el = Array.isArray(s.species) ? (s.species[0]?.element || `X`) : (s.label || `X`)
    counts[el] = (counts[el] || 0) + 1
  }
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([el, n]) => n > 1 ? `${el}${n}` : el).join(``)
}

// ========== Sample Structures ==========

export interface SampleStructure {
  name: string
  description: string
  formula: string
  data: AnyStructure
}

// ========== File Detection ==========

/** CHGCAR/AECCAR/LOCPOT etc. VASP volumetric data file name detection */
const CHGCAR_PATTERNS = /^(CHGCAR|CHGDIFF|DIFFCHG|AECCAR0|AECCAR1|AECCAR2|LOCPOT|ELFCAR|PARCHG)(\.vasp)?$/i

export function is_chgcar_file(filename: string): boolean {
  // Files with .cube/.cub extension are NOT CHGCAR, even if name contains "CHGCAR"
  if (/\.(cube|cub)$/i.test(filename)) return false
  const basename = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``)
  if (CHGCAR_PATTERNS.test(basename)) return true
  // Loose match — catches "CHGCAR_diff_HCO2", "DIFFCHG_HCO2" etc.
  if (/CHGCAR|CHGDIFF|DIFFCHG|AECCAR|LOCPOT|ELFCAR|PARCHG/i.test(basename)) return true
  return false
}

/** Non-structure file extension pattern for skip logic */
export const NON_STRUCTURE_EXTS = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|pdf|xlsx?|xlsm|xlsb|ods|csv|tsv|mp[34]|wav|ogg|avi|mov|mkv|zip|gz|tar|rar|7z|exe|dll|so|dylib|woff2?|ttf|eot)$/i

// ========== Export Helpers ==========

/** Infer export format from a filename extension. */
export function update_export_format(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf(`.`)).toLowerCase()
  if (ext === `.poscar` || ext === `.vasp`) return `poscar`
  if (ext === `.extxyz`) return `extxyz`
  if (ext === `.xyz`) return `xyz`
  return `cif`
}

/** Infer a format string from a file extension string. */
export function format_from_ext(ext: string): string {
  if ([`poscar`, `vasp`, `contcar`].includes(ext)) return `poscar`
  if (ext === `extxyz`) return `extxyz`
  if (ext === `xyz`) return `xyz`
  return `cif`
}

// ========== Structure Serialization ==========

import type { AnyStructure as AnyStructureType } from '$lib'
import { serialize_structure } from '$lib/api/project'

/** Serialize structure to text: frontend first (preserves pseudo-H, selective dynamics),
 *  backend fallback for unsupported formats. */
export async function serialize_structure_content(structure: Record<string, unknown>, format: string): Promise<string> {
  try {
    const { structure_to_cif_str, structure_to_poscar_str, structure_to_xyz_str, structure_to_extxyz_str, structure_to_json_str } = await import(`$lib/structure/export`)
    const s = structure as AnyStructureType
    if (format === `poscar`) return structure_to_poscar_str(s)
    if (format === `xyz`) return structure_to_xyz_str(s)
    if (format === `extxyz`) return structure_to_extxyz_str(s)
    if (format === `json`) return structure_to_json_str(s)
    return structure_to_cif_str(s)
  } catch {
    const result = await serialize_structure(structure, format)
    return result.content
  }
}
