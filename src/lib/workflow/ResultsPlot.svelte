<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { EnrichedResult } from '$lib/api/project'

  load_i18n_module(`workflow`)

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
    { key: `formula`, label: `workflow.results_col_formula`, numeric: false },
    { key: `energy`, label: `workflow.results_col_energy`, numeric: true },
    { key: `energy_per_atom`, label: `workflow.results_col_energy_atom`, numeric: true },
    { key: `natoms`, label: `workflow.results_col_n_atoms`, numeric: true },
    { key: `volume`, label: `workflow.results_col_volume`, numeric: true },
    { key: `a`, label: `a (\u00c5)`, numeric: true },
    { key: `b`, label: `b (\u00c5)`, numeric: true },
    { key: `c`, label: `c (\u00c5)`, numeric: true },
    { key: `node_type`, label: `workflow.results_col_node_type`, numeric: false },
    { key: `workflow_name`, label: `workflow.results_col_workflow`, numeric: false },
    { key: `step_label`, label: `workflow.results_col_step`, numeric: false },
    { key: `frequencies`, label: `workflow.plot_axis_vibrational_freq`, numeric: true },
    { key: `absorption_spectrum`, label: `workflow.plot_axis_uvvis_absorption`, numeric: true },
    { key: `ir_histogram`, label: `workflow.plot_axis_ir_intensity_histogram`, numeric: true },
    { key: `opt_convergence`, label: `workflow.plot_axis_opt_convergence`, numeric: true },
    { key: `neb_profile`, label: `workflow.plot_axis_neb_energy_profile`, numeric: true },
    { key: `irc_profile`, label: `workflow.plot_axis_irc_energy_profile`, numeric: true },
  ]

  const OPT_TYPES = new Set([`orca_opt`, `geo_opt`])
  const NEB_TYPES = new Set([`orca_neb_ts`, `ts_search`])
  const IRC_TYPES = new Set([`orca_irc`, `irc`])

  // Check if any results have frequency data
  function has_frequency_data(): boolean {
    return results.some(r => r.frequencies && r.frequencies.length > 0)
  }

  function has_ir_intensity_data(): boolean {
    return results.some(r => r.frequencies?.some(f => (f.ir_intensity_km_mol ?? 0) > 0))
  }

  function has_convergence_data(): boolean {
    return results.some(r => OPT_TYPES.has(r.node_type) && (r.convergence_points?.length ?? 0) > 0)
  }

  function has_neb_data(): boolean {
    return results.some(r => NEB_TYPES.has(r.node_type) && (r.path_summary?.images?.length ?? 0) > 0)
  }

  function has_irc_data(): boolean {
    return results.some(r => IRC_TYPES.has(r.node_type) && (r.convergence_points?.length ?? 0) > 0)
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

  // IR intensity histogram: frequency on x, IR intensity (km/mol) on y, grouped by color_by
  function build_ir_histogram_traces(): any[] {
    const freq_results = results.filter(r => r.frequencies && r.frequencies.length > 0)
    if (freq_results.length === 0) return []

    const traces: any[] = []
    let color_idx = 0

    const groups = new Map<string, typeof freq_results>()
    for (const r of freq_results) {
      const key = color_by === `none`
        ? `All`
        : String(r[color_by as keyof EnrichedResult] ?? `Unknown`)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }

    for (const [group_name, group_data] of groups) {
      const all_freqs: Array<{ frequency_cm: number; ir_intensity_km_mol: number; label: string }> = []
      for (const result of group_data) {
        if (result.frequencies) {
          for (const f of result.frequencies) {
            all_freqs.push({
              frequency_cm: f.frequency_cm,
              ir_intensity_km_mol: f.ir_intensity_km_mol ?? 0,
              label: result.step_label || result.formula || `Step ${result.step_id}`,
            })
          }
        }
      }

      if (all_freqs.length === 0) continue
      color_idx++

      traces.push({
        x: all_freqs.map(f => f.frequency_cm),
        y: all_freqs.map(f => f.ir_intensity_km_mol),
        type: `bar`,
        name: group_name,
        marker: {
          color: all_freqs.map(f => f.ir_intensity_km_mol),
          colorscale: `RdYlBu_r` as any,
          showscale: color_idx === 1,
          colorbar: { title: `km/mol`, thickness: 12 },
        },
        text: all_freqs.map(f => `${f.label}<br>${f.frequency_cm.toFixed(0)} cm⁻¹<br>${f.ir_intensity_km_mol.toFixed(1)} km/mol`),
        hovertemplate: `%{text}<extra></extra>`,
      })
    }

    return traces
  }

  // Geo-opt convergence: energy (Eh) vs optimization step, one line per result
  function build_convergence_traces(): any[] {
    const opt_results = results.filter(r => OPT_TYPES.has(r.node_type) && r.convergence_points?.length)
    if (opt_results.length === 0) return []

    const traces: any[] = []
    let color_idx = 0

    for (const result of opt_results) {
      const pts = result.convergence_points!
      const label = result.step_label || result.formula || `Step ${result.step_id}`
      const color = COLORS[color_idx % COLORS.length]
      color_idx++

      traces.push({
        x: pts.map(p => p.step),
        y: pts.map(p => p.energy),
        mode: `lines+markers`,
        type: `scatter`,
        name: label,
        line: { color, width: 2 },
        marker: { size: 5, color },
        hovertemplate: `<b>${label}</b><br>Step %{x}<br>Energy: %{y:.6f} Eh<extra></extra>`,
      })
    }

    return traces
  }

  // NEB energy profile: ΔE (kcal/mol) vs image index. TS shown as diamond, CI as triangle-up
  function build_neb_traces(): any[] {
    const neb_results = results.filter(r => NEB_TYPES.has(r.node_type) && r.path_summary?.images?.length)
    if (neb_results.length === 0) return []

    const traces: any[] = []
    let color_idx = 0

    for (const result of neb_results) {
      const images = result.path_summary!.images
      const label = result.step_label || result.formula || `Step ${result.step_id}`
      const color = COLORS[color_idx % COLORS.length]
      color_idx++

      const x = images.map((_, i) => i)
      const y = images.map(img => img.de_kcal_mol)
      const hover = images.map((img, i) => {
        let tip = `<b>${label}</b><br>Image ${i}<br>ΔE = ${img.de_kcal_mol.toFixed(2)} kcal/mol`
        if (img.is_ts) tip += `<br><b>Transition State</b>`
        if (img.is_ci) tip += `<br><b>Climbing Image</b>`
        return tip
      })

      traces.push({
        x, y,
        mode: `lines`,
        type: `scatter`,
        name: label,
        line: { color, width: 2 },
        hoverinfo: `skip`,
        showlegend: true,
      })

      const reg_x = x.filter((_, i) => !images[i].is_ts && !images[i].is_ci)
      const reg_y = y.filter((_, i) => !images[i].is_ts && !images[i].is_ci)
      const reg_hover = hover.filter((_, i) => !images[i].is_ts && !images[i].is_ci)
      if (reg_x.length) {
        traces.push({
          x: reg_x, y: reg_y,
          mode: `markers`, type: `scatter`,
          name: `${label} (images)`,
          marker: { color, size: 7, symbol: `circle` },
          text: reg_hover, hovertemplate: `%{text}<extra></extra>`,
          showlegend: false,
        })
      }

      const ts_indices = x.filter((_, i) => images[i].is_ts)
      const ts_y = y.filter((_, i) => images[i].is_ts)
      const ts_hover = hover.filter((_, i) => images[i].is_ts)
      if (ts_indices.length) {
        const barrier = result.activation_barrier_kcal_mol
        traces.push({
          x: ts_indices, y: ts_y,
          mode: `markers+text`, type: `scatter`,
          name: `${label} (TS)`,
          marker: { color: `#ef4444`, size: 14, symbol: `diamond`, line: { color: `#fca5a5`, width: 2 } },
          text: barrier != null ? [`${barrier.toFixed(1)} kcal/mol`] : ts_indices.map(() => `TS`),
          textposition: `top center`,
          textfont: { size: 11, color: `#fca5a5` },
          hovertext: ts_hover, hovertemplate: `%{hovertext}<extra></extra>`,
          showlegend: false,
        })
      }

      const ci_indices = x.filter((_, i) => images[i].is_ci && !images[i].is_ts)
      const ci_y = y.filter((_, i) => images[i].is_ci && !images[i].is_ts)
      const ci_hover = hover.filter((_, i) => images[i].is_ci && !images[i].is_ts)
      if (ci_indices.length) {
        traces.push({
          x: ci_indices, y: ci_y,
          mode: `markers`, type: `scatter`,
          name: `${label} (CI)`,
          marker: { color: `#f97316`, size: 11, symbol: `triangle-up` },
          text: ci_hover, hovertemplate: `%{text}<extra></extra>`,
          showlegend: false,
        })
      }
    }

    return traces
  }

  // IRC energy profile: ΔE (kcal/mol) vs IRC step. Backward arm purple, forward teal, TS red diamond.
  // Palette matches IrcPathPlot (NodeStatusPanel).
  function build_irc_traces(): any[] {
    const irc_results = results.filter(r => IRC_TYPES.has(r.node_type) && r.convergence_points?.length)
    if (irc_results.length === 0) return []

    const IRC_BACKWARD = `#8b5cf6`
    const IRC_FORWARD = `#10b981`
    const IRC_TS = `#ef4444`
    const IRC_TS_OUTLINE = `#dc2626`

    const traces: any[] = []
    const show_legend = irc_results.length === 1

    for (const result of irc_results) {
      const points = result.convergence_points! as Array<{ step: number; energy: number; dE?: number; is_ts?: boolean }>
      const label = result.step_label || result.formula || `Step ${result.step_id}`

      // Locate TS (parser guarantees points are sorted: backward negative → TS step=0 → forward positive)
      const ts_idx = points.findIndex(p => p.is_ts === true)
      if (ts_idx < 0) continue

      const x = points.map(p => p.step)
      const y = points.map(p => p.dE ?? 0)
      const hover = points.map((p) => {
        let tip = `<b>${label}</b><br>IRC Step ${p.step}<br>ΔE = ${(p.dE ?? 0).toFixed(2)} kcal/mol`
        if (p.is_ts) tip += `<br><b>Transition State</b>`
        return tip
      })

      // Backward arm: indices 0..ts_idx (inclusive of TS so the line connects through it)
      const bwd_x = x.slice(0, ts_idx + 1)
      const bwd_y = y.slice(0, ts_idx + 1)
      const bwd_hover = hover.slice(0, ts_idx + 1)
      if (bwd_x.length > 1) {
        traces.push({
          x: bwd_x, y: bwd_y,
          mode: `lines+markers`, type: `scatter`,
          name: show_legend ? `Backward` : `${label} (backward)`,
          line: { color: IRC_BACKWARD, width: 2 },
          marker: { color: IRC_BACKWARD, size: 6, symbol: `circle` },
          text: bwd_hover, hovertemplate: `%{text}<extra></extra>`,
          showlegend: true,
        })
      }

      // Forward arm: indices ts_idx..end (inclusive of TS so the line connects through it)
      const fwd_x = x.slice(ts_idx)
      const fwd_y = y.slice(ts_idx)
      const fwd_hover = hover.slice(ts_idx)
      if (fwd_x.length > 1) {
        traces.push({
          x: fwd_x, y: fwd_y,
          mode: `lines+markers`, type: `scatter`,
          name: show_legend ? `Forward` : `${label} (forward)`,
          line: { color: IRC_FORWARD, width: 2 },
          marker: { color: IRC_FORWARD, size: 6, symbol: `circle` },
          text: fwd_hover, hovertemplate: `%{text}<extra></extra>`,
          showlegend: true,
        })
      }

      // TS marker
      traces.push({
        x: [x[ts_idx]], y: [y[ts_idx]],
        mode: `markers+text`, type: `scatter`,
        name: show_legend ? `TS` : `${label} (TS)`,
        marker: { color: IRC_TS, size: 14, symbol: `diamond`, line: { color: IRC_TS_OUTLINE, width: 2 } },
        text: [`TS`],
        textposition: `top center`,
        textfont: { size: 11, color: IRC_TS_OUTLINE },
        hovertext: [hover[ts_idx]], hovertemplate: `%{hovertext}<extra></extra>`,
        showlegend: show_legend,
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

    // Special plot modes for spectral and convergence data
    if (x_axis === `frequencies`) {
      traces = build_frequency_traces()
    } else if (x_axis === `absorption_spectrum`) {
      traces = build_uvvis_traces()
    } else if (x_axis === `ir_histogram`) {
      traces = build_ir_histogram_traces()
    } else if (x_axis === `opt_convergence`) {
      traces = build_convergence_traces()
    } else if (x_axis === `neb_profile`) {
      traces = build_neb_traces()
    } else if (x_axis === `irc_profile`) {
      traces = build_irc_traces()
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
    } else if (x_axis === `ir_histogram`) {
      x_label = `Wavenumber (cm⁻¹)`
      y_label = `IR Intensity (km/mol)`
    } else if (x_axis === `opt_convergence`) {
      x_label = `Optimization Step`
      y_label = `Energy (Eh)`
    } else if (x_axis === `neb_profile`) {
      x_label = `Image Index`
      y_label = `ΔE (kcal/mol)`
    } else if (x_axis === `irc_profile`) {
      x_label = `IRC Step`
      y_label = `ΔE (kcal/mol)`
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
        title: { text: x_label, font: { color: text_muted, size: 15 } },
        color: text_muted,
        gridcolor: border_color,
        linecolor: border_color,
        zerolinecolor: border_color,
        tickfont: { size: 13, color: text_muted },
      },
      yaxis: {
        title: { text: y_label, font: { color: text_muted, size: 15 } },
        color: text_muted,
        gridcolor: border_color,
        linecolor: border_color,
        zerolinecolor: border_color,
        tickfont: { size: 13, color: text_muted },
      },
      paper_bgcolor: `transparent`,
      plot_bgcolor: `transparent`,
      font: { color: text_color, family: `'Inter', sans-serif`, size: 13 },
      margin: { t: 24, r: 24, b: 72, l: 84 },
      height: container_height - 60,
      showlegend: color_by !== `none` || x_axis === `frequencies` || x_axis === `absorption_spectrum` || x_axis === `ir_histogram` || x_axis === `opt_convergence` || x_axis === `neb_profile` || x_axis === `irc_profile`,
      legend: {
        font: { size: 13, color: text_muted },
        bgcolor: `transparent`,
      },
      hoverlabel: {
        bgcolor: surface_bg,
        bordercolor: border_color,
        font: { color: text_color, size: 14 },
      },
      barmode: `group` as const,
    }

    // Hide Y axis for frequency stick plot (no meaningful y values)
    if (x_axis === `frequencies`) {
      layout.yaxis.visible = false
    }

    // Zero-line for NEB/IRC profiles (reactant baseline at ΔE = 0)
    if (x_axis === `neb_profile` || x_axis === `irc_profile`) {
      layout.yaxis.zeroline = true
      layout.yaxis.zerolinecolor = `rgba(255,255,255,0.2)`
      layout.yaxis.zerolinewidth = 1
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
      case `ir_histogram`:
        plot_type = `bar`; x_axis = `ir_histogram`; color_by = `workflow_name`; sort_mode = `none`
        break
      case `opt_convergence`:
        plot_type = `line`; x_axis = `opt_convergence`; color_by = `workflow_name`; sort_mode = `none`
        break
      case `neb_profile`:
        plot_type = `line`; x_axis = `neb_profile`; color_by = `workflow_name`; sort_mode = `none`
        break
      case `irc_profile`:
        plot_type = `line`; x_axis = `irc_profile`; color_by = `workflow_name`; sort_mode = `none`
        break
    }
  }
</script>

<div class="results-plot" bind:this={container_div}>
  <!-- Controls bar -->
  <div class="controls-bar">
    <div class="control-group">
      <label>{t(`workflow.type`)}</label>
      <select bind:value={plot_type}>
        <option value="bar">{t(`workflow.bar`)}</option>
        <option value="scatter">{t(`workflow.scatter`)}</option>
        <option value="line">{t(`workflow.line`)}</option>
      </select>
    </div>
    <div class="control-group">
      <label>X</label>
      <select bind:value={x_axis}>
        {#each axis_options as opt}
          <option value={opt.key}>{t(opt.label)}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>Y</label>
      <select bind:value={y_axis}>
        {#each axis_options.filter(o => o.numeric) as opt}
          <option value={opt.key}>{t(opt.label)}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>{t(`workflow.color`)}</label>
      <select bind:value={color_by}>
        {#each color_options as opt}
          <option value={opt.key}>{t(opt.label)}</option>
        {/each}
      </select>
    </div>
    <div class="control-group">
      <label>{t(`workflow.sort`)}</label>
      <select bind:value={sort_mode}>
        <option value="none">{t(`workflow.none`)}</option>
        <option value="x">{t(`workflow.by_x`)}</option>
        <option value="y">{t(`workflow.by_y`)}</option>
      </select>
    </div>

    <div class="control-sep"></div>

    <!-- Presets -->
    <div class="presets">
      <button class="preset-btn" onclick={() => apply_preset(`energy_comparison`)}>{t(`workflow.preset_energy_compare`)}</button>
      <button class="preset-btn" onclick={() => apply_preset(`volume_vs_energy`)}>{t(`workflow.preset_vol_vs_e`)}</button>
      <button class="preset-btn" onclick={() => apply_preset(`lattice_constants`)}>{t(`workflow.preset_lattice`)}</button>
      {#if has_frequency_data()}
        <button class="preset-btn" onclick={() => apply_preset(`vibrational_frequencies`)}>{t(`workflow.preset_frequencies`)}</button>
      {/if}
      {#if has_ir_intensity_data()}
        <button class="preset-btn" onclick={() => apply_preset(`ir_histogram`)}>{t(`workflow.preset_ir_intensities`)}</button>
      {/if}
      {#if has_uvvis_data()}
        <button class="preset-btn" onclick={() => apply_preset(`absorption_spectrum`)}>{t(`workflow.preset_uvvis`)}</button>
      {/if}
      {#if has_convergence_data()}
        <button class="preset-btn" onclick={() => apply_preset(`opt_convergence`)}>{t(`workflow.preset_opt_convergence`)}</button>
      {/if}
      {#if has_neb_data()}
        <button class="preset-btn" onclick={() => apply_preset(`neb_profile`)}>{t(`workflow.preset_neb_profile`)}</button>
      {/if}
      {#if has_irc_data()}
        <button class="preset-btn" onclick={() => apply_preset(`irc_profile`)}>{t(`workflow.preset_irc_profile`)}</button>
      {/if}
    </div>

    <div class="control-sep"></div>

    <!-- Export -->
    <button class="export-btn" onclick={export_png} title={t(`workflow.download_png`)}>PNG</button>
    <button class="export-btn" onclick={export_svg} title={t(`workflow.download_svg`)}>SVG</button>
  </div>

  <!-- Plot area -->
  <div class="plot-area">
    {#if results.length === 0}
      <div class="empty-plot">{t(`workflow.no_data_to_plot`)}</div>
    {:else if !Plotly}
      <div class="loading-plot">{t(`workflow.loading_plot_library`)}</div>
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
