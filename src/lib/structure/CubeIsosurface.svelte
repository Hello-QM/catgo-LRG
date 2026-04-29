<script lang="ts">
  import type { CubeMesh } from '$lib/cube/api'
  import { T } from '@threlte/core'
  import { BufferAttribute, Float32BufferAttribute, Quaternion, Vector3 } from 'three'

  let {
    positive_mesh = null,
    negative_mesh = null,
    show_positive = true,
    show_negative = true,
    positive_color = `#3b82f6`,
    negative_color = `#ef4444`,
    opacity = 0.6,
    wireframe = false,
    slice_normal = null,
    slice_center = null,
    show_slice_plane = false,
    slice_plane_size = 20,
    slice_color = `#ffcc00`,
  }: {
    positive_mesh?: CubeMesh | null
    negative_mesh?: CubeMesh | null
    show_positive?: boolean
    show_negative?: boolean
    positive_color?: string
    negative_color?: string
    opacity?: number
    wireframe?: boolean
    slice_normal?: [number, number, number] | null
    slice_center?: [number, number, number] | null
    show_slice_plane?: boolean
    slice_plane_size?: number
    slice_color?: string
  } = $props()

  function setup_geometry(geo: any, m: CubeMesh) {
    geo.setAttribute(`position`, new Float32BufferAttribute(m.positions, 3))
    geo.setAttribute(`normal`, new Float32BufferAttribute(m.normals, 3))
    geo.setIndex(ArrayBuffer.isView(m.indices)
      ? new BufferAttribute(new Uint32Array(m.indices), 1)
      : m.indices)
    geo.computeBoundingSphere()
  }
</script>

<!-- Cube file isosurface overlays -->
{#if positive_mesh && show_positive}
  {#key positive_mesh}
    {#if wireframe}
      <T.Mesh raycast={null} frustumCulled={false}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, positive_mesh!)} />
        <T.MeshBasicMaterial color={positive_color} wireframe={true} />
      </T.Mesh>
    {:else if opacity < 1}
      <!-- Two-pass transparency: back faces first, then front faces -->
      <T.Mesh raycast={null} frustumCulled={false} renderOrder={1}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, positive_mesh!)} />
        <T.MeshStandardMaterial
          color={positive_color}
          transparent
          {opacity}
          side={1}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
      <T.Mesh raycast={null} frustumCulled={false} renderOrder={2}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, positive_mesh!)} />
        <T.MeshStandardMaterial
          color={positive_color}
          transparent
          {opacity}
          side={0}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {:else}
      <T.Mesh raycast={null} frustumCulled={false}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, positive_mesh!)} />
        <T.MeshStandardMaterial
          color={positive_color}
          side={2}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {/if}
  {/key}
{/if}
{#if negative_mesh && show_negative}
  {#key negative_mesh}
    {#if wireframe}
      <T.Mesh raycast={null} frustumCulled={false}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, negative_mesh!)} />
        <T.MeshBasicMaterial color={negative_color} wireframe={true} />
      </T.Mesh>
    {:else if opacity < 1}
      <!-- Two-pass transparency: back faces first, then front faces -->
      <T.Mesh raycast={null} frustumCulled={false} renderOrder={1}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, negative_mesh!)} />
        <T.MeshStandardMaterial
          color={negative_color}
          transparent
          {opacity}
          side={1}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
      <T.Mesh raycast={null} frustumCulled={false} renderOrder={2}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, negative_mesh!)} />
        <T.MeshStandardMaterial
          color={negative_color}
          transparent
          {opacity}
          side={0}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {:else}
      <T.Mesh raycast={null} frustumCulled={false}>
        <T.BufferGeometry oncreate={(geo) => setup_geometry(geo, negative_mesh!)} />
        <T.MeshStandardMaterial
          color={negative_color}
          side={2}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {/if}
  {/key}
{/if}

<!-- Cube slice plane preview -->
{#if show_slice_plane && slice_normal && slice_center}
  {@const n = new Vector3(...slice_normal).normalize()}
  {@const up = new Vector3(0, 0, 1)}
  {@const q = new Quaternion().setFromUnitVectors(up, n)}
  {@const qt = [q.x, q.y, q.z, q.w] as [number, number, number, number]}
  {@const r = slice_plane_size * 0.5}
  <T.Mesh
    position={slice_center}
    quaternion={qt}
    raycast={null}
  >
    <T.CircleGeometry args={[r, 64]} />
    <T.MeshStandardMaterial color={slice_color} transparent opacity={0.45} side={2} depthWrite={false} />
  </T.Mesh>
{/if}
