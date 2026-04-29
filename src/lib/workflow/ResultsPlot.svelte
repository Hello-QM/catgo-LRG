<script lang="ts">
  import type { EnrichedResult } from '$lib/api/project'

  let {
    results = [],
    selected_results,
  }: {
    results: EnrichedResult[]
    selected_results?: EnrichedResult[]
  } = $props()

  let plot_div: HTMLDivElement | undefined = $state()
  let container_div: HTMLDivElement | undefined = $state()
  let Plotly: any = $state(null)
  let container_height = $state(400)

  // User controls
  let plot_type = $state<`bar` | `scatter` | `line`>(`bar`)
  let x_axis = $state<string>(`formula`)
  let y_axis = $state<string>(`energy_per_atom`)
  let color_by = $state<string>(`node_type`)
  let sort_mode = $state<`none` | `x` | `y`>(`none`)

  interface AxisOption {
    key: string
    label: string
    numeric: boolean
  }

  const axis_options: AxisOption[] = [
    { key: `formula`, label: `Formula`, numeric: false },
    { key: `energy`, label: `Energy (eV)`, numeric: true },
    { key: `energy_per_atom`, label: `E/atom (eV)`, numeric: true },
    { key: `natoms`, label: `N atoms`, numeric: true },
    { key: `volume`, label: `Volume (\u00c5\u00b3)`, numeric: true },
    { key: `a`, label: `a (\u00c5)`, numeric: true },
    { key: `b`, label: `b (\u00c5)`, numeric: true },
    { key: `c`, label: `c (\u00c5)`, numeric: true },
    { key: `node_type`, label: `Node Type`, numeric: false },
    { key: `workflow_name`, label: `Workflow`, numeric: false },
    { key: `step_label`, label: `Step`, numeric: false },
    { key: `frequencies`, label: `Vibrational Freq (cm\u207b\u00b9)`, numeric: true },
    { key: `absorption_spectrum`, label: `UV-Vis Absorption`, numeric: true },
  ]

  // Check if any results have frequency data
  function has_frequency_data(): boolean {
    return results.some(r => r.frequencies && r.frequencies.length > 0)
  }

  // Check if any results have UV-Vis absorption data
  function has_uvvis_data(): boolean {
    return results.some(r => r.absorption_states && r.absorption_states.length > 0)
  }

  // Build frequency scatter plot traces
  function build_frequency_traces(): any[] {
    const freq_results = results.filter(r => r.frequencies && r.frequencies.length > 0)
    if (freq_results.length === 0) return []

    const traces: any[] = []
    let color_idx = 0

    // Group by category (workflow/formula/node_type)
    const groups = new Map<string, typeof freq_results>()
    for (const r of freq_results) {
      const key = color_by === 'none'
        ? 'All'
        : String(r[color_by as keyof EnrichedResult] ?? 'Unknown')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }

    for (const [group_name, group_data] of groups) {
      // Flatten all frequencies from this group
      const all_freqs: any[] = []
      for (const result of group_data) {
        if (result.frequencies) {
          for (const freq of result.frequencies) {
            all_freqs.push({
              ...freq,
              label: result.step_label || result.formula || `Step ${result.step_id}`
            })
          }
        }
      }

      if (all_freqs.length === 0) continue

      // Separate real and imaginary frequencies
      const real_freqs = all_freqs.filter(f => !f.imaginary)
      const imag_freqs = all_freqs.filter(f => f.imaginary)

      const group_color = COLORS[color_idx % COLORS.length]
      color_idx++

      // Real frequencies trace
      if (real_freqs.length > 0) {
        traces.push({
          x: real_freqs.map(f => f.frequency_cm),
          y: real_freqs.map(() => 1),
          mode: 'markers',
          type: 'scatter',
          name: `${group_name} (real)`,
          marker: {
            size: 8,
            color: group_color,
            symbol: 'line-ns-open',
            opacity: 0.8
          },
          text: real_freqs.map(f => `Mode ${f.index}: ${f.frequency_cm.toFixed(2)} cm\u207b\u00b9<br>${f.label}`),
          hovertemplate: '%{text}<extra></extra>',
        })
      }

      // Imaginary frequencies trace
      if (imag_freqs.length > 0) {
        traces.push({
          x: imag_freqs.map(f => f.frequency_cm),
          y: imag_freqs.map(() => 1),
          mode: 'markers',
          type: 'scatter',
          name: `${group_name} (imaginary)`,
          marker: {
            size: 10,
            color: group_color,
            symbol: 'diamond',
            opacity: 0.8,
            line: { width: 2, color: 'red' }
          },
          text: imag_freqs.map(f => `Mode ${f.index}: -${f.frequency_cm.toFixed(2)} cm\u207b\u00b9 (imaginary)<br>${f.label}`),
          hovertemplate: '%{text}<extra></extra>',
        })
      }
    }

    return traces
  }

  // Build UV-Vis absorption spectrum traces (stick + Gaussian envelope)
  function build_uvvis_traces(): any[] {
    const uvvis_results = results.filter(r => r.absorption_states && r.absorption_states.length > 0)
    if (uvvis_results.length === 0) return []

    const traces: any[] = []
    let color_idx = 0

    // Group by category
    const groups = new Map<string, typeof uvvis_results>()
    for (const r of uvvis_results) {
      const key = color_by === `none`
        ? `All`
        : String(r[color_by as keyof EnrichedResult] ?? `Unknown`)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }

    for (const [group_name, group_data] of groups) {
      // Flatten all absorption states from this group
      const all_states: Array<{ wavelength_nm: number; oscillator_strength: number; label: string }> = []
      for (const result of group_data) {
        if (result.absorption_states) {
          for (const state of result.absorption_states) {
            // Filter out invalid states (negative oscillator strengths from parsing artifacts)
            if (state.oscillator_strength >= 0) {
              all_states.push({
                wavelength_nm: state.wavelength_nm,
                oscillator_strength: state.oscillator_strength,
                label: result.step_label || result.formula || `Step ${result.step_id}`,
              })
            }
          }
        }
      }

      if (all_states.length === 0) continue

      const group_color = COLORS[color_idx % COLORS.length]
      color_idx++

      // Stick spectrum trace (vertical markers)
      traces.push({
        x: all_states.map(s => s.wavelength_nm),
        y: all_states.map(s => s.oscillator_strength),
        mode: `markers`,
        type: `scatter`,
        name: `${group_name} (transitions)`,
        marker: {
          symbol: `line-ns-open`,
          size: 15,
          color: group_color,
          line: { color: group_color, width: 2 },
        },
        text: all_states.map(s =>
          `\u03BB = ${s.wavelength_nm.toFixed(1)} nm<br>f = ${s.oscillator_strength.toFixed(4)}<br>${s.label}`
        ),
        hovertemplate: `%{text}<extra></extra>`,
      })

      // Gaussian envelope trace
      const wavelengths = all_states.map(s => s.wavelength_nm)
      const x_min = Math.min(...wavelengths) - 50
      const x_max = Math.max(...wavelengths) + 50
      const n_points = 200
      const x_points = Array.from({ length: n_points }, (_, i) => x_min + ((x_max - x_min) * i) / (n_points - 1))
      const sigma = 20 // nm broadening width
      const envelope_y = x_points.map(x =>
        all_states.reduce(
          (sum, s) => sum + s.oscillator_strength * Math.exp(-0.5 * ((x - s.wavelength_nm) / sigma) ** 2),
          0
        )
      )

      // Convert hex color to rgba for fill
      const fill_color = group_color + `1a` // ~10% opacity via hex alpha

      traces.push({
        x: x_points,
        y: envelope_y,
        fill: `tozeroy`,
        mode: `lines`,
        type: `scatter`,
        line: { color: group_color, width: 1.5 },
        fillcolor: fill_color,
        name: `${group_name} (envelope)`,
        hoverinfo: `skip`,
        showlegend: false,
      })
    }

    return traces
  }

  const color_options = [
    { key: `none`, label: `None` },
    { key: `node_type`, label: `Node Type` },
    { key: `workflow_name`, label: `Workflow` },
    { key: `formula`, label: `Formula` },
  ]

  const COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]

  // Load Plotly dynamically
  $effect(() => {
    if (typeof window !== `undefined` && !Plotly) {
      import(`plotly.js-dist-min`).then((mod) => {
        Plotly = mod.default ?? mod
      })
    }
  })

  // Fix Plotly's read-only event.target error
  $effect(() => {
    if (!plot_div) return
    function make_target_writable(e: Event) {
      try {
        Object.defineProperty(e, `target`, {
          value: e.target,
          writable: true,
          configurable: true,
        })
      } catch {}
    }
    plot_div.addEventListener(`mousemove`, make_target_writable, true)
    plot_div.addEventListener(`click`, make_target_writable, true)
    return () => {
      plot_div!.removeEventListener(`mousemove`, make_target_writable, true)
      plot_div!.removeEventListener(`click`, make_target_writable, true)
    }
  })

  // Track container size with ResizeObserver
  $effect(() => {
    if (!container_div) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height
        if (h > 50) container_height = h
      }
    })
    ro.observe(container_div)
    return () => ro.disconnect()
  })

  // Main plot rendering effect
  $effect(() => {
    if (!Plotly || !plot_div || results.length === 0) return

    const data_source = selected_results && selected_results.length > 0 ? selected_results : results

    let traces: any[] = []

    // Special plot modes for spectral data
    if (x_axis === `frequencies`) {
      traces = build_frequency_traces()
    } else if (x_axis === `absorption_spectrum`) {
      traces = build_uvvis_traces()
    } else {
      // Regular scatter/bar plot
      let sorted = [...data_source]
      if (sort_mode === `y`) {
        sorted.sort((a, b) => {
          const va = a[y_axis as keyof EnrichedResult] as number ?? 0
          const vb = b[y_axis as keyof EnrichedResult] as number ?? 0
          return va - vb
        })
      } else if (sort_mode === `x`) {
        sorted.sort((a, b) => {
          const va = a[x_axis as keyof EnrichedResult]
          const vb = b[x_axis as keyof EnrichedResult]
          if (typeof va === `string`) return va.localeCompare(vb as string)
          return ((va as number) ?? 0) - ((vb as number) ?? 0)
        })
      }

      if (color_by !== `none`) {
        // Group by color category
        const groups = new Map<string, typeof sorted>()
        for (const r of sorted) {
          const key = String(r[color_by as keyof EnrichedResult] ?? `Unknown`)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(r)
        }

        let color_idx = 0
        for (const [group_name, group_data] of groups) {
          const x = group_data.map(r => r[x_axis as keyof EnrichedResult] ?? ``)
          const y = group_data.map(r => r[y_axis as keyof EnrichedResult] ?? 0)
          const color = COLORS[color_idx % COLORS.length]

          const trace: any = {
            x, y,
            name: group_name,
            type: plot_type === `line` ? `scatter` : plot_type,
            mode: plot_type === `scatter` ? `markers` : plot_type === `line` ? `lines+markers` : undefined,
            marker: { color, size: plot_type === `scatter` ? 8 : undefined },
            hovertemplate: `%{x}<br>%{y:.4f}<br>${group_name}<extra></extra>`,
          }
          traces.push(trace)
          color_idx++
        }
      } else {
        // Single trace
        const x = sorted.map(r => r[x_axis as keyof EnrichedResult] ?? ``)
        const y = sorted.map(r => r[y_axis as keyof EnrichedResult] ?? 0)
        traces.push({
          x, y,
          type: plot_type === `line` ? `scatter` : plot_type,
          mode: plot_type === `scatter` ? `markers` : plot_type === `line` ? `lines+markers` : undefined,
          marker: { color: COLORS[0], size: plot_type === `scatter` ? 8 : undefined },
          hovertemplate: `%{x}<br>%{y:.4f}<extra></extra>`,
        })
      }
    }

    // Determine axis labels (spectral plots have special labels)
    let x_label: string
    let y_label: string
    if (x_axis === `frequencies`) {
      x_label = `Wavenumber (cm\u207b\u00b9)`
      y_label = ``
    } else if (x_axis === `absorption_spectrum`) {
      x_label = `Wavelength (nm)`
      y_label = `Oscillator Strength`
    } else {
      x_label = axis_options.find(o => o.key === x_axis)?.label ?? x_axis
      y_label = axis_options.find(o => o.key === y_axis)?.label ?? y_axis
    }

    // Read theme colors from CSS variables
    const root_style = getComputedStyle(document.documentElement)
    const get_css = (name: string, fallback: string) => root_style.getPropertyValue(name).trim() || fallback
    const text_muted = get_css(`--text-color-muted`, `#94a3b8`)
    const text_color = get_css(`--text-color`, `#e2e8f0`)
    const border_color = get_css(`--border-color`, `rgba(255,255,255,0.1)`)
    const surface_bg = get_css(`--surface-bg`, `#1e293b`)

    const layout: any = {
      xaxis: {
        title: { text: x_label, font: { color: text_muted, size: 12 } },
        color: text_muted,
        gridcolor: border_color,
        linecolor: border_color,
        zerolinecolor: border_color,
        tickfont: { size: 11, color: text_muted },
      },
      yaxis: {
        title: { text: y_label, font: { color: text_muted, size: 12 } },
        color: text_muted,
        gridcolor: border_color,
        linecolor: border_color,
        zerolinecolor: border_color,
        tickfont: { size: 11, color: text_muted },
      },
      paper_bgcolor: `transparent`,
      plot_bgcolor: `transparent`,
      font: { color: text_color, family: `'Inter', sans-serif` },
      margin: { t: 20, r: 20, b: 60, l: 70 },
      height: container_height - 60,
      showlegend: color_by !== `none` || x_axis === `frequencies` || x_axis === `absorption_spectrum`,
      legend: {
        font: { size: 11, color: text_muted },
        bgcolor: `transparent`,
      },
      hoverlabel: {
        bgcolor: surface_bg,
        bordercolor: border_color,
        font: { color: text_color, size: 12 },
      },
      barmode: `group` as const,
    }

    // Hide Y axis for frequency stick plot (no meaningful y values)
    if (x_axis === `frequencies`) {
      layout.yaxis.visible = false
    }

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: [`sendDataToCloud`, `lasso2d`, `select2d`],
      displaylogo: false,
    }

    Plotly.react(plot_div, traces, layout, config)
  })

  function export_png() {
    if (!Plotly || !plot_div) return
    Plotly.downloadImage(plot_div, { format: `png`, width: 1200, height: 800, filename: `results_plot` })
  }

  function export_svg() {
    if (!Plotly || !plot_div) return
    Plotly.downloadImage(plot_div, { format: `svg`, width: 1200, height: 800, filename: `results_plot` })
  }

  function apply_preset(preset: string) {
    switch (preset) {
      case `energy_comparison`:
        plot_type = `bar`; x_axis = `formula`; y_axis = `energy_per_atom`; color_by = `workflow_name`; sort_mode = `y`
        break
      case `volume_vs_energy`:
        plot_type = `scatter`; x_axis = `volume`; y_axis = `energy_per_atom`; color_by = `formula`; sort_mode = `none`
        break
      case `lattice_constants`:
        plot_type = `bar`; x_axis = `formula`; y_axis = `a`; color_by = `node_type`; sort_mode = `none`
        break
      case `vibrational_frequencies`:
        plot_type = `scatter`; x_axis = `frequencies`; y_axis = `energy`; color_by = `workflow_name`; sort_mode = `none`
        break
      case `absorption_spectrum`:
        plot_type = `scatter`; x_axis = `absorption_spectrum`; y_axis = `energy`; color_by = `workflow_name`; sort_mode = `none`
        break
    }
  }
</script>

<div class="results-plot" bind:this={container_div}>
  <!-- Controls bar -->
  <div class="controls-bar">
    <div class="control-group">
      <label>Type</label>
      <select bind:value={plot_type}>
        <option value="bar">Bar</option>
        <option value="scatter">Scatter</option>
        <option value="line">Line</option>
      </select>
    </div>
    <div class="control-group">
      <label>X</label>
      <select bind:value={x_axis}>
        {#each axis_options as opt}
          <option value={opt.key}>{opt.label}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>Y</label>
      <select bind:value={y_axis}>
        {#each axis_options.filter(o => o.numeric) as opt}
          <option value={opt.key}>{opt.label}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>Color</label>
      <select bind:value={color_by}>
        {#each color_options as opt}
          <option value={opt.key}>{opt.label}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>Sort</label>
      <select bind:value={sort_mode}>
        <option value="none">None</option>
        <option value="x">By X</option>
        <option value="y">By Y</option>
      </select>
    </div>

    <div class="control-sep"></div>

    <!-- Presets -->
    <div class="presets">
      <button class="preset-btn" onclick={() => apply_preset(`energy_comparison`)}>Energy Compare</button>
      <button class="preset-btn" onclick={() => apply_preset(`volume_vs_energy`)}>Vol vs E</button>
      <button class="preset-btn" onclick={() => apply_preset(`lattice_constants`)}>Lattice</button>
      {#if has_frequency_data()}
        <button class="preset-btn" onclick={() => apply_preset(`vibrational_frequencies`)}>Frequencies</button>
      {/if}
      {#if has_uvvis_data()}
        <button class="preset-btn" onclick={() => apply_preset(`absorption_spectrum`)}>UV-Vis</button>
      {/if}
    </div>

    <div class="control-sep"></div>

    <!-- Export -->
    <button class="export-btn" onclick={export_png} title="Download PNG">PNG</button>
    <button class="export-btn" onclick={export_svg} title="Download SVG">SVG</button>
  </div>

  <!-- Plot area -->
  <div class="plot-area">
    {#if results.length === 0}
      <div class="empty-plot">No data to plot</div>
    {:else if !Plotly}
      <div class="loading-plot">Loading plot library...</div>
    {:else}
      <div class="plot-container" bind:this={plot_div}></div>
    {/if}
  </div>
</div>

<style>
  .results-plot {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 300px;
  }

  .controls-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: end;
    padding: 8px 0;
    margin-bottom: 8px;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .control-group label {
    font-size: 10px;
    color: var(--text-color-muted, #64748b);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .control-group select {
    padding: 4px 8px;
    background: var(--input-bg, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    border-radius: 4px;
    color: var(--text-color, #e2e8f0);
    font-size: 12px;
    outline: none;
    cursor: pointer;
    appearance: auto;
  }

  .control-group select:focus {
    border-color: var(--accent-color, rgba(59, 130, 246, 0.5));
  }

  .control-sep {
    width: 1px;
    height: 28px;
    background: var(--border-color, rgba(255, 255, 255, 0.08));
    margin: 0 4px;
    align-self: center;
  }

  .preset-btn {
    padding: 4px 10px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 4px;
    color: var(--accent-color, #60a5fa);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .preset-btn:hover {
    background: rgba(59, 130, 246, 0.2);
  }

  .export-btn {
    padding: 4px 10px;
    background: var(--input-bg, rgba(255, 255, 255, 0.05));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 11px;
    cursor: pointer;
  }

  .export-btn:hover {
    background: var(--surface-bg-hover, rgba(255, 255, 255, 0.1));
  }

  .plot-area {
    flex: 1;
    position: relative;
    min-height: 250px;
  }

  .plot-container {
    width: 100%;
    height: 100%;
  }

  .empty-plot,
  .loading-plot {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-color-muted, #475569);
    font-size: 13px;
  }
</style>
