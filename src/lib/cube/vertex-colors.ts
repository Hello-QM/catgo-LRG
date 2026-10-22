/**
 * Colour an isosurface by a second volumetric grid (e.g. sign(λ2)ρ on an
 * IRI/IGMH surface, or ESP on a ρ = 0.001 a.u. surface) and locate surface
 * extrema of the mapped values.
 */

import type { CubeMesh } from "./api";
import type { VolumetricGrid } from "./parse-cube";

export type ColorScaleName = `bgr` | `esp`;

export interface ColorScale {
  name: ColorScaleName;
  min: number;
  max: number;
}

type RGB = [number, number, number];

// Stops in [0, 1] → linear RGB in [0, 1]
const STOPS: Record<ColorScaleName, (stop_at_zero: number) => [number, RGB][]> =
  {
    // blue (attractive) → green (vdW) → red (repulsive), green pinned at 0
    bgr: (zero) => [[0, [0, 0, 1]], [zero, [0, 1, 0]], [1, [1, 0, 0]]],
    // red (negative) → white (zero) → blue (positive)
    esp: (
      zero,
    ) => [[0, [0.8, 0.05, 0.05]], [zero, [1, 1, 1]], [1, [0.05, 0.2, 0.85]]],
  };

/** Position of value 0 inside [min, max], clamped to (0, 1). */
function zero_stop(min: number, max: number): number {
  if (max <= min) return 0.5;
  return Math.min(0.999, Math.max(0.001, (0 - min) / (max - min)));
}

export function color_at(value: number, scale: ColorScale): RGB {
  const stops = STOPS[scale.name](zero_stop(scale.min, scale.max));
  const span = scale.max - scale.min || 1;
  const t = Math.min(1, Math.max(0, (value - scale.min) / span));
  for (let k = 1; k < stops.length; k++) {
    const [t1, c1] = stops[k];
    if (t <= t1) {
      const [t0, c0] = stops[k - 1];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [
        c0[0] + f * (c1[0] - c0[0]),
        c0[1] + f * (c1[1] - c0[1]),
        c0[2] + f * (c1[2] - c0[2]),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** CSS linear-gradient for a colour bar of `scale` (left = min, right = max). */
export function scale_gradient_css(scale: ColorScale): string {
  const stops = STOPS[scale.name](zero_stop(scale.min, scale.max));
  const css = stops.map(([t, [r, g, b]]) =>
    `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${
      Math.round(b * 255)
    }) ${(t * 100).toFixed(1)}%`
  );
  return `linear-gradient(to right, ${css.join(`, `)})`;
}

/** Inverse of the 3×3 voxel-axis matrix (rows = step vectors). */
function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) throw new Error(`Degenerate cube voxel axes`);
  const inv = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ];
  return inv.map((row) => row.map((v) => v / det));
}

/** Trilinear sampler of `grid` at Cartesian (Å) points. */
export function make_sampler(
  grid: VolumetricGrid,
): (x: number, y: number, z: number) => number {
  const inv = invert3(grid.voxel_axes);
  const [nx, ny, nz] = grid.dims;
  const { data, origin } = grid;
  const at = (i: number, j: number, k: number) =>
    data[i * ny * nz + j * nz + k];
  return (x, y, z) => {
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    // fractional index f solves f · axes = d  →  f = d · axes⁻¹
    const fi = Math.min(
      nx - 1,
      Math.max(0, dx * inv[0][0] + dy * inv[1][0] + dz * inv[2][0]),
    );
    const fj = Math.min(
      ny - 1,
      Math.max(0, dx * inv[0][1] + dy * inv[1][1] + dz * inv[2][1]),
    );
    const fk = Math.min(
      nz - 1,
      Math.max(0, dx * inv[0][2] + dy * inv[1][2] + dz * inv[2][2]),
    );
    const i0 = Math.min(nx - 2, Math.floor(fi));
    const j0 = Math.min(ny - 2, Math.floor(fj));
    const k0 = Math.min(nz - 2, Math.floor(fk));
    const u = fi - i0;
    const v = fj - j0;
    const w = fk - k0;
    const c00 = at(i0, j0, k0) * (1 - w) + at(i0, j0, k0 + 1) * w;
    const c01 = at(i0, j0 + 1, k0) * (1 - w) + at(i0, j0 + 1, k0 + 1) * w;
    const c10 = at(i0 + 1, j0, k0) * (1 - w) + at(i0 + 1, j0, k0 + 1) * w;
    const c11 = at(i0 + 1, j0 + 1, k0) * (1 - w) +
      at(i0 + 1, j0 + 1, k0 + 1) * w;
    return (c00 * (1 - v) + c01 * v) * (1 - u) + (c10 * (1 - v) + c11 * v) * u;
  };
}

/** Sample `grid` at every vertex of `mesh`. */
export function sample_mesh(
  mesh: CubeMesh,
  grid: VolumetricGrid,
): Float32Array {
  const sample = make_sampler(grid);
  const pos = mesh.positions;
  const values = new Float32Array(pos.length / 3);
  for (let v = 0; v < values.length; v++) {
    values[v] = sample(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
  }
  return values;
}

export function colors_for(
  values: Float32Array,
  scale: ColorScale,
): Float32Array {
  const colors = new Float32Array(values.length * 3);
  for (let v = 0; v < values.length; v++) {
    const [r, g, b] = color_at(values[v], scale);
    colors[3 * v] = r;
    colors[3 * v + 1] = g;
    colors[3 * v + 2] = b;
  }
  return colors;
}

/** Copy of `mesh` carrying per-vertex `values` and `colors`. */
export function color_mesh(
  mesh: CubeMesh,
  grid: VolumetricGrid,
  scale: ColorScale,
): CubeMesh {
  const values = sample_mesh(mesh, grid);
  return { ...mesh, values, colors: colors_for(values, scale) };
}

export interface SurfaceExtremum {
  kind: `min` | `max`;
  value: number;
  position: [number, number, number];
}

/**
 * Local minima and maxima of per-vertex values over the mesh's 1-ring
 * neighbourhoods; extrema closer than `merge_distance` Å to a stronger one of
 * the same kind are dropped.
 */
export function surface_extrema(
  mesh: CubeMesh,
  values: Float32Array,
  merge_distance = 0.6,
): SurfaceExtremum[] {
  const n = values.length;
  const idx = mesh.indices;
  const lo = new Float32Array(n).fill(Infinity);
  const hi = new Float32Array(n).fill(-Infinity);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    for (const a of tri) {
      for (const b of tri) {
        if (a === b) continue;
        if (values[b] < lo[a]) lo[a] = values[b];
        if (values[b] > hi[a]) hi[a] = values[b];
      }
    }
  }
  const pos = mesh.positions;
  const candidates: SurfaceExtremum[] = [];
  for (let v = 0; v < n; v++) {
    if (!Number.isFinite(lo[v])) continue; // isolated vertex
    const p: [number, number, number] = [
      pos[3 * v],
      pos[3 * v + 1],
      pos[3 * v + 2],
    ];
    if (values[v] < lo[v]) {
      candidates.push({ kind: `min`, value: values[v], position: p });
    } else if (values[v] > hi[v]) {
      candidates.push({ kind: `max`, value: values[v], position: p });
    }
  }
  // strongest first, then suppress weaker neighbours of the same kind
  candidates.sort((a, b) =>
    (a.kind === `min` ? a.value : -a.value) -
    (b.kind === `min` ? b.value : -b.value)
  );
  const kept: SurfaceExtremum[] = [];
  const d2 = merge_distance * merge_distance;
  for (const c of candidates) {
    const close = kept.some((k) =>
      k.kind === c.kind &&
      (k.position[0] - c.position[0]) ** 2 +
            (k.position[1] - c.position[1]) ** 2 +
            (k.position[2] - c.position[2]) ** 2 < d2
    );
    if (!close) kept.push(c);
  }
  return kept;
}
