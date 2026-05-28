<script lang="ts">
  import type { CubeState, IsosurfaceResult, CubeAtom } from './api'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import {
    extractIsosurface,
    uploadCubeFile,
    extractPlaneSlice,
    downloadIsosurface,
  } from './api'

  let {
    cube_state = $bindable(),
    onisosurface,
    onslice,
  }: {
    cube_state: CubeState
    onisosurface?: (result: IsosurfaceResult) => void
    onslice?: (blob: Blob) => void
  } = $props()

  load_i18n_module('common')
  load_i18n_module('structure')

  let file_input: HTMLInputElement
  let selecting_atoms = $state(false)

  async function handle_file_upload() {
    const file = file_input?.files?.[0]
    if (!file) return

    cube_state.loading = true
    cube_state.error = null
    try {
      const result = await uploadCubeFile(file)
      cube_state.filepath = result.path
      await handle_extract_isosurface()
    } catch (err) {
      cube_state.error = t('structure.upload_failed', { error: (err as Error).message })
    } finally {
      cube_state.loading = false
    }
  }

  async function handle_extract_isosurface() {
    if (!cube_state.filepath) return
    cube_state.loading = true
    cube_state.error = null
    try {
      const result = await extractIsosurface({
        filepath: cube_state.filepath,
        isovalue: cube_state.isovalue,
        dual: cube_state.dual,
        decimate: cube_state.decimate > 0 ? cube_state.decimate : undefined,
      })
      cube_state.header = result.header
      onisosurface?.(result)
    } catch (err) {
      cube_state.error = t('structure.cube_isosurface_failed', { error: (err as Error).message })
    } finally {
      cube_state.loading = false
    }
  }

  // Compute the rotated normal from the base normal + euler rotation
  function get_rotated_normal(): [number, number, number] {
    const sp = cube_state.slice_plane
    let [nx, ny, nz] = sp.normal

    // Apply rotations (Euler angles in degrees → radians)
    const [rx, ry, rz] = sp.rotation.map((d) => (d * Math.PI) / 180)

    // Rotation around X
    const ny1 = ny * Math.cos(rx) - nz * Math.sin(rx)
    const nz1 = ny * Math.sin(rx) + nz * Math.cos(rx)
    ny = ny1
    nz = nz1

    // Rotation around Y
    const nx2 = nx * Math.cos(ry) + nz * Math.sin(ry)
    const nz2 = -nx * Math.sin(ry) + nz * Math.cos(ry)
    nx = nx2
    nz = nz2

    // Rotation around Z
    const nx3 = nx * Math.cos(rz) - ny * Math.sin(rz)
    const ny3 = nx * Math.sin(rz) + ny * Math.cos(rz)
    nx = nx3
    ny = ny3

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 1]
  }

  async function handle_extract_plane_slice() {
    if (!cube_state.filepath) return
    cube_state.loading = true
    cube_state.error = null
    try {
      const rotated_normal = get_rotated_normal()
      const blob = await extractPlaneSlice({
        filepath: cube_state.filepath,
        normal: rotated_normal,
        center: cube_state.slice_plane.center,
      })
      onslice?.(blob)
    } catch (err) {
      cube_state.error = t('structure.cube_slice_failed', { error: (err as Error).message })
    } finally {
      cube_state.loading = false
    }
  }

  function toggle_atom_selection() {
    selecting_atoms = !selecting_atoms
    if (selecting_atoms) {
      cube_state.slice_plane.selected_atoms = []
    }
  }

  // Called externally when user clicks an atom
  export function on_atom_clicked(atom_index: number) {
    if (!selecting_atoms) return
    const sp = cube_state.slice_plane
    if (sp.selected_atoms.includes(atom_index)) return
    sp.selected_atoms = [...sp.selected_atoms, atom_index]

    if (sp.selected_atoms.length >= 3) {
      compute_plane_from_atoms()
      selecting_atoms = false
    }
  }

  function compute_plane_from_atoms() {
    const atoms = cube_state.header?.atoms
    if (!atoms) return
    const sp = cube_state.slice_plane
    const indices = sp.selected_atoms

    if (indices.length === 2) {
      // 2 atoms: plane normal = cross(atom_vec, Z_up), center = midpoint
      const p1 = atoms[indices[0]].position
      const p2 = atoms[indices[1]].position
      const d = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
      sp.center = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2]
      // Normal perpendicular to the bond and Z-up
      const up = [0, 0, 1]
      sp.normal = normalize_vec(cross_vec(d, up))
    } else if (indices.length >= 3) {
      // 3 atoms: plane from cross product
      const p1 = atoms[indices[0]].position
      const p2 = atoms[indices[1]].position
      const p3 = atoms[indices[2]].position
      const v1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
      const v2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]
      sp.normal = normalize_vec(cross_vec(v1, v2))
      sp.center = [
        (p1[0] + p2[0] + p3[0]) / 3,
        (p1[1] + p2[1] + p3[1]) / 3,
        (p1[2] + p2[2] + p3[2]) / 3,
      ]
    }

    sp.rotation = [0, 0, 0]
    sp.show_plane = true
  }

  function cross_vec(
    a: number[],
    b: number[],
  ): [number, number, number] {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ]
  }

  function normalize_vec(v: [number, number, number]): [number, number, number] {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
  }

  async function handle_export(format: `glb` | `obj`) {
    if (!cube_state.filepath) return
    cube_state.loading = true
    try {
      const blob = await downloadIsosurface(
        {
          filepath: cube_state.filepath,
          isovalue: cube_state.isovalue,
          dual: cube_state.dual,
          decimate: cube_state.decimate > 0 ? cube_state.decimate : undefined,
        },
        format,
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement(`a`)
      a.href = url
      a.download = `isosurface.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      cube_state.error = t('structure.cube_export_failed', { error: (err as Error).message })
    } finally {
      cube_state.loading = false
    }
  }

  let debounce_timer: ReturnType<typeof setTimeout>
  function debounced_extract() {
    clearTimeout(debounce_timer)
    debounce_timer = setTimeout(handle_extract_isosurface, 300)
  }

  // Atom label helper
  function atom_symbol(z: number): string {
    const symbols: Record<number, string> = {
      1: `H`, 6: `C`, 7: `N`, 8: `O`, 42: `Mo`,
      26: `Fe`, 27: `Co`, 28: `Ni`, 29: `Cu`, 30: `Zn`,
      44: `Ru`, 46: `Pd`, 78: `Pt`, 79: `Au`,
    }
    return symbols[z] ?? `Z${z}`
  }
</script>

<div class="cube-controls">
  <section class="section">
    <h4>{t('structure.cube_file')}</h4>
    <input
      type="file"
      accept=".cube,.cub"
      bind:this={file_input}
      onchange={handle_file_upload}
    />
    {#if cube_state.header}
      <div class="info">
        <span>{t('structure.md_atoms_count', { n: cube_state.header.n_atoms })}</span>
        <span>
          {t('structure.cube_grid_dims', { x: cube_state.header.dims[0], y: cube_state.header.dims[1], z: cube_state.header.dims[2] })}
        </span>
      </div>
    {/if}
  </section>

  {#if cube_state.filepath}
    <section class="section">
      <h4>{t('structure.isosurface')}</h4>
      <label>
        {t('structure.cube_isovalue')}
        <input
          type="range"
          min="0.001"
          max="1.0"
          step="0.001"
          bind:value={cube_state.isovalue}
          oninput={debounced_extract}
        />
        <input
          type="number"
          min="0.001"
          max="10"
          step="0.001"
          bind:value={cube_state.isovalue}
          class="num-input"
        />
      </label>

      <label>
        <input type="checkbox" bind:checked={cube_state.dual} />
        {t('structure.cube_show_pm_isosurfaces')}
      </label>

      <label>
        {t('structure.opacity')}
        <input
          type="range"
          min="0.1"
          max="1.0"
          step="0.05"
          bind:value={cube_state.opacity}
        />
      </label>

      <label>
        <input type="checkbox" bind:checked={cube_state.wireframe} />
        {t('structure.cube_wireframe')}
      </label>

      <div class="color-row">
        <label>
          {t('structure.cube_positive_color')}
          <input type="color" bind:value={cube_state.positive_color} />
        </label>
        {#if cube_state.dual}
          <label>
            {t('structure.cube_negative_color')}
            <input type="color" bind:value={cube_state.negative_color} />
          </label>
        {/if}
      </div>

      <label>
        {t('structure.cube_mesh_simplification')}
        <input
          type="number"
          min="0"
          max="1"
          step="0.01"
          bind:value={cube_state.decimate}
          class="num-input"
        />
      </label>

      <button onclick={handle_extract_isosurface} disabled={cube_state.loading}>
        {cube_state.loading ? t('structure.processing') : t('structure.cube_update_isosurface')}
      </button>
    </section>

    <section class="section">
      <h4>{t('structure.cube_slice_plane')}</h4>

      <div class="slice-info">
        {#if cube_state.slice_plane.selected_atoms.length > 0 && cube_state.header}
          <span class="selected-atoms">
            {t('structure.atoms')}:
            {#each cube_state.slice_plane.selected_atoms as idx}
              <span class="atom-tag">
                {atom_symbol(cube_state.header.atoms[idx].atomic_number)}{idx + 1}
              </span>
            {/each}
          </span>
        {:else}
          <span class="hint">{t('structure.cube_select_3_atoms_plane')}</span>
        {/if}
      </div>

      <button
        onclick={toggle_atom_selection}
        class:active={selecting_atoms}
      >
        {selecting_atoms
          ? t('structure.cube_selecting_atoms_count', { n: cube_state.slice_plane.selected_atoms.length })
          : t('structure.cube_pick_atoms')}
      </button>

      {#if cube_state.slice_plane.selected_atoms.length >= 2}
        <label>
          <input type="checkbox" bind:checked={cube_state.slice_plane.show_plane} />
          {t('structure.cube_show_plane_preview')}
        </label>

        <label>
          {t('structure.cube_tilt_x')}
          <input
            type="range"
            min="-90"
            max="90"
            step="1"
            bind:value={cube_state.slice_plane.rotation[0]}
          />
          <span class="angle">{cube_state.slice_plane.rotation[0]}°</span>
        </label>

        <label>
          {t('structure.cube_tilt_y')}
          <input
            type="range"
            min="-90"
            max="90"
            step="1"
            bind:value={cube_state.slice_plane.rotation[1]}
          />
          <span class="angle">{cube_state.slice_plane.rotation[1]}°</span>
        </label>

        <label>
          {t('structure.cube_tilt_z')}
          <input
            type="range"
            min="-90"
            max="90"
            step="1"
            bind:value={cube_state.slice_plane.rotation[2]}
          />
          <span class="angle">{cube_state.slice_plane.rotation[2]}°</span>
        </label>

        <button onclick={handle_extract_plane_slice} disabled={cube_state.loading}>
          {cube_state.loading ? t('structure.cube_extracting') : t('structure.cube_extract_slice')}
        </button>
      {/if}
    </section>

    <section class="section">
      <h4>{t('common.export')}</h4>
      <div class="btn-row">
        <button onclick={() => handle_export(`glb`)} disabled={cube_state.loading}>
          GLB
        </button>
        <button onclick={() => handle_export(`obj`)} disabled={cube_state.loading}>
          OBJ
        </button>
      </div>
    </section>
  {/if}

  {#if cube_state.error}
    <div class="error">{cube_state.error}</div>
  {/if}
</div>

<style>
  .cube-controls {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem;
    font-size: 0.85rem;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
  }
  h4 {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
    opacity: 0.8;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  input[type='range'] {
    flex: 1;
    min-width: 80px;
  }
  .num-input {
    width: 65px;
    padding: 2px 4px;
    font-size: 0.8rem;
  }
  .color-row {
    display: flex;
    gap: 0.75rem;
  }
  input[type='color'] {
    width: 28px;
    height: 22px;
    padding: 0;
    border: 1px solid rgba(128, 128, 128, 0.3);
    cursor: pointer;
  }
  .btn-row {
    display: flex;
    gap: 0.4rem;
  }
  button {
    padding: 4px 10px;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.1);
  }
  button:hover:not(:disabled) {
    background: rgba(128, 128, 128, 0.2);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.active {
    background: rgba(51, 102, 204, 0.2);
    border-color: rgba(51, 102, 204, 0.5);
  }
  .info {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    opacity: 0.7;
  }
  .error {
    color: #cc3333;
    font-size: 0.75rem;
    padding: 4px 8px;
    background: rgba(204, 51, 51, 0.1);
    border-radius: 3px;
  }
  .slice-info {
    font-size: 0.75rem;
  }
  .hint {
    opacity: 0.5;
    font-style: italic;
  }
  .selected-atoms {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .atom-tag {
    background: rgba(51, 102, 204, 0.15);
    border: 1px solid rgba(51, 102, 204, 0.3);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .angle {
    min-width: 32px;
    text-align: right;
    font-size: 0.7rem;
    opacity: 0.7;
  }
</style>
