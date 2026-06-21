/** TypeScript interfaces for band structure analysis. */

import type { PaletteName } from './palettes'
import type { PymatgenStructure } from '$lib/structure'

export interface BandBranch {
  start_index: number
  end_index: number
  name: string
}

export interface BandGapInfo {
  energy: number
  direct: boolean
  transition: string
}

export interface BandSessionInfo {
  session_id: string
  nbands: number
  nkpts: number
  nspin: number
  is_spin_polarized: boolean
  efermi: number
  is_metal: boolean
  band_gap: BandGapInfo | null
  elements: string[]
  ion_types: string[]
  ion_counts: number[]
  branches: BandBranch[]
  structure?: PymatgenStructure
}

export interface BandSeries {
  spin: string
  bands: number[][]  // [n_bands][n_kpoints]
}

export interface BandProjectionGroup {
  atoms: number[]
  channels: string
  label: string
}

export interface BandProjection {
  label: string
  spin: string
  weights: number[][]  // [n_bands][n_kpoints]
}

export interface BandDataResult {
  distance: number[]
  branches: BandBranch[]
  band_series: BandSeries[]
  efermi: number
  is_metal: boolean
  band_gap: BandGapInfo | null
  tick_labels: string[]
  tick_positions: number[]
}

export interface BandProjectionResult extends BandDataResult {
  projections: BandProjection[]
}

/** Shared state between BandAnalysisPane and BandPlot. */
export interface BandViewState {
  band_data: BandDataResult | null
  projections: BandProjection[] | null
  show_fermi_line: boolean
  show_band_gap: boolean
  show_spin_down: boolean
  energy_range: [number, number]
  fat_band_scale: number
  // Plot appearance
  show_gridlines: boolean
  show_axis_lines: boolean
  axis_line_width: number
  tick_length: number
  tick_width: number
  title_size: number
  font_size: number
  legend_visible: boolean
  // Line colors (optional; unset -> default blue / tab10 projections)
  spin_up_color?: string
  spin_down_color?: string
  proj_palette?: PaletteName
  proj_colors?: Record<string, string>
}
