<script lang="ts">
  /**
   * Coverage Dependence Plot — scatter plot of adsorption energy vs coverage
   * with optional linear regression fit line.
   *
   * Standard visualization for coverage-dependent adsorption energy analysis
   * in computational catalysis (E_ads = intercept + slope * theta).
   */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    coverages = [],
    e_ads_per_h = [],
    fit = undefined,
    fit_curve = undefined,
    species = '',
    height = 320,
  }: {
    coverages: number[]
    e_ads_per_h: number[]
    fit?: { slope: number; intercept: number; r_squared: number }
    fit_curve?: { coverages: number[]; energies: number[] }
    species?: string
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
    if (!Plotly || !plot_div) return
    if (!coverages?.length || !e_ads_per_h?.length) {
      Plotly.purge(plot_div)
      return
    }

    const traces: any[] = [{
      x: coverages, y: e_ads_per_h,
      mode: 'markers', type: 'scatter', name: 'Calculated',
      marker: { size: 10, color: '#3b82f6' },
      hovertemplate: '<b>\u03B8 = %{x:.2f} ML</b><br>E_ads = %{y:.3f} eV/H<extra></extra>',
    }]

    if (fit_curve?.coverages?.length) {
      traces.push({
        x: fit_curve.coverages, y: fit_curve.energies,
        mode: 'lines', type: 'scatter',
        name: fit ? `Fit: ${fit.intercept?.toFixed(2)} + ${fit.slope?.toFixed(2)}\u03B8` : 'Fit',
        line: { color: '#ef4444', dash: 'dash', width: 2 },
      })
    }

    const ac = 'var(--text-color, #374151)'
    const annotations: any[] = []
    if (fit && typeof fit.intercept === 'number' && typeof fit.slope === 'number') {
      annotations.push({
        text: `E<sub>ads</sub> = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(3)}\u03B8<br>R\u00B2 = ${fit.r_squared?.toFixed(4) ?? '—'}`,
        xref: 'paper', yref: 'paper', x: 0.98, y: 0.02,
        showarrow: false, font: { size: 11, color: '#ef4444' },
        bgcolor: 'rgba(0,0,0,0.5)', borderpad: 4,
        xanchor: 'right', yanchor: 'bottom',
      })
    }

    Plotly.react(plot_div, traces, base_layout({
      height,
      margin: { l: 65, r: 20, t: 30, b: 55 },
      xaxis: { title: 'Coverage \u03B8 (ML)', showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
      yaxis: { title: 'E_ads (eV/adsorbate)', showgrid: true, gridcolor: 'rgba(128,128,128,0.15)', color: ac },
      legend: { x: 0.02, y: 0.98 },
      annotations,
      title: {
        text: species ? `Coverage Dependence \u2014 ${species}` : 'Coverage Dependence',
        font: { size: 13 },
        x: 0.5,
      },
    }), base_config())

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
    const url = await Plotly.toImage(plot_div, { format, width: 1200, height: 800, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `coverage_sweep.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="coverage-plot-container">
  <div bind:this={plot_div} class="coverage-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .coverage-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .coverage-plot {
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
