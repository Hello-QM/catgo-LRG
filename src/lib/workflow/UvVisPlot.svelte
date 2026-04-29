<script lang="ts">
  import { onMount } from 'svelte'

  let {
    transitions = [],
  }: {
    transitions: Array<{ state: number; wavelength_nm: number; oscillator_strength: number; energy_ev: number }>
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)

  // Load Plotly lazily
  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      import(`plotly.js-dist-min`).then((mod) => {
        Plotly = mod.default ?? mod
      })
    }
  })

  // Fix Plotly's read-only event.target bug (required for all Plotly components)
  function make_target_writable(event: Event) {
    Object.defineProperty(event, 'target', { writable: true, value: event.currentTarget })
  }

  $effect(() => {
    if (!Plotly || !plot_div || transitions.length === 0) return

    // Build stick trace (vertical lines for each transition)
    const stick_trace = {
      x: transitions.map((t) => t.wavelength_nm),
      y: transitions.map((t) => t.oscillator_strength),
      mode: `markers`,
      type: `scatter`,
      marker: {
        symbol: `line-ns`,
        size: 15,
        line: { color: `#7c3aed`, width: 2 },
      },
      hovertemplate: `<b>λ = %{x:.1f} nm</b><br>f = %{y:.4f}<extra></extra>`,
      name: `Transitions`,
    }

    // Build Gaussian envelope trace (broadened spectrum for visualization)
    const x_min = Math.min(...transitions.map((t) => t.wavelength_nm)) - 50
    const x_max = Math.max(...transitions.map((t) => t.wavelength_nm)) + 50
    const x_points = Array.from({ length: 200 }, (_, i) => x_min + ((x_max - x_min) * i) / 199)

    const sigma = 20 // nm, broadening width
    const envelope_y = x_points.map((x) =>
      transitions.reduce(
        (sum, t) => sum + t.oscillator_strength * Math.exp(-0.5 * Math.pow((x - t.wavelength_nm) / sigma, 2)),
        0,
      ),
    )

    const envelope_trace = {
      x: x_points,
      y: envelope_y,
      fill: `tozeroy`,
      mode: `lines`,
      line: { color: `rgba(124, 58, 237, 0.3)`, width: 1 },
      fillcolor: `rgba(124, 58, 237, 0.1)`,
      hoverinfo: `skip`,
      showlegend: false,
    }

    const layout = {
      title: false,
      xaxis: {
        title: `Wavelength (nm)`,
        showgrid: true,
        zeroline: false,
        color: `var(--text-color, #374151)`,
      },
      yaxis: {
        title: `Oscillator Strength`,
        showgrid: true,
        zeroline: false,
        color: `var(--text-color, #374151)`,
      },
      plot_bgcolor: `transparent`,
      paper_bgcolor: `transparent`,
      margin: { l: 50, r: 20, t: 20, b: 40 },
      height: 180,
      hovermode: `closest`,
      font: {
        family: `'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace`,
        size: 11,
        color: `var(--text-color, #374151)`,
      },
    }

    const config = {
      responsive: true,
      displayModeBar: false,
      staticPlot: false,
    }

    Plotly.react(plot_div, [envelope_trace, stick_trace], layout, config)
  })

  onMount(() => {
    if (plot_div) {
      plot_div.addEventListener(`mousemove`, make_target_writable, true)
    }
    return () => {
      if (plot_div) {
        plot_div.removeEventListener(`mousemove`, make_target_writable, true)
      }
    }
  })
</script>

<div bind:this={plot_div} class="uv-vis-plot"></div>

<style>
  .uv-vis-plot {
    width: 100%;
    min-height: 180px;
  }
</style>
