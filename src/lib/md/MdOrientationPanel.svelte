<script lang="ts">
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let axis = $state<`x` | `y` | `z`>(`z`)
  let n_bins = $state(100)
  let z_min = $state(``)
  let z_max = $state(``)
  let frame_start = $state(``)
  let frame_end = $state(``)
  let oh_cutoff = $state(1.25)
  let periodic = $state(true)
  let compute_p2 = $state(true)
  let computing = $state(false)
  let error = $state(``)
  let result: {
    axis: string
    bin_centers_angstrom: number[]
    cos_phi_mean: number[]
    p2_cos_phi_mean: number[] | null
    counts: number[]
    n_frames_used: number
    n_waters_mean: number
  } | null = $state(null)

  async function compute_orientation() {
    computing = true
    error = ``
    result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        axis,
        n_bins,
        oh_cutoff_angstrom: oh_cutoff,
        periodic,
        compute_p2,
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

      const fs = parseInt(frame_start, 10)
      const fe = parseInt(frame_end, 10)
      if (!isNaN(fs) && !isNaN(fe)) body.frame_range = [fs, fe]

      const resp = await fetch(`${server_url}/api/md/orientation/water`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      result = await resp.json()

      const traces: any[] = [
        {
          x: result!.bin_centers_angstrom,
          y: result!.cos_phi_mean,
          type: `scatter`,
          mode: `lines`,
          line: { color: `#1f77b4`, width: 1.5 },
          name: `⟨cos φ⟩`,
        },
      ]

      if (result!.p2_cos_phi_mean) {
        traces.push({
          x: result!.bin_centers_angstrom,
          y: result!.p2_cos_phi_mean,
          type: `scatter`,
          mode: `lines`,
          line: { color: `#ff7f0e`, width: 1.5, dash: `dot` },
          name: `⟨P₂(cos φ)⟩`,
        })
      }

      on_plot({
        traces,
        title: t('structure.md_water_orientation_order_parameter'),
        x_label: `${result!.axis.toUpperCase()} (Å)`,
        y_label: t('structure.md_order_parameter'),
      })
    } catch (e: any) {
      error = e.message || t('structure.computation_failed')
    } finally {
      computing = false
    }
  }
</script>

<div class="orientation-panel">
  <details open>
    <summary>{t('structure.md_water_orientation_summary')}</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_surface_normal')}
        <select bind:value={axis}>
          <option value="x">x</option>
          <option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label>
        {t('structure.md_number_of_bins')}
        <input type="number" bind:value={n_bins} min="1" max="5000" step="10" />
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
        {t('structure.md_oh_cutoff_angstrom')}
        <input type="number" bind:value={oh_cutoff} min="0.5" max="2" step="0.05" />
      </label>
      <label>
        {t('structure.md_frame_start')}
        <input type="text" placeholder="(optional)" bind:value={frame_start} />
      </label>
      <label>
        {t('structure.md_frame_end')}
        <input type="text" placeholder="(optional)" bind:value={frame_end} />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={periodic} />
        {t('structure.md_periodic_pbc')}
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={compute_p2} />
        {t('structure.md_also_p2')}
      </label>
    </div>

    <button class="btn-compute" onclick={compute_orientation} disabled={computing}>
      {#if computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_orientation_profile')}
      {/if}
    </button>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    {#if result}
      <div class="info-bar">
        <span title={t('structure.md_frames_used')}>{t('structure.md_frames_count', { n: result.n_frames_used })}</span>
        <span title={t('structure.md_avg_water_per_frame')}>
          {result.n_waters_mean.toFixed(1)} H₂O/frame
        </span>
        <span>axis = {result.axis}</span>
      </div>
    {/if}
  </details>
</div>

<style>
  .orientation-panel {
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
</style>
