/**
 * Wavefunction analyses computed in the browser by the built-in engine
 * (engine.ts): orbitals, IRI, IGMH, ESP-mapped surfaces and QTAIM.
 */

import {
  aim_json,
  cube_text,
  esp_at,
  esp_at_points,
  evaluate_grid,
  grid_for,
  type GridSpec,
} from "./engine";
import type {
  AimResult,
  EspResult,
  GridQuality,
  IgmhResult,
  IriResult,
  PlotlyData,
  WavefunctionInfo,
} from "./api";

export const SL2R_RANGE: [number, number] = [-0.04, 0.02];
const BGR_COLORSCALE = [[0, `#0000ff`], [0.04 / 0.06, `#00ff00`], [
  1,
  `#ff0000`,
]];
/** Isovalue of the van der Waals surface the ESP is mapped on (a.u.) */
export const ESP_SURFACE_RHO = 0.001;

/** Cube text of one orbital (1-based index as listed in `wf.orbitals`). */
export async function local_orbital_cube(
  wf: WavefunctionInfo,
  orbital_index: number,
  quality: GridQuality,
): Promise<string> {
  const grid = await grid_for(wf.key, quality);
  const [values] = await evaluate_grid(wf.key, `orbital`, grid, {
    orbital: orbital_index,
  });
  return cube_text(
    grid,
    wf.atoms,
    values,
    `${wf.filename} orbital ${orbital_index}`,
  );
}

/** IRI isosurface grid coloured by sign(λ2)ρ, plus the IRI vs sign(λ2)ρ scatter. */
export async function local_iri(
  wf: WavefunctionInfo,
  quality: GridQuality,
): Promise<IriResult> {
  const grid = await grid_for(wf.key, quality);
  const [iri, sl2r] = await evaluate_grid(wf.key, `iri_sl2r`, grid);
  return {
    iri_cube: cube_text(grid, wf.atoms, iri, `${wf.filename} IRI`),
    sl2r_cube: cube_text(
      grid,
      wf.atoms,
      sl2r,
      `${wf.filename} sign(lambda2)rho`,
    ),
    scatter: scatter_plot(sl2r, iri, `IRI`, 1.5),
  };
}

/** IGMH δg_inter between fragments (1-based atom lists) with sign(λ2)ρ colouring. */
export async function local_igmh(
  wf: WavefunctionInfo,
  quality: GridQuality,
  fragments: number[][],
): Promise<IgmhResult> {
  const grid = await grid_for(wf.key, quality);
  const [dg, sl2r] = await evaluate_grid(wf.key, `igmh_sl2r`, grid, {
    fragments,
  });
  return {
    dg_inter_cube: cube_text(
      grid,
      wf.atoms,
      dg,
      `${wf.filename} IGMH dg_inter`,
    ),
    sl2r_cube: cube_text(
      grid,
      wf.atoms,
      sl2r,
      `${wf.filename} sign(lambda2)rho`,
    ),
    scatter: scatter_plot(sl2r, dg, `δg_inter (a.u.)`, 0.1),
  };
}

/** Grid with every `factor`-th point of `grid` along each axis. */
export function coarsen(grid: GridSpec, factor: number): GridSpec {
  return {
    origin: grid.origin,
    spacing: grid.spacing.map((h) => h * factor) as GridSpec[`spacing`],
    dims: grid.dims.map((n) =>
      Math.floor((n - 1) / factor) + 1
    ) as GridSpec[`dims`],
  };
}

/**
 * Points of `coarse` (= coarsen(fine, factor)) needed to colour the ρ = `iso`
 * surface found on `fine`: the corners of the coarse cells holding a fine
 * cell the surface crosses, grown by one point so smoothed surface vertices
 * still sample computed values. Flat cube-order indices into `coarse`.
 */
export function surface_band(
  fine: GridSpec,
  rho: ArrayLike<number>,
  iso: number,
  coarse: GridSpec,
  factor: number,
): Uint32Array {
  const [nx, ny, nz] = fine.dims;
  const [cx, cy, cz] = coarse.dims;
  const fat = (i: number, j: number, k: number) => (i * ny + j) * nz + k;
  const cat = (i: number, j: number, k: number) => (i * cy + j) * cz + k;
  const corner = new Uint8Array(cx * cy * cz);
  for (let i = 0; i + 1 < nx; i++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let k = 0; k + 1 < nz; k++) {
        let below = false;
        let above = false;
        for (let c = 0; c < 8; c++) {
          if (
            rho[fat(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))] < iso
          ) below = true;
          else above = true;
        }
        if (!(below && above)) continue;
        const ci = Math.min(Math.floor(i / factor), cx - 2);
        const cj = Math.min(Math.floor(j / factor), cy - 2);
        const ck = Math.min(Math.floor(k / factor), cz - 2);
        for (let c = 0; c < 8; c++) {
          corner[cat(ci + (c & 1), cj + ((c >> 1) & 1), ck + ((c >> 2) & 1))] =
            1;
        }
      }
    }
  }
  const band: number[] = [];
  for (let i = 0; i < cx; i++) {
    for (let j = 0; j < cy; j++) {
      for (let k = 0; k < cz; k++) {
        let hit = false;
        for (let d = 0; d < 27 && !hit; d++) {
          const a = i + (d % 3) - 1;
          const b = j + (Math.floor(d / 3) % 3) - 1;
          const c = k + Math.floor(d / 9) - 1;
          hit = a >= 0 && b >= 0 && c >= 0 && a < cx && b < cy && c < cz &&
            corner[cat(a, b, c)] === 1;
        }
        if (hit) band.push(cat(i, j, k));
      }
    }
  }
  return Uint32Array.from(band);
}

/**
 * Density grid for the ρ = 0.001 a.u. surface and an ESP grid to colour it.
 * The ESP is smooth, so it is computed on every other density grid point
 * and only near the surface; elsewhere the ESP cube holds 0.
 */
export async function local_esp(
  wf: WavefunctionInfo,
  quality: GridQuality,
): Promise<EspResult> {
  const grid = await grid_for(wf.key, quality);
  const [rho] = await evaluate_grid(wf.key, `density`, grid);
  const coarse = coarsen(grid, 2);
  const band = surface_band(grid, rho, ESP_SURFACE_RHO, coarse, 2);
  const values = await esp_at(wf.key, coarse, band);
  const esp = new Float64Array(
    coarse.dims[0] * coarse.dims[1] * coarse.dims[2],
  );
  band.forEach((p, n) => (esp[p] = values[n]));
  return {
    density_cube: cube_text(
      grid,
      wf.atoms,
      rho,
      `${wf.filename} electron density`,
    ),
    esp_cube: cube_text(
      coarse,
      wf.atoms,
      esp,
      `${wf.filename} ESP near the rho=0.001 surface`,
    ),
  };
}

/** Exact ESP (a.u.) at positions in Å, e.g. surface extrema found on the coloured mesh. */
export async function exact_esp(
  wf: WavefunctionInfo,
  positions: [number, number, number][],
): Promise<number[]> {
  return Array.from(await esp_at_points(wf.key, positions));
}

/** QTAIM critical points (with properties) and bond paths. */
export async function local_aim(wf: WavefunctionInfo): Promise<AimResult> {
  return JSON.parse(await aim_json(wf.key));
}

/** Small deterministic PRNG (mulberry32) so repeated runs plot the same sample. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plotly data for a y vs sign(λ2)ρ scatter, sub-sampled to `max_points`. */
export function scatter_plot(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  y_label: string,
  y_max: number,
  x_range: [number, number] = [-0.05, 0.05],
  max_points = 30000,
): PlotlyData {
  const keep: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] >= x_range[0] && x[i] <= x_range[1] && y[i] > 0 && y[i] <= y_max) {
      keep.push(i);
    }
  }
  const n_points = keep.length;
  if (keep.length > max_points) {
    // partial Fisher–Yates
    const rand = rng(0);
    for (let i = 0; i < max_points; i++) {
      const j = i + Math.floor(rand() * (keep.length - i));
      [keep[i], keep[j]] = [keep[j], keep[i]];
    }
    keep.length = max_points;
  }
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const xs = keep.map((i) => round(x[i]));
  const ys = keep.map((i) => round(y[i]));
  return {
    traces: [{
      type: `scattergl`,
      mode: `markers`,
      x: xs,
      y: ys,
      marker: {
        size: 2,
        color: xs,
        colorscale: BGR_COLORSCALE,
        cmin: SL2R_RANGE[0],
        cmax: SL2R_RANGE[1],
      },
      hoverinfo: `skip`,
      showlegend: false,
    }],
    layout: {
      height: 320,
      paper_bgcolor: `rgba(0,0,0,0)`,
      plot_bgcolor: `rgba(0,0,0,0)`,
      xaxis: { title: { text: `sign(λ₂)ρ (a.u.)` }, range: x_range },
      yaxis: { title: { text: y_label }, range: [0, y_max] },
      margin: { l: 60, r: 20, t: 20, b: 50 },
    },
    annotations: [],
    n_points,
  };
}
