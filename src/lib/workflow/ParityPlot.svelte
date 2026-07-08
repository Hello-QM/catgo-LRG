<script lang="ts">
  /**
   * Parity Plot — computed vs reference scatter with y=x line.
   * Standard validation chart for comparing calculated values
   * against literature or experimental reference data.
   *
   * Includes error bands (±0.1 and ±0.3 eV), MAE/RMSE/max error
   * stats annotation, and per-point coloring.
   */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    points = [],
    x_label = 'Reference',
    y_label = 'Calculated',
    title = 'Parity Plot',
    height = 350,
    unit = 'eV',
    show_stats = true,
  }: {
    points: { label: string; x: number; y: number; color?: string }[]
    x_label?: string
    y_label?: string
    title?: string
    height?: number
    unit?: string
    show_stats?: boolean
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => { Plotly = p })
    }
  })

  $effect(() => {
    if (!Plotly || !plot_div) return

    const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    if (valid.length === 0) {
      Plotly.purge(plot_div)
      return
    }

    // Compute range across all x and y values with 10% padding
    const all_vals = [...valid.map(p => p.x), ...valid.map(p => p.y)]
    const raw_min = Math.min(...all_vals)
    const raw_max = Math.max(...all_vals)
    const padding = (raw_max - raw_min) * 0.1 || 0.5
    const min = raw_min - padding
    const max = raw_max + padding

    // Error statistics (from valid points only)
    const errors = valid.map(p => p.y - p.x)
    const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length
    const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length)
    const max_err = Math.max(...errors.map(Math.abs))

    // Traces (bands behind, then line, then points)
    const traces: any[] = [
      // ±0.3 eV band (lighter)
      {
        x: [min, max, max, min],
        y: [min - 0.3, max - 0.3, max + 0.3, min + 0.3],
        fill: 'toself',
        fillcolor: 'rgba(128,128,128,0.08)',
        line: { width: 0 },
        showlegend: false,
        hoverinfo: 'skip',
      },
      // ±0.1 eV band (darker)
      {
        x: [min, max, max, min],
        y: [min - 0.1, max - 0.1, max + 0.1, min + 0.1],
        fill: 'toself',
        fillcolor: 'rgba(128,128,128,0.15)',
        line: { width: 0 },
        showlegend: false,
        hoverinfo: 'skip',
      },
      // y=x parity line
      {
        x: [min, max],
        y: [min, max],
        mode: 'lines',
        type: 'scatter',
        name: 'y = x',
        line: { color: 'rgba(128,128,128,0.5)', dash: 'dash', width: 1.5 },
      },
      // Data points
      {
        x: valid.map(p => p.x),
        y: valid.map(p => p.y),
        mode: 'markers',
        type: 'scatter',
        name: 'Data',
        marker: { size: 10, color: valid.map(p => p.color ?? '#3b82f6') },
        text: valid.map(p => p.label),
        hovertemplate: valid.map(p => {
          const delta = (p.y - p.x).toFixed(3)
          return `<b>${p.label}</b><br>Ref: ${p.x.toFixed(3)}<br>Calc: ${p.y.toFixed(3)}<br>\u0394: ${delta} ${unit}<extra></extra>`
        }),
      },
    ]

    // Annotations
    const annotations: any[] = []
    if (show_stats && valid.length > 0) {
      annotations.push({
        text: `MAE = ${mae.toFixed(3)} ${unit}<br>RMSE = ${rmse.toFixed(3)} ${unit}<br>Max \u0394 = ${max_err.toFixed(3)} ${unit}`,
        xref: 'paper',
        yref: 'paper',
        x: 0.02,
        y: 0.98,
        showarrow: false,
        font: { size: 10, color: '#9ca3af' },
        bgcolor: 'rgba(0,0,0,0.5)',
        borderpad: 6,
        xanchor: 'left',
        yanchor: 'top',
      })
    }

    const axis_color = `var(--text-color, #374151)`
    const layout = base_layout({
      height,
      title: {
        text: title,
        font: { size: 13 },
        x: 0.5,
      },
      xaxis: {
        title: `${x_label} (${unit})`,
        showgrid: true,
        gridcolor: `rgba(128, 128, 128, 0.15)`,
        color: axis_color,
        scaleanchor: 'y',
      },
      yaxis: {
        title: `${y_label} (${unit})`,
        showgrid: true,
        gridcolor: `rgba(128, 128, 128, 0.15)`,
        color: axis_color,
      },
      margin: { l: 60, r: 20, t: 40, b: 50 },
      annotations,
    })

    Plotly.react(plot_div, traces, layout, base_config())

  })

  $effect(() => {
    if (!plot_div) return
    plot_div.addEventListener(`mousemove`, make_target_writable, true)
    const stop_resize = observe_resize(plot_div)
    return () => {
      plot_div?.removeEventListener(`mousemove`, make_target_writable, true)
      stop_resize()
      if (plot_div && Plotly) Plotly.purge(plot_div)
    }
  })

  export async function export_plot(format: 'png' | 'svg') {
    if (!Plotly || !plot_div) return
    const url = await Plotly.toImage(plot_div, { format, width: 800, height: 500, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `parity_plot.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="parity-plot-container">
  <div bind:this={plot_div} class="parity-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .parity-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .parity-plot {
    width: 100%;
    min-height: 180px;
  }
  .export-bar {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 4px 0;
  }
  .export-btn {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    background: rgba(128, 128, 128, 0.1);
    color: var(--text-color, #ccc);
    cursor: pointer;
  }
  .export-btn:hover {
    background: rgba(128, 128, 128, 0.25);
  }
</style>
