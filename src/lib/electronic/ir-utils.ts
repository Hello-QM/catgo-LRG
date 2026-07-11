/** Map data series to an SVG polyline `points` string.
 * y is flipped (SVG y grows downward); degenerate ranges collapse safely. */
export function polyline_points(
  xs: number[],
  ys: number[],
  w: number,
  h: number,
  pad: number,
): string {
  if (!xs.length) return ''
  const x_min = Math.min(...xs)
  const x_max = Math.max(...xs)
  const y_min = Math.min(...ys)
  const y_max = Math.max(...ys)
  const x_span = x_max - x_min || 1
  const y_span = y_max - y_min || 1
  return xs
    .map((x, i) => {
      const px = pad + ((x - x_min) / x_span) * (w - 2 * pad)
      const py = h - pad - ((ys[i] - y_min) / y_span) * (h - 2 * pad)
      return `${px},${py}`
    })
    .join(' ')
}
