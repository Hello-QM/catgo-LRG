<script lang="ts">
  /**
   * Wulff Construction Plot — horizontal bar chart of facet area fractions
   * colored by surface energy. Dominant facet highlighted.
   *
   * Standard visualization for nanoparticle morphology prediction in
   * computational catalysis papers (replaces pymatgen WulffShape.get_plot()).
  */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('workflow')

  let {
    facet_table = [],
    dominant_facet = ``,
    weighted_surface_energy_J_per_m2 = 0,
    height = 280,
  }: {
    facet_table: { facet: string; area_percent: number; gamma_J_per_m2: number }[]
    dominant_facet?: string
    weighted_surface_energy_J_per_m2?: number
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
    if (!Plotly || !plot_div || facet_table.length === 0) return

    // Sort by area fraction descending
    const sorted = [...facet_table].sort((a, b) => b.area_percent - a.area_percent)

    // Color scale: green (low γ) → red (high γ)
    const gammas = sorted.map(f => f.gamma_J_per_m2)
    const min_gamma = Math.min(...gammas)
    const max_gamma = Math.max(...gammas)
    const range = max_gamma - min_gamma || 1

    const colors = sorted.map(f => {
      const t = (f.gamma_J_per_m2 - min_gamma) / range
      // Green → Yellow → Red gradient
      const r = Math.round(34 + t * 205)
      const g = Math.round(197 - t * 128)
      const b = Math.round(94 - t * 50)
      return `rgb(${r}, ${g}, ${b})`
    })

    // Highlight dominant facet with a border
    const line_widths = sorted.map(f =>
      f.facet === dominant_facet ? 2 : 0
    )

    const trace = {
      y: sorted.map(f => `(${f.facet})`),
      x: sorted.map(f => f.area_percent),
      type: `bar`,
      orientation: `h`,
      marker: {
        color: colors,
        line: {
          color: `#ffffff`,
          width: line_widths,
        },
      },
      text: sorted.map(f => `${f.area_percent.toFixed(1)}% — γ=${f.gamma_J_per_m2.toFixed(2)} J/m²`),
      textposition: `auto`,
      textfont: { size: 11, color: `#fff` },
      hovertemplate: `<b>%{y}</b><br>Area: %{x:.1f}%<br>%{text}<extra></extra>`,
    }

    const axis_color = `var(--text-color, #374151)`
    const layout = base_layout({
      height,
      xaxis: {
        title: t('workflow.wulff_area_fraction'),
        showgrid: true,
        gridcolor: `rgba(128, 128, 128, 0.15)`,
        color: axis_color,
        range: [0, Math.max(100, ...sorted.map(f => f.area_percent)) * 1.05],
      },
      yaxis: {
        automargin: true,
        color: axis_color,
      },
      margin: { l: 70, r: 20, t: 30, b: 50 },
      title: {
        text: t('workflow.wulff_shape_dominant', { facet: dominant_facet }),
        font: { size: 13 },
        x: 0.5,
      },
    })

    Plotly.react(plot_div, [trace], layout, base_config())
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
    const url = await Plotly.toImage(plot_div, { format, width: 800, height: 500, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `wulff_construction.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="wulff-plot-container">
  <div bind:this={plot_div} class="wulff-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title={t('workflow.wulff_export_png')}>PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title={t('workflow.wulff_export_svg')}>SVG</button>
  </div>
</div>

<style>
  .wulff-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .wulff-plot {
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
