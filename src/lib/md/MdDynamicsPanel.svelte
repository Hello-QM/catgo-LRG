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
  // Helpers
  // ============================================================================

  function parse_int_list(text: string): number[] {
    return text.split(`,`).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
      const n = parseInt(s, 10)
      if (isNaN(n)) throw new Error(`Invalid integer: "${s}"`)
      return n
    })
  }

  function parse_groups(text: string, group_size: number, label: string): number[][] {
    return text.split(`;`).map((seg) => seg.trim()).filter((seg) => seg.length > 0).map((seg) => {
      const nums = parse_int_list(seg)
      if (nums.length !== group_size) {
        throw new Error(`Expected ${label} of ${group_size} indices, got ${nums.length}: "${seg}"`)
      }
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
  // RMSD Section State
  // ============================================================================

  let rmsd_ref_frame = $state(0)
  let rmsd_atom_indices_text = $state(``)
  let rmsd_precentered = $state(false)
  let rmsd_loading = $state(false)
  let rmsd_error = $state(``)
  let rmsd_result: {
    rmsd_angstroms: number[]
    frame_indices: number[]
    ref_frame: number
    n_frames: number
    n_atoms_used: number
  } | null = $state(null)

  // ============================================================================
  // RMSF Section State
  // ============================================================================

  let rmsf_atom_indices_text = $state(``)
  let rmsf_ref_frame_text = $state(``)
  let rmsf_loading = $state(false)
  let rmsf_error = $state(``)
  let rmsf_result: {
    rmsf_angstroms: number[]
    atom_indices: number[]
    n_frames: number
    n_atoms: number
    reference: string
  } | null = $state(null)

  // ============================================================================
  // Bond Angles Section State
  // ============================================================================

  let angles_triplets_text = $state(``)
  let angles_periodic = $state(true)
  let angles_loading = $state(false)
  let angles_error = $state(``)
  let angles_result: {
    angles_deg: number[][]
    frame_indices: number[]
    n_frames: number
    n_angles: number
    atom_triplets: number[][]
  } | null = $state(null)

  // ============================================================================
  // Dihedral Angles Section State
  // ============================================================================

  let dihedrals_quartets_text = $state(``)
  let dihedrals_periodic = $state(true)
  let dihedrals_loading = $state(false)
  let dihedrals_error = $state(``)
  let dihedrals_result: {
    dihedrals_deg: number[][]
    frame_indices: number[]
    n_frames: number
    n_dihedrals: number
    atom_quartets: number[][]
  } | null = $state(null)

  // ============================================================================
  // RMSD Computation
  // ============================================================================

  async function compute_rmsd() {
    rmsd_loading = true
    rmsd_error = ``
    rmsd_result = null

    try {
      const body: Record<string, any> = {
        ...build_base_body(),
        ref_frame: rmsd_ref_frame,
        precentered: rmsd_precentered,
      }

      if (rmsd_atom_indices_text.trim()) {
        body.atom_indices = parse_int_list(rmsd_atom_indices_text)
      }

      const resp = await fetch(`${server_url}/api/md/rmsd/rmsd`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `RMSD request failed (${resp.status})`)
      }

      rmsd_result = await resp.json()

      // Emit plot data
      const r = rmsd_result!
      on_plot({
        traces: [
          {
            x: r.frame_indices,
            y: r.rmsd_angstroms,
            type: `scatter`,
            mode: `lines`,
            name: `RMSD`,
            line: { color: COLORS[0], width: 1.5 },
          },
        ],
        title: `RMSD`,
        x_label: `Frame`,
        y_label: `RMSD (\u00C5)`,
      })
    } catch (e: any) {
      rmsd_error = e.message || `RMSD computation failed`
    } finally {
      rmsd_loading = false
    }
  }

  // ============================================================================
  // RMSF Computation
  // ============================================================================

  async function compute_rmsf() {
    rmsf_loading = true
    rmsf_error = ``
    rmsf_result = null

    try {
      const body: Record<string, any> = {
        ...build_base_body(),
      }

      if (rmsf_atom_indices_text.trim()) {
        body.atom_indices = parse_int_list(rmsf_atom_indices_text)
      }

      const ref_val = parseInt(rmsf_ref_frame_text.trim(), 10)
      if (!isNaN(ref_val)) {
        body.ref_frame = ref_val
      }

      const resp = await fetch(`${server_url}/api/md/rmsd/rmsf`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `RMSF request failed (${resp.status})`)
      }

      rmsf_result = await resp.json()

      // Emit plot data
      const r = rmsf_result!
      on_plot({
        traces: [
          {
            x: r.atom_indices,
            y: r.rmsf_angstroms,
            type: `bar`,
            name: `RMSF`,
            marker: { color: COLORS[0], opacity: 0.8 },
          },
        ],
        title: `RMSF per Atom`,
        x_label: `Atom Index`,
        y_label: `RMSF (\u00C5)`,
      })
    } catch (e: any) {
      rmsf_error = e.message || `RMSF computation failed`
    } finally {
      rmsf_loading = false
    }
  }

  // ============================================================================
  // Bond Angles Computation
  // ============================================================================

  async function compute_angles() {
    angles_loading = true
    angles_error = ``
    angles_result = null

    try {
      if (!angles_triplets_text.trim()) throw new Error(`Enter at least one atom triplet`)
      const atom_triplets = parse_groups(angles_triplets_text, 3, `triplet`)

      const body = {
        ...build_base_body(),
        atom_triplets,
        periodic: angles_periodic,
      }

      const resp = await fetch(`${server_url}/api/md/angles/angles`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Angles request failed (${resp.status})`)
      }

      angles_result = await resp.json()

      // Emit plot data
      const r = angles_result!
      const traces = r.atom_triplets.map((triplet: number[], idx: number) => ({
        x: r.frame_indices,
        y: r.angles_deg.map((frame_row: number[]) => frame_row[idx]),
        type: `scatter`,
        mode: `lines`,
        name: `${triplet[0]}-${triplet[1]}-${triplet[2]}`,
        line: { color: COLORS[idx % COLORS.length], width: 1.5 },
      }))
      on_plot({
        traces,
        title: `Bond Angles`,
        x_label: `Frame`,
        y_label: `Angle (\u00B0)`,
      })
    } catch (e: any) {
      angles_error = e.message || `Angle computation failed`
    } finally {
      angles_loading = false
    }
  }

  // ============================================================================
  // Dihedral Angles Computation
  // ============================================================================

  async function compute_dihedrals() {
    dihedrals_loading = true
    dihedrals_error = ``
    dihedrals_result = null

    try {
      if (!dihedrals_quartets_text.trim()) throw new Error(`Enter at least one atom quartet`)
      const atom_quartets = parse_groups(dihedrals_quartets_text, 4, `quartet`)

      const body = {
        ...build_base_body(),
        atom_quartets,
        periodic: dihedrals_periodic,
      }

      const resp = await fetch(`${server_url}/api/md/angles/dihedrals`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      })

      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || `Dihedrals request failed (${resp.status})`)
      }

      dihedrals_result = await resp.json()

      // Emit plot data
      const r = dihedrals_result!
      const traces = r.atom_quartets.map((quartet: number[], idx: number) => ({
        x: r.frame_indices,
        y: r.dihedrals_deg.map((frame_row: number[]) => frame_row[idx]),
        type: `scatter`,
        mode: `lines`,
        name: `${quartet[0]}-${quartet[1]}-${quartet[2]}-${quartet[3]}`,
        line: { color: COLORS[idx % COLORS.length], width: 1.5 },
      }))
      on_plot({
        traces,
        title: t('structure.md_dihedral_angles'),
        x_label: t('structure.md_frame'),
        y_label: t('structure.md_angle_degree'),
      })
    } catch (e: any) {
      dihedrals_error = e.message || t('structure.md_dihedral_failed')
    } finally {
      dihedrals_loading = false
    }
  }
</script>

<div class="md-dynamics-panel">
  <!-- RMSD -->
  <details open>
    <summary>RMSD</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_reference_frame')}
        <input type="number" bind:value={rmsd_ref_frame} step="1" min="0" />
      </label>
      <label>
        {t('structure.md_atom_indices_optional')}
        <input
          type="text"
          placeholder="0,1,2,..."
          bind:value={rmsd_atom_indices_text}
          class="text-input"
          title={t('structure.md_atom_indices_all_hint')}
        />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={rmsd_precentered} />
        {t('structure.md_precentered')}
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_rmsd}
      disabled={rmsd_loading}
    >
      {#if rmsd_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_rmsd')}
      {/if}
    </button>

    {#if rmsd_error}
      <div class="error-msg">{rmsd_error}</div>
    {/if}

    {#if rmsd_result}
      <div class="result-info">
        <span>{t('structure.md_frames_label_count', { n: rmsd_result.n_frames })}</span>
        <span>{t('structure.md_atoms_used_count', { n: rmsd_result.n_atoms_used })}</span>
      </div>
    {/if}
  </details>

  <!-- RMSF -->
  <details>
    <summary>RMSF</summary>

    <div class="param-grid">
      <label>
        {t('structure.md_atom_indices_optional')}
        <input
          type="text"
          placeholder="0,1,2,..."
          bind:value={rmsf_atom_indices_text}
          class="text-input"
          title={t('structure.md_atom_indices_all_hint')}
        />
      </label>
      <label>
        {t('structure.md_reference_frame_optional')}
        <input
          type="text"
          placeholder="avg structure"
          bind:value={rmsf_ref_frame_text}
          class="text-input"
          title={t('structure.md_reference_frame_hint')}
        />
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_rmsf}
      disabled={rmsf_loading}
    >
      {#if rmsf_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_rmsf')}
      {/if}
    </button>

    {#if rmsf_error}
      <div class="error-msg">{rmsf_error}</div>
    {/if}

    {#if rmsf_result}
      <div class="result-info">
        <span>{t('structure.md_atoms_label_count', { n: rmsf_result.n_atoms })}</span>
        <span>{t('structure.md_frames_label_count', { n: rmsf_result.n_frames })}</span>
        <span>{t('structure.md_ref_label', { ref: rmsf_result.reference })}</span>
      </div>
    {/if}
  </details>

  <!-- Bond Angles -->
  <details>
    <summary>{t('structure.md_bond_angles')}</summary>

    <div class="param-grid">
      <label class="full-width">
        {t('structure.md_atom_triplets_semicolon')}
        <input
          type="text"
          placeholder="0,1,2 ; 3,4,5"
          bind:value={angles_triplets_text}
          class="text-input wide"
          title={t('structure.md_atom_triplets_hint')}
        />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={angles_periodic} />
        {t('structure.md_periodic')}
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_angles}
      disabled={angles_loading}
    >
      {#if angles_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_angles')}
      {/if}
    </button>

    {#if angles_error}
      <div class="error-msg">{angles_error}</div>
    {/if}

    {#if angles_result}
      <div class="result-info">
        <span>{t('structure.md_frames_label_count', { n: angles_result.n_frames })}</span>
        <span>{t('structure.md_angles_label_count', { n: angles_result.n_angles })}</span>
      </div>
    {/if}
  </details>

  <!-- Dihedral Angles -->
  <details>
    <summary>{t('structure.md_dihedral_angles')}</summary>

    <div class="param-grid">
      <label class="full-width">
        {t('structure.md_atom_quartets_semicolon')}
        <input
          type="text"
          placeholder="0,1,2,3 ; 4,5,6,7"
          bind:value={dihedrals_quartets_text}
          class="text-input wide"
          title={t('structure.md_atom_quartets_hint')}
        />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={dihedrals_periodic} />
        {t('structure.md_periodic')}
      </label>
    </div>

    <button
      class="btn-compute"
      onclick={compute_dihedrals}
      disabled={dihedrals_loading}
    >
      {#if dihedrals_loading}
        <Spinner /> {t('structure.computing')}
      {:else}
        {t('structure.md_compute_dihedrals')}
      {/if}
    </button>

    {#if dihedrals_error}
      <div class="error-msg">{dihedrals_error}</div>
    {/if}

    {#if dihedrals_result}
      <div class="result-info">
        <span>{t('structure.md_frames_label_count', { n: dihedrals_result.n_frames })}</span>
        <span>{t('structure.md_dihedrals_label_count', { n: dihedrals_result.n_dihedrals })}</span>
      </div>
    {/if}
  </details>
</div>

<style>
  .md-dynamics-panel {
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
  .text-input {
    padding: 3px 5px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px;
    color: var(--text-color);
    font-size: 0.9em;
  }
  .text-input.wide {
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
    flex-wrap: wrap;
  }
  .result-info span {
    padding: 1px 4px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border-radius: 3px;
  }
</style>
