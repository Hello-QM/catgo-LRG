<script lang="ts">
  import { untrack } from 'svelte'
  import { Spinner } from '$lib'
  import {
    upload_h5,
    upload_procar,
    compute_pdos,
    compute_total_dos,
    compute_dband,
    select_atoms,
    cleanup_session,
    load_from_remote as dos_load_remote,
    load_from_directory as dos_load_directory,
  } from '$lib/api/dos'
  import { register_analysis_session, unregister_analysis_session } from '$lib/chat/analysis-session-store.svelte'
  import FileSourceDialog from './FileSourceDialog.svelte'
  import type {
    DOSGroup,
    DOSSessionInfo,
    DosViewState,
  } from './types'
  import type { PymatgenStructure } from '$lib/structure'

  let {
    on_structure_loaded = (_s: PymatgenStructure) => {},
    initial_session = null,
    dos_state = $bindable(),
  }: {
    on_structure_loaded?: (s: PymatgenStructure) => void
    initial_session?: DOSSessionInfo | null
    dos_state: DosViewState
  } = $props()

  // When an external session is passed in (e.g. from file open), adopt it
  $effect(() => {
    if (initial_session && initial_session !== session) {
      session = initial_session
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
    }
  })

  // State
  let session = $state<DOSSessionInfo | null>(null)

  // Register/unregister analysis session for AI tool access
  // Must untrack the register/unregister calls — they read+write analysis_sessions
  // ($state array), which would re-trigger this effect in an infinite loop.
  $effect(() => {
    if (session) {
      const { session_id, elements, efermi, nions } = session
      untrack(() => register_analysis_session({
        type: `dos`,
        session_id,
        label: `DOS (${elements?.join(`, `) ?? `uploaded`})`,
        meta: { elements, efermi, nions },
        created_at: Date.now(),
      }))
    } else {
      untrack(() => unregister_analysis_session(`dos`))
    }
  })

  let uploading = $state(false)
  let computing = $state(false)
  let error_msg = $state(``)
  let dband_computing = $state(false)
  let show_dband = $state(false)
  let show_file_dialog = $state(false)
  let remote_loading = $state(false)

  // PROCAR companion file dialog
  let show_procar_dialog = $state(false)
  let procar_pending = $state<File | null>(null)
  let outcar_file = $state<File | null>(null)
  let poscar_file = $state<File | null>(null)

  // PDOS groups
  let groups: DOSGroup[] = $state([])

  // Parameters
  let sigma = $state(0.05)
  let emin = $state(-8.0)
  let emax = $state(6.0)
  let ngrid = $state(2000)
  let include_total = $state(true)

  // New group form state
  let selection_mode = $state<`element` | `index`>(`element`)
  let new_element = $state(``)
  let new_index_spec = $state(``)
  let new_orbital = $state(`d`)
  let new_orbital_custom = $state(``)
  let new_label = $state(``)
  let new_normalize = $state(false)

  // Display option local state for range inputs (string → parsed in $effect)
  let x_range_min = $state(``)
  let x_range_max = $state(``)
  let y_range_min = $state(``)
  let y_range_max = $state(``)

  // Sync range inputs → dos_state
  $effect(() => {
    const min = parseFloat(x_range_min)
    const max = parseFloat(x_range_max)
    dos_state.x_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })
  $effect(() => {
    const min = parseFloat(y_range_min)
    const max = parseFloat(y_range_max)
    dos_state.y_range = !isNaN(min) && !isNaN(max) ? [min, max] : null
  })

  // D-band form
  let dband_sel_mode = $state<`element` | `index`>(`element`)
  let dband_element = $state(``)
  let dband_index_spec = $state(``)
  let dband_occupied_only = $state(true)

  // Derived
  let unique_elements: string[] = $derived(
    session ? [...new Set(session.elements)] : []
  )

  function get_orbital_value(): string {
    return new_orbital === `custom` ? new_orbital_custom : new_orbital
  }

  function is_procar(f: File): boolean {
    return f.name.toUpperCase().startsWith(`PROCAR`)
  }
  function is_outcar(f: File): boolean {
    return f.name.toUpperCase().startsWith(`OUTCAR`)
  }
  function is_poscar(f: File): boolean {
    const n = f.name.toUpperCase()
    return n.startsWith(`POSCAR`) || n.startsWith(`CONTCAR`)
  }

  /** Open PROCAR companion dialog (or upload H5 directly). */
  function open_procar_dialog(procar: File, outcar?: File | null, poscar?: File | null) {
    procar_pending = procar
    outcar_file = outcar ?? null
    poscar_file = poscar ?? null
    show_procar_dialog = true
  }

  async function handle_remote_path(hpc_session_id: string, path: string) {
    uploading = true
    error_msg = ''
    try {
      // Use from-directory for directories (auto-detects PROCAR+OUTCAR+CONTCAR or vaspout.h5)
      // Use from-remote for single h5 files
      const lower = path.toLowerCase()
      if (lower.endsWith('.h5') || lower.endsWith('.hdf5')) {
        session = await dos_load_remote(hpc_session_id, path)
      } else {
        // Treat as directory or let from-directory handle it
        session = await dos_load_directory(hpc_session_id, path)
      }
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session?.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || 'Remote load failed'
    } finally {
      uploading = false
    }
  }

  async function do_h5_upload(file: File) {
    uploading = true
    error_msg = ``
    try {
      session = await upload_h5(file)
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || `Upload failed`
    } finally {
      uploading = false
    }
  }

  async function handle_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    if (is_procar(file)) {
      open_procar_dialog(file)
    } else {
      await do_h5_upload(file)
    }
  }

  async function handle_drop(event: DragEvent) {
    event.preventDefault()
    const files = event.dataTransfer?.files
    if (!files?.length) return

    const file_list = Array.from(files)
    const procar = file_list.find(is_procar)

    if (procar) {
      // Auto-identify companion files from the dropped set
      open_procar_dialog(
        procar,
        file_list.find(is_outcar),
        file_list.find(is_poscar),
      )
      return
    }

    // Single H5 file
    await do_h5_upload(file_list[0])
  }

  async function submit_procar_upload() {
    if (!procar_pending) return
    show_procar_dialog = false
    uploading = true
    error_msg = ``
    try {
      session = await upload_procar(procar_pending, outcar_file, poscar_file)
      groups = []
      dos_state.dos_result = null
      dos_state.dband_result = null
      if (session.structure) {
        on_structure_loaded(session.structure as PymatgenStructure)
      }
    } catch (e: any) {
      error_msg = e.message || `Upload failed`
    } finally {
      uploading = false
      procar_pending = null
      outcar_file = null
      poscar_file = null
    }
  }

  function cancel_procar_dialog() {
    show_procar_dialog = false
    procar_pending = null
    outcar_file = null
    poscar_file = null
  }

  async function add_group() {
    if (!session) return
    error_msg = ``

    try {
      let atoms: number[]
      if (selection_mode === `element`) {
        if (!new_element) return
        atoms = await select_atoms(session.session_id, { elements: [new_element] })
      } else {
        if (!new_index_spec.trim()) return
        atoms = await select_atoms(session.session_id, { index_spec: new_index_spec.trim() })
      }

      if (atoms.length === 0) {
        error_msg = `No atoms found for selection`
        return
      }

      const orb = get_orbital_value()
      const sel_label = selection_mode === `element` ? new_element : `[${new_index_spec}]`
      const label = new_label || `${sel_label}-${orb}`

      groups = [...groups, {
        atoms,
        channels: orb,
        label,
        normalize: new_normalize,
      }]
      new_label = ``
      error_msg = ``
    } catch (e: any) {
      error_msg = e.message
    }
  }

  function remove_group(idx: number) {
    groups = groups.filter((_, i) => i !== idx)
  }

  async function run_compute() {
    if (!session || groups.length === 0) return
    computing = true
    error_msg = ``
    try {
      const params = { sigma, emin, emax, ngrid }
      const pdos = await compute_pdos(session.session_id, groups, params)

      if (include_total) {
        const total = await compute_total_dos(session.session_id, params)
        pdos.series = [...total.series, ...pdos.series]
      }

      dos_state.dos_result = pdos
    } catch (e: any) {
      error_msg = e.message || `Computation failed`
    } finally {
      computing = false
    }
  }

  async function run_dband() {
    if (!session) return
    dband_computing = true
    error_msg = ``
    try {
      let atoms: number[]
      if (dband_sel_mode === `element`) {
        if (!dband_element) return
        atoms = await select_atoms(session.session_id, { elements: [dband_element] })
      } else {
        if (!dband_index_spec.trim()) return
        atoms = await select_atoms(session.session_id, { index_spec: dband_index_spec.trim() })
      }

      if (atoms.length === 0) {
        error_msg = `No atoms found for d-band analysis`
        dband_computing = false
        return
      }

      dos_state.dband_result = await compute_dband(session.session_id, atoms, {
        sigma,
        occupied_only_center: dband_occupied_only,
      })
    } catch (e: any) {
      error_msg = e.message
    } finally {
      dband_computing = false
    }
  }

  function close_session() {
    if (session) cleanup_session(session.session_id)
    session = null
    dos_state.dos_result = null
    dos_state.dband_result = null
    groups = []
  }

  // Cleanup on component destroy
  $effect(() => {
    const sid = session?.session_id
    return () => {
      if (sid) cleanup_session(sid)
    }
  })
</script>

<div class="dos-analysis">
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
        <span>Parsing file...</span>
      {:else}
        <p>Drop <code>vaspout.h5</code> or <code>PROCAR</code> here or</p>
        <div class="source-buttons">
          <label class="upload-btn">
            Browse Local
            <input type="file" onchange={handle_upload} hidden />
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
      <span title="Elements">{session.ion_types.join(`, `)}</span>
      <span title="Atoms">{session.nions} ions</span>
      <span title="K-points">{session.nkpts}k</span>
      <span title="Bands">{session.nbands}b</span>
      <span title="Spin">{session.nspin > 1 ? `spin-pol` : `non-spin`}</span>
      <button class="btn-small danger" title="Close session" onclick={close_session}>
        &times;
      </button>
    </div>

    <!-- Group Builder -->
    <details open>
      <summary>PDOS Groups ({groups.length})</summary>

      <!-- Selection mode tabs -->
      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={selection_mode === `element`}
          onclick={() => selection_mode = `element`}
        >Element</button>
        <button
          class="tab-btn"
          class:active={selection_mode === `index`}
          onclick={() => selection_mode = `index`}
        >Index</button>
      </div>

      <div class="group-form">
        {#if selection_mode === `element`}
          <select bind:value={new_element}>
            <option value="">Element</option>
            {#each unique_elements as el}
              <option value={el}>{el}</option>
            {/each}
          </select>
        {:else}
          <input
            type="text"
            placeholder="1-5,8-10"
            bind:value={new_index_spec}
            class="index-input"
            title="1-based atom indices (e.g. 1-5,8-10)"
          />
        {/if}

        <select bind:value={new_orbital}>
          <option value="s">s</option>
          <option value="p">p</option>
          <option value="d">d</option>
          <option value="f">f</option>
          <option value="s,p">s+p</option>
          <option value="s,p,d">s+p+d</option>
          <option value="dxy">dxy</option>
          <option value="dyz">dyz</option>
          <option value="dz2">dz2</option>
          <option value="dxz">dxz</option>
          <option value="dx2-y2">dx2-y2</option>
          <option value="custom">Custom...</option>
        </select>

        {#if new_orbital === `custom`}
          <input
            type="text"
            placeholder="dxy,dz2"
            bind:value={new_orbital_custom}
            class="orbital-input"
            title="Comma-separated orbital names"
          />
        {/if}

        <input
          type="text"
          placeholder="Label"
          bind:value={new_label}
          class="label-input"
        />

        <label class="norm-toggle" title="Per-atom normalization">
          <input type="checkbox" bind:checked={new_normalize} />
          norm
        </label>

        <button
          class="btn-small"
          onclick={add_group}
          disabled={selection_mode === `element` ? !new_element : !new_index_spec.trim()}
        >+</button>
      </div>

      {#if groups.length > 0}
        <ul class="group-list">
          {#each groups as g, i}
            <li>
              <span class="group-label">{g.label}</span>
              <span class="group-detail">
                {g.atoms.length} atoms, {g.channels}{g.normalize ? ` (norm)` : ``}
              </span>
              <button class="btn-tiny" onclick={() => remove_group(i)}>&times;</button>
            </li>
          {/each}
        </ul>
      {/if}
    </details>

    <!-- Parameters -->
    <details>
      <summary>Parameters</summary>
      <div class="param-grid">
        <label>
          Sigma (eV)
          <input type="number" bind:value={sigma} step="0.01" min="0.001" max="1" />
        </label>
        <label>
          E min (eV)
          <input type="number" bind:value={emin} step="0.5" />
        </label>
        <label>
          E max (eV)
          <input type="number" bind:value={emax} step="0.5" />
        </label>
        <label>
          Grid pts
          <input type="number" bind:value={ngrid} step="100" min="100" max="10000" />
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={include_total} />
          Include total DOS
        </label>
      </div>
    </details>

    <!-- Display Options -->
    <details>
      <summary>Display Options</summary>
      <div class="display-opts">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_fermi_line} />
          Fermi level line
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_fill} />
          Fill under curves
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_spin_down} />
          Show spin down
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_dband_line} />
          D-band center line
        </label>
        <label>
          Orientation
          <select bind:value={dos_state.orientation}>
            <option value="vertical">Energy on X</option>
            <option value="horizontal">Energy on Y</option>
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
          <input type="checkbox" bind:checked={dos_state.legend_visible} />
          Show legend
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_gridlines} />
          Show gridlines
        </label>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dos_state.show_axis_lines} />
          Show axis lines
        </label>
        <div class="range-row">
          <span>Axis width:</span>
          <input
            type="number"
            bind:value={dos_state.axis_line_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>Tick length:</span>
          <input
            type="number"
            bind:value={dos_state.tick_length}
            min="0" max="15" step="1"
            class="range-input"
          />
        </div>
        <div class="range-row">
          <span>Tick width:</span>
          <input
            type="number"
            bind:value={dos_state.tick_width}
            min="0.5" max="5" step="0.5"
            class="range-input"
          />
        </div>
      </div>
    </details>

    <!-- Series Visibility -->
    {#if dos_state.dos_result && dos_state.dos_result.series.length > 0}
      <details>
        <summary>Series Visibility</summary>
        <div class="display-opts">
          {#each dos_state.dos_result.series as s}
            <label class="checkbox-label">
              <input
                type="checkbox"
                checked={!dos_state.hidden_series.includes(s.label)}
                onchange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked
                  if (checked) {
                    dos_state.hidden_series = dos_state.hidden_series.filter((l) => l !== s.label)
                  } else {
                    dos_state.hidden_series = [...dos_state.hidden_series, s.label]
                  }
                }}
              />
              {s.label}
            </label>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Line style overrides per group -->
    {#if groups.length > 0}
      <details>
        <summary>Line Styles</summary>
        <div class="line-styles">
          {#each groups as g}
            <div class="line-style-row">
              <span class="group-label">{g.label}</span>
              <select
                value={dos_state.line_styles[g.label]?.dash ?? `solid`}
                onchange={(e) => {
                  const target = e.target as HTMLSelectElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], dash: target.value } }
                }}
              >
                <option value="solid">Solid</option>
                <option value="dash">Dashed</option>
                <option value="dot">Dotted</option>
                <option value="dashdot">Dash-dot</option>
              </select>
              <input
                type="number"
                value={dos_state.line_styles[g.label]?.width ?? 1.5}
                min="0.5"
                max="5"
                step="0.5"
                class="width-input"
                onchange={(e) => {
                  const target = e.target as HTMLInputElement
                  dos_state.line_styles = { ...dos_state.line_styles, [g.label]: { ...dos_state.line_styles[g.label], width: parseFloat(target.value) } }
                }}
              />
            </div>
          {/each}
        </div>
      </details>
    {/if}

    <!-- Compute -->
    <button
      class="btn-compute"
      onclick={run_compute}
      disabled={computing || groups.length === 0}
    >
      {#if computing}
        <Spinner /> Computing...
      {:else}
        Compute PDOS
      {/if}
    </button>

    <!-- D-band Analysis -->
    <details bind:open={show_dband}>
      <summary>D-band Analysis</summary>
      <div class="tab-bar">
        <button
          class="tab-btn"
          class:active={dband_sel_mode === `element`}
          onclick={() => dband_sel_mode = `element`}
        >Element</button>
        <button
          class="tab-btn"
          class:active={dband_sel_mode === `index`}
          onclick={() => dband_sel_mode = `index`}
        >Index</button>
      </div>
      <div class="dband-form">
        {#if dband_sel_mode === `element`}
          <select bind:value={dband_element}>
            <option value="">Element</option>
            {#each unique_elements as el}
              <option value={el}>{el}</option>
            {/each}
          </select>
        {:else}
          <input
            type="text"
            placeholder="1-5,8-10"
            bind:value={dband_index_spec}
            class="index-input"
            title="1-based atom indices"
          />
        {/if}
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={dband_occupied_only} />
          Occupied only
        </label>
        <button
          class="btn-small"
          onclick={run_dband}
          disabled={dband_computing || (dband_sel_mode === `element` ? !dband_element : !dband_index_spec.trim())}
        >
          {#if dband_computing}
            <Spinner />
          {:else}
            Analyze
          {/if}
        </button>
      </div>

      {#if dos_state.dband_result}
        <table class="dband-table">
          <tbody>
            <tr><td>Center (abs)</td><td>{dos_state.dband_result.center_abs.toFixed(4)} eV</td></tr>
            <tr><td>Center (rel E<sub>f</sub>)</td><td>{dos_state.dband_result.center_rel.toFixed(4)} eV</td></tr>
            <tr><td>Width (RMS)</td><td>{dos_state.dband_result.width.toFixed(4)} eV</td></tr>
            <tr><td>Variance</td><td>{dos_state.dband_result.variance.toFixed(4)} eV&sup2;</td></tr>
            <tr><td>n<sub>d</sub></td><td>{dos_state.dband_result.n_d.toFixed(3)}</td></tr>
            <tr><td>Total d-weight</td><td>{dos_state.dband_result.total_d_weight.toFixed(3)}</td></tr>
            <tr><td>Filling</td><td>{(dos_state.dband_result.filling_fraction * 100).toFixed(1)}%</td></tr>
            <tr><td>Skewness</td><td>{dos_state.dband_result.skewness.toFixed(4)}</td></tr>
            <tr><td>Kurtosis</td><td>{dos_state.dband_result.kurtosis.toFixed(4)}</td></tr>
            <tr>
              <td>Band edges</td>
              <td>{dos_state.dband_result.lower_edge.toFixed(2)} ~ {dos_state.dband_result.upper_edge.toFixed(2)} eV</td>
            </tr>
          </tbody>
        </table>
      {/if}
    </details>
  {/if}

  {#if error_msg}
    <div class="error-msg">{error_msg}</div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.h5', '.hdf5', 'PROCAR']}
  title="Load DOS Data"
  description="Select a vaspout.h5 or PROCAR file, or provide a remote directory containing PROCAR + OUTCAR + CONTCAR."
  onfile={async (file) => {
    if (is_procar(file)) {
      open_procar_dialog(file)
    } else {
      await do_h5_upload(file)
    }
  }}
  onremote_path={handle_remote_path}
  onclose={() => show_file_dialog = false}
/>

{#if show_procar_dialog}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="procar-backdrop" onclick={cancel_procar_dialog}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="procar-modal" onclick={(e) => e.stopPropagation()}>
      <div class="procar-header">
        <h3>Upload PROCAR</h3>
        <button class="close-btn" onclick={cancel_procar_dialog}>&times;</button>
      </div>

      <div class="procar-body">
        <!-- PROCAR (always present) -->
        <div class="file-slot done">
          <span class="slot-label">PROCAR</span>
          <span class="slot-file">{procar_pending?.name}</span>
        </div>

        <!-- OUTCAR slot -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="file-slot"
          class:done={outcar_file}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const f = e.dataTransfer?.files[0]
            if (f) outcar_file = f
          }}
        >
          <span class="slot-label">OUTCAR</span>
          {#if outcar_file}
            <span class="slot-file">
              {outcar_file.name}
              <button class="btn-tiny" onclick={() => outcar_file = null}>&times;</button>
            </span>
          {:else}
            <label class="slot-browse">
              Drop or browse
              <input type="file" onchange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) outcar_file = f
              }} hidden />
            </label>
          {/if}
          {#if !outcar_file}
            <span class="slot-warn">Without OUTCAR, Fermi energy defaults to 0</span>
          {/if}
        </div>

        <!-- POSCAR slot -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="file-slot"
          class:done={poscar_file}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const f = e.dataTransfer?.files[0]
            if (f) poscar_file = f
          }}
        >
          <span class="slot-label">POSCAR / CONTCAR</span>
          {#if poscar_file}
            <span class="slot-file">
              {poscar_file.name}
              <button class="btn-tiny" onclick={() => poscar_file = null}>&times;</button>
            </span>
          {:else}
            <label class="slot-browse">
              Drop or browse
              <input type="file" onchange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) poscar_file = f
              }} hidden />
            </label>
          {/if}
          {#if !poscar_file}
            <span class="slot-warn">Without POSCAR, atoms cannot be selected by element</span>
          {/if}
        </div>
      </div>

      <div class="procar-footer">
        <button class="btn-cancel" onclick={submit_procar_upload}>
          Skip (PROCAR only)
        </button>
        <button class="btn-upload" onclick={submit_procar_upload}>
          Upload
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dos-analysis {
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
  .info-bar {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 6px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.04));
    border-radius: 4px; font-size: 0.85em;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .info-bar span { padding: 1px 4px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06)); border-radius: 3px; }
  .tab-bar { display: flex; gap: 2px; margin: 6px 0 4px; }
  .tab-btn {
    padding: 2px 10px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1)); border-radius: 3px 3px 0 0;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); cursor: pointer; font-size: 0.85em;
  }
  .tab-btn.active { background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.12)); color: var(--text-color, #fff); border-bottom-color: transparent; }
  details { background: light-dark(rgba(0, 0, 0, 0.02), rgba(255, 255, 255, 0.03)); border-radius: 6px; padding: 6px 8px; }
  summary { cursor: pointer; font-weight: 600; font-size: 0.88em; color: var(--text-color, #fff); user-select: none; }
  .group-form { display: flex; gap: 4px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
  .group-form select, .group-form input {
    padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px;
    color: var(--text-color, #fff); font-size: 0.9em;
  }
  .group-form select { min-width: 60px; }
  .label-input { width: 60px; }
  .index-input { width: 80px; }
  .orbital-input { width: 70px; }
  .norm-toggle { display: flex; align-items: center; gap: 3px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); cursor: pointer; }
  .group-list { list-style: none; padding: 0; margin: 6px 0 0; }
  .group-list li { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .group-label { font-weight: 500; color: var(--text-color, #fff); }
  .group-detail { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); flex: 1; }
  .param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
  .param-grid label { display: flex; flex-direction: column; gap: 2px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .param-grid input[type="number"] {
    padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px;
    color: var(--text-color, #fff); font-size: 0.95em; width: 100%; box-sizing: border-box;
  }
  .checkbox-label { flex-direction: row !important; align-items: center; gap: 5px !important; grid-column: span 2; display: flex; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); cursor: pointer; }
  .display-opts { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .display-opts label { font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.7)); }
  .display-opts select { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; margin-top: 2px; }
  .range-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .range-input { width: 55px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.9em; }
  .line-styles { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .line-style-row { display: flex; align-items: center; gap: 4px; font-size: 0.85em; }
  .line-style-row .group-label { min-width: 60px; font-size: 0.9em; }
  .line-style-row select { padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .width-input { width: 45px; padding: 2px 4px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); font-size: 0.85em; }
  .btn-compute { padding: 6px 12px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn-compute:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-small { padding: 3px 8px; background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.1)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 3px; color: var(--text-color, #fff); cursor: pointer; font-size: 0.85em; }
  .btn-small:hover { background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.2)); }
  .btn-small.danger { color: var(--error-color, #f55); }
  .btn-tiny { padding: 1px 5px; background: transparent; border: none; color: var(--text-color-muted, rgba(255, 255, 255, 0.4)); cursor: pointer; font-size: 1em; }
  .btn-tiny:hover { color: var(--error-color, #f55); }
  .dband-form { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .dband-form select, .dband-form input[type="text"] { padding: 3px 5px; background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); border-radius: 4px; color: var(--text-color, #fff); font-size: 0.9em; }
  .dband-table { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: 0.9em; }
  .dband-table td { padding: 3px 6px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.05)); }
  .dband-table td:first-child { color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); width: 40%; }
  .dband-table td:last-child { color: var(--text-color, #fff); font-family: monospace; }
  .error-msg { padding: 5px 8px; background: light-dark(rgba(220, 38, 38, 0.1), rgba(255, 60, 60, 0.15)); border: 1px solid light-dark(rgba(220, 38, 38, 0.25), rgba(255, 60, 60, 0.3)); border-radius: 4px; color: var(--error-color, #f88); font-size: 0.85em; }
  .section-divider { border: none; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08)); margin: 4px 0; }
  .source-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .remote-btn { background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08)); border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15)); }
  .remote-btn:hover { background: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.15)); }

  /* PROCAR companion file dialog */
  .procar-backdrop {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
  }
  .procar-modal {
    background: light-dark(#fff, #1e1e2e); border-radius: 10px;
    width: min(420px, 90vw); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
  }
  .procar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }
  .procar-header h3 { margin: 0; font-size: 0.95em; color: var(--text-color, #fff); }
  .close-btn { background: none; border: none; color: var(--text-color-muted, rgba(255, 255, 255, 0.5)); font-size: 1.3em; cursor: pointer; padding: 0 4px; }
  .close-btn:hover { color: var(--text-color, #fff); }
  .procar-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .file-slot {
    padding: 8px 10px; border-radius: 6px;
    background: light-dark(rgba(0, 0, 0, 0.03), rgba(255, 255, 255, 0.04));
    border: 1px dashed light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    display: flex; flex-direction: column; gap: 4px;
  }
  .file-slot.done {
    border-style: solid;
    border-color: light-dark(rgba(34, 197, 94, 0.4), rgba(34, 197, 94, 0.3));
    background: light-dark(rgba(34, 197, 94, 0.05), rgba(34, 197, 94, 0.06));
  }
  .slot-label { font-size: 0.8em; font-weight: 600; color: var(--text-color-muted, rgba(255, 255, 255, 0.6)); }
  .slot-file { font-size: 0.85em; color: var(--text-color, #fff); display: flex; align-items: center; gap: 6px; }
  .slot-browse {
    font-size: 0.82em; color: var(--accent-color, #007acc); cursor: pointer;
    text-decoration: underline; text-underline-offset: 2px;
  }
  .slot-browse:hover { opacity: 0.8; }
  .slot-warn {
    font-size: 0.78em; color: light-dark(#b45309, #fbbf24); font-style: italic;
  }
  .procar-footer {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
  }
  .btn-cancel {
    padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
    color: var(--text-color-muted, rgba(255, 255, 255, 0.7));
  }
  .btn-upload {
    padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
    background: var(--accent-color, #007acc); color: white; border: none;
  }
</style>
