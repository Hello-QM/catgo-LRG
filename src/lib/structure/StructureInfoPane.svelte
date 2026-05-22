<script lang="ts">
  import type { AnyStructure, Site } from '$lib'
  import { DraggablePane, element_data, format_num, Icon, type InfoItem } from '$lib'
  import { electro_neg_formula, get_density } from '$lib/structure'
  import { wyckoff_positions_from_moyo, WyckoffTable } from '$lib/symmetry'
  import type { MoyoDataset } from '@spglib/moyo-wasm'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import { SvelteSet } from 'svelte/reactivity'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  let {
    structure,
    pane_open = $bindable(false),
    atom_count_thresholds = [50, 500],
    toggle_props = {},
    pane_props = {},
    highlighted_sites = $bindable([]),
    selected_sites = $bindable([]),
    symmetry_data = null,
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, `onclose`> & {
    structure: AnyStructure
    pane_open?: boolean
    atom_count_thresholds?: [number, number] // if atom count is less than min_threshold, show sites, if atom count is greater than max_threshold, hide sites. in between, show sites behind a toggle button.
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    highlighted_sites?: number[] // Sites highlighted from Wyckoff table hover
    selected_sites?: number[] // Sites selected from Wyckoff table click
    symmetry_data?: MoyoDataset | null // Symmetry analysis data (bindable for external access)
  } = $props()

  let copied_items = new SvelteSet<string>()
  let sites_expanded = $state(false)

  async function copy_to_clipboard(label: string, value: string, key: string) {
    try {
      await navigator.clipboard.writeText(`${label}: ${value}`)
      copied_items.add(key)
      setTimeout(() => copied_items.delete(key), 1000)
    } catch (error) {
      console.error(`Failed to copy to clipboard:`, error)
    }
  }

  function handle_click(item: InfoItem, section_title: string) {
    if (section_title === `Usage Tips`) return
    if (item.key === `sites-toggle`) sites_expanded = !sites_expanded
    else copy_to_clipboard(item.label, String(item.value), item.key ?? item.label)
  }

  let pane_data = $derived.by(() => {
    if (!structure) return []
    const sections: { title: string; items: InfoItem[] }[] = []
    const [min_threshold, max_threshold] = atom_count_thresholds

    // Structure Info
    const structure_items: InfoItem[] = [
      {
        label: t('structure.formula'),
        value: `${electro_neg_formula(structure)} (${structure.sites.length} ${t('common.sites')})`,
        key: `structure-formula`,
      },
      {
        label: t('structure.charge'),
        value: `${structure.charge || 0}e`,
        key: `structure-charge`,
      },
    ]

    if (`properties` in structure) {
      for (
        const [key, value] of Object.entries(structure.properties ?? {})
      ) {
        if (value != null) {
          structure_items.push({
            label: key.replace(/_/g, ` `).replace(/\b\w/g, (l) => l.toUpperCase()),
            value: String(value),
            key: `structure-prop-${key}`,
          })
        }
      }
    }
    sections.push({ title: t('structure.structure_tab'), items: structure_items })

    // Cell Info
    if (`lattice` in structure && structure.lattice) {
      const { a, b, c, alpha, beta, gamma, volume, matrix } = structure.lattice
      // Calculate volume from matrix if not provided
      let cell_volume = volume
      if ((cell_volume === undefined || cell_volume === null) && matrix) {
        const [va, vb, vc] = matrix
        const cross_bc = [
          vb[1] * vc[2] - vb[2] * vc[1],
          vb[2] * vc[0] - vb[0] * vc[2],
          vb[0] * vc[1] - vb[1] * vc[0]
        ]
        cell_volume = Math.abs(va[0] * cross_bc[0] + va[1] * cross_bc[1] + va[2] * cross_bc[2])
      }
      sections.push({
        title: t('structure.cell'),
        items: [
          {
            label: t('structure.volume_density'),
            value: `${format_num(cell_volume, `.3~s`)} Å³, ${
              format_num(get_density(structure), `.3~f`)
            } g/cm³`,
            key: `cell-volume-density`,
          },
          {
            label: `a, b, c`,
            value: `${format_num(a, `.4~f`)}, ${format_num(b, `.4~f`)}, ${
              format_num(c, `.4~f`)
            } Å`,
            key: `cell-abc`,
          },
          {
            label: `α, β, γ`,
            value: `${format_num(alpha, `.2~f`)}°, ${format_num(beta, `.2~f`)}°, ${
              format_num(gamma, `.2~f`)
            }°`,
            key: `cell-angles`,
          },
        ],
      })
    }

    // Symmetry Info
    if (`lattice` in structure && symmetry_data) {
      const { operations } = symmetry_data
      const is_identity3 = (mat: number[]) => String(mat) === `1,0,0,0,1,0,0,0,1`
      let translations = 0, rotations = 0, roto_translations = 0
      for (const op of operations) {
        const has_translation = op.translation.some((t) => t !== 0)
        const is_identity = is_identity3(op.rotation)
        if (is_identity && has_translation) translations++
        else if (!has_translation) rotations++
        else roto_translations++
      }

      sections.push({
        title: t('structure.symmetry'),
        items: [
          {
            label: t('structure.space_group'),
            value: String(symmetry_data.number),
            key: `symmetry-space-group`,
          },
          {
            label: t('structure.hall_number'),
            value: String(symmetry_data.hall_number),
            key: `symmetry-hall-number`,
          },
          {
            label: t('structure.pearson_symbol'),
            value: symmetry_data.pearson_symbol,
            key: `symmetry-pearson-symbol`,
          },
          {
            label: t('structure.symmetry_ops'),
            value:
              `${operations.length} (${translations} ${t('structure.trans')}, ${rotations} ${t('structure.rot')}, ${roto_translations} ${t('structure.roto_trans')})`,
            key: `symmetry-operations-total`,
          },
        ],
      })
    }

    // Sites Section
    const atom_count = structure.sites.length
    if (atom_count <= max_threshold) {
      const site_items: InfoItem[] = []

      // Merged toggle button with Sites title
      if (atom_count >= min_threshold) {
        const toggle_label = sites_expanded
          ? t('structure.hide_sites')
          : t('structure.show_sites', { n: atom_count })
        site_items.push({
          label: toggle_label,
          value: sites_expanded ? `▲` : `▼`,
          key: `sites-toggle`,
          tooltip: sites_expanded ? t('structure.click_to_hide_sites') : t('structure.click_to_show_sites'),
        })
      }

      if (atom_count < min_threshold || sites_expanded) {
        structure.sites.forEach((site: Site, idx: number) => {
          const element = site.species?.[0]?.element || `Unknown`
          const element_name = element_data.find((el) =>
            el.symbol === element
          )?.name || element

          site_items.push({
            label: `${element}${idx + 1}`,
            value: element_name,
            key: `site-${idx}-header`,
          })

          if (site.abc) {
            site_items.push({
              label: `  ${t('structure.fractional')}`,
              value: `(${site.abc.map((x) => format_num(x, `.4~f`)).join(`, `)})`,
              key: `site-${idx}-fractional`,
            })
          }
          if (site.xyz) {
            site_items.push({
              label: `  ${t('structure.cartesian')}`,
              value: `(${site.xyz.map((x) => format_num(x, `.4~f`)).join(`, `)}) Å`,
              key: `site-${idx}-cartesian`,
            })
          }

          if (site.properties) {
            for (const [prop_key, prop_value] of Object.entries(site.properties)) {
              if (prop_value != null && prop_value !== undefined) {
                let formatted_value: string
                let tooltip: string | undefined

                if (
                  prop_key === `force` && Array.isArray(prop_value) &&
                  prop_value.length === 3 && prop_value.every((v) =>
                    typeof v === `number`
                  )
                ) {
                  const force_magnitude = Math.hypot(...prop_value)
                  formatted_value = `${format_num(force_magnitude, `.3~f`)} eV/Å`
                  tooltip = `Force vector: (${
                    prop_value.map((force) => format_num(force, `.3~f`)).join(`, `)
                  }) eV/Å`
                } else if (prop_key === `magmom` || prop_key.includes(`magnet`)) {
                  const num_val = Number(prop_value)
                  if (isNaN(num_val)) continue
                  formatted_value = `${format_num(num_val, `.3~f`)} μB`
                  tooltip = t('structure.magmom_tooltip')
                } else if (Array.isArray(prop_value)) {
                  formatted_value = `(${
                    prop_value.map((v) => {
                      const num_val = Number(v)
                      return isNaN(num_val) ? String(v) : format_num(num_val, `.3~f`)
                    }).join(`, `)
                  })`
                } else {
                  const num_val = Number(prop_value)
                  formatted_value = isNaN(num_val)
                    ? String(prop_value)
                    : format_num(num_val, `.3~f`)
                }

                site_items.push({
                  label: `  ${prop_key}`,
                  value: formatted_value,
                  key: `site-${idx}-${prop_key}`,
                  tooltip,
                })
              }
            }
          }
        })
      }

      if (site_items.length > 0) {
        sections.push({
          title: atom_count >= min_threshold ? `` : t('structure.sites'),
          items: site_items,
        })
      }
    }

    // Usage Tips
    sections.push({
      title: t('structure.usage_tips'),
      items: [
        { label: t('structure.tip_file_drop'), value: t('structure.tip_file_drop_desc') },
        { label: t('structure.tip_camera'), value: t('structure.tip_camera_desc') },
        { label: t('structure.tip_camera_reset'), value: t('structure.tip_camera_reset_desc') },
        { label: t('structure.tip_selection'), value: t('structure.tip_selection_desc') },
        { label: t('structure.tip_rotate_atoms'), value: t('structure.tip_rotate_atoms_desc') },
        { label: t('structure.tip_move_atoms'), value: t('structure.tip_move_atoms_desc') },
        { label: t('structure.tip_trajectory'), value: t('structure.tip_trajectory_desc') },
        { label: t('structure.tip_undo_redo'), value: t('structure.tip_undo_redo_desc') },
        { label: t('structure.tip_measure'), value: t('structure.tip_measure_desc') },
        { label: t('structure.tip_colors'), value: t('structure.tip_colors_desc') },
        { label: t('structure.tip_keyboard'), value: t('structure.tip_keyboard_desc') },
      ],
    })

    return sections
  })

  // Compute Wyckoff positions from symmetry data
  let wyckoff_positions = $derived(wyckoff_positions_from_moyo(symmetry_data, structure))
</script>

<DraggablePane
  bind:show={pane_open}
  max_width="24em"
  toggle_props={{
    class: `structure-info-toggle`,
    title: t('structure.structure_info'),
    ...toggle_props,
  }}
  open_icon="Cross"
  closed_icon="Info"
  pane_props={{ ...pane_props, class: `structure-info-pane ${pane_props?.class ?? ``}` }}
  {...rest}
>
  <h4 style="margin-top: 0">{t('structure.structure_info')}</h4>
  {#each pane_data as section, sec_idx (section.title)}
    {#if sec_idx > 0}<hr />{/if}
    <section>
      {#if section.title && section.title !== t('structure.structure_tab')}
        <h4>{section.title}</h4>
      {/if}
      {#each section.items as item (item.key ?? item.label)}
        {@const { key, label, value, tooltip } = item}
        {#if section.title === t('structure.usage_tips')}
          <div class="tips-item">
            <span>{label}</span>
            <span>{@html value}</span>
          </div>
        {:else}
          <div
            class:site-item={label.startsWith(`  `)}
            class:toggle-item={key === `sites-toggle`}
            class="clickable"
            title={key === `sites-toggle` ? tooltip : `Click to copy: ${label}: ${value}`}
            onclick={() => handle_click(item, section.title)}
            role="button"
            tabindex="0"
            onkeydown={(event) => {
              if ([`Enter`, ` `].includes(event.key)) {
                event.preventDefault()
                handle_click(item, section.title)
              }
            }}
          >
            <span>{label}</span>
            <span title={tooltip}>{@html value}</span>
            {#if key !== `sites-toggle` && key && copied_items.has(key)}
              <Icon
                icon="Check"
                style="color: var(--success-color, #10b981); width: 12px; height: 12px"
                class="copy-checkmark"
              />
            {/if}
          </div>
        {/if}
      {/each}

      {#if section.title === t('structure.symmetry') && wyckoff_positions.length > 0}
        <WyckoffTable
          {wyckoff_positions}
          on_hover={(site_indices) => highlighted_sites = site_indices ?? []}
          on_click={(site_indices) => selected_sites = site_indices ?? []}
          style="width: 100%; margin-top: 0.5em; font-size: 0.8em"
        />
      {/if}
    </section>
  {/each}

</DraggablePane>

<style>
  section {
    margin-bottom: 0.5em;
  }
  section h4 {
    margin: 0.5em 0 0.3em;
  }
  section div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 2px;
    line-height: 1.4;
  }
  section div.clickable {
    cursor: pointer;
    position: relative;
    border-radius: 4px;
  }
  section div:hover {
    background: rgba(255, 255, 255, 0.05);
  }
  section :global(.copy-checkmark) {
    position: absolute;
    top: 50%;
    right: 3px;
    transform: translateY(-50%);
    background: var(--pane-bg);
    border-radius: 50%;
    padding: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fade-in 0.1s ease-out;
  }
  @keyframes fade-in {
    0% {
      opacity: 0;
    }
  }
  section div.site-item {
    border-left: 2px solid #3b82f6;
    margin-left: 10px;
    padding-left: 6px;
  }
  /* Usage tips: label left, description right */
  section div.tips-item {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 12px;
  }
  section div.tips-item span:first-child {
    flex-shrink: 0;
    min-width: 80px;
    font-weight: 500;
    color: inherit;
  }
  section div.tips-item span:last-child {
    flex: 1;
    opacity: 0.75;
    font-size: 0.85em;
    text-align: right;
  }
  hr {
    margin: 8px 0;
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.15);
  }
</style>
