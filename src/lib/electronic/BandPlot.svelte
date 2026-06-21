<script lang="ts">
  import type { BandSeries, BandProjection } from './band_types'
  import { PALETTE_PRESETS, type PaletteName } from './palettes'
  import { plot_theme_colors } from './plot-theme.svelte'
  import { compute_export_px } from './export-dims'

  let {
    distance = [],
    band_series = [],
    projections = null,
    tick_labels = [],
    tick_positions = [],
    efermi = 0,
    is_metal = false,
    band_gap = null,
    show_fermi_line = true,
    show_band_gap = true,
    show_spin_down = true,
    energy_range = [-8, 6] as [number, number],
    fat_band_scale = 10,
    // Plot appearance
    show_gridlines = true,
    show_axis_lines = true,
    axis_line_width = 1,
    tick_length = 5,
    tick_width = 1,
    title_size = 14,
    font_size = 12,
    legend_visible = true,
    spin_up_color,
    spin_down_color,
    proj_palette,
    proj_colors,
  }: {
    distance: number[]
    band_series: BandSeries[]
    projections?: BandProjection[] | null
    tick_labels?: string[]
    tick_positions?: number[]
    efermi?: number
    is_metal?: boolean
    band_gap?: { energy: number; direct: boolean; transition: string } | null
    show_fermi_line?: boolean
    show_band_gap?: boolean
    show_spin_down?: boolean
    energy_range?: [number, number]
    fat_band_scale?: number
    show_gridlines?: boolean
    show_axis_lines?: boolean
    axis_line_width?: number
    tick_length?: number
    tick_width?: number
    title_size?: number
    font_size?: number
    legend_visible?: boolean
    spin_up_color?: string
    spin_down_color?: string
    proj_palette?: PaletteName
    proj_colors?: Record<string, string>
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let container_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)
  let container_height: number = $state(400)

  // Dynamic Plotly import
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
    plot_div.addEventListener(`mousemove`, make_target_writable, true)
    plot_div.addEventListener(`click`, make_target_writable, true)
    return () => {
      plot_div!.removeEventListener(`mousemove`, make_target_writable, true)
      plot_div!.removeEventListener(`click`, make_target_writable, true)
    }
  })

  // ResizeObserver
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

  // Main plot effect
  $effect(() => {
    if (!Plotly || !plot_div || distance.length === 0 || band_series.length === 0) return

    const pc = plot_theme_colors()
    const traces: any[] = []
    const [emin, emax] = energy_range

    // Plot bands
    for (const bs of band_series) {
      if (bs.spin === `down` && !show_spin_down) continue

      const is_down = bs.spin === `down`
      const line_dash = is_down ? `dash` : `solid`
      const line_color = is_down
        ? (spin_down_color ?? `rgba(100, 160, 255, 0.6)`)
        : (spin_up_color ?? `rgba(100, 160, 255, 0.8)`)

      for (let band_idx = 0; band_idx < bs.bands.length; band_idx++) {
        const energies = bs.bands[band_idx]

        traces.push({
          x: distance,
          y: energies,
          type: `scatter`,
          mode: `lines`,
          line: { color: line_color, width: 1.2, dash: line_dash },
          showlegend: band_idx === 0,
          name: band_idx === 0 ? (is_down ? `Spin down` : `Spin up`) : undefined,
          legendgroup: bs.spin,
          hoverinfo: `y`,
        })
      }
    }

    // Fat band projections
    if (projections && projections.length > 0) {
      for (let proj_idx = 0; proj_idx < projections.length; proj_idx++) {
        const proj = projections[proj_idx]
        if (proj.spin === `down` && !show_spin_down) continue

        const palette = PALETTE_PRESETS[proj_palette ?? `default`]
        const color = proj_colors?.[proj.label] ?? palette[proj_idx % palette.length]
        // Find matching band series
        const bs = band_series.find((s) => s.spin === proj.spin) ?? band_series[0]

        for (let band_idx = 0; band_idx < proj.weights.length; band_idx++) {
          if (band_idx >= bs.bands.length) break
          const energies = bs.bands[band_idx]
          const weights = proj.weights[band_idx]

          // Scale weights to marker sizes
          const sizes = weights.map((w) => Math.max(0, w * fat_band_scale))

          // Only add trace if there are non-zero weights
          const max_size = Math.max(...sizes)
          if (max_size < 0.01) continue

          traces.push({
            x: distance,
            y: energies,
            type: `scatter`,
            mode: `markers`,
            marker: {
              size: sizes,
              color: color,
              opacity: 0.6,
              line: { width: 0 },
            },
            showlegend: band_idx === 0,
            name: band_idx === 0 ? `${proj.label} (${proj.spin})` : undefined,
            legendgroup: `proj_${proj.label}_${proj.spin}`,
            hoverinfo: `y+text`,
            text: weights.map((w) => `weight: ${w.toFixed(3)}`),
          })
        }
      }
    }

    // Shapes: vertical lines at high-symmetry points + Fermi line
    const shapes: any[] = []

    // Vertical lines at tick positions
    for (const pos of tick_positions) {
      shapes.push({
        type: `line`,
        x0: pos, x1: pos,
        y0: emin, y1: emax,
        line: { color: `rgba(255,255,255,0.2)`, width: 1 },
      })
    }

    // Fermi level at E=0
    if (show_fermi_line) {
      shapes.push({
        type: `line`,
        x0: distance[0] ?? 0, x1: distance[distance.length - 1] ?? 1,
        y0: 0, y1: 0,
        line: { color: `rgba(200, 80, 80, 0.6)`, width: 1.5, dash: `dash` },
      })
    }

    const annotations: any[] = []

    // Band gap annotation
    if (show_band_gap && band_gap && !is_metal) {
      annotations.push({
        x: 0.98,
        y: 0.98,
        xref: `paper`,
        yref: `paper`,
        text: `E<sub>g</sub> = ${band_gap.energy.toFixed(3)} eV (${band_gap.direct ? `direct` : `indirect`})`,
        showarrow: false,
        font: { color: `rgba(80, 200, 80, 0.9)`, size: 12 },
        xanchor: `right`,
        yanchor: `top`,
        bgcolor: `rgba(0,0,0,0.5)`,
        borderpad: 4,
      })
    }

    // Axis appearance
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
    const tick_props_obj = {
      ticks: `outside` as const,
      ticklen: tick_length,
      tickwidth: tick_width,
      tickcolor: pc.tick,
    }

    const layout: any = {
      xaxis: {
        title: { text: `Wave Vector`, font: { size: title_size } },
        tickmode: `array`,
        tickvals: tick_positions,
        ticktext: tick_labels,
        range: [distance[0] ?? 0, distance[distance.length - 1] ?? 1],
        zeroline: false,
        ...grid_props,
        showgrid: false,  // No horizontal grid for band plots
        ...line_props,
        ...tick_props_obj,
      },
      yaxis: {
        title: { text: `E \u2013 E<sub>f</sub> (eV)`, font: { size: title_size } },
        range: [emin, emax],
        zeroline: false,
        ...grid_props,
        ...line_props,
        ...tick_props_obj,
      },
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
      hovermode: `closest`,
      autosize: true,
    }

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: [`lasso2d`, `select2d`],
      toImageButtonOptions: {
        format: `svg`,
        filename: `band_plot`,
      },
      edits: { legendPosition: true },
    }

    Plotly.react(plot_div, traces, layout, config)
  })

  export function export_csv(): string {
    if (distance.length === 0 || band_series.length === 0) return ``
    const bs = band_series[0]  // spin up
    const headers = [`k_distance`, ...bs.bands.map((_, i) => `band_${i + 1}`)]
    const rows = distance.map((d, ki) => {
      const vals = bs.bands.map((band) => band[ki].toFixed(6))
      return [d.toFixed(6), ...vals].join(`,`)
    })
    return [headers.join(`,`), ...rows].join(`\n`)
  }

  export function export_json(): string {
    return JSON.stringify({ distance, band_series, tick_labels, tick_positions, efermi }, null, 2)
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

<div class="band-plot-container" bind:this={container_div}>
  <div bind:this={plot_div} class="plotly-target"></div>
</div>

<style>
  .band-plot-container {
    width: 100%;
    height: 100%;
    min-height: 100px;
  }
  .plotly-target {
    width: 100%;
    height: 100%;
  }
</style>
