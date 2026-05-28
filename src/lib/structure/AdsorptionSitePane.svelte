<script lang="ts">
  import type { Crystal } from '$lib/structure'
  import { DraggablePane } from '$lib'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import type { ComponentProps } from 'svelte'
  import type {
    AdsorptionSite,
    AdsorptionSiteFinderParams,
    AdsorptionSiteResult,
  } from './ferrox-wasm-types'
  import { wasm_find_adsorption_sites } from './ferrox-wasm'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    adsorption_sites = $bindable<AdsorptionSite[]>([]),
    show_sites = $bindable(true),
    selected_site_idx = $bindable<number | null>(null),
    // Alpha Shape V7 parameters
    alpha = $bindable(2.7),
    height = $bindable(1.5),
    gap_ratio = $bindable(1.2),
    blocking = $bindable(0.8),
    merge = $bindable(1.0),
    keep_bottom = $bindable(false),
    bottom_fraction = $bindable(0.5),
    expansion_distance = $bindable(3.0),
    filter_internal = $bindable(true),
    filter_radius = $bindable(5.0),
    filter_threshold = $bindable(0.7),
    // Pane props
    pane_props = {},
    toggle_props = {},
    on_sites_found,
    delete_site_ref = $bindable(),
    embedded = false,
  }: {
    structure?: Crystal
    pane_open?: boolean
    adsorption_sites?: AdsorptionSite[]
    show_sites?: boolean
    selected_site_idx?: number | null
    alpha?: number
    height?: number
    gap_ratio?: number
    blocking?: number
    merge?: number
    keep_bottom?: boolean
    bottom_fraction?: number
    expansion_distance?: number
    filter_internal?: boolean
    filter_radius?: number
    filter_threshold?: number
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    on_sites_found?: (result: AdsorptionSiteResult) => void
    delete_site_ref?: (site_id: number) => void
    embedded?: boolean
  } = $props()

  // Expose delete function to parent
  $effect(() => {
    delete_site_ref = delete_site
  })

  let is_computing = $state(false)
  let error_message = $state<string | null>(null)
  let result_summary = $state<{ n_top: number; n_bridge: number; n_hollow3: number; n_hollow4: number } | null>(null)
  let show_advanced = $state(false)

  // Internal storage for all sites (unfiltered)
  let all_sites = $state<AdsorptionSite[]>([])

  // Filter states
  let show_top = $state(true)
  let show_bridge = $state(true)
  let show_hollow3 = $state(true)
  let show_hollow4 = $state(true)
  let deduplicate = $state(false)

  // Filtered sites based on type selection + optional deduplication
  let filtered_sites = $derived.by(() => {
    let sites = all_sites.filter((site) => {
      if (site.site_type === `top` && !show_top) return false
      if (site.site_type === `bridge` && !show_bridge) return false
      if (site.site_type === `hollow3` && !show_hollow3) return false
      if (site.site_type === `hollow4` && !show_hollow4) return false
      return true
    })
    if (deduplicate) {
      const seen = new Set<string>()
      sites = sites.filter((site) => {
        const key = `${site.site_type}:${site.env_signature}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    return sites
  })

  // Sync filtered sites to the bindable prop (for 3D rendering)
  $effect(() => {
    adsorption_sites = filtered_sites
  })

  async function find_sites() {
    if (!structure) {
      error_message = t('structure.ads_site_no_structure_loaded')
      return
    }

    is_computing = true
    error_message = null

    try {
      const params: AdsorptionSiteFinderParams = {
        alpha,
        height,
        gap_ratio,
        blocking,
        merge,
        keep_bottom,
        bottom_fraction,
        expansion_distance,
        filter_internal,
        filter_radius,
        filter_threshold,
      }

      const result: AdsorptionSiteResult = await wasm_find_adsorption_sites(structure, params)

      all_sites = result.sites
      result_summary = {
        n_top: result.n_top,
        n_bridge: result.n_bridge,
        n_hollow3: result.n_hollow3,
        n_hollow4: result.n_hollow4,
      }
      on_sites_found?.(result)
    } catch (err) {
      error_message = err instanceof Error ? err.message : String(err)
      all_sites = []
      result_summary = null
    } finally {
      is_computing = false
    }
  }

  function clear_sites() {
    all_sites = []
    result_summary = null
    selected_site_idx = null
    error_message = null
  }

  function select_site(idx: number) {
    selected_site_idx = selected_site_idx === idx ? null : idx
  }

  function delete_site(site_id: number) {
    all_sites = all_sites.filter((s) => s.id !== site_id)
    // Update result summary counts
    if (result_summary) {
      result_summary = {
        n_top: all_sites.filter((s) => s.site_type === `top`).length,
        n_bridge: all_sites.filter((s) => s.site_type === `bridge`).length,
        n_hollow3: all_sites.filter((s) => s.site_type === `hollow3`).length,
        n_hollow4: all_sites.filter((s) => s.site_type === `hollow4`).length,
      }
    }
    selected_site_idx = null
  }

  // Site type colors for display
  const site_colors: Record<string, string> = {
    top: `#4CAF50`,
    bridge: `#2196F3`,
    hollow3: `#FF9800`,
    hollow4: `#9C27B0`,
  }

  function site_type_label(site_type: string): string {
    switch (site_type) {
      case `top`: return t('structure.ads_site_top')
      case `bridge`: return t('structure.ads_site_bridge')
      case `hollow3`: return t('structure.ads_site_hollow3')
      case `hollow4`: return t('structure.ads_site_hollow4')
      default: return site_type
    }
  }
</script>

{#snippet pane_content()}
  <h4>{t('structure.ads_site_finder')}</h4>

  <div class="controls">
    <button
      type="button"
      onclick={find_sites}
      disabled={is_computing || !structure}
      class="primary"
    >
      {is_computing ? t('structure.computing') : t('structure.ads_site_find_sites')}
    </button>

    <button
      type="button"
      onclick={clear_sites}
      disabled={all_sites.length === 0}
    >
      {t('common.clear')}
    </button>

    <label class="checkbox">
      <input type="checkbox" bind:checked={show_sites} />
      {t('structure.ads_site_show')}
    </label>
  </div>

  {#if error_message}
    <div class="error">{error_message}</div>
  {/if}

  <!-- Key parameters (Alpha Shape V7) -->
  <div class="key-params">
    <label>
      <span>{t('structure.ads_site_alpha_a')}</span>
      <input type="number" bind:value={alpha} min={0.5} max={10} step={0.1} />
    </label>
    <label>
      <span>{t('structure.ads_site_height_a')}</span>
      <input type="number" bind:value={height} min={0.5} max={5} step={0.1} />
    </label>
    <label>
      <span>{t('structure.ads_site_merge_a')}</span>
      <input type="number" bind:value={merge} min={0} max={3} step={0.1} />
    </label>
  </div>

  {#if result_summary}
    <div class="summary">
      <span class="site-badge top">{t('structure.ads_site_type_count', { n: result_summary.n_top, type: t('structure.ads_site_top') })}</span>
      <span class="site-badge bridge">{t('structure.ads_site_type_count', { n: result_summary.n_bridge, type: t('structure.ads_site_bridge') })}</span>
      <span class="site-badge hollow3">{t('structure.ads_site_type_count', { n: result_summary.n_hollow3, type: t('structure.ads_site_hollow3') })}</span>
      <span class="site-badge hollow4">{t('structure.ads_site_type_count', { n: result_summary.n_hollow4, type: t('structure.ads_site_hollow4') })}</span>
    </div>

    <div class="filters">
      <label class="filter-checkbox">
        <input type="checkbox" bind:checked={show_top} />
        <span class="dot" style:background={site_colors.top}></span>
        {t('structure.ads_site_filter_count', { type: t('structure.ads_site_top'), n: result_summary.n_top })}
      </label>
      <label class="filter-checkbox">
        <input type="checkbox" bind:checked={show_bridge} />
        <span class="dot" style:background={site_colors.bridge}></span>
        {t('structure.ads_site_filter_count', { type: t('structure.ads_site_bridge'), n: result_summary.n_bridge })}
      </label>
      <label class="filter-checkbox">
        <input type="checkbox" bind:checked={show_hollow3} />
        <span class="dot" style:background={site_colors.hollow3}></span>
        {t('structure.ads_site_filter_count', { type: t('structure.ads_site_hollow3'), n: result_summary.n_hollow3 })}
      </label>
      <label class="filter-checkbox">
        <input type="checkbox" bind:checked={show_hollow4} />
        <span class="dot" style:background={site_colors.hollow4}></span>
        {t('structure.ads_site_filter_count', { type: t('structure.ads_site_hollow4'), n: result_summary.n_hollow4 })}
      </label>
      <label class="filter-checkbox">
        <input type="checkbox" bind:checked={deduplicate} />
        {t('structure.ads_site_deduplicate_count', { n: filtered_sites.length })}
      </label>
    </div>
  {/if}

  <details bind:open={show_advanced}>
    <summary>{t('structure.ads_site_advanced_parameters')}</summary>
    <div class="params">
      <label>
        <span>{t('structure.ads_site_gap_ratio')}</span>
        <input type="number" bind:value={gap_ratio} min={1.0} max={2.0} step={0.05} />
      </label>
      <label>
        <span>{t('structure.ads_site_blocking')}</span>
        <input type="number" bind:value={blocking} min={0.1} max={2.0} step={0.1} />
      </label>
      <label>
        <span>{t('structure.ads_site_bottom_fraction')}</span>
        <input type="number" bind:value={bottom_fraction} min={0.1} max={0.9} step={0.05} />
      </label>
      <label>
        <span>{t('structure.ads_site_expansion_a')}</span>
        <input type="number" bind:value={expansion_distance} min={1} max={10} step={0.5} />
      </label>
      <label>
        <span>{t('structure.ads_site_filter_radius_a')}</span>
        <input type="number" bind:value={filter_radius} min={1} max={10} step={0.5} />
      </label>
      <label>
        <span>{t('structure.ads_site_filter_threshold')}</span>
        <input type="number" bind:value={filter_threshold} min={0.1} max={1.0} step={0.05} />
      </label>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={keep_bottom} />
        <span>{t('structure.ads_site_keep_bottom_surface')}</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={filter_internal} />
        <span>{t('structure.ads_site_filter_internal_sites')}</span>
      </label>
    </div>
  </details>

  {#if filtered_sites.length > 0}
    <div class="site-list">
      <h5>{t('structure.ads_site_sites_count', { n: filtered_sites.length })}</h5>
      <div class="sites-scroll">
        {#each filtered_sites as site, idx (site.id)}
          <div class="site-row">
            <button
              type="button"
              class="site-item"
              class:selected={selected_site_idx === idx}
              onclick={() => select_site(idx)}
            >
              <span class="site-id">#{site.id}</span>
              <span class="dot" style:background={site_colors[site.site_type]}></span>
              <span class="type">{site_type_label(site.site_type)}</span>
              <span class="env">{site.env_signature}</span>
            </button>
            <button
              type="button"
              class="delete-btn"
              onclick={() => delete_site(site.id)}
              title={t('structure.ads_site_delete_site')}
            >
              ×
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    open_icon="Cross"
    closed_icon="Target"
    show_toggle={!embedded}
    pane_props={{ ...pane_props, class: `adsorption-site-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{
      title: pane_open ? `` : t('structure.ads_site_find_adsorption_sites'),
      ...toggle_props,
      class: `adsorption-site-toggle ${toggle_props?.class ?? ``}`,
    }}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  .controls {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
  }

  .controls button {
    padding: 4px 8px;
  }

  .controls button.primary {
    background: var(--accent-color, #007acc);
    color: white;
    border: none;
    border-radius: 4px;
  }

  .controls button.primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .error {
    margin: 4px 0;
    padding: 4px 6px;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 4px;
  }

  .key-params {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
    margin-bottom: 8px;
  }

  .key-params label {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .key-params label span {
    opacity: 0.6;
    font-size: 0.85em;
  }

  .key-params input[type='number'] {
    width: 100%;
    padding: 4px;
  }

  .summary {
    display: flex;
    gap: 6px;
    margin: 8px 0;
    flex-wrap: wrap;
  }

  .site-badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 500;
  }

  .site-badge.top {
    background: rgba(76, 175, 80, 0.2);
    color: #66bb6a;
  }

  .site-badge.bridge {
    background: rgba(33, 150, 243, 0.2);
    color: #42a5f5;
  }

  .site-badge.hollow3 {
    background: rgba(255, 152, 0, 0.2);
    color: #ffa726;
  }

  .site-badge.hollow4 {
    background: rgba(156, 39, 176, 0.2);
    color: #ab47bc;
  }

  .filters {
    display: flex;
    gap: 8px;
    margin: 8px 0;
    flex-wrap: wrap;
  }

  .filter-checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 6px;
  }

  .params label {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .params label span {
    opacity: 0.6;
  }

  .params input[type='number'] {
    width: 100%;
    padding: 4px;
  }

  .checkbox-row {
    flex-direction: row !important;
    align-items: center;
    grid-column: span 2;
  }

  .site-list {
    margin-top: 8px;
  }

  .sites-scroll {
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .site-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    flex: 1;
  }

  .site-item:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .site-item.selected {
    border-color: var(--accent-color, #007acc);
    background: rgba(0, 122, 204, 0.15);
  }

  .site-item .type {
    font-weight: 500;
    min-width: 45px;
  }

  .site-item .env {
    opacity: 0.6;
    font-family: monospace;
  }

  .site-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .site-id {
    opacity: 0.5;
    min-width: 24px;
    font-family: monospace;
  }

  .delete-btn {
    padding: 2px 6px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.6;
    line-height: 1;
  }

  .delete-btn:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: #ef4444;
    color: #ef4444;
    opacity: 1;
  }
</style>
