<script lang="ts">
  import { T } from '@threlte/core'
  import { Float32BufferAttribute, Quaternion, Vector3 } from 'three'

  let {
    normal = [0, 0, 1],
    center = [0, 0, 0],
    size = 20,
    color = `#ffcc00`,
    opacity = 0.2,
    visible = true,
  }: {
    normal?: [number, number, number]
    center?: [number, number, number]
    size?: number
    color?: string
    opacity?: number
    visible?: boolean
  } = $props()

  // Compute quaternion to rotate from default plane normal (0,0,1) to target normal
  let quaternion = $derived.by(() => {
    const from = new Vector3(0, 0, 1)
    const to = new Vector3(...normal).normalize()
    const q = new Quaternion()
    q.setFromUnitVectors(from, to)
    return [q.x, q.y, q.z, q.w] as [number, number, number, number]
  })
</script>

{#if visible}
  {#key `${normal}-${center}-${size}`}
    <T.Mesh position={center} quaternion={quaternion} renderOrder={1}>
      <T.PlaneGeometry args={[size, size]} />
      <T.MeshStandardMaterial
        {color}
        transparent
        {opacity}
        side={2}
        depthWrite={false}
      />
    </T.Mesh>

    <T.LineLoop position={center} quaternion={quaternion}>
      <T.BufferGeometry
        oncreate={(geo) => {
          const hs = size / 2
          const verts = new Float32Array([
            -hs, -hs, 0,
             hs, -hs, 0,
             hs,  hs, 0,
            -hs,  hs, 0,
          ])
          geo.setAttribute(`position`, new Float32BufferAttribute(verts, 3))
        }}
      />
      <T.LineBasicMaterial {color} linewidth={2} />
    </T.LineLoop>
  {/key}
{/if}
