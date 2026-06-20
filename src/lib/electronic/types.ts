/** TypeScript interfaces for DOS analysis. */

import type { PymatgenStructure } from '$lib/structure'

export interface DOSGroup {
  atoms: number[]
  channels: string
  label: string
  normalize: boolean
}

export interface DOSSessionInfo {
  session_id: string
  nions: number
  nkpts: number
  nbands: number
  nchannels: number
  nspin: number
  elements: string[]
  ion_types: string[]
  ion_counts: number[]
  efermi: number
  structure?: PymatgenStructure
}

export interface PDOSSeries {
  label: string
  spin_up: number[]
  spin_down?: number[]
}

export interface PDOSResult {
  grid: number[]
  series: PDOSSeries[]
  efermi: number
}

export interface DBandResult {
  center_abs: number | null
  center_rel: number | null
  width: number | null
  variance: number | null
  n_d: number | null
  total_d_weight: number | null
  filling_fraction: number | null
  skewness: number | null
  kurtosis: number | null
  lower_edge: number | null
  upper_edge: number | null
}

export interface DOSPlotConfig {
  sigma: number
  emin: number
  emax: number
  ngrid: number
  show_total: boolean
  show_fermi_line: boolean
  show_fill: boolean
  orientation: `horizontal` | `vertical`
  show_spin_down: boolean
  x_range: [number, number] | null
  y_range: [number, number] | null
  dband_center_line: number | null
}

/** Shared state between DosAnalysisPane (writes) and Structure (reads for rendering). */
export interface DosViewState {
  dos_result: PDOSResult | null
  dband_result: DBandResult | null
  show_fermi_line: boolean
  show_fill: boolean
  show_spin_down: boolean
  orientation: `horizontal` | `vertical`
  x_range: [number, number] | null
  y_range: [number, number] | null
  show_dband_line: boolean
  line_styles: Record<string, { dash?: string; width?: number }>
  // Plot appearance customization
  show_gridlines: boolean
  show_axis_lines: boolean
  axis_line_width: number
  tick_length: number
  tick_width: number
  title_size: number
  font_size: number
  legend_visible: boolean
  hidden_series: string[]  // series labels to hide from legend & plot
}
