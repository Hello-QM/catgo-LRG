<script lang="ts">
  import { Spinner } from '$lib'

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
  // Shared detection parameters (used across all 3 sections)
  // ---------------------------------------------------------------------------
  let detect_method = $state<`baker_hubbard` | `wernet_nilsson`>(`baker_hubbard`)
  let detect_distance_cutoff = $state(3.5)
  let detect_angle_cutoff = $state(150)
  let detect_exclude_water = $state(true)
  let detect_periodic = $state(true)

  // ---------------------------------------------------------------------------
  // Section 1: H-bond Detection
  // ---------------------------------------------------------------------------
  let detect_donor_text = $state(``)
  let detect_acceptor_text = $state(``)
  let detect_freq = $state(0.1)
  let detect_computing = $state(false)
  let detect_error = $state(``)
  let detect_result: any = $state(null)

  async function run_detect() {
    detect_computing = true
    detect_error = ``
    detect_result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        method: detect_method,
        distance_cutoff: detect_distance_cutoff,
        angle_cutoff: detect_angle_cutoff,
        exclude_water: detect_exclude_water,
        periodic: detect_periodic,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      if (detect_method === `baker_hubbard`) {
        body.freq = detect_freq
      }

      const donor_idx = parse_atom_indices(detect_donor_text)
      if (donor_idx) body.donor_indices = donor_idx

      const acceptor_idx = parse_atom_indices(detect_acceptor_text)
      if (acceptor_idx) body.acceptor_indices = acceptor_idx

      const resp = await fetch(`${server_url}/api/md/hbonds/detect`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      detect_result = await resp.json()

      // Emit plot data for H-bonds per frame
      const frame_indices = detect_result.count_per_frame.map((_: number, i: number) => i)
      const trace = {
        x: frame_indices,
        y: detect_result.count_per_frame,
        type: `scatter`,
        mode: `lines`,
        line: { color: `#ff7f0e`, width: 1.5 },
        name: `H-bonds/frame`,
      }
      on_plot({
        traces: [trace],
        title: `Hydrogen Bonds per Frame`,
        x_label: `Frame`,
        y_label: `H-bonds`,
      })
    } catch (e: any) {
      detect_error = e.message || `Detection failed`
    } finally {
      detect_computing = false
    }
  }

  // Derived: first 20 unique H-bonds for the table
  let detect_table_rows = $derived(
    detect_result
      ? detect_result.unique_hbonds.slice(0, 20)
      : []
  )

  // ---------------------------------------------------------------------------
  // Section 2: H-bond Lifetime
  // ---------------------------------------------------------------------------
  let lifetime_max_lag = $state(100)
  let lifetime_time_step = $state(1.0)
  let lifetime_computing = $state(false)
  let lifetime_error = $state(``)
  let lifetime_result: any = $state(null)

  async function run_lifetime() {
    lifetime_computing = true
    lifetime_error = ``
    lifetime_result = null

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        distance_cutoff: detect_distance_cutoff,
        angle_cutoff: detect_angle_cutoff,
        exclude_water: detect_exclude_water,
        periodic: detect_periodic,
        time_step: lifetime_time_step,
        max_lag_fraction: 0.5,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const resp = await fetch(`${server_url}/api/md/hbonds/lifetime`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      lifetime_result = await resp.json()

      // Emit plot data for H-bond autocorrelation
      const trace = {
        x: lifetime_result.time_ps,
        y: lifetime_result.autocorrelation,
        type: `scatter`,
        mode: `lines`,
        line: { color: `#2ca02c`, width: 1.5 },
        name: `C(t)`,
      }
      on_plot({
        traces: [trace],
        title: `H-bond Autocorrelation`,
        x_label: `Time (ps)`,
        y_label: `C(t)`,
      })
    } catch (e: any) {
      lifetime_error = e.message || `Lifetime analysis failed`
    } finally {
      lifetime_computing = false
    }
  }

  // ---------------------------------------------------------------------------
  // Section 3: H-bond Density
  // ---------------------------------------------------------------------------
  let hbdensity_z_min = $state(``)
  let hbdensity_z_max = $state(``)
  let hbdensity_computing = $state(false)
  let hbdensity_error = $state(``)
  let hbdensity_result: any = $state(null)

  async function run_hbdensity() {
    hbdensity_computing = true
    hbdensity_error = ``
    hbdensity_result = null

    const z_min_val = parseFloat(hbdensity_z_min)
    const z_max_val = parseFloat(hbdensity_z_max)

    if (isNaN(z_min_val) || isNaN(z_max_val)) {
      hbdensity_error = `Z range min and max are required`
      hbdensity_computing = false
      return
    }

    try {
      const body: Record<string, any> = {
        trajectory_b64,
        format: trajectory_format,
        z_range: [z_min_val, z_max_val],
        distance_cutoff: detect_distance_cutoff,
        angle_cutoff: detect_angle_cutoff,
        exclude_water: detect_exclude_water,
        periodic: detect_periodic,
      }

      if (topology_b64) {
        body.topology_b64 = topology_b64
        body.topology_format = topology_format
      }

      const resp = await fetch(`${server_url}/api/md/hbonds/density`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `Server error ${resp.status}`)
      }

      hbdensity_result = await resp.json()

      // Emit plot data for H-bond density per frame
      const frame_indices = hbdensity_result.h_bond_count_per_frame.map((_: number, i: number) => i)
      const trace = {
        x: frame_indices,
        y: hbdensity_result.h_bond_count_per_frame,
        type: `scatter`,
        mode: `lines`,
        line: { color: `#d62728`, width: 1.5 },
        name: `H-bonds in slab`,
      }
      on_plot({
        traces: [trace],
        title: `H-bonds in Slab`,
        x_label: `Frame`,
        y_label: `H-bonds`,
      })
    } catch (e: any) {
      hbdensity_error = e.message || `Density computation failed`
    } finally {
      hbdensity_computing = false
    }
  }
</script>

<div class="hbonds-panel">
  <!-- ===== H-bond Detection ===== -->
  <details open>
    <summary>H-bond Detection</summary>

    <div class="param-grid">
      <label>
        Method
        <select bind:value={detect_method}>
          <option value="baker_hubbard">Baker-Hubbard</option>
          <option value="wernet_nilsson">Wernet-Nilsson</option>
        </select>
      </label>
      <label>
        Distance cutoff (A)
        <input type="number" bind:value={detect_distance_cutoff} min="1" max="10" step="0.1" />
      </label>
      <label>
        Angle cutoff (deg)
        <input type="number" bind:value={detect_angle_cutoff} min="90" max="180" step="1" />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={detect_exclude_water} />
        Exclude water
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={detect_periodic} />
        Periodic
      </label>

      {#if detect_method === `baker_hubbard`}
        <label>
          Frequency threshold
          <input type="number" bind:value={detect_freq} min="0" max="1" step="0.05" />
        </label>
      {/if}

      <label>
        Donor indices
        <input
          type="text"
          placeholder="0,1,2 (optional)"
          bind:value={detect_donor_text}
        />
      </label>
      <label>
        Acceptor indices
        <input
          type="text"
          placeholder="3,4,5 (optional)"
          bind:value={detect_acceptor_text}
        />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={run_detect}
      disabled={detect_computing}
    >
      {#if detect_computing}
        <Spinner /> Detecting...
      {:else}
        Detect H-bonds
      {/if}
    </button>

    {#if detect_error}
      <div class="error-msg">{detect_error}</div>
    {/if}

    {#if detect_result}
      <div class="info-bar">
        <span>Found {detect_result.n_unique} unique H-bonds across {detect_result.n_frames} frames</span>
      </div>

      {#if detect_table_rows.length > 0}
        <table class="hbond-table">
          <thead>
            <tr>
              <th>Donor</th>
              <th>H</th>
              <th>Acceptor</th>
            </tr>
          </thead>
          <tbody>
            {#each detect_table_rows as row}
              <tr>
                <td>{row.donor_idx}</td>
                <td>{row.hydrogen_idx}</td>
                <td>{row.acceptor_idx}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if detect_result.unique_hbonds.length > 20}
          <div class="table-note">
            Showing first 20 of {detect_result.unique_hbonds.length} unique H-bonds
          </div>
        {/if}
      {/if}
    {/if}
  </details>

  <!-- ===== H-bond Lifetime ===== -->
  <details>
    <summary>H-bond Lifetime</summary>

    <div class="param-grid">
      <label>
        Time step (ps)
        <input type="number" bind:value={lifetime_time_step} min="0.001" max="100" step="0.1" />
      </label>
      <label>
        Max lag (frames)
        <input type="number" bind:value={lifetime_max_lag} min="1" max="10000" step="10" />
      </label>
    </div>

    <div class="param-note">
      Uses detection parameters above (method, cutoffs, periodicity).
    </div>

    <button
      class="btn-compute"
      onclick={run_lifetime}
      disabled={lifetime_computing}
    >
      {#if lifetime_computing}
        <Spinner /> Computing...
      {:else}
        Compute Lifetime
      {/if}
    </button>

    {#if lifetime_error}
      <div class="error-msg">{lifetime_error}</div>
    {/if}

    {#if lifetime_result}
      <div class="info-bar">
        <span>Average lifetime: {lifetime_result.average_lifetime_ps.toFixed(3)} ps</span>
        <span>{lifetime_result.n_hbonds_sampled} H-bonds tracked</span>
      </div>
    {/if}
  </details>

  <!-- ===== H-bond Density ===== -->
  <details>
    <summary>H-bond Density</summary>

    <div class="param-grid">
      <label>
        Z range min (A)
        <input type="text" placeholder="e.g. 5.0" bind:value={hbdensity_z_min} />
      </label>
      <label>
        Z range max (A)
        <input type="text" placeholder="e.g. 15.0" bind:value={hbdensity_z_max} />
      </label>
    </div>

    <div class="param-note">
      Uses detection parameters from H-bond Detection section above.
    </div>

    <button
      class="btn-compute"
      onclick={run_hbdensity}
      disabled={hbdensity_computing || !hbdensity_z_min.trim() || !hbdensity_z_max.trim()}
    >
      {#if hbdensity_computing}
        <Spinner /> Computing...
      {:else}
        Compute Density
      {/if}
    </button>

    {#if hbdensity_error}
      <div class="error-msg">{hbdensity_error}</div>
    {/if}

    {#if hbdensity_result}
      <div class="info-bar">
        <span>Avg density: {hbdensity_result.average_density.toExponential(3)} H-bonds/A^3</span>
        <span>Region volume: {hbdensity_result.region_volume_ang3.toFixed(1)} A^3</span>
      </div>
      <div class="info-bar">
        <span>Avg count/frame: {hbdensity_result.average_count.toFixed(1)}</span>
        <span>{hbdensity_result.n_frames} frames</span>
      </div>
    {/if}
  </details>
</div>

<style>
  .hbonds-panel {
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
  .checkbox-label {
    flex-direction: row !important;
    align-items: center;
    gap: 5px !important;
    display: flex;
    font-size: 0.85em;
    color: var(--text-color-muted);
    cursor: pointer;
  }
  .param-note {
    font-size: 0.8em;
    color: var(--text-color-dim);
    margin-top: 4px;
    font-style: italic;
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
  .hbond-table {
    width: 100%;
    margin-top: 6px;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  .hbond-table th {
    text-align: left;
    padding: 3px 6px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    color: var(--text-color-muted);
    font-weight: 500;
  }
  .hbond-table td {
    padding: 3px 6px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05));
    color: var(--text-color);
    font-family: monospace;
  }
  .table-note {
    font-size: 0.8em;
    color: var(--text-color-dim);
    margin-top: 4px;
    font-style: italic;
  }
</style>
