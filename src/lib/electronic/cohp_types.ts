/** TypeScript interfaces for COHP analysis. */

export interface COHPBondInfo {
  bond_index: number
  atom1: string
  atom2: string
  distance: number
  orbital1: string | null
  orbital2: string | null
  is_total: boolean
  label: string
  element1: string
  element2: string
}

export interface COHPSessionInfo {
  session_id: string
  nspin: number
  npoints: number
  ncols: number
  efermi: number
  emin: number
  emax: number
  bonds: COHPBondInfo[]       // total bonds only
  all_bonds: COHPBondInfo[]   // all bonds including orbital-resolved
}

export interface COHPSeries {
  label: string
  spin_up: number[]
  spin_down?: number[]
  bond_index: number
  is_total: boolean
}

export interface COHPDataResult {
  energies: number[]
  series: COHPSeries[]
  efermi: number
}

export interface ICOHPEntry {
  cohp_num: number
  atom1: string
  atom2: string
  distance: number
  spin_up: number
  spin_down: number
  total: number
  orbital1: string | null
  orbital2: string | null
  is_total: boolean
  label: string
}

export interface ICOHPResult {
  session_id: string
  entries: ICOHPEntry[]
}

/** Shared state between CohpAnalysisPane (writes) and CohpPlot (reads). */
export interface CohpViewState {
  cohp_result: COHPDataResult | null
  icohp_entries: ICOHPEntry[] | null
  show_fermi_line: boolean
  show_fill: boolean
  fill_opacity: number         // 0..1 global fill opacity
  show_spin_down: boolean
  spin_mode: `separate` | `summed`  // separate: up/down as 2 traces; summed: up+down as 1 trace
  orientation: `horizontal` | `vertical`
  x_range: [number, number] | null
  y_range: [number, number] | null
  invert_cohp: boolean        // negate COHP so bonding → positive
  // Plot appearance customization
  show_gridlines: boolean
  show_axis_lines: boolean
  axis_line_width: number
  tick_length: number
  tick_width: number
  title_size: number
  font_size: number
  legend_visible: boolean
  hidden_series: string[]
  line_styles: Record<string, { dash?: string; width?: number; color?: string; fill_color?: string }>
}
