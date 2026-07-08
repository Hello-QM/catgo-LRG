/**
 * Shared validation helpers and constants used across export targets.
 */
import type { AnyStructure, PymatgenStructure } from '$lib'
import { download } from '$lib/io/fetch'

// ====== MAGMOM Database ======
export const MAGMOM_DATABASE: Record<string, number> = {
  Mn: 4.058, Cr: 3.629, Fe: 3.097, V: 2.335, Co: 1.811, Mo: 1.054,
  Ti: 1.02, Rh: 0.875, Ni: 0.761, Re: 0.739, Ce: 0.731, Os: 0.72,
  Ir: 0.613, Nb: 0.545, W: 0.518, Pt: 0.369, Ru: 0.344, Pd: 0.265, Zr: 0.226,
}
export const MAGMOM_DEFAULT = 0.6

// ====== Atomic Masses ======
export const ATOMIC_MASSES: Record<string, number> = {
  H: 1.008, He: 4.003, Li: 6.941, Be: 9.012, B: 10.81, C: 12.011,
  N: 14.007, O: 15.999, F: 18.998, Ne: 20.180, Na: 22.990, Mg: 24.305,
  Al: 26.982, Si: 28.086, P: 30.974, S: 32.065, Cl: 35.453, Ar: 39.948,
  K: 39.098, Ca: 40.078, Ti: 47.867, V: 50.942, Cr: 51.996, Mn: 54.938,
  Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Ga: 69.723,
  Ge: 72.630, As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798,
  Rb: 85.468, Sr: 87.62, Zr: 91.224, Mo: 95.95, Ru: 101.07, Rh: 102.91,
  Pd: 106.42, Ag: 107.87, Cd: 112.41, In: 114.82, Sn: 118.71,
  Sb: 121.76, Te: 127.60, I: 126.90, Xe: 131.29, Cs: 132.91, Ba: 137.33,
  La: 138.91, Ce: 140.12, Pt: 195.08, Au: 196.97, Hg: 200.59,
  Tl: 204.38, Pb: 207.2, Bi: 208.98, W: 183.84, Re: 186.21, Os: 190.23,
  Ir: 192.22,
}

/** Approximate atomic mass for topology generation */
export function get_atom_mass(element: string): number {
  return ATOMIC_MASSES[element] ?? 0
}

/** Atomic weight map used by the QE / LAMMPS local generators. Backed by the full
 *  ATOMIC_MASSES table so less-common elements (Li, P, Ge, S, F, Mg, Ni, Ti, Ru,
 *  Co, Zr, …) get correct masses instead of a placeholder 1.000. */
export const ATOMIC_WEIGHTS_SMALL: Record<string, number> = { ...ATOMIC_MASSES }

/** Extended atomic weight map used by ABACUS */
export const ATOMIC_WEIGHTS_ABACUS: Record<string, number> = {
  H: 1.008, He: 4.003, Li: 6.941, Be: 9.012, B: 10.81, C: 12.01, N: 14.01, O: 16.00,
  F: 19.00, Ne: 20.18, Na: 22.99, Mg: 24.31, Al: 26.98, Si: 28.09, P: 30.97, S: 32.07,
  Cl: 35.45, Ar: 39.95, K: 39.10, Ca: 40.08, Sc: 44.96, Ti: 47.87, V: 50.94, Cr: 52.00,
  Mn: 54.94, Fe: 55.85, Co: 58.93, Ni: 58.69, Cu: 63.55, Zn: 65.38, Ga: 69.72, Ge: 72.63,
  As: 74.92, Se: 78.97, Br: 79.90, Kr: 83.80, Rb: 85.47, Sr: 87.62, Y: 88.91, Zr: 91.22,
  Nb: 92.91, Mo: 95.95, Ru: 101.1, Rh: 102.9, Pd: 106.4, Ag: 107.9, Cd: 112.4, In: 114.8,
  Sn: 118.7, Sb: 121.8, Te: 127.6, I: 126.9, Xe: 131.3, Cs: 132.9, Ba: 137.3, La: 138.9,
  Ce: 140.1, Pt: 195.1, Au: 197.0, Pb: 207.2, Bi: 209.0,
}

/** Parse "1-5,8,10-12" style indices string to a set of 0-based indices */
export function parse_index_range(s: string, max_idx: number): Set<number> {
  const result = new Set<number>()
  if (!s.trim()) return result
  for (const part of s.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const range_match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range_match) {
      const lo = parseInt(range_match[1]) - 1  // user inputs 1-based
      const hi = parseInt(range_match[2]) - 1
      for (let i = Math.max(0, lo); i <= Math.min(hi, max_idx - 1); i++) result.add(i)
    } else {
      const idx = parseInt(trimmed) - 1  // 1-based to 0-based
      if (!isNaN(idx) && idx >= 0 && idx < max_idx) result.add(idx)
    }
  }
  return result
}

/** Extract unique sorted elements from a structure */
export function get_unique_elements(structure: AnyStructure): string[] {
  if (!structure?.sites) return []
  const elements = new Set<string>()
  for (const site of structure.sites) {
    const species = site.species?.[0]
    if (species?.element) elements.add(species.element)
  }
  return Array.from(elements).sort()
}

/** Get constrained atoms info from structure */
export function get_constrained_atoms_info(structure: AnyStructure): {
  count: number
  details: { idx: number; element: string; constraint: [boolean, boolean, boolean] }[]
} {
  if (!structure?.sites) return { count: 0, details: [] }
  const details: { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] = []
  structure.sites.forEach((site, idx) => {
    const sd = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
    if (sd && !(sd[0] && sd[1] && sd[2])) {
      details.push({ idx, element: site.species?.[0]?.element || 'X', constraint: sd })
    }
  })
  return { count: details.length, details }
}

/** Auto-generate MAGMOM string from structure */
export function generate_magmom_string(
  structure: AnyStructure,
  overrides: Record<string, number>,
): string {
  if (!structure?.sites) return ''

  const element_counts = new Map<string, number>()
  for (const site of structure.sites) {
    const el = site.species?.[0]?.element || 'X'
    element_counts.set(el, (element_counts.get(el) || 0) + 1)
  }

  const magmom_parts: string[] = []
  for (const [el, count] of element_counts.entries()) {
    const moment = overrides[el] ?? MAGMOM_DATABASE[el] ?? MAGMOM_DEFAULT
    magmom_parts.push(`${count}*${moment.toFixed(3)}`)
  }

  return magmom_parts.join(' ')
}

/** Download a text file. Delegates to the shared `download()` helper so the
 *  Tauri desktop app's native save dialog (installed by `init_tauri`) is used.
 *  A raw `<a download>` click is silently ignored by WebKitGTK, so the export
 *  panels' download buttons did nothing in the desktop app. `download()` still
 *  falls back to `showSaveFilePicker` / `<a>` in a plain browser. */
export function download_file(content: string, filename: string): void {
  download(content, filename, 'text/plain')
}

/** Common fix mode / selective dynamics parameters */
export interface FixAtomParams {
  fix_mode: 'none' | 'selected' | 'z_below'
  fix_z_threshold: number
  selected_indices: number[]
  constrained_atoms_info: { count: number; details: { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] }
}

/** Build selective dynamics array for a structure */
export function build_selective_dynamics(
  structure: AnyStructure,
  params: FixAtomParams,
): [boolean, boolean, boolean][] {
  const sites = structure.sites || []
  const sd = sites.map(s => (s.properties?.selective_dynamics as [boolean, boolean, boolean]) || [true, true, true]) as [boolean, boolean, boolean][]
  if (params.fix_mode === 'selected') {
    params.selected_indices.forEach(i => { if (i < sd.length) sd[i] = [false, false, false] })
  } else if (params.fix_mode === 'z_below') {
    sites.forEach((s, i) => { if (s.xyz && s.xyz[2] < params.fix_z_threshold) sd[i] = [false, false, false] })
  }
  return sd
}
