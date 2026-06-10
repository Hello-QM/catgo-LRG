<script lang="ts">
  import { Icon } from '$lib'
  import type { OptimadeStructure } from '$lib/api/optimade'
  import { Composition } from '$lib/composition'
  import type { PymatgenStructure } from './index'
  import StructurePreview from './StructurePreview.svelte'

  export interface PreviewDetailRow {
    label: string
    value: string
    mono?: boolean
  }

  export interface PreviewLatticeParams {
    a: number
    b: number
    c: number
    alpha: number
    beta: number
    gamma: number
  }

  interface Props {
    visible: boolean
    onclose: () => void
    onconfirm: () => void
    pymatgen_structure: PymatgenStructure | null
    // Generic mode (preferred): caller prepares the rows
    title?: string
    formula?: string
    details?: PreviewDetailRow[]
    lattice_params?: PreviewLatticeParams | null
    // Legacy OPTIMADE mode (back-compat): if optimade_structure is provided
    // and `details` is not, the modal computes the rows from it.
    optimade_structure?: OptimadeStructure | null
    provider_name?: string
  }

  let {
    visible,
    onclose,
    onconfirm,
    pymatgen_structure,
    title = `Preview Structure Import`,
    formula: formula_prop,
    details: details_prop,
    lattice_params: lattice_params_prop,
    optimade_structure = null,
    provider_name = `OPTIMADE`,
  }: Props = $props()

  let modal_element = $state<HTMLDivElement | null>(null)

  function handle_keydown(event: KeyboardEvent) {
    if (visible && event.key === `Escape`) onclose()
  }

  function handle_click_outside(event: MouseEvent) {
    if (!modal_element) return
    const target = event.target as HTMLElement
    if (!modal_element.contains(target)) onclose()
  }

  function calculate_lattice_params(
    lattice_vectors: number[][],
  ): {
    a: number
    b: number
    c: number
    alpha: number
    beta: number
    gamma: number
  } | null {
    if (!lattice_vectors || lattice_vectors.length !== 3) return null

    try {
      const [v1, v2, v3] = lattice_vectors

      // Calculate vector lengths
      const a = Math.sqrt(v1[0] ** 2 + v1[1] ** 2 + v1[2] ** 2)
      const b = Math.sqrt(v2[0] ** 2 + v2[1] ** 2 + v2[2] ** 2)
      const c = Math.sqrt(v3[0] ** 2 + v3[1] ** 2 + v3[2] ** 2)

      // Calculate dot products
      const v2_dot_v3 = v2[0] * v3[0] + v2[1] * v3[1] + v2[2] * v3[2]
      const v1_dot_v3 = v1[0] * v3[0] + v1[1] * v3[1] + v1[2] * v3[2]
      const v1_dot_v2 = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]

      // Calculate angles
      const alpha = Math.acos(v2_dot_v3 / (b * c)) * (180 / Math.PI)
      const beta = Math.acos(v1_dot_v3 / (a * c)) * (180 / Math.PI)
      const gamma = Math.acos(v1_dot_v2 / (a * b)) * (180 / Math.PI)

      return { a, b, c, alpha, beta, gamma }
    } catch {
      return null
    }
  }

  function get_formula(): string {
    if (!optimade_structure?.attributes) return `Unknown formula`
    const { chemical_formula_descriptive, chemical_formula_reduced } =
      optimade_structure.attributes
    return chemical_formula_descriptive || chemical_formula_reduced || `Unknown formula`
  }

  function get_sites_count(): number {
    if (optimade_structure?.attributes?.n_sites) {
      return optimade_structure.attributes.n_sites
    }
    if (
      optimade_structure?.attributes?.cartesian_site_positions &&
      Array.isArray(optimade_structure.attributes.cartesian_site_positions)
    ) {
      return optimade_structure.attributes.cartesian_site_positions.length
    }
    return 0
  }

  let lattice_params = $derived.by(() => {
    if (lattice_params_prop !== undefined) return lattice_params_prop
    if (!optimade_structure?.attributes?.lattice_vectors) return null
    return calculate_lattice_params(optimade_structure.attributes.lattice_vectors)
  })

  let formula = $derived.by(() => formula_prop ?? get_formula())
  let sites_count = $derived.by(() => get_sites_count())

  let details_rows = $derived.by<PreviewDetailRow[]>(() => {
    if (details_prop && details_prop.length > 0) return details_prop
    // Legacy OPTIMADE-derived rows
    if (!optimade_structure) return []
    const rows: PreviewDetailRow[] = []
    rows.push({ label: `ID:`, value: optimade_structure.id, mono: true })
    rows.push({ label: `Formula:`, value: formula })
    rows.push({ label: `Sites:`, value: String(sites_count) })
    rows.push({ label: `Database:`, value: provider_name })
    return rows
  })
</script>

<svelte:window onkeydown={handle_keydown} />

{#if visible && pymatgen_structure}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handle_click_outside}>
    <div class="modal-content" bind:this={modal_element} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>{title}</h2>
        <button class="close-btn" onclick={onclose}>×</button>
      </div>

      <div class="modal-body">
        <div class="preview-container">
          <!-- Left column: 3D Structure preview -->
          <div class="structure-preview-column">
            <StructurePreview structure={pymatgen_structure} />
          </div>

          <!-- Right column: Structure info and composition -->
          <div class="info-column">
            <div class="info-section">
              <h3>Details</h3>

              {#each details_rows as row (row.label + row.value)}
                <div class="info-item">
                  <span class="label">{row.label}</span>
                  <span class="value" class:mono={row.mono}>{row.value}</span>
                </div>
              {/each}

              {#if lattice_params}
                <div class="info-subsection">
                  <span class="sublabel">Lattice</span>

                  <div class="lattice-grid">
                    <div class="lattice-item">
                      <span class="lattice-label">a:</span>
                      <span class="lattice-value">{lattice_params.a.toFixed(2)} Å</span>
                    </div>
                    <div class="lattice-item">
                      <span class="lattice-label">b:</span>
                      <span class="lattice-value">{lattice_params.b.toFixed(2)} Å</span>
                    </div>
                    <div class="lattice-item">
                      <span class="lattice-label">c:</span>
                      <span class="lattice-value">{lattice_params.c.toFixed(2)} Å</span>
                    </div>

                    <div class="lattice-item">
                      <span class="lattice-label">α:</span>
                      <span class="lattice-value">{lattice_params.alpha.toFixed(1)}°</span>
                    </div>
                    <div class="lattice-item">
                      <span class="lattice-label">β:</span>
                      <span class="lattice-value">{lattice_params.beta.toFixed(1)}°</span>
                    </div>
                    <div class="lattice-item">
                      <span class="lattice-label">γ:</span>
                      <span class="lattice-value">{lattice_params.gamma.toFixed(1)}°</span>
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Composition visualization -->
            {#if formula && formula !== 'Unknown formula'}
              <div class="composition-section">
                <h3>Composition</h3>
                <Composition
                  composition={formula}
                  mode="pie"
                  style="width: 100%; height: 150px; display: flex; align-items: center; justify-content: center;"
                />
              </div>
            {/if}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="cancel-btn" onclick={onclose}>
          <Icon icon={"X" as any} /> Cancel
        </button>
        <button class="confirm-btn" onclick={onconfirm}>
          <Icon icon="Check" /> Confirm Import
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100000010;
    padding: 16px;
    overflow: auto;
    box-sizing: border-box;
  }

  .modal-content {
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: 8px;
    width: min(1000px, calc(100vw - 32px));
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    box-sizing: border-box;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, #444);
    min-width: 0;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.1rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 20px;
    cursor: pointer;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .close-btn:hover {
    background: var(--surface-bg-hover, #333);
  }

  .modal-body {
    padding: 16px;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    min-height: 0;
    min-width: 0;
  }

  .preview-container {
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 16px;
    width: 100%;
    height: 100%;
    max-height: 500px;
    min-width: 0;
  }

  .structure-preview-column {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 300px;
    min-width: 0;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    overflow: hidden;
  }

  .info-column {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    padding-right: 8px;
    min-width: 0;
  }

  .info-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .info-section h3 {
    margin: 0;
    font-size: 0.9rem;
    color: inherit;
    border-bottom: 1px solid var(--border-color, #444);
    padding-bottom: 6px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .composition-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .composition-section h3 {
    margin: 0;
    font-size: 0.9rem;
    color: inherit;
    border-bottom: 1px solid var(--border-color, #444);
    padding-bottom: 6px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  .info-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.9rem;
  }

  .label {
    color: var(--text-color-muted, #999);
    min-width: 60px;
    font-weight: 500;
  }

  .value {
    color: inherit;
    flex: 1;
    word-break: break-all;
  }

  .value.mono {
    font-family: monospace;
    font-size: 0.8rem;
  }

  .info-subsection {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0;
  }

  .sublabel {
    color: var(--text-color-muted, #999);
    font-size: 0.85rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .lattice-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .lattice-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 0.85rem;
    background: var(--surface-bg-hover, #333);
    padding: 6px 8px;
    border-radius: 4px;
  }

  .lattice-label {
    color: var(--text-color-muted, #999);
    min-width: 20px;
    font-weight: 500;
  }

  .lattice-value {
    color: inherit;
    font-family: monospace;
  }


  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-color, #444);
    background: var(--surface-bg-hover, #333);
    flex-wrap: wrap;
  }

  .cancel-btn,
  .confirm-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    font-size: 0.9rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .cancel-btn {
    background: var(--border-color, #444);
    color: inherit;
  }

  .cancel-btn:hover {
    background: var(--text-color-muted, #999);
    opacity: 0.8;
  }

  .confirm-btn {
    background: var(--accent-color, #0066cc);
    color: white;
  }

  .confirm-btn:hover {
    opacity: 0.9;
  }

  @media (max-width: 800px) {
    .modal-overlay {
      padding: 8px;
    }

    .preview-container {
      grid-template-columns: 1fr;
      gap: 16px;
      max-height: none;
    }

    .structure-preview-column {
      min-height: 250px;
    }

    .modal-content {
      width: calc(100vw - 16px);
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
    }
  }
</style>
