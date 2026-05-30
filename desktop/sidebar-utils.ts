/**
 * Pure helper functions extracted from Sidebar.svelte.
 * These have no dependency on reactive ($state/$derived) variables.
 */

import type { FileBrowseItem } from '$lib/api/project'
import { STRUCTURE_EXTS, DB_FILE_EXTS, CHGCAR_PATTERNS } from './sidebar-data'
import type { LocalFile } from './sidebar-data'

// ========== File classification ==========

export function is_structure_file(name: string): boolean {
  const lower = name.toLowerCase()
  if (STRUCTURE_EXTS.has(lower.substring(lower.lastIndexOf(`.`)))) return true
  if (lower.includes(`poscar`) || lower.includes(`contcar`)) return true
  // CHGCAR/AECCAR/LOCPOT etc. VASP volume data files
  const basename = name.replace(/\.(gz|bz2|xz|zst)$/i, ``)
  if (CHGCAR_PATTERNS.test(basename)) return true
  if (/CHGCAR|AECCAR|LOCPOT|ELFCAR|PARCHG/i.test(basename)) return true
  return false
}

export function is_db_file(name: string): boolean {
  const lower = name.toLowerCase()
  return DB_FILE_EXTS.has(lower.substring(lower.lastIndexOf(`.`)))
}

// ========== Formatting ==========

export function format_energy(e: number | null): string {
  if (e === null || e === undefined) return ``
  return `${e.toFixed(2)} eV`
}

export function format_file_size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ========== File icon SVG path ==========

export function get_file_icon(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith(`.json`)) return `M12 3v18M3 9h18M3 15h18`
  if (lower.endsWith(`.cif`)) return `M12 3L2 9l10 6 10-6-10-6zM2 17l10 6 10-6`
  if (lower.endsWith(`.poscar`) || lower.includes(`poscar`) || lower.includes(`contcar`)) return `M12 3L2 9l10 6 10-6-10-6z`
  if (lower.endsWith(`.xyz`) || lower.endsWith(`.extxyz`)) return `M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5`
  if (lower.endsWith(`.h5`) || lower.endsWith(`.hdf5`)) return `M4 4h16v16H4zM8 4v16M16 4v16M4 12h16`
  if (lower.endsWith(`.traj`)) return `M3 12h4l3-8 4 16 3-8h4`
  return `M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z`
}

// ========== Filesystem breadcrumbs ==========

export function fs_get_breadcrumbs(dir: string): Array<{ label: string; path: string }> {
  if (!dir) return []
  const normalized_dir = dir.replace(/^\\\\\?\\([A-Za-z]:[\\/])/, `$1`)
  const is_windows_drive = /^[A-Za-z]:[\\/]/.test(normalized_dir)
  const sep = normalized_dir.includes(`\\`) ? `\\` : `/`
  const parts = is_windows_drive
    ? normalized_dir.split(/[\\/]+/).filter(Boolean)
    : normalized_dir.split(sep).filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = []
  if (is_windows_drive) {
    let acc = ``
    for (const p of parts) {
      acc = acc ? `${acc}${sep}${p}` : p
      crumbs.push({ label: p, path: acc + sep })
    }
    return crumbs
  }
  // On Unix, start with /
  if (sep === `/`) {
    crumbs.push({ label: `/`, path: `/` })
    let acc = ``
    for (const p of parts) {
      acc += `/${p}`
      crumbs.push({ label: p, path: acc })
    }
  } else {
    // Windows: first part is drive like C:
    let acc = ``
    for (const p of parts) {
      acc = acc ? `${acc}${sep}${p}` : p
      crumbs.push({ label: p, path: acc + sep })
    }
  }
  return crumbs
}

// ========== Filesystem file icon CSS class ==========

export function fs_file_icon_class(item: FileBrowseItem): string {
  if (item.type === `dir`) return `fs-icon-dir`
  if (is_db_file(item.name)) return `fs-icon-db`
  if (is_structure_file(item.name)) return `fs-icon-structure`
  return `fs-icon-file`
}

// ========== Static file list builder ==========

export function make_files(raw: Record<string, string>, mode: `raw` | `url`): LocalFile[] {
  return Object.entries(raw)
    .filter(([path]) => !path.endsWith(`index.ts`))
    .map(([path, value]) => ({
      path,
      name: path.split(/[/\\]/).pop() || path,
      ...(mode === `raw` ? { content: value } : { url: value }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
