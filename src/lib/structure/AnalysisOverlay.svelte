<script lang="ts">
  import type { AnalysisOverlayData } from '$lib/wavefunction/overlay'
  import { T } from '@threlte/core'

  let { overlay = null }: { overlay?: AnalysisOverlayData | null } = $props()
</script>

<!-- Critical points, surface extrema and bond paths from wavefunction analyses -->
{#if overlay}
  {#each overlay.markers as m, i (i)}
    <T.Mesh position={m.position} raycast={null}>
      <T.SphereGeometry args={[m.radius, 16, 12]} />
      <T.MeshStandardMaterial color={m.color} metalness={0.1} roughness={0.5} />
    </T.Mesh>
  {/each}
  {#each overlay.lines as line, i (i)}
    <T.Line raycast={null}>
      <T.BufferGeometry>
        <T.Float32BufferAttribute
          attach="attributes.position"
          args={[new Float32Array(line.points.flat()), 3]}
        />
      </T.BufferGeometry>
      <T.LineBasicMaterial color={line.color} linewidth={2} />
    </T.Line>
  {/each}
{/if}
