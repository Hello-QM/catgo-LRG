<script lang="ts">
  /**
   * Scaling Relations Plot — descriptor-based scatter plot for catalyst screening.
   * Plots adsorption energy of one species vs another with optional linear fit.
   *
   * Standard visualization for identifying scaling relations between adsorbate
   * binding energies in computational catalysis (e.g. E_ads(OH*) vs E_ads(O*)).
   */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    points = [],
    x_label = 'E_ads(O*) (eV)',
    y_label = 'E_ads(OH*) (eV)',
    title = '',
    height = 350,
    show_fit = true,
  }: {
    points: { label: string; x: number; y: number; color?: string; symbol?: string }[]
    x_label?: string
    y_label?: string
    title?: string
    height?: number
    show_fit?: boolean
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  const palette = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

  function linear_fit(xs: number[], ys: number[]): { slope: number; intercept: number; r_squared: number } {
    const n = xs.length
    const sum_x = xs.reduce((a, b) => a + b, 0)
    const sum_y = ys.reduce((a, b) => a + b, 0)
    const sum_xy = xs.reduce((a, x, i) => a + x * ys[i], 0)
    const sum_x2 = xs.reduce((a, x) => a + x * x, 0)
    const denom = n * sum_x2 - sum_x * sum_x
    if (Math.abs(denom) < 1e-15) return { slope: 0, intercept: sum_y / n, r_squared: 0 }
    const slope = (n * sum_xy - sum_x * sum_y) / denom
    const intercept = (sum_y - slope * sum_x) / n
    const y_mean = sum_y / n
    const ss_tot = ys.reduce((a, y) => a + (y - y_mean) ** 2, 0)
    const ss_res = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0)
    const r_squared = ss_tot > 0 ? 1 - ss_res / ss_tot : 0
    return { slope, intercept, r_squared }
  }

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

    const ac = `var(--text-color, #374151)`
    const traces: any[] = []
    const annotations: any[] = []

    traces.push({
      x: valid.map(p => p.x),
      y: valid.map(p => p.y),
      mode: 'markers+text',
      type: 'scatter',
      name: 'Materials',
      marker: {
        size: 12,
        color: valid.map((p, i) => p.color ?? palette[i % palette.length]),
        line: { width: 1, color: 'rgba(255,255,255,0.5)' },
      },
      text: valid.map(p => p.label),
      textposition: 'top center',
      textfont: { size: 9, color: 'rgba(255,255,255,0.7)' },
      hovertemplate: '<b>%{text}</b><br>x = %{x:.3f} eV<br>y = %{y:.3f} eV<extra></extra>',
    })

    if (show_fit && valid.length >= 2) {
      const xs = valid.map(p => p.x)
      const ys = valid.map(p => p.y)
      const { slope, intercept, r_squared } = linear_fit(xs, ys)
      const x_range = Math.max(...xs) - Math.min(...xs) || 1
      const x_min = Math.min(...xs) - x_range * 0.1
      const x_max = Math.max(...xs) + x_range * 0.1

      traces.push({
        x: [x_min, x_max],
        y: [slope * x_min + intercept, slope * x_max + intercept],
        mode: 'lines',
        type: 'scatter',
        name: `Fit: y = ${slope.toFixed(2)}x + ${intercept.toFixed(2)}`,
        line: { color: '#ef4444', dash: 'dash', width: 2 },
      })

      annotations.push({
        text: `y = ${slope.toFixed(3)}x + ${intercept.toFixed(3)}<br>R\u00b2 = ${r_squared.toFixed(4)}`,
        xref: 'paper',
        yref: 'paper',
        x: 0.98,
        y: 0.02,
        showarrow: false,
        font: { size: 11, color: '#ef4444' },
        bgcolor: 'rgba(0,0,0,0.5)',
        borderpad: 4,
        xanchor: 'right',
        yanchor: 'bottom',
      })
    }

    const layout = base_layout({
      height,
      annotations,
      margin: { l: 65, r: 20, t: title ? 40 : 10, b: 55 },
      xaxis: { title: x_label, showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
      yaxis: { title: y_label, showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
      legend: { x: 0.02, y: 0.98 },
      ...(title ? { title: { text: title, font: { size: 13 }, x: 0.5 } } : {}),
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
    download(blob, `scaling_relations.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="scaling-plot-container">
  <div bind:this={plot_div} class="scaling-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .scaling-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .scaling-plot {
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
