export type LinearRgb = readonly [number, number, number]

export type BondColorSpan = Readonly<{
  start: LinearRgb
  end: LinearRgb
}>

export type BondColorSpanKind = `full` | `boundary-stub`
export type BondHalf = 0 | 1

/** Full bonds change color at one exact midpoint, matching WebGL's two
 *  monochrome half-bond instances. The midpoint belongs to endpoint B. */
export const BOND_MIDPOINT_SPLIT = 0.5

/** Resolve the endpoint colors forwarded by a bond segment.
 *  Full/ghost bonds span A→B; boundary stubs remain A/A or B/B. */
export function resolve_bond_color_span(
  color_a: LinearRgb,
  color_b: LinearRgb,
  kind: BondColorSpanKind,
  half: BondHalf,
): BondColorSpan {
  if (kind === `full`) return { start: color_a, end: color_b }
  const color = half === 0 ? color_a : color_b
  return { start: color, end: color }
}

/** CPU reference for the fragment contract. At the exact midpoint, choose B. */
export function sample_bond_color(
  span: BondColorSpan,
  axial: number,
): LinearRgb {
  return axial < BOND_MIDPOINT_SPLIT ? span.start : span.end
}
