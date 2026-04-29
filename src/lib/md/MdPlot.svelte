<script lang="ts">
  let {
    traces = [],
    layout_overrides = {},
    title = ``,
    x_label = ``,
    y_label = ``,
    x_range = null,
    y_range = null,
    show_gridlines = true,
    show_axis_lines = true,
    axis_line_width = 1,
    tick_length = 5,
    tick_width = 1,
    legend_visible = true,
    hovermode = `x unified`,
  }: {
    /** Pre-built Plotly trace objects */
    traces?: any[]
    /** Extra layout properties to merge into the computed layout */
    layout_overrides?: Record<string, any>
    /** Plot title (empty string hides it) */
    title?: string
    /** X-axis label */
    x_label?: string
    /** Y-axis label */
    y_label?: string
    /** X-axis range [min, max], or null for auto */
    x_range?: [number, number] | null
    /** Y-axis range [min, max], or null for auto */
    y_range?: [number, number] | null
    /** Show grid lines on both axes */
    show_gridlines?: boolean
    /** Show axis border lines */
    show_axis_lines?: boolean
    /** Width of axis border lines */
    axis_line_width?: number
    /** Length of tick marks */
    tick_length?: number
    /** Width of tick marks */
    tick_width?: number
    /** Show/hide the legend */
    legend_visible?: boolean
    /** Plotly hovermode */
    hovermode?: string
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let container_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)
  let container_height: number = $state(400)

  // Dynamic Plotly import (SSR-safe)
  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      import(`plotly.js-dist-min`).then((mod) => {
        Plotly = mod.default ?? mod
      })
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

  // Axis appearance shared properties
  const grid_props = $derived({
    showgrid: show_gridlines,
    gridcolor: `rgba(255,255,255,0.1)`,
    gridwidth: 1,
  })

  const line_props = $derived({
    showline: show_axis_lines,
    linecolor: `rgba(200,200,200,0.5)`,
    linewidth: axis_line_width,
    mirror: show_axis_lines,
  })

  const tick_props = $derived({
    ticks: `outside` as const,
    ticklen: tick_length,
    tickwidth: tick_width,
    tickcolor: `rgba(200,200,200,0.5)`,
  })

  // Plotly.js (strict mode) tries to assign event.target which is read-only
  // in modern browsers, breaking hover/click handlers. Fix by making
  // event.target writable before Plotly's handlers fire (capture phase).
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

  // Render / update plot
  $effect(() => {
    if (!Plotly || !plot_div) return

    const xaxis: Record<string, any> = {
      title: x_label ? { text: x_label, font: { color: `#ccc`, size: 12 } } : undefined,
      automargin: true,
      zeroline: false,
      ...grid_props,
      ...line_props,
      ...tick_props,
    }
    if (x_range) xaxis.range = x_range

    const yaxis: Record<string, any> = {
      title: y_label ? { text: y_label, font: { color: `#ccc`, size: 12 } } : undefined,
      automargin: true,
      zeroline: false,
      ...grid_props,
      ...line_props,
      ...tick_props,
    }
    if (y_range) yaxis.range = y_range

    const layout: Record<string, any> = {
      xaxis,
      yaxis,
      plot_bgcolor: `rgba(0,0,0,0)`,
      paper_bgcolor: `rgba(0,0,0,0)`,
      font: { color: `#ccc`, size: 11 },
      showlegend: legend_visible,
      legend: {
        bgcolor: `rgba(0,0,0,0.3)`,
        font: { color: `#ccc`, size: 10 },
      },
      margin: { l: 60, r: 10, t: title ? 30 : 10, b: 50 },
      height: container_height,
      hovermode,
      autosize: true,
      ...layout_overrides,
    }

    if (title) {
      layout.title = {
        text: title,
        font: { color: `#ccc`, size: 13 },
        x: 0.5,
        xanchor: `center`,
      }
    }

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: [`lasso2d`, `select2d`],
      toImageButtonOptions: {
        format: `svg`,
        filename: `md_plot`,
        width: 800,
        height: container_height,
        scale: 2,
      },
      edits: {
        legendPosition: true,
      },
    }

    Plotly.react(plot_div, traces, layout, config)
  })

  /**
   * Export plot data as CSV.
   * @param headers - Column header names
   * @param rows - Array of row arrays (each inner array = one row of values)
   */
  export function export_csv(
    headers: string[],
    rows: (string | number)[][],
  ): string {
    if (headers.length === 0 || rows.length === 0) return ``
    const header_line = headers.join(`,`)
    const data_lines = rows.map((row) =>
      row.map((v) => (typeof v === `number` ? v.toFixed(6) : v)).join(`,`)
    )
    return [header_line, ...data_lines].join(`\n`)
  }

  /**
   * Export the plot as an image.
   * @param format - Image format: 'png' or 'svg'
   * @returns Data URL string, or null if export is not possible
   */
  export async function export_image(
    format: `png` | `svg` = `png`,
  ): Promise<string | null> {
    if (!Plotly || !plot_div) return null
    const url = await Plotly.toImage(plot_div, {
      format,
      width: 800,
      height: container_height,
      scale: 2,
    })
    return url
  }
</script>

<div class="md-plot-container" bind:this={container_div}>
  <div bind:this={plot_div} class="plotly-target"></div>
</div>

<style>
  .md-plot-container {
    width: 100%;
    height: 100%;
    min-height: 100px;
  }
  .plotly-target {
    width: 100%;
    height: 100%;
  }
</style>
