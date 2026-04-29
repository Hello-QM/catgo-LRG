<script lang="ts">
  import { DraggablePane } from '$lib'
  import type { Snippet } from 'svelte'

  export type BuildTab = 'lattice' | 'slab_cutter' | 'adsorption' | 'adsorbate' | 'water_layer' | 'pseudo_h' | 'moire' | 'nanotube' | 'heterostructure' | 'doping' | 'pathway'

  const tab_defs: { id: BuildTab; label: string }[] = [
    { id: 'lattice', label: 'Lattice' },
    { id: 'slab_cutter', label: 'Slab' },
    { id: 'adsorption', label: 'Sites' },
    { id: 'adsorbate', label: 'Adsorbate' },
    { id: 'water_layer', label: 'Water' },
    { id: 'pseudo_h', label: 'Passivate' },
    { id: 'moire', label: 'Moiré' },
    { id: 'nanotube', label: 'Nanotube' },
    { id: 'heterostructure', label: 'Hetero' },
    { id: 'doping', label: 'Doping' },
    { id: 'pathway', label: 'Pathway' },
  ]

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
  <h4 class="pane-title">Build Tools</h4>
  <div class="tab-bar">
    {#each tab_defs as tab}
      <button
        class:active={active_tab === tab.id}
        class:disabled={disabled_ids.has(tab.id)}
        disabled={disabled_ids.has(tab.id)}
        onclick={() => active_tab = tab.id}
        title={disabled_ids.has(tab.id) ? disabled_reason[tab.id] : tab.label}
      >
        {tab.label}
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
