<script lang="ts">
  import type { PymatgenMolecule, PymatgenStructure } from '$lib'
  import { wrap_molecule_in_box } from '$lib/structure/lattice-ops'

  interface Props {
    visible: boolean
    molecule: PymatgenMolecule | null
    onclose: () => void
    onwrap: (wrapped: PymatgenStructure) => void
  }
  let { visible, molecule, onclose, onwrap }: Props = $props()

  let vacuum_padding = $state(10)
  let modal_element = $state<HTMLDivElement | null>(null)

  function handle_keydown(event: KeyboardEvent) {
    if (visible && event.key === `Escape`) onclose()
  }

  function handle_click_outside(event: MouseEvent) {
    if (!modal_element) return
    const target = event.target as HTMLElement
    if (!modal_element.contains(target)) onclose()
  }

  function handle_wrap() {
    if (!molecule) return
    const wrapped = wrap_molecule_in_box(molecule, vacuum_padding)
    onwrap(wrapped)
  }
</script>

<svelte:window onkeydown={handle_keydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-overlay" onclick={handle_click_outside}>
    <div class="modal-content" bind:this={modal_element} role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>Vacuum Box</h2>
        <button class="close-btn" onclick={onclose}>&times;</button>
      </div>

      <div class="modal-body">
        <div class="param-row">
          <span>Padding (&Aring;)</span>
          <input type="number" min="1" max="50" step="1" bind:value={vacuum_padding} />
        </div>
        <div class="padding-presets">
          {#each [
            { value: 8, label: `8`, hint: `Small neutral molecules` },
            { value: 10, label: `10`, hint: `Standard (recommended)` },
            { value: 12, label: `12`, hint: `Charged / polar molecules` },
            { value: 15, label: `15`, hint: `Dispersion corrections (DFT-D3)` },
          ] as preset}
            <button
              class="preset-chip"
              class:active={vacuum_padding === preset.value}
              title={preset.hint}
              onclick={() => vacuum_padding = preset.value}
            >{preset.label}</button>
          {/each}
        </div>
        <p class="padding-hint">
          {#if vacuum_padding <= 6}
            Tight — only for quick tests, not production
          {:else if vacuum_padding <= 8}
            OK for small neutral molecules (H2O, CH4)
          {:else if vacuum_padding <= 10}
            Standard — safe for most molecules
          {:else if vacuum_padding <= 12}
            Recommended for charged or polar systems
          {:else}
            Large — good for dispersion corrections or long-range interactions
          {/if}
        </p>
        <button class="wrap-btn" onclick={handle_wrap} disabled={!molecule || !(vacuum_padding > 0)}>
          Wrap in Vacuum Box
        </button>
        <p class="convergence-tip">
          Places molecule in an orthorhombic cell for periodic codes (VASP, QE).
          Tip: converge padding by comparing energies at different values.
        </p>
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
    width: min(400px, calc(100vw - 32px));
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
    font-size: 1.1em;
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
    background: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.1));
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .param-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8pt;
    padding: 3pt 2pt;
    min-width: 0;
  }
  .param-row input[type="number"] {
    width: 70px;
    text-align: right;
    min-width: 0;
  }
  .padding-presets {
    display: flex;
    gap: 4px;
    padding: 2pt 2pt;
    flex-wrap: wrap;
  }
  .preset-chip {
    flex: 1;
    padding: 3px 6px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
    border: 1px solid light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.1));
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    color: inherit;
    min-width: 0;
  }
  .preset-chip:hover {
    background: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.15));
  }
  .preset-chip.active {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
    color: white;
  }
  .padding-hint {
    font-size: 0.8em;
    color: var(--text-color-muted);
    margin: 0.2em 0 0.4em;
    padding: 0 2pt;
  }
  .wrap-btn {
    display: block;
    width: 100%;
    padding: 5px 10px;
    margin-top: 0.4em;
    background: var(--accent-color, #007acc);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .wrap-btn:hover {
    filter: brightness(1.1);
  }
  .convergence-tip {
    font-size: 0.8em;
    color: var(--text-color-muted);
    margin-top: 0.6em;
  }

  @media (max-width: 420px) {
    .modal-overlay {
      padding: 8px;
    }

    .modal-content {
      width: calc(100vw - 16px);
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
    }

    .param-row {
      align-items: stretch;
      flex-direction: column;
    }

    .param-row input[type="number"] {
      width: 100%;
    }
  }
</style>
