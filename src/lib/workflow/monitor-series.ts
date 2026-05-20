/**
 * VASP monitor series definitions and Plotly trace/layout builders.
 * Defines the 5 toggleable series for the enhanced monitoring chart.
 */

import type { ConvergencePoint } from '$lib/api/workflow'
import { base_layout } from './plotly-utils'

export interface MonitorSeries {
  key: keyof ConvergencePoint
  label: string
  unit: string
  color: string
  dash?: string
  yaxis: 'y' | 'y2'
  /** true = visible, 'legendonly' = hidden but toggleable */
  visible: boolean | 'legendonly'
}

/** Default series for VASP monitoring (5 traces). */
export const VASP_SERIES: MonitorSeries[] = [
  { key: `energy`,        label: `Energy`,   unit: `eV`,    color: `#3b82f6`, yaxis: `y`,  visible: true },
  { key: `energy_sigma0`, label: `E₀ (σ→0)`, unit: `eV`,    color: `#06b6d4`, dash: `dash`, yaxis: `y`,  visible: `legendonly` },
  { key: `max_force`,     label: `Max Force`, unit: `eV/Å`,  color: `#ef4444`, yaxis: `y2`, visible: true },
  { key: `rms_force`,     label: `RMS Force`, unit: `eV/Å`,  color: `#f97316`, dash: `dash`, yaxis: `y2`, visible: `legendonly` },
  { key: `dE`,            label: `dE`,        unit: `eV`,    color: `#22c55e`, dash: `dot`,  yaxis: `y2`, visible: `legendonly` },
]

/** Default series for CP2K monitoring (4 traces, single-axis).
 *
 * Used by the legacy combined Energy+Force chart. Kept around in case
 * anything imports it, but the new Cp2kMonitorPlot.svelte splits these
 * into separate single-quantity panels (see CP2K_ENERGY_SERIES,
 * CP2K_FORCE_SERIES, CP2K_TEMPERATURE_SERIES below).
 */
export const CP2K_SERIES: MonitorSeries[] = [
  { key: `energy`,    label: `Energy`,    unit: `eV`,    color: `#3b82f6`, yaxis: `y`,  visible: true },
  { key: `max_force`, label: `Max Force`, unit: `eV/Å`,  color: `#ef4444`, yaxis: `y2`, visible: true },
  { key: `rms_force`, label: `RMS Force`, unit: `eV/Å`,  color: `#f97316`, dash: `dash`, yaxis: `y2`, visible: `legendonly` },
  { key: `dE`,        label: `dE`,        unit: `eV`,    color: `#22c55e`, dash: `dot`,  yaxis: `y2`, visible: `legendonly` },
]

/* Per-panel single-axis series — used by the new stacked-chart CP2K UI.
 * Each array drives ONE Plotly plot. Splitting up the dual-axis design
 * gives Energy / Force / Temperature their own y-axis ranges (otherwise
 * the temperature in K would crush sub-eV energy detail). */

export const CP2K_ENERGY_SERIES: MonitorSeries[] = [
  // For OPT this is the SCF total energy. For MD it's potential + kinetic
  // (parse_cp2k_convergence sums them in the MD branch).
  { key: `energy`, label: `Total Energy`, unit: `eV`, color: `#3b82f6`, yaxis: `y`, visible: true },
]

export const CP2K_FORCE_SERIES: MonitorSeries[] = [
  { key: `max_force`, label: `Max Force`, unit: `eV/Å`, color: `#ef4444`, yaxis: `y`, visible: true },
  { key: `rms_force`, label: `RMS Force`, unit: `eV/Å`, color: `#f97316`, dash: `dash`, yaxis: `y`, visible: true },
]

export const CP2K_TEMPERATURE_SERIES: MonitorSeries[] = [
  { key: `temperature` as keyof ConvergencePoint, label: `Temperature`, unit: `K`, color: `#a855f7`, yaxis: `y`, visible: true },
]

/* MD energies — three separate single-trace series, picked one at a time
 * by Cp2kMonitorPlot's tab switcher. Plotting them together on a single
 * y-axis (the previous design) made Potential (~-3360 eV) and Conserved
 * (~-3360 eV, drifts ±meV) coincide while Kinetic (~0.6 eV) collapsed
 * to a flat line at the bottom — the user couldn't tell the curves
 * apart. Switching views gives each quantity its own autoscaled y-axis. */
export const CP2K_MD_POTENTIAL_SERIES: MonitorSeries[] = [
  { key: `potential_energy` as keyof ConvergencePoint, label: `Potential`, unit: `eV`, color: `#3b82f6`, yaxis: `y`, visible: true },
]

export const CP2K_MD_KINETIC_SERIES: MonitorSeries[] = [
  { key: `kinetic_energy` as keyof ConvergencePoint, label: `Kinetic`, unit: `eV`, color: `#22c55e`, yaxis: `y`, visible: true },
]

export const CP2K_MD_CONSERVED_SERIES: MonitorSeries[] = [
  { key: `conserved_energy` as keyof ConvergencePoint, label: `Conserved`, unit: `eV`, color: `#ef4444`, yaxis: `y`, visible: true },
]

/* Backward-compat alias for any old import path. New code should use the
 * three per-quantity series above + the tab switcher in Cp2kMonitorPlot. */
export const CP2K_MD_ENERGY_SERIES: MonitorSeries[] = CP2K_MD_POTENTIAL_SERIES

/** Single-axis layout — simpler than the dual-axis VASP layout.
 *
 * `autorange: true` is explicit on both axes. `uirevision` is intentionally
 * NOT set by default — when the caller omits it, Plotly auto-changes the
 * revision on every data update, which forces autoscale to re-fit the new
 * range. Setting any constant string (e.g. `'static'`) here would freeze
 * the axis range at whatever it was on first render — that was the bug
 * causing y-axis to be stuck at 0-1 K when MD temperature ~300 K arrived.
 * Pass an explicit `uirevision` only if you want sticky zoom across data
 * updates (e.g. completed task with stable data).
 */
export function build_single_axis_layout(opts: {
  ytitle: string
  height?: number
  /** Optional. If set, Plotly preserves user UI state (zooms, pans)
   *  across data updates with this revision tag. Omit for live charts
   *  where new data should always re-autoscale. */
  uirevision?: number | string
}): Record<string, unknown> {
  const axis_color = `var(--text-color, #374151)`
  const layout: Record<string, unknown> = {
    height: opts.height ?? 200,
    xaxis: {
      title: `Step`, showgrid: true, zeroline: false, color: axis_color,
      autorange: true,
    },
    yaxis: {
      title: opts.ytitle, showgrid: true, zeroline: false, color: axis_color,
      autorange: true,
    },
    legend: {
      x: 0.02, y: 0.98,
      bgcolor: `rgba(255,255,255,0.7)`,
      bordercolor: axis_color,
      borderwidth: 1,
      font: { size: 10 },
    },
  }
  if (opts.uirevision !== undefined) {
    layout.uirevision = opts.uirevision
  }
  return base_layout(layout)
}

/** Build Plotly traces from convergence points + series config. */
export function build_traces(points: ConvergencePoint[], series: MonitorSeries[]): Record<string, unknown>[] {
  const steps = points.map((_, i) => i + 1)

  return series.map((s) => ({
    x: steps,
    y: points.map((p) => p[s.key]),
    mode: `lines+markers`,
    type: `scatter`,
    name: `${s.label} (${s.unit})`,
    line: { color: s.color, width: 2, ...(s.dash ? { dash: s.dash } : {}) },
    marker: { size: 5 },
    yaxis: s.yaxis,
    visible: s.visible,
    hovertemplate: `<b>Step %{x}</b><br>${s.label}: %{y:.6f} ${s.unit}<extra></extra>`,
  }))
}

/** Build EDIFFG target horizontal line shape. */
export function build_ediffg_shape(ediffg: number): Record<string, unknown> {
  const target = Math.abs(ediffg)
  return {
    type: `line`,
    xref: `paper`,
    yref: `y2`,
    x0: 0, x1: 1,
    y0: target, y1: target,
    line: { color: `#ef4444`, width: 1, dash: `dot` },
  }
}

/** Build EDIFFG annotation label. */
export function build_ediffg_annotation(ediffg: number): Record<string, unknown> {
  return {
    text: `EDIFFG=${ediffg}`,
    xref: `paper`, yref: `y2`,
    x: 1, y: Math.abs(ediffg),
    xanchor: `right`, yanchor: `bottom`,
    font: { size: 9, color: `#ef4444` },
    showarrow: false,
  }
}

/** Build Plotly layout for VASP monitor (dual y-axes). */
export function build_monitor_layout(opts: {
  height?: number
  ediffg?: number
} = {}): Record<string, unknown> {
  const axis_color = `var(--text-color, #374151)`
  const shapes: Record<string, unknown>[] = []
  const annotations: Record<string, unknown>[] = []

  if (opts.ediffg && opts.ediffg < 0) {
    shapes.push(build_ediffg_shape(opts.ediffg))
    annotations.push(build_ediffg_annotation(opts.ediffg))
  }

  return base_layout({
    height: opts.height ?? 250,
    xaxis: { title: `Step`, showgrid: true, zeroline: false, color: axis_color },
    yaxis: { title: `Energy (eV)`, showgrid: true, zeroline: false, color: axis_color },
    yaxis2: {
      title: `Force (eV/Å) / dE (eV)`,
      overlaying: `y`, side: `right`,
      showgrid: false, color: axis_color,
    },
    legend: {
      x: 0.02, y: 0.98,
      bgcolor: `rgba(255,255,255,0.7)`,
      bordercolor: axis_color,
      borderwidth: 1,
      font: { size: 10 },
    },
    shapes,
    annotations,
  })
}
