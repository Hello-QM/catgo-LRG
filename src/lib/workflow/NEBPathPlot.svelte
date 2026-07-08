<script lang="ts">
  /**
   * NEB (Nudged Elastic Band) Minimum Energy Path Plot
   *
   * Renders a Plotly line+markers chart of relative energies along
   * the reaction coordinate.  Highlights the transition state (TS),
   * forward / reverse barriers, and initial / final reference lines.
   */
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'
  import { download } from '$lib/io/fetch'

  let {
    energies_ev = [],
    path_summary = undefined,
    height = 280,
  }: {
    energies_ev?: number[]
    path_summary?: {
      images: { image: string; de_kcal_mol: number; is_ts?: boolean }[]
    }
    height?: number
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  /* ---- Load Plotly lazily ---- */
  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => { Plotly = p })
    }
  })

  /* ---- Render NEB path when data is ready ---- */
  $effect(() => {
    if (!Plotly || !plot_div) return

    // Determine energies: prefer energies_ev, fall back to path_summary
    let energies: number[] = energies_ev ?? []
    if (!energies.length && path_summary?.images?.length) {
      energies = path_summary.images
        .map((img) => typeof img.de_kcal_mol === 'number' ? img.de_kcal_mol / 23.0605 : NaN)
        .filter((e) => Number.isFinite(e))
    }
    if (energies.length < 2) { Plotly.purge(plot_div); return }

    const e_ref = energies[0]
    const e_rel = energies.map((e: number) => e - e_ref)

    // Use backend TS flag if available, otherwise pick max
    let ts_idx = e_rel.indexOf(Math.max(...e_rel))
    if (path_summary?.images) {
      const flagged = path_summary.images.findIndex((img) => img.is_ts)
      if (flagged >= 0) ts_idx = Math.min(flagged, e_rel.length - 1)
    }
    const barrier = e_rel[ts_idx]
    const product = e_rel[e_rel.length - 1]

    const traces: any[] = [
      {
        x: e_rel.map((_: number, i: number) => i),
        y: e_rel,
        mode: `lines+markers`,
        type: `scatter`,
        name: `NEB Path`,
        line: { color: `#3b82f6`, width: 2.5 },
        marker: {
          size: 8,
          color: e_rel.map((_: number, i: number) => i === ts_idx ? `#f59e0b` : `#3b82f6`),
        },
        hovertemplate: `<b>Image %{x}</b><br>ΔE = %{y:.3f} eV<extra></extra>`,
      },
      {
        x: [0, e_rel.length - 1],
        y: [0, 0],
        mode: `lines`,
        type: `scatter`,
        showlegend: false,
        line: { color: `#22c55e`, dash: `dash`, width: 1 },
      },
      {
        x: [0, e_rel.length - 1],
        y: [product, product],
        mode: `lines`,
        type: `scatter`,
        showlegend: false,
        line: { color: `#ef4444`, dash: `dash`, width: 1 },
      },
    ]

    const annotations: any[] = []

    if (barrier > 0.01) {
      // TS annotation with arrow
      annotations.push({
        text: `<b>TS</b><br>${barrier.toFixed(2)} eV`,
        x: ts_idx,
        y: barrier,
        showarrow: true,
        arrowhead: 2,
        arrowcolor: `#f59e0b`,
        ax: 0,
        ay: -35,
        font: { size: 11, color: `#f59e0b` },
      })

      // Forward barrier annotation (between 0 and TS)
      annotations.push({
        text: `E<sub>a,fwd</sub> = ${barrier.toFixed(2)} eV`,
        x: ts_idx / 2,
        y: barrier / 2,
        showarrow: false,
        font: { size: 10, color: `#3b82f6` },
      })

      // Reverse barrier annotation (between product and TS)
      const reverse_barrier = barrier - product
      annotations.push({
        text: `E<sub>a,rev</sub> = ${reverse_barrier.toFixed(2)} eV`,
        x: (ts_idx + e_rel.length - 1) / 2,
        y: (barrier + product) / 2,
        showarrow: false,
        font: { size: 10, color: `#ef4444` },
      })
    }

    const ac = `var(--text-color, #374151)`
    Plotly.react(plot_div, traces, base_layout({
      height,
      annotations,
      margin: { l: 65, r: 20, t: 10, b: 50 },
      xaxis: { title: `Reaction Coordinate`, showgrid: true, gridcolor: `rgba(128,128,128,0.15)`, color: ac, dtick: 1 },
      yaxis: { title: `Relative Energy (eV)`, showgrid: true, gridcolor: `rgba(128,128,128,0.15)`, color: ac },
    }), base_config())

  })

  /* ---- Mouse fix + resize observer + unmount cleanup ---- */
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
    download(blob, `neb_pathway.${format}`, format === 'png' ? 'image/png' : 'image/svg+xml')
  }
</script>

<div class="neb-plot-container">
  <div bind:this={plot_div} class="neb-plot"></div>
  <div class="export-bar">
    <button class="export-btn" onclick={() => export_plot('png')} title="Export PNG">PNG</button>
    <button class="export-btn" onclick={() => export_plot('svg')} title="Export SVG">SVG</button>
  </div>
</div>

<style>
  .neb-plot-container {
    width: 100%;
    position: relative;
    margin-top: 12px;
  }
  .neb-plot {
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
