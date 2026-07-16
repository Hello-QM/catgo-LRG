<script lang="ts">
  import { createThrelteContext } from '@threlte/core'
  import type { Scene, WebGLRenderer } from 'three'
  import AtomManagerInstances from '$lib/structure/atoms/AtomManagerInstances.svelte'
  import type { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
  import BondManagerInstances from '$lib/structure/bonding/BondManagerInstances.svelte'
  import type { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
  import type { RenderPacket } from '$lib/structure/scene/render-packet'

  interface Props {
    mode: 'atom' | 'bond'
    packets: RenderPacket[]
    atom_manager: AtomManager
    bond_manager: BondManager
    renderer: WebGLRenderer
    dom: HTMLElement
    canvas: HTMLCanvasElement
    onscene: (scene: Scene) => void
  }

  let {
    mode,
    packets,
    atom_manager,
    bond_manager,
    renderer,
    dom,
    canvas,
    onscene,
  }: Props = $props()

  const threlte = createThrelteContext({
    dom,
    canvas,
    createRenderer: () => renderer,
    autoRender: false,
    renderMode: 'manual',
  })
  onscene(threlte.scene)

  let packet_idx = $state(0)
  let ghost_opacity = $state(0.2)
  let stub_scale = $state(0.25)
  let bond_opacity = $state(0.8)
  let appearance_alt = $state(false)

  const packet = $derived(packets[packet_idx])
  const live_ghost_opacity = $derived(appearance_alt ? 0.65 : ghost_opacity)
  const live_stub_scale = $derived(appearance_alt ? 0.75 : stub_scale)
  const live_bond_opacity = $derived(appearance_alt ? 0.4 : bond_opacity)
</script>

<button data-testid="factor-1" onclick={() => packet_idx = 0}>1x</button>
<button data-testid="factor-2" onclick={() => packet_idx = 1}>2x</button>
<button data-testid="factor-8" onclick={() => packet_idx = 2}>8x</button>
<button data-testid="appearance" onclick={() => appearance_alt = true}>appearance</button>

{#if mode === 'atom'}
  <AtomManagerInstances
    {atom_manager}
    render_packet={packet}
    image_atom_opacity={live_ghost_opacity}
  />
{:else}
  <BondManagerInstances
    {bond_manager}
    atom_positions={packet.frame.positions}
    atom_colors={packet.topology.colors}
    render_packet={packet}
    incomplete_edge_length_scale={live_stub_scale}
    periodic_bond_opacity={live_ghost_opacity}
    opacity={live_bond_opacity}
  />
{/if}
