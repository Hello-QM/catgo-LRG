<script lang="ts">
  import type { AnyStructure, PymatgenStructure, Vec3 } from '$lib'
  import { DraggablePane, Icon } from '$lib'
  import {
    add_vacuum_layer,
    apply_transform_matrix,
    matrix_to_params,
    reorient_lattice,
    update_lattice_params,
    wrap_molecule_with_lattice_params,
    type LatticeParams
  } from './lattice-ops'
  import { create_supercell_matrix, wasm_reorient_lattice, is_ok } from './ferrox-wasm'
  import {
    make_supercell as make_supercell_ts,
    CPU_SUPERCELL_CELL_WARN_THRESHOLD,
    GPU_SUPERCELL_MAX_INSTANCES,
  } from './supercell'
  import type { Crystal } from './index'
  import type { ComponentProps } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  let {
    structure = $bindable(),
    pane_open = $bindable(false),
    center_camera_trigger = $bindable(0),
    supercell_scaling = $bindable(`1x1x1`),
    large_system_mode = false,
    embedded = false,
    toggle_props = {},
    pane_props = {},
    on_structure_change,
    on_push_undo,
    on_reset_view,
    ...rest
  }: Omit<HTMLAttributes<HTMLDivElement>, 'onclose'> & {
    structure?: AnyStructure
    pane_open?: boolean
    center_camera_trigger?: number
    // Logical supercell factor ("NxNxN"). When the WebGPU overlay is ON, a
    // diagonal-integer transform sets this instead of materializing atoms on the
    // CPU — routing to the GPU instancing path (no freeze).
    supercell_scaling?: string
    // WebGPU large-system overlay state. ON ⇒ diagonal supercell goes to GPU
    // instancing. OFF ⇒ CPU build (guarded against huge factors).
    large_system_mode?: boolean
    embedded?: boolean
    toggle_props?: ComponentProps<typeof DraggablePane>['toggle_props']
    pane_props?: ComponentProps<typeof DraggablePane>['pane_props']
    on_structure_change?: (structure: PymatgenStructure) => void
    on_push_undo?: () => void
    on_reset_view?: () => void
  } = $props()

  // Active tab
  let active_tab: 'params' | 'transform' | 'vacuum' = $state('params')

  // Lattice parameters (editable)
  let params = $state<LatticeParams>({
    a: 1, b: 1, c: 1, alpha: 90, beta: 90, gamma: 90
  })

  // Sync params with structure
  $effect(() => {
    if (structure && 'lattice' in structure && structure.lattice?.matrix) {
      const matrix = structure.lattice.matrix as [Vec3, Vec3, Vec3]
      const extracted = matrix_to_params(matrix)
      params = extracted
    }
  })

  // Transformation matrix
  let transform = $state<[[number, number, number], [number, number, number], [number, number, number]]>([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ])

  // Transform mode: 'lattice_only' keeps atom count, 'supercell' replicates atoms
  let transform_mode: 'lattice_only' | 'supercell' = $state('supercell')

  // Vacuum layer settings
  let vacuum_direction: 'x' | 'y' | 'z' = $state('z')
  let vacuum_thickness = $state(10)
  let vacuum_center = $state(true)

  // New lattice params preview
  let new_c = $derived(
    vacuum_direction === 'z' ? (params.c + vacuum_thickness) :
    vacuum_direction === 'y' ? params.c : params.c
  )

  function apply_params() {
    if (!structure || !has_lattice) return
    on_push_undo?.()
    const new_structure = update_lattice_params(structure as PymatgenStructure, params)
    structure = new_structure
    on_structure_change?.(new_structure)
  }

  let transform_loading = $state(false)

  /** Try WASM reorient_lattice, fall back to TS implementation */
  async function reorient_with_fallback(s: PymatgenStructure): Promise<PymatgenStructure> {
    try {
      const result = await wasm_reorient_lattice(s as Crystal)
      if (is_ok(result)) {
        return result.ok as PymatgenStructure
      }
      console.warn(`[LatticePane] WASM reorient_lattice failed:`, result.error, `— using TS fallback`)
    } catch (err) {
      console.warn(`[LatticePane] WASM reorient_lattice threw:`, err, `— using TS fallback`)
    }
    return reorient_lattice(s)
  }

  // Helper to check if matrix is diagonal (allowing small floating point errors)
  function is_diagonal_matrix(m: typeof transform): boolean {
    const eps = 1e-6
    return Math.abs(m[0][1]) < eps && Math.abs(m[0][2]) < eps &&
           Math.abs(m[1][0]) < eps && Math.abs(m[1][2]) < eps &&
           Math.abs(m[2][0]) < eps && Math.abs(m[2][1]) < eps
  }

  // Helper to check if a value is a positive integer (allowing small fp errors)
  function is_positive_integer(n: number): boolean {
    return Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) >= 1
  }

  // A pure diagonal supercell: diagonal matrix with positive integers on the
  // diagonal ⇒ factors (nx,ny,nz) = (m00,m11,m22). GPU axis-aligned instancing
  // can represent exactly this; non-diagonal / non-integer ⇒ null.
  function diagonal_supercell_factors(
    m: typeof transform,
  ): [number, number, number] | null {
    if (!is_diagonal_matrix(m)) return null
    const [nx, ny, nz] = [m[0][0], m[1][1], m[2][2]]
    if (!is_positive_integer(nx) || !is_positive_integer(ny) || !is_positive_integer(nz)) {
      return null
    }
    return [Math.round(nx), Math.round(ny), Math.round(nz)]
  }

  async function apply_transform() {
    if (!structure || !has_lattice) return

    if (transform_mode === 'supercell') {
      const diag = diagonal_supercell_factors(transform)

      // ── Diagonal-integer supercell: route by overlay state ──────────────────
      if (diag) {
        const [nx, ny, nz] = diag
        const ncells = nx * ny * nz
        const base_sites = (structure as PymatgenStructure).sites?.length ?? 0

        if (large_system_mode) {
          // Overlay ON: skip the CPU expand entirely. Set the logical factor so
          // Structure.svelte's gpu_supercell_active routes to GPU instancing
          // (CPU keeps the base cell — no materialization, no freeze).
          const est_instances = base_sites * ncells
          if (
            est_instances > 0 &&
            est_instances > GPU_SUPERCELL_MAX_INSTANCES
          ) {
            console.warn(
              `[LatticePane] Refusing supercell ${nx}x${ny}x${nz}: ` +
                `~${est_instances.toLocaleString()} GPU instances exceeds the soft cap of ` +
                `${GPU_SUPERCELL_MAX_INSTANCES.toLocaleString()}. Reduce the factor to avoid a GPU hang.`,
            )
            return
          }
          on_push_undo?.()
          supercell_scaling = `${nx}x${ny}x${nz}`
          on_reset_view?.()
          center_camera_trigger++
          transform = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
          return
        }

        // Overlay OFF: a large CPU build would freeze the tab. Guard + warn.
        if (ncells > CPU_SUPERCELL_CELL_WARN_THRESHOLD) {
          console.warn(
            `[LatticePane] Refusing supercell ${nx}x${ny}x${nz} (${ncells} cells): WebGPU ` +
              `large-system mode is OFF, so this would build on the CPU and freeze the tab. ` +
              `Enable WebGPU large-system mode to view without freezing.`,
          )
          return
        }
        // else: small diagonal factor, overlay off ⇒ fall through to CPU build.
      }

      // Use WASM for supercell generation (non-diagonal lattice transform, or a
      // small diagonal factor with the overlay off).
      on_push_undo?.()
      transform_loading = true

      // Helper to apply TypeScript fallback
      const apply_ts_fallback = async () => {
        const [nx, ny, nz] = [transform[0][0], transform[1][1], transform[2][2]]
        console.log(`[LatticePane] Attempting TypeScript fallback with diagonal [${nx}, ${ny}, ${nz}]`)

        if (!is_diagonal_matrix(transform)) {
          console.error(`[LatticePane] Cannot use TypeScript fallback: matrix is not diagonal`)
          console.error(`[LatticePane] Matrix: [[${transform[0].join(',')}], [${transform[1].join(',')}], [${transform[2].join(',')}]]`)
          return false
        }

        const is_integer = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-6
        if (!is_integer(nx) || !is_integer(ny) || !is_integer(nz)) {
          console.error(`[LatticePane] Cannot use TypeScript fallback: diagonal values are not integers`)
          return false
        }

        try {
          const supercell = make_supercell_ts(structure as PymatgenStructure, [Math.round(nx), Math.round(ny), Math.round(nz)])
          const new_structure = await reorient_with_fallback(supercell)
          structure = new_structure
          on_structure_change?.(new_structure)
          console.log('[LatticePane] TypeScript supercell succeeded')
          return true
        } catch (tsError) {
          console.error('[LatticePane] TypeScript supercell failed:', tsError)
          return false
        }
      }

      try {
        const result = await create_supercell_matrix(structure as Crystal, transform)
        if (is_ok(result)) {
          const new_structure = await reorient_with_fallback(result.ok as PymatgenStructure)
          structure = new_structure
          on_structure_change?.(new_structure)
          on_reset_view?.()
          center_camera_trigger++
        } else {
          console.error('[LatticePane] WASM supercell failed:', result.error)
          if (await apply_ts_fallback()) {
            on_reset_view?.()
            center_camera_trigger++
          }
        }
      } catch (error) {
        console.error('[LatticePane] WASM supercell threw exception:', error)
        if (await apply_ts_fallback()) {
          on_reset_view?.()
          center_camera_trigger++
        }
      } finally {
        transform_loading = false
      }
    } else {
      // Lattice-only transform (TypeScript) — also try WASM reorient
      on_push_undo?.()
      const transformed = apply_transform_matrix(structure as PymatgenStructure, transform)
      const new_structure = await reorient_with_fallback(transformed)
      structure = new_structure
      on_structure_change?.(new_structure)
      on_reset_view?.()
      center_camera_trigger++
    }

    // Reset transform matrix
    transform = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }

  function apply_vacuum() {
    if (!structure || !has_lattice) return
    on_push_undo?.()
    const new_structure = add_vacuum_layer(structure as PymatgenStructure, vacuum_direction, vacuum_thickness, vacuum_center)
    structure = new_structure
    on_structure_change?.(new_structure)
  }

  function reset_transform() {
    transform = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  }

  function format_num(val: number): string {
    return val.toFixed(4)
  }

  let has_lattice = $derived(
    !!structure && `lattice` in structure && !!(structure as any).lattice,
  )

  // New lattice params for creating a lattice on a molecule
  let new_lattice_params = $state<LatticeParams>({
    a: 10, b: 10, c: 10, alpha: 90, beta: 90, gamma: 90,
  })
  let new_lattice_padding = $state(5)

  // Auto-compute sensible box from molecule bounding box + padding
  $effect(() => {
    if (!has_lattice && structure?.sites?.length) {
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (const site of structure.sites) {
        const xyz = site.xyz ?? site.abc ?? [0, 0, 0]
        minX = Math.min(minX, xyz[0]); maxX = Math.max(maxX, xyz[0])
        minY = Math.min(minY, xyz[1]); maxY = Math.max(maxY, xyz[1])
        minZ = Math.min(minZ, xyz[2]); maxZ = Math.max(maxZ, xyz[2])
      }
      const pad = new_lattice_padding
      new_lattice_params = {
        a: Math.max(maxX - minX + 2 * pad, 1),
        b: Math.max(maxY - minY + 2 * pad, 1),
        c: Math.max(maxZ - minZ + 2 * pad, 1),
        alpha: 90, beta: 90, gamma: 90,
      }
    }
  })

  function create_lattice() {
    if (!structure?.sites) return
    on_push_undo?.()
    const new_structure = wrap_molecule_with_lattice_params(structure, new_lattice_params)
    structure = new_structure
    on_structure_change?.(new_structure)
    center_camera_trigger++
  }
</script>

{#snippet pane_content()}
  <h4 style="margin-top: 0">{t('structure.lattice_editor')}</h4>

  {#if !has_lattice}
    <section>
      <p class="no-lattice">{t('structure.no_lattice_defined')}</p>

      <h5>{t('structure.cell_parameters')}</h5>
      <div class="param-row">
        <label>{t('structure.padding')}</label>
        <input type="number" step="1" min="0" bind:value={new_lattice_padding} style="width: 5em" />
        <span>A</span>
      </div>

      <h5>{t('structure.lattice_lengths')}</h5>
      <div class="param-row">
        <label>a</label>
        <input type="number" step="0.1" bind:value={new_lattice_params.a} />
      </div>
      <div class="param-row">
        <label>b</label>
        <input type="number" step="0.1" bind:value={new_lattice_params.b} />
      </div>
      <div class="param-row">
        <label>c</label>
        <input type="number" step="0.1" bind:value={new_lattice_params.c} />
      </div>

      <h5>{t('structure.lattice_angles')}</h5>
      <div class="param-row">
        <label>alpha</label>
        <input type="number" step="1" bind:value={new_lattice_params.alpha} />
      </div>
      <div class="param-row">
        <label>beta</label>
        <input type="number" step="1" bind:value={new_lattice_params.beta} />
      </div>
      <div class="param-row">
        <label>gamma</label>
        <input type="number" step="1" bind:value={new_lattice_params.gamma} />
      </div>

      <button class="apply-btn" onclick={create_lattice} disabled={!structure?.sites?.length}>
        {t('structure.create_lattice')}
      </button>
    </section>
  {:else}
    <!-- Tab buttons -->
    <div class="tab-bar">
      <button
        class:active={active_tab === 'params'}
        onclick={() => active_tab = 'params'}
      >
        {t('structure.parameters')}
      </button>
      <button
        class:active={active_tab === 'transform'}
        onclick={() => active_tab = 'transform'}
      >
        {t('structure.transform')}
      </button>
      <button
        class:active={active_tab === 'vacuum'}
        onclick={() => active_tab = 'vacuum'}
      >
        {t('structure.vacuum')}
      </button>
    </div>

    {#if active_tab === 'params'}
      <section>
        <h5>{t('structure.lattice_lengths')}</h5>
        <div class="param-row">
          <label>a</label>
          <input type="number" step="0.01" bind:value={params.a} />
        </div>
        <div class="param-row">
          <label>b</label>
          <input type="number" step="0.01" bind:value={params.b} />
        </div>
        <div class="param-row">
          <label>c</label>
          <input type="number" step="0.01" bind:value={params.c} />
        </div>
      </section>

      <section>
        <h5>{t('structure.lattice_angles')}</h5>
        <div class="param-row">
          <label>alpha</label>
          <input type="number" step="0.1" bind:value={params.alpha} />
        </div>
        <div class="param-row">
          <label>beta</label>
          <input type="number" step="0.1" bind:value={params.beta} />
        </div>
        <div class="param-row">
          <label>gamma</label>
          <input type="number" step="0.1" bind:value={params.gamma} />
        </div>
      </section>

      <button class="apply-btn" onclick={apply_params} disabled={!structure}>
        {t('structure.apply_parameters')}
      </button>
    {:else if active_tab === 'transform'}
      <section>
        <h5>{t('structure.transform_mode')}</h5>
        <div class="button-group">
          <button
            class:active={transform_mode === 'supercell'}
            onclick={() => transform_mode = 'supercell'}
            title={t('structure.supercell_hint')}
          >
            {t('structure.supercell')}
          </button>
          <button
            class:active={transform_mode === 'lattice_only'}
            onclick={() => transform_mode = 'lattice_only'}
            title={t('structure.lattice_only_hint')}
          >
            {t('structure.lattice_only')}
          </button>
        </div>
        <p class="hint">
          {transform_mode === 'supercell'
            ? t('structure.supercell_hint')
            : t('structure.lattice_only_hint')}
        </p>
      </section>

      <section>
        <h5>{t('structure.transformation_matrix')}</h5>
        <p class="hint">{t('structure.transformation_matrix_hint')}</p>
        <div class="matrix-grid">
          {#each [0, 1, 2] as row}
            <div class="matrix-row">
              {#each [0, 1, 2] as col}
                <input
                  type="number"
                  step="1"
                  bind:value={transform[row][col]}
                  class="matrix-cell"
                />
              {/each}
            </div>
          {/each}
        </div>
        <div class="matrix-actions">
          <button class="secondary-btn" onclick={reset_transform}>
            {t('structure.reset_to_identity')}
          </button>
        </div>
      </section>

      <section class="preset-transforms">
        <h5>{t('structure.presets')}</h5>
        <div class="preset-grid">
          <button
            onclick={() => transform = [[1, 0, 0], [0, 1, 0], [0, 0, 2]]}
            title="Double the c parameter"
          >
            2x c
          </button>
          <button
            onclick={() => transform = [[2, 0, 0], [0, 2, 0], [0, 0, 1]]}
            title="Create 2x2 supercell in ab plane"
          >
            2x2 ab
          </button>
          <button
            onclick={() => transform = [[2, 0, 0], [0, 2, 0], [0, 0, 2]]}
            title="Create 2x2x2 supercell"
          >
            2x2x2
          </button>
          <button
            onclick={() => transform = [[1, 1, 0], [-1, 1, 0], [0, 0, 1]]}
            title="Rotate 45 deg in ab plane"
          >
            45 deg ab
          </button>
        </div>
      </section>

      <button class="apply-btn" onclick={apply_transform} disabled={!structure || transform_loading}>
        {transform_loading ? t('common.applying') : t('structure.apply_transform')}
      </button>
    {:else if active_tab === 'vacuum'}
      <section>
        <h5>{t('structure.direction')}</h5>
        <div class="button-group">
          <button
            class:active={vacuum_direction === 'x'}
            onclick={() => vacuum_direction = 'x'}
          >
            X
          </button>
          <button
            class:active={vacuum_direction === 'y'}
            onclick={() => vacuum_direction = 'y'}
          >
            Y
          </button>
          <button
            class:active={vacuum_direction === 'z'}
            onclick={() => vacuum_direction = 'z'}
          >
            Z
          </button>
        </div>
      </section>

      <section>
        <h5>{t('structure.vacuum_thickness')}</h5>
        <div class="param-row">
          <input
            type="number"
            step="1"
            min="0"
            bind:value={vacuum_thickness}
            style="width: 6em"
          />
          <span>A</span>
        </div>
      </section>

      <section>
        <label class="checkbox-row">
          <input type="checkbox" bind:checked={vacuum_center} />
          <span>{t('structure.center_structure')}</span>
        </label>
      </section>

      <section class="preview">
        <h5>{t('common.preview')}</h5>
        <div class="preview-row">
          <span>{t('common.current')} {vacuum_direction}:</span>
          <span>{format_num(params[vacuum_direction === 'x' ? 'a' : vacuum_direction === 'y' ? 'b' : 'c'])} A</span>
        </div>
        <div class="preview-row">
          <span>{t('common.new')} {vacuum_direction}:</span>
          <span class="highlight">
            {format_num(
              (vacuum_direction === 'x' ? params.a :
               vacuum_direction === 'y' ? params.b : params.c) + vacuum_thickness
            )} A
          </span>
        </div>
      </section>

      <button class="apply-btn" onclick={apply_vacuum} disabled={!structure || !(vacuum_thickness > 0)}>
        {t('structure.add_vacuum_layer')}
      </button>
    {/if}
  {/if}
{/snippet}

{#if !embedded}
  <DraggablePane
    bind:show={pane_open}
    show_toggle={!embedded}
    max_width="22em"
    toggle_props={{
      class: 'lattice-pane-toggle',
      title: `${pane_open ? 'Close' : 'Open'} lattice editor`,
      ...toggle_props,
    }}
    open_icon="Cross"
    closed_icon="Lattice"
    pane_props={{ ...pane_props, class: `lattice-pane ${pane_props?.class ?? ''}` }}
    {...rest}
  >
    {@render pane_content()}
  </DraggablePane>
{:else}
  {@render pane_content()}
{/if}

<style>
  .no-lattice {
    color: var(--warning-color, #f59e0b);
    padding: 1em;
    background: rgba(245, 158, 11, 0.1);
    border-radius: 4px;
  }
  .tab-bar {
    grid-template-columns: repeat(3, 1fr);
  }
  .param-row {
    margin-bottom: 4px;
  }
  .param-row label {
    width: 4em;
  }
  .param-row input {
    flex: 1;
    padding: 4px 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.2);
    color: inherit;
    border-radius: 4px;
  }
  .matrix-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .matrix-row {
    display: flex;
    gap: 4px;
  }
  .matrix-cell {
    width: 4em;
    padding: 4px;
    text-align: center;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.2);
    color: inherit;
    border-radius: 4px;
  }
  .matrix-actions {
    margin-top: 8px;
  }
  .preset-transforms {
    margin-top: 1em;
  }
  .preset-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
  }
  .preset-grid button {
    padding: 6px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
  }
  .preset-grid button:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }
  .button-group button {
    padding: 6px 10px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .button-group button:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }
  .button-group button.active {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
  }
  .checkbox-row input {
    accent-color: var(--accent-color, #007acc);
  }
  .preview {
    background: var(--pane-preview-bg, rgba(255, 255, 255, 0.05));
    border-radius: 4px;
    padding: 8px;
  }
  .preview-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
  }
  .highlight {
    color: var(--accent-color, #007acc);
    font-weight: bold;
  }
</style>
