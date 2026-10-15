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
  coarsen,
  local_aim,
  local_esp,
  local_igmh,
  local_iri,
  local_orbital_cube,
  scatter_plot,
  surface_band,
} from "$lib/wavefunction/local-analyses";
import { use_wfn_module, type WfnModule } from "$lib/wavefunction/wfn-core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

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

  // Everything runs locally: no request may leave the page
  const fetch_spy = vi.fn(async () => {
    throw new TypeError(`Failed to fetch`);
  });

  async function load(name: string): Promise<WavefunctionInfo> {
    vi.stubGlobal(`Worker`, undefined);
    vi.stubGlobal(`fetch`, fetch_spy);
    return load_wavefunction(readFileSync(`${DATA}/${name}`, `utf8`), name);
  }

  afterAll(() => expect(fetch_spy).not.toHaveBeenCalled());

  test(`loads a file in the engine`, async () => {
    const wf = await load(`ch2_triplet.fchk`);
    expect(wf.key).toMatch(/^wfn\d+$/);
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
    const key = wf.key;
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

  test(`IGMH: δg_inter isosurface around the water-dimer hydrogen bond`, async () => {
    const wf = await load(`h2o_dimer.molden`);
    const r = await local_igmh(wf, `low`, [[1, 2, 3], [4, 5, 6]]);
    const dg = parse_cube_full(r.dg_inter_cube).grid;
    const sl2r = parse_cube_full(r.sl2r_cube).grid;
    let best = 0;
    for (let p = 1; p < dg.data.length; p++) {
      if (dg.data[p] > dg.data[best]) best = p;
    }
    // strongest inter-fragment interaction: attractive (sign(λ2)ρ < 0), between H3 and O4
    expect(dg.data[best]).toBeGreaterThan(0.01);
    expect(sl2r.data[best]).toBeLessThan(-0.01);
    expect(r.scatter.n_points).toBeGreaterThan(10);
    await expect(local_igmh(wf, `low`, [[1, 2, 3]])).rejects.toThrow(/two/);
  });

  test(`ESP is computed only near the ρ = 0.001 surface, on a coarser grid`, async () => {
    const wf = await load(`h2o_tz.molden`);
    const r = await local_esp(wf, `low`);
    const rho = parse_cube_full(r.density_cube).grid;
    const esp = parse_cube_full(r.esp_cube).grid;
    expect(esp.dims).toEqual(
      rho.dims.map((n: number) => Math.floor((n - 1) / 2) + 1),
    );
    const values = Array.from(esp.data as ArrayLike<number>).filter((v) =>
      v !== 0
    );
    // a band, not the whole box
    expect(values.length).toBeGreaterThan(100);
    expect(values.length).toBeLessThan(esp.data.length / 3);
    // negative near the O lone pairs, positive near the H atoms (a.u.)
    expect(Math.min(...values)).toBeLessThan(-0.03);
    expect(Math.max(...values)).toBeGreaterThan(0.03);
  });

  test(`surface band marks coarse corners around crossing cells`, () => {
    const n = 17;
    const fine = {
      origin: [0, 0, 0] as [number, number, number],
      spacing: [1, 1, 1] as [number, number, number],
      dims: [n, n, n] as [number, number, number],
    };
    // ρ > iso only inside a small blob around the centre (8,8,8)
    const rho = new Float64Array(n ** 3);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          rho[(i * n + j) * n + k] = Math.exp(
            -((i - 8) ** 2 + (j - 8) ** 2 + (k - 8) ** 2),
          );
        }
      }
    }
    const coarse = coarsen(fine, 2);
    expect(coarse.dims).toEqual([9, 9, 9]);
    expect(coarse.spacing).toEqual([2, 2, 2]);
    const band = new Set(surface_band(fine, rho, 0.5, coarse, 2));
    expect(band.has((4 * 9 + 4) * 9 + 4)).toBe(true); // centre
    expect(band.has(0)).toBe(false); // far corner
    expect(band.size).toBeLessThan(9 ** 3 / 4);
  });

  test(`AIM: critical points and bond paths of the water dimer`, async () => {
    const wf = await load(`h2o_dimer.molden`);
    const r = await local_aim(wf);
    expect(r.counts).toMatchObject({ NCP: 6, BCP: 5 });
    expect(r.poincare_hopf).toBe(1);
    const hb = r.critical_points.find((c) =>
      c.atoms?.[0] === 3 && c.atoms?.[1] === 4
    )!;
    expect(hb.kind).toBe(`BCP`);
    expect(hb.rho).toBeGreaterThan(0.015);
    expect(hb.laplacian).toBeGreaterThan(0);
    expect(r.bond_paths).toHaveLength(5);
    const ncp = r.critical_points.find((c) => c.kind === `NCP`)!;
    expect(ncp.element).toBe(`O`);
  });

  test(`a broken file reports the parser error`, async () => {
    vi.stubGlobal(`Worker`, undefined);
    vi.stubGlobal(`fetch`, fetch_spy);
    await expect(load_wavefunction(`not a checkpoint`, `x.fchk`)).rejects
      .toThrow(/Atomic numbers/);
  });
});
