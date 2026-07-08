<script lang="ts">
  import { Canvas } from '@threlte/core'
  import { ACESFilmicToneMapping } from 'three'
  import CubeScene from './CubeScene.svelte'
  import CubeControls from './CubeControls.svelte'
  import type { CubeState, IsosurfaceResult, CubeMesh, CubeAtom } from './api'
  import { uploadCubeFile, extractIsosurface } from './api'
  import { download } from '$lib/io/fetch'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    initial_file = undefined,
  }: {
    initial_file?: File | null
  } = $props()

  // Isosurface mesh data
  let positive_mesh: CubeMesh | null = $state(null)
  let negative_mesh: CubeMesh | null = $state(null)
  let atoms: CubeAtom[] = $state([])
  let slice_image_url: string | null = $state(null)
  let controls_ref: CubeControls | null = $state(null)

  // Controls state
  let cube_state: CubeState = $state({
    filepath: ``,
    header: null,
    isovalue: 0.05,
    dual: true,
    decimate: 0,
    show_positive: true,
    show_negative: true,
    positive_color: `#3b82f6`,
    negative_color: `#ef4444`,
    opacity: 0.6,
    wireframe: false,
    slice_plane: {
      mode: `z` as `x` | `y` | `z` | `custom`,
      position: 0.5,
      offset: 0,
      selected_atoms: [],
      normal: [0, 0, 1] as [number, number, number],
      center: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      show_plane: false,
      plane_color: `#ffcc00`,
      colormap: `RdBu` as const,
    },
    loading: false,
    error: null,
  })

  // Auto-upload initial_file when provided (e.g. from desktop app file drop)
  let auto_uploaded = $state(false)
  $effect(() => {
    if (initial_file && !auto_uploaded && !cube_state.filepath) {
      auto_uploaded = true
      ;(async () => {
        cube_state.loading = true
        cube_state.error = null
        try {
          const result = await uploadCubeFile(initial_file)
          cube_state.filepath = result.path
          const iso = await extractIsosurface({
            filepath: result.path,
            isovalue: cube_state.isovalue,
            dual: cube_state.dual,
            decimate: cube_state.decimate > 0 ? cube_state.decimate : undefined,
          })
          cube_state.header = iso.header
          handle_isosurface(iso)
        } catch (err) {
          cube_state.error = `Auto-upload failed: ${(err as Error).message}`
        } finally {
          cube_state.loading = false
        }
      })()
    }
  })

  function handle_isosurface(result: IsosurfaceResult) {
    positive_mesh = result.positive
    negative_mesh = result.negative
    atoms = result.header.atoms
  }

  let slice_blob: Blob | null = $state(null)

  function handle_slice(blob: Blob) {
    if (slice_image_url) URL.revokeObjectURL(slice_image_url)
    slice_blob = blob
    slice_image_url = URL.createObjectURL(blob)
  }

  function download_slice() {
    if (!slice_blob) return
    download(slice_blob, `slice.png`, `image/png`)
  }

  function handle_atom_click(index: number) {
    controls_ref?.on_atom_clicked(index)
  }

  // Compute the rotated normal for the slice plane preview
  let display_normal = $derived.by((): [number, number, number] => {
    const sp = cube_state.slice_plane
    let [nx, ny, nz] = sp.normal
    const [rx, ry, rz] = sp.rotation.map((d) => (d * Math.PI) / 180)

    // Rotation around X
    let ny1 = ny * Math.cos(rx) - nz * Math.sin(rx)
    let nz1 = ny * Math.sin(rx) + nz * Math.cos(rx)
    ny = ny1
    nz = nz1

    // Rotation around Y
    let nx2 = nx * Math.cos(ry) + nz * Math.sin(ry)
    let nz2 = -nx * Math.sin(ry) + nz * Math.cos(ry)
    nx = nx2
    nz = nz2

    // Rotation around Z
    let nx3 = nx * Math.cos(rz) - ny * Math.sin(rz)
    let ny3 = nx * Math.sin(rz) + ny * Math.cos(rz)
    nx = nx3
    ny = ny3

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 1]
  })

  // Compute plane size from the spread of atoms near the selected plane
  let plane_size = $derived.by(() => {
    if (!cube_state.header || atoms.length === 0) return 10
    const sp = cube_state.slice_plane
    if (sp.selected_atoms.length < 2) return 10

    // Find bounding box of all atoms (not just selected) for a reasonable plane size
    let min_x = Infinity, max_x = -Infinity
    let min_y = Infinity, max_y = -Infinity
    let min_z = Infinity, max_z = -Infinity
    for (const a of atoms) {
      min_x = Math.min(min_x, a.position[0])
      max_x = Math.max(max_x, a.position[0])
      min_y = Math.min(min_y, a.position[1])
      max_y = Math.max(max_y, a.position[1])
      min_z = Math.min(min_z, a.position[2])
      max_z = Math.max(max_z, a.position[2])
    }
    const spread = Math.max(max_x - min_x, max_y - min_y, max_z - min_z)
    return (spread + 6) * 1.2 // atom spread + 6 Å margin
  })
</script>

<div class="cube-viewer">
  <div class="scene-container">
    <Canvas toneMapping={ACESFilmicToneMapping}>
      <CubeScene
        {positive_mesh}
        {negative_mesh}
        {atoms}
        show_positive={cube_state.show_positive}
        show_negative={cube_state.show_negative}
        positive_color={cube_state.positive_color}
        negative_color={cube_state.negative_color}
        opacity={cube_state.opacity}
        wireframe={cube_state.wireframe}
        selected_atoms={cube_state.slice_plane.selected_atoms}
        slice_normal={display_normal}
        slice_center={cube_state.slice_plane.center}
        show_slice_plane={cube_state.slice_plane.show_plane}
        {plane_size}
        onatomclick={handle_atom_click}
      />
    </Canvas>
  </div>

  <div class="controls-panel">
    <CubeControls
      bind:this={controls_ref}
      bind:cube_state
      onisosurface={handle_isosurface}
      onslice={handle_slice}
    />

    {#if slice_image_url}
      <div class="slice-preview">
        <div class="slice-header">
          <h4>{t('structure.cube_slice_result')}</h4>
          <button class="export-btn" onclick={download_slice}>{t('structure.cube_save_png')}</button>
        </div>
        <img src={slice_image_url} alt={t('structure.cube_plane_slice_alt')} />
      </div>
    {/if}
  </div>
</div>

<style>
  .cube-viewer {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 500px;
  }
  .scene-container {
    flex: 1;
    position: relative;
  }
  .controls-panel {
    width: 280px;
    overflow-y: auto;
    border-left: 1px solid rgba(128, 128, 128, 0.2);
    background: var(--bg-secondary, #f8f8f8);
  }
  .slice-preview {
    padding: 0.5rem;
    border-top: 1px solid rgba(128, 128, 128, 0.2);
  }
  .slice-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.3rem;
  }
  .slice-preview h4 {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
    opacity: 0.8;
  }
  .export-btn {
    padding: 2px 8px;
    font-size: 0.75rem;
    cursor: pointer;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.1);
  }
  .export-btn:hover {
    background: rgba(128, 128, 128, 0.2);
  }
  .slice-preview img {
    width: 100%;
    border-radius: 3px;
    image-rendering: pixelated;
  }
</style>
