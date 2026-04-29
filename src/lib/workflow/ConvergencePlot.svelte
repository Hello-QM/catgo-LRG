<script lang="ts">
  import type { ConvergencePoint } from '$lib/api/workflow'
  import { lazy_load_plotly, make_target_writable, base_layout, base_config, observe_resize } from './plotly-utils'

  let {
    points = [],
    is_orca = false,
    running = false,
    max_steps = 0,
  }: {
    points: ConvergencePoint[]
    is_orca: boolean
    running?: boolean
    /** Target step count (NSW / max_steps). When > 0, the x-axis is pinned
     * to [0, max_steps] so a 57-of-500-steps NEB visibly shows ~11% progress
     * across the plot width instead of filling the whole axis. Pass 0 to
     * let Plotly auto-scale. */
    max_steps?: number
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      lazy_load_plotly().then((p) => Plotly = p)
    }
  })

  $effect(() => {
    if (!Plotly || !plot_div || points.length === 0) return

    const steps = points.map((_, i) => i + 1)

    const energy_trace = {
      x: steps,
      y: points.map((p) => p.energy),
      mode: `lines+markers`,
      type: `scatter`,
      name: is_orca ? `Energy (Eh)` : `Energy (eV)`,
      line: { color: `#3b82f6`, width: 2 },
      marker: { size: 4 },
      yaxis: `y`,
      hovertemplate: `<b>Step %{x}</b><br>Energy: %{y:.6f}<extra></extra>`,
    }

    const force_trace = {
      x: steps,
      y: points.map((p) => p.max_force),
      mode: `lines`,
      type: `scatter`,
      name: is_orca ? `Max Gradient` : `Max Force (eV/Å)`,
      line: { color: `#ef4444`, width: 2, dash: `dash` },
      yaxis: `y2`,
      hovertemplate: `<b>Step %{x}</b><br>${is_orca ? `Gradient` : `Force`}: %{y:.6f}<extra></extra>`,
    }

    const axis_color = `var(--text-color, #374151)`
    // Pin x-axis to the target step count when provided so the user sees
    // their progress as a fraction of the planned run (e.g. 57/500 = 11 %
    // of the plot width). When max_steps is 0 or unknown, fall back to
    // Plotly auto-scaling.
    const x_current_max = steps[steps.length - 1] ?? 1
    const x_range = max_steps > x_current_max
      ? [0, max_steps]
      : [0, Math.max(x_current_max, 10)]

    const layout = base_layout({
      height: 260,
      margin: { l: 60, r: 60, t: 15, b: 50 },
      xaxis: {
        title: max_steps > 0 ? `Step (of ${max_steps})` : `Step`,
        showgrid: true, zeroline: false, color: axis_color,
        range: x_range, autorange: false,
      },
      yaxis: { title: is_orca ? `Energy (Eh)` : `Energy (eV)`, showgrid: true, zeroline: false, color: axis_color },
      yaxis2: { title: is_orca ? `Max Gradient` : `Max Force (eV/Å)`, overlaying: `y`, side: `right`, showgrid: false, color: axis_color },
      legend: { x: 0.02, y: 0.98, bgcolor: `rgba(255,255,255,0.7)`, bordercolor: axis_color, borderwidth: 1 },
    })

    Plotly.react(plot_div, [energy_trace, force_trace], layout, base_config())
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
</script>

<div class="convergence-container">
  {#if running}
    <div class="live-badge">● LIVE</div>
  {/if}
  <div bind:this={plot_div} class="convergence-plot"></div>
</div>

<style>
  .convergence-container {
    position: relative;
    width: 100%;
  }

  .live-badge {
    position: absolute;
    top: 8px;
    right: 12px;
    font-size: 12px;
    font-weight: 600;
    color: #ef4444;
    animation: pulse 1.5s ease-in-out infinite;
    z-index: 10;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .convergence-plot {
    width: 100%;
    min-height: 260px;
  }
</style>
