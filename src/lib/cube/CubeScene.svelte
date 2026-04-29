<script lang="ts">
  import { T } from '@threlte/core'
  import { interactivity, OrbitControls } from '@threlte/extras'
  import IsosurfaceMesh from './IsosurfaceMesh.svelte'
  import SlicePlane from './SlicePlane.svelte'
  import type { CubeMesh, CubeAtom } from './api'

  let {
    positive_mesh = null,
    negative_mesh = null,
    atoms = [],
    show_positive = true,
    show_negative = true,
    positive_color = `#3366cc`,
    negative_color = `#cc3333`,
    opacity = 0.7,
    wireframe = false,
    selected_atoms = [],
    slice_normal = [0, 0, 1] as [number, number, number],
    slice_center = [0, 0, 0] as [number, number, number],
    show_slice_plane = false,
    plane_size = 20,
    onatomclick,
  }: {
    positive_mesh?: CubeMesh | null
    negative_mesh?: CubeMesh | null
    atoms?: CubeAtom[]
    show_positive?: boolean
    show_negative?: boolean
    positive_color?: string
    negative_color?: string
    opacity?: number
    wireframe?: boolean
    selected_atoms?: number[]
    slice_normal?: [number, number, number]
    slice_center?: [number, number, number]
    show_slice_plane?: boolean
    plane_size?: number
    onatomclick?: (index: number) => void
  } = $props()

  // Enable pointer events on 3D meshes
  interactivity({
    filter: (hits) => hits.slice(0, 1),
  })

  // Compute center of atoms for camera target
  let center = $derived.by(() => {
    if (atoms.length === 0) return [0, 0, 0] as [number, number, number]
    const sum = atoms.reduce(
      (acc, a) => [acc[0] + a.position[0], acc[1] + a.position[1], acc[2] + a.position[2]],
      [0, 0, 0],
    )
    return [sum[0] / atoms.length, sum[1] / atoms.length, sum[2] / atoms.length] as [
      number,
      number,
      number,
    ]
  })

  const ELEMENT_COLORS: Record<number, string> = {
    1: `#ffffff`,
    6: `#333333`,
    7: `#3333ff`,
    8: `#ff3333`,
    42: `#54b5b5`,
  }

  function atom_color(z: number): string {
    return ELEMENT_COLORS[z] ?? `#999999`
  }

  function is_selected(index: number): boolean {
    return selected_atoms.includes(index)
  }
</script>

<T.PerspectiveCamera
  makeDefault
  position={[center[0] + 20, center[1] + 15, center[2] + 20]}
>
  <OrbitControls target={center} enableDamping />
</T.PerspectiveCamera>

<T.AmbientLight intensity={0.4} />
<T.DirectionalLight position={[10, 20, 10]} intensity={0.8} />
<T.DirectionalLight position={[-10, -5, -10]} intensity={0.3} />

<!-- Atom spheres (clickable) -->
{#each atoms as atom, i (i)}
  <T.Mesh
    position={atom.position}
    onclick={() => onatomclick?.(i)}
  >
    <T.SphereGeometry args={[is_selected(i) ? 0.6 : 0.4, 16, 16]} />
    <T.MeshStandardMaterial
      color={is_selected(i) ? `#ffcc00` : atom_color(atom.atomic_number)}
      emissive={is_selected(i) ? `#ffcc00` : `#000000`}
      emissiveIntensity={is_selected(i) ? 0.3 : 0}
    />
  </T.Mesh>
{/each}

<!-- Positive isosurface -->
{#if positive_mesh && show_positive}
  <IsosurfaceMesh
    mesh={positive_mesh}
    color={positive_color}
    {opacity}
    {wireframe}
  />
{/if}

<!-- Negative isosurface -->
{#if negative_mesh && show_negative}
  <IsosurfaceMesh
    mesh={negative_mesh}
    color={negative_color}
    {opacity}
    {wireframe}
  />
{/if}

<!-- Slice plane preview -->
{#if show_slice_plane && selected_atoms.length >= 2}
  <SlicePlane
    normal={slice_normal}
    center={slice_center}
    size={plane_size}
  />
{/if}
