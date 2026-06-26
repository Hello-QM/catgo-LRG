<script lang="ts">
  import { DraggablePane } from '$lib'
  import { STATIC_ONLY } from '$lib/api/config'
  import type { Snippet } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  export type BuildTab = 'lattice' | 'slab_cutter' | 'adsorption' | 'adsorbate' | 'water_layer' | 'pseudo_h' | 'moire' | 'nanotube' | 'nanoparticle' | 'nanoscroll' | 'heterostructure' | 'doping' | 'pathway' | 'reticular'

  // Build tabs that have NO client-side (WASM/TS) path and only work via the
  // Python backend. On STATIC_ONLY (web + the iOS build) they'd 503, so they are
  // hidden entirely rather than shown-then-broken (App Store completeness). Every
  // other build tab runs offline; doping (combinatorial/random substitution) is
  // the lone backend-only one.
  const STATIC_HIDDEN_TABS: ReadonlySet<BuildTab> = new Set<BuildTab>(['doping'])

  const all_tab_defs: { id: BuildTab; label: () => string }[] = [
    { id: 'lattice', label: () => t('structure.lattice_tab') },
    { id: 'slab_cutter', label: () => t('structure.slab') },
    { id: 'adsorption', label: () => t('structure.sites') },
    { id: 'adsorbate', label: () => t('structure.adsorbate') },
    { id: 'water_layer', label: () => t('structure.water') },
    { id: 'pseudo_h', label: () => t('structure.passivate') },
    { id: 'moire', label: () => t('structure.moire') },
    { id: 'nanotube', label: () => t('structure.nanotube') },
    { id: 'nanoparticle', label: () => t('structure.nanoparticle') },
    { id: 'nanoscroll', label: () => t('structure.nanoscroll') },
    { id: 'heterostructure', label: () => t('structure.hetero') },
    { id: 'doping', label: () => t('structure.doping') },
    { id: 'pathway', label: () => t('structure.pathway') },
    { id: 'reticular', label: () => t('structure.reticular') },
  ]

  const tab_defs = STATIC_ONLY
    ? all_tab_defs.filter((tab) => !STATIC_HIDDEN_TABS.has(tab.id))
    : all_tab_defs

  let {
    show = $bindable(false),
    active_tab = $bindable<BuildTab>('lattice'),
    max_height = '',
    disabled_tabs = [],
    children,
  }: {
    show?: boolean
    active_tab?: BuildTab
    max_height?: string
    disabled_tabs?: { id: BuildTab; reason: string }[]
    children?: Snippet
  } = $props()

  const disabled_ids = $derived(new Set(disabled_tabs.map((t) => t.id)))
  const disabled_reason = $derived(Object.fromEntries(disabled_tabs.map((t) => [t.id, t.reason])))
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="none"
  max_height={max_height || ``}
  pane_props={{ class: 'build-pane' }}
>
  <h4 class="pane-title">{t('structure.build_tools')}</h4>
  <div class="tab-bar">
    {#each tab_defs as tab}
      <button
        class:active={active_tab === tab.id}
        class:disabled={disabled_ids.has(tab.id)}
        disabled={disabled_ids.has(tab.id)}
        onclick={() => active_tab = tab.id}
        title={disabled_ids.has(tab.id) ? disabled_reason[tab.id] : tab.label()}
      >
        {tab.label()}
      </button>
    {/each}
  </div>
  <div class="pane-content">
    {#if children}
      {@render children()}
    {/if}
  </div>
</DraggablePane>

<style>
  .tab-bar {
    grid-template-columns: repeat(6, 1fr);
  }
</style>
