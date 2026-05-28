<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module(`workflow`)

  interface Props {
    image_energies: Record<number, Array<[number, number]>>
    selected_iteration?: number | null
  }

  let { image_energies = {}, selected_iteration = null }: Props = $props()

  const latest_iteration = $derived(
    Object.keys(image_energies).length > 0
      ? Math.max(...Object.keys(image_energies).map(Number))
      : null
  )

  let selected = $state<number | null>(selected_iteration ?? latest_iteration)

  $effect(() => {
    selected = selected_iteration ?? latest_iteration
  })

  const iterations = $derived(
    Object.keys(image_energies)
      .map(Number)
      .sort((a, b) => a - b)
  )

  const images = $derived.by(() => {
    if (selected === null || !image_energies[selected]) return []
    return image_energies[selected]
  })

  const prev_iteration = $derived.by(() => {
    if (selected === null) return null
    const idx = iterations.indexOf(selected)
    return idx > 0 ? iterations[idx - 1] : null
  })

  const prev_images = $derived.by(() => {
    if (prev_iteration === null || !image_energies[prev_iteration]) return null
    return image_energies[prev_iteration]
  })

  const reactant_energy = $derived(images.length > 0 ? images[0][1] : 0)
</script>

<div class="neb-table-container">
  <div class="neb-table-controls">
    {#if latest_iteration !== null}
      <label class="neb-table-label">{t(`workflow.iteration`)}</label>
      <select class="neb-table-select" bind:value={selected}>
        <option value={null}>{t(`workflow.latest_iteration`, { n: latest_iteration })}</option>
        {#each iterations as iter}
          <option value={iter}>{iter}</option>
        {/each}
      </select>
    {/if}
  </div>

  {#if images.length > 0}
    <div class="neb-table-wrap">
      <table class="neb-tbl">
        <thead>
          <tr>
            <th>Img</th>
            <th>E (Eh)</th>
            <th>ΔE (kcal/mol)</th>
            {#if prev_images}<th>{t(`workflow.delta_e_vs_prev_iter`)}</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each images as [idx, energy_eh], i (idx)}
            {@const delta_e = (energy_eh - reactant_energy) * 627.51}
            {@const prev_e = prev_images && prev_images[i] ? prev_images[i][1] : null}
            {@const iter_delta = prev_e !== null ? (energy_eh - prev_e) * 627.51 : null}
            <tr>
              <td class="center">{idx}</td>
              <td class="mono right">{energy_eh.toFixed(6)}</td>
              <td class="mono right" class:positive={delta_e > 0.5}>{delta_e > 0 ? '+' : ''}{delta_e.toFixed(2)}</td>
              {#if prev_images}
                <td class="mono right" class:positive={iter_delta !== null && iter_delta > 0.01} class:negative={iter_delta !== null && iter_delta < -0.01}>
                  {#if iter_delta !== null}{iter_delta > 0 ? '+' : ''}{iter_delta.toFixed(3)}{:else}—{/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="neb-table-empty">{t(`workflow.no_data_selected_iteration`)}</div>
  {/if}
</div>

<style>
  .neb-table-container {
    width: 100%;
  }

  .neb-table-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  .neb-table-label {
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .neb-table-select {
    padding: 2px 6px;
    border: 1px solid #334155;
    border-radius: 3px;
    background: #1e293b;
    color: #e2e8f0;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .neb-table-select:focus {
    outline: none;
    border-color: #3b82f6;
  }

  .neb-table-wrap {
    overflow-x: auto;
    border: 1px solid #334155;
    border-radius: 4px;
  }

  .neb-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .neb-tbl th {
    background: #1e293b;
    padding: 4px 6px;
    text-align: left;
    border-bottom: 1px solid #334155;
    font-weight: 600;
    color: #94a3b8;
    white-space: nowrap;
  }

  .neb-tbl td {
    padding: 3px 6px;
    border-bottom: 1px solid rgba(51, 65, 85, 0.5);
    color: #cbd5e1;
  }

  .neb-tbl tbody tr:hover {
    background: rgba(59, 130, 246, 0.08);
  }

  .center { text-align: center; }
  .right { text-align: right; }
  .mono { font-family: 'Courier New', monospace; }
  .positive { color: #f59e0b; }
  .negative { color: #22d3ee; }

  .neb-table-empty {
    text-align: center;
    padding: 16px;
    color: #64748b;
    font-size: 0.8rem;
  }
</style>
