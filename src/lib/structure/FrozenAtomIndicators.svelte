<script lang="ts">
  import type { Site } from '$lib'
  import { T } from '@threlte/core'
  import type { SvelteMap } from 'svelte/reactivity'

  let {
    sites,
    all_radii_by_site_idx,
    atom_radius = 1,
  }: {
    sites: Site[]
    all_radii_by_site_idx: Map<number, number> | SvelteMap<number, number>
    atom_radius?: number
  } = $props()

  // No-op raycast prevents these visual-only meshes from intercepting
  // Threlte's interactivity raycasting (which only keeps the closest hit).
  // Without this, the torus rings block click events meant for atoms.
  const noop_raycast = () => {}

  // Early-exit guard: skip the entire loop when no atoms are frozen (common case)
  let has_any_frozen = $derived(
    sites.some(s => {
      const sd = s.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
      return sd && (!sd[0] || !sd[1] || !sd[2])
    })
  )
</script>

<!-- Frozen atom indicators — per-axis colored rings (X=red, Y=green, Z=blue) -->
{#if has_any_frozen}
  {#each sites as site, site_idx (site_idx)}
    {@const sel_dyn = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined}
    {#if sel_dyn && (!sel_dyn[0] || !sel_dyn[1] || !sel_dyn[2])}
      {@const frozen_radius = (all_radii_by_site_idx.get(site_idx) ?? atom_radius) * 0.85}
      {#if !sel_dyn[0]}
        <T.Mesh position={site.xyz} rotation={[0, Math.PI / 2, 0]} raycast={noop_raycast}>
          <T.TorusGeometry args={[frozen_radius, 0.06, 8, 32]} />
          <T.MeshBasicMaterial color="#d75555" />
        </T.Mesh>
      {/if}
      {#if !sel_dyn[1]}
        <T.Mesh position={site.xyz} rotation={[Math.PI / 2, 0, 0]} raycast={noop_raycast}>
          <T.TorusGeometry args={[frozen_radius, 0.06, 8, 32]} />
          <T.MeshBasicMaterial color="#55b855" />
        </T.Mesh>
      {/if}
      {#if !sel_dyn[2]}
        <T.Mesh position={site.xyz} raycast={noop_raycast}>
          <T.TorusGeometry args={[frozen_radius, 0.06, 8, 32]} />
          <T.MeshBasicMaterial color="#5555d7" />
        </T.Mesh>
      {/if}
    {/if}
  {/each}
{/if}
