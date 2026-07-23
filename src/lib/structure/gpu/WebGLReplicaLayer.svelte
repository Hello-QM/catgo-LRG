<script lang="ts">
  /**
   * WebGL2 replica impostor layer — mounts the Task-4 atom/bond replica
   * renderers (gpu/webgl2/) for every packet-path `RenderPacket`, including
   * 1×1×1. One packet drives both draws; a frame advance only rewrites
   * base-sized buffers + the current-lattice uniform (no mesh reconstruction
   * across play / pause / scrub), and a replica-factor change only touches
   * instance counts, divisors, and uniforms.
   *
   * StructureScene hosts one combined instance for the packet path. The
   * manager-local atom-only/bond-only mounts remain compatibility fallbacks
   * for isolated component consumers.
   */
  import { untrack } from 'svelte'
  import { T, useThrelte } from '@threlte/core'
  import { Vector2, Vector3 } from 'three'
  import { get_atom_matcap, type MatcapPreset } from '../atoms/matcap-texture'
  import {
    type AtomRenderStyle,
    render_style_to_int,
    style_pbr,
  } from '../atoms/render-style'
  import type { RenderPacket } from '../scene/render-packet'
  import { AtomReplicaRenderer } from './webgl2/atom-replica-renderer'
  import { BondReplicaRenderer } from './webgl2/bond-replica-renderer'
  import type { SharedPositionTexture } from './webgl2/shared-position-texture'

  interface Props {
    packet: RenderPacket
    gpu_positions_rgba?: Float32Array | null
    position_resource: SharedPositionTexture
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
    /** Appearance → Material style for the atom impostors (#533). */
    render_style?: AtomRenderStyle
    matcap_preset?: string
    highlight_strength?: number
    /** Main bond-draw opacity (ignored by atom-only layers). */
    opacity?: number
    /** Opacity multiplier for ghost-image instances (sparse second draws). */
    ghost_opacity?: number
  }

  let {
    packet,
    gpu_positions_rgba = null,
    position_resource,
    show_atoms = true,
    show_bonds = true,
    bond_radius = 0.15,
    incomplete_edge_length_scale = 0.5,
    ambient_light = 0.7,
    directional_light = 0.3,
    light_dir = new Vector3(0.4, 0.7, 0.6).normalize(),
    render_style = `glossy`,
    matcap_preset = `ceramic`,
    highlight_strength = 1.0,
    opacity = 1,
    ghost_opacity = 1,
  }: Props = $props()

  const threlte = useThrelte()

  // Renderers are created once per layer mount (show_* are mount-time flags);
  // every packet change flows through update() below. untrack: constructor
  // options capture initial values, the $effects keep uniforms live.
  const atom_renderer = untrack(() =>
    show_atoms
      ? new AtomReplicaRenderer({
        positions: position_resource,
        ambient_light,
        directional_light,
        ghost_opacity,
      })
      : null
  )
  const bond_renderer = untrack(() =>
    show_bonds
      ? new BondReplicaRenderer({
        positions: position_resource,
        bond_radius,
        stub_scale: incomplete_edge_length_scale,
        ambient_light,
        directional_light,
        opacity,
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
    const rgba = gpu_positions_rgba
    untrack(() => {
      position_resource.update(pkt.frame, rgba)
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
            0,
            0,
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
    atom_renderer?.set_ghost_opacity(ghost_opacity)
    bond_renderer?.set_bond_radius(bond_radius)
    bond_renderer?.set_stub_scale(incomplete_edge_length_scale)
    bond_renderer?.set_opacity(opacity)
    bond_renderer?.set_ghost_opacity(ghost_opacity)
    mark_dirty()
  })

  // Appearance → Material (#533): uniform-int branch switch, zero recompile.
  // The baked matcap texture is built lazily ONLY while MatCap is active
  // (same gating as the legacy material — non-matcap renders never touch
  // matcap code; cached per preset).
  $effect(() => {
    if (!atom_renderer) return
    const matcap = render_style === `matcap`
      ? get_atom_matcap(matcap_preset as MatcapPreset, mark_dirty)
      : null
    atom_renderer.set_render_style(
      render_style_to_int(render_style),
      style_pbr(render_style),
      matcap,
    )
    atom_renderer.set_highlight_strength(highlight_strength)
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
