/**
 * Wavefunction files (.fchk/.molden/.wfn/.wfx): orbital list from the backend
 * and Multiwfn-generated orbital cubes.
 */

import { API_BASE } from "$lib/api/config";

export type OrbitalSpin = `restricted` | `alpha` | `beta`;

export interface Orbital {
  /** 1-based index as Multiwfn numbers it (beta follows all alpha). */
  index: number;
  /** 1-based index within its spin set. */
  number: number;
  spin: OrbitalSpin;
  /** Hartree; null when the file stores none. */
  energy: number | null;
  energy_ev: number | null;
  occupation: number;
}

export interface FrontierInfo {
  homo: number | null;
  lumo: number | null;
  gap: number | null;
  gap_ev: number | null;
}

export interface WavefunctionInfo {
  session_id: string;
  format: `fchk` | `molden` | `wfn` | `wfx`;
  filename: string;
  title: string;
  atoms: { Z: number; symbol: string; xyz: [number, number, number] }[];
  /** XYZ text (Angstrom) for loading the geometry into the viewer. */
  xyz: string;
  charge: number | null;
  multiplicity: number | null;
  /** Hartree */
  energy: number | null;
  unrestricted: boolean;
  orbitals: Orbital[];
  frontier: Partial<Record<OrbitalSpin, FrontierInfo>>;
}

export interface MultiwfnStatus {
  found: boolean;
  path: string | null;
  source: string | null;
}

export type GridQuality = `low` | `medium` | `high`;

const WAVEFUNCTION_RE = /\.(fchk|fch|molden|molden\.input|wfn|wfx)$/i;
const MULTIWFN_PATH_KEY = `catgo.multiwfn_path`;

export function is_wavefunction_file(filename: string): boolean {
  return WAVEFUNCTION_RE.test(filename);
}

async function error_detail(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail ?? `${res.status} ${res.statusText}`;
}

export async function load_wavefunction(
  content: string | ArrayBuffer,
  filename: string,
): Promise<WavefunctionInfo> {
  const form = new FormData();
  form.append(`file`, new File([content], filename));
  const res = await fetch(`${API_BASE}/wavefunction/load`, {
    method: `POST`,
    body: form,
  });
  if (!res.ok) throw new Error(await error_detail(res));
  return res.json();
}

export async function multiwfn_status(path?: string): Promise<MultiwfnStatus> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ``;
  const res = await fetch(`${API_BASE}/wavefunction/multiwfn-status${query}`);
  if (!res.ok) throw new Error(await error_detail(res));
  return res.json();
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
    headers: { "Content-Type": `application/json` },
    body: JSON.stringify({
      session_id,
      orbital_index,
      grid,
      multiwfn_path: multiwfn_path || null,
    }),
  });
  if (!res.ok) throw new Error(await error_detail(res));
  return res.text();
}

/** Saved Multiwfn path (per browser); empty when unset or storage is blocked. */
export function get_saved_multiwfn_path(): string {
  try {
    return localStorage.getItem(MULTIWFN_PATH_KEY) ?? ``;
  } catch {
    return ``;
  }
}

export function save_multiwfn_path(path: string): void {
  try {
    if (path) localStorage.setItem(MULTIWFN_PATH_KEY, path);
    else localStorage.removeItem(MULTIWFN_PATH_KEY);
  } catch {
    // storage unavailable: the path just isn't remembered
  }
}

/** "HOMO", "HOMO-2", "LUMO+1" … relative to the frontier orbitals of a spin set. */
export function frontier_label(
  orbital: Orbital,
  frontier?: FrontierInfo,
): string {
  if (!frontier) return ``;
  const { homo, lumo } = frontier;
  if (homo !== null && orbital.index <= homo) {
    const d = homo - orbital.index;
    return d === 0 ? `HOMO` : d <= 10 ? `HOMO-${d}` : ``;
  }
  if (lumo !== null && orbital.index >= lumo) {
    const d = orbital.index - lumo;
    return d === 0 ? `LUMO` : d <= 10 ? `LUMO+${d}` : ``;
  }
  return ``;
}

// ── analyses (step 3/4) ──

export interface PlotlyData {
  traces: unknown[];
  layout: Record<string, unknown>;
  annotations: unknown[];
  n_points?: number;
}

export interface IriResult {
  iri_cube: string;
  sl2r_cube: string;
  scatter: PlotlyData;
}

export interface IgmhResult {
  dg_inter_cube: string;
  sl2r_cube: string;
  scatter: PlotlyData;
}

export interface EspResult {
  density_cube: string;
  esp_cube: string;
}

export type CpKind = `NCP` | `BCP` | `RCP` | `CCP`;

export interface CriticalPoint {
  index: number;
  type: string;
  kind: CpKind;
  position: [number, number, number];
  rho?: number;
  laplacian?: number;
  G?: number;
  V?: number;
  H?: number;
  ELF?: number;
  ellipticity?: number;
  eta?: number;
  nucleus?: number;
  element?: string;
  /** 1-based atoms a BCP links */
  atoms?: [number, number];
}

export interface AimResult {
  critical_points: CriticalPoint[];
  bond_paths: {
    cp: number;
    atoms: [number, number];
    points: [number, number, number][];
  }[];
  counts: Partial<Record<CpKind, number>>;
}

export interface NboCharge {
  atom: number;
  symbol: string;
  charge: number;
  core: number;
  valence: number;
  rydberg: number;
  total: number;
}

export interface NboE2 {
  donor_index: number;
  donor: string;
  acceptor_index: number;
  acceptor: string;
  /** kcal/mol */
  e2: number;
  gap: number;
  fock: number;
  spin: `alpha` | `beta` | null;
}

export interface NboResult {
  charges: NboCharge[];
  wiberg: number[][];
  bonds: { atoms: [number, number]; wbi: number }[];
  e2: NboE2[];
  n_e2: number;
}

interface AnalysisBody {
  session_id: string;
  grid?: GridQuality;
  multiwfn_path?: string | null;
  [key: string]: unknown;
}

async function post_json<T>(path: string, body: AnalysisBody): Promise<T> {
  const res = await fetch(`${API_BASE}/wavefunction/${path}`, {
    method: `POST`,
    headers: { "Content-Type": `application/json` },
    body: JSON.stringify({
      ...body,
      multiwfn_path: body.multiwfn_path || null,
    }),
  });
  if (!res.ok) throw new Error(await error_detail(res));
  return res.json();
}

export const run_iri = (body: AnalysisBody) =>
  post_json<IriResult>(`iri`, body);
export const run_igmh = (body: AnalysisBody & { fragments: number[][] }) =>
  post_json<IgmhResult>(`igmh`, body);
export const run_esp = (body: AnalysisBody) =>
  post_json<EspResult>(`esp`, body);
export const run_aim = (body: AnalysisBody) =>
  post_json<AimResult>(`aim`, body);

export async function load_nbo(
  content: string | ArrayBuffer,
  filename: string,
): Promise<NboResult> {
  const form = new FormData();
  form.append(`file`, new File([content], filename));
  const res = await fetch(`${API_BASE}/wavefunction/nbo`, {
    method: `POST`,
    body: form,
  });
  if (!res.ok) throw new Error(await error_detail(res));
  return res.json();
}

/** "1-3, 7" → [1, 2, 3, 7]; throws on malformed input. */
export function parse_atom_ranges(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad atom range "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) throw new Error(`Bad atom range "${part}"`);
    for (let k = a; k <= b; k++) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

/** Whether text looks like Gaussian/ORCA output containing NBO results. */
export function has_nbo_results(text: string): boolean {
  return /Summary of Natural Population Analysis|SECOND ORDER PERTURBATION THEORY ANALYSIS/
    .test(
      text,
    );
}
