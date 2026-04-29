// Pure TypeScript helpers for trajectory frame computation and analysis
import type { AnyStructure } from '$lib/structure'

/**
 * Check if two structures are compatible for cross-frame editing:
 * same atom count and same element sequence (same species in same order)
 */
export function structures_compatible(a: AnyStructure, b: AnyStructure): boolean {
  if (a.sites.length !== b.sites.length) return false
  for (let i = 0; i < a.sites.length; i++) {
    const sp_a = a.sites[i].species
    const sp_b = b.sites[i].species
    if (sp_a.length !== sp_b.length) return false
    for (let j = 0; j < sp_a.length; j++) {
      if (sp_a[j].element !== sp_b[j].element) return false
    }
  }
  return true
}

/**
 * Compute step label positions for the trajectory slider.
 * @param step_labels - positive number (ticks count), negative number (spacing), or array of exact indices
 * @param total_frames - total number of trajectory frames
 * @param scale_linear - d3 scaleLinear factory (passed to avoid importing d3 here)
 */
export function compute_step_label_positions(
  step_labels: number | number[] | undefined,
  total_frames: number,
  scale_linear: () => { domain: (d: number[]) => { nice: () => { ticks: (n: number) => number[] } } },
): number[] {
  if (!step_labels || total_frames <= 1) return []

  if (Array.isArray(step_labels)) {
    return step_labels.filter((idx) => idx >= 0 && idx < total_frames)
  }

  if (typeof step_labels === `number`) {
    if (step_labels > 0) {
      return scale_linear().domain([0, total_frames - 1]).nice()
        .ticks(Math.min(step_labels, total_frames))
        .map((t: number) => Math.round(t))
        .filter((t: number, i: number, arr: number[]) => t >= 0 && t < total_frames && arr.indexOf(t) === i)
    }
    if (step_labels < 0) {
      const spacing = Math.abs(step_labels)
      const positions = Array.from(
        { length: Math.ceil(total_frames / spacing) },
        (_, idx) => idx * spacing,
      )
      return positions[positions.length - 1] === total_frames - 1
        ? positions
        : [...positions, total_frames - 1]
    }
  }
  return []
}

/**
 * Get the display label for a given display mode.
 */
export function get_view_mode_label(
  display_mode: `structure+scatter` | `structure` | `scatter` | `histogram` | `structure+histogram`,
): string {
  if (display_mode === `structure`) return `Structure Only`
  if (display_mode === `scatter`) return `Scatter Only`
  if (display_mode === `histogram`) return `Histogram Only`
  if (display_mode === `structure+histogram`) return `Structure + Histogram`
  if (display_mode === `structure+scatter`) return `Structure + Scatter`
  throw new Error(`Unexpected display mode: ${display_mode}`)
}

/**
 * Read a File as text or ArrayBuffer depending on extension.
 */
export function read_file_content(file: File): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string | ArrayBuffer)
    reader.onerror = () => reject(new Error(`Failed to read file`))

    // Read as text for text-based formats, binary for others
    if (file.name.toLowerCase().match(/\.(xyz|json|extxyz)$/)) {
      reader.readAsText(file)
    } else reader.readAsArrayBuffer(file)
  })
}
