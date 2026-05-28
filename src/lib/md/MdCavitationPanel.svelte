<script lang="ts">
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    trajectory_b64,
    trajectory_format,
    topology_b64 = null,
    topology_format = ``,
    on_plot = (_data: any) => {},
  }: {
    trajectory_b64: string
    trajectory_format: string
    topology_b64?: string | null
    topology_format?: string
    on_plot?: (data: { traces: any[]; title: string; x_label: string; y_label: string; layout_overrides?: Record<string, any> } | null) => void
  } = $props()

  const server_url = `http://localhost:8000`

  type LCWRegion = {
    region: string
    z_range_angstrom: [number, number]
    probe_radii_angstrom: number[]
    cavity_volume_angstrom3: number[]
    delta_g_cav_eV: number[]
    linear_fit_slope_eV_per_A3: number | null
    linear_fit_intercept_eV: number | null
    linear_fit_r_squared: number | null
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let solvent_element = $state(`O`)
  let probe_radii_text = $state(`1.25,1.5,1.75,2.0,2.25,2.5`)
  let axis = $state<`x` | `y` | `z`>(`z`)
  let n_z_bins = $state(60)
  let z_min = $state(``)
  let z_max = $state(``)
  let grid_spacing = $state(0.8)
  let frame_stride = $state(1)
  let temperature_K = $state(300)
  let ihp_min = $state(``)
  let ihp_max = $state(``)
  let stern_min = $state(``)
  let stern_max = $state(``)
  let periodic = $state(true)
  let plot_mode = $state<`profile` | `heatmap` | `lcw`>(`profile`)
  let computing = $state(false)
  let error = $state(``)
  let result: {
    axis: string
    probe_radii_angstrom: number[]
    z_bin_centers_angstrom: number[]
    p0: number[][]
    delta_g_cav_eV: number[][]
    sampling_lower_bound_eV: number[][]
    n_samples: number[][]
    temperature_K: number
    n_frames_used: number
    n_solvent_atoms: number
    lcw_ihp: LCWRegion | null
    lcw_stern: LCWRegion | null
    migration_descriptor_eV: number[] | null
  } | null = $state(null)

  function parse_float_list(text: string): number[] | null {
    const parts = text.split(`,`).map((s) => s.trim()).filter(Boolean)
    const out: number[] = []
    for (const p of parts) {
      const v = parseFloat(p)
      if (isNaN(v) || v <= 0) return null
      out.push(v)
    }
    return out.length > 0 ? out : null
  }

  const COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]

  function emit_plot(res: NonNullable<typeof result>) {
    if (plot_mode === `heatmap`) {
      on_plot({
        traces: [
          {
            type: `heatmap`,
            z: res.delta_g_cav_eV,
            x: res.z_bin_centers_angstrom,
            y: res.probe_radii_angstrom,
            colorscale: `Viridis`,
            colorbar: { title: `ΔG_cav (eV)` },
          },
        ],
        title: t('structure.md_cav_heatmap_title'),
        x_label: `${res.axis.toUpperCase()} (Å)`,
        y_label: t('structure.md_probe_radius_angstrom'),
        layout_overrides: { hovermode: `closest` },
      })
      return
    }

    if (plot_mode === `lcw`) {
      const traces: any[] = []
      if (res.lcw_ihp) {
        traces.push({
          x: res.lcw_ihp.cavity_volume_angstrom3,
          y: res.lcw_ihp.delta_g_cav_eV,
          type: `scatter`,
          mode: `markers+lines`,
          marker: { size: 8, color: `#d62728` },
          line: { color: `#d62728`, width: 1.5 },
          name: `IHP`,
        })
      }
      if (res.lcw_stern) {
        traces.push({
          x: res.lcw_stern.cavity_volume_angstrom3,
          y: res.lcw_stern.delta_g_cav_eV,
          type: `scatter`,
          mode: `markers+lines`,
          marker: { size: 8, color: `#1f77b4` },
          line: { color: `#1f77b4`, width: 1.5 },
          name: `Stern`,
        })
      }
      if (traces.length === 0) {
        on_plot({
          traces: [],
          title: t('structure.md_lcw_scaling_hint_title'),
          x_label: t('structure.md_cavity_volume_ang3'),
          y_label: `ΔG_cav (eV)`,
        })
        return
      }
      on_plot({
        traces,
        title: t('structure.md_lcw_cav_vs_volume'),
        x_label: t('structure.md_cavity_volume_ang3'),
        y_label: `ΔG_cav (eV)`,
      })
      return
    }

    // profile mode: one ΔG_cav(z) line per probe radius
    const traces = res.probe_radii_angstrom.map((r, i) => ({
      x: res.z_bin_centers_angstrom,
      y: res.delta_g_cav_eV[i],
      type: `scatter`,
      mode: `lines`,
      line: { color: COLORS[i % COLORS.length], width: 1.5 },
      name: `R=${r.toFixed(2)} Å`,
    }))
    on_plot({
      traces,
      title: t('structure.md_cav_free_energy_profile'),
      x_label: `${res.axis.toUpperCase()} (Å)`,
      y_label: `ΔG_cav (eV)`,
    })
  }

  async function compute_cavitation() {
    computing = true
    error = ``
    result = null

    try {
      const radii = parse_float_list(probe_radii_text)
      if (!radii) throw new Error(t('structure.md_probe_radii_invalid'))

      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        solvent_element: solvent_element.trim() || `O`,
        probe_radii_angstrom: radii,
        axis,
        n_z_bins,
        grid_spacing_angstrom: grid_spacing,
        frame_stride,
        temperature_K,
        periodic,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const zmin_val = parseFloat(z_min)
      const zmax_val = parseFloat(z_max)
      if (!isNaN(zmin_val) && !isNaN(zmax_val)) {
        body.z_range = [zmin_val, zmax_val]
      }

      const i1 = parseFloat(ihp_min)
      const i2 = parseFloat(ihp_max)
      if (!isNaN(i1) && !isNaN(i2)) body.ihp_z_range = [i1, i2]
      const s1 = parseFloat(stern_min)
      const s2 = parseFloat(stern_max)
      if (!isNaN(s1) && !isNaN(s2)) body.stern_z_range = [s1, s2]

      const resp = await fetch(`${server_url}/api/md/cavitation/profile`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      result = await resp.json()
      emit_plot(result!)
    } catch (e: any) {
      error = e.message || t('structure.computation_failed')
    } finally {
      computing = false
    }
  }

  $effect(() => {
    if (result) emit_plot(result)
  })
</script>

<div class="cav-panel">
  <details open>
    <summary>{t('structure.md_lcw_cav_free_energy')}</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_solvent_element')}
        <input type="text" bind:value={solvent_element} />
      </label>
      <label>
        {t('structure.md_surface_normal')}
        <select bind:value={axis}>
          <option value="x">x</option>
          <option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label class="wide">
        {t('structure.md_probe_radii_comma')}
        <input type="text" bind:value={probe_radii_text} />
      </label>
      <label>
        {t('structure.md_number_z_bins')}
        <input type="number" bind:value={n_z_bins} min="1" max="1000" />
      </label>
      <label>
        {t('structure.md_grid_spacing_angstrom')}
        <input type="number" bind:value={grid_spacing} min="0.1" step="0.1" />
      </label>
      <label>
        {t('structure.md_z_min_angstrom')}
        <input type="text" placeholder="auto" bind:value={z_min} />
      </label>
      <label>
        {t('structure.md_z_max_angstrom')}
        <input type="text" placeholder="auto" bind:value={z_max} />
      </label>
      <label>
        {t('structure.md_frame_stride')}
        <input type="number" bind:value={frame_stride} min="1" />
      </label>
      <label>
        {t('structure.md_temperature_k')}
        <input type="number" bind:value={temperature_K} min="1" step="10" />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={periodic} />
        {t('structure.md_periodic_pbc')}
      </label>
    </div>

    <div class="subheading">{t('structure.md_lcw_windows_optional')}</div>
    <div class="param-grid">
      <label>
        IHP z min (Å)
        <input type="text" bind:value={ihp_min} />
      </label>
      <label>
        IHP z max (Å)
        <input type="text" bind:value={ihp_max} />
      </label>
      <label>
        Stern z min (Å)
        <input type="text" bind:value={stern_min} />
      </label>
      <label>
        Stern z max (Å)
        <input type="text" bind:value={stern_max} />
      </label>
    </div>

    <div class="plot-mode-row">
      <span>{t('structure.md_plot')}:</span>
      <label><input type="radio" value="profile" bind:group={plot_mode} /> ΔG_cav(z)</label>
      <label><input type="radio" value="heatmap" bind:group={plot_mode} /> heatmap</label>
      <label><input type="radio" value="lcw" bind:group={plot_mode} /> {t('structure.md_lcw_fit')}</label>
    </div>

    <button class="btn-compute" onclick={compute_cavitation} disabled={computing}>
      {#if computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_dg_cav')}
      {/if}
    </button>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    {#if result}
      <div class="info-bar">
        <span title={t('structure.md_frames_used')}>{t('structure.md_frames_count', { n: result.n_frames_used })}</span>
        <span title={t('structure.md_solvent_atoms')}>{t('structure.md_solvent_count', { n: result.n_solvent_atoms })}</span>
        <span>T = {result.temperature_K} K</span>
      </div>

      {#if result.lcw_ihp?.linear_fit_slope_eV_per_A3 !== null && result.lcw_ihp?.linear_fit_slope_eV_per_A3 !== undefined}
        <div class="lcw-summary">
          <strong>{t('structure.md_ihp_lcw_fit')}:</strong>
          slope = {result.lcw_ihp.linear_fit_slope_eV_per_A3.toExponential(3)} eV/Å³,
          R² = {result.lcw_ihp.linear_fit_r_squared?.toFixed(4) ?? `—`}
        </div>
      {/if}
      {#if result.lcw_stern?.linear_fit_slope_eV_per_A3 !== null && result.lcw_stern?.linear_fit_slope_eV_per_A3 !== undefined}
        <div class="lcw-summary">
          <strong>{t('structure.md_stern_lcw_fit')}:</strong>
          slope = {result.lcw_stern.linear_fit_slope_eV_per_A3.toExponential(3)} eV/Å³,
          R² = {result.lcw_stern.linear_fit_r_squared?.toFixed(4) ?? `—`}
        </div>
      {/if}
      {#if result.migration_descriptor_eV}
        <div class="lcw-summary migration">
          <strong>{t('structure.md_migration_descriptor')}:</strong>
          {#each result.migration_descriptor_eV as dg, i}
            <span>R={result.probe_radii_angstrom[i].toFixed(2)}: {dg.toFixed(4)}</span>
          {/each}
        </div>
      {/if}
    {/if}
  </details>
</div>

<style>
  .cav-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.82em;
  }
  details {
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.03));
    border-radius: 6px;
    padding: 6px 8px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 0.88em;
    color: var(--text-color);
    user-select: none;
  }
  .subheading {
    margin-top: 10px;
    margin-bottom: 4px;
    font-weight: 600;
    font-size: 0.85em;
    color: var(--text-color-muted);
  }
  .param-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 6px;
  }
  .param-grid label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.85em;
    color: var(--text-color-muted);
  }
  .param-grid label.wide {
    grid-column: span 2;
  }
  .checkbox-label {
    flex-direction: row !important;
    align-items: center;
    gap: 6px !important;
  }
  .checkbox-label input {
    width: auto;
  }
  .param-grid input[type="number"],
  .param-grid input[type="text"],
  .param-grid select {
    padding: 3px 5px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    color: var(--text-color);
    font-size: 0.95em;
    width: 100%;
    box-sizing: border-box;
  }
  .plot-mode-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 8px;
    font-size: 0.85em;
    color: var(--text-color-muted);
  }
  .plot-mode-row label {
    display: flex;
    gap: 4px;
    align-items: center;
    cursor: pointer;
  }
  .btn-compute {
    padding: 6px 12px;
    background: var(--accent-color, #007acc);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 8px;
  }
  .btn-compute:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error-msg {
    padding: 5px 8px;
    background: light-dark(rgba(220, 60, 60, 0.1), rgba(255, 60, 60, 0.15));
    border: 1px solid light-dark(rgba(220, 60, 60, 0.25), rgba(255, 60, 60, 0.3));
    border-radius: 4px;
    color: var(--error-color);
    font-size: 0.85em;
    margin-top: 6px;
  }
  .info-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 4px 6px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border-radius: 4px;
    font-size: 0.85em;
    color: var(--text-color-muted);
    margin-top: 6px;
  }
  .info-bar span {
    padding: 1px 4px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border-radius: 3px;
  }
  .lcw-summary {
    margin-top: 6px;
    padding: 4px 6px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border-radius: 4px;
    font-size: 0.82em;
    color: var(--text-color);
  }
  .lcw-summary.migration {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .lcw-summary.migration span {
    padding: 1px 4px;
    background: light-dark(rgba(0, 0, 0, 0.05), rgba(255, 255, 255, 0.06));
    border-radius: 3px;
  }
</style>
