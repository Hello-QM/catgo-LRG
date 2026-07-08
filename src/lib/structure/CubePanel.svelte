<script lang="ts">
  import { DraggablePane, Icon } from '$lib'
  import type { CubeState, IsosurfaceResult, CubeMesh, CubeAtom } from '$lib/cube'
  import {
    uploadCubeFile,
    extractIsosurface,
    downloadIsosurface,
  } from '$lib/cube'
  import { parse_cube_full, type ParsedCubeData } from '$lib/cube/parse-cube'
  import {
    sample_plane_slice,
    project_atoms_to_plane,
    in_plane_basis,
    rodrigues_rotate,
    normalize,
    cross,
    COLORMAP_NAMES,
    type SliceResult,
    type AtomSliceInfo,
    type ColormapName,
    type Vec3,
  } from '$lib/cube/slice'
  import { extract_isosurface_client, dispose_worker } from '$lib/cube/client'
  import { download } from '$lib/io/fetch'
  import { atomic_radii } from '$lib/structure'
  import { element_data } from '$lib/element'
  import { onDestroy } from 'svelte'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  let {
    pane_open = $bindable(false),
    cube_file = null as File | null,
    positive_mesh = $bindable(null),
    negative_mesh = $bindable(null),
    cube_atoms = $bindable([]),
    selected_sites = [],
    display_positions = [],
    display_elements = [],
    cube_state = $bindable({
      filepath: ``,
      header: null,
      isovalue: 0.05,
      dual: true,
      decimate: 0,
      show_positive: true,
      show_negative: true,
      positive_color: `#3366cc`,
      negative_color: `#cc3333`,
      opacity: 0.7,
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
        colormap: `RdBu` as ColormapName,
      },
      loading: false,
      error: null,
    } as CubeState),
    onslice_data,
    toggle_props = {},
    pane_props = {},
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, `onclose`> & {
    pane_open?: boolean
    cube_file?: File | null
    positive_mesh?: CubeMesh | null
    negative_mesh?: CubeMesh | null
    cube_atoms?: CubeAtom[]
    selected_sites?: number[]
    /** Cartesian positions of ALL displayed atoms (base + PBC images), indexed
     *  to match selected_sites, so a 3-atom plane works when an image is picked. */
    display_positions?: number[][]
    /** Element symbols of ALL displayed atoms (base + PBC images), indexed to
     *  match selected_sites, for the selected-atom tags (image idx is out of
     *  range of the base-only header.atoms). */
    display_elements?: string[]
    cube_state?: CubeState
    onslice_data?: (result: SliceResult, atoms: AtomSliceInfo[]) => void
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    max_height?: string
  } = $props()

  let auto_uploaded = $state(false)
  let file_input: HTMLInputElement = $state(undefined as any)
  let parsed_cube: ParsedCubeData | null = $state(null)

  /** Upload current cube file to server if not yet uploaded (needed for export). */
  async function ensure_server_file(): Promise<boolean> {
    if (cube_state.filepath) return true
    const file = cube_file ?? file_input?.files?.[0]
    if (!file) return false
    try {
      const result = await uploadCubeFile(file)
      cube_state.filepath = result.path
      return true
    } catch (err) {
      cube_state.error = `Server upload failed: ${(err as Error).message}`
      return false
    }
  }

  onDestroy(() => dispose_worker())

  // Auto-load when cube_file is provided
  $effect(() => {
    if (cube_file && !auto_uploaded && !cube_state.filepath && !parsed_cube) {
      auto_uploaded = true
      load_file_client(cube_file)
    }
  })

  // Computed isovalue range from data
  let iso_max = $state(1.0)
  let iso_step = $state(0.001)

  async function load_file_client(file: File) {
    cube_state.loading = true
    cube_state.error = null
    try {
      const text = await file.text()
      parsed_cube = parse_cube_full(text)
      cube_state.header = parsed_cube.header
      cube_atoms = parsed_cube.header.atoms

      // Auto-scale isovalue to data range
      const abs_max = Math.max(Math.abs(parsed_cube.grid.data_min), Math.abs(parsed_cube.grid.data_max))
      if (abs_max > 0) {
        iso_max = abs_max
        cube_state.isovalue = Math.min(cube_state.isovalue, abs_max * 0.1)
        iso_step = abs_max * 0.001
      }

      await extract_isosurface_local()
    } catch (err) {
      cube_state.error = `Parse error: ${(err as Error).message}`
    } finally {
      cube_state.loading = false
    }
  }

  async function upload_and_extract(file: File) {
    cube_state.loading = true
    cube_state.error = null
    try {
      const result = await uploadCubeFile(file)
      cube_state.filepath = result.path
      await handle_extract_isosurface()
    } catch (err) {
      cube_state.error = `Upload failed: ${(err as Error).message}`
    } finally {
      cube_state.loading = false
    }
  }

  async function handle_file_upload() {
    const file = file_input?.files?.[0]
    if (!file) return
    auto_uploaded = true
    await load_file_client(file)
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
      positive_mesh = result.positive
      negative_mesh = result.negative
      cube_atoms = result.header.atoms
    } catch (err) {
      cube_state.error = `Isosurface extraction failed: ${(err as Error).message}`
    } finally {
      cube_state.loading = false
    }
  }

  async function extract_isosurface_local() {
    if (!parsed_cube) return
    cube_state.loading = true
    cube_state.error = null
    try {
      const result = await extract_isosurface_client(
        parsed_cube.grid,
        cube_state.isovalue,
        cube_state.dual,
      )
      positive_mesh = result.positive
      negative_mesh = result.negative
    } catch (err) {
      cube_state.error = `Extraction failed: ${(err as Error).message}`
    } finally {
      cube_state.loading = false
    }
  }

  /**
   * Rotate the slice normal using Rodrigues' rotation around the plane's
   * local U, V, N axes instead of world X, Y, Z.
   */
  function get_rotated_normal(): [number, number, number] {
    const sp = cube_state.slice_plane
    const base_normal = normalize(sp.normal)
    const [u_axis, v_axis] = in_plane_basis(base_normal)
    const [ru, rv, rn] = sp.rotation.map((d) => (d * Math.PI) / 180)

    // Apply rotations sequentially: first around U, then V, then N
    let n: Vec3 = base_normal
    if (Math.abs(ru) > 1e-10) n = rodrigues_rotate(n, u_axis, ru)
    if (Math.abs(rv) > 1e-10) n = rodrigues_rotate(n, v_axis, rv)
    if (Math.abs(rn) > 1e-10) n = rodrigues_rotate(n, base_normal, rn)

    return normalize(n)
  }

  function handle_extract_slice() {
    if (!parsed_cube) return
    cube_state.error = null
    try {
      const sp = cube_state.slice_plane
      let normal: [number, number, number] = sp.normal
      let center: [number, number, number] = sp.center

      if (sp.mode === `custom`) {
        normal = get_rotated_normal()
        const off = sp.offset
        center = [
          sp.center[0] + normal[0] * off,
          sp.center[1] + normal[1] * off,
          sp.center[2] + normal[2] * off,
        ]
      }

      const result = sample_plane_slice(parsed_cube.grid, normal, center)
      if (!result) {
        cube_state.error = `Could not compute slice (degenerate plane?)`
        return
      }

      // Project atoms onto the slice plane
      const atoms = cube_state.header?.atoms ?? []
      const atom_infos = project_atoms_to_plane(
        atoms.map(a => ({ position: a.position, element: atom_symbol(a.atomic_number) })),
        result.normal, result.center, result.u_vec, result.v_vec,
        1.5, // distance threshold in Angstroms
        atomic_radii as Record<string, number>,
      )

      // Emit slice data upward to Structure.svelte for split-view rendering
      onslice_data?.(result, atom_infos)
    } catch (err) {
      cube_state.error = `Slice failed: ${(err as Error).message}`
    }
  }

  // Debounced auto-extract for real-time slider dragging
  let slice_debounce_timer: ReturnType<typeof setTimeout>
  function debounced_slice() {
    clearTimeout(slice_debounce_timer)
    slice_debounce_timer = setTimeout(handle_extract_slice, 50)
  }

  // Custom ▲▼ steppers — native number-input spinners are unreliable
  // (hover-only in Chrome, absent in WebKitGTK), and the user wants always-on
  // up/down arrows. These mutate the bound value, clamp, and re-extract.
  function step_offset(delta: number) {
    const v = Math.round((cube_state.slice_plane.offset + delta) * 10) / 10
    cube_state.slice_plane.offset = Math.min(10, Math.max(-10, v))
    debounced_slice()
  }
  function step_tilt(i: number, delta: number) {
    const v = Math.round((cube_state.slice_plane.rotation[i] ?? 0) + delta)
    cube_state.slice_plane.rotation[i] = Math.min(90, Math.max(-90, v))
    debounced_slice()
  }
  function step_position(delta: number) {
    const v = Math.round((cube_state.slice_plane.position + delta) * 100) / 100
    cube_state.slice_plane.position = Math.min(1, Math.max(0, v))
    debounced_slice()
  }

  // Update normal/center for axis-aligned modes based on position slider and grid info
  $effect(() => {
    const h = cube_state.header
    const sp = cube_state.slice_plane
    if (!h || sp.mode === `custom`) return
    const normals: Record<string, [number, number, number]> = {
      x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
    }
    sp.normal = normals[sp.mode]
    const o = h.origin
    const v = h.voxel_axes
    const d = h.dims
    const t = sp.position
    if (sp.mode === `x`) {
      sp.center = [
        o[0] + t * d[0] * v[0][0] + 0.5 * d[1] * v[1][0] + 0.5 * d[2] * v[2][0],
        o[1] + t * d[0] * v[0][1] + 0.5 * d[1] * v[1][1] + 0.5 * d[2] * v[2][1],
        o[2] + t * d[0] * v[0][2] + 0.5 * d[1] * v[1][2] + 0.5 * d[2] * v[2][2],
      ]
    } else if (sp.mode === `y`) {
      sp.center = [
        o[0] + 0.5 * d[0] * v[0][0] + t * d[1] * v[1][0] + 0.5 * d[2] * v[2][0],
        o[1] + 0.5 * d[0] * v[0][1] + t * d[1] * v[1][1] + 0.5 * d[2] * v[2][1],
        o[2] + 0.5 * d[0] * v[0][2] + t * d[1] * v[1][2] + 0.5 * d[2] * v[2][2],
      ]
    } else if (sp.mode === `z`) {
      sp.center = [
        o[0] + 0.5 * d[0] * v[0][0] + 0.5 * d[1] * v[1][0] + t * d[2] * v[2][0],
        o[1] + 0.5 * d[0] * v[0][1] + 0.5 * d[1] * v[1][1] + t * d[2] * v[2][1],
        o[2] + 0.5 * d[0] * v[0][2] + 0.5 * d[1] * v[1][2] + t * d[2] * v[2][2],
      ]
    }
  })

  // Auto-compute custom slice plane when 3+ atoms are selected.
  // selected_sites are BASE-site indices into the viewer structure; that
  // structure is built 1:1 from header.atoms (cube_atoms_to_molecule maps in
  // order), so the same index addresses the matching cube atom. We read the
  // RAW cube positions (header.atoms[i].position) on purpose: the slice math
  // (sample_plane_slice) lives in the cube's origin+voxel frame, so the plane
  // must be defined there too.
  $effect(() => {
    const atoms = cube_state.header?.atoms
    const sp = cube_state.slice_plane
    // Track selection length explicitly so the effect re-runs as atoms are
    // clicked one-by-one (and fires the moment the 3rd atom lands).
    const sel = selected_sites
    if (!atoms || sp.mode !== `custom` || sel.length < 3) return
    const indices = sel.slice(0, 3)
    // selected_sites can include PBC image-atom indices (>= base atom count) for
    // periodic structures (the user clicked a periodic image). A base-only
    // lookup rejected those (and silently did nothing). Resolve each clicked
    // atom's position from the DISPLAYED positions (base + image, same cube
    // frame), falling back to the base cube atoms when not supplied.
    const pos_of = (i: number): Vec3 | null => {
      if (display_positions.length > i) return display_positions[i] as Vec3
      return i < atoms.length ? (atoms[i].position as Vec3) : null
    }
    const p1 = pos_of(indices[0])
    const p2 = pos_of(indices[1])
    const p3 = pos_of(indices[2])
    if (!p1 || !p2 || !p3) return
    const v1: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
    const v2: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]
    const raw_normal = cross(v1, v2)
    // Guard against three collinear atoms (degenerate plane → cross == ~0).
    if (Math.hypot(...raw_normal) < 1e-8) {
      cube_state.error = `Selected atoms are collinear — pick 3 non-collinear atoms`
      return
    }
    sp.normal = normalize(raw_normal)
    sp.center = [
      (p1[0] + p2[0] + p3[0]) / 3,
      (p1[1] + p2[1] + p3[1]) / 3,
      (p1[2] + p2[2] + p3[2]) / 3,
    ]
    sp.selected_atoms = indices
    sp.rotation = [0, 0, 0]
    sp.show_plane = true
    // X/Y/Z modes only sample the 2D slice when the Position slider fires
    // `oninput`; the custom mode has no such trigger, so selecting 3 atoms used
    // to update only the 3D preview plane (driven reactively from sp.normal/
    // sp.center) and never produced the 2D slice figure. Kick the extract here
    // so the figure appears as soon as the plane is defined.
    debounced_slice()
  })

  async function handle_export(format: `glb` | `obj`) {
    cube_state.loading = true
    if (!(await ensure_server_file())) {
      cube_state.loading = false
      return
    }
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
      download(
        blob,
        `isosurface.${format}`,
        format === `glb` ? `model/gltf-binary` : `model/obj`,
      )
    } catch (err) {
      cube_state.error = `Export failed: ${(err as Error).message}`
    } finally {
      cube_state.loading = false
    }
  }

  let debounce_timer: ReturnType<typeof setTimeout>
  function debounced_extract() {
    clearTimeout(debounce_timer)
    debounce_timer = setTimeout(
      parsed_cube ? extract_isosurface_local : handle_extract_isosurface,
      300,
    )
  }

  // Build atomic number → symbol lookup from element data
  const z_to_symbol: Record<number, string> = Object.fromEntries(
    element_data.map((el) => [el.number, el.symbol]),
  )

  function atom_symbol(z: number): string {
    return z_to_symbol[z] ?? `Z${z}`
  }
</script>

<DraggablePane
  bind:show={pane_open}
  max_width="20em"
  close_on_click_outside={false}
  toggle_props={{
    class: `cube-panel-toggle`,
    title: pane_open ? t('structure.close_cube_file_controls') : t('structure.open_cube_file_controls'),
    ...toggle_props,
  }}
  open_icon="Cross"
  closed_icon="Grid"
  pane_props={{ ...pane_props, class: `cube-panel ${pane_props?.class ?? ``}` }}
  {...rest}
>
  <div class="cube-controls">
    {#if !cube_state.filepath && !parsed_cube}
      <section class="section">
        <h4>{t('structure.cube_file')}</h4>
        <input
          type="file"
          accept=".cube,.cub"
          bind:this={file_input}
          onchange={handle_file_upload}
        />
        {#if cube_state.loading}
          <span class="loading-text">{t('structure.uploading')}</span>
        {/if}
      </section>
    {:else}
      <section class="section">
        <h4>{t('structure.cube_file')}</h4>
        {#if cube_state.header}
          <div class="info">
            <span>{cube_state.header.n_atoms} atoms</span>
            <span>
              {cube_state.header.dims[0]}x{cube_state.header.dims[1]}x{cube_state.header.dims[2]}
            </span>
          </div>
          {#if parsed_cube}
            <div class="info">
              <span>Range: {parsed_cube.grid.data_min.toExponential(2)} to {parsed_cube.grid.data_max.toExponential(2)}</span>
            </div>
          {/if}
        {/if}
      </section>

      <section class="section">
        <h4>Isosurface</h4>
        <label>
          Isovalue
          <input
            type="range"
            min={iso_step}
            max={iso_max}
            step={iso_step}
            bind:value={cube_state.isovalue}
            oninput={debounced_extract}
          />
          <input
            type="number"
            min={iso_step}
            max={iso_max * 10}
            step={iso_step}
            bind:value={cube_state.isovalue}
            class="num-input"
          />
        </label>

        <label>
          <input type="checkbox" bind:checked={cube_state.dual} />
          Show +/- isosurfaces
        </label>

        <label>
          Opacity
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
          Wireframe
        </label>

        <div class="color-row">
          <label>
            + <input type="color" bind:value={cube_state.positive_color} />
          </label>
          {#if cube_state.dual}
            <label>
              - <input type="color" bind:value={cube_state.negative_color} />
            </label>
          {/if}
        </div>

        <button onclick={parsed_cube ? extract_isosurface_local : handle_extract_isosurface} disabled={cube_state.loading}>
          {cube_state.loading ? t('structure.processing') : t('structure.update')}
        </button>
      </section>

      <section class="section">
        <h4>Slice Plane</h4>
        <div class="mode-row">
          {#each [`x`, `y`, `z`, `custom`] as m}
            <button
              class:mode-active={cube_state.slice_plane.mode === m}
              onclick={() => { cube_state.slice_plane.mode = m as any; cube_state.slice_plane.show_plane = true }}
            >
              {m === `custom` ? `3-Atom` : m.toUpperCase()}
            </button>
          {/each}
        </div>

        {#if cube_state.slice_plane.mode !== `custom`}
          <label>
            Position
            <span class="spin-wrap">
              <input
                type="number"
                class="spin-input"
                min="0"
                max="1"
                step="0.01"
                bind:value={cube_state.slice_plane.position}
                oninput={debounced_slice}
              />
              <span class="spin-arrows">
                <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_position(0.01)}>▲</button>
                <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_position(-0.01)}>▼</button>
              </span>
            </span>
          </label>
        {:else}
          <div class="slice-info">
            {#if cube_state.slice_plane.selected_atoms.length > 0 && cube_state.header}
              <span class="selected-atoms">
                {#each cube_state.slice_plane.selected_atoms as idx}
                  <span class="atom-tag">
                    {display_elements[idx]
                      ?? (cube_state.header.atoms[idx]
                        ? atom_symbol(cube_state.header.atoms[idx].atomic_number)
                        : `?`)}{idx + 1}
                  </span>
                {/each}
              </span>
            {:else}
              <span class="hint">Select 3 atoms in viewer</span>
            {/if}
          </div>

          <label>
            Offset
            <span class="spin-wrap">
              <input
                type="number"
                class="spin-input"
                min="-10"
                max="10"
                step="0.1"
                bind:value={cube_state.slice_plane.offset}
                oninput={debounced_slice}
              />
              <span class="spin-arrows">
                <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_offset(0.1)}>▲</button>
                <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_offset(-0.1)}>▼</button>
              </span>
            </span>
            <span class="unit">&Aring;</span>
          </label>

          {#each [`U`, `V`, `N`] as axis, i}
            <label>
              Tilt {axis}
              <span class="spin-wrap">
                <input
                  type="number"
                  class="spin-input"
                  min="-90"
                  max="90"
                  step="1"
                  bind:value={cube_state.slice_plane.rotation[i]}
                  oninput={debounced_slice}
                />
                <span class="spin-arrows">
                  <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_tilt(i, 1)}>▲</button>
                  <button type="button" class="spin-btn" tabindex="-1" onclick={() => step_tilt(i, -1)}>▼</button>
                </span>
              </span>
              <span class="unit">&deg;</span>
            </label>
          {/each}
        {/if}

        <label>
          Colormap
          <select
            class="colormap-select"
            bind:value={cube_state.slice_plane.colormap}
            onchange={debounced_slice}
          >
            {#each COLORMAP_NAMES as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </label>

        <div class="color-row">
          <label>
            Plane <input type="color" bind:value={cube_state.slice_plane.plane_color} />
          </label>
          <label>
            <input type="checkbox" bind:checked={cube_state.slice_plane.show_plane} />
            Preview
          </label>
        </div>
      </section>

      <section class="section">
        <h4>Export</h4>
        <div class="btn-row">
          <button
            onclick={() => handle_export(`glb`)}
            disabled={cube_state.loading}
          >GLB</button>
          <button
            onclick={() => handle_export(`obj`)}
            disabled={cube_state.loading}
          >OBJ</button>
        </div>
      </section>
    {/if}

    {#if cube_state.error}
      <div class="error">{cube_state.error}</div>
    {/if}
  </div>
</DraggablePane>

<style>
  .cube-controls {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    font-size: 0.8rem;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  }
  h4 {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 600;
    opacity: 0.8;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
  }
  input[type='range'] {
    flex: 1;
    min-width: 60px;
  }
  .num-input {
    width: 55px;
    padding: 1px 3px;
    font-size: 0.75rem;
  }
  .spin-wrap {
    flex: 1;
    display: flex;
    align-items: stretch;
    min-width: 60px;
  }
  .spin-input {
    flex: 1;
    min-width: 40px;
    padding: 2px 4px;
    font-size: 0.75rem;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px 0 0 3px;
    background: rgba(128, 128, 128, 0.1);
    color: inherit;
    /* Hide the unreliable native spinner — we provide custom ▲▼ buttons. */
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .spin-input::-webkit-outer-spin-button,
  .spin-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .spin-arrows {
    display: flex;
    flex-direction: column;
  }
  .spin-btn {
    flex: 1;
    width: 16px;
    padding: 0;
    font-size: 0.5rem;
    line-height: 1;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-left: none;
    background: rgba(128, 128, 128, 0.15);
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .spin-btn:first-child { border-radius: 0 3px 0 0; border-bottom: none; }
  .spin-btn:last-child { border-radius: 0 0 3px 0; }
  .spin-btn:hover { background: rgba(128, 128, 128, 0.3); }
  .unit {
    min-width: 14px;
    text-align: left;
    font-size: 0.65rem;
    opacity: 0.7;
  }
  .color-row {
    display: flex;
    gap: 0.75rem;
  }
  input[type='color'] {
    width: 24px;
    height: 18px;
    padding: 0;
    border: 1px solid rgba(128, 128, 128, 0.3);
    cursor: pointer;
  }
  .btn-row {
    display: flex;
    gap: 0.35rem;
  }
  button {
    padding: 3px 8px;
    font-size: 0.75rem;
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
  .mode-row {
    display: flex;
    gap: 0.25rem;
  }
  .mode-row button {
    flex: 1;
    padding: 2px 4px;
    font-size: 0.7rem;
  }
  .mode-active {
    background: rgba(51, 102, 204, 0.2) !important;
    border-color: rgba(51, 102, 204, 0.5) !important;
  }
  .info {
    display: flex;
    gap: 0.75rem;
    font-size: 0.7rem;
    opacity: 0.7;
  }
  .error {
    color: #cc3333;
    font-size: 0.7rem;
    padding: 3px 6px;
    background: rgba(204, 51, 51, 0.1);
    border-radius: 3px;
  }
  .loading-text {
    font-size: 0.7rem;
    opacity: 0.7;
  }
  .slice-info {
    font-size: 0.7rem;
  }
  .hint {
    opacity: 0.5;
    font-style: italic;
  }
  .selected-atoms {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
  }
  .atom-tag {
    background: rgba(51, 102, 204, 0.15);
    border: 1px solid rgba(51, 102, 204, 0.3);
    border-radius: 3px;
    padding: 0px 4px;
    font-size: 0.65rem;
    font-weight: 600;
  }
  .colormap-select {
    flex: 1;
    padding: 2px 4px;
    font-size: 0.7rem;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.1);
    color: inherit;
  }
  .angle {
    min-width: 28px;
    text-align: right;
    font-size: 0.65rem;
    opacity: 0.7;
  }
  input[type='file'] {
    font-size: 0.7rem;
  }
</style>
