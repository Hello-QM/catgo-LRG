<script lang="ts">
  import { T } from '@threlte/core'
  import { Float32BufferAttribute, Uint32BufferAttribute, FrontSide, BackSide, DoubleSide } from 'three'
  import type { CubeMesh } from './api'

  let {
    mesh,
    color = `#3b82f6`,
    opacity = 0.6,
    wireframe = false,
    visible = true,
    side = `double`,
    renderOrder = 0,
  }: {
    mesh: CubeMesh
    color?: string
    opacity?: number
    wireframe?: boolean
    visible?: boolean
    side?: `front` | `back` | `double`
    renderOrder?: number
  } = $props()

  // Create typed arrays from the mesh data
  let positions_attr = $derived(new Float32BufferAttribute(new Float32Array(mesh.positions), 3))
  let normals_attr = $derived(new Float32BufferAttribute(new Float32Array(mesh.normals), 3))
  let indices_attr = $derived(new Uint32BufferAttribute(new Uint32Array(mesh.indices), 1))

  function setup_geometry(geo: any) {
    geo.setAttribute(`position`, positions_attr)
    geo.setAttribute(`normal`, normals_attr)
    geo.setIndex(indices_attr)
    geo.computeBoundingSphere()
  }
</script>

{#if visible && mesh.positions.length > 0}
  {#key mesh}
    {#if wireframe}
      <T.Mesh frustumCulled={false} {renderOrder}>
        <T.BufferGeometry oncreate={setup_geometry} />
        <T.MeshBasicMaterial {color} wireframe={true} />
      </T.Mesh>
    {:else if opacity < 1}
      <!-- Two-pass transparency: back faces first, then front faces -->
      <T.Mesh frustumCulled={false} renderOrder={renderOrder + 1}>
        <T.BufferGeometry oncreate={setup_geometry} />
        <T.MeshStandardMaterial
          {color}
          transparent
          {opacity}
          side={BackSide}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
      <T.Mesh frustumCulled={false} renderOrder={renderOrder + 2}>
        <T.BufferGeometry oncreate={setup_geometry} />
        <T.MeshStandardMaterial
          {color}
          transparent
          {opacity}
          side={FrontSide}
          depthWrite={false}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {:else}
      <T.Mesh frustumCulled={false} {renderOrder}>
        <T.BufferGeometry oncreate={setup_geometry} />
        <T.MeshStandardMaterial
          {color}
          side={DoubleSide}
          metalness={0.1}
          roughness={0.6}
        />
      </T.Mesh>
    {/if}
  {/key}
{/if}
