<script lang="ts">
  import type { COHPSeries } from './cohp_types'
  import { plot_theme_colors } from './plot-theme.svelte'
  import { PALETTE_PRESETS } from './palettes'
  import { compute_export_px } from './export-dims'

  let {
    energies = [],
    series = [],
    efermi = 0,
    show_fermi_line = true,
    show_fill = false,
    fill_opacity = 0.15,
    show_spin_down = true,
    spin_mode = `separate`,
    orientation = `horizontal`,   // horizontal: Energy on Y, COHP on X
    x_range = null,
    y_range = null,
    invert_cohp = true,  // negate COHP so bonding → positive
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
    energies: number[]
    series: COHPSeries[]
    efermi: number
    show_fermi_line?: boolean
    show_fill?: boolean
    fill_opacity?: number
    show_spin_down?: boolean
    spin_mode?: `separate` | `summed`
    orientation?: `horizontal` | `vertical`
    x_range?: [number, number] | null
    y_range?: [number, number] | null
    invert_cohp?: boolean
    line_styles?: Record<string, { dash?: string; width?: number; color?: string; fill_color?: string }>
    show_gridlines?: boolean
    show_axis_lines?: boolean
    axis_line_width?: number
    tick_length?: number
    tick_width?: number
    title_size?: number
    font_size?: number
    legend_visible?: boolean
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

  /** Parse hex color to {r,g,b}. Returns null on failure. */
  function hex_to_rgb(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
    if (!m) return null
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
    }
  }

  /** Build rgba fill color from hex + alpha, with optional override. */
  function make_fill_rgba(hex: string, alpha: number, fill_color_override?: string): string {
    if (fill_color_override) {
      const rgb = hex_to_rgb(fill_color_override)
      if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
    }
    const rgb = hex_to_rgb(hex)
    if (!rgb) return `rgba(128, 128, 128, ${alpha})`
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }

  // Main reactive plot effect
  $effect(() => {
    if (!Plotly || !plot_div || energies.length === 0 || series.length === 0) return

    const pc = plot_theme_colors()
    const sign = invert_cohp ? -1 : 1
    const traces: any[] = []
    const fa = Math.max(0, Math.min(1, fill_opacity))  // clamp

    for (let i = 0; i < series.length; i++) {
      const s = series[i]
      const style = line_styles[s.label] ?? {}
      const color = style.color ?? PALETTE_PRESETS.default[i % PALETTE_PRESETS.default.length]
      const dash = style.dash ?? `solid`
      const lw = style.width ?? 1.5
      const is_hidden = hidden_set.has(s.label)
      const fill_color_override = style.fill_color

      if (spin_mode === `summed` && s.spin_down) {
        // Sum spin-up + spin-down into a single trace
        const cohp_sum = s.spin_up.map((v, j) => (v + s.spin_down![j]) * sign)
        const trace: any = {
          x: is_horizontal ? cohp_sum : energies,
          y: is_horizontal ? energies : cohp_sum,
          type: `scatter`,
          mode: `lines`,
          name: s.label,
          line: { color, width: lw, dash },
          visible: is_hidden ? `legendonly` : true,
        }
        if (show_fill && !is_hidden) {
          trace.fill = is_horizontal ? `tozerox` : `tozeroy`
          trace.fillcolor = make_fill_rgba(color, fa, fill_color_override)
        }
        traces.push(trace)
      } else {
        // Separate spin traces (original behavior)
        const cohp_up = s.spin_up.map((v) => v * sign)
        const has_down = s.spin_down && show_spin_down

        const trace_up: any = {
          x: is_horizontal ? cohp_up : energies,
          y: is_horizontal ? energies : cohp_up,
          type: `scatter`,
          mode: `lines`,
          name: has_down ? `${s.label} (up)` : s.label,
          line: { color, width: lw, dash },
          visible: is_hidden ? `legendonly` : true,
        }
        if (show_fill && !is_hidden) {
          trace_up.fill = is_horizontal ? `tozerox` : `tozeroy`
          trace_up.fillcolor = make_fill_rgba(color, fa, fill_color_override)
        }
        traces.push(trace_up)

        // Spin down
        if (has_down) {
          const cohp_down = s.spin_down!.map((v) => v * sign)
          const trace_down: any = {
            x: is_horizontal ? cohp_down : energies,
            y: is_horizontal ? energies : cohp_down,
            type: `scatter`,
            mode: `lines`,
            name: `${s.label} (down)`,
            line: { color, width: lw, dash: `dash` },
            showlegend: true,
            visible: is_hidden ? `legendonly` : true,
          }
          if (show_fill && !is_hidden) {
            trace_down.fill = is_horizontal ? `tozerox` : `tozeroy`
            trace_down.fillcolor = make_fill_rgba(color, fa * 0.7, fill_color_override)
          }
          traces.push(trace_down)
        }
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

    // Zero line for COHP axis (bonding/antibonding boundary)
    if (is_horizontal) {
      shapes.push({
        type: `line`,
        x0: 0, x1: 0, y0: 0, y1: 1,
        xref: `x`, yref: `paper`,
        line: { color: `rgba(150, 150, 150, 0.4)`, width: 1, dash: `dot` },
      })
    } else {
      shapes.push({
        type: `line`,
        x0: 0, x1: 1, y0: 0, y1: 0,
        xref: `paper`, yref: `y`,
        line: { color: `rgba(150, 150, 150, 0.4)`, width: 1, dash: `dot` },
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

    const cohp_label = invert_cohp ? `\u2013COHP (eV)` : `COHP (eV)`
    const energy_axis = {
      title: { text: `E \u2013 E<sub>f</sub> (eV)`, font: { size: title_size } },
      zeroline: false,
      automargin: true,
      range: is_horizontal ? (y_range ?? undefined) : (x_range ?? undefined),
      ...grid_props,
      ...line_props,
      ...tick_props,
    }
    const cohp_axis = {
      title: { text: cohp_label, font: { size: title_size } },
      zeroline: true,
      automargin: true,
      range: is_horizontal ? (x_range ?? undefined) : (y_range ?? undefined),
      ...grid_props,
      ...line_props,
      ...tick_props,
    }

    const layout: any = {
      xaxis: is_horizontal ? cohp_axis : energy_axis,
      yaxis: is_horizontal ? energy_axis : cohp_axis,
      shapes,
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
        filename: `cohp_plot`,
      },
      edits: {
        legendPosition: true,
      },
    }

    Plotly.react(plot_div, traces, layout, config)
  })

  // Export functions (same pattern as DosPlot)
  export function export_csv(): string {
    if (energies.length === 0 || series.length === 0) return ``
    const visible = series.filter((s) => !hidden_set.has(s.label))
    const summed = spin_mode === `summed`
    const headers = [`Energy_eV`, ...visible.flatMap((s) =>
      s.spin_down && !summed ? [`${s.label}_up`, `${s.label}_down`] : [s.label]
    )]
    const rows = energies.map((e, i) => {
      const vals = visible.flatMap((s) => {
        if (s.spin_down && summed) {
          return [(s.spin_up[i] + s.spin_down[i]).toFixed(6)]
        }
        return s.spin_down && !summed
          ? [s.spin_up[i].toFixed(6), s.spin_down[i].toFixed(6)]
          : [s.spin_up[i].toFixed(6)]
      })
      return [e.toFixed(6), ...vals].join(`,`)
    })
    return [headers.join(`,`), ...rows].join(`\n`)
  }

  export function export_json(): string {
    const visible = series.filter((s) => !hidden_set.has(s.label))
    return JSON.stringify({ energies, series: visible, efermi, spin_mode }, null, 2)
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

<div class="cohp-plot-container" bind:this={container_div}>
  <div bind:this={plot_div} class="plotly-target"></div>
</div>

<style>
  .cohp-plot-container {
    width: 100%;
    height: 100%;
    min-height: 100px;
  }
  .plotly-target {
    width: 100%;
    height: 100%;
  }
</style>
