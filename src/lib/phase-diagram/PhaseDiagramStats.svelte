<script lang="ts">
  import { format_num, Histogram, Icon, type InfoItem } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import { SvelteSet } from 'svelte/reactivity'
  import type { PhaseStats, PlotEntry3D } from './types'

  load_i18n_module('structure')

  let { phase_stats, stable_entries, unstable_entries, ...rest }:
    & HTMLAttributes<HTMLDivElement>
    & {
      phase_stats: PhaseStats | null
      stable_entries: PlotEntry3D[]
      unstable_entries: PlotEntry3D[]
    } = $props()

  let copied_items = new SvelteSet<string>()

  async function copy_to_clipboard(label: string, value: string, key: string) {
    try {
      await navigator.clipboard.writeText(`${label}: ${value}`)
      copied_items.add(key)
      setTimeout(() => copied_items.delete(key), 1000)
    } catch (error) {
      console.error(`Failed to copy to clipboard:`, error)
    }
  }

  // Prepare histogram data for formation energies and hull distances
  let e_form_data = $derived.by(() => {
    const all_entries = [...stable_entries, ...unstable_entries]
    const energies = all_entries
      .map((entry) => entry.e_form_per_atom ?? entry.energy_per_atom)
      .filter((val): val is number => val !== undefined && isFinite(val))
    return [{
      x: [],
      y: energies,
      label: t('structure.phase_formation_energy'),
      line_style: { stroke: `steelblue` },
    }]
  })

  let hull_distance_data = $derived.by(() => {
    const all_entries = [...stable_entries, ...unstable_entries]
    const distances = all_entries
      .map((entry) => entry.e_above_hull)
      .filter((val): val is number => val !== undefined && isFinite(val))
    return [{
      x: [],
      y: distances,
      label: t('structure.phase_e_above_hull'),
      line_style: { stroke: `coral` },
    }]
  })

  let pane_data = $derived.by(() => {
    if (!phase_stats) return []
    const sections: { key: string; title: string; items: InfoItem[] }[] = []

    // Determine system dimensionality from chemical_system string (count elements)
    const num_elements = phase_stats.chemical_system.split(`-`).length
    const max_arity = Math.max(
      num_elements,
      phase_stats.quaternary > 0
        ? 4
        : phase_stats.ternary > 0
        ? 3
        : phase_stats.binary > 0
        ? 2
        : 1,
    )

    const phase_items: InfoItem[] = [
      {
        label: t('structure.phase_total_entries_system', { system: phase_stats.chemical_system }),
        value: format_num(phase_stats.total),
        key: `total-entries`,
      },
    ]

    // Only show phase types that exist or are within expected dimensionality
    if (phase_stats.unary > 0 || max_arity >= 1) {
      phase_items.push({
        label: t('structure.phase_unary_phases'),
        value: `${format_num(phase_stats.unary)} (${
          format_num(phase_stats.unary / phase_stats.total, `.2~%`)
        })`,
        key: `unary-phases`,
      })
    }
    if (phase_stats.binary > 0 || max_arity >= 2) {
      phase_items.push({
        label: t('structure.phase_binary_phases'),
        value: `${format_num(phase_stats.binary)} (${
          format_num(phase_stats.binary / phase_stats.total, `.2~%`)
        })`,
        key: `binary-phases`,
      })
    }
    if (phase_stats.ternary > 0 || max_arity >= 3) {
      phase_items.push({
        label: t('structure.phase_ternary_phases'),
        value: `${format_num(phase_stats.ternary)} (${
          format_num(phase_stats.ternary / phase_stats.total, `.2~%`)
        })`,
        key: `ternary-phases`,
      })
    }
    if (phase_stats.quaternary > 0 || max_arity >= 4) {
      phase_items.push({
        label: t('structure.phase_quaternary_phases'),
        value: `${format_num(phase_stats.quaternary)} (${
          format_num(phase_stats.quaternary / phase_stats.total, `.2~%`)
        })`,
        key: `quaternary-phases`,
      })
    }

    sections.push({
      key: `summary`,
      title: ``,
      items: phase_items,
    })

    // Stability
    sections.push({
      key: `stability`,
      title: t('structure.phase_stability'),
      items: [
        {
          label: t('structure.phase_stable_phases'),
          value: `${format_num(phase_stats.stable)} (${
            format_num(phase_stats.stable / phase_stats.total, `.2~%`)
          })`,
          key: `stable-phases`,
        },
        {
          label: t('structure.phase_unstable_phases'),
          value: `${format_num(phase_stats.unstable)} (${
            format_num(phase_stats.unstable / phase_stats.total, `.2~%`)
          })`,
          key: `unstable-phases`,
        },
      ],
    })

    // Energy Statistics
    sections.push({
      key: `energy-statistics`,
      title: t('structure.phase_energy_statistics_ev_atom'),
      items: [
        {
          label: t('structure.phase_min_formation_energy'),
          value: format_num(phase_stats.energy_range.min, `.3f`),
          key: `min-formation-energy`,
        },
        {
          label: t('structure.phase_max_formation_energy'),
          value: format_num(phase_stats.energy_range.max, `.3f`),
          key: `max-formation-energy`,
        },
        {
          label: t('structure.phase_avg_formation_energy'),
          value: format_num(phase_stats.energy_range.avg, `.3f`),
          key: `avg-formation-energy`,
        },
      ],
    })

    // Hull Distance
    sections.push({
      key: `hull-distance`,
      title: t('structure.phase_hull_distance_ev_atom'),
      items: [
        {
          label: t('structure.phase_max_above_hull'),
          value: format_num(phase_stats.hull_distance.max, `.3f`),
          key: `max-hull-distance`,
        },
        {
          label: t('structure.phase_avg_above_hull'),
          value: format_num(phase_stats.hull_distance.avg, `.3f`),
          key: `avg-hull-distance`,
        },
      ],
    })

    return sections
  })
</script>

<div {...rest} class="phase-diagram-stats {rest.class ?? ``}">
  <h4 style="margin-top: 0">{t('structure.phase_diagram_stats')}</h4>
  {#each pane_data as section, sec_idx (section.key)}
    {#if sec_idx > 0}<hr />{/if}
    <section>
      {#if section.title}
        <h5>{section.title}</h5>
      {/if}
      {#each section.items as item (item.key ?? item.label)}
        {@const { key, label, value } = item}
        <div
          class="clickable stat-item"
          data-testid={key ? `pd-${key}` : undefined}
          title={t('structure.click_to_copy_value', { label, value })}
          onclick={() => copy_to_clipboard(item.label, String(item.value), key ?? item.label)}
          role="button"
          tabindex="0"
          onkeydown={(event) => {
            if ([`Enter`, ` `].includes(event.key)) {
              event.preventDefault()
              copy_to_clipboard(item.label, String(item.value), key ?? item.label)
            }
          }}
        >
          <span>{label}:</span>
          <span>{@html value}</span>
          {#if key && copied_items.has(key)}
            <Icon
              icon="Check"
              style="color: var(--success-color, #10b981); width: 12px; height: 12px"
              class="copy-checkmark"
            />
          {/if}
        </div>
      {/each}

      {#if section.key === `energy-statistics` &&
        e_form_data[0].y.length > 0}
        <Histogram
          series={e_form_data}
          bins={50}
          x_axis={{ label: ``, format: `.2f` }}
          y_axis={{ label: ``, ticks: 3 }}
          show_legend={false}
          show_controls={false}
          padding={{ t: 5, b: 25, l: 35, r: 5 }}
          style="height: 100px; --histogram-min-height: 100px"
          bar={{ color: `steelblue`, opacity: 0.7 }}
        />
      {/if}

      {#if section.key === `hull-distance` &&
        hull_distance_data[0].y.length > 0}
        <Histogram
          series={hull_distance_data}
          bins={50}
          x_axis={{ label: ``, format: `.2f`, range: [0, null] }}
          y_axis={{ label: ``, ticks: 3 }}
          show_legend={false}
          show_controls={false}
          padding={{ t: 5, b: 25, l: 35, r: 5 }}
          style="height: 100px; --histogram-min-height: 100px"
          bar={{ color: `coral`, opacity: 0.7 }}
        />
      {/if}
    </section>
  {/each}
</div>

<style>
  .phase-diagram-stats {
    background: var(--surface-bg, white);
    border-radius: 4px;
    padding: 0 1em 1em;
  }
  section div {
    display: flex;
    justify-content: space-between;
    gap: 6pt;
    padding: 1pt;
    line-height: 1.5;
  }
  section div.clickable {
    cursor: pointer;
    position: relative;
    padding: 0 3pt;
  }
  section div:hover {
    background: var(--pane-bg-hover);
    border-radius: 3pt;
  }
  section :global(.copy-checkmark) {
    position: absolute;
    top: 50%;
    right: 3pt;
    transform: translateY(-50%);
    background: var(--pane-bg);
    border-radius: 50%;
    animation: fade-in 0.1s ease-out;
  }
  @keyframes fade-in {
    0% {
      opacity: 0;
    }
  }
  .stat-item span:first-child {
    color: var(--text-color-muted, #666);
  }
  section h5 {
    margin: 0 0 6px 0;
  }
</style>
