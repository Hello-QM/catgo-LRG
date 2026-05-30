<script lang="ts">
  import type { AdsorptionSite } from './ferrox-wasm-types'
  import { T } from '@threlte/core'
  import { CanvasTooltip } from './index'

  let {
    adsorption_sites = [],
    show_adsorption_sites = true,
    selected_adsorption_site_idx = $bindable(null),
    on_adsorption_site_click,
    on_delete_adsorption_site,
    camera_is_moving = false,
    external_dragging = false,
    is_rotating_atoms = false,
    is_box_selecting = false,
    on_hover_change,
  }: {
    adsorption_sites?: AdsorptionSite[]
    show_adsorption_sites?: boolean
    selected_adsorption_site_idx?: number | null
    on_adsorption_site_click?: (idx: number) => void
    on_delete_adsorption_site?: (site_id: number) => void
    camera_is_moving?: boolean
    external_dragging?: boolean
    is_rotating_atoms?: boolean
    is_box_selecting?: boolean
    on_hover_change?: (hovered: boolean) => void
  } = $props()

  // Adsorption site hover state (isolated from parent reactive scope)
  let hovered_adsorption_site_idx = $state<number | null>(null)
  let hovered_adsorption_site = $derived(
    hovered_adsorption_site_idx !== null ? adsorption_sites[hovered_adsorption_site_idx] : null
  )

  function adsorption_site_hover_enter(idx: number) {
    if (external_dragging || is_rotating_atoms || is_box_selecting) return
    hovered_adsorption_site_idx = idx
    on_hover_change?.(true)
  }
  function adsorption_site_hover_leave() {
    if (external_dragging || is_rotating_atoms || is_box_selecting) return
    hovered_adsorption_site_idx = null
    on_hover_change?.(false)
  }

  // Handle Delete/Backspace key for adsorption sites
  function handle_adsorption_site_delete(event: KeyboardEvent) {
    // Ignore if user is typing in an input field or an embedded editor.
    // Monaco (EditContext) focuses a <div>, not a <textarea>, so a tagName-only
    // check would let Delete/Backspace in the editor delete an adsorption site.
    const target = event.target as HTMLElement
    if (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target?.closest?.('.monaco-editor, .native-edit-context, [contenteditable=""], [contenteditable="true"]')
    ) return

    // Check for Delete or Backspace key
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Delete selected adsorption site
      if (selected_adsorption_site_idx !== null && on_delete_adsorption_site) {
        const site = adsorption_sites[selected_adsorption_site_idx]
        if (site) {
          event.preventDefault()
          on_delete_adsorption_site(site.id)
          selected_adsorption_site_idx = null
        }
      }
    }
  }

  // Add keyboard listener for adsorption site deletion
  $effect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('keydown', handle_adsorption_site_delete)
    return () => {
      window.removeEventListener('keydown', handle_adsorption_site_delete)
    }
  })
</script>

<!-- Adsorption site markers -->
{#if show_adsorption_sites && adsorption_sites.length > 0}
  {#each adsorption_sites as site, idx (idx)}
    {@const is_selected = selected_adsorption_site_idx === idx}
    {@const is_hovered = hovered_adsorption_site_idx === idx}
    {@const site_color = site.site_type === `top` ? `#00ff00` : site.site_type === `bridge` ? `#0088ff` : `#ff8800`}
    {@const radius = is_selected ? 0.5 : is_hovered ? 0.45 : 0.35}
    <!-- Simple solid sphere for adsorption site -->
    <T.Mesh
      position={[site.position[0], site.position[1], site.position[2]]}
      onpointerenter={() => adsorption_site_hover_enter(idx)}
      onpointerleave={() => adsorption_site_hover_leave()}
      onclick={() => {
        if (on_adsorption_site_click) {
          on_adsorption_site_click(idx)
        } else {
          selected_adsorption_site_idx = selected_adsorption_site_idx === idx ? null : idx
        }
      }}
    >
      <T.SphereGeometry args={[radius, 16, 16]} />
      <T.MeshBasicMaterial color={site_color} transparent opacity={0.6} depthWrite={false} />
    </T.Mesh>
  {/each}
{/if}

<!-- Adsorption site tooltip -->
{#if hovered_adsorption_site && !camera_is_moving}
  {@const site = hovered_adsorption_site}
  <CanvasTooltip position={[site.position[0], site.position[1], site.position[2]]}>
    <div class="adsorption-site-tooltip">
      <strong style="color: {site.site_type === 'top' ? '#00ff00' : site.site_type === 'bridge' ? '#0088ff' : '#ff8800'}">
        #{site.id} {site.site_type.toUpperCase()}
      </strong>
      <div>Environment: {site.env_signature}</div>
      <div>Height: {site.height.toFixed(2)} Å</div>
      <div>Neighbors: {site.neighbor_elements.join(`, `)}</div>
      <div style="font-size: 0.85em; opacity: 0.8">
        Position: ({site.position.map(v => v.toFixed(2)).join(`, `)})
      </div>
    </div>
  </CanvasTooltip>
{/if}

