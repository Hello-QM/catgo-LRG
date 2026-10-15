/**
 * Wavefunction files (.fchk/.molden/.wfn/.wfx) and NBO output. Everything
 * runs in the browser: wavefunctions in the built-in engine (engine.ts, a
 * Rust/WASM port of parts of Multiwfn), NBO output in nbo.ts.
 */

import { open_wavefunction } from "./engine";
import { parse_nbo } from "./nbo";

export type OrbitalSpin = `restricted` | `alpha` | `beta`;

export interface Orbital {
  /** 1-based index in the file's orbital list (beta follows all alpha). */
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
  /** Handle of the file in the built-in engine */
  key: string;
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
  n_electrons: number;
  /** Tr(P·S); differs from n_electrons for an inconsistent file */
  trace_ps: number;
}

export type GridQuality = `low` | `medium` | `high`;

const WAVEFUNCTION_RE = /\.(fchk|fch|molden|molden\.input|wfn|wfx)$/i;

export function is_wavefunction_file(filename: string): boolean {
  return WAVEFUNCTION_RE.test(filename);
}

/** Parse a wavefunction file in the built-in engine. */
export async function load_wavefunction(
  content: string | ArrayBuffer,
  filename: string,
): Promise<WavefunctionInfo> {
  const text = typeof content === `string`
    ? content
    : new TextDecoder().decode(content);
  const { key, info, trace_ps } = await open_wavefunction(text, filename);
  return {
    ...(info as Omit<WavefunctionInfo, `key` | `filename` | `trace_ps`>),
    key,
    filename,
    trace_ps,
  };
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

// ── analyses ──

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
  /** Å */
  position: [number, number, number];
  rho: number;
  laplacian: number;
  G: number;
  V: number;
  H: number;
  ELF: number;
  ellipticity: number;
  eta: number;
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
  /** n(NCP) − n(BCP) + n(RCP) − n(CCP); 1 when the search is complete */
  poincare_hopf: number;
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

/** NBO results from Gaussian/ORCA output text. */
export async function load_nbo(
  content: string | ArrayBuffer,
  _filename = ``,
): Promise<NboResult> {
  const text = typeof content === `string`
    ? content
    : new TextDecoder().decode(content);
  return parse_nbo(text);
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
    .test(text);
}
