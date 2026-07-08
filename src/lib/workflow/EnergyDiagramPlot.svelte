<script lang="ts">
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    plotly_data = null,
    height = 450,
    editable = true,
  }: {
    plotly_data: { traces: any[]; layout: any; annotations: any[] } | null
    height?: number
    editable?: boolean
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  // Pre-load Plotly on mount (same pattern as ConvergencePlot/DosPlot)
  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => { Plotly = p })
    }
  })

  // Render when data + Plotly are both ready
  $effect(() => {
    if (!Plotly || !plot_div || !plotly_data) return

    const layout = base_layout({
      ...plotly_data.layout,
      height,
      annotations: plotly_data.annotations,
    })

    const config = {
      ...base_config(),
      edits: { annotationPosition: editable, annotationText: editable },
    }

    Plotly.react(plot_div, plotly_data.traces, layout, config)
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

  export async function export_diagram(format: 'png' | 'svg') {
    if (!Plotly || !plot_div) return
    const url = await Plotly.toImage(plot_div, { format, width: 1200, height: height * 2, scale: 2 })
    const blob = await (await fetch(url)).blob()
    download(blob, `energy_diagram.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="energy-diagram-container">
  <div bind:this={plot_div} class="energy-diagram-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_diagram('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_diagram('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .energy-diagram-container {
    width: 100%;
    position: relative;
  }

  .energy-diagram-plot {
    width: 100%;
    min-height: 200px;
  }

  .export-bar {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 4px 8px;
  }

  .export-btn {
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: 3px;
    background: transparent;
    color: var(--text-color-dim);
    cursor: pointer;
  }

  .export-btn:hover {
    border-color: var(--accent);
  }
</style>
