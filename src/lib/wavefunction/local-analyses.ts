/**
 * Orbital and IRI analyses computed in the browser by the built-in engine
 * (engine.ts) — no Multiwfn executable or backend needed.
 */

import { cube_text, evaluate_grid, grid_for } from "./engine";
import type {
  GridQuality,
  IriResult,
  PlotlyData,
  WavefunctionInfo,
} from "./api";

export const SL2R_RANGE: [number, number] = [-0.04, 0.02];
const BGR_COLORSCALE = [[0, `#0000ff`], [0.04 / 0.06, `#00ff00`], [
  1,
  `#ff0000`,
]];

function local_key(wf: WavefunctionInfo): string {
  if (!wf.local_key) {
    throw new Error(`This wavefunction was not loaded by the built-in engine`);
  }
  return wf.local_key;
}

/** Cube text of one orbital (1-based index as listed in `wf.orbitals`). */
export async function local_orbital_cube(
  wf: WavefunctionInfo,
  orbital_index: number,
  quality: GridQuality,
): Promise<string> {
  const key = local_key(wf);
  const grid = await grid_for(key, quality);
  const [values] = await evaluate_grid(key, `orbital`, grid, orbital_index);
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
  const key = local_key(wf);
  const grid = await grid_for(key, quality);
  const [iri, sl2r] = await evaluate_grid(key, `iri_sl2r`, grid);
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
