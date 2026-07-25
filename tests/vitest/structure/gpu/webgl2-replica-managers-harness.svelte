<script lang="ts">
  import { createThrelteContext } from '@threlte/core'
  import { onDestroy, untrack } from 'svelte'
  import type { Scene, WebGLRenderer } from 'three'
  import AtomManagerInstances from '$lib/structure/atoms/AtomManagerInstances.svelte'
  import type { AtomManager } from '$lib/structure/atoms/atom-manager.svelte'
  import BondManagerInstances from '$lib/structure/bonding/BondManagerInstances.svelte'
  import type { BondManager } from '$lib/structure/bonding/bond-manager.svelte'
  import type { RenderPacket } from '$lib/structure/scene/render-packet'
  import WebGLReplicaLayer from '$lib/structure/gpu/WebGLReplicaLayer.svelte'
  import { SharedPositionTexture } from '$lib/structure/gpu/webgl2/shared-position-texture'
  import type { PacketSyncEvidence } from '$lib/structure/trajectory-presentation-commit'

  interface Props {
    mode: 'atom' | 'bond' | 'combined'
    packets: RenderPacket[]
    atom_manager: AtomManager
    bond_manager: BondManager
    renderer: WebGLRenderer
    dom: HTMLElement
    canvas: HTMLCanvasElement
    onscene: (scene: Scene) => void
    /** Start with render_packet=null (legacy static path) — atom mode only. */
    start_null?: boolean
    onpositions?: (positions: SharedPositionTexture) => void
    on_packet_synced?: (evidence: PacketSyncEvidence) => void
    initial_show_atoms?: boolean
    initial_show_bonds?: boolean
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
    onpositions,
    on_packet_synced,
    initial_show_atoms = true,
    initial_show_bonds = true,
  }: Props = $props()

  const threlte = createThrelteContext({
    dom,
    canvas,
    createRenderer: () => renderer,
    autoRender: false,
    renderMode: 'manual',
  })
  onscene(threlte.scene)
  const position_resource = new SharedPositionTexture()
  onpositions?.(position_resource)
  onDestroy(() => position_resource.dispose())

  let packet_idx = $state(start_null ? -1 : 0)
  let ghost_opacity = $state(0.2)
  let stub_scale = $state(0.25)
  let bond_opacity = $state(0.8)
  let appearance_alt = $state(false)
  let layer_show_atoms = $state(untrack(() => initial_show_atoms))
  let layer_show_bonds = $state(untrack(() => initial_show_bonds))
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
<button data-testid="atoms-on" onclick={() => layer_show_atoms = true}>atoms on</button>
<button data-testid="atoms-off" onclick={() => layer_show_atoms = false}>atoms off</button>
<button data-testid="bonds-on" onclick={() => layer_show_bonds = true}>bonds on</button>
<button data-testid="bonds-off" onclick={() => layer_show_bonds = false}>bonds off</button>

{#if mode === 'atom'}
  <AtomManagerInstances
    {atom_manager}
    render_packet={packet}
    {render_style}
    image_atom_opacity={live_ghost_opacity}
    max_capacity={16}
  />
{:else if mode === 'bond'}
  <BondManagerInstances
    {bond_manager}
    atom_positions={(packet ?? packets[0]).frame.positions}
    atom_colors={(packet ?? packets[0]).topology.colors}
    render_packet={packet}
    incomplete_edge_length_scale={live_stub_scale}
    periodic_bond_opacity={live_ghost_opacity}
    opacity={live_bond_opacity}
  />
{:else}
  {#if packet}
    <WebGLReplicaLayer
      {packet}
      {position_resource}
      gpu_positions_rgba={null}
      show_atoms={layer_show_atoms}
      show_bonds={layer_show_bonds}
      incomplete_edge_length_scale={live_stub_scale}
      opacity={live_bond_opacity}
      ghost_opacity={live_ghost_opacity}
      {render_style}
      {on_packet_synced}
    />
  {/if}
  <AtomManagerInstances
    {atom_manager}
    render_packet={packet}
    packet_renderer_owned={packet !== null}
    {render_style}
    image_atom_opacity={live_ghost_opacity}
    max_capacity={16}
  />
  <BondManagerInstances
    {bond_manager}
    atom_positions={(packet ?? packets[0]).frame.positions}
    atom_colors={(packet ?? packets[0]).topology.colors}
    render_packet={packet}
    packet_renderer_owned={packet !== null}
    incomplete_edge_length_scale={live_stub_scale}
    periodic_bond_opacity={live_ghost_opacity}
    opacity={live_bond_opacity}
  />
{/if}
