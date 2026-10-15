// Built-in wavefunction engine (wfn-wasm, a Rust port of parts of Multiwfn)
// driven end to end from the UI-facing API. Workers are unavailable here, so
// the engine runs on the main thread with the real WASM module.
import { parse_cube_full } from "$lib/cube/parse-cube";
import {
  load_wavefunction,
  type WavefunctionInfo,
} from "$lib/wavefunction/api";
import { cube_text, evaluate_grid, grid_for } from "$lib/wavefunction/engine";
import {
  local_iri,
  local_orbital_cube,
  scatter_plot,
} from "$lib/wavefunction/local-analyses";
import { use_wfn_module, type WfnModule } from "$lib/wavefunction/wfn-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const PKG = resolve(__dirname, `../../../src/lib/wavefunction/wfn-wasm-pkg`);
const DATA = resolve(__dirname, `../../../extensions/wfn-wasm/tests/data`);
const built = existsSync(`${PKG}/wfn_wasm_bg.wasm`);

describe(`cube_text`, () => {
  test(`writes a Gaussian cube the viewer can read back`, () => {
    const grid = {
      origin: [-1, -2, -3] as [number, number, number],
      spacing: [0.5, 0.5, 0.5] as [number, number, number],
      dims: [2, 3, 7] as [number, number, number],
    };
    const values = Float64Array.from({ length: 42 }, (_, i) => (i - 20) * 1e-3);
    const text = cube_text(grid, [{ Z: 8, xyz: [0, 0, 0] }], values, `test`);
    const { header, grid: g } = parse_cube_full(text);
    expect(header.n_atoms ?? header.atoms?.length ?? 1).toBe(1);
    expect(g.dims).toEqual([2, 3, 7]);
    expect(g.data[0]).toBeCloseTo(-0.02, 8);
    expect(g.data[41]).toBeCloseTo(0.021, 8);
    // Bohr in the file, Å after parsing
    expect(g.origin[0]).toBeCloseTo(-0.529177, 5);
    // 7 values per (x, y) column → rows of 6 + 1
    expect(text.trim().split(`\n`).length).toBe(6 + 1 + 2 * 3 * 2);
  });
});

describe(`scatter_plot`, () => {
  test(`keeps points in range and caps their number`, () => {
    const x = [-0.06, -0.01, 0.0, 0.01, 0.03];
    const y = [0.5, 0.5, 3, 0.2, 0.4];
    const plot = scatter_plot(x, y, `IRI`, 1.5);
    expect(plot.n_points).toBe(3);
    const trace = plot.traces[0] as { x: number[] };
    expect(trace.x).toEqual([-0.01, 0.01, 0.03]);
    const many = Array.from({ length: 500 }, (_, i) => (i - 250) * 1e-4);
    const capped = scatter_plot(many, many.map(() => 1), `IRI`, 1.5, [
      -0.05,
      0.05,
    ], 100);
    expect((capped.traces[0] as { x: number[] }).x).toHaveLength(100);
    expect(capped.n_points).toBe(500);
  });
});

describe.skipIf(!built)(`wfn-wasm engine`, () => {
  beforeAll(async () => {
    const mod =
      (await import(/* @vite-ignore */ `${PKG}/wfn_wasm.js`)) as WfnModule;
    await mod.default({
      module_or_path: readFileSync(`${PKG}/wfn_wasm_bg.wasm`),
    });
    use_wfn_module(mod);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function load(name: string): Promise<WavefunctionInfo> {
    vi.stubGlobal(`Worker`, undefined);
    // no backend: only the analyses that still need Multiwfn are affected
    vi.stubGlobal(
      `fetch`,
      vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
      }),
    );
    return load_wavefunction(readFileSync(`${DATA}/${name}`, `utf8`), name);
  }

  test(`loads a file without the backend`, async () => {
    const wf = await load(`ch2_triplet.fchk`);
    expect(wf.session_id).toBeNull();
    expect(wf.local_key).toBeTruthy();
    expect(wf.format).toBe(`fchk`);
    expect(wf.unrestricted).toBe(true);
    expect(wf.multiplicity).toBe(3);
    expect(wf.atoms.map((a) => a.symbol)).toEqual([`C`, `H`, `H`]);
    expect(wf.trace_ps).toBeCloseTo(8, 6);
    expect(wf.n_electrons).toBe(8);
    const alpha = wf.frontier.alpha!;
    expect(wf.orbitals[alpha.homo! - 1].occupation).toBe(1);
    expect(wf.orbitals[alpha.lumo! - 1].occupation).toBe(0);
  });

  test(`orbital cube on a Multiwfn-style grid`, async () => {
    const wf = await load(`nh3_cart.molden`);
    const homo = wf.frontier.restricted!.homo!;
    const text = await local_orbital_cube(wf, homo, `low`);
    const { grid } = parse_cube_full(text);
    const n = grid.dims[0] * grid.dims[1] * grid.dims[2];
    expect(n / 125000).toBeGreaterThan(0.9);
    expect(n / 125000).toBeLessThan(1.1);
    const max = grid.data.reduce(
      (m: number, v: number) => Math.max(m, Math.abs(v)),
      0,
    );
    expect(max).toBeGreaterThan(0.1);
    // orbital normalised: Σ ψ² dV ≈ 1 even on a coarse grid
    const dv = (0.52917721 ** -3) * grid.voxel_axes[0][0] *
      grid.voxel_axes[1][1] * grid.voxel_axes[2][2];
    const norm = grid.data.reduce((s: number, v: number) => s + v * v, 0) * dv;
    expect(norm).toBeGreaterThan(0.9);
    expect(norm).toBeLessThan(1.1);
  });

  test(`density integrates to the electron count; slabs assemble in order`, async () => {
    const wf = await load(`h2o_tz.molden`);
    const key = wf.local_key!;
    const grid = await grid_for(key, `low`);
    const [rho] = await evaluate_grid(key, `density`, grid);
    const dv = grid.spacing[0] * grid.spacing[1] * grid.spacing[2];
    const n = rho.reduce((s, v) => s + v, 0) * dv;
    // a 0.35 Bohr grid misses part of the O 1s cusp
    expect(n).toBeGreaterThan(9);
    expect(n).toBeLessThan(10.5);
    // largest value at the grid point nearest the O nucleus
    const [nx, ny, nz] = grid.dims;
    let best = 0;
    for (let p = 1; p < rho.length; p++) if (rho[p] > rho[best]) best = p;
    const at = [
      Math.floor(best / (ny * nz)),
      Math.floor(best / nz) % ny,
      best % nz,
    ];
    const o = wf.atoms[0].xyz.map((c) => c / 0.529177210903);
    at.forEach((idx, d) =>
      expect(Math.abs(grid.origin[d] + idx * grid.spacing[d] - o[d]))
        .toBeLessThan(grid.spacing[d])
    );
    expect(nx * ny * nz).toBe(rho.length);
  });

  test(`IRI with sign(λ2)ρ colouring grid and scatter`, async () => {
    const wf = await load(`nh3_cart.wfx`);
    const r = await local_iri(wf, `low`);
    const iri = parse_cube_full(r.iri_cube).grid;
    const sl2r = parse_cube_full(r.sl2r_cube).grid;
    expect(iri.dims).toEqual(sl2r.dims);
    // far from the molecule ρ < 5e-5 → IRI = 5 (Multiwfn's IRI_rhocut)
    expect(iri.data[0]).toBe(5);
    // covalent bonds: negative sign(λ2)ρ somewhere, and points in the scatter
    expect(sl2r.data.reduce((m: number, v: number) => Math.min(m, v), 0))
      .toBeLessThan(-0.1);
    // a lone NH3 has no weak interactions in the default ±0.05 window …
    expect(r.scatter.n_points).toBe(0);
    // … but its N–H bond critical points (ρ ≈ 0.34, ∇ρ = 0) have IRI ≈ 0
    const wide = scatter_plot(sl2r.data, iri.data, `IRI`, 1.5, [-0.5, 0.5]);
    expect(wide.n_points).toBeGreaterThan(0);
    expect(Math.min(...(wide.traces[0] as { x: number[] }).x)).toBeLessThan(
      -0.2,
    );
  });

  test(`a broken file reports the parser error`, async () => {
    vi.stubGlobal(`Worker`, undefined);
    vi.stubGlobal(
      `fetch`,
      vi.fn(async () => {
        throw new TypeError(`Failed to fetch`);
      }),
    );
    await expect(load_wavefunction(`not a checkpoint`, `x.fchk`)).rejects
      .toThrow(/Atomic numbers/);
  });
});
