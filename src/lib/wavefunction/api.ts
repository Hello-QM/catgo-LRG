/**
 * Wavefunction files (.fchk/.molden/.wfn/.wfx): orbital list from the backend
 * and Multiwfn-generated orbital cubes.
 */

import { API_BASE } from '$lib/api/config'

export type OrbitalSpin = `restricted` | `alpha` | `beta`

export interface Orbital {
  /** 1-based index as Multiwfn numbers it (beta follows all alpha). */
  index: number
  /** 1-based index within its spin set. */
  number: number
  spin: OrbitalSpin
  /** Hartree; null when the file stores none. */
  energy: number | null
  energy_ev: number | null
  occupation: number
}

export interface FrontierInfo {
  homo: number | null
  lumo: number | null
  gap: number | null
  gap_ev: number | null
}

export interface WavefunctionInfo {
  session_id: string
  format: `fchk` | `molden` | `wfn` | `wfx`
  filename: string
  title: string
  atoms: { Z: number; symbol: string; xyz: [number, number, number] }[]
  /** XYZ text (Angstrom) for loading the geometry into the viewer. */
  xyz: string
  charge: number | null
  multiplicity: number | null
  /** Hartree */
  energy: number | null
  unrestricted: boolean
  orbitals: Orbital[]
  frontier: Partial<Record<OrbitalSpin, FrontierInfo>>
}

export interface MultiwfnStatus {
  found: boolean
  path: string | null
  source: string | null
}

export type GridQuality = `low` | `medium` | `high`

const WAVEFUNCTION_RE = /\.(fchk|fch|molden|molden\.input|wfn|wfx)$/i
const MULTIWFN_PATH_KEY = `catgo.multiwfn_path`

export function is_wavefunction_file(filename: string): boolean {
  return WAVEFUNCTION_RE.test(filename)
}

async function error_detail(res: Response): Promise<string> {
  const body = await res.json().catch(() => null)
  return body?.detail ?? `${res.status} ${res.statusText}`
}

export async function load_wavefunction(
  content: string | ArrayBuffer,
  filename: string,
): Promise<WavefunctionInfo> {
  const form = new FormData()
  form.append(`file`, new File([content], filename))
  const res = await fetch(`${API_BASE}/wavefunction/load`, { method: `POST`, body: form })
  if (!res.ok) throw new Error(await error_detail(res))
  return res.json()
}

export async function multiwfn_status(path?: string): Promise<MultiwfnStatus> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ``
  const res = await fetch(`${API_BASE}/wavefunction/multiwfn-status${query}`)
  if (!res.ok) throw new Error(await error_detail(res))
  return res.json()
}

/** Run Multiwfn on the server and return the orbital's cube file text. */
export async function fetch_orbital_cube(
  session_id: string,
  orbital_index: number,
  grid: GridQuality,
  multiwfn_path?: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/wavefunction/orbital-cube`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      session_id,
      orbital_index,
      grid,
      multiwfn_path: multiwfn_path || null,
    }),
  })
  if (!res.ok) throw new Error(await error_detail(res))
  return res.text()
}

/** Saved Multiwfn path (per browser); empty when unset or storage is blocked. */
export function get_saved_multiwfn_path(): string {
  try {
    return localStorage.getItem(MULTIWFN_PATH_KEY) ?? ``
  } catch {
    return ``
  }
}

export function save_multiwfn_path(path: string): void {
  try {
    if (path) localStorage.setItem(MULTIWFN_PATH_KEY, path)
    else localStorage.removeItem(MULTIWFN_PATH_KEY)
  } catch {
    // storage unavailable: the path just isn't remembered
  }
}

/** "HOMO", "HOMO-2", "LUMO+1" … relative to the frontier orbitals of a spin set. */
export function frontier_label(orbital: Orbital, frontier?: FrontierInfo): string {
  if (!frontier) return ``
  const { homo, lumo } = frontier
  if (homo !== null && orbital.index <= homo) {
    const d = homo - orbital.index
    return d === 0 ? `HOMO` : d <= 10 ? `HOMO-${d}` : ``
  }
  if (lumo !== null && orbital.index >= lumo) {
    const d = orbital.index - lumo
    return d === 0 ? `LUMO` : d <= 10 ? `LUMO+${d}` : ``
  }
  return ``
}
