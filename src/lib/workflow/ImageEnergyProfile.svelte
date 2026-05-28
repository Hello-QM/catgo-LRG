<script lang="ts">
  import { onMount } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { lazy_load_plotly } from './plotly-utils'

  load_i18n_module(`workflow`)

  interface Props {
    image_energies: Record<number, Array<[number, number]>>
  }

  let { image_energies = {} }: Props = $props()

  let plot_div: HTMLDivElement | null = null
  let Plotly: any = null

  // Build traces and render directly to DOM — never store Plotly objects in
  // $state or $derived.  Plotly mutates trace/layout internals after render,
  // which Svelte 5 proxies detect as changes, triggering an infinite loop.
  function render() {
    if (!plot_div || !Plotly) return

    const iters = Object.keys(image_energies).map(Number).sort((a, b) => a - b)
    if (iters.length === 0) {
      Plotly.purge(plot_div)
      return
    }

    const traces = iters.map((iter, color_idx) => {
      const images = image_energies[iter]
      if (!images || images.length === 0) return null

      const x_vals = images.map(([idx]: [number, number]) => idx)
      const y_vals = images.map(([, energy_eh]: [number, number]) => energy_eh * 627.51)

      const opacity = 0.3 + (0.7 * color_idx) / Math.max(iters.length - 1, 1)

      return {
        x: x_vals,
        y: y_vals,
        type: 'scatter' as const,
        mode: 'lines+markers' as const,
        name: t(`workflow.iter_n`, { n: iter }),
        line: {
          color: `hsl(${(color_idx * 360) / Math.max(iters.length, 1)}, 70%, 55%)`,
          width: iters.length > 20 ? 1 : 1.5,
        },
        marker: { size: iters.length > 20 ? 3 : 4 },
        opacity,
      }
    }).filter(Boolean)

    const layout = {
      xaxis: {
        title: { text: t(`workflow.image`), font: { size: 11, color: '#94a3b8' } },
        color: '#94a3b8',
        gridcolor: 'rgba(148,163,184,0.15)',
        zerolinecolor: 'rgba(148,163,184,0.2)',
      },
      yaxis: {
        title: { text: 'ΔE (kcal/mol)', font: { size: 11, color: '#94a3b8' } },
        color: '#94a3b8',
        gridcolor: 'rgba(148,163,184,0.15)',
        zerolinecolor: 'rgba(148,163,184,0.2)',
      },
      hovermode: 'x unified' as const,
      showlegend: iters.length <= 10,
      legend: {
        font: { size: 10, color: '#94a3b8' },
        bgcolor: 'transparent',
        x: 1,
        xanchor: 'right' as const,
        y: 1,
      },
      plot_bgcolor: 'transparent',
      paper_bgcolor: 'transparent',
      font: { family: 'system-ui, sans-serif', size: 11, color: '#94a3b8' },
      margin: { l: 50, r: 10, t: 10, b: 36 },
      autosize: true,
    }

    Plotly.react(plot_div, traces, layout, {
      responsive: true,
      displayModeBar: false,
      displaylogo: false,
    })
  }

  // Track iteration count for empty-state display (cheap primitive, no proxy)
  let has_data = $state(false)

  onMount(async () => {
    Plotly = await lazy_load_plotly()
    render()
  })

  // Re-render when image_energies changes — read only a primitive (key count)
  // to avoid tracking deep proxy reads.  The actual data is consumed inside
  // render() which runs outside Svelte's reactive tracking.
  $effect(() => {
    const keys = Object.keys(image_energies)
    has_data = keys.length > 0
    // Untrack the heavy render — we only want to re-run when the key set changes
    render()
  })
</script>

<div class="neb-profile-container">
  {#if !has_data}
    <div class="empty-state">{t(`workflow.waiting_neb_iteration_data`)}</div>
  {:else}
    <div bind:this={plot_div} class="neb-profile-plot"></div>
  {/if}
</div>

<style>
  .neb-profile-container {
    width: 100%;
  }

  .neb-profile-plot {
    width: 100%;
    height: 220px;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100px;
    color: #64748b;
    font-size: 0.8rem;
  }
</style>
