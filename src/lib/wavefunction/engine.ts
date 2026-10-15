/**
 * Built-in wavefunction engine: wfn-wasm (Rust port of parts of Multiwfn)
 * in a pool of Web Workers. Grids are split into x-slabs evaluated in
 * parallel, then written as Gaussian cube text for the cube viewer.
 *
 * Multiwfn: Tian Lu, Feiwu Chen, J. Comput. Chem. 33, 580 (2012);
 *           Tian Lu, J. Chem. Phys. 161, 082503 (2024).
 */

import {
  type CoreRequest,
  type CoreResponse,
  type GridArgs,
  type GridKind,
  type GridSpec,
  run_core,
} from "./wfn-core";

export type { GridArgs, GridKind, GridSpec };

interface Slot {
  worker: Worker;
  loaded: Set<string>;
}

type Pending = {
  resolve: (r: CoreResponse) => void;
  reject: (e: Error) => void;
};

const MAX_WORKERS = 8;
let pool: Slot[] | null = null;
let next_id = 1;
const pending = new Map<number, Pending>();
/** File text per key, sent to a worker the first time it needs that file */
const files = new Map<string, { text: string; filename: string }>();
let next_key = 1;

function worker_count(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function make_pool(): Slot[] | null {
  if (typeof Worker === `undefined`) return null;
  try {
    return Array.from({ length: worker_count() }, () => {
      const worker = new Worker(new URL(`./wfn.worker.ts`, import.meta.url), {
        type: `module`,
      });
      worker.onmessage = (event: MessageEvent) => {
        const { id, res, error } = event.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve(res);
      };
      return { worker, loaded: new Set<string>() };
    });
  } catch {
    return null;
  }
}

function post(slot: Slot, req: CoreRequest): Promise<CoreResponse> {
  const id = next_id++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.worker.postMessage({ id, req });
  });
}

/** Run `req` on worker `k` (or the main thread), loading the file there first. */
async function run_on(
  k: number,
  key: string,
  req: CoreRequest,
): Promise<CoreResponse> {
  pool ??= make_pool();
  const file = files.get(key);
  if (!file) throw new Error(`Wavefunction ${key} is not loaded`);
  if (!pool) {
    await run_core({ op: `load`, key, ...file });
    return run_core(req);
  }
  const slot = pool[k % pool.length];
  if (!slot.loaded.has(key)) {
    await post(slot, { op: `load`, key, ...file });
    slot.loaded.add(key);
  }
  return post(slot, req);
}

export interface LocalWavefunction {
  key: string;
  info: Record<string, unknown>;
  /** Tr(P·S); differs from the electron count for an inconsistent file */
  trace_ps: number;
}

/** Parse a wavefunction file in a worker; returns its summary. */
export async function open_wavefunction(
  text: string,
  filename: string,
): Promise<LocalWavefunction> {
  const key = `wfn${next_key++}`;
  files.set(key, { text, filename });
  try {
    const res = await run_on(0, key, { op: `load`, key, text, filename });
    if (!(`info_json` in res)) throw new Error(`unexpected worker reply`);
    return { key, info: JSON.parse(res.info_json), trace_ps: res.trace_ps };
  } catch (err) {
    files.delete(key);
    throw err;
  }
}

/** Forget a file in all workers. */
export function close_wavefunction(key: string): void {
  if (!files.delete(key)) return;
  for (const slot of pool ?? []) {
    if (slot.loaded.delete(key)) {
      post(slot, { op: `drop`, key }).catch(() => {});
    }
  }
  if (!pool) run_core({ op: `drop`, key }).catch(() => {});
}

export async function grid_for(
  key: string,
  quality: string,
): Promise<GridSpec> {
  const res = await run_on(0, key, { op: `grid`, key, quality });
  if (!(`grid` in res)) throw new Error(`unexpected worker reply`);
  return res.grid;
}

function n_workers(): number {
  return pool?.length ?? worker_count();
}

/**
 * Evaluate a grid function. Returns one Float64Array per block (iri_sl2r and
 * igmh_sl2r have two, the second being sign(λ2)ρ), each in cube order
 * (x slowest, z fastest).
 */
export async function evaluate_grid(
  key: string,
  kind: GridKind,
  grid: GridSpec,
  args: GridArgs = {},
): Promise<Float64Array[]> {
  const [nx, ny, nz] = grid.dims;
  // A few slabs per worker keeps them busy when slab costs differ
  const n_slabs = Math.max(1, Math.min(nx, n_workers() * 3));
  const bounds = Array.from(
    { length: n_slabs + 1 },
    (_, k) => Math.round((k * nx) / n_slabs),
  );
  const parts = await Promise.all(
    bounds.slice(0, -1).map(async (ix0, k) => {
      const res = await run_on(k, key, {
        op: `evaluate`,
        key,
        kind,
        args,
        grid,
        ix0,
        ix1: bounds[k + 1],
      });
      if (!(`data` in res)) throw new Error(`unexpected worker reply`);
      return { ix0, ix1: bounds[k + 1], data: res.data };
    }),
  );
  const n = nx * ny * nz;
  const n_blocks = kind === `iri_sl2r` || kind === `igmh_sl2r` ? 2 : 1;
  const blocks = Array.from({ length: n_blocks }, () => new Float64Array(n));
  for (const { ix0, ix1, data } of parts) {
    const m = (ix1 - ix0) * ny * nz;
    for (let b = 0; b < n_blocks; b++) {
      blocks[b].set(data.subarray(b * m, (b + 1) * m), ix0 * ny * nz);
    }
  }
  return blocks;
}

/** Electrostatic potential (a.u.) at the listed flat grid indices. */
export async function esp_at(
  key: string,
  grid: GridSpec,
  indices: Uint32Array,
): Promise<Float64Array> {
  const n_chunks = Math.max(1, Math.min(indices.length, n_workers() * 3));
  const bounds = Array.from(
    { length: n_chunks + 1 },
    (_, k) => Math.round((k * indices.length) / n_chunks),
  );
  const out = new Float64Array(indices.length);
  await Promise.all(
    bounds.slice(0, -1).map(async (start, k) => {
      const res = await run_on(k, key, {
        op: `esp_points`,
        key,
        grid,
        indices: indices.slice(start, bounds[k + 1]),
      });
      if (!(`data` in res)) throw new Error(`unexpected worker reply`);
      out.set(res.data, start);
    }),
  );
  return out;
}

/** Electrostatic potential (a.u.) at arbitrary points given in Å. */
export async function esp_at_points(
  key: string,
  points: [number, number, number][],
): Promise<Float64Array> {
  const xyz = Float64Array.from(points.flat().map((c) => c * ANGSTROM_TO_BOHR));
  const res = await run_on(0, key, { op: `esp_xyz`, key, xyz });
  if (!(`data` in res)) throw new Error(`unexpected worker reply`);
  return res.data;
}

/** QTAIM critical points and bond paths (JSON from the engine). */
export async function aim_json(key: string): Promise<string> {
  const res = await run_on(0, key, { op: `aim`, key });
  if (!(`json` in res)) throw new Error(`unexpected worker reply`);
  return res.json;
}

export interface CubeAtom {
  Z: number;
  /** Ångström */
  xyz: [number, number, number];
}

const ANGSTROM_TO_BOHR = 1 / 0.529177210903;

/** Gaussian cube text (Bohr) for `values` on `grid`. */
export function cube_text(
  grid: GridSpec,
  atoms: CubeAtom[],
  values: Float64Array,
  title: string,
): string {
  const f = (v: number) => v.toFixed(6).padStart(12);
  const e = (v: number) => {
    const s = v.toExponential(5).replace(/e([+-])(\d)$/, `e$10$2`);
    return ` ${v < 0 ? `` : ` `}${s.toUpperCase()}`;
  };
  const [nx, ny, nz] = grid.dims;
  const lines = [
    title,
    `Generated by CatGo (wavefunction engine ported from Multiwfn)`,
    `${String(atoms.length).padStart(5)}${grid.origin.map(f).join(``)}`,
    `${String(nx).padStart(5)}${f(grid.spacing[0])}${f(0)}${f(0)}`,
    `${String(ny).padStart(5)}${f(0)}${f(grid.spacing[1])}${f(0)}`,
    `${String(nz).padStart(5)}${f(0)}${f(0)}${f(grid.spacing[2])}`,
  ];
  for (const a of atoms) {
    const r = a.xyz.map((c) => c * ANGSTROM_TO_BOHR);
    lines.push(`${String(a.Z).padStart(5)}${f(a.Z)}${r.map(f).join(``)}`);
  }
  const out: string[] = [lines.join(`\n`), `\n`];
  let p = 0;
  for (let i = 0; i < nx * ny; i++) {
    let row = ``;
    for (let k = 0; k < nz; k++) {
      row += e(values[p++]);
      if (k % 6 === 5 || k === nz - 1) {
        out.push(row, `\n`);
        row = ``;
      }
    }
  }
  return out.join(``);
}
