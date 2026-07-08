<script lang="ts">
  /**
   * Surface Energy Linear Fit Plot — renders per-facet E(N) vs N_atoms
   * with linear fit lines, following the UMA catalysis tutorial pattern.
   *
   * Uses Plotly subplots: one panel per facet, scatter points + dashed fit line.
   * Each panel titled with facet name and gamma value.
   */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    per_facet = {},
    height = 400,
  }: {
    per_facet: Record<string, {
      gamma_J_per_m2?: number
      gamma_eV_per_A2?: number
      data_points?: { n_atoms: number; energy: number; label?: string }[]
      fit_curve?: { n_atoms: number[]; energies: number[] }
      r_squared?: number
      slope_eV_per_atom?: number
      intercept_eV?: number
      n_points?: number
    }>
    height?: number
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => { Plotly = p })
    }
  })

  $effect(() => {
    if (!Plotly || !plot_div || !per_facet) return
    const facets = Object.keys(per_facet).sort()
    if (facets.length === 0) return

    const colors = [`#3b82f6`, `#ef4444`, `#22c55e`, `#f59e0b`, `#8b5cf6`, `#ec4899`]
    const traces: any[] = []
    const annotations: any[] = []

    // Grid layout: up to 2 columns
    const n_cols = Math.min(facets.length, 2)
    const n_rows = Math.ceil(facets.length / n_cols)

    facets.forEach((fk, idx) => {
      const fd = per_facet[fk]
      if (!fd) return

      const row = Math.floor(idx / n_cols) + 1
      const col = (idx % n_cols) + 1
      const axis_suffix = idx === 0 ? `` : `${idx + 1}`
      const x_axis = `x${axis_suffix}`
      const y_axis = `y${axis_suffix}`
      const color = colors[idx % colors.length]

      // Scatter: calculated data points
      if (fd.data_points && fd.data_points.length > 0) {
        traces.push({
          x: fd.data_points.map(p => p.n_atoms),
          y: fd.data_points.map(p => p.energy),
          mode: `markers`,
          type: `scatter`,
          name: `(${fk}) data`,
          marker: { size: 8, color, symbol: `circle` },
          xaxis: x_axis,
          yaxis: y_axis,
          hovertemplate: `<b>N=%{x}</b><br>E=%{y:.3f} eV<extra>(${fk})</extra>`,
          showlegend: false,
        })
      }

      // Line: linear fit
      if (fd.fit_curve && fd.fit_curve.n_atoms && fd.fit_curve.energies) {
        const slope = fd.slope_eV_per_atom ?? 0
        const intercept = fd.intercept_eV ?? 0
        traces.push({
          x: fd.fit_curve.n_atoms,
          y: fd.fit_curve.energies,
          mode: `lines`,
          type: `scatter`,
          name: `Fit: ${slope.toFixed(2)}N + ${intercept.toFixed(2)}`,
          line: { color, dash: `dash`, width: 2 },
          xaxis: x_axis,
          yaxis: y_axis,
          showlegend: false,
        })
      }

      // Annotation: facet title with gamma
      const gamma = fd.gamma_J_per_m2
      const title_text = gamma != null
        ? `(${fk}): γ = ${gamma.toFixed(2)} J/m²`
        : `(${fk})`

      annotations.push({
        text: `<b>${title_text}</b>`,
        xref: `${x_axis} domain`,
        yref: `${y_axis} domain`,
        x: 0.5,
        y: 1.18,
        showarrow: false,
        font: { size: 11 },
        xanchor: `center`,
      })
    })

    // Build axis layout for grid
    const axis_color = `var(--text-color, #374151)`
    const grid_color = `rgba(128, 128, 128, 0.15)`
    const axes: Record<string, any> = {}

    // Simple grid: divide [0,1] into rows and columns with fixed gaps
    const x_gap = 0.15  // gap between columns (fraction of total width)
    const y_gap = 0.18  // gap between rows (fraction of total height, room for titles)

    facets.forEach((_, idx) => {
      const suffix = idx === 0 ? `` : `${idx + 1}`
      const row = Math.floor(idx / n_cols)
      const col = idx % n_cols

      // Each cell's position
      const cell_w = (1 - x_gap * (n_cols - 1)) / n_cols
      const cell_h = (1 - y_gap * (n_rows - 1)) / n_rows
      const x0 = col * (cell_w + x_gap)
      const x1 = x0 + cell_w
      // Rows go top-to-bottom: row 0 = top
      const y1 = 1 - row * (cell_h + y_gap)
      const y0 = y1 - cell_h

      axes[`xaxis${suffix}`] = {
        title: row === n_rows - 1 ? `N atoms` : ``,
        domain: [x0, x1],
        anchor: `y${suffix}`,
        showgrid: true,
        gridcolor: grid_color,
        color: axis_color,
      }
      axes[`yaxis${suffix}`] = {
        title: col === 0 ? `Energy (eV)` : ``,
        domain: [Math.max(0, y0), y1],
        anchor: `x${suffix}`,
        showgrid: true,
        gridcolor: grid_color,
        color: axis_color,
      }
    })

    const total_height = n_rows > 1 ? 300 * n_rows : height
    const layout = base_layout({
      height: total_height,
      margin: { l: 60, r: 20, t: 25, b: 50 },
      annotations,
      ...axes,
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
    }
  })

  export async function export_plot(format: 'png' | 'svg') {
    if (!Plotly || !plot_div) return
    const url = await Plotly.toImage(plot_div, { format, width: 1200, height: 900, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `surface_energy_fits.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="se-plot-container">
  <div bind:this={plot_div} class="se-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .se-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .se-plot {
    width: 100%;
    min-height: 200px;
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
