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

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------
  function parse_atom_indices(text: string): number[] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const parts = trimmed.split(`,`).map((s) => s.trim()).filter(Boolean)
    const indices: number[] = []
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (isNaN(n) || n < 0) return null
      indices.push(n)
    }
    return indices.length > 0 ? indices : null
  }

  // ---------------------------------------------------------------------------
  // 1D Density Profile state
  // ---------------------------------------------------------------------------
  let profile_axis = $state<`x` | `y` | `z`>(`z`)
  let profile_n_bins = $state(100)
  let profile_density_type = $state<`number` | `mass`>(`number`)
  let profile_atom_indices_text = $state(``)
  let profile_frame_start = $state(``)
  let profile_frame_end = $state(``)
  let profile_computing = $state(false)
  let profile_error = $state(``)
  let profile_result: any = $state(null)

  async function compute_profile() {
    profile_computing = true
    profile_error = ``
    profile_result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        axis: profile_axis,
        n_bins: profile_n_bins,
        density_type: profile_density_type,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const indices = parse_atom_indices(profile_atom_indices_text)
      if (indices) body.atom_indices = indices

      const fs = parseInt(profile_frame_start, 10)
      const fe = parseInt(profile_frame_end, 10)
      if (!isNaN(fs) && !isNaN(fe)) {
        body.frame_range = [fs, fe]
      }

      const resp = await fetch(`${server_url}/api/md/density/profile`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      profile_result = await resp.json()

      // Emit plot data for 1D density profile
      const unit = profile_result.density_type === `number` ? `atoms/A^3` : `g/cm^3`
      const trace = {
        x: profile_result.bin_centers,
        y: profile_result.density,
        type: `scatter`,
        mode: `lines`,
        line: { color: `#1f77b4`, width: 1.5 },
        name: `Density`,
      }
      on_plot({
        traces: [trace],
        title: `Density Profile`,
        x_label: `Position along ${profile_result.axis.toUpperCase()} (A)`,
        y_label: `Density (${unit})`,
      })
    } catch (e: any) {
      profile_error = e.message || `Computation failed`
    } finally {
      profile_computing = false
    }
  }

  // ---------------------------------------------------------------------------
  // 2D Planar Density state
  // ---------------------------------------------------------------------------
  let planar_plane = $state<`xy` | `xz` | `yz`>(`xy`)
  let planar_nx = $state(50)
  let planar_ny = $state(50)
  let planar_z_min = $state(``)
  let planar_z_max = $state(``)
  let planar_atom_indices_text = $state(``)
  let planar_frame_start = $state(``)
  let planar_frame_end = $state(``)
  let planar_computing = $state(false)
  let planar_error = $state(``)
  let planar_result: any = $state(null)

  async function compute_planar() {
    planar_computing = true
    planar_error = ``
    planar_result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        plane: planar_plane,
        n_bins: [planar_nx, planar_ny],
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const z_min_val = parseFloat(planar_z_min)
      const z_max_val = parseFloat(planar_z_max)
      if (!isNaN(z_min_val) && !isNaN(z_max_val)) {
        body.z_range = [z_min_val, z_max_val]
      }

      const indices = parse_atom_indices(planar_atom_indices_text)
      if (indices) body.atom_indices = indices

      const fs = parseInt(planar_frame_start, 10)
      const fe = parseInt(planar_frame_end, 10)
      if (!isNaN(fs) && !isNaN(fe)) {
        body.frame_range = [fs, fe]
      }

      const resp = await fetch(`${server_url}/api/md/density/planar`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      planar_result = await resp.json()

      // Emit plot data for 2D planar density heatmap
      const trace = {
        type: `heatmap`,
        z: planar_result.density,
        x: planar_result.x_edges,
        y: planar_result.y_edges,
        colorscale: `Viridis`,
        colorbar: {
          title: `Density (atoms/A^3)`,
          titlefont: { color: `#ccc` },
          tickfont: { color: `#ccc` },
        },
      }
      on_plot({
        traces: [trace],
        title: `Planar Density`,
        x_label: planar_result.x_label,
        y_label: planar_result.y_label,
        layout_overrides: { hovermode: `closest` },
      })
    } catch (e: any) {
      planar_error = e.message || `Computation failed`
    } finally {
      planar_computing = false
    }
  }
</script>

<div class="density-panel">
  <!-- ===== 1D Density Profile ===== -->
  <details open>
    <summary>{t('structure.md_density_profile_1d')}</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_axis')}
        <select bind:value={profile_axis}>
          <option value="x">x</option>
          <option value="y">y</option>
          <option value="z">z</option>
        </select>
      </label>
      <label>
        {t('structure.md_number_of_bins')}
        <input type="number" bind:value={profile_n_bins} min="1" max="10000" step="10" />
      </label>
      <label>
        {t('structure.md_density_type')}
        <select bind:value={profile_density_type}>
          <option value="number">{t('structure.md_number_density')}</option>
          <option value="mass">{t('structure.md_mass_density')}</option>
        </select>
      </label>
      <label>
        {t('structure.md_atom_indices')}
        <input
          type="text"
          placeholder="0,1,2,5 (optional)"
          bind:value={profile_atom_indices_text}
        />
      </label>
      <label>
        {t('structure.md_frame_start')}
        <input type="text" placeholder="(optional)" bind:value={profile_frame_start} />
      </label>
      <label>
        {t('structure.md_frame_end')}
        <input type="text" placeholder="(optional)" bind:value={profile_frame_end} />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_profile}
      disabled={profile_computing}
    >
      {#if profile_computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_profile')}
      {/if}
    </button>

    {#if profile_error}
      <div class="error-msg">{profile_error}</div>
    {/if}

    {#if profile_result}
      <div class="info-bar">
        <span title={t('structure.md_atoms_selected')}>{t('structure.md_atoms_count', { n: profile_result.n_atoms_selected })}</span>
        <span title={t('structure.md_total_frames')}>{t('structure.md_frames_count', { n: profile_result.total_frames })}</span>
        <span title={t('structure.md_bin_width')}>{profile_result.bin_width.toFixed(3)} A/bin</span>
      </div>
    {/if}
  </details>

  <!-- ===== 2D Planar Density ===== -->
  <details>
    <summary>{t('structure.md_planar_density_2d')}</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_plane')}
        <select bind:value={planar_plane}>
          <option value="xy">xy</option>
          <option value="xz">xz</option>
          <option value="yz">yz</option>
        </select>
      </label>
      <label>
        {t('structure.md_grid_bins_nx')}
        <input type="number" bind:value={planar_nx} min="1" max="10000" step="10" />
      </label>
      <label>
        {t('structure.md_grid_bins_ny')}
        <input type="number" bind:value={planar_ny} min="1" max="10000" step="10" />
      </label>
      <label>
        {t('structure.md_axis_range_min_angstrom', { axis: planar_plane === `xy` ? `Z` : planar_plane === `xz` ? `Y` : `X` })}
        <input type="text" placeholder="(optional)" bind:value={planar_z_min} />
      </label>
      <label>
        {t('structure.md_axis_range_max_angstrom', { axis: planar_plane === `xy` ? `Z` : planar_plane === `xz` ? `Y` : `X` })}
        <input type="text" placeholder="(optional)" bind:value={planar_z_max} />
      </label>
      <label>
        {t('structure.md_atom_indices')}
        <input
          type="text"
          placeholder="0,1,2,5 (optional)"
          bind:value={planar_atom_indices_text}
        />
      </label>
      <label>
        {t('structure.md_frame_start')}
        <input type="text" placeholder="(optional)" bind:value={planar_frame_start} />
      </label>
      <label>
        {t('structure.md_frame_end')}
        <input type="text" placeholder="(optional)" bind:value={planar_frame_end} />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_planar}
      disabled={planar_computing}
    >
      {#if planar_computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_density_map')}
      {/if}
    </button>

    {#if planar_error}
      <div class="error-msg">{planar_error}</div>
    {/if}

    {#if planar_result}
      <div class="info-bar">
        <span title={t('structure.md_total_frames')}>{t('structure.md_frames_count', { n: planar_result.total_frames })}</span>
        <span title={t('structure.md_atoms_selected')}>{t('structure.md_atoms_count', { n: planar_result.n_atoms_selected })}</span>
      </div>
    {/if}
  </details>
</div>

<style>
  .density-panel {
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
