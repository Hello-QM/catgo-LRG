<script lang="ts">
  import type { PDOSSeries } from './types'
  import { plot_theme_colors } from './plot-theme.svelte'
  import { PALETTE_PRESETS } from './palettes'
  import { compute_export_px } from './export-dims'

  let {
    grid = [],
    series = [],
    efermi = 0,
    show_fermi_line = true,
    show_fill = false,
    show_spin_down = true,
    orientation = `vertical`,
    x_range = null,
    y_range = null,
    dband_center_line = null,
    line_styles = {},
    // Plot appearance
    show_gridlines = true,
    show_axis_lines = true,
    axis_line_width = 1,
    tick_length = 5,
    tick_width = 1,
    title_size = 14,
    font_size = 12,
    legend_visible = true,
    hidden_series = [],
  }: {
    grid: number[]
    series: PDOSSeries[]
    efermi: number
    show_fermi_line?: boolean
    show_fill?: boolean
    show_spin_down?: boolean
    orientation?: `horizontal` | `vertical`
    x_range?: [number, number] | null
    y_range?: [number, number] | null
    dband_center_line?: number | null
    /** Per-series line style overrides: { "label": { dash: "dash", width: 2 } } */
    line_styles?: Record<string, { dash?: string; width?: number; color?: string; fill_color?: string }>
    show_gridlines?: boolean
    show_axis_lines?: boolean
    axis_line_width?: number
    tick_length?: number
    tick_width?: number
    title_size?: number
    font_size?: number
    legend_visible?: boolean
    /** Series labels to hide from the plot and legend */
    hidden_series?: string[]
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let container_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)
  let container_height: number = $state(400)

  const is_horizontal = $derived(orientation === `horizontal`)

  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      import(`plotly.js-dist-min`).then((mod) => {
        Plotly = mod.default ?? mod
      })
    }
  })

  // Fix Plotly's read-only event.target error
  $effect(() => {
    if (!plot_div) return
    function make_target_writable(e: Event) {
      try {
        Object.defineProperty(e, `target`, {
          value: e.target,
          writable: true,
          configurable: true,
        })
      } catch {}
    }
    plot_div!.addEventListener(`mousemove`, make_target_writable, true)
    plot_div!.addEventListener(`click`, make_target_writable, true)
    return () => {
      plot_div!.removeEventListener(`mousemove`, make_target_writable, true)
      plot_div!.removeEventListener(`click`, make_target_writable, true)
    }
  })

  // Track container size with ResizeObserver
  $effect(() => {
    if (!container_div) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height
        if (h > 50) container_height = h
      }
    })
    ro.observe(container_div)
    return () => ro.disconnect()
  })

  const hidden_set = $derived(new Set(hidden_series))

  $effect(() => {
    if (!Plotly || !plot_div || grid.length === 0 || series.length === 0) return

    const pc = plot_theme_colors()
    const traces: any[] = []
    // Track color index per original series position (so colors stay stable)
    for (let i = 0; i < series.length; i++) {
      const s = series[i]
      const style = line_styles[s.label] ?? {}
      const color = style.color ?? PALETTE_PRESETS.default[i % PALETTE_PRESETS.default.length]
      const fill_base = style.fill_color ?? color
      const dash = style.dash ?? `solid`
      const lw = style.width ?? 1.5
      const is_hidden = hidden_set.has(s.label)

      const energy = grid
      const density_up = s.spin_up

      const trace_up: any = {
        x: is_horizontal ? density_up : energy,
        y: is_horizontal ? energy : density_up,
        type: `scatter`,
        mode: `lines`,
        name: s.spin_down && show_spin_down ? `${s.label} (up)` : s.label,
        line: { color, width: lw, dash },
        visible: is_hidden ? `legendonly` : true,
      }

      if (show_fill && !is_hidden) {
        trace_up.fill = is_horizontal ? `tozerox` : `tozeroy`
        trace_up.fillcolor = `rgba(${parseInt(fill_base.slice(1, 3), 16)}, ${parseInt(fill_base.slice(3, 5), 16)}, ${parseInt(fill_base.slice(5, 7), 16)}, 0.15)`
      }

      traces.push(trace_up)

      // Spin down (mirrored)
      if (s.spin_down && show_spin_down) {
        const density_down = s.spin_down.map((v) => -v)
        const trace_down: any = {
          x: is_horizontal ? density_down : energy,
          y: is_horizontal ? energy : density_down,
          type: `scatter`,
          mode: `lines`,
          name: `${s.label} (down)`,
          line: { color, width: lw, dash },
          showlegend: true,
          visible: is_hidden ? `legendonly` : true,
        }
        if (show_fill && !is_hidden) {
          trace_down.fill = is_horizontal ? `tozerox` : `tozeroy`
          trace_down.fillcolor = `rgba(${parseInt(fill_base.slice(1, 3), 16)}, ${parseInt(fill_base.slice(3, 5), 16)}, ${parseInt(fill_base.slice(5, 7), 16)}, 0.1)`
        }
        traces.push(trace_down)
      }
    }

    const shapes: any[] = []

    // Fermi level line at E=0
    if (show_fermi_line) {
      if (is_horizontal) {
        shapes.push({
          type: `line`,
          x0: 0, x1: 1, y0: 0, y1: 0,
          xref: `paper`, yref: `y`,
          line: { color: `rgba(200, 80, 80, 0.6)`, width: 1.5, dash: `dash` },
        })
      } else {
        shapes.push({
          type: `line`,
          x0: 0, x1: 0, y0: 0, y1: 1,
          xref: `x`, yref: `paper`,
          line: { color: `rgba(200, 80, 80, 0.6)`, width: 1.5, dash: `dash` },
        })
      }
    }

    // D-band center line
    if (dband_center_line != null) {
      const val = dband_center_line
      if (is_horizontal) {
        shapes.push({
          type: `line`,
          x0: 0, x1: 1, y0: val, y1: val,
          xref: `paper`, yref: `y`,
          line: { color: `rgba(80, 180, 80, 0.8)`, width: 2, dash: `dot` },
        })
      } else {
        shapes.push({
          type: `line`,
          x0: val, x1: val, y0: 0, y1: 1,
          xref: `x`, yref: `paper`,
          line: { color: `rgba(80, 180, 80, 0.8)`, width: 2, dash: `dot` },
        })
      }
    }

    const annotations: any[] = []
    if (dband_center_line != null) {
      annotations.push({
        x: is_horizontal ? 1 : dband_center_line,
        y: is_horizontal ? dband_center_line : 1,
        xref: is_horizontal ? `paper` : `x`,
        yref: is_horizontal ? `y` : `paper`,
        text: `\u03B5<sub>d</sub> = ${dband_center_line.toFixed(2)} eV`,
        showarrow: false,
        font: { color: `rgba(80, 180, 80, 0.9)`, size: 11 },
        xanchor: is_horizontal ? `right` : `left`,
        yanchor: is_horizontal ? `bottom` : `top`,
      })
    }

    // Axis appearance shared properties
    const grid_props = {
      showgrid: show_gridlines,
      gridcolor: pc.grid,
      gridwidth: 1,
    }
    const line_props = {
      showline: show_axis_lines,
      linecolor: pc.line,
      linewidth: axis_line_width,
      mirror: show_axis_lines,
    }
    const tick_props = {
      ticks: `outside` as const,
      ticklen: tick_length,
      tickwidth: tick_width,
      tickcolor: pc.tick,
    }

    const energy_axis = {
      title: { text: `E \u2013 E<sub>f</sub> (eV)`, font: { size: title_size } },
      zeroline: false,
      range: is_horizontal ? (y_range ?? undefined) : (x_range ?? undefined),
      ...grid_props,
      ...line_props,
      ...tick_props,
    }
    const dos_axis = {
      title: { text: `DOS (states/eV)`, font: { size: title_size } },
      zeroline: true,
      range: is_horizontal ? (x_range ?? undefined) : (y_range ?? undefined),
      ...grid_props,
      ...line_props,
      ...tick_props,
    }

    const layout: any = {
      xaxis: is_horizontal ? dos_axis : energy_axis,
      yaxis: is_horizontal ? energy_axis : dos_axis,
      shapes,
      annotations,
      plot_bgcolor: `rgba(0,0,0,0)`,
      paper_bgcolor: `rgba(0,0,0,0)`,
      font: { family: pc.font, color: pc.text, size: font_size },
      showlegend: legend_visible,
      legend: {
        bgcolor: pc.legend_bg,
        font: { family: pc.font, color: pc.text, size: font_size },
      },
      margin: { l: 60, r: 10, t: 10, b: 45 },
      height: container_height,
      hovermode: is_horizontal ? `y unified` : `x unified`,
      autosize: true,
    }

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: [`lasso2d`, `select2d`],
      toImageButtonOptions: {
        format: `svg`,
        filename: `dos_plot`,
      },
      edits: {
        legendPosition: true,
      },
    }

    Plotly.react(plot_div, traces, layout, config)
  })

  export function export_csv(): string {
    if (grid.length === 0 || series.length === 0) return ``
    // Only export visible series
    const visible = series.filter((s) => !hidden_set.has(s.label))
    const headers = [`Energy_eV`, ...visible.flatMap((s) =>
      s.spin_down ? [`${s.label}_up`, `${s.label}_down`] : [s.label]
    )]
    const rows = grid.map((e, i) => {
      const vals = visible.flatMap((s) =>
        s.spin_down
          ? [s.spin_up[i].toFixed(6), s.spin_down[i].toFixed(6)]
          : [s.spin_up[i].toFixed(6)]
      )
      return [e.toFixed(6), ...vals].join(`,`)
    })
    return [headers.join(`,`), ...rows].join(`\n`)
  }

  export function export_json(): string {
    const visible = series.filter((s) => !hidden_set.has(s.label))
    return JSON.stringify({ grid, series: visible, efermi }, null, 2)
  }

  export async function export_image(
    format: `png` | `svg` = `png`,
    opts?: { dpi?: number; width_mm?: number },
  ): Promise<string | null> {
    if (!Plotly || !plot_div) return null
    if (format === `png` && opts?.dpi && opts?.width_mm) {
      const { width, height } = compute_export_px(opts.width_mm, opts.dpi, container_height / 800)
      return await Plotly.toImage(plot_div, { format, width, height, scale: 1 })
    }
    return await Plotly.toImage(plot_div, {
      format,
      width: 800,
      height: container_height,
      scale: 2,
    })
  }
</script>

<div class="dos-plot-container" bind:this={container_div}>
  <div bind:this={plot_div} class="plotly-target"></div>
</div>

<style>
  .dos-plot-container {
    width: 100%;
    height: 100%;
    min-height: 100px;
  }
  .plotly-target {
    width: 100%;
    height: 100%;
  }
</style>
