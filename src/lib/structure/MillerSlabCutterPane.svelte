<script lang="ts">
  /**
   * Miller Slab Cutter Control Pane
   *
   * Full UI for the bulk -> slab cutting tool with:
   * - Miller index (hkl) input with presets
   * - Offset slider for plane position
   * - Thickness control: by layers OR by Angstroms (linked)
   * - In-plane supercell expansion (1×1, 2×2, 3×3)
   * - Real-time slab preview
   * - Apply button with construction animation
   * - Docked panel (doesn't auto-close)
   */
  import type { PymatgenStructure, Vec3 } from '$lib'
  import { Icon } from '$lib'
  import type { Matrix3x3 } from '$lib/math'
  import type { Crystal } from '$lib/structure'
  import type { MoyoDataset } from '@spglib/moyo-wasm'
  import type { CellType } from '$lib/symmetry/cell-transform'
  import { get_conventional_cell } from '$lib/symmetry/cell-transform'
  import { analyze_structure_symmetry } from '$lib/symmetry'
  import {
    animate_visibility,
    compute_slab_bounds,
    compute_slab_preview,
    detect_layers,
    generate_preview_slab,
    get_bounds_along_normal,
    miller_to_normal,
    MILLER_PRESETS,
    thickness_for_layers_physical,
    validate_miller,
    type AtomLayer,
    type AtomVisibility,
    type CuttingPlaneConfig,
    type GrowthMode,
    type MillerIndex,
    type SlabPreview,
    type SlabPreviewStructure
  } from './miller-slab'
  import {
    wasm_generate_slab, wasm_generate_slab_layers, wasm_slab_termination_info,
    is_ok, type WasmGrowthMode, type SlabTermination,
  } from './ferrox-wasm'
  import { matrix_to_params, ensure_right_handed } from './lattice-ops'
  import { deduplicate_periodic_images } from './pbc'
  import type { HTMLAttributes } from 'svelte/elements'

  let {
    structure = $bindable(),
    // Original bulk structure (managed by parent via pbc check).
    // After slab cut, `structure` becomes a slab (pbc[2]=false, reoriented + vacuum).
    // All slab computations must use bulk_structure to get correct results.
    bulk_structure = null,
    pane_open = $bindable(false),
    // Cutting plane visualization state (exposed for StructureScene)
    cutting_active = $bindable(false),
    plane_normal = $bindable<Vec3>([0, 0, 1]),
    plane_offset = $bindable(0),
    plane_thickness = $bindable(5),
    atom_visibility = $bindable<AtomVisibility[]>([]),
    flash_intensity = $bindable(0),
    animation_phase = $bindable<'idle' | 'preview' | 'applying' | 'transitioning'>('idle'),
    miller_label = $bindable('(001)'),
    // WYSIWYG slab preview (exposed for StructureScene)
    slab_preview = $bindable<SlabPreviewStructure | null>(null),
    preview_mode = $bindable<'slab'>('slab'),  // Always slab mode
    // Display options
    show_bonds_in_preview = $bindable(true),
    // Undo callback
    on_push_undo,
    // Callbacks
    on_structure_change,
    on_camera_transition,
    on_reset_view,
    symmetry_data = null,
    cell_type = `original`,
    on_symmetry_data_change,
    embedded = false,
  }: Omit<HTMLAttributes<HTMLDivElement>, 'onclose'> & {
    structure?: PymatgenStructure
    bulk_structure?: PymatgenStructure | null
    pane_open?: boolean
    cutting_active?: boolean
    plane_normal?: Vec3
    plane_offset?: number
    plane_thickness?: number
    atom_visibility?: AtomVisibility[]
    flash_intensity?: number
    animation_phase?: 'idle' | 'preview' | 'applying' | 'transitioning'
    miller_label?: string
    slab_preview?: SlabPreviewStructure | null
    preview_mode?: 'slab'
    show_bonds_in_preview?: boolean
    on_push_undo?: () => void
    on_structure_change?: (structure: PymatgenStructure) => void
    on_camera_transition?: (from_bulk: boolean) => void
    on_reset_view?: () => void
    symmetry_data?: MoyoDataset | null
    cell_type?: CellType
    on_symmetry_data_change?: (data: MoyoDataset) => void
    embedded?: boolean
  } = $props()

  // Conventional cell auto-conversion state
  let use_conventional = $state(true)
  let conv_loading = $state(false)
  let conv_error = $state<string | null>(null)
  let conv_structure = $state<PymatgenStructure | null>(null)
  // Generation counter to discard stale async results (not reactive — plain variable)
  let conv_gen = 0

  // Use bulk_structure for all slab computations (deriveds, preview, apply).
  // Falls back to structure if bulk_structure not provided.
  // If use_conventional is on and we have a converted structure, use it.
  let base_structure = $derived<PymatgenStructure | undefined>(bulk_structure ?? structure)
  let calc_structure = $derived<PymatgenStructure | undefined>(
    use_conventional && conv_structure ? conv_structure : base_structure
  )

  // Miller index input
  let h = $state(0)
  let k = $state(0)
  let l = $state(1)

  // Local slider values (for responsive updates)
  let local_offset = $state(0)
  let local_thickness = $state(5)

  // Thickness mode: 'angstrom' or 'layers'
  let thickness_mode = $state<'angstrom' | 'layers'>('angstrom')
  let layer_count = $state(3)

  // Termination selection (WASM-based, accurate layer detection in rotated frame)
  let terminations = $state<SlabTermination[]>([])
  let termination_index = $state(0)

  // Growth mode: controls which direction thickness expands from offset
  let growth_mode = $state<GrowthMode>('anchor_minus_z')

  // Current surface layer tracking
  let current_surface_layer = $state<number | null>(null)

  // Supercell expansion
  let supercell_a = $state(1)
  let supercell_b = $state(1)

  // Vacuum layer
  let vacuum = $state(15)

  // Derived values
  let miller_index = $derived<MillerIndex>([h, k, l])
  let is_valid = $derived(validate_miller(miller_index))
  let has_lattice = $derived(!!structure?.lattice)

  // Auto-convert to conventional cell when pane opens or structure changes
  async function ensure_conventional() {
    const src = base_structure
    if (!src?.lattice) return

    const my_gen = ++conv_gen
    conv_loading = true
    conv_error = null
    try {
      let sym = symmetry_data
      if (!sym) {
        sym = await analyze_structure_symmetry(src as Crystal, {})
        if (conv_gen !== my_gen) return // stale — structure changed during async work
        on_symmetry_data_change?.(sym)
      }
      const conv = get_conventional_cell(src as Crystal, sym) as PymatgenStructure
      if (conv_gen !== my_gen) return // stale
      conv_structure = conv
    } catch (err) {
      if (conv_gen !== my_gen) return // stale
      console.error(`Conventional cell conversion failed:`, err)
      conv_error = err instanceof Error ? err.message : String(err)
      conv_structure = null
    } finally {
      if (conv_gen === my_gen) {
        conv_loading = false
      }
    }
  }

  // Clear cached conventional cell when base structure changes.
  // Also reset conv_loading so the auto-trigger effect can re-fire
  // (otherwise a stale in-flight ensure_conventional blocks re-trigger).
  $effect(() => {
    void base_structure
    conv_structure = null
    conv_error = null
    conv_loading = false
  })

  // Auto-run conventional cell conversion when enabled and pane is open
  // Guard: skip if previous attempt failed (prevents infinite retry loop)
  $effect(() => {
    if (use_conventional && pane_open && has_lattice && !conv_structure && !conv_loading && !conv_error) {
      ensure_conventional()
    }
  })

  // Update miller label when h, k, l change
  $effect(() => {
    miller_label = `(${h}${k}${l})`
  })

  // Detect layers when miller index or structure changes (but not during commit)
  let layers = $derived.by<AtomLayer[]>(() => {
    if (!calc_structure?.lattice || !is_valid || is_committing) return []
    const lattice = calc_structure.lattice.matrix as Matrix3x3
    const normal = miller_to_normal(miller_index, lattice)
    return detect_layers(calc_structure, normal)
  })

  // Fetch termination info from WASM (accurate rotated-frame layer detection)
  let term_counter = 0
  $effect(() => {
    const _m = miller_index
    const struct = calc_structure
    if (!struct?.lattice || !is_valid || is_committing) {
      terminations = []
      return
    }
    const my_id = ++term_counter
    wasm_slab_termination_info(struct, _m).then(result => {
      if (term_counter !== my_id) return
      if (is_ok(result)) {
        terminations = result.ok
        if (termination_index >= result.ok.length) termination_index = 0
      } else {
        terminations = []
      }
    }).catch((e) => {
      console.debug(`[MillerSlabCutter] Termination info fetch failed:`, e)
      if (term_counter === my_id) terminations = []
    })
  })

  // Auto-sync layer_count to the detected layer count — but ONLY when the
  // structure or miller index actually changes. The previous unconditional
  // reset clobbered a user-chosen count (e.g. 6 layers via bulk replication)
  // back to the 1× detected count whenever `layers` re-derived for an unrelated
  // reason, so Apply Cut then generated the wrong (fewer) layers.
  let _layer_sync_key = $state('')
  $effect(() => {
    const key = `${h},${k},${l}|${calc_structure?.sites?.length ?? 0}`
    if (layers.length > 0 && key !== _layer_sync_key) {
      _layer_sync_key = key
      layer_count = layers.length
    }
  })

  // Error message for user feedback
  let error_message = $state<string | null>(null)

  // Replication tracking for physical layer mode
  let replication_count = $state(1)
  let available_layers = $state(0)

  // Compute preview when parameters change (but not during commit)
  let preview = $derived.by<SlabPreview | null>(() => {
    if (!calc_structure?.lattice || !is_valid || is_committing) return null
    try {
      return compute_slab_preview(calc_structure, {
        miller_index,
        offset: local_offset,
        thickness: local_thickness,
        vacuum,
        growth_mode
      })
    } catch (err) {
      console.warn('Error computing slab preview:', err)
      return null
    }
  })

  // Included layers based on current thickness and growth mode (but not during commit)
  let included_layers = $derived.by<AtomLayer[]>(() => {
    if (layers.length === 0 || is_committing) return []
    const { lower, upper } = compute_slab_bounds(local_offset, local_thickness, growth_mode)
    return layers.filter(l => l.distance >= lower && l.distance <= upper)
  })

  // Flag to prevent reactive effects from running during structure commit
  let is_committing = $state(false)

  // WYSIWYG slab preview — TS for fast real-time interaction
  // Apply uses WASM with primitive reduction + c⊥ab orthogonalization
  let computed_slab_preview = $derived.by<SlabPreviewStructure | null>(() => {
    if (!calc_structure?.lattice || !is_valid || is_committing) return null
    try {
      return generate_preview_slab(calc_structure, {
        miller_index,
        offset: local_offset,
        thickness: local_thickness,
        vacuum,
        growth_mode,
        supercell: [supercell_a, supercell_b]
      })
    } catch (err) {
      console.warn('Error generating slab preview:', err)
      return null
    }
  })

  // Compute bounds for sliders when miller index changes (but not during commit)
  let bounds = $derived.by<[number, number]>(() => {
    if (!calc_structure?.lattice || !is_valid || is_committing) return [0, 10]
    const lattice = calc_structure.lattice.matrix as Matrix3x3
    const normal = miller_to_normal(miller_index, lattice)
    return get_bounds_along_normal(calc_structure, normal)
  })

  let min_offset = $derived(bounds[0] - 2)
  let max_offset = $derived(bounds[1] + 2)
  let offset_range = $derived(max_offset - min_offset)

  // Reset offset to center when miller index changes (but not during commit)
  $effect(() => {
    if (is_valid && calc_structure?.lattice && !is_committing) {
      const mid = (bounds[0] + bounds[1]) / 2
      local_offset = mid
    }
  })

  // Sync layer count to thickness when mode is 'layers' (but not during commit)
  $effect(() => {
    if (thickness_mode === 'layers' && calc_structure?.lattice && !is_committing) {
      const result = thickness_for_layers_physical(
        calc_structure,
        miller_index,
        local_offset,
        layer_count,
        growth_mode
      )
      if (result.thickness > 0) {
        local_thickness = result.thickness
        replication_count = result.replication_count
        available_layers = result.total_available_layers
      }
    }
  })

  // Update external state when local values change
  $effect(() => {
    if (preview) {
      plane_normal = preview.normal
      plane_offset = local_offset
      plane_thickness = local_thickness
      // Apply animation to atom visibility based on fade progress
      atom_visibility = animate_visibility(preview.atom_visibility, outside_fade_progress)
    }
  })

  // Update slab preview for WYSIWYG visualization
  $effect(() => {
    slab_preview = computed_slab_preview
  })

  // Activate cutting mode when pane opens
  $effect(() => {
    cutting_active = pane_open && is_valid && has_lattice
    if (pane_open && is_valid && has_lattice) {
      animation_phase = 'preview'
      // Start fade animation when pane opens to preview which atoms will be removed
      setTimeout(() => start_fade_animation(), 200)
    } else if (!pane_open) {
      animation_phase = 'idle'
      flash_intensity = 0
      reset_fade_animation()
    }
  })

  // Animation state for outside atoms
  let outside_fade_progress = $state(0)
  let fade_animation_id: number | null = null

  function start_fade_animation() {
    if (fade_animation_id) cancelAnimationFrame(fade_animation_id)

    const duration = 800 // ms
    const start_time = performance.now()

    const animate = (current_time: number) => {
      const elapsed = current_time - start_time
      outside_fade_progress = Math.min(1, elapsed / duration)

      if (outside_fade_progress < 1) {
        fade_animation_id = requestAnimationFrame(animate)
      }
    }

    fade_animation_id = requestAnimationFrame(animate)
  }

  function reset_fade_animation() {
    if (fade_animation_id) {
      cancelAnimationFrame(fade_animation_id)
      fade_animation_id = null
    }
    outside_fade_progress = 0
  }

  // Apply preset
  function apply_preset(hkl: MillerIndex) {
    on_push_undo?.()
    h = hkl[0]
    k = hkl[1]
    l = hkl[2]
    reset_fade_animation()
  }

  // Apply the cut and generate slab
  async function apply_cut() {
    const source = calc_structure
    if (animation_phase === 'applying') return
    if (!source) {
      error_message = `No structure available for slab cutting`
      return
    }
    if (!is_valid) {
      error_message = `Miller indices (${h},${k},${l}) are invalid`
      return
    }

    error_message = null
    on_push_undo?.()
    animation_phase = 'applying'

    // Step 1: Flash effect
    flash_intensity = 1
    await new Promise(r => setTimeout(r, 150))
    flash_intensity = 0
    await new Promise(r => setTimeout(r, 100))
    flash_intensity = 0.8
    await new Promise(r => setTimeout(r, 100))
    flash_intensity = 0

    // Step 2: Generate new slab structure using WASM backend
    try {
      // Use layer-based generation when in layers mode (accurate layer counting)
      const result = thickness_mode === 'layers'
        ? await wasm_generate_slab_layers(source, miller_index, {
            num_layers: layer_count,
            termination_index,
            vacuum,
            supercell: [supercell_a, supercell_b],
          })
        : await wasm_generate_slab(source, miller_index, {
            offset: local_offset,
            thickness: local_thickness,
            vacuum,
            growth_mode: growth_mode as WasmGrowthMode,
            supercell: [supercell_a, supercell_b],
          })

      if (!is_ok(result)) {
        throw new Error(result.error)
      }

      const wasm_structure = result.ok

      // Compute lattice parameters from matrix (WASM may not return these)
      // Also ensure right-handed lattice for VASP compatibility
      let new_structure = wasm_structure
      if (wasm_structure?.lattice?.matrix) {
        const raw_matrix = wasm_structure.lattice.matrix as [Vec3, Vec3, Vec3]
        const { matrix, swapped } = ensure_right_handed(raw_matrix)
        const params = matrix_to_params(matrix)

        // Compute volume from matrix
        const [va, vb, vc] = matrix
        const cross_bc: Vec3 = [
          vb[1] * vc[2] - vb[2] * vc[1],
          vb[2] * vc[0] - vb[0] * vc[2],
          vb[0] * vc[1] - vb[1] * vc[0]
        ]
        const volume = Math.abs(va[0] * cross_bc[0] + va[1] * cross_bc[1] + va[2] * cross_bc[2])

        // If a/b were swapped, swap fractional coordinates for all sites
        const sites = swapped && wasm_structure.sites
          ? wasm_structure.sites.map((s: any) => ({
              ...s,
              abc: s.abc ? [s.abc[1], s.abc[0], s.abc[2]] : s.abc,
            }))
          : wasm_structure.sites

        new_structure = {
          ...wasm_structure,
          sites,
          lattice: {
            ...wasm_structure.lattice,
            matrix,
            a: params.a,
            b: params.b,
            c: params.c,
            alpha: params.alpha,
            beta: params.beta,
            gamma: params.gamma,
            volume,
            // Slabs are periodic in X/Y but not Z (vacuum direction)
            pbc: [true, true, false] as [boolean, boolean, boolean]
          }
        }
      }

      // Deduplicate atoms that are periodic images of each other
      // This is needed because slab cutting may create duplicate atoms at periodic boundaries
      new_structure = deduplicate_periodic_images(new_structure as any) as typeof new_structure

      // Step 3: Transition animation
      animation_phase = 'transitioning'
      on_camera_transition?.(true)

      await new Promise(r => setTimeout(r, 500))

      // Set committing flag to prevent reactive cascades from interfering
      is_committing = true

      // Update structure (bulk_structure is managed by parent via pbc check)
      structure = new_structure
      on_structure_change?.(new_structure)
      on_reset_view?.()

      // Close pane after successful cut
      await new Promise(r => setTimeout(r, 300))
      pane_open = false
      animation_phase = 'idle'

      // Reset committing flag after a tick to allow bindings to settle
      await new Promise(r => setTimeout(r, 50))
      is_committing = false

    } catch (err) {
      console.error('Error generating slab:', err)
      error_message = `Slab generation failed: ${err instanceof Error ? err.message : String(err)}`
      animation_phase = 'preview'
    }
  }

  // Format number for display
  function fmt(val: number, decimals: number = 2): string {
    return val.toFixed(decimals)
  }

  // Snap offset to nearest layer (always enabled)
  function snap_offset_to_layer(raw_offset: number): number {
    if (layers.length === 0) return raw_offset

    // Find the closest layer to the raw offset
    let closest = layers[0]
    let min_dist = Math.abs(layers[0].distance - raw_offset)

    for (const layer of layers) {
      const dist = Math.abs(layer.distance - raw_offset)
      if (dist < min_dist) {
        min_dist = dist
        closest = layer
      }
    }

    // Update current surface layer indicator
    current_surface_layer = closest.layer_idx

    // Only snap if within reasonable distance (half the average layer spacing)
    const avg_spacing = layers.length > 1
      ? (layers[layers.length - 1].distance - layers[0].distance) / (layers.length - 1)
      : 1

    if (min_dist < avg_spacing * 0.5) {
      return closest.distance
    }

    return raw_offset
  }

  // Handle layer pick from atom click (exposed callback)
  function handle_layer_pick(site_idx: number) {
    const layer = layers.find(l => l.site_indices.includes(site_idx))
    if (layer) {
      local_offset = layer.distance
      current_surface_layer = layer.layer_idx
      start_fade_animation()
    }
  }

  // RAF + throttling for 60 FPS slider updates
  let raf_id: number | null = null
  let precision_timeout: ReturnType<typeof setTimeout> | null = null
  const HEAVY_COMPUTE_THROTTLE_MS = 50

  // Pending values for RAF batching
  let pending_offset: number | null = null
  let pending_thickness: number | null = null
  let last_heavy_update = 0

  function schedule_raf_update() {
    if (raf_id !== null) return // Already scheduled

    raf_id = requestAnimationFrame(() => {
      raf_id = null

      // Apply pending offset (always snap to layers)
      if (pending_offset !== null) {
        const val = snap_offset_to_layer(pending_offset)
        local_offset = val
        plane_offset = val
        pending_offset = null
      }

      // Apply pending thickness
      if (pending_thickness !== null) {
        local_thickness = pending_thickness
        plane_thickness = pending_thickness
        pending_thickness = null
      }

      // Throttled heavy recomputation (visibility, preview)
      const now = performance.now()
      if (now - last_heavy_update > HEAVY_COMPUTE_THROTTLE_MS) {
        last_heavy_update = now
        // Visibility is already computed via $derived, this just triggers re-render
      }
    })
  }

  function schedule_precision_update() {
    if (precision_timeout) clearTimeout(precision_timeout)
    precision_timeout = setTimeout(() => {
      start_fade_animation()
    }, 150)
  }

  function on_offset_input(e: Event) {
    const raw_val = parseFloat((e.target as HTMLInputElement).value)
    pending_offset = raw_val
    schedule_raf_update()
    schedule_precision_update()
  }

  function on_thickness_input(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value)
    pending_thickness = val
    // Switch to angstrom mode when manually adjusting thickness
    thickness_mode = 'angstrom'
    schedule_raf_update()
    schedule_precision_update()
  }

  function on_layer_count_change(delta: number) {
    on_push_undo?.()
    // No upper limit - virtual layers allow infinite extension
    const new_count = Math.max(1, layer_count + delta)
    layer_count = new_count
    thickness_mode = 'layers'
    start_fade_animation()
  }

  function set_supercell(a: number, b: number) {
    on_push_undo?.()
    supercell_a = a
    supercell_b = b
  }

  // Cleanup
  $effect(() => {
    return () => {
      if (fade_animation_id) cancelAnimationFrame(fade_animation_id)
      if (raf_id) cancelAnimationFrame(raf_id)
      if (precision_timeout) clearTimeout(precision_timeout)
    }
  })
</script>

{#snippet pane_content()}
    <div class="pane-header">
      <h4>Slab Cutter</h4>
      <div class="header-right">
        <span class="phase-indicator" class:active={animation_phase === 'applying'}>
          {#if animation_phase === 'applying'}
            Cutting...
          {:else if animation_phase === 'transitioning'}
            Done
          {:else}
            Preview
          {/if}
        </span>
        <button class="close-btn" onclick={() => pane_open = false} title="Close panel">×</button>
      </div>
    </div>

    {#if !has_lattice}
      <p class="no-lattice">
        No lattice defined. This tool requires a crystalline structure with periodic boundary conditions.
      </p>
    {:else}
      <!-- Conventional cell toggle + warning -->
      <div class="conv-cell-section">
        <label class="conv-toggle">
          <input type="checkbox" bind:checked={use_conventional} />
          <span>Use conventional cell</span>
        </label>
        {#if use_conventional}
          {#if conv_loading}
            <div class="conv-banner info">
              <span class="spinner-small"></span>
              Converting to conventional cell...
            </div>
          {:else if conv_error}
            <div class="conv-banner error">
              Conversion failed: {conv_error}
            </div>
          {:else if conv_structure}
            <div class="conv-banner success">
              Using conventional cell ({conv_structure.sites.length} atoms)
            </div>
          {/if}
        {/if}
      </div>

      <!-- Step A: Miller Index Input -->
      <section class="step">
        <div class="step-header">
          <span class="step-badge">A</span>
          <h5>Cutting Plane (hkl)</h5>
        </div>

        <div class="miller-input">
          <div class="miller-field">
            <label>h</label>
            <input
              type="number"
              step="1"
              bind:value={h}
              class:invalid={!is_valid}
              onchange={() => reset_fade_animation()}
            />
          </div>
          <div class="miller-field">
            <label>k</label>
            <input
              type="number"
              step="1"
              bind:value={k}
              class:invalid={!is_valid}
              onchange={() => reset_fade_animation()}
            />
          </div>
          <div class="miller-field">
            <label>l</label>
            <input
              type="number"
              step="1"
              bind:value={l}
              class:invalid={!is_valid}
              onchange={() => reset_fade_animation()}
            />
          </div>
        </div>

        {#if !is_valid}
          <p class="error-msg">Miller index cannot be (0,0,0)</p>
        {/if}

        <!-- Presets -->
        <div class="presets">
          {#each MILLER_PRESETS as preset}
            <button
              class:active={h === preset.hkl[0] && k === preset.hkl[1] && l === preset.hkl[2]}
              onclick={() => apply_preset(preset.hkl)}
            >
              {preset.label}
            </button>
          {/each}
        </div>
      </section>

      <!-- Step B: Position & Thickness -->
      <section class="step">
        <div class="step-header">
          <span class="step-badge">B</span>
          <h5>Position & Thickness</h5>
        </div>

        <!-- Offset Slider -->
        <div class="slider-group">
          <div class="slider-label">
            <span>Plane Offset</span>
            <span class="value">{fmt(local_offset)} A</span>
          </div>
          <input
            type="range"
            min={min_offset}
            max={max_offset}
            step={offset_range / 200}
            value={local_offset}
            oninput={on_offset_input}
          />
          <div class="slider-bounds">
            <span>{fmt(min_offset)}</span>
            <span>{fmt(max_offset)}</span>
          </div>
        </div>

        <!-- Thickness Control with Mode Toggle -->
        <div class="thickness-control">
          <div class="thickness-header">
            <span>Slab Thickness</span>
            <div class="mode-toggle">
              <button
                class:active={thickness_mode === 'angstrom'}
                onclick={() => thickness_mode = 'angstrom'}
                title="Control by Angstroms"
              >
                A
              </button>
              <button
                class:active={thickness_mode === 'layers'}
                onclick={() => thickness_mode = 'layers'}
                title="Control by layer count"
                disabled={layers.length === 0}
              >
                Layers
              </button>
            </div>
          </div>

          {#if thickness_mode === 'angstrom'}
            <!-- Thickness Slider (Angstroms) -->
            <div class="slider-group">
              <div class="slider-label">
                <span></span>
                <span class="value">{fmt(local_thickness)} A</span>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(20, offset_range)}
                step={0.1}
                value={local_thickness}
                oninput={on_thickness_input}
              />
            </div>
          {:else}
            <!-- Layer Count Control -->
            <div class="layer-control">
              <button
                class="layer-btn"
                onclick={() => on_layer_count_change(-1)}
                disabled={layer_count <= 1}
              >
                -
              </button>
              <span class="layer-value">
                {layer_count} layer{layer_count !== 1 ? 's' : ''}
                <span class="layer-thickness">({fmt(local_thickness)} A)</span>
              </span>
              <button
                class="layer-btn"
                onclick={() => on_layer_count_change(1)}
              >
                +
              </button>
            </div>
            <div class="layer-info">
              {available_layers > 0 ? available_layers : layers.length} layers available | {included_layers.length} selected
              {#if replication_count > 1}
                <span class="replication-info">(bulk {replication_count}×)</span>
              {/if}
            </div>
            {#if terminations.length > 1}
              <div class="termination-selector">
                <span class="term-label">Termination</span>
                <div class="term-btns">
                  {#each terminations as term, idx}
                    <button
                      class="term-btn"
                      class:active={idx === termination_index}
                      onclick={() => { termination_index = idx; start_fade_animation() }}
                      title={term.elements.join(', ')}
                    >
                      T{idx + 1}: {term.elements.join('-')}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
        </div>

        <!-- Growth Mode Control -->
        <div class="growth-mode-control">
          <div class="growth-mode-header">
            <span>Growth Direction</span>
          </div>
          <div class="growth-mode-buttons">
            <button
              class:active={growth_mode === 'anchor_minus_z'}
              onclick={() => { growth_mode = 'anchor_minus_z'; start_fade_animation() }}
              title="Surface at offset, slab grows into -Z (below)"
            >
              <span class="growth-icon">↓</span>
              Anchor Top
            </button>
            <button
              class:active={growth_mode === 'anchor_plus_z'}
              onclick={() => { growth_mode = 'anchor_plus_z'; start_fade_animation() }}
              title="Bottom at offset, slab grows into +Z (above)"
            >
              <span class="growth-icon">↑</span>
              Anchor Bottom
            </button>
            <button
              class:active={growth_mode === 'centered'}
              onclick={() => { growth_mode = 'centered'; start_fade_animation() }}
              title="Slab grows symmetrically from center"
            >
              <span class="growth-icon">↕</span>
              Centered
            </button>
          </div>
        </div>

        <!-- Vacuum Layer -->
        <div class="slider-group">
          <div class="slider-label">
            <span>Vacuum Layer</span>
            <span class="value">{fmt(vacuum)} A</span>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            bind:value={vacuum}
          />
        </div>
      </section>

      <!-- Step C: Supercell -->
      <section class="step">
        <div class="step-header">
          <span class="step-badge">C</span>
          <h5>In-Plane Supercell</h5>
        </div>

        <div class="supercell-input">
          <div class="supercell-field">
            <label>a</label>
            <input
              type="number"
              min="1"
              max="10"
              value={supercell_a}
              onchange={(e) => supercell_a = Math.max(1, Math.min(10, parseInt(e.currentTarget.value) || 1))}
            />
          </div>
          <span class="supercell-x">×</span>
          <div class="supercell-field">
            <label>b</label>
            <input
              type="number"
              min="1"
              max="10"
              value={supercell_b}
              onchange={(e) => supercell_b = Math.max(1, Math.min(10, parseInt(e.currentTarget.value) || 1))}
            />
          </div>
          <span class="supercell-info">
            ({computed_slab_preview?.structure?.sites?.length ?? '...'} atoms)
          </span>
        </div>

        <!-- Show bonds option -->
        <label class="display-option">
          <input type="checkbox" bind:checked={show_bonds_in_preview} />
          <span>Show bonds</span>
        </label>
      </section>

      <!-- Preview Statistics -->
      {#if preview}
        <section class="preview-stats">
          <div class="stat-row">
            <span class="stat-label">d-spacing</span>
            <span class="stat-value">{fmt(preview.d_spacing, 3)} A</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Atoms</span>
            <span class="stat-value highlight-green">{computed_slab_preview?.structure?.sites?.length ?? preview.atoms_inside * supercell_a * supercell_b}</span>
          </div>
        </section>
      {/if}

      <!-- Step D: Apply -->
      <section class="step apply-section">
        <div class="step-header">
          <span class="step-badge">D</span>
          <h5>Generate Slab</h5>
        </div>

        <button
          class="apply-btn"
          onclick={apply_cut}
          disabled={!is_valid || animation_phase === 'applying' || animation_phase === 'transitioning' || (preview?.atoms_inside ?? 0) === 0}
          title={!is_valid ? 'Miller indices (0,0,0) are invalid' : !preview ? 'No preview available — check lattice' : (preview.atoms_inside ?? 0) === 0 ? 'No atoms inside slab region — adjust thickness or offset' : ''}
        >
          {#if animation_phase === 'applying'}
            <span class="spinner"></span>
            Cutting...
          {:else if animation_phase === 'transitioning'}
            <span class="spinner"></span>
            Generating...
          {:else}
            <Icon icon="Cut" style="width: 18px; height: 18px" />
            Apply Cut
          {/if}
        </button>

        {#if error_message}
          <p class="apply-error">{error_message}</p>
        {/if}

        <p class="apply-hint">
          The structure will be reoriented so that the (hkl) plane becomes the XY surface with vacuum in Z.
        </p>
      </section>
    {/if}
{/snippet}

{#if embedded}
  {@render pane_content()}
{:else if pane_open}
  <!-- Docked panel - doesn't close on outside click -->
  <div class="slab-cutter-pane" role="dialog" aria-label="Miller Slab Cutter">
    {@render pane_content()}
  </div>
{/if}

<!-- Toggle button moved to Structure.svelte control-buttons section -->

<style>
  .slab-cutter-pane {
    position: absolute;
    top: 40px;
    right: 10px;
    width: 290px;
    max-height: calc(100vh - 100px);
    overflow-y: auto;
    background: var(--pane-bg, var(--page-bg));
    border: var(--pane-border, 1px solid rgba(255, 255, 255, 0.15));
    border-radius: 10px;
    padding: 12px;
    color: var(--text-color, #eee);
    font-size: 0.85em;
    line-height: 1.4;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    z-index: 100;
    backdrop-filter: blur(12px);
  }

  .pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.8em;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .close-btn {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    border: none;
    background: transparent;
    opacity: 0.5;
    cursor: pointer;
    display: flex;
    align-items: center;
    font-size: 18px;
    font-weight: bold;
    justify-content: center;
    transition: all 0.15s;
  }

  .close-btn:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
    opacity: 1;
  }

  h4 {
    margin: 0;
    font-size: 1.05em;
    font-weight: 600;
  }

  h5 {
    margin: 0;
    font-size: 0.95em;
    font-weight: 500;
  }

  .phase-indicator {
    font-size: 0.85em;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    opacity: 0.6;
  }

  .phase-indicator.active {
    background: var(--accent-color, #007acc);
    color: white;
    opacity: 1;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .no-lattice {
    color: var(--warning-color, #f59e0b);
    padding: 1em;
    background: rgba(245, 158, 11, 0.1);
    border-radius: 6px;
  }

  .step {
    margin-bottom: 1em;
    padding: 0.8em;
    background: var(--pane-card-bg, rgba(255, 255, 255, 0.04));
    border-radius: 8px;
    border-left: 3px solid var(--accent-color, #007acc);
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 0.5em;
  }

  .step-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-color, #007acc);
    color: white;
    font-size: 0.85em;
    font-weight: bold;
  }

  .miller-input {
    display: inline-flex;
    gap: 6px;
    margin-bottom: 0.5em;
  }

  .miller-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .miller-field label {
    opacity: 0.6;
    text-align: center;
  }

  .miller-field input {
    width: 44px;
    padding: 6px 4px;
    text-align: center;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
    font-size: 1.1em;
    font-weight: bold;
  }

  .miller-field input:focus {
    outline: none;
    border-color: var(--accent-color, #007acc);
  }

  .miller-field input.invalid {
    border-color: var(--error-color, #ef4444);
    background: rgba(239, 68, 68, 0.1);
  }

  .error-msg {
    color: var(--error-color, #ef4444);
    margin: 4px 0 0 0;
    text-align: center;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .presets button {
    padding: 4px 8px;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .presets button:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .presets button.active {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
  }

  .slider-group {
    margin-bottom: 0.6em;
  }

  .slider-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 3px;
    opacity: 0.8;
  }

  .slider-label .value {
    font-weight: bold;
    color: var(--accent-color, #007acc);
    opacity: 1;
  }

  .slider-group input[type="range"] {
    width: 100%;
    height: 5px;
    border-radius: 3px;
    background: var(--border-color, rgba(255, 255, 255, 0.15));
    appearance: none;
    cursor: pointer;
  }

  .slider-group input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent-color, #007acc);
    cursor: grab;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  .slider-group input[type="range"]::-webkit-slider-thumb:active {
    cursor: grabbing;
  }

  .slider-bounds {
    display: flex;
    justify-content: space-between;
    font-size: 0.8em;
    opacity: 0.5;
    margin-top: 2px;
  }

  .thickness-control {
    margin-bottom: 0.6em;
  }

  .thickness-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .mode-toggle {
    display: flex;
    gap: 2px;
    background: var(--btn-bg, rgba(0, 0, 0, 0.2));
    border-radius: 4px;
    padding: 2px;
  }

  .mode-toggle button {
    padding: 3px 8px;
    border: none;
    background: transparent;
    opacity: 0.6;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .mode-toggle button:hover:not(:disabled) {
    opacity: 1;
  }

  .mode-toggle button.active {
    background: var(--accent-color, #007acc);
    color: white;
    opacity: 1;
  }

  .mode-toggle button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .layer-control {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 8px;
    background: var(--btn-bg, rgba(0, 0, 0, 0.2));
    border-radius: 4px;
  }

  .layer-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    color: inherit;
    cursor: pointer;
    font-size: 1.1em;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .layer-btn:hover:not(:disabled) {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
  }

  .layer-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .layer-value {
    font-weight: bold;
    text-align: center;
  }

  .layer-thickness {
    font-size: 0.8em;
    opacity: 0.6;
    font-weight: normal;
  }

  .layer-info {
    text-align: center;
    font-size: 0.85em;
    opacity: 0.6;
    margin-top: 4px;
  }

  .termination-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .term-label {
    font-size: 0.8em;
    opacity: 0.6;
    white-space: nowrap;
  }
  .term-btns {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
  .term-btn {
    background: none;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 0.8em;
    line-height: 1.4;
    transition: all 0.15s;
  }
  .term-btn:hover {
    border-color: var(--accent-color, #007acc);
    color: var(--text-color, light-dark(#1f2937, #e5e7eb));
  }
  .term-btn.active {
    background: color-mix(in srgb, var(--accent-color, #007acc) 20%, transparent);
    border-color: var(--accent-color, #007acc);
    color: var(--accent-color, #007acc);
  }

  .replication-info {
    color: var(--accent-color, #007acc);
    font-weight: 500;
  }

  .growth-mode-control {
    margin-top: 0.6em;
  }

  .growth-mode-header {
    margin-bottom: 6px;
  }

  .growth-mode-buttons {
    display: flex;
    gap: 4px;
  }

  .growth-mode-buttons button {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 4px;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, rgba(255, 255, 255, 0.1));
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    transition: all 0.15s;
  }

  .growth-mode-buttons button:hover {
    background: var(--btn-bg-hover, rgba(255, 255, 255, 0.15));
  }

  .growth-mode-buttons button.active {
    background: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
  }

  .growth-icon {
    font-size: 1.3em;
    line-height: 1;
  }

  .supercell-input {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .supercell-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .supercell-field label {
    opacity: 0.6;
    text-align: center;
  }

  .supercell-field input {
    width: 50px;
    padding: 6px 4px;
    text-align: center;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    background: var(--btn-bg, rgba(0, 0, 0, 0.2));
    color: inherit;
    border-radius: 4px;
    font-size: 1em;
    font-weight: bold;
  }

  .supercell-field input:focus {
    outline: none;
    border-color: var(--accent-color, #007acc);
  }

  .supercell-x {
    font-size: 1.2em;
    opacity: 0.5;
    margin-top: 14px;
  }

  .supercell-info {
    opacity: 0.6;
    margin-left: 4px;
    margin-top: 14px;
  }

  .display-option {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    opacity: 0.8;
    cursor: pointer;
  }

  .display-option input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .preview-stats {
    background: var(--pane-card-bg, rgba(255, 255, 255, 0.05));
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 0.8em;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
  }

  .stat-label {
    opacity: 0.6;
  }

  .stat-value {
    font-weight: 500;
  }

  .highlight-green {
    color: var(--success-color, #22c55e);
    font-weight: bold;
  }

  .highlight-red {
    color: var(--error-color, #ef4444);
    font-weight: bold;
  }

  .apply-section {
    border-left-color: var(--success-color, #22c55e);
  }

  .apply-btn {
    width: 100%;
    padding: 10px;
    background: linear-gradient(135deg, var(--accent-color, #007acc), color-mix(in srgb, var(--accent-color, #007acc), black 30%));
    border: none;
    border-radius: 8px;
    color: white;
    cursor: pointer;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: all 0.2s;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .apply-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
  }

  .apply-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .apply-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .apply-error {
    font-size: 0.85em;
    color: #ff6b6b;
    text-align: center;
    margin: 6px 0 0 0;
    line-height: 1.4;
  }

  .apply-hint {
    font-size: 0.85em;
    opacity: 0.6;
    text-align: center;
    margin: 6px 0 0 0;
    line-height: 1.4;
  }

  .conv-cell-section {
    margin-bottom: 0.8em;
  }

  .conv-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    opacity: 0.9;
    margin-bottom: 6px;
  }

  .conv-toggle input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .conv-banner {
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.85em;
    display: flex;
    align-items: center;
    gap: 6px;
    line-height: 1.4;
  }

  .conv-banner.info {
    background: rgba(59, 130, 246, 0.15);
    color: var(--info-color, #60a5fa);
  }

  .conv-banner.error {
    background: rgba(239, 68, 68, 0.1);
    color: var(--error-color, #ef4444);
  }

  .conv-banner.success {
    background: rgba(34, 197, 94, 0.1);
    color: var(--success-color, #22c55e);
  }

  .spinner-small {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
</style>
