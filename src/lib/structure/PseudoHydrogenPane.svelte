<script lang="ts">
  import type { PymatgenStructure } from '$lib/structure'
  import { DraggablePane } from '$lib'
  import type { ComponentProps } from 'svelte'
  import {
    passivateSlab,
    type PseudoHydrogenParams,
    type PseudoHydrogenResult,
  } from '$lib/api/pseudo-hydrogen'
  import { SERVER_URL } from '$lib/api/config'
  import { parse_structure_file } from './parse'

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    selected_sites = [],
    parent_bulk = null as PymatgenStructure | null,
    server_url = SERVER_URL,
    on_push_undo,
    on_structure_change,
    on_pseudo_h_added,
    pane_props = {},
    toggle_props = {},
    embedded = false,
  }: {
    structure?: PymatgenStructure
    pane_open?: boolean
    selected_sites?: number[]
    parent_bulk?: PymatgenStructure | null
    server_url?: string
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    on_pseudo_h_added?: (result: PseudoHydrogenResult, n_slab_atoms: number) => void
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    embedded?: boolean
  } = $props()

  // Bulk structure: user-uploaded overrides parent_bulk (from slab cutter)
  let uploaded_bulk = $state<PymatgenStructure | null>(null)
  let bulk_filename = $state<string>(``)
  let bulk_input: HTMLInputElement | null = $state(null)

  // Effective bulk: uploaded takes priority, then parent (slab cutter) bulk
  let bulk_structure = $derived(uploaded_bulk ?? parent_bulk)
  let bulk_source = $derived(uploaded_bulk ? `upload` : parent_bulk ? `slab_cutter` : null)

  // Parameters
  let use_selected_only = $state(false)
  let passivate_top = $state(false)
  let passivate_bottom = $state(true)
  let surface_depth = $state(1.5)
  let bond_length_scale = $state(1.0)
  let cutoff_mult = $state(1.15)

  // Advanced
  let show_advanced = $state(false)
  let show_theory = $state(false)
  let valence_json = $state(``)
  let coordination_json = $state(``)

  // Status
  let status = $state<'idle' | 'running' | 'complete' | 'error'>(`idle`)
  let error_message = $state<string | null>(null)
  let result_message = $state<string | null>(null)
  let result_details = $state<PseudoHydrogenResult | null>(null)

  let has_selection = $derived(selected_sites.length > 0)

  // Compute bulk formula for display
  let bulk_formula = $derived.by(() => {
    if (!bulk_structure?.sites) return ``
    const counts: Record<string, number> = {}
    for (const site of bulk_structure.sites) {
      const el = site.species?.[0]?.element ?? `X`
      counts[el] = (counts[el] ?? 0) + 1
    }
    return Object.entries(counts).map(([el, n]) => n > 1 ? `${el}${n}` : el).join(``)
  })

  function trigger_bulk_upload() {
    bulk_input?.click()
  }

  async function handle_bulk_upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    try {
      const content = await file.text()
      const parsed = parse_structure_file(content, file.name)
      if (!(parsed as any)?.structure) {
        error_message = `Failed to parse bulk structure file`
        return
      }
      uploaded_bulk = (parsed as any).structure as PymatgenStructure
      bulk_filename = file.name
      error_message = null
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
      uploaded_bulk = null
    }

    // Reset input so the same file can be re-selected
    input.value = ``
  }

  function clear_uploaded_bulk() {
    uploaded_bulk = null
    bulk_filename = ``
  }

  async function passivate() {
    if (!structure || !bulk_structure) {
      error_message = `Both slab and bulk structures are required`
      return
    }

    on_push_undo?.()
    status = `running`
    error_message = null
    result_message = null
    result_details = null

    try {
      // Parse advanced JSON overrides
      let valence_electrons: Record<string, number> | null = null
      if (valence_json.trim()) {
        try {
          valence_electrons = JSON.parse(valence_json)
        } catch {
          throw new Error(`Invalid valence electrons JSON: ${valence_json}`)
        }
      }

      let bulk_coordination: Record<string, number> | null = null
      if (coordination_json.trim()) {
        try {
          bulk_coordination = JSON.parse(coordination_json)
        } catch {
          throw new Error(`Invalid bulk coordination JSON: ${coordination_json}`)
        }
      }

      const params: PseudoHydrogenParams = {
        passivate_top: use_selected_only ? undefined : passivate_top,
        passivate_bottom: use_selected_only ? undefined : passivate_bottom,
        surface_depth,
        bond_length_scale,
        cutoff_mult,
        selected_indices: use_selected_only && has_selection ? selected_sites : null,
        valence_electrons,
        bulk_coordination,
      }

      const result: PseudoHydrogenResult = await passivateSlab(
        structure, bulk_structure, params, server_url,
      )

      if (result.n_pseudo_h === 0) {
        status = `error`
        error_message = result.message
        return
      }

      const n_slab_atoms = structure.sites.length
      structure = result.structure
      on_structure_change?.(result.structure)
      on_pseudo_h_added?.(result, n_slab_atoms)
      status = `complete`
      result_message = result.message
      result_details = result
    } catch (err) {
      status = `error`
      error_message = err instanceof Error ? err.message : String(err)
    }
  }
</script>

{#snippet pane_content()}
  <div class="title-row">
    <h4>Pseudo-Hydrogen Passivation</h4>
    <button class="info-btn" onclick={() => show_theory = !show_theory} title="How it works">?</button>
  </div>

  {#if show_theory}
    <div class="theory-box">
      <p>In bulk, each A-B covalent bond has <strong>2 electrons</strong>:</p>
      <p class="formula">e_A = V_A/N_A, &nbsp; e_B = V_B/N_B, &nbsp; e_A + e_B = 2</p>
      <p>When a slab is cut, surface atoms lose neighbors. The pseudo-H nuclear charge equals the electron contribution of the <strong>missing</strong> atom:</p>
      <p class="formula">Z_H = V<sub>missing</sub> / N<sub>missing</sub></p>
      <p><strong>Example (ZnO, N=4):</strong><br/>
        Zn face (O missing): Z_H = 6/4 = 1.50<br/>
        O face (Zn missing): Z_H = 2/4 = 0.50</p>
      <p class="theory-note">V = bonding valence electrons (NOT VASP POTCAR count).<br/>
        N = bulk coordination number (auto-detected, verify below).<br/>
        Check that V_A/N_A + V_B/N_B = 2 for each bond type.</p>
    </div>
  {/if}

  <!-- Bulk structure -->
  <div class="bulk-upload">
    <span class="section-label">Bulk Structure</span>
    {#if bulk_structure}
      <div class="bulk-info">
        <span class="bulk-formula">{bulk_formula}</span>
        {#if bulk_source === `upload`}
          <span class="bulk-file">({bulk_filename})</span>
          <button class="clear-btn" onclick={clear_uploaded_bulk} title="Clear uploaded bulk">✕</button>
        {:else}
          <span class="bulk-file">(from slab cutter)</span>
        {/if}
      </div>
      {#if bulk_source !== `upload`}
        <button class="upload-btn override-btn" onclick={trigger_bulk_upload}>
          Override with file...
        </button>
      {/if}
    {:else}
      <button class="upload-btn" onclick={trigger_bulk_upload}>
        Upload Bulk File
      </button>
    {/if}
  </div>

  <!-- Selection mode -->
  <div class="selection-section">
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={use_selected_only} disabled={!has_selection} />
      <span>
        Passivate selected atoms only
        {#if has_selection}
          ({selected_sites.length} selected)
        {:else}
          (select atoms first)
        {/if}
      </span>
    </label>
  </div>

  <!-- Surface controls (only when auto-detect mode) -->
  {#if !use_selected_only}
    <div class="surface-params">
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={passivate_top} />
        <span>Top surface</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={passivate_bottom} />
        <span>Bottom surface</span>
      </label>
    </div>
  {/if}

  <!-- Primary parameters -->
  <div class="primary-params">
    <label>
      <span>Bond length scale</span>
      <input type="number" bind:value={bond_length_scale} min={0.5} max={1.5} step={0.05} />
    </label>
    <label>
      <span>Surface depth (Å)</span>
      <input type="number" bind:value={surface_depth} min={0.5} max={5.0} step={0.1} />
    </label>
  </div>

  <!-- Advanced parameters -->
  <details bind:open={show_advanced}>
    <summary>Advanced Parameters</summary>
    <div class="advanced-params">
      <label>
        <span>Cutoff multiplier</span>
        <input type="number" bind:value={cutoff_mult} min={0.8} max={2.0} step={0.05} />
      </label>
      <label class="full-width">
        <span>Valence electrons (JSON)</span>
        <input type="text" bind:value={valence_json} placeholder={`{"Fe": 3, "O": 6}`} />
      </label>
      <label class="full-width">
        <span>Bulk coordination (JSON)</span>
        <input type="text" bind:value={coordination_json} placeholder={`{"Fe": 8}`} />
      </label>
    </div>
  </details>

  <!-- Action button -->
  <div class="controls">
    <button
      type="button"
      onclick={passivate}
      disabled={status === `running` || !structure || !bulk_structure}
      class="primary"
    >
      {status === `running` ? `Passivating...` : `Passivate`}
    </button>
  </div>

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}

  {#if result_message && status === `complete`}
    <div class="success">{result_message}</div>
  {/if}

  {#if result_details && status === `complete`}
    <div class="results">
      <div class="result-row">
        <span class="result-label">Bulk analysis (verify!):</span>
      </div>
      {#each Object.entries(result_details.bulk_coordination) as [el, cn]}
        <div class="result-row detail-row">
          <span>{el}: N={cn}, V={result_details.valence_used?.[el] ?? `?`}</span>
          <span class="derived">→ V/N = {((result_details.valence_used?.[el] ?? 0) / cn).toFixed(2)}</span>
        </div>
      {/each}
      {#if result_details.bond_warnings?.length > 0}
        <div class="warning-box">
          {#each result_details.bond_warnings as w}
            <div class="warning-line">{w}</div>
          {/each}
        </div>
      {/if}
      {#if result_details.unique_potcars.length > 0}
        <div class="result-row potcar-info">
          <span class="result-label">POTCAR:</span>
          <span>{result_details.unique_potcars.join(` + `)}</span>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Hidden file input -->
  <input
    type="file"
    accept=".poscar,.vasp,.xyz,.cif,.json"
    style="display: none;"
    bind:this={bulk_input}
    onchange={handle_bulk_upload}
  />
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Atom"
    show_toggle={!embedded}
    pane_props={{ ...pane_props, class: `pseudo-h-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : `Pseudo-Hydrogen Passivation`,
      ...toggle_props,
      class: `pseudo-h-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  h4 {
    margin: 0;
    font-size: 0.9em;
    font-weight: 600;
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6pt;
    margin-bottom: 8pt;
  }

  .info-btn {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--text-secondary, #888);
    background: transparent;
    color: var(--text-secondary, #888);
    font-size: 0.75em;
    font-weight: 700;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    flex-shrink: 0;
  }

  .info-btn:hover {
    background: var(--accent-color, #2196f3);
    color: white;
    border-color: var(--accent-color, #2196f3);
  }

  .theory-box {
    margin-bottom: 8pt;
    padding: 6pt 8pt;
    background: rgba(33, 150, 243, 0.08);
    border-radius: 4pt;
    font-size: 0.82em;
    line-height: 1.4;
  }

  .theory-box p {
    margin: 3pt 0;
  }

  .theory-box .formula {
    font-family: monospace;
    font-size: 0.95em;
    padding: 2pt 4pt;
    background: rgba(0, 0, 0, 0.05);
    border-radius: 2pt;
    text-align: center;
  }

  .theory-note {
    color: var(--text-secondary, #666);
    font-size: 0.9em;
    font-style: italic;
  }

  .bulk-upload {
    margin-bottom: 8pt;
  }

  .section-label {
    display: block;
    color: var(--text-secondary, #666);
    font-size: 0.85em;
    margin-bottom: 3pt;
  }

  .bulk-info {
    display: flex;
    align-items: center;
    gap: 4pt;
    padding: 4pt 6pt;
    background: rgba(76, 175, 80, 0.1);
    border-radius: 3pt;
    font-size: 0.9em;
  }

  .bulk-formula {
    font-weight: 600;
  }

  .bulk-file {
    color: var(--text-secondary, #666);
    font-size: 0.85em;
  }

  .clear-btn {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary, #999);
    font-size: 0.9em;
    padding: 0 2pt;
  }

  .clear-btn:hover {
    color: var(--text-primary, #333);
  }

  .upload-btn {
    width: 100%;
    padding: 6pt 8pt;
    background: var(--pane-btn-bg, rgba(255, 255, 255, 0.08));
    border: 1px dashed var(--text-secondary, #666);
    border-radius: 3pt;
    color: inherit;
    cursor: pointer;
    font-size: 0.85em;
  }

  .upload-btn:hover {
    background: var(--pane-btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .override-btn {
    margin-top: 4pt;
    padding: 3pt 6pt;
    font-size: 0.8em;
    border-style: dotted;
    opacity: 0.7;
  }

  .selection-section {
    margin: 6pt 0;
  }

  .surface-params {
    display: flex;
    gap: 12pt;
    margin: 4pt 0 6pt;
    padding-left: 4pt;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 4pt;
    cursor: pointer;
    font-size: 0.9em;
  }

  .checkbox-row input:disabled + span {
    opacity: 0.5;
  }

  .primary-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-bottom: 8pt;
  }

  .primary-params label,
  .advanced-params label {
    display: flex;
    flex-direction: column;
    gap: 2pt;
  }

  .primary-params label span,
  .advanced-params label span {
    color: var(--text-secondary, #666);
    font-size: 0.85em;
  }

  .primary-params input[type='number'],
  .advanced-params input[type='number'],
  .advanced-params input[type='text'] {
    width: 100%;
    padding: 3pt 4pt;
  }

  .advanced-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6pt;
    margin-top: 6pt;
  }

  .advanced-params .full-width {
    grid-column: 1 / -1;
  }

  .controls {
    display: flex;
    gap: 6pt;
    margin: 8pt 0;
  }

  .controls button.primary {
    padding: 4pt 8pt;
    background: var(--accent-color, #2196f3);
    color: white;
    border: none;
    border-radius: 3pt;
    flex: 1;
  }

  .controls button.primary:hover:not(:disabled) {
    background: var(--accent-color-dark, #1976d2);
  }

  .controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(244, 67, 54, 0.1);
    border-radius: 3pt;
  }

  .success {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(76, 175, 80, 0.1);
    border-radius: 3pt;
    color: #2e7d32;
    font-size: 0.9em;
  }

  .results {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(33, 150, 243, 0.1);
    border-radius: 3pt;
    font-size: 0.85em;
  }

  .result-row {
    margin: 2pt 0;
  }

  .detail-row {
    display: flex;
    justify-content: space-between;
    font-family: monospace;
    font-size: 0.95em;
    padding: 1pt 4pt;
  }

  .derived {
    color: var(--text-secondary, #888);
  }

  .result-label {
    font-weight: 600;
    margin-right: 4pt;
  }

  .warning-box {
    margin: 4pt 0;
    padding: 4pt 6pt;
    background: rgba(255, 152, 0, 0.15);
    border-radius: 3pt;
    font-size: 0.85em;
  }

  .warning-line {
    margin: 2pt 0;
    color: #e65100;
    font-family: monospace;
    font-size: 0.9em;
  }

  .potcar-info {
    padding: 3pt 0;
    font-family: monospace;
    font-size: 0.95em;
  }
</style>
