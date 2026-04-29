<script lang="ts">
  import { untrack } from 'svelte'
  import { Spinner } from '$lib'
  import {
    upload_cohpcar,
    get_cohp_data,
    upload_icohplist,
    cleanup_cohp_session,
    load_from_remote as cohp_load_remote,
  } from '$lib/api/cohp'
  import { register_analysis_session, unregister_analysis_session } from '$lib/chat/analysis-session-store.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'
  import type {
    COHPBondInfo,
    COHPSessionInfo,
    CohpViewState,
  } from './cohp_types'

  let {
    cohp_state = $bindable(),
  }: {
    cohp_state: CohpViewState
  } = $props()

  // State
  let session = $state<COHPSessionInfo | null>(null)

  // Register/unregister analysis session for AI tool access
  $effect(() => {
    if (session) {
      const { session_id, all_bonds, efermi } = session
      untrack(() => register_analysis_session({
        type: `cohp`,
        session_id,
        label: `COHP (${all_bonds?.length ?? 0} bonds)`,
        meta: { efermi, nbonds: all_bonds?.length },
        created_at: Date.now(),
      }))
    } else {
      untrack(() => unregister_analysis_session(`cohp`))
    }
  })

  let uploading = $state(false)
  let loading_data = $state(false)
  let error_msg = $state(``)
  let show_file_dialog = $state(false)

  // Bond selection
  let selected_bond_indices: number[] = $state([])

  // Orbital options
  let include_orbitals = $state(false)
  let aggregate_orbitals = $state(false)
  let orbital_filter = $state<string>(`all`)

  const DEFAULT_COLORS = [
    `#1f77b4`, `#ff7f0e`, `#2ca02c`, `#d62728`, `#9467bd`,
    `#8c564b`, `#e377c2`, `#7f7f7f`, `#bcbd22`, `#17becf`,
  ]

  // Display option local state for range inputs
  let x_range_min = $state(``)
  let x_range_max = $state(``)
  let y_range_min = $state(``)
  let y_range_max = $state(``)

  // Sync range inputs → cohp_state
  $effect(() => {
    const min = parseFloat(x_range_min)
    const max = parseFloat(x_range_max)
    cohp_state.x_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })
  $effect(() => {
    const min = parseFloat(y_range_min)
    const max = parseFloat(y_range_max)
    cohp_state.y_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })

  async function handle_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    uploading = true
    error_msg = ``
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || `Upload failed`
    } finally {
      uploading = false
    }
  }

  async function handle_drop(event: DragEvent) {
    event.preventDefault()
    const file = event.dataTransfer?.files[0]
    if (!file) return

    uploading = true
    error_msg = ``
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || `Upload failed`
    } finally {
      uploading = false
    }
  }

  async function handle_icohp_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    error_msg = ``
    try {
      const result = await upload_icohplist(file)
      cohp_state.icohp_entries = result.entries
    } catch (e: any) {
      error_msg = e.message || `ICOHPLIST upload failed`
    }
  }

  function toggle_bond(bond_index: number) {
    if (selected_bond_indices.includes(bond_index)) {
      selected_bond_indices = selected_bond_indices.filter((i) => i !== bond_index)
    } else {
      selected_bond_indices = [...selected_bond_indices, bond_index]
    }
  }

  function select_all_bonds() {
    if (!session) return
    selected_bond_indices = session.bonds.map((b) => b.bond_index)
  }

  function deselect_all_bonds() {
    selected_bond_indices = []
  }

  async function load_cohp_data() {
    if (!session || selected_bond_indices.length === 0) return
    loading_data = true
    error_msg = ``
    try {
      const orb_filter = orbital_filter === `all` ? null : [orbital_filter]
      const result = await get_cohp_data(
        session.session_id,
        selected_bond_indices,
        {
          include_orbitals: include_orbitals && !aggregate_orbitals,
          orbital_filter: orb_filter ?? undefined,
          aggregate_orbitals,
        },
      )
      cohp_state.cohp_result = result
    } catch (e: any) {
      error_msg = e.message || `Failed to load COHP data`
    } finally {
      loading_data = false
    }
  }

  function close_session() {
    if (session) cleanup_cohp_session(session.session_id)
    session = null
    cohp_state.cohp_result = null
    cohp_state.icohp_entries = null
    selected_bond_indices = []
  }

  // Cleanup on component destroy
  $effect(() => {
    const sid = session?.session_id
    return () => {
      if (sid) cleanup_cohp_session(sid)
    }
  })
</script>

<div class="cohp-analysis">
  <!-- File Upload -->
  {#if !session}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="upload-zone"
      role="region"
      ondragover={(e) => e.preventDefault()}
      ondrop={handle_drop}
    >
      {#if uploading}
        <Spinner />
        <span>Parsing COHPCAR...</span>
      {:else}
        <p>Drop <code>COHPCAR.lobster</code> here or</p>
        <div class="source-buttons">
          <label class="upload-btn">
            Browse Local
            <input type="file" accept=".lobster,.txt" onchange={handle_upload} hidden />
          </label>
          <button class="upload-btn remote-btn" onclick={() => show_file_dialog = true}>
            Browse Remote / Workflow
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Session Info -->
    <div class="info-bar">
      <span title="Spin">{session.nspin > 1 ? `spin-pol` : `non-spin`}</span>
      <span title="Energy points">{session.npoints} pts</span>
      <span title="Bonds">{session.bonds.length} bonds</span>
      <span title="Energy range">{session.emin.toFixed(1)}~{session.emax.toFixed(1)} eV</span>
      <button class="btn-small danger" title="Close session" onclick={close_session}>
        &times;
      </button>
    </div>

    <!-- Bond Selection -->
    <details open>
      <summary>Bonds ({selected_bond_indices.length}/{session.bonds.length} selected)</summary>
      <div class="bond-actions">
        <button class="btn-tiny" onclick={select_all_bonds}>Select all</button>
        <button class="btn-tiny" onclick={deselect_all_bonds}>Clear</button>
      </div>
      <div class="bond-list">
        {#each session.bonds as bond}
          <label class="bond-item">
            <input
              type="checkbox"
              checked={selected_bond_indices.includes(bond.bond_index)}
              onchange={() => toggle_bond(bond.bond_index)}
            />
            <span class="bond-label">{bond.label}</span>
            <span class="bond-detail">{bond.distance.toFixed(3)} A</span>
          </label>
        {/each}
      </div>
    </details>

    <!-- Orbital Options -->
    <details>
      <summary>Orbital Options</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={include_orbitals} />
          Show individual orbitals
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={aggregate_orbitals} />
          Aggregate orbitals
        </label>
        {#if include_orbitals || aggregate_orbitals}
          <label>
            Orbital filter
            <select bind:value={orbital_filter}>
              <option value="all">All orbitals</option>
              <option value="s-s">s-s</option>
              <option value="s-p">s-p</option>
              <option value="s-d">s-d</option>
              <option value="p-p">p-p</option>
              <option value="p-d">p-d</option>
              <option value="d-d">d-d</option>
            </select>
          </label>
        {/if}
      </div>
    </details>

    <!-- Display Options -->
    <details>
      <summary>Display Options</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_fermi_line} />
          Fermi level line
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_fill} />
          Fill under curves
        </label>
        {#if cohp_state.show_fill}
          <div class="range-row">
            <span>Fill opacity:</span>
            <input
              type="range"
              bind:value={cohp_state.fill_opacity}
              min="0" max="1" step="0.05"
              class="slider-input"
            />
            <span class="slider-val">{cohp_state.fill_opacity.toFixed(2)}</span>
          </div>
        {/if}
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.invert_cohp} />
          Invert COHP (bonding &rarr; positive)
        </label>

        <hr class="section-divider" />

        {#if session && session.nspin > 1}
          <label>
            Spin handling
            <select bind:value={cohp_state.spin_mode}>
              <option value="separate">Separate (up/down)</option>
              <option value="summed">Summed (up+down)</option>
            </select>
          </label>
          {#if cohp_state.spin_mode === `separate`}
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={cohp_state.show_spin_down} />
              Show spin down
            </label>
          {/if}
        {/if}

        <label>
          Orientation
          <select bind:value={cohp_state.orientation}>
            <option value="horizontal">Energy on Y (standard)</option>
            <option value="vertical">Energy on X</option>
          </select>
        </label>
        <div class="range-row">
          <span>X range:</span>
          <input type="text" placeholder="min" bind:value={x_range_min} class="range-input" />
          <input type="text" placeholder="max" bind:value={x_range_max} class="range-input" />
        </div>
        <div class="range-row">
          <span>Y range:</span>
          <input type="text" placeholder="min" bind:value={y_range_min} class="range-input" />
          <input type="text" placeholder="max" bind:value={y_range_max} class="range-input" />
        </div>

        <hr class="section-divider" />

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.legend_visible} />
          Show legend
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_gridlines} />
          Show gridlines
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={cohp_state.show_axis_lines} />
          Show axis lines
        </label>
        <div class="range-row">
          <span>Axis width:</span>
          <input
            type="number"
            bind:value={cohp_state.axis_line_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>Tick length:</span>
          <input
            type="number"
            bind:value={cohp_state.tick_length}
            min="0" max="15" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>Tick width:</span>
          <input
            type="number"
            bind:value={cohp_state.tick_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
      </div>
    </details>

    <!-- Series Visibility -->
    {#if cohp_state.cohp_result && cohp_state.cohp_result.series.length > 0}
      <details>
        <summary>Series Visibility</summary>
        <div class="display-opts">
          {#each cohp_state.cohp_result.series as s}
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={!cohp_state.hidden_series.includes(s.label)}
                onchange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked
                  if (checked) {
                    cohp_state.hidden_series = cohp_state.hidden_series.filter((l) => l !== s.label)
                  } else {
                    cohp_state.hidden_series = [...cohp_state.hidden_series, s.label]
                  }
                }}
              />
              {s.label}
            </label>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Line Styles -->
    {#if cohp_state.cohp_result && cohp_state.cohp_result.series.length > 0}
      <details>
        <summary>Line Styles</summary>
        <div class="line-styles">
          {#each cohp_state.cohp_result.series as s, idx}
            <div class="line-style-group">
              <span class="group-label">{s.label}</span>
              <div class="line-style-row">
                <input
                  type="color"
                  value={cohp_state.line_styles[s.label]?.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
                  class="color-input"
                  title="Line color"
                  oninput={(e) => {
                    const target = e.target as HTMLInputElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], color: target.value } }
                  }}
                />
                <select
                  value={cohp_state.line_styles[s.label]?.dash ?? `solid`}
                  onchange={(e) => {
                    const target = e.target as HTMLSelectElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], dash: target.value } }
                  }}
                >
                  <option value="solid">Solid</option>
                  <option value="dash">Dashed</option>
                  <option value="dot">Dotted</option>
                  <option value="dashdot">Dash-dot</option>
                </select>
                <input
                  type="number"
                  value={cohp_state.line_styles[s.label]?.width ?? 1.5}
                  min="0.5"
                  max="5"
                  step="0.5"
                  class="width-input"
                  title="Line width"
                  onchange={(e) => {
                    const target = e.target as HTMLInputElement
                    cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], width: parseFloat(target.value) } }
                  }}
                />
                {#if cohp_state.show_fill}
                  <input
                    type="color"
                    value={cohp_state.line_styles[s.label]?.fill_color ?? cohp_state.line_styles[s.label]?.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length]}
                    class="color-input"
                    title="Fill color"
                    oninput={(e) => {
                      const target = e.target as HTMLInputElement
                      cohp_state.line_styles = { ...cohp_state.line_styles, [s.label]: { ...cohp_state.line_styles[s.label], fill_color: target.value } }
                    }}
                  />
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Load Data Button -->
    <button
      class="btn-compute"
      onclick={load_cohp_data}
      disabled={loading_data || selected_bond_indices.length === 0}
    >
      {#if loading_data}
        <Spinner /> Loading...
      {:else}
        Load COHP
      {/if}
    </button>

    <!-- ICOHPLIST Upload -->
    <details>
      <summary>ICOHP Values</summary>
      <div class="icohp-section">
        {#if !cohp_state.icohp_entries}
          <label class="upload-btn-small">
            Upload ICOHPLIST.lobster
            <input type="file" accept=".lobster,.txt" onchange={handle_icohp_upload} hidden />
          </label>
        {:else}
          <table class="icohp-table">
            <thead>
              <tr>
                <th>Bond</th>
                <th>d (A)</th>
                <th>ICOHP (eV)</th>
              </tr>
            </thead>
            <tbody>
              {#each cohp_state.icohp_entries.filter((e) => e.is_total) as entry}
                <tr>
                  <td>{entry.label}</td>
                  <td>{entry.distance.toFixed(3)}</td>
                  <td class="mono">{entry.total.toFixed(4)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </details>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.lobster', '.txt']}
  title="Load COHPCAR.lobster"
  description="Select a COHPCAR.lobster file from local, remote HPC, or workflow output."
  onfile={async (file) => {
    uploading = true
    error_msg = ''
    try {
      session = await upload_cohpcar(file)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || 'Upload failed'
    } finally {
      uploading = false
    }
  }}
  onremote_path={async (session_id, path) => {
    uploading = true
    error_msg = ''
    try {
      session = await cohp_load_remote(session_id, path)
      selected_bond_indices = []
      cohp_state.cohp_result = null
      cohp_state.icohp_entries = null
    } catch (e: any) {
      error_msg = e.message || 'Remote load failed'
    } finally {
      uploading = false
    }
  }}
  onclose={() => show_file_dialog = false}
/>

<style>
  .cohp-analysis {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.82em;
  }
  .upload-zone {
    border: 2px dashed light-dark(rgba(0, 0, 0, 0.2), rgba(255, 255, 255, 0.2));
    border-radius: 8px;
    padding: 20px;
    text-align: center;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    cursor: pointer;
  }
  .upload-zone:hover { border-color: var(--accent-color, #007acc); }
  .upload-zone p { margin: 0 0 8px; }
  .upload-zone code { background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); padding: 2px 5px; border-radius: 3px; }
  .upload-btn {
    display: inline-block; padding: 5px 14px;
    background: var(--accent-color, #007acc); color: white;
    border-radius: 4px; cursor: pointer; font-size: 0.9em;
  }
  .upload-btn-small {
    display: inline-block; padding: 4px 10px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); color: var(--text-color, #fff);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    border-radius: 4px; cursor: pointer; font-size: 0.85em;
  }
  .upload-btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .info-bar {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-radius: 4px; font-size: 0.85em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .info-bar span { padding: 1px 4px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)); border-radius: 3px; }
  details { background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.03)); border-radius: 6px; padding: 6px 8px; }
  summary { cursor: pointer; font-weight: 600; font-size: 0.88em; color: var(--text-color, #fff); user-select: none; }
  .bond-actions { display: flex; gap: 6px; margin: 4px 0; }
  .bond-list { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow-y: auto; }
  .bond-item {
    display: flex; align-items: center; gap: 6px; padding: 3px 4px;
    border-radius: 3px; cursor: pointer; font-size: 0.9em;
  }
  .bond-item:hover { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.05)); }
  .bond-label { font-weight: 500; color: var(--text-color, #fff); }
  .bond-detail { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); margin-left: auto; }
  .display-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .display-opts label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .display-opts select { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; margin-top: 2px; }
  .checkbox-label { display: flex; align-items: center; gap: 5px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); cursor: pointer; }
  .range-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .range-input { width: 55px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.9em; }
  .line-styles { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .line-style-group { display: flex; flex-direction: column; gap: 2px; }
  .line-style-group .group-label { font-size: 0.85em; font-weight: 500; color: var(--text-color, #fff); }
  .line-style-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; }
  .line-style-row select { padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .width-input { width: 45px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .color-input { width: 28px; height: 22px; padding: 0; border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; cursor: pointer; background: transparent; }
  .slider-input { flex: 1; accent-color: var(--accent-color, #007acc); }
  .slider-val { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); min-width: 30px; text-align: right; }
  .btn-compute { padding: 6px 12px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn-compute:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-small { padding: 3px 8px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); cursor: pointer; font-size: 0.85em; }
  .btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .btn-small.danger { color: var(--error-color, #f55); }
  .btn-tiny { padding: 2px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)); border-radius: 3px; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); cursor: pointer; font-size: 0.8em; }
  .btn-tiny:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); color: var(--text-color, #fff); }
  .icohp-section { margin-top: 6px; }
  .icohp-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  .icohp-table th { text-align: left; padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); font-weight: 600; }
  .icohp-table td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .icohp-table .mono { font-family: monospace; color: var(--text-color, #fff); }
  .error-msg { padding: 5px 8px; background: light-dark(rgba(220, 38, 38, 0.1), rgba(255, 60, 60, 0.15)); border: 1px solid light-dark(rgba(220, 38, 38, 0.25), rgba(255, 60, 60, 0.3)); border-radius: 4px; color: var(--error-color, #f88); font-size: 0.85em; }
  .section-divider { border: none; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)); margin: 4px 0; }
  .source-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .remote-btn { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); }
  .remote-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }
</style>
