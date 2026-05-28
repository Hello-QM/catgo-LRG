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

  function parse_atom_indices(text: string): number[] | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    const parts = trimmed.split(`,`).map((s) => s.trim()).filter(Boolean)
    const out: number[] = []
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (isNaN(n) || n < 0) return null
      out.push(n)
    }
    return out.length > 0 ? out : null
  }

  // ---------------------------------------------------------------------------
  // MSD state
  // ---------------------------------------------------------------------------
  let element = $state(`O`)
  let atom_indices_text = $state(``)
  let timestep_ps = $state(1.0)
  let max_tau_frames = $state(``)
  let directions = $state<`xyz` | `xy` | `z` | `x` | `y`>(`xyz`)
  let unwrap_pbc = $state(true)
  let fit_tau_min = $state(``)
  let fit_tau_max = $state(``)
  let computing = $state(false)
  let error = $state(``)
  let result: {
    tau_ps: number[]
    msd_angstrom2: number[]
    n_atoms_used: number
    n_frames: number
    directions: string
    dimensionality: number
    diffusion_coefficient_cm2_s: number | null
    diffusion_coefficient_ang2_ps: number | null
    fit_slope_ang2_per_ps: number | null
    fit_intercept_ang2: number | null
    fit_r_squared: number | null
    fit_tau_range_ps: [number, number] | null
  } | null = $state(null)

  async function compute_msd() {
    computing = true
    error = ``
    result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        timestep_ps,
        directions,
        unwrap_pbc,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const trimmed_element = element.trim()
      if (trimmed_element) {
        body.element = trimmed_element
      } else {
        const indices = parse_atom_indices(atom_indices_text)
        if (indices) body.atom_indices = indices
      }

      const mt = parseInt(max_tau_frames, 10)
      if (!isNaN(mt) && mt > 0) body.max_tau_frames = mt

      const fmin = parseFloat(fit_tau_min)
      const fmax = parseFloat(fit_tau_max)
      if (!isNaN(fmin) && !isNaN(fmax)) body.fit_range_ps = [fmin, fmax]

      const resp = await fetch(`${server_url}/api/md/dynamics/msd`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      result = await resp.json()

      const msd_trace = {
        x: result!.tau_ps,
        y: result!.msd_angstrom2,
        type: `scatter`,
        mode: `lines`,
        line: { color: `#1f77b4`, width: 1.5 },
        name: `MSD`,
      }
      const traces: any[] = [msd_trace]

      // Overlay Einstein fit line if available
      if (
        result!.fit_slope_ang2_per_ps !== null &&
        result!.fit_intercept_ang2 !== null &&
        result!.fit_tau_range_ps !== null
      ) {
        const [tmin, tmax] = result!.fit_tau_range_ps
        const slope = result!.fit_slope_ang2_per_ps
        const intercept = result!.fit_intercept_ang2
        traces.push({
          x: [tmin, tmax],
          y: [slope * tmin + intercept, slope * tmax + intercept],
          type: `scatter`,
          mode: `lines`,
          line: { color: `#d62728`, width: 1.5, dash: `dash` },
          name: t('structure.md_einstein_fit'),
        })
      }

      on_plot({
        traces,
        title: t('structure.md_mean_squared_displacement'),
        x_label: `τ (ps)`,
        y_label: `MSD (Å²)`,
      })
    } catch (e: any) {
      error = e.message || t('structure.computation_failed')
    } finally {
      computing = false
    }
  }
</script>

<div class="msd-panel">
  <details open>
    <summary>{t('structure.md_msd_self_diffusion')}</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_element_filter')}
        <input
          type="text"
          placeholder="e.g. O"
          bind:value={element}
        />
      </label>
      <label>
        {t('structure.md_atom_indices_if_empty')}
        <input
          type="text"
          placeholder="0,1,2,5"
          bind:value={atom_indices_text}
        />
      </label>
      <label>
        {t('structure.md_timestep_ps_frame')}
        <input type="number" step="0.001" min="0.001" bind:value={timestep_ps} />
      </label>
      <label>
        {t('structure.md_max_tau_frames')}
        <input type="text" placeholder="n_frames/2" bind:value={max_tau_frames} />
      </label>
      <label>
        {t('structure.md_directions')}
        <select bind:value={directions}>
          <option value="xyz">xyz (3D, d=3)</option>
          <option value="xy">xy (2D, d=2)</option>
          <option value="x">{t('structure.md_x_only')}</option>
          <option value="y">{t('structure.md_y_only')}</option>
          <option value="z">{t('structure.md_z_only')}</option>
        </select>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={unwrap_pbc} />
        {t('structure.md_unwrap_pbc')}
      </label>
      <label>
        {t('structure.md_fit_tau_min_ps')}
        <input type="text" placeholder="auto" bind:value={fit_tau_min} />
      </label>
      <label>
        {t('structure.md_fit_tau_max_ps')}
        <input type="text" placeholder="auto" bind:value={fit_tau_max} />
      </label>
    </div>

    <button class="btn-compute" onclick={compute_msd} disabled={computing}>
      {#if computing}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_msd')}
      {/if}
    </button>

    {#if error}
      <div class="error-msg">{error}</div>
    {/if}

    {#if result}
      <div class="info-bar">
        <span title={t('structure.md_atoms_used')}>{t('structure.md_atoms_count', { n: result.n_atoms_used })}</span>
        <span title={t('structure.md_frames')}>{t('structure.md_frames_count', { n: result.n_frames })}</span>
        <span title={t('structure.md_dimensionality_title')}>d = {result.dimensionality}</span>
        {#if result.diffusion_coefficient_cm2_s !== null}
          <span class="d-value" title={t('structure.md_self_diffusion_coefficient')}>
            D = {result.diffusion_coefficient_cm2_s.toExponential(3)} cm²/s
          </span>
        {/if}
        {#if result.fit_r_squared !== null}
          <span title={t('structure.md_r2_einstein_fit')}>R² = {result.fit_r_squared.toFixed(4)}</span>
        {/if}
      </div>
    {/if}
  </details>
</div>

<style>
  .msd-panel {
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
  .d-value {
    color: var(--accent-color, #007acc);
    font-weight: 600;
  }
</style>
