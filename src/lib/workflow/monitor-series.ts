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
