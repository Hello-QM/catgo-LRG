/**
 * Pane / tab types and pure helper functions — extracted from App.svelte.
 *
 * These are non-reactive, pure functions that operate on pane and tab data.
 */

import type { AnyStructure } from '$lib'

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
}

export type LayoutType = 'single' | 'splitH' | 'splitV' | 'quad'

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
}

export interface StructureTabState {
  panes: PaneState[]
  layout: LayoutType
  active_pane: number
  close_confirm_pane: number | null
  col_split: number
  row_split: number
  /** Per-tab structure library (sidebar). Cleared automatically on tab close. */
  library: LibraryEntry[]
  active_library_id: string | null
}

// ========== Pure Functions ==========

export function layout_panel_count(layout: LayoutType): number {
  if (layout === 'single') return 1
  if (layout === 'splitH' || layout === 'splitV') return 2
  return 4
}

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
  return {
    panes: [create_empty_pane(), create_empty_pane(), create_empty_pane(), create_empty_pane()],
    layout: 'single',
    active_pane: 0,
    close_confirm_pane: null,
    col_split: 50,
    row_split: 50,
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

/** Determine the import target pane when loading a new structure into a tab. */
export function find_import_target_pane(ts: StructureTabState, source_pane: number): number {
  const { panes } = ts
  const source_has_content = pane_has_content(panes[source_pane])
  if (!source_has_content) return source_pane
  const panel_count = layout_panel_count(ts.layout)
  // Look for empty pane within visible panels first
  let target = -1
  for (let i = 0; i < panel_count; i++) {
    if (!pane_has_content(panes[i])) { target = i; break }
  }
  if (target < 0) {
    if (ts.layout === 'single') { ts.layout = 'splitH'; target = 1 }
    else if (ts.layout === 'splitH' || ts.layout === 'splitV') { ts.layout = 'quad'; target = 2 }
    else return -1
  }
  return target
}

// ========== Grid Layout Helpers ==========

export function get_visible_panes(ts: StructureTabState): number[] {
  return Array.from({ length: layout_panel_count(ts.layout) }, (_, i) => i)
}

export function get_grid_style(ts: StructureTabState): string {
  switch (ts.layout) {
    case 'single': return `grid-template-columns: 1fr; grid-template-rows: 1fr;`
    case 'splitH': return `grid-template-columns: ${ts.col_split}% 6px 1fr; grid-template-rows: 1fr;`
    case 'splitV': return `grid-template-columns: 1fr; grid-template-rows: ${ts.row_split}% 6px 1fr;`
    case 'quad': return `grid-template-columns: ${ts.col_split}% 6px 1fr; grid-template-rows: ${ts.row_split}% 6px 1fr;`
  }
}

export function get_pane_position(layout: LayoutType, idx: number): string {
  if (layout === 'single') return ``
  if (layout === 'splitH') return `grid-column: ${idx === 0 ? 1 : 3}; grid-row: 1;`
  if (layout === 'splitV') return `grid-column: 1; grid-row: ${idx === 0 ? 1 : 3};`
  const col = [1, 3, 1, 3][idx]
  const row = [1, 1, 3, 3][idx]
  return `grid-column: ${col}; grid-row: ${row};`
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
