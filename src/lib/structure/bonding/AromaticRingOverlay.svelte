<!--
  AromaticRingOverlay — the textbook aromatic depiction.

  For each perceived aromatic ring (benzene, pyridine, ...), draws ONE thin
  solid ring (a 3D torus tube) inset inside the ring, in the ring plane and
  centered on the ring centroid. A solid 3D tube reads cleanly against the
  ball-and-stick bonds (a hairline dashed line looked cheap next to the fat
  cylinders). The ring's six bonds render as plain single solid sticks (see
  bond-instanced-renderer.ts) and this single inscribed ring carries the
  aromaticity.

  Geometry: a shared UNIT torus (ring radius 1, tube `tube_fraction`, in the
  local XY plane) built ONCE and reused by every ring via a per-ring world
  transform:
    - positioned at ring.centroid,
    - oriented by a quaternion rotating +Z → ring.normal (ring plane),
    - uniformly scaled to RADIUS_FRACTION × ring.radius so the ring sits a
      touch inside and reads as inscribed. (Uniform scale also scales the tube,
      so larger rings get a proportionally thicker tube — visually fine.)

  Material: MeshStandardMaterial (dark), so the ring is lit by the scene
  headlamp and shades like the bonds — a solid 3D presence, not a flat line.

  Gated entirely by the caller: when bond_order_perception is OFF the caller
  passes an empty `rings` array → nothing is drawn → byte-identical default.
-->
<script lang="ts">
  import type { AromaticRing } from './bond-orders'
  import { T } from '@threlte/core'
  import { untrack } from 'svelte'
  import { Color, MeshStandardMaterial, Quaternion, TorusGeometry, Vector3 } from 'three'

  let {
    rings = [],
    // Inset factor: ring radius = fraction × ring radius. ~0.7 leaves a clear
    // gap to the ring bonds so the inscribed ring reads cleanly.
    radius_fraction = 0.7,
    // Tube radius in unit-ring space (ring radius = 1). 0.05 → a delicate tube,
    // thinner than the bonds, that still has solid 3D presence.
    tube_fraction = 0.05,
    color = `#1a1a1a`,
    opacity = 1,
  }: {
    rings?: AromaticRing[]
    radius_fraction?: number
    tube_fraction?: number
    color?: string
    opacity?: number
  } = $props()

  const RADIAL_SEGMENTS = 12
  const TUBULAR_SEGMENTS = 64

  // Unit torus (ring radius 1, in the local XY plane) built once; reused
  // (scaled/oriented) by every ring.
  const unit_torus_geometry = untrack(
    () => new TorusGeometry(1, tube_fraction, RADIAL_SEGMENTS, TUBULAR_SEGMENTS),
  )

  const ring_material = untrack(
    () =>
      new MeshStandardMaterial({
        color: new Color(color),
        roughness: 0.55,
        metalness: 0,
        transparent: opacity < 1,
        opacity,
      }),
  )

  $effect(() => {
    ring_material.color.set(color)
    ring_material.opacity = opacity
    ring_material.transparent = opacity < 1
    ring_material.needsUpdate = true
  })

  // +Z (the unit ring's plane normal) → each ring's normal, as a quaternion.
  const Z_AXIS = new Vector3(0, 0, 1)
  const tmp_normal = new Vector3()
  const tmp_quat = new Quaternion()

  function ring_quaternion(n: AromaticRing[`normal`]): [number, number, number, number] {
    tmp_normal.set(n[0], n[1], n[2])
    if (tmp_normal.lengthSq() < 1e-12) tmp_normal.set(0, 0, 1)
    else tmp_normal.normalize()
    tmp_quat.setFromUnitVectors(Z_AXIS, tmp_normal)
    return [tmp_quat.x, tmp_quat.y, tmp_quat.z, tmp_quat.w]
  }

  // A stable key per ring so Svelte reuses instances across re-derives.
  function ring_key(ring: AromaticRing): string {
    return ring.atom_indices.join(`,`)
  }
</script>

{#each rings as ring (ring_key(ring))}
  {@const r = ring.radius * radius_fraction}
  <T.Mesh
    geometry={unit_torus_geometry}
    material={ring_material}
    position={ring.centroid}
    quaternion={ring_quaternion(ring.normal)}
    scale={r}
    raycast={null}
    frustumCulled={false}
    renderOrder={2}
  />
{/each}
