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
  import { onDestroy, untrack } from 'svelte'
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
  import type { SharedAtomColorTexture } from './webgl2/shared-atom-color-texture'
  import type { PacketSyncEvidence } from '../trajectory-presentation-commit'

  interface Props {
    packet: RenderPacket
    gpu_positions_rgba?: Float32Array | null
    position_resource: SharedPositionTexture
    color_resource?: SharedAtomColorTexture
    /** Live flags — which replica draws this layer instance owns. */
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
    /** Fired only after every enabled packet-owned renderer is synchronized. */
    on_packet_synced?: (evidence: PacketSyncEvidence) => void
  }

  let {
    packet,
    gpu_positions_rgba = null,
    position_resource,
    color_resource,
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
    on_packet_synced,
  }: Props = $props()

  const threlte = useThrelte()

  // Visibility owns renderer lifetime. Only the show_* flag is tracked by
  // each transition effect; constructor options are snapshots, while the
  // appearance effects below keep uniforms live.
  let atom_renderer = $state.raw<AtomReplicaRenderer | null>(null)
  let bond_renderer = $state.raw<BondReplicaRenderer | null>(null)

  $effect(() => {
    const visible = show_atoms
    untrack(() => {
      if (visible && atom_renderer === null) {
        atom_renderer = new AtomReplicaRenderer({
          positions: position_resource,
          ambient_light,
          directional_light,
          ghost_opacity,
        })
      } else if (!visible && atom_renderer !== null) {
        atom_renderer.dispose()
        atom_renderer = null
      }
    })
  })

  $effect(() => {
    const visible = show_bonds
    untrack(() => {
      if (visible && bond_renderer === null) {
        bond_renderer = new BondReplicaRenderer({
          positions: position_resource,
          colors: color_resource,
          bond_radius,
          stub_scale: incomplete_edge_length_scale,
          ambient_light,
          directional_light,
          opacity,
          ghost_opacity,
        })
      } else if (!visible && bond_renderer !== null) {
        bond_renderer.dispose()
        bond_renderer = null
      }
    })
  })

  function mark_dirty(): void {
    threlte.invalidate()
    if (import.meta.env?.DEV) {
      const g = globalThis as unknown as { __invalidate_count?: number }
      g.__invalidate_count = (g.__invalidate_count ?? 0) + 1
    }
  }

  // Packet sync tracks both packet and renderer identity, so a newly created
  // draw receives the already uploaded current packet. update() internally
  // diffs topology / bond-graph / frame / replica versions and does the
  // minimal buffer + uniform work.
  const viewport_scratch = new Vector2(1, 1)
  $effect(() => {
    const pkt = packet
    const rgba = gpu_positions_rgba
    const atoms = atom_renderer
    const bonds = bond_renderer
    untrack(() => {
      position_resource.update(pkt.frame, rgba)
      atoms?.update(pkt)
      if (bonds) {
        bonds.update(pkt)
        // Fragment ray-cast rebuilds the view ray per pixel from the inverse
        // projection + drawing-buffer size — refresh alongside every packet.
        threlte.renderer?.getDrawingBufferSize(viewport_scratch)
        const cam = threlte.camera.current
        if (cam) {
          bonds.set_view(
            cam.projectionMatrixInverse,
            0,
            0,
            viewport_scratch.x,
            viewport_scratch.y,
          )
        }
      }
      mark_dirty()
      const installed_frame = position_resource.uploaded_frame()
      const atom_packet = atoms?.installed_packet() ?? null
      const bond_packet = bonds?.installed_packet() ?? null
      if (
        installed_frame === null ||
        installed_frame.owner !== pkt.frame.owner ||
        installed_frame.frame_idx !== pkt.frame.frame_idx ||
        installed_frame.positions_version !== pkt.frame.positions_version ||
        (atoms !== null && atom_packet !== pkt) ||
        (bonds !== null && bond_packet !== pkt) ||
        (atoms === null && bonds === null)
      ) return
      const installed_packet = atom_packet ?? bond_packet
      if (installed_packet === null) return
      const graph = installed_packet.topology.bond_graph
      on_packet_synced?.({
        packet: installed_packet,
        ...installed_frame,
        topology_version: installed_packet.topology.version,
        graph_version: graph?.version ?? null,
        bond_count: (graph?.pairs.length ?? 0) / 2,
        atom_renderer_synced: atom_packet === pkt,
        bond_renderer_synced: bond_packet === pkt,
      })
    })
  })

  // Live appearance uniforms (shared uniform objects update both the main
  // and the ghost draw of each renderer).
  $effect(() => {
    const atoms = atom_renderer
    const bonds = bond_renderer
    const materials = [atoms?.material, bonds?.material]
    for (const material of materials) {
      if (!material) continue
      material.uniforms.uLightDir.value.copy(light_dir)
      material.uniforms.uAmbientIntensity.value = ambient_light
      material.uniforms.uDirectionalIntensity.value = directional_light
    }
    atoms?.set_ghost_opacity(ghost_opacity)
    bonds?.set_bond_radius(bond_radius)
    bonds?.set_stub_scale(incomplete_edge_length_scale)
    bonds?.set_opacity(opacity)
    bonds?.set_ghost_opacity(ghost_opacity)
    mark_dirty()
  })

  // Appearance → Material (#533): uniform-int branch switch, zero recompile.
  // The baked matcap texture is built lazily ONLY while MatCap is active
  // (same gating as the legacy material — non-matcap renders never touch
  // matcap code; cached per preset).
  $effect(() => {
    const atoms = atom_renderer
    if (!atoms) return
    const matcap = render_style === `matcap`
      ? get_atom_matcap(matcap_preset as MatcapPreset, mark_dirty)
      : null
    atoms.set_render_style(
      render_style_to_int(render_style),
      style_pbr(render_style),
      matcap,
    )
    atoms.set_highlight_strength(highlight_strength)
    mark_dirty()
  })

  // Orthographic flag for the atom sphere impostor's ray setup.
  $effect(() => {
    const atoms = atom_renderer
    if (!atoms) return
    const cam = threlte.camera.current
    atoms.material.uniforms.uIsOrthographic.value = cam
      ? !!(cam as { isOrthographicCamera?: boolean }).isOrthographicCamera
      : false
    mark_dirty()
  })

  // Renderers hold GL resources not owned by <T is={...}> — dispose on unmount.
  onDestroy(() => {
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
