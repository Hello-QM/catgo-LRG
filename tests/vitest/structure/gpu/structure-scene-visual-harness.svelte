<script lang="ts">
  import type { AnyStructure, Site } from '$lib'
  import StructureScene from '$lib/structure/StructureScene.svelte'
  import type { RenderStyle } from '$lib/settings'
  import type { VisualStateSource } from '$lib/structure/rendering/visual-state'
  import type { RenderPacket } from '$lib/structure/scene/render-packet'
  import { createThrelteContext } from '@threlte/core'
  import { untrack } from 'svelte'
  import type { WebGLRenderer } from 'three'

  let {
    renderer,
    dom,
    canvas,
  }: {
    renderer: WebGLRenderer
    dom: HTMLElement
    canvas: HTMLCanvasElement
  } = $props()

  createThrelteContext({
    dom: untrack(() => dom),
    canvas: untrack(() => canvas),
    createRenderer: () => renderer,
    autoRender: false,
    renderMode: `manual`,
  })

  const site: Site = {
    species: [{ element: `C`, occu: 1, oxidation_state: 0 }],
    abc: [0, 0, 0],
    xyz: [0, 0, 0],
    label: `C`,
    properties: {},
  } as Site
  const structure = {
    sites: [site],
    lattice: {
      matrix: [[8, 0, 0], [0, 8, 0], [0, 0, 8]],
      pbc: [true, true, true],
      a: 8,
      b: 8,
      c: 8,
      alpha: 90,
      beta: 90,
      gamma: 90,
      volume: 512,
    },
  } as AnyStructure
  const packet: RenderPacket = {
    topology: {
      version: 1,
      atom_count: 1,
      site_ids: Uint32Array.of(0),
      atomic_numbers: Uint8Array.of(6),
      radii: Float32Array.of(0.7),
      colors: Float32Array.of(0.4, 0.5, 0.6),
    },
    frame: {
      owner: structure,
      frame_idx: 0,
      positions_version: 1,
      positions: Float32Array.of(0, 0, 0),
      lattice: Float32Array.of(8, 0, 0, 0, 8, 0, 0, 0, 8),
    },
    replicas: {
      version: 1,
      dims: [1, 1, 1],
      boundary_policy: `stub`,
      semantics: `visual-shared-base`,
    },
  }

  let render_style = $state<RenderStyle>(`glossy`)
  let background_color = $state(`#123456`)
  let visual_state_source = $state<VisualStateSource | null>(null)

  export function publish_toon_revision(): void {
    render_style = `toon`
    background_color = `#654321`
  }

  export function get_visual_source(): VisualStateSource | null {
    return visual_state_source
  }
</script>

<StructureScene
  {structure}
  render_packet={packet}
  bind:visual_state_source
  {render_style}
  {background_color}
  background_opacity={1}
  show_bonds="never"
  show_cell={false}
  show_scale_bar={false}
  gizmo={false}
  width={320}
  height={240}
/>
