<script lang="ts">
  import { Spinner } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    trajectory_b64,
    trajectory_format,
    topology_b64 = null,
    topology_format = ``,
    on_plot = (data: any) => {},
  }: {
    trajectory_b64: string
    trajectory_format: string
    topology_b64?: string | null
    topology_format?: string
    on_plot?: (data: { traces: any[]; title: string; x_label: string; y_label: string; layout_overrides?: Record<string, any> } | null) => void
  } = $props()

  const server_url = `http://localhost:8000`

  const COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]

  // ============================================================================
  // RDF Section State
  // ============================================================================

  let rdf_sel_mode_1 = $state<`element` | `indices`>(`element`)
  let rdf_element_1 = $state(``)
  let rdf_indices_1 = $state(``)
  let rdf_sel_mode_2 = $state<`element` | `indices`>(`element`)
  let rdf_element_2 = $state(``)
  let rdf_indices_2 = $state(``)
  let rdf_r_min = $state(0)
  let rdf_r_max = $state(10)
  let rdf_n_bins = $state(200)
  let rdf_periodic = $state(true)
  let rdf_show_coord = $state(false)
  let rdf_loading = $state(false)
  let rdf_error = $state(``)
  let rdf_result: { r: number[]; g_r: number[]; coordination_number: number[]; n_pairs: number } | null = $state(null)

  // ============================================================================
  // Pairwise Distances Section State
  // ============================================================================

  let dist_pairs_text = $state(``)
  let dist_periodic = $state(true)
  let dist_loading = $state(false)
  let dist_error = $state(``)
  let dist_result: { distances: number[][]; frame_indices: number[]; n_frames: number; n_pairs: number } | null = $state(null)
  let dist_stats: { pair: string; mean: number; std: number }[] = $state([])

  // ============================================================================
  // Center of Mass Section State
  // ============================================================================

  let com_indices_text = $state(``)
  let com_loading = $state(false)
  let com_error = $state(``)
  let com_result: { positions: number[][]; frame_indices: number[]; n_frames: number } | null = $state(null)

  // ============================================================================
  // Helpers
  // ============================================================================

  function parse_int_list(text: string): number[] {
    return text.split(`,`).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
      const n = parseInt(s, 10)
      if (isNaN(n)) throw new Error(`Invalid integer: "${s}"`)
      return n
    })
  }

  function parse_pairs(text: string): number[][] {
    return text.split(`;`).map((seg) => seg.trim()).filter((seg) => seg.length > 0).map((seg) => {
      const nums = parse_int_list(seg)
      if (nums.length !== 2) throw new Error(`Expected pair of 2 indices, got ${nums.length}: "${seg}"`)
      return nums
    })
  }

  function build_base_body() {
    const body: Record<string, any> = {
      trajectory_b64,
      format: trajectory_format,
    }
    if (topology_b64) {
      body.topology_b64 = topology_b64
      body.topology_format = topology_format
    }
    return body
  }

  // ============================================================================
  // RDF Computation
  // ============================================================================

  async function compute_rdf() {
    rdf_loading = true
    rdf_error = ``
    rdf_result = null

    try {
      const selection_1: Record<string, any> = {}
      if (rdf_sel_mode_1 === `element`) {
        if (!rdf_element_1.trim()) throw new Error(`Selection 1: enter an element name`)
        selection_1.element = rdf_element_1.trim()
      } else {
        if (!rdf_indices_1.trim()) throw new Error(`Selection 1: enter atom indices`)
        selection_1.indices = parse_int_list(rdf_indices_1)
      }

      const selection_2: Record<string, any> = {}
      if (rdf_sel_mode_2 === `element`) {
        if (!rdf_element_2.trim()) throw new Error(`Selection 2: enter an element name`)
        selection_2.element = rdf_element_2.trim()
      } else {
        if (!rdf_indices_2.trim()) throw new Error(`Selection 2: enter atom indices`)
        selection_2.indices = parse_int_list(rdf_indices_2)
      }

      const body = {
        ...build_base_body(),
        selection_1,
        selection_2,
        r_range: [rdf_r_min, rdf_r_max],
        n_bins: rdf_n_bins,
        periodic: rdf_periodic,
      }

      const resp = await fetch(`${server_url}/api/md/distances/rdf`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `RDF request failed (${resp.status})`)
      }

      rdf_result = await resp.json()

      // Emit plot data
      const traces: any[] = [{
        x: rdf_result!.r,
        y: rdf_result!.g_r,
        type: `scatter`,
        mode: `lines`,
        name: `g(r)`,
        line: { color: COLORS[0], width: 1.5 },
      }]
      const layout_overrides: Record<string, any> = {}
      if (rdf_show_coord && rdf_result!.coordination_number) {
        traces.push({
          x: rdf_result!.r,
          y: rdf_result!.coordination_number,
          type: `scatter`,
          mode: `lines`,
          name: `N(r)`,
          line: { color: COLORS[1], width: 1.5, dash: `dash` },
          yaxis: `y2`,
        })
        layout_overrides.yaxis2 = {
          title: `N(r)`,
          overlaying: `y`,
          side: `right`,
          gridcolor: `rgba(255,255,255,0.1)`,
          linecolor: `rgba(200,200,200,0.5)`,
          tickcolor: `rgba(200,200,200,0.5)`,
          showgrid: true,
          showline: true,
        }
      }
      on_plot({ traces, title: `Radial Distribution Function`, x_label: `r (Å)`, y_label: `g(r)`, layout_overrides })
    } catch (e: any) {
      rdf_error = e.message || `RDF computation failed`
    } finally {
      rdf_loading = false
    }
  }

  // ============================================================================
  // Pairwise Distances Computation
  // ============================================================================

  async function compute_distances() {
    dist_loading = true
    dist_error = ``
    dist_result = null
    dist_stats = []

    try {
      if (!dist_pairs_text.trim()) throw new Error(`Enter at least one atom pair`)
      const atom_pairs = parse_pairs(dist_pairs_text)

      const body = {
        ...build_base_body(),
        atom_pairs,
        periodic: dist_periodic,
      }

      const resp = await fetch(`${server_url}/api/md/distances/pairwise`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Distance request failed (${resp.status})`)
      }

      dist_result = await resp.json()

      // Compute stats per pair
      if (dist_result) {
        const pairs = parse_pairs(dist_pairs_text)
        dist_stats = pairs.map((pair, idx) => {
          const values = dist_result!.distances.map((frame_row) => frame_row[idx])
          const mean = values.reduce((a, b) => a + b, 0) / values.length
          const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
          return {
            pair: `${pair[0]}-${pair[1]}`,
            mean: Math.round(mean * 1000) / 1000,
            std: Math.round(Math.sqrt(variance) * 1000) / 1000,
          }
        })

        // Emit plot data
        const traces = pairs.map((pair, idx) => ({
          x: dist_result!.frame_indices,
          y: dist_result!.distances.map((frame_row: number[]) => frame_row[idx]),
          type: `scatter`,
          mode: `lines`,
          name: `${pair[0]}-${pair[1]}`,
          line: { color: COLORS[idx % COLORS.length], width: 1.5 },
        }))
        on_plot({ traces, title: `Pairwise Distances`, x_label: `Frame`, y_label: `Distance (Å)` })
      }
    } catch (e: any) {
      dist_error = e.message || `Distance computation failed`
    } finally {
      dist_loading = false
    }
  }

  // ============================================================================
  // Center of Mass Computation
  // ============================================================================

  async function compute_com() {
    com_loading = true
    com_error = ``
    com_result = null

    try {
      if (!com_indices_text.trim()) throw new Error(`Enter atom indices`)
      const atom_indices = parse_int_list(com_indices_text)

      const body = {
        ...build_base_body(),
        atom_indices,
      }

      const resp = await fetch(`${server_url}/api/md/distances/center-of-mass`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Center-of-mass request failed (${resp.status})`)
      }

      com_result = await resp.json()

      // Emit plot data
      const labels = [`x`, `y`, `z`]
      const traces = [0, 1, 2].map((dim) => ({
        x: com_result!.frame_indices,
        y: com_result!.positions.map((pos: number[]) => pos[dim]),
        type: `scatter`,
        mode: `lines`,
        name: labels[dim],
        line: { color: COLORS[dim], width: 1.5 },
      }))
      on_plot({ traces, title: t('structure.md_center_of_mass'), x_label: t('structure.md_frame'), y_label: t('structure.md_position_angstrom') })
    } catch (e: any) {
      com_error = e.message || t('structure.md_com_failed')
    } finally {
      com_loading = false
    }
  }
</script>

<div class="md-rdf-panel">
  <!-- RDF Analysis -->
  <details open>
    <summary>{t('structure.md_rdf_analysis')}</summary>

    <!-- Selection 1 -->
    <div class="selection-block">
      <span class="sel-label">{t('structure.md_selection_1')}</span>
      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={rdf_sel_mode_1 === `element`}
          onclick={() => rdf_sel_mode_1 = `element`}
        >{t('structure.md_element')}</button>
        <button
          class="tab-btn"
          class:active={rdf_sel_mode_1 === `indices`}
          onclick={() => rdf_sel_mode_1 = `indices`}
        >{t('structure.md_indices')}</button>
      </div>
      {#if rdf_sel_mode_1 === `element`}
        <input
          type="text"
          placeholder="e.g. O"
          bind:value={rdf_element_1}
          class="text-input"
          title={t('structure.md_element_symbol_hint')}
        />
      {:else}
        <input
          type="text"
          placeholder="0,1,2,3"
          bind:value={rdf_indices_1}
          class="text-input"
          title={t('structure.md_atom_indices_hint')}
        />
      {/if}
    </div>

    <!-- Selection 2 -->
    <div class="selection-block">
      <span class="sel-label">{t('structure.md_selection_2')}</span>
      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={rdf_sel_mode_2 === `element`}
          onclick={() => rdf_sel_mode_2 = `element`}
        >{t('structure.md_element')}</button>
        <button
          class="tab-btn"
          class:active={rdf_sel_mode_2 === `indices`}
          onclick={() => rdf_sel_mode_2 = `indices`}
        >{t('structure.md_indices')}</button>
      </div>
      {#if rdf_sel_mode_2 === `element`}
        <input
          type="text"
          placeholder="e.g. H"
          bind:value={rdf_element_2}
          class="text-input"
          title={t('structure.md_element_symbol_hint')}
        />
      {:else}
        <input
          type="text"
          placeholder="4,5,6,7"
          bind:value={rdf_indices_2}
          class="text-input"
          title={t('structure.md_atom_indices_hint')}
        />
      {/if}
    </div>

    <!-- Parameters -->
    <div class="param-grid">
      <label>
        r min (A)
        <input type="number" bind:value={rdf_r_min} step="0.5" min="0" />
      </label>
      <label>
        r max (A)
        <input type="number" bind:value={rdf_r_max} step="0.5" min="0.1" />
      </label>
      <label>
        {t('structure.md_bins')}
        <input type="number" bind:value={rdf_n_bins} step="10" min="10" max="2000" />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={rdf_periodic} />
        {t('structure.md_periodic')}
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={rdf_show_coord} />
        {t('structure.md_show_coordination_number')}
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_rdf}
      disabled={rdf_loading}
    >
      {#if rdf_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_rdf')}
      {/if}
    </button>

    {#if rdf_error}
      <div class="error-msg">{rdf_error}</div>
    {/if}

    {#if rdf_result}
      <div class="result-info">
        <span>{t('structure.md_pairs_count', { n: rdf_result.n_pairs })}</span>
      </div>
    {/if}
  </details>

  <!-- Pairwise Distances -->
  <details>
    <summary>{t('structure.md_pairwise_distances')}</summary>

    <div class="param-grid">
      <label class="full-width">
        {t('structure.md_atom_pairs_semicolon')}
        <input
          type="text"
          placeholder="0,1 ; 2,3 ; 4,5"
          bind:value={dist_pairs_text}
          class="text-input wide"
          title={t('structure.md_atom_pairs_hint')}
        />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={dist_periodic} />
        {t('structure.md_periodic')}
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_distances}
      disabled={dist_loading}
    >
      {#if dist_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_distances')}
      {/if}
    </button>

    {#if dist_error}
      <div class="error-msg">{dist_error}</div>
    {/if}

    {#if dist_result}
      {#if dist_stats.length > 0}
        <table class="stats-table">
          <thead>
            <tr><th>{t('structure.md_pair')}</th><th>{t('structure.md_mean_angstrom')}</th><th>{t('structure.md_std_angstrom')}</th></tr>
          </thead>
          <tbody>
            {#each dist_stats as s}
              <tr>
                <td>{s.pair}</td>
                <td>{s.mean.toFixed(3)}</td>
                <td>{s.std.toFixed(3)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  </details>

  <!-- Center of Mass -->
  <details>
    <summary>{t('structure.md_center_of_mass')}</summary>

    <div class="param-grid">
      <label class="full-width">
        {t('structure.md_atom_indices')}
        <input
          type="text"
          placeholder="0,1,2,3"
          bind:value={com_indices_text}
          class="text-input wide"
          title={t('structure.md_atom_indices_hint')}
        />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_com}
      disabled={com_loading}
    >
      {#if com_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_com')}
      {/if}
    </button>

    {#if com_error}
      <div class="error-msg">{com_error}</div>
    {/if}

    {#if com_result}
      <div class="result-info">
        <span>Frames: {com_result.n_frames}</span>
      </div>
    {/if}
  </details>
</div>

<style>
  .md-rdf-panel {
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
  .selection-block {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .sel-label {
    font-size: 0.85em;
    font-weight: 500;
    color: var(--text-color-muted);
    min-width: 70px;
  }
  .tab-bar {
    display: flex;
    gap: 2px;
  }
  .tab-btn {
    padding: 2px 10px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
    border-radius: 3px 3px 0 0;
    color: var(--text-color-dim);
    cursor: pointer;
    font-size: 0.85em;
  }
  .tab-btn.active {
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.12));
    color: var(--text-color);
    border-bottom-color: transparent;
  }
  .text-input {
    padding: 3px 5px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    color: var(--text-color);
    font-size: 0.9em;
    min-width: 70px;
  }
  .text-input.wide {
    width: 100%;
    box-sizing: border-box;
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
  .param-grid label.full-width {
    grid-column: span 2;
  }
  .param-grid input[type="number"] {
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
    grid-column: span 2;
    display: flex;
    font-size: 0.85em;
    color: var(--text-color-muted);
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
  .result-info {
    display: flex;
    gap: 10px;
    font-size: 0.85em;
    color: var(--text-color-muted);
    margin-top: 6px;
  }
  .result-info span {
    padding: 1px 4px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border-radius: 3px;
  }
  .stats-table {
    width: 100%;
    margin-top: 6px;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  .stats-table th {
    text-align: left;
    padding: 3px 6px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    color: var(--text-color-muted);
    font-weight: 500;
  }
  .stats-table td {
    padding: 3px 6px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05));
    color: var(--text-color);
    font-family: monospace;
  }
</style>
