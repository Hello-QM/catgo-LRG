<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { TrajectoryType } from '$lib/trajectory'
  import type { PathwayTrajectoryMetadata } from '$lib/structure/pathway-types'
  import { pathway_frame_index, decompose_frame_index } from '$lib/structure/pathway-builder'

  load_i18n_module(`structure`)

  let {
    trajectory,
    current_step_idx = 0,
    on_step_change,
  }: {
    trajectory: TrajectoryType
    current_step_idx?: number
    on_step_change?: (idx: number) => void
  } = $props()

  // Extract pathway metadata from trajectory
  let pw_meta = $derived(trajectory?.metadata as unknown as PathwayTrajectoryMetadata | undefined)
  let is_pathway = $derived(pw_meta?.type === `reaction_pathway`)

  let n_surfaces = $derived(pw_meta?.n_surfaces ?? 1)
  let pathways_info = $derived(pw_meta?.pathways ?? [])
  let step_counts = $derived(pathways_info.map((p) => p.n_steps))

  // Current decomposed position
  let coords = $derived.by(() => {
    if (!is_pathway || step_counts.length === 0) {
      return { surface_idx: 0, pathway_idx: 0, step_idx: current_step_idx }
    }
    return decompose_frame_index(current_step_idx, n_surfaces, step_counts)
  })

  let surface_idx = $derived(coords.surface_idx)
  let pathway_idx = $derived(coords.pathway_idx)
  let step_idx = $derived(coords.step_idx)

  let active_pathway = $derived(pathways_info[pathway_idx])
  let n_steps = $derived(active_pathway?.n_steps ?? 1)

  // Frame label
  let frame_label = $derived.by(() => {
    if (!is_pathway || !active_pathway) return ``
    const parts: string[] = []
    if (n_surfaces > 1) parts.push(t(`structure.pathway_surface_n`, { n: surface_idx + 1 }))
    parts.push(active_pathway.name)
    if (active_pathway.step_names?.[step_idx]) {
      parts.push(active_pathway.step_names[step_idx])
    }
    return parts.join(` / `)
  })

  function update_frame(new_surface: number, new_pathway: number, new_step: number) {
    // Clamp step to valid range for the new pathway
    const max_step = (pathways_info[new_pathway]?.n_steps ?? 1) - 1
    const clamped_step = Math.min(new_step, max_step)
    const idx = pathway_frame_index(new_surface, new_pathway, clamped_step, step_counts)
    on_step_change?.(idx)
  }
</script>

{#if is_pathway && pw_meta}
  <div class="pathway-controls">
    <!-- Frame label -->
    <span class="frame-label">{frame_label}</span>

    <div class="controls-row">
      <!-- Surface slider (hidden when n=1) -->
      {#if n_surfaces > 1}
        <label class="control-group">
          <span class="label">{t(`structure.pathway_surface_label`)}</span>
          <input
            type="range"
            min="0"
            max={n_surfaces - 1}
            value={surface_idx}
            oninput={(e) => update_frame(+e.currentTarget.value, pathway_idx, step_idx)}
          />
          <span class="value">{surface_idx + 1}/{n_surfaces}</span>
        </label>
      {/if}

      <!-- Pathway dropdown (hidden when m=1) -->
      {#if pathways_info.length > 1}
        <label class="control-group">
          <span class="label">{t(`structure.pathway_label`)}</span>
          <select
            value={pathway_idx}
            onchange={(e) => update_frame(surface_idx, +e.currentTarget.value, step_idx)}
          >
            {#each pathways_info as pw, idx}
              <option value={idx}>{pw.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      <!-- Step slider (always visible) -->
      <label class="control-group step-control">
        <span class="label">{t(`structure.pathway_step_label`)}</span>
        <input
          type="range"
          min="0"
          max={n_steps - 1}
          value={step_idx}
          oninput={(e) => update_frame(surface_idx, pathway_idx, +e.currentTarget.value)}
        />
        <span class="value">
          {active_pathway?.step_names?.[step_idx] ?? `${step_idx + 1}/${n_steps}`}
        </span>
      </label>
    </div>
  </div>
{/if}

<style>
  .pathway-controls {
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    padding: 0.3em 0.5em;
    font-size: 0.85em;
    width: 100%;
  }

  .frame-label {
    font-weight: 600;
    font-size: 0.9em;
    color: var(--text-color, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .controls-row {
    display: flex;
    gap: 0.8em;
    align-items: center;
    flex-wrap: wrap;
  }

  .control-group {
    display: flex;
    align-items: center;
    gap: 0.3em;
    min-width: 0;
  }

  .control-group.step-control {
    flex: 1;
    min-width: 8em;
  }

  .label {
    font-size: 0.8em;
    color: #888;
    white-space: nowrap;
  }

  .value {
    font-size: 0.8em;
    color: #666;
    white-space: nowrap;
    min-width: 3em;
    text-align: right;
  }

  input[type='range'] {
    flex: 1;
    min-width: 4em;
    height: 4px;
    cursor: pointer;
  }

  select {
    padding: 0.15em 0.3em;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px;
    font-size: 0.9em;
    background: var(--bg-color, white);
    cursor: pointer;
  }
</style>
