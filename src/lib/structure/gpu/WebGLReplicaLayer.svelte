<script lang="ts">
  /**
   * WebGL2 replica impostor layer — mounts the Task-4 atom/bond replica
   * renderers (gpu/webgl2/) for a `RenderPacket` whose `ReplicaLayout` has
   * dims ≠ 1×1×1. One packet drives both draws; a frame advance only rewrites
   * base-sized buffers + the current-lattice uniform (no mesh reconstruction
   * across play / pause / scrub), and a replica-factor change only touches
   * instance counts, divisors, and uniforms.
   *
   * Hosted by AtomManagerInstances (show_bonds=false) and BondManagerInstances
   * (show_atoms=false) so each legacy component owns exactly its own replica
   * bypass. Task 6 integrates the full scene semantics.
   */
  import { untrack } from 'svelte'
  import { T, useThrelte } from '@threlte/core'
  import { Vector2, Vector3 } from 'three'
  import type { RenderPacket } from '../scene/render-packet'
  import { AtomReplicaRenderer } from './webgl2/atom-replica-renderer'
  import { BondReplicaRenderer } from './webgl2/bond-replica-renderer'

  interface Props {
    packet: RenderPacket
    /** Mount-time flags — which replica draws this layer instance owns. */
    show_atoms?: boolean
    show_bonds?: boolean
    bond_radius?: number
    /** Stub length multiplier for the 'stub' boundary policy. */
    incomplete_edge_length_scale?: number
    ambient_light?: number
    directional_light?: number
    /** View-space headlamp direction (kept live in both materials). */
    light_dir?: Vector3
    /** Opacity multiplier for ghost-image instances (sparse second draws). */
    ghost_opacity?: number
  }

  let {
    packet,
    show_atoms = true,
    show_bonds = true,
    bond_radius = 0.15,
    incomplete_edge_length_scale = 0.5,
    ambient_light = 0.7,
    directional_light = 0.3,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    ghost_opacity = 1,
  }: Props = $props()

  const threlte = useThrelte()

  // Renderers are created once per layer mount (show_* are mount-time flags);
  // every packet change flows through update() below. untrack: constructor
  // options capture initial values, the $effects keep uniforms live.
  const atom_renderer = untrack(() =>
    show_atoms
      ? new AtomReplicaRenderer({ ambient_light, directional_light, ghost_opacity })
      : null
  )
  const bond_renderer = untrack(() =>
    show_bonds
      ? new BondReplicaRenderer({
        bond_radius,
        stub_scale: incomplete_edge_length_scale,
        ambient_light,
        directional_light,
        ghost_opacity,
      })
      : null
  )

  function mark_dirty(): void {
    threlte.invalidate()
    if (import.meta.env?.DEV) {
      const g = globalThis as unknown as { __invalidate_count?: number }
      g.__invalidate_count = (g.__invalidate_count ?? 0) + 1
    }
  }

  // Packet sync — the only per-frame effect. Tracks the packet identity;
  // update() internally diffs topology / bond-graph / frame / replica
  // versions and does the minimal buffer + uniform work.
  const viewport_scratch = new Vector2(1, 1)
  $effect(() => {
    const pkt = packet
    untrack(() => {
      atom_renderer?.update(pkt)
      if (bond_renderer) {
        bond_renderer.update(pkt)
        // Fragment ray-cast rebuilds the view ray per pixel from the inverse
        // projection + drawing-buffer size — refresh alongside every packet.
        threlte.renderer?.getDrawingBufferSize(viewport_scratch)
        const cam = threlte.camera.current
        if (cam) {
          bond_renderer.set_view(
            cam.projectionMatrixInverse,
            viewport_scratch.x,
            viewport_scratch.y,
          )
        }
      }
      mark_dirty()
    })
  })

  // Live appearance uniforms (shared uniform objects update both the main
  // and the ghost draw of each renderer).
  $effect(() => {
    const materials = [atom_renderer?.material, bond_renderer?.material]
    for (const material of materials) {
      if (!material) continue
      material.uniforms.uLightDir.value.copy(light_dir)
      material.uniforms.uAmbientIntensity.value = ambient_light
      material.uniforms.uDirectionalIntensity.value = directional_light
    }
    bond_renderer?.set_bond_radius(bond_radius)
    mark_dirty()
  })

  // Orthographic flag for the atom sphere impostor's ray setup.
  $effect(() => {
    if (!atom_renderer) return
    const cam = threlte.camera.current
    atom_renderer.material.uniforms.uIsOrthographic.value = cam
      ? !!(cam as { isOrthographicCamera?: boolean }).isOrthographicCamera
      : false
    mark_dirty()
  })

  // Renderers hold GL resources not owned by <T is={...}> — dispose on unmount.
  $effect(() => () => {
    atom_renderer?.dispose()
    bond_renderer?.dispose()
  })
</script>

{#if atom_renderer}
  <T is={atom_renderer.mesh} />
  <T is={atom_renderer.ghost_mesh} />
{/if}
{#if bond_renderer}
  <T is={bond_renderer.mesh} />
  <T is={bond_renderer.ghost_mesh} />
{/if}
