/** Exact pixel dimensions for a publication-grade PNG export. */

export interface ExportDims {
  width: number
  height: number
}

const MM_PER_INCH = 25.4
export const DPI_MIN = 50
export const DPI_MAX = 1200

/**
 * Pixel dimensions for a PNG of physical `width_mm` at `dpi`, preserving the
 * on-screen `aspect` (= rendered height / width). DPI is clamped to
 * [DPI_MIN, DPI_MAX] to avoid multi-hundred-megapixel renders.
 */
export function compute_export_px(
  width_mm: number,
  dpi: number,
  aspect: number,
): ExportDims {
  const clamped_dpi = Math.max(DPI_MIN, Math.min(DPI_MAX, dpi))
  const width = Math.max(1, Math.round((width_mm / MM_PER_INCH) * clamped_dpi))
  const height = Math.max(1, Math.round(width * aspect))
  return { width, height }
}
