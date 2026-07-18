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
    /** Start with render_packet=null (legacy static path) — atom mode only. */
    start_null?: boolean
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
    start_null = false,
  }: Props = $props()

  const threlte = createThrelteContext({
    dom,
    canvas,
    createRenderer: () => renderer,
    autoRender: false,
    renderMode: 'manual',
  })
  onscene(threlte.scene)

  let packet_idx = $state(start_null ? -1 : 0)
  let ghost_opacity = $state(0.2)
  let stub_scale = $state(0.25)
  let bond_opacity = $state(0.8)
  let appearance_alt = $state(false)
  // #533 — Appearance → Material must reach the packet-path impostor material.
  let render_style = $state<'glossy' | 'toon' | 'metallic'>('glossy')

  // -1 = no packet: AtomManagerInstances falls back to the legacy
  // InstancedMesh path, mirroring a static structure at 1×1×1.
  const packet = $derived(packet_idx < 0 ? null : packets[packet_idx])
  const live_ghost_opacity = $derived(appearance_alt ? 0.65 : ghost_opacity)
  const live_stub_scale = $derived(appearance_alt ? 0.75 : stub_scale)
  const live_bond_opacity = $derived(appearance_alt ? 0.4 : bond_opacity)
</script>

<button data-testid="factor-null" onclick={() => packet_idx = -1}>none</button>
<button data-testid="factor-1" onclick={() => packet_idx = 0}>1x</button>
<button data-testid="factor-2" onclick={() => packet_idx = 1}>2x</button>
<button data-testid="factor-8" onclick={() => packet_idx = 2}>8x</button>
<button data-testid="appearance" onclick={() => appearance_alt = true}>appearance</button>
<button data-testid="style-toon" onclick={() => render_style = 'toon'}>toon</button>
<button data-testid="style-metallic" onclick={() => render_style = 'metallic'}>metallic</button>

{#if mode === 'atom'}
  <AtomManagerInstances
    {atom_manager}
    render_packet={packet}
    {render_style}
    image_atom_opacity={live_ghost_opacity}
    max_capacity={16}
  />
{:else}
  <BondManagerInstances
    {bond_manager}
    atom_positions={(packet ?? packets[0]).frame.positions}
    atom_colors={(packet ?? packets[0]).topology.colors}
    render_packet={packet}
    incomplete_edge_length_scale={live_stub_scale}
    periodic_bond_opacity={live_ghost_opacity}
    opacity={live_bond_opacity}
  />
{/if}
