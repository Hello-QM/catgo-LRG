<script lang="ts">
  import type { ConvergencePoint } from '$lib/api/workflow'
  import { lazy_load_plotly, make_target_writable, base_config, observe_resize } from './plotly-utils'
  import { VASP_SERIES, build_traces, build_monitor_layout } from './monitor-series'

  let {
    points = [],
    running = false,
    ediffg = 0,
  }: {
    points: ConvergencePoint[]
    running?: boolean
    ediffg?: number
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

    const traces = build_traces(points, VASP_SERIES)
    const layout = build_monitor_layout({ ediffg })

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
</script>

<div class="monitor-container">
  {#if running}
    <div class="live-badge">● LIVE</div>
  {/if}
  <div bind:this={plot_div} class="monitor-plot"></div>
</div>

<style>
  .monitor-container {
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

  .monitor-plot {
    width: 100%;
    min-height: 250px;
  }
</style>
