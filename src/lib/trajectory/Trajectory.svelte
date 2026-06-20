<script lang="ts">
  import {
    type ElementSymbol,
    type Vec3,
    Icon,
    Spinner,
    Structure,
    toggle_fullscreen,
  } from '$lib'
  import { add_atom, delete_atoms, replace_atom } from '$lib/structure'
  import type { AtomManipulationEvent } from '$lib/structure'
  import type { AnyStructure, PymatgenStructure } from '$lib/structure'
  import { type Matrix3x3, matrix_inverse_3x3, transpose_3x3_matrix } from '$lib/math'
  import { writeRemoteFile } from '$lib/api/hpc'
  import { structure_to_poscar_str } from '$lib/structure/export'
  import { handle_url_drop, load_from_url } from '$lib/io'
  import FileSourceDialog from '$lib/electronic/FileSourceDialog.svelte'
  import { format_num, trajectory_property_config } from '$lib/labels'
  import type { ControlsConfig, DataSeries, Orientation, Point } from '$lib/plot'
  import { Histogram, ScatterPlot } from '$lib/plot'
  import { DEFAULTS } from '$lib/settings'
  import { scaleLinear } from 'd3-scale'
  import type { ComponentProps, Snippet } from 'svelte'
  import { untrack } from 'svelte'
  import { tooltip } from 'svelte-multiselect/attachments'
  import type { HTMLAttributes } from 'svelte/elements'
  import { full_data_extractor } from './extract'
  import type {
    ParseProgress,
    TrajectoryDataExtractor,
    TrajectoryFrame,
    TrajectoryType,
    TrajHandlerData,
  } from './index'
  import { TrajectoryError, TrajectoryExportPane, TrajectoryInfoPane } from './index'
  import type { LoadingOptions } from './parse'
  import {
    create_frame_loader,
    get_unsupported_format_message,
    MAX_BIN_FILE_SIZE,
    MAX_TEXT_FILE_SIZE,
    parse_trajectory_async,
  } from './parse'
  import {
    generate_axis_labels,
    generate_plot_series,
    generate_streaming_plot_series,
    should_hide_plot,
  } from './plotting'
  import {
    compute_step_label_positions,
    get_view_mode_label,
    read_file_content,
  } from './trajectory-utils'
  import {
    clamp_fps,
    get_keyboard_action,
  } from './trajectory-controls'
  import { apply_displacements, sites_to_float32, write_sites_to_cache_slice } from './edit-apply'
  import { build_atom_graph } from '$lib/structure/atom-graph'
  import {
    register_viewer,
    refresh_viewer_manifest,
    set_active_viewer,
    type ViewerPosition,
  } from '$lib/structure/viewer-registry.svelte'
  import { scale_structure_geometry, validate_uniform_topology } from './operations'
  import type { PaneTrajectory } from './clone'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  type EventHandlers = {
    on_play?: (data: TrajHandlerData) => void
    on_pause?: (data: TrajHandlerData) => void
    on_step_change?: (data: TrajHandlerData) => void
    on_end?: (data: TrajHandlerData) => void
    on_loop?: (data: TrajHandlerData) => void
    on_frame_rate_change?: (data: TrajHandlerData) => void
    on_display_mode_change?: (data: TrajHandlerData) => void
    on_fullscreen_change?: (data: TrajHandlerData) => void
    on_file_load?: (data: TrajHandlerData) => void
    on_error?: (data: TrajHandlerData) => void
  }

  let {
    trajectory = $bindable(undefined),
    data_url,
    current_step_idx = $bindable(0),
    selected_sites = $bindable<number[]>([]),
    data_extractor = full_data_extractor,
    allow_file_drop = true,
    layout = `auto`,
    structure_props = {},
    scatter_props = {},
    histogram_props = {},
    spinner_props = {},
    trajectory_controls,
    error_snippet,
    show_controls = true,
    fullscreen_toggle = DEFAULTS.trajectory.fullscreen_toggle,
    auto_play = false,
    display_mode = $bindable(`structure+scatter`),
    step_labels = 5,
    on_play,
    on_pause,
    on_step_change,
    on_end,
    on_loop,
    on_frame_rate_change,
    on_display_mode_change,
    on_fullscreen_change,
    on_file_load,
    on_error,
    fps_range = DEFAULTS.trajectory.fps_range,
    fps = $bindable(5),
    loading_options = {},
    plot_skimming = true,
    // W7 Milestone 5: forward Structure display toggles so test pages and
    // external consumers can drive them via bind: without nesting through
    // structure_props. These mirror the matching $bindable props on Structure.
    supercell_scaling = $bindable<string>(`1x1x1`),
    show_image_atoms = $bindable<boolean>(false),
    show_hydrogen_bonds = $bindable<boolean | undefined>(undefined),
    viewer_id,
    tab_id,
    leaf_id = ``,
    pane_position = `single` as ViewerPosition,
    pane_number = 1,
    filename = null as string | null,
    is_active = true,
    ...rest
  }: EventHandlers & HTMLAttributes<HTMLDivElement> & {
    // trajectory data - can be provided directly or loaded from file
    trajectory?: TrajectoryType
    // URL to load trajectory from (alternative to providing trajectory directly)
    data_url?: string
    // current step index being displayed
    current_step_idx?: number
    // selected site indices for atom selection
    selected_sites?: number[]
    // custom function to extract plot data from trajectory frames
    data_extractor?: TrajectoryDataExtractor

    // file drop handlers
    allow_file_drop?: boolean
    // layout configuration - 'auto' (default) adapts to viewport, 'horizontal'/'vertical' forces layout
    layout?: `auto` | Orientation
    // structure viewer props (passed to Structure component)
    structure_props?: ComponentProps<typeof Structure>
    // plot props (passed to ScatterPlot component)
    scatter_props?: ComponentProps<typeof ScatterPlot>
    // histogram props (passed to Histogram component, excluding series which is handled separately)
    histogram_props?: Omit<ComponentProps<typeof Histogram>, `series`>
    // spinner props (passed to Spinner component)
    spinner_props?: ComponentProps<typeof Spinner>
    // custom snippets for additional UI elements
    trajectory_controls?: Snippet<
      [
        {
          trajectory: TrajectoryType
          current_step_idx: number
          total_frames: number
          on_step_change: (idx: number) => void
        },
      ]
    >
    // Custom error snippet for advanced error handling
    error_snippet?: Snippet<[{ error_msg: string; on_dismiss: () => void }]>
    show_controls?: boolean // show/hide the trajectory controls bar
    // show/hide the fullscreen button
    fullscreen_toggle?: Snippet<[]> | boolean
    // automatically start playing when trajectory data is loaded
    auto_play?: boolean
    // display mode: 'structure+scatter' (default), 'structure' (only structure), 'scatter' (only scatter), 'histogram' (only histogram), 'structure+histogram' (structure with histogram)
    display_mode?:
      | `structure+scatter`
      | `structure`
      | `scatter`
      | `histogram`
      | `structure+histogram`
    // step labels configuration for slider
    // - positive number: number of evenly spaced ticks
    // - negative number: spacing between ticks (e.g., -10 = every 10th step)
    // - array: exact step indices to label
    // - undefined: no labels
    step_labels?: number | number[]
    // explicit mapping from property keys to display labels
    property_labels?: Record<string, string>
    // units configuration - developers can override these (deprecated - use property_labels instead)
    units?: {
      energy?: string
      energy_per_atom?: string
      force_max?: string
      force_norm?: string
      stress_max?: string
      volume?: string
      density?: string
      temperature?: string
      pressure?: string
      length?: string
      a?: string
      b?: string
      c?: string
      [key: string]: string | undefined
    }
    fps_range?: [number, number] // allowed FPS range [min_fps, max_fps]
    fps?: number // frame rate for playback
    // Loading options for large files
    loading_options?: LoadingOptions
    // Disable plot skimming (mouse over plot doesn't update structure/step slider)
    plot_skimming?: boolean
    // W7 Milestone 5: forwarded Structure display toggles (bind:able from
    // outside Trajectory). Default values match Structure's own defaults
    // except show_image_atoms which defaults to false here (existing behavior).
    supercell_scaling?: string
    show_image_atoms?: boolean
    show_hydrogen_bonds?: boolean
    viewer_id?: string
    tab_id?: string
    leaf_id?: string
    pane_position?: ViewerPosition
    pane_number?: number
    filename?: string | null
    is_active?: boolean
  } = $props()

  // PNG sequence export settings
  let png_dpi = $state(150)
  let crop_region = $state<import('$lib/io/export').CropRegion | null>(null)

  let dragover = $state(false)
  let loading = $state(false)
  let error_msg = $state<string | null>(null)
  let is_playing = $state(false)

  // DEV-only probe: expose is_playing on globalThis for the W7 mutex tests
  // (Test 3.4 vibration-trajectory mutex). Mirrors the __catgo_align_on_load_fires
  // pattern in Structure.svelte's principal-axes alignment $effect (grep that file
  // for "__catgo_align_on_load_fires") — cross-component state lifts to a global
  // so StructureScene's __catgo_probe can read it without prop drilling.
  $effect(() => {
    if (!import.meta.env?.DEV) return
    ;(globalThis as { __catgo_traj_is_playing?: boolean }).__catgo_traj_is_playing = is_playing
    return () => {
      delete (globalThis as { __catgo_traj_is_playing?: unknown }).__catgo_traj_is_playing
    }
  })

  // DEV-only probe: expose resume_disabled flag + handler-trigger API for
  // W7 Tests 6.4 / 6.5. The W5 design (plans/W5-resume-disable-design.md)
  // sets resume_disabled=true on add/delete/replace during pause and play
  // button gates on it. Tests need to drive these handlers directly because
  // the test page doesn't expose add/delete UI affordances.
  $effect(() => {
    if (!import.meta.env?.DEV) return
    const api = {
      get resume_disabled(): boolean { return resume_disabled },
      trigger_atom_added: () => handle_atom_added({ element: `H` as ElementSymbol, position: [2, 0, 0] }),
      trigger_atoms_deleted: () => handle_atoms_deleted({ site_indices: [0] }),
      trigger_atom_replaced: () => handle_atom_replaced({ site_indices: [0], new_element: `O` as ElementSymbol }),
      trigger_atoms_manipulated: () => handle_atoms_manipulated({
        displacements: new Map([[0, [0.01, 0, 0]]]),
      } as AtomManipulationEvent),
      get edit_mode(): string { return edit_mode },
      set_edit_mode(m: 'view' | 'edit-current' | 'edit-all') { edit_mode = m },
      get_frame_x0(frame_idx: number): number | null {
        return trajectory?.frames?.[frame_idx]?.structure?.sites?.[0]?.xyz?.[0] ?? null
      },
      get_current_idx(): number { return current_step_idx },
      get_frame_natoms(frame_idx: number): number | null {
        return trajectory?.frames?.[frame_idx]?.structure?.sites?.length ?? null
      },
      get_current_frame_x0(): number | null {
        return trajectory?.frames?.[current_step_idx]?.structure?.sites?.[0]?.xyz?.[0] ?? null
      },
    }
    ;(globalThis as { __catgo_traj_test?: typeof api }).__catgo_traj_test = api
    return () => {
      delete (globalThis as { __catgo_traj_test?: unknown }).__catgo_traj_test
    }
  })

  // Plan v3 Phase 5 (W5 resume-disable per plans/W5-resume-disable-design.md):
  // When the user pauses trajectory and performs a topology-altering edit
  // (add / delete / replace atom — but NOT drag, which doesn't change
  // topology), resume must be blocked. The position_cache is sized for the
  // original topology; resuming after a topology edit would either crash
  // (delete) or animate atoms with garbage positions (add/replace).
  // Resets only on new trajectory load. Stop, pause, and undo do NOT reset.
  // Tracking `traj_load_seq` instead of `trajectory` directly avoids being
  // retriggered by spread refreshes from `_chunked_cross_frame_edit` and
  // `flush_pending_ops` (`trajectory = { ...trajectory }`), which would
  // otherwise silently re-enable resume after add/replace edits during pause.
  // The counter is bumped synchronously alongside the I6 cache-nulls inside
  // `load_trajectory_data` / `load_with_indexing` — the only real-load paths.
  let resume_disabled = $state(false)
  let traj_load_seq = $state(0)
  $effect(() => {
    traj_load_seq // track new-trajectory-load reset
    resume_disabled = false
  })
  let play_interval: ReturnType<typeof setInterval> | undefined = $state(undefined)

  // Ensure fps is within the allowed range
  $effect(() => {
    fps = clamp_fps(fps, fps_range)
  })
  let current_filename = $state<string | undefined>(undefined)
  let current_file_path = $state<string | null>(null)
  let file_size = $state<number | undefined>(undefined)
  let file_object = $state<File | null>(null)
  let wrapper = $state<HTMLDivElement | undefined>(undefined)
  let info_pane_open = $state(false)
  let parsing_progress = $state<ParseProgress | null>(null)
  let viewport = $state({ width: 0, height: 0 })
  let filename_copied = $state(false)
  let orig_data = $state<string | ArrayBuffer | null>(null)
  let show_file_dialog = $state(false)

  // W7 Milestone 5: bind:scene_props from Structure so we can mutate
  // show_hydrogen_bonds via the scene_props sub-object (it lives on
  // StructureScene, not directly on Structure as a top-level prop).
  let trajectory_scene_props = $state<
    ComponentProps<typeof Structure>['scene_props']
  >(undefined as any)
  // When the user (or test harness) changes show_hydrogen_bonds at the
  // Trajectory boundary, propagate into scene_props. When scene_props itself
  // shifts (e.g. settings restore), reflect back to the bindable prop so
  // outside consumers stay in sync.
  $effect(() => {
    if (trajectory_scene_props && show_hydrogen_bonds !== undefined) {
      if (trajectory_scene_props.show_hydrogen_bonds !== show_hydrogen_bonds) {
        trajectory_scene_props.show_hydrogen_bonds = show_hydrogen_bonds
      }
    }
  })
  $effect(() => {
    const v = trajectory_scene_props?.show_hydrogen_bonds
    if (v !== undefined && v !== show_hydrogen_bonds) {
      show_hydrogen_bonds = v
    }
  })

  // Push-back state
  let pushback_status = $state<`idle` | `saving` | `saved` | `error`>(`idle`)
  let pushback_message = $state(``)
  let pushback_timer: ReturnType<typeof setTimeout> | undefined = undefined

  // Remote origin from trajectory metadata (for push-back to remote HPC)
  let remote_origin = $derived(
    trajectory?.metadata?.remote_origin as { session_id: string; dir_path: string } | undefined,
  )
  async function push_back_current_frame() {
    // Plan v3 Phase 4 fix: serialize current_frame.structure rather than
    // current_structure. Under Architecture P, current_structure freezes
    // at the first frame's topology; the actual frame to push back is
    // current_frame.structure (which holds the per-frame positions).
    const frame_structure = current_frame?.structure
    if (!remote_origin || !current_frame_source || !frame_structure) {
      console.warn(`Push-back guard failed:`, { remote_origin, current_frame_source, has_structure: !!frame_structure })
      return
    }
    if (pushback_timer) clearTimeout(pushback_timer)

    pushback_status = `saving`
    pushback_message = ``

    try {
      const content = structure_to_poscar_str(frame_structure)
      const full_path = `${remote_origin.dir_path}/${current_frame_source}`
      console.log(`Push-back: writing frame ${current_step_idx} to ${full_path} (session: ${remote_origin.session_id})`)
      const result = await writeRemoteFile(remote_origin.session_id, full_path, content)
      console.log(`Push-back result:`, result)
      if (result.success) {
        pushback_status = `saved`
        pushback_message = current_frame_source!
        pushback_timer = setTimeout(() => { pushback_status = `idle` }, 3000)
      } else {
        pushback_status = `error`
        pushback_message = result.message || `Write failed`
        console.error(`Push-back failed:`, result.message)
        pushback_timer = setTimeout(() => { pushback_status = `idle` }, 5000)
      }
    } catch (e: any) {
      pushback_status = `error`
      pushback_message = e?.message || String(e)
      console.error(`Push-back error:`, e)
      pushback_timer = setTimeout(() => { pushback_status = `idle` }, 5000)
    }
  }

  // Reactive layout based on viewport aspect ratio
  let actual_layout = $derived.by(() => {
    if (layout === `horizontal` || layout === `vertical`) return layout
    if (viewport.width > 0 && viewport.height > 0) {
      return viewport.width > viewport.height ? `horizontal` : `vertical`
    }
    return `horizontal` // Fallback to horizontal if dimensions not available yet
  })

  // Get total frame count (supports both regular and indexed trajectories)
  let total_frames = $derived(
    trajectory?.total_frames || trajectory?.frames.length || 0,
  )

  // Current frame - load on demand for indexed trajectories
  let current_frame = $state<TrajectoryFrame | null>(null)

  // Current frame structure for display — controlled $state instead of $derived
  // so we can freeze it during fast-path playback (moved up to avoid use-before-declaration)
  let current_structure = $state<AnyStructure | undefined>(undefined)

  // Remote push-back derived values (depend on current_frame)
  let current_frame_source = $derived(
    current_frame?.metadata?.source_file as string | undefined,
  )
  let can_push_back = $derived(
    // Plan v3 Phase 4 fix: read current_frame.structure rather than
    // current_structure. Under Architecture P, current_structure is frozen
    // at first-frame topology; current_frame.structure tracks the actual
    // displayed frame. Without this, can_push_back stays true after
    // navigating to any frame even when the user can't actually push the
    // current frame's positions.
    !!remote_origin && !!current_frame_source && !!current_frame?.structure,
  )

  // Auto-play when trajectory changes (handles both props and file loading)
  $effect(() => {
    if (auto_play && trajectory && !untrack(() => is_playing) && total_frames > 1) {
      start_playback()
    }
  })

  // Update current frame when step changes
  $effect(() => {
    if (trajectory && current_step_idx >= 0 && current_step_idx < total_frames) {
      // @ts-expect-error - frame_loader is added dynamically for indexed/streaming trajectories
      if (trajectory.frame_loader) {
        // Load frame on demand (works for both indexed files and external streaming)
        load_frame_on_demand(current_step_idx)
      } else {
        // In-memory frames: apply any pending ops before showing. The mutation
        // inside `materialize_frame` replaces `trajectory.frames[idx]` with a
        // fresh object, so we re-read after to pick up the new reference.
        materialize_frame(current_step_idx)
        current_frame = trajectory.frames[current_step_idx] || null
      }
    } else {
      current_frame = null
    }
  })

  // Load frame on demand - works for both indexed files and external streaming
  async function load_frame_on_demand(frame_idx: number) {
    // @ts-expect-error - frame_loader is added dynamically for indexed/streaming trajectories
    if (!trajectory?.frame_loader) return

    try {
      // @ts-expect-error - frame_loader is added dynamically for indexed/streaming trajectories
      const frame = await trajectory.frame_loader.load_frame(
        orig_data || ``, // Use original_data for indexed files, empty string for external streaming
        frame_idx,
      )
      current_frame = frame
    } catch (error) {
      console.error(`Failed to load frame ${frame_idx}:`, error)
      current_frame = null
      on_error?.({
        error_msg: `Failed to load frame ${frame_idx}: ${error}`,
        filename: current_filename,
        file_size,
        step_idx: frame_idx,
        frame_count: total_frames,
      })
    }
  }

  // --- Trajectory fast-path: position-only GPU updates during playback/scrubbing ---
  // Pre-cache flat position arrays so we can skip the full reactive pipeline
  // (atom_data re-derive → AtomImpostors full buffer rebuild) during playback.
  let position_cache: Float32Array[] | null = null
  // Force cache: flat Float32Array of [fx,fy,fz] per atom per frame (null if no forces)
  let force_cache: Float32Array[] | null = null

  // B3: null caches when the underlying frames array identity changes — i.e. a
  // real trajectory swap (loader assignment OR bind:trajectory parent reassignment
  // that bypasses load_trajectory_data / load_with_indexing). Skip on spread
  // refreshes (`trajectory = { ...trajectory }`) where `frames` is the same array
  // — those rely on the fast-update path in the cache-rebuild $effect below to
  // mutate in place. Declared BEFORE the cache-rebuild $effect so Svelte 5's
  // declaration-order flush nulls caches first on bind:trajectory swaps.
  let prev_frames_ref: NonNullable<typeof trajectory>['frames'] | null = null
  $effect(() => {
    const frames_ref = trajectory?.frames ?? null
    if (frames_ref !== prev_frames_ref) {
      position_cache = null
      force_cache = null
      prev_frames_ref = frames_ref
    }
  })

  $effect(() => {
    if (!trajectory?.frames?.length) { position_cache = null; return }
    // Only cache for in-memory trajectories with constant atom count
    // @ts-expect-error - frame_loader is added dynamically for indexed/streaming trajectories
    if (trajectory.frame_loader) { position_cache = null; return }
    // Invalidate cache while pending ops exist — ops may change atom counts
    // or positions per-frame. Cache rebuilds automatically after
    // `flush_pending_ops()` (which spreads `trajectory`, triggering this effect).
    if (pending_ops.length > 0) { position_cache = null; force_cache = null; return }

    const frames = trajectory.frames
    const first_count = frames[0].structure.sites.length
    // Verify constant atom count (sample check)
    const sample_indices = [
      0,
      Math.floor(frames.length / 4),
      Math.floor(frames.length / 2),
      Math.floor(frames.length * 3 / 4),
      frames.length - 1,
    ]
    const constant = sample_indices.every(
      (i) => (frames[i]?.structure.sites.length ?? first_count) === first_count,
    )
    if (!constant) { position_cache = null; force_cache = null; return }

    // Check if any frame has force data
    const has_forces = (frames[0].structure.sites[0]?.properties?.force as number[] | undefined)?.length === 3

    // Fast path: if cache exists with matching dimensions, update in-place (e.g. after editing)
    const existing = position_cache
    if (existing && existing.length === frames.length && existing[0]?.length === first_count * 3) {
      const existing_forces = has_forces ? (force_cache ?? new Array(frames.length)) : null
      for (let f = 0; f < frames.length; f++) {
        const sites = frames[f].structure.sites
        const arr = existing[f]
        for (let i = 0; i < sites.length; i++) {
          const xyz = sites[i].xyz
          arr[i * 3] = xyz[0]
          arr[i * 3 + 1] = xyz[1]
          arr[i * 3 + 2] = xyz[2]
        }
        if (existing_forces) {
          const farr = existing_forces[f] ?? new Float32Array(sites.length * 3)
          for (let i = 0; i < sites.length; i++) {
            const fv = sites[i].properties?.force as number[] | undefined
            if (fv) { farr[i * 3] = fv[0]; farr[i * 3 + 1] = fv[1]; farr[i * 3 + 2] = fv[2] }
          }
          existing_forces[f] = farr
        }
      }
      position_cache = existing
      force_cache = existing_forces
      return
    }

    // Initial build: create cache in chunks to avoid blocking the UI
    const CHUNK_SIZE = 200
    const cache: Float32Array[] = new Array(frames.length)
    const f_cache: Float32Array[] | null = has_forces ? new Array(frames.length) : null
    let built = 0
    let cancelled = false

    function build_chunk() {
      if (cancelled) return
      const end = Math.min(built + CHUNK_SIZE, frames.length)
      for (let f = built; f < end; f++) {
        const sites = frames[f].structure.sites
        const arr = new Float32Array(sites.length * 3)
        for (let i = 0; i < sites.length; i++) {
          const xyz = sites[i].xyz
          arr[i * 3] = xyz[0]
          arr[i * 3 + 1] = xyz[1]
          arr[i * 3 + 2] = xyz[2]
        }
        cache[f] = arr
        if (f_cache) {
          const farr = new Float32Array(sites.length * 3)
          for (let i = 0; i < sites.length; i++) {
            const fv = sites[i].properties?.force as number[] | undefined
            if (fv) { farr[i * 3] = fv[0]; farr[i * 3 + 1] = fv[1]; farr[i * 3 + 2] = fv[2] }
          }
          f_cache[f] = farr
        }
      }
      built = end
      if (built < frames.length) {
        setTimeout(build_chunk, 0)
      } else {
        position_cache = cache
        force_cache = f_cache
      }
    }
    build_chunk()

    return () => { cancelled = true }
  })

  // Trajectory frame positions for the fast path (Float32Array of x,y,z triples)
  let trajectory_frame_positions = $state<Float32Array | null>(null)
  // Trajectory frame forces for fast path (Float32Array of fx,fy,fz triples, null if no forces)
  let trajectory_frame_forces = $state<Float32Array | null>(null)

  // Plan v3 Phase 4 (per plans/phase4-current-structure-investigation.md):
  // Gate `current_structure = frame.structure` behind a topology_initialized
  // flag so the cascade fires ONCE on trajectory load (to populate
  // displayed_structure with base topology), then per-frame position updates
  // flow exclusively through trajectory_frame_positions. Without this gate,
  // current_structure cascades to displayed_structure → atom_data, bbp, apb,
  // acb, nhsi all re-fire per frame at ~13-25ms total — the bypass refactor's
  // entire reason for existing.
  //
  // Reset on new trajectory load via separate $effect tracking `trajectory`.
  // For indexed/streaming trajectories without position_cache, fall back to
  // per-frame current_structure writes (the slow path is acceptable for the
  // large-file workflow this represents).
  let topology_initialized = $state(false)
  $effect(() => {
    trajectory // track
    topology_initialized = false
  })

  $effect(() => {
    const frame = current_frame
    if (!frame?.structure) {
      current_structure = undefined
      trajectory_frame_positions = null
      trajectory_frame_forces = null
      topology_initialized = false
      return
    }
    // Doping / substitution trajectories swap element identity per frame
    // while keeping positions constant; the position_cache fast-path freezes
    // current_structure to frame[0] so every later frame would render the
    // first frame's elements (e.g. all Sc instead of Sc → Ti → V → ... in
    // a 10-element scan). Detect those via `trajectory.metadata.source_format`
    // and force the slow path so each frame's species labels reach the
    // viewer.
    const traj_meta = trajectory?.metadata as
      | { source_format?: string; type?: string }
      | undefined
    const traj_source = traj_meta?.source_format ?? traj_meta?.type
    const force_slow_path = traj_source === `doping_substitution` ||
      traj_source === `reaction_pathway`
    if (position_cache && !force_slow_path) {
      // Architecture P fast-path: write current_structure once on trajectory
      // load (or new trajectory). Subsequent frames update only the Float32Array,
      // bypassing the displayed_structure cascade. Atom positions reach the
      // GPU via Structure.svelte's Phase 2 position-write loop and X2's
      // trajectory_only fast-path; bond positions follow via Phase 3's
      // build_trajectory_bond_pairs branch.
      if (!topology_initialized) {
        current_structure = frame.structure
        topology_initialized = true
      }
      trajectory_frame_positions = position_cache[current_step_idx] ?? null
      trajectory_frame_forces = force_cache?.[current_step_idx] ?? null
      // NOTE: do NOT call sync_structure_sites_to_frame_positions() here.
      // Architecture P requires `current_structure` to stay static during
      // playback / scrub — writing it per-frame triggers the bond pipeline
      // (async worker recompute) which during scrub causes visible bond
      // flicker (bond_pairs lags current frame positions by ~1 worker tick,
      // so cylinders draw against frame-N atom positions using frame-(N-1)
      // index pairs). The helper is intentionally only called from
      // pause_playback() — one cascade per pause, none per scrub step.
      // Trade-off: click/drag/edit during scrub-while-paused still hit
      // the LAST-paused frame's xyz, not the displayed scrub frame. Known
      // limitation; acceptable until a non-cascading writeback path exists.
    } else {
      // Indexed/streaming trajectories: no Float32Array cache available.
      // Fall back to per-frame structure writes (slow path). This is the
      // pre-Phase-4 behavior and is acceptable for the large-file workflow.
      current_structure = frame.structure
      trajectory_frame_positions = null
      trajectory_frame_forces = null
    }
  })

  // Track hidden elements (persists across frame changes)
  let hidden_elements = $state(new Set<ElementSymbol>())

  let step_label_positions = $derived(
    compute_step_label_positions(step_labels, total_frames, scaleLinear as any),
  )

  // Generate plot data - use pre-extracted metadata for indexed trajectories
  let plot_series = $derived.by(() => {
    if (trajectory?.plot_metadata) {
      // Use pre-extracted metadata for indexed trajectories
      // Convert metadata to plot series format
      return generate_streaming_plot_series(trajectory.plot_metadata, {
        property_config: trajectory_property_config,
      })
    }

    // Traditional mode: use trajectory frames
    return trajectory
      ? generate_plot_series(trajectory, data_extractor, {
        property_config: trajectory_property_config,
      })
      : []
  })

  let x_axis = $derived({
    label: `Step`,
    format: `.3~s`,
    ticks: step_label_positions,
  })
  // Generate axis labels based on first visible series on each axis
  let y_axis_labels = $derived(generate_axis_labels(plot_series))
  let y_axis = $derived({
    label: y_axis_labels.y1,
    format: `.2~s`,
    label_shift: { y: 20 },
  })
  let y2_axis = $derived({
    label: y_axis_labels.y2,
    format: `.2~s`,
    label_shift: { y: 80 },
  })

  // Helper function to get current frame data for callbacks
  function get_current_frame_data() {
    return {
      frame: current_frame || undefined,
      frame_count: total_frames,
    }
  }

  // hide plot if all plotted values are constant (no variation)
  let show_plot = $derived(
    display_mode !== `structure` && !should_hide_plot(trajectory, plot_series),
  )

  // Determine what to show based on display mode
  let show_structure = $derived(![`scatter`, `histogram`].includes(display_mode))
  let actual_show_plot = $derived(display_mode !== `structure` && show_plot)

  // Check if there are any Y2 series to determine padding
  let has_y2_series = $derived(
    plot_series.some((srs) => srs.y_axis === `y2` && srs.visible),
  )

  // Step navigation functions
  function next_step() {
    if (current_step_idx < total_frames - 1) {
      current_step_idx++
      // Streaming frame loading handled by reactive effect
      if (trajectory) {
        const { frame } = get_current_frame_data()
        on_step_change?.({
          trajectory,
          step_idx: current_step_idx,
          frame_count: total_frames,
          frame,
        })
      }
    }
  }

  function prev_step() {
    if (current_step_idx > 0) {
      current_step_idx--
      // Streaming frame loading handled by reactive effect
      if (trajectory) {
        const { frame } = get_current_frame_data()
        on_step_change?.({
          trajectory,
          step_idx: current_step_idx,
          frame_count: total_frames,
          frame,
        })
      }
    }
  }

  function go_to_step(idx: number) {
    if (idx >= 0 && idx < total_frames) {
      current_step_idx = idx
      // Note: streaming frame loading is handled by reactive effect
      // Handle callbacks for both traditional and streaming modes
      if (trajectory) {
        const { frame } = get_current_frame_data()
        on_step_change?.({
          trajectory,
          step_idx: current_step_idx,
          frame_count: total_frames,
          frame,
        })
      }
    }
  }

  // Handle plot point clicks to jump to that step
  function handle_plot_change(data: (Point & { series: DataSeries }) | null) {
    if (data?.x !== undefined && typeof data.x === `number`) {
      go_to_step(Math.round(data.x))
    }
  }

  // read_file_content imported from trajectory-utils.ts

  // T5 pause writeback — sync current_structure.sites to the displayed frame's
  // positions whenever paused (initial pause OR frame scrub while paused).
  // Click/drag/edit handlers read structure.sites for hit-test xyz, so the
  // sites array MUST track the user-visible frame to avoid the silent
  // "dragged positions don't propagate" desync that the simplified W7 2.3
  // assertion was hiding. Per-slot equality short-circuit avoids spurious
  // structure refs (which would cascade into property_colors / supercell
  // rebuilds even when positions haven't changed).
  // Does not honor `realtime_position_overrides` — a drag in flight is
  // overwritten and re-applied by drag-commit. Mirror Structure.svelte's
  // Phase 2 override skip if that semantics ever needs to change.
  function sync_structure_sites_to_frame_positions(): void {
    const positions = trajectory_frame_positions
    const cur = current_structure
    if (!positions || !cur?.sites) return
    const sites = cur.sites
    const max_i = Math.min(sites.length, Math.floor(positions.length / 3))
    const new_sites = sites.map((site, i) => {
      if (i >= max_i) return site // supercell-extra atom; pass through
      const x = positions[i * 3]
      const y = positions[i * 3 + 1]
      const z = positions[i * 3 + 2]
      // Skip allocation if positions match (per-slot equality)
      if (site.xyz?.[0] === x && site.xyz?.[1] === y && site.xyz?.[2] === z) {
        return site
      }
      return { ...site, xyz: [x, y, z] as [number, number, number] }
    })
    // Bail if every site was passthrough (no actual change)
    if (new_sites.every((s, i) => s === sites[i])) return
    current_structure = { ...cur, sites: new_sites }
  }

  // Play/pause functionality
  function toggle_play() {
    if (is_playing) pause_playback()
    else start_playback()
  }
  function start_playback() {
    if (total_frames <= 1) return
    is_playing = true
    if (trajectory) {
      on_play?.({ trajectory, step_idx: current_step_idx, frame_count: total_frames })
    }
  }
  function pause_playback() {
    is_playing = false
    // T5 pause writeback (search "T5 pause writeback" in this file or src/lib/structure/Structure.svelte).
    // Plan v3 Phase 5 (T5 writeback per W2 Option 1, refined 2026-04-27):
    // Commit current trajectory frame positions back into current_structure
    // so subsequent edits (drag, element swap, atom add/delete) start from
    // paused-frame positions, not trajectory-load positions. Uses the
    // existing trajectory_frame_positions Float32Array as source of truth
    // (same data Phase 2's position-write loop fed to the GPU on the
    // paused frame).
    //
    // The original Phase 5 implementation lived in Structure.svelte as a $effect
    // tracking trajectory_active true→false (grep that file for "T5 pause writeback"
    // — the dead-effect stub stays there as a don't-restore sentinel). It gated on the
    // trajectory_active derived (= `trajectory_frame_positions != null`), which only
    // flips false on trajectory unload — at which point current_structure is already
    // null and the inner block short-circuits. Co-locating the writeback
    // here with the pause event is the simpler, correct approach.
    //
    // pause_playback is the ONLY entry point for sync_structure_sites_to_frame_positions().
    // A per-scrub call from the current_frame $effect was tried and reverted
    // (see the NOTE in that $effect): writing current_structure per frame
    // wakes the bond pipeline (async worker recompute lags by one tick →
    // visible cylinder flicker during scrub). Trade-off: click/drag during
    // scrub-while-paused hits the LAST-paused frame's xyz, not the displayed
    // scrub frame. Acknowledged limitation; needs a non-cascading scrub-target
    // state to fix properly.
    //
    // Indexed/streaming trajectories without position_cache: skip — the
    // pre-Phase-4 fallback already writes current_structure = frame.structure
    // per frame, so positions are already in current_structure. The helper
    // bails when trajectory_frame_positions is null.
    sync_structure_sites_to_frame_positions()
    if (trajectory) {
      on_pause?.({
        trajectory: trajectory,
        step_idx: current_step_idx,
        frame_count: total_frames,
      })
    }
  }
  $effect(() => { // Effect to manage playback interval
    // Only watch is_playing and frame_rate_ms, not play_interval itself
    const playing = is_playing
    const rate_ms = 1000 / fps

    if (playing) {
      // Clear existing interval if it exists - use untrack to avoid circular dependency
      const current_interval = untrack(() => play_interval)
      if (current_interval !== undefined) clearInterval(current_interval)

      // Create new interval with current frame rate
      play_interval = setInterval(() => {
        if (current_step_idx >= total_frames - 1) {
          const { frame } = get_current_frame_data()
          if (trajectory) {
            on_end?.({
              trajectory,
              step_idx: current_step_idx,
              frame_count: total_frames,
              frame,
            })
          }
          go_to_step(0) // Loop back to 1st step
          if (trajectory) {
            on_loop?.({ trajectory, frame_count: total_frames })
          }
        } else next_step()
      }, rate_ms)
    } else {
      // Clear interval when not playing - use untrack to avoid circular dependency
      const current_interval = untrack(() => play_interval)
      if (current_interval !== undefined) {
        clearInterval(current_interval)
        play_interval = undefined
      }
    }
  })

  // Cleanup interval on component destroy
  $effect(() => () => {
    if (play_interval !== undefined) clearInterval(play_interval)
    if (pushback_timer) clearTimeout(pushback_timer)
  })

  // Handle internal file format drops
  async function handle_internal_file_drop(internal_data: string): Promise<boolean> {
    try {
      const file_info = JSON.parse(internal_data)

      // Check if this is a binary file
      if (file_info.is_binary) {
        if (file_info.content instanceof ArrayBuffer) {
          await load_trajectory_data(file_info.content, file_info.name)
        } else if (file_info.content_url) {
          const response = await fetch(file_info.content_url)
          const array_buffer = await response.arrayBuffer()
          await load_trajectory_data(array_buffer, file_info.name)
        } else {
          console.warn(
            `Binary file without ArrayBuffer or blob URL:`,
            file_info.name,
          )
        }
      } else {
        await load_trajectory_data(file_info.content, file_info.name)
      }
      return true
    } catch (error) {
      console.warn(`Failed to parse internal file data:`, error)
      return false
    }
  }

  // Handle file drop events with optimized large file support
  async function handle_file_drop(event: DragEvent) {
    event.preventDefault()
    dragover = false
    if (!allow_file_drop) return

    loading = true

    try {
      // Check for our custom internal file format first
      const internal_data = event.dataTransfer?.getData(
        `application/x-catgo-file`,
      )
      if (internal_data) {
        const handled = await handle_internal_file_drop(internal_data)
        if (handled) return
      }

      // Handle URL-based files (e.g. from FilePicker)
      const handled = await handle_url_drop(event, async (content, filename) => {
        current_filename = filename
        file_size = content instanceof ArrayBuffer
          ? content.byteLength
          : new Blob([content]).size
        await load_trajectory_data(content, filename)
      }).catch(() => false)

      if (handled) {
        return
      }

      // Handle file system drops with optimized large file support
      const file = event.dataTransfer?.files[0]
      if (file) {
        file_size = file.size
        current_file_path = file.webkitRelativePath || file.name
        file_object = file

        // Read file content directly
        const content = await read_file_content(file)
        await load_trajectory_data(content, file.name)
      }

      // Check for plain text data (fallback)
      const text_data = event.dataTransfer?.getData(`text/plain`)
      if (text_data) {
        file_size = new Blob([text_data]).size // Calculate byte size of text data
        await load_trajectory_data(text_data, `trajectory.json`)
        return
      }
    } catch (error) {
      console.error(`File drop failed:`, error)
      error_msg = `Failed to load file: ${error}`
      on_error?.({ error_msg, filename: current_filename, file_size })
    } finally {
      loading = false
    }
  }

  // Handle file selected from FileSourceDialog (local browse or remote download)
  async function handle_dialog_file(file: File) {
    loading = true
    error_msg = null
    try {
      file_size = file.size
      current_file_path = file.name
      file_object = file
      current_filename = file.name
      const content = await read_file_content(file)
      await load_trajectory_data(content, file.name)
    } catch (error) {
      console.error(`File load failed:`, error)
      error_msg = `Failed to load file: ${error}`
      on_error?.({ error_msg, filename: current_filename, file_size })
    } finally {
      loading = false
    }
  }

  $effect(() => { // Load trajectory from URL when data_url is provided
    if (data_url && !trajectory) {
      loading = true
      error_msg = null

      load_from_url(data_url, async (content, filename) => {
        current_filename = filename
        file_size = content instanceof ArrayBuffer
          ? content.byteLength
          : new Blob([content]).size
        await load_trajectory_data(content, filename)
      })
        .then(() => {
          loading = false
        })
        .catch((err: Error) => {
          console.error(`Failed to load trajectory from URL:`, err)
          error_msg = `Failed to load trajectory: ${err.message}`
          current_filename = undefined
          file_size = undefined
          loading = false
          on_error?.({
            error_msg,
            filename: current_filename || undefined,
            file_size: file_size || undefined,
          })
        })
    }
  })

  // Watch for frame rate changes
  $effect(() => {
    on_frame_rate_change?.({ trajectory, fps: fps })
  })

  async function load_trajectory_data(data: string | ArrayBuffer, filename: string) {
    loading = true
    error_msg = null
    parsing_progress = null

    // Reset previous loading state
    orig_data = null

    try {
      const data_size = data instanceof ArrayBuffer ? data.byteLength : data.length

      // Determine loading strategy based on file size
      const bin_file_threshold = loading_options.bin_file_threshold ??
        MAX_BIN_FILE_SIZE
      const text_file_threshold = loading_options.text_file_threshold ??
        MAX_TEXT_FILE_SIZE
      if (
        (data instanceof ArrayBuffer && data_size > bin_file_threshold) ||
        (typeof data === `string` && data_size > text_file_threshold)
      ) { // Large files: Use indexed loading
        await load_with_indexing(data, filename)
      } else {
        // Small files: Use regular loading
        trajectory = await parse_trajectory_async(data, filename, (progress) => {
          parsing_progress = progress
        })
      }

      // New trajectory loaded — synchronously reset the pending-ops queue.
      // (The length-change $effect also resets, but it runs async; the
      // synchronous code below reads `trajectory.frames[0].structure` and
      // must not see ops queued against the PREVIOUS trajectory.)
      pending_ops = []
      frame_op_cursor = new Array(trajectory?.frames?.length ?? 0).fill(0)
      position_cache = null
      force_cache = null
      traj_load_seq += 1

      current_step_idx = 0
      current_filename = filename

      const file_size_bytes = data instanceof ArrayBuffer
        ? data.byteLength
        : new Blob([data]).size
      on_file_load?.({ // emit file load event
        trajectory,
        frame_count: trajectory?.frames.length ?? 0,
        total_atoms: trajectory?.frames[0]?.structure.sites.length ?? 0,
        filename,
        file_size: file_size_bytes,
      })
    } catch (err) {
      const unsupported_message = get_unsupported_format_message(
        filename,
        typeof data === `string` ? data : ``,
      )
      error_msg = unsupported_message || `Failed to parse trajectory: ${err}`
      current_filename = undefined
      file_size = undefined

      on_error?.({ // emit error event
        error_msg,
        filename: current_filename || undefined,
        file_size: file_size || undefined,
      })
    } finally {
      parsing_progress = null
      loading = false
    }
  }

  // Load using indexed parsing for large files
  async function load_with_indexing(data: string | ArrayBuffer, filename: string) {
    try { // Use indexed parsing for efficient large file handling
      trajectory = await parse_trajectory_async(data, filename, (progress) => {
        parsing_progress = progress
      }, { use_indexing: true, ...loading_options })

      // New trajectory — synchronously reset pending-ops queue.
      pending_ops = []
      frame_op_cursor = new Array(trajectory?.frames?.length ?? 0).fill(0)
      position_cache = null
      force_cache = null
      traj_load_seq += 1

      // Attach frame loader and original data directly to trajectory for unified access
      orig_data = data
      // @ts-expect-error - dynamically adding frame_loader for indexed trajectories
      trajectory.frame_loader = create_frame_loader(filename)
    } catch (error) {
      console.error(`Indexed loading failed:`, error)
      throw error
    }
  }

  // Get current view mode label
  let current_view_label = $derived(get_view_mode_label(display_mode))

  let view_mode_dropdown_open = $state(false)

  // Handle click outside to close dropdowns
  function handle_click_outside(event: MouseEvent) {
    const target = event.target as Element
    if (view_mode_dropdown_open) {
      const dropdown_wrapper = target.closest(`.view-mode-dropdown-wrapper`)
      // Don't close if clicking on dropdown wrapper (contains both button and menu)
      if (!dropdown_wrapper) view_mode_dropdown_open = false
    }
  }

  // Handle keyboard shortcuts
  function onkeydown(event: KeyboardEvent) {
    if (!trajectory) return

    // Don't handle shortcuts if user is typing in an input field (but allow if it's our step input and not focused)
    const target = event.target as HTMLElement
    const is_step_input = target.classList.contains(`step-input`)
    const is_input_focused = target.tagName === `INPUT` ||
      target.tagName === `TEXTAREA`

    // Skip if typing in an input that's not our step input
    if (is_input_focused && !is_step_input) return

    // If typing in step input, only handle certain navigation keys
    if (is_step_input && is_input_focused) {
      // Allow normal typing, but handle special navigation keys
      if ([`Escape`, `Enter`].includes(event.key)) target.blur() // Remove focus from input
      return
    }

    const action = get_keyboard_action(event, {
      total_frames,
      current_step_idx,
      is_playing,
      has_fullscreen_toggle: !!fullscreen_toggle,
      view_mode_dropdown_open,
      fps_range,
      fps,
    })
    if (!action) return

    switch (action.type) {
      case `toggle_play`: toggle_play(); break
      case `prev_step`: prev_step(); break
      case `next_step`: next_step(); break
      case `go_to_step`: go_to_step(action.idx); break
      case `fullscreen`: toggle_fullscreen(wrapper); break
      case `fps_change`:
        fps = clamp_fps(fps + action.delta, fps_range)
        on_frame_rate_change?.({ trajectory, fps })
        break
      case `close_dropdown`: view_mode_dropdown_open = false; break
      case `exit_fullscreen`: document.exitFullscreen(); break
    }
  }

  // Separate state variables for each pane to match component prop types
  let structure_info_open = $state(false)
  let structure_controls_open = $state(false)
  let scatter_controls = $state<ControlsConfig>({ open: false })
  let trajectory_export_open = $state(false)
  let fullscreen = $state(false)

  // Cross-frame editing: apply atom manipulations to all frames
  type EditMode = 'view' | 'edit-current' | 'edit-all'
  let edit_mode = $state<EditMode>('edit-current')
  let cross_frame_busy = $state(false)

  // ─── Pending cross-frame ops (lazy materialization) ───
  //
  // Replaces the eager "iterate every frame NOW" model with "record an op
  // once, apply per-frame when that frame is read". Cross-frame edit cost at
  // the edit site becomes O(1); per-frame cost is paid lazily on access, or
  // in bulk via `flush_pending_ops()` before save/export.
  //
  // Invariants:
  //   - `pending_ops` grows append-only. Each entry is an immutable op.
  //   - `frame_op_cursor[idx] === N` means frame `idx` has applied ops[0..N-1].
  //   - When `cursor[idx] === pending_ops.length`, frame `idx` is up to date.
  //   - `flush_pending_ops()` materializes every frame, clears the queue, and
  //     zeroes all cursors.
  //
  // Producers (handle_atoms_deleted enqueues at HEAD; add/replace/manipulate remain
  // eager and call flush_pending_ops first) push ops via enqueue_pending_op. Consumers
  // (materialize_frame on read, flush_pending_ops on save/export, _chunked_cross_frame_edit's
  // flush pre-pass, drag's flush pre-pass) drain. Search "enqueue_pending_op" for the
  // live producer set.
  type PendingOp =
    | { kind: 'delete';     site_indices: number[] }
    | { kind: 'add';        element: ElementSymbol; position: Vec3 }
    | { kind: 'replace';    site_indices: number[]; new_element: ElementSymbol }
    | { kind: 'manipulate'; displacements: Map<number, Vec3> }

  let pending_ops     = $state<PendingOp[]>([])
  let frame_op_cursor = $state<number[]>([])

  // Bumped whenever the CURRENT frame's positions change in place (atom
  // edit). Passed to <Structure> → bond-cache driver so bonds recompute
  // even though current_step_idx didn't move (issue #51 bond defect).
  // `all` = drop every frame's bond cache (edit-all fan-out), else just idx.
  let trajectory_positions_version = $state<{ v: number; all: boolean }>({ v: 0, all: false })

  // Keep `frame_op_cursor` length in sync with `trajectory.frames.length`.
  // The only way the frame count changes in steady state is a brand-new
  // trajectory being loaded — in that case the old queue is stale and we
  // discard it. `trajectory = { ...trajectory }` refreshes (same frame count)
  // do NOT trigger this branch, so in-flight ops survive internal refreshes.
  $effect(() => {
    const n = trajectory?.frames?.length ?? 0
    if (frame_op_cursor.length !== n) {
      pending_ops = []
      frame_op_cursor = new Array(n).fill(0)
    }
  })

  /** Pure: apply a single op to a structure, return a new structure. */
  function apply_op(structure: AnyStructure, op: PendingOp): AnyStructure {
    switch (op.kind) {
      case 'delete':
        return delete_atoms(structure, op.site_indices)
      case 'add':
        return add_atom(structure, op.element, op.position)
      case 'replace': {
        let s = structure
        for (const idx of op.site_indices) {
          s = replace_atom(s, idx, op.new_element)
        }
        return s
      }
      case 'manipulate': {
        if (!structure?.sites) return structure
        // Same xyz+abc delta-add primitive as the directly-committed current
        // frame, so fanned-out frames stay consistent for fractional export.
        let inv_flat:
          | [number, number, number, number, number, number, number, number, number]
          | null = null
        if (`lattice` in structure && (structure as PymatgenStructure).lattice) {
          const li = matrix_inverse_3x3(
            transpose_3x3_matrix((structure as PymatgenStructure).lattice.matrix),
          )
          inv_flat = [
            li[0][0], li[0][1], li[0][2],
            li[1][0], li[1][1], li[1][2],
            li[2][0], li[2][1], li[2][2],
          ]
        }
        return {
          ...structure,
          sites: apply_displacements(structure.sites, op.displacements, inv_flat),
        }
      }
    }
  }

  /** Apply any unapplied pending ops to frame[idx], cache the result back on
   *  the frame, advance the cursor, and return the materialized structure.
   *  Returns `undefined` if idx is out of range or no trajectory. */
  function materialize_frame(idx: number): AnyStructure | undefined {
    if (!trajectory) return undefined
    const frames = trajectory.frames
    if (idx < 0 || idx >= frames.length) return undefined
    const frame = frames[idx]
    if (!frame) return undefined
    const cursor = frame_op_cursor[idx] ?? 0
    if (cursor >= pending_ops.length) return frame.structure
    let s: AnyStructure = frame.structure
    for (let i = cursor; i < pending_ops.length; i++) {
      s = apply_op(s, pending_ops[i])
    }
    frames[idx] = { ...frame, structure: s }
    frame_op_cursor[idx] = pending_ops.length
    return s
  }

  /** Force all pending ops to be applied to every frame. Call before any
   *  consumer that reads all frames at once (save, export, bulk serialize).
   *  After this returns, the queue is empty and every cursor is at zero. */
  function flush_pending_ops(): void {
    if (!trajectory || pending_ops.length === 0) return
    for (let i = 0; i < trajectory.frames.length; i++) {
      materialize_frame(i)
    }
    pending_ops = []
    frame_op_cursor = new Array(trajectory.frames.length).fill(0)
    // Notify consumers that a bulk update happened (matches the pattern used
    // by `_chunked_cross_frame_edit` when it completes).
    trajectory = { ...trajectory }
  }

  /** Record a cross-frame op without touching any frames. O(1). */
  function enqueue_pending_op(op: PendingOp): void {
    pending_ops = [...pending_ops, op]
  }

  /** True when this trajectory is in-memory (frames mutable, position_cache
   *  usable). Indexed/streaming trajectories have a frame_loader. */
  function _is_in_memory(): boolean {
    if (!trajectory) return false
    // @ts-expect-error - frame_loader is added dynamically for indexed/streaming trajectories
    return !trajectory.frame_loader
  }
  /** Gate for cross-frame propagation of add/delete/replace edits: true only
   *  in edit-all on an in-memory trajectory. In the default `edit-current`
   *  mode these edits stay current-frame-scoped (intentional per the 3-state
   *  model — issue #51). */
  function _can_cross_frame_edit(): boolean {
    return edit_mode === 'edit-all' && _is_in_memory()
  }

  function handle_atoms_manipulated(event: AtomManipulationEvent) {
    if (!trajectory) return
    const { displacements } = event
    if (displacements.size === 0) return

    // view mode: edits disabled. (Edits shouldn't fire, but guard anyway —
    // never silently mutate while the user is in inspect mode.)
    if (edit_mode === `view`) return
    if (!_is_in_memory()) {
      // Indexed/streaming: positions live in frame.structure already (slow
      // path writes current_structure = frame.structure each frame). Just
      // refresh so the change is observed.
      trajectory = { ...trajectory }
      return
    }

    // Catch every frame (incl. the current one) up to the pending queue
    // before this eager in-place edit, so we commit on top of the latest
    // materialized state and a prior lazy op can't be skipped on the
    // current frame (its cursor is pre-advanced below). No-op when the
    // queue is empty. Restores the guard the old `_chunked_cross_frame_edit`
    // ran before every eager edit.
    flush_pending_ops()

    const frames = trajectory.frames
    const idx = current_step_idx

    // Build inverse-lattice once (cartesian Δ → fractional Δ for abc).
    let inv: Matrix3x3 | null = null
    const ref = frames[idx]?.structure
    if (ref && `lattice` in ref && (ref as PymatgenStructure).lattice) {
      const lat = (ref as PymatgenStructure).lattice
      inv = matrix_inverse_3x3(transpose_3x3_matrix(lat.matrix))
    }
    const inv_flat = inv
      ? [inv[0][0], inv[0][1], inv[0][2], inv[1][0], inv[1][1], inv[1][2], inv[2][0], inv[2][1], inv[2][2]] as
        [number, number, number, number, number, number, number, number, number]
      : null

    // ── Single write path: always commit the CURRENT frame first ──────────
    const cur = frames[idx]
    if (cur?.structure?.sites) {
      const new_sites = apply_displacements(cur.structure.sites, displacements, inv_flat)
      frames[idx] = { ...cur, structure: { ...cur.structure, sites: new_sites } }
      // Mirror straight into the render source so Phase-2 GPU + bond getter
      // see the edit. The snap-back window is fully closed once Task 6
      // reorders interaction.svelte.ts to fire this BEFORE clearing
      // realtime_position_overrides.
      const slice = position_cache?.[idx]
      if (slice) write_sites_to_cache_slice(slice, new_sites)
    }

    if (edit_mode === `edit-current`) {
      // Signal bond pipeline THIS frame changed (drop only idx's cache).
      trajectory_positions_version = { v: trajectory_positions_version.v + 1, all: false }
      // Other frames stay independent (use-case 2).
      trajectory = { ...trajectory }
      return
    }

    // ── edit-all: fan out lazily via the pending-ops machinery ────────────
    // (use-case 3: many frames, must not freeze). Other frames materialize
    // their copy of this displacement on next read (scrub / export / flush)
    // exactly like the proven `delete` path. The current frame is already
    // committed above, so record the op with its cursor pre-advanced past
    // the current frame.
    enqueue_pending_op({ kind: `manipulate`, displacements: new Map(displacements) })
    frame_op_cursor[idx] = pending_ops.length // current frame already applied
    // Drop EVERY frame's bond cache (lazy recompute via keyframe/prefetch
    // scheduler keeps long trajectories smooth).
    trajectory_positions_version = { v: trajectory_positions_version.v + 1, all: true }
    trajectory = { ...trajectory }
  }

  /**
   * Unified topology-edit write path (add / delete / replace), mirroring the
   * #51 manipulate path. Always commits the CURRENT frame (the fast-path
   * renders position_cache / slow-path renders frames[idx].structure — NOT
   * the bound current_structure — so the current frame must be committed
   * here, never skipped). Topology changes atom count → drop position_cache
   * (slow-path renders the edited frame; bond cache invalidated via the
   * {all:true} positions-version). edit-current stops; edit-all fans the op
   * out lazily via the existing pending-ops machinery.
   */
  function _apply_topology_op(op: PendingOp) {
    // W5: a topology-altering edit while paused disables resume (even in the
    // not-in-memory case the local topology / position_cache is now invalid).
    if (!is_playing) resume_disabled = true
    if (!trajectory) return
    if (edit_mode === `view`) return
    if (!_is_in_memory()) {
      // Indexed/streaming slow path already renders frame.structure each
      // frame; the editing UI mutated the current structure via bind. Just
      // refresh so the change is observed.
      trajectory = { ...trajectory }
      return
    }

    // Catch every frame up to the pending queue before this eager topology
    // edit, so the current frame is committed on top of the latest
    // materialized state and a prior lazy op can't be skipped on it (its
    // cursor is pre-advanced below). No-op when the queue is empty.
    // Restores the guard the old `_chunked_cross_frame_edit` ran first.
    flush_pending_ops()

    const frames = trajectory.frames
    const idx = current_step_idx
    const cur = frames[idx]
    if (!cur?.structure) return

    // Commit the CURRENT frame.
    frames[idx] = { ...cur, structure: apply_op(cur.structure, op) }

    // Topology changed: the Float32 position cache (fixed per-frame length)
    // is invalid. Dropping it makes the render fall back to the slow path
    // (current_structure = frames[idx].structure) so the edit is visible on
    // the current frame; the {all:true} bump invalidates every bond frame.
    position_cache = null
    force_cache = null
    trajectory_positions_version = { v: trajectory_positions_version.v + 1, all: true }

    if (edit_mode === `edit-current`) {
      // Other frames stay independent (use-case 2).
      trajectory = { ...trajectory }
      return
    }

    // edit-all: fan out lazily (use-case 3 — many frames, must not freeze).
    // Other frames materialize this op on next read (scrub / export / flush)
    // exactly like the proven delete path. Current frame already applied →
    // pre-advance its cursor so materialize_frame won't re-apply it.
    enqueue_pending_op(op)
    frame_op_cursor[idx] = pending_ops.length
    trajectory = { ...trajectory }
  }

  function handle_atom_added(event: { element: ElementSymbol; position: Vec3 }) {
    _apply_topology_op({ kind: `add`, element: event.element, position: event.position })
  }

  function handle_atoms_deleted(event: { site_indices: number[] }) {
    _apply_topology_op({ kind: `delete`, site_indices: event.site_indices })
  }

  function handle_atom_replaced(event: { site_indices: number[]; new_element: ElementSymbol }) {
    _apply_topology_op({ kind: `replace`, site_indices: event.site_indices, new_element: event.new_element })
  }

  function manifest_formula(): string {
    const structure = current_frame?.structure ?? trajectory?.frames?.[current_step_idx]?.structure
    const counts = new Map<string, number>()
    for (const site of structure?.sites ?? []) {
      const el = site.species?.[0]?.element ?? site.label ?? `?`
      counts.set(el, (counts.get(el) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([el, n]) => n === 1 ? el : `${el}${n}`)
      .join(``)
  }

  function inspect_trajectory_atoms() {
    const structure = current_frame?.structure ?? trajectory?.frames?.[current_step_idx]?.structure
    return build_atom_graph(structure)
  }

  function require_editable_memory_trajectory(): TrajectoryType {
    if (!trajectory) throw new Error(`No trajectory loaded.`)
    // @ts-expect-error frame_loader is a runtime extension
    if (trajectory.frame_loader) {
      throw new Error(`All-frame edits on streamed trajectories are not available until every frame is materialized.`)
    }
    const topology_error = validate_uniform_topology(trajectory)
    if (topology_error) throw new Error(topology_error)
    flush_pending_ops()
    return trajectory
  }

  function scale_all_frames(factor: number): TrajectoryType {
    if (!trajectory) throw new Error(`No trajectory loaded.`)
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`Scale factor must be positive.`)
    }
    flush_pending_ops()
    trajectory.frames = trajectory.frames.map((frame) => ({
      ...frame,
      structure: scale_structure_geometry(frame.structure, factor),
    }))
    const pane_trajectory = trajectory as PaneTrajectory
    if (pane_trajectory.frame_loader) {
      pane_trajectory.pane_transformations ??= []
      pane_trajectory.pane_transformations.push({ kind: `scale_geometry`, factor })
    }
    return trajectory
  }

  function refresh_after_external_edit(): void {
    position_cache = null
    force_cache = null
    topology_initialized = false
    current_frame = trajectory?.frames?.[current_step_idx] ?? null
    trajectory_positions_version = { v: trajectory_positions_version.v + 1, all: true }
    trajectory = trajectory ? { ...trajectory } : trajectory
  }

  function handle_trajectory_command(action: string, args: Record<string, unknown>) {
    if (action === `inspect`) return { atoms: inspect_trajectory_atoms(), current_frame: current_step_idx, total_frames }
    if (action === `add_atom`) {
      const target = require_editable_memory_trajectory()
      const element = String(args.element ?? ``) as ElementSymbol
      const position = Array.isArray(args.position) ? args.position.map(Number) : []
      if (!element || position.length !== 3 || !position.every(Number.isFinite)) {
        throw new Error(`element and a 3D Cartesian position are required.`)
      }
      target.frames = target.frames.map((frame) => ({
        ...frame,
        structure: add_atom(
          frame.structure,
          element,
          [position[0], position[1], position[2]],
        ),
      }))
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    if (action === `delete_atoms`) {
      const target = require_editable_memory_trajectory()
      const atom_count = target.frames[0]?.structure.sites.length ?? 0
      const indices = [...new Set((Array.isArray(args.indices) ? args.indices : []).map(Number))]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < atom_count)
      if (!indices.length) throw new Error(`At least one valid atom index is required.`)
      for (let i = 0; i < target.frames.length; i++) {
        target.frames[i] = { ...target.frames[i], structure: delete_atoms(target.frames[i].structure, indices) }
      }
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    if (action === `move_atoms`) {
      const target = require_editable_memory_trajectory()
      const moves = new Map<number, [number, number, number]>()
      for (const move of Array.isArray(args.moves) ? args.moves as Record<string, unknown>[] : []) {
        const d = Array.isArray(move.displacement) ? move.displacement.map(Number) : []
        if (Number.isInteger(Number(move.index)) && d.length === 3 && d.every(Number.isFinite)) {
          moves.set(Number(move.index), [d[0], d[1], d[2]])
        }
      }
      for (let i = 0; i < target.frames.length; i++) {
        const structure = target.frames[i].structure
        let inv_flat: [number, number, number, number, number, number, number, number, number] | null = null
        if (`lattice` in structure && structure.lattice) {
          const inv = matrix_inverse_3x3(transpose_3x3_matrix(structure.lattice.matrix))
          inv_flat = [inv[0][0], inv[0][1], inv[0][2], inv[1][0], inv[1][1], inv[1][2], inv[2][0], inv[2][1], inv[2][2]]
        }
        target.frames[i] = { ...target.frames[i], structure: { ...structure, sites: apply_displacements(structure.sites, moves, inv_flat) } }
      }
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    if (action === `replace_atoms`) {
      const target = require_editable_memory_trajectory()
      const element = String(args.element ?? ``) as ElementSymbol
      const atom_count = target.frames[0]?.structure.sites.length ?? 0
      const indices = [...new Set((Array.isArray(args.indices) ? args.indices : []).map(Number))]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < atom_count)
      if (!element || !indices.length) throw new Error(`element and atom indices are required.`)
      target.frames = target.frames.map((frame) => {
        let structure = frame.structure
        for (const index of indices) structure = replace_atom(structure, index, element)
        return { ...frame, structure }
      })
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    if (action === `scale_geometry`) {
      const target = scale_all_frames(Number(args.factor))
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    throw new Error(`Unsupported trajectory command: ${action}`)
  }

  $effect(() => {
    if (!viewer_id || !tab_id) return
    const cleanup = untrack(() => register_viewer({
      get_manifest: () => ({
        viewer_id,
        tab_id,
        leaf_id,
        position: pane_position,
        pane_number,
        label: manifest_formula() || filename || `Trajectory`,
        filename,
        formula: manifest_formula(),
        kind: trajectory ? `trajectory` : `empty`,
        active: is_active,
        current_frame: current_step_idx,
        total_frames,
        atom_count: (current_frame?.structure ?? trajectory?.frames?.[current_step_idx]?.structure)?.sites?.length ?? 0,
        // @ts-expect-error frame_loader is a runtime extension
        streaming: !!trajectory?.frame_loader,
        // @ts-expect-error frame_loader is a runtime extension
        editable: !!trajectory && !trajectory.frame_loader,
      }),
      get_structure: () => current_frame?.structure ?? trajectory?.frames?.[current_step_idx]?.structure,
      set_structure: (next) => {
        if (!trajectory?.frames?.[current_step_idx]) return
        trajectory.frames[current_step_idx] = { ...trajectory.frames[current_step_idx], structure: next }
        refresh_after_external_edit()
      },
      set_scene_prop: (key, value) => {
        if (trajectory_scene_props) (trajectory_scene_props as Record<string, unknown>)[key] = value
      },
      set_selection: (indices) => { selected_sites = indices },
      select_by_element: (element) => {
        const structure = current_frame?.structure ?? trajectory?.frames?.[current_step_idx]?.structure
        const indices = (structure?.sites ?? [])
          .map((site, idx) => site.species?.[0]?.element === element ? idx : -1)
          .filter((idx) => idx >= 0)
        selected_sites = indices
        return indices.length
      },
      clear_selection: () => { selected_sites = [] },
      inspect_atoms: inspect_trajectory_atoms,
      add_atom: (element, position) => {
        const target = require_editable_memory_trajectory()
        target.frames = target.frames.map((frame) => ({
          ...frame,
          structure: add_atom(frame.structure, element as ElementSymbol, position),
        }))
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      delete_atoms: (indices) => {
        const target = require_editable_memory_trajectory()
        for (let i = 0; i < target.frames.length; i++) {
          target.frames[i] = { ...target.frames[i], structure: delete_atoms(target.frames[i].structure, indices) }
        }
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      replace_atoms: (indices, element) => {
        const target = require_editable_memory_trajectory()
        target.frames = target.frames.map((frame) => {
          let structure = frame.structure
          for (const index of indices) structure = replace_atom(structure, index, element as ElementSymbol)
          return { ...frame, structure }
        })
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      move_atoms: (displacements) => {
        const target = require_editable_memory_trajectory()
        for (let i = 0; i < target.frames.length; i++) {
          const structure = target.frames[i].structure
          let inv_flat: [number, number, number, number, number, number, number, number, number] | null = null
          if (`lattice` in structure && structure.lattice) {
            const inv = matrix_inverse_3x3(transpose_3x3_matrix(structure.lattice.matrix))
            inv_flat = [inv[0][0], inv[0][1], inv[0][2], inv[1][0], inv[1][1], inv[1][2], inv[2][0], inv[2][1], inv[2][2]]
          }
          target.frames[i] = { ...target.frames[i], structure: { ...structure, sites: apply_displacements(structure.sites, displacements, inv_flat) } }
        }
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      scale_geometry: (factor) => {
        const target = scale_all_frames(factor)
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
    }))
    return cleanup
  })

  $effect(() => {
    if (!viewer_id) return
    trajectory
    current_step_idx
    current_frame
    pane_position
    is_active
    filename
    refresh_viewer_manifest(viewer_id)
    if (is_active) set_active_viewer(viewer_id)
  })
</script>

<svelte:document
  onfullscreenchange={() => {
    fullscreen = !!document.fullscreenElement
    on_fullscreen_change?.({ trajectory, is_fullscreen: fullscreen })
  }}
/>

<!-- The wrapper's element-level onkeydown only fires when focus is INSIDE it.
     When nothing is focused (focus on <body>), forward the trajectory shortcuts
     so keys like Ctrl+A→first frame / A·D / Space work without first clicking
     the viewer. If focus is on a specific element (an input, another pane), we
     bail and let that element's own handler decide — so this never hijacks keys
     from another focused pane. -->
<svelte:window onkeydown={(event) => {
  const ae = document.activeElement
  if (ae && ae !== document.body) return
  onkeydown(event)
}} />

<div
  class:dragover
  class:active={is_playing || structure_info_open || structure_controls_open ||
  scatter_controls.open || trajectory_export_open || info_pane_open}
  bind:this={wrapper}
  bind:clientWidth={viewport.width}
  bind:clientHeight={viewport.height}
  role="button"
  tabindex="0"
  aria-label="Drop trajectory file here to load"
  ondrop={handle_file_drop}
  ondragover={(event) => {
    event.preventDefault()
    if (!allow_file_drop) return
    dragover = true
  }}
  ondragleave={(event) => {
    event.preventDefault()
    dragover = false
  }}
  onclick={handle_click_outside}
  {onkeydown}
  {...rest}
  class="trajectory {actual_layout} {rest.class ?? ``}"
>
  {#if loading}
    {@const text = parsing_progress
      ? `${parsing_progress.stage} (${parsing_progress.current}%)`
      : `Loading trajectory...`}
    <Spinner {text} {...spinner_props} />
  {:else if error_msg}
    <TrajectoryError
      {error_msg}
      on_dismiss={() => (error_msg = null)}
      {error_snippet}
    />
  {:else if trajectory}
    <!-- Trajectory Controls -->
    {#if supercell_scaling !== `1x1x1`}
      <div class="traj-supercell-warning" data-testid="traj-supercell-warning" role="alert">
        Supercell + trajectory: positions only cover the base cell. Atoms in
        supercell replicas display the topology-load positions, not the
        per-frame trajectory data.
      </div>
    {/if}
    {#if show_controls}
      <div class="trajectory-controls">
        {#if trajectory_controls}
          {@render trajectory_controls({
        trajectory,
        current_step_idx,
        total_frames: total_frames,
        on_step_change: go_to_step,
      })}
        {/if}
          {#if current_filename}
            <button
              class="filename"
              title="Click to copy filename <code>{current_filename}</code>"
              {@attach tooltip()}
              onclick={() => {
                if (current_filename) {
                  navigator.clipboard.writeText(current_filename)
                  filename_copied = true
                  setTimeout(() => filename_copied = false, 1000)
                }
              }}
            >
              {current_filename}
              {#if filename_copied}
                <Icon
                  icon="Check"
                  style="color: var(--success-color); position: absolute; right: 3pt; top: 50%; transform: translateY(-50%); font-size: 16px; animation: fade-in 0.1s; background: var(--surface-bg-hover); border-radius: 50%"
                />
              {/if}
            </button>
          {/if}

          <!-- Navigation controls -->
          <div class="nav-section">
            <button
              onclick={prev_step}
              disabled={current_step_idx === 0 || is_playing}
              title="Previous step"
            >
              ⏮
            </button>
            <button
              onclick={toggle_play}
              disabled={total_frames <= 1 || resume_disabled}
              title={resume_disabled
                ? `Structure was edited — reload trajectory to resume`
                : is_playing
                  ? `Pause playback`
                  : `Play trajectory`}
              aria-label={resume_disabled
                ? `Play (disabled — structure was edited, reload trajectory to resume)`
                : is_playing
                  ? `Pause playback`
                  : `Play trajectory`}
              class="play-button"
              class:playing={is_playing}
            >
              {is_playing ? `⏸` : `▶`}
            </button>
            <button
              onclick={next_step}
              disabled={current_step_idx === total_frames - 1 || is_playing}
              title="Next step"
            >
              ⏭
            </button>
          </div>

          <!-- Frame slider and counter -->
          <div class="step-section">
            <input
              type="number"
              min="0"
              max={total_frames - 1}
              bind:value={current_step_idx}
              class="step-input"
              title="Enter step number to jump to"
              aria-label="Step input"
              {@attach tooltip()}
            />
            <span aria-label="total frames">/ {format_num(total_frames, `.3~s`)}</span>
            <div class="slider-container">
              <input
                type="range"
                min="0"
                max={total_frames - 1}
                bind:value={current_step_idx}
                class="step-slider"
                title="Drag to navigate steps"
              />
              {#if step_label_positions.length > 0}
                <div class="step-labels">
                  {#each step_label_positions as step_idx (step_idx)}
                    {@const position_percent = total_frames > 1
              ? (step_idx / (total_frames - 1)) * 100
              : 0}
                    {@const adjusted_position = 1.5 + (position_percent * (100 - 2)) / 100}
                    <div class="step-tick" style:left="{adjusted_position}%"></div>
                    <div class="step-label" style:left="{adjusted_position}%">
                      {format_num(step_idx, `.3~s`)}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <!-- Frame rate control - only shown when playing -->
          {#if is_playing}
            <label
              class="fps-section"
              style="font-size: 0.9em; display: flex; align-items: center; gap: 5pt; margin-inline: 6pt"
            >
              FPS
              <input
                type="range"
                min={fps_range[0]}
                max={fps_range[1]}
                bind:value={fps}
                title="Frame rate: {format_num(fps, `.2~s`)} fps"
                style="width: clamp(60px, 8cqw, 90px); accent-color: var(--accent-color)"
              />
              <input
                type="number"
                min={fps_range[0]}
                max={fps_range[1]}
                bind:value={fps}
                title="Enter precise FPS value"
                style="text-align: center; border: var(--tooltip-border)"
              />
            </label>
          {/if}

          <!-- Frame info section -->
          <div class="info-section">
            <!-- Push-back current frame to remote -->
            {#if can_push_back}
              <button
                type="button"
                onclick={push_back_current_frame}
                disabled={pushback_status === `saving`}
                title={pushback_status === `saved`
                  ? `Saved to ${remote_origin?.dir_path}/${pushback_message}`
                  : pushback_status === `error`
                    ? `Error: ${pushback_message}`
                    : `Push frame ${current_step_idx} back to ${remote_origin?.dir_path}/${current_frame_source}`}
                class="push-back-btn"
                class:saved={pushback_status === `saved`}
                class:error={pushback_status === `error`}
              >
                {#if pushback_status === `saving`}
                  <Spinner style="width: 14px; height: 14px;" />
                {:else if pushback_status === `saved`}
                  &#x2713;
                {:else if pushback_status === `error`}
                  &#x2717;
                {:else}
                  &#x21E7;
                {/if}
              </button>
            {/if}
            <!-- Edit-scope mode: view → edit-current → edit-all -->
            <button
              type="button"
              onclick={() => {
                edit_mode = edit_mode === `view`
                  ? `edit-current`
                  : edit_mode === `edit-current`
                  ? `edit-all`
                  : `view`
              }}
              title={edit_mode === `view`
                ? `View only — scrubbing fast, atom edits disabled`
                : edit_mode === `edit-current`
                ? `Edit current frame only`
                : `Edit all frames (sync) — applies to every frame`}
              class="cross-frame-toggle"
              class:active={edit_mode !== `view`}
              disabled={cross_frame_busy}
            >
              {#if cross_frame_busy}
                <Spinner style="width: 14px; height: 14px;" />
              {:else}
                {edit_mode === `view` ? `👁` : edit_mode === `edit-current` ? `✏️1` : `✏️∀`}
              {/if}
            </button>
            {#if trajectory}
              <TrajectoryInfoPane
                {trajectory}
                {current_step_idx}
                {current_filename}
                {current_file_path}
                {file_size}
                {file_object}
                bind:pane_open={info_pane_open}
                max_height="calc({viewport.height}px - 50px)"
              />
            {/if}
            <!-- Trajectory Export Pane -->
            <TrajectoryExportPane
              bind:export_pane_open={trajectory_export_open}
              {trajectory}
              {wrapper}
              filename={current_filename || `trajectory`}
              on_step_change={go_to_step}
              bind:png_dpi
              crop_region={crop_region}
              max_height="calc({viewport.height}px - 50px)"
              {flush_pending_ops}
            />
            <!-- Display mode dropdown -->
            {#if plot_series.length > 0}
              <div class="view-mode-dropdown-wrapper">
                <button
                  onclick={() => (view_mode_dropdown_open = !view_mode_dropdown_open)}
                  title={current_view_label}
                  class="view-mode-button"
                  class:active={view_mode_dropdown_open}
                  style="background-color: transparent; padding: 0"
                >
                  <Icon
                    icon={({
                      structure: `Atom`,
                      'structure+scatter': `TwoColumns`,
                      'structure+histogram': `TwoColumns`,
                      scatter: `ScatterPlot`,
                      histogram: `Histogram`,
                    } as const)[display_mode]}
                  />
                  <Icon icon={view_mode_dropdown_open ? `ArrowUp` : `ArrowDown`} />
                </button>
                {#if view_mode_dropdown_open}
                  <div class="view-mode-dropdown">
                    {#each [
              { mode: `structure`, icon: `Atom`, label: `Structure-only` },
              {
                mode: `structure+scatter`,
                icon: `TwoColumns`,
                label: `Structure + Scatter`,
              },
              {
                mode: `structure+histogram`,
                icon: `TwoColumns`,
                label: `Structure + Histogram`,
              },
              { mode: `scatter`, icon: `ScatterPlot`, label: `Scatter-only` },
              {
                mode: `histogram`,
                icon: `Histogram`,
                label: `Histogram-only`,
              },
            ] as const as
                      option
                      (option.mode)
                    }
                      <button
                        class="view-mode-option"
                        class:selected={display_mode === option.mode}
                        onclick={() => {
                          display_mode = option.mode
                          on_display_mode_change?.({ trajectory, mode: option.mode })
                          view_mode_dropdown_open = false
                        }}
                      >
                        <Icon icon={option.icon} />
                        <span>{option.label}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
            <!-- Fullscreen button - rightmost position -->
            {#if fullscreen_toggle}
              <button
                type="button"
                onclick={() => fullscreen_toggle && toggle_fullscreen(wrapper)}
                title="{fullscreen ? `Exit` : `Enter`} fullscreen"
                aria-label="{fullscreen ? `Exit` : `Enter`} fullscreen"
                aria-pressed={fullscreen}
                class="fullscreen-button"
              >
                {#if typeof fullscreen_toggle === `function`}
                  {@render fullscreen_toggle()}
                {:else}
                  <Icon icon="{fullscreen ? `Exit` : ``}Fullscreen" />
                {/if}
              </button>
            {/if}
          </div>
      </div>
    {/if}

    <div
      class="content-area"
      class:hide-plot={!actual_show_plot}
      class:hide-structure={!show_structure}
      class:show-both={[`structure+scatter`, `structure+histogram`].includes(display_mode)}
      class:show-structure-only={display_mode === `structure`}
      class:show-plot-only={[`scatter`, `histogram`].includes(display_mode)}
    >
      <div class="structure-container" class:structure-hidden={!show_structure}>
        <Structure
          bind:structure={current_structure}
          {tab_id}
          {viewer_id}
          {is_active}
          bridge_structure={current_frame?.structure}
          handle_viewer_command={handle_trajectory_command}
          {trajectory_frame_positions}
          {trajectory_frame_forces}
          trajectory_step_idx={current_step_idx}
          trajectory_positions_version={trajectory_positions_version}
          get_trajectory_frame_positions={(i: number) => {
            const c = position_cache?.[i]
            if (c) return c
            // position_cache transiently null (an edit-all enqueued a
            // pending op in the same flush that nulled it): fall back to
            // the already-committed frame sites so the bond pipeline never
            // reads null mid-edit (issue #60). Indexed/streaming frames
            // have no in-memory structure → null (slow path handles it).
            const sites = (
              trajectory?.frames?.[i]?.structure as { sites?: { xyz: [number, number, number] }[] } | undefined
            )?.sites
            return sites ? sites_to_float32(sites) : null
          }}
          allow_file_drop={false}
          style="height: 100%; min-height: 0; z-index: 3; border-radius: 0"
          {...{
            align_on_load: 'none', // Trajectory frames should display raw coordinates, not rotated
            ...structure_props,
          }}
          register_as_viewer={false}
          bind:supercell_scaling
          bind:show_image_atoms
          bind:scene_props={trajectory_scene_props}
          bind:controls_open={structure_controls_open}
          bind:info_pane_open={structure_info_open}
          bind:hidden_elements
          bind:selected_sites
          on_atoms_manipulated={handle_atoms_manipulated}
          on_atom_added={handle_atom_added}
          on_atoms_deleted={handle_atoms_deleted}
          on_atom_replaced={handle_atom_replaced}
          hide_extra_tools={structure_props?.hide_extra_tools ?? true}
          trajectory_context={{ total_frames, on_step: (idx: number) => go_to_step(idx) }}
        />
      </div>

      {#if actual_show_plot}
        {#if display_mode === `scatter` || display_mode === `structure+scatter`}
          <ScatterPlot
            series={plot_series}
            {x_axis}
            {y_axis}
            {y2_axis}
            controls={scatter_controls}
            current_x_value={current_step_idx}
            change={plot_skimming ? handle_plot_change : undefined}
            padding={{ t: 20, b: 60, l: 100, r: has_y2_series ? 100 : 20 }}
            range_padding={0}
            style="height: 100%"
            legend={scatter_props?.legend}
            {...scatter_props}
            class="plot {scatter_props.class ?? ``}"
          >
            {#snippet tooltip({ x, y, metadata })}
              {#if metadata?.series_label}
                Step: {Math.round(x)}<br />
                {@html metadata.series_label}: {typeof y === `number` ? format_num(y) : y}
              {:else}
                Step: {Math.round(x)}<br />
                Value: {typeof y === `number` ? format_num(y) : y}
              {/if}
            {/snippet}
          </ScatterPlot>
        {:else if display_mode === `histogram` || display_mode === `structure+histogram`}
          <Histogram
            series={plot_series}
            x_axis={{
              label: String(histogram_props.x_axis?.label ?? y_axis_labels.y1),
              format: `.3~s`,
            }}
            y_axis={{ label: histogram_props.y_axis?.label ?? `Count`, format: `.3~s` }}
            mode={histogram_props.mode ?? `overlay`}
            show_legend={histogram_props.show_legend ?? plot_series.length > 1}
            legend={histogram_props.legend}
            style="height: 100%"
            {...histogram_props}
            class="plot {histogram_props.class ?? ``}"
            --ctrl-btn-top="6ex"
          >
            {#snippet tooltip({ value, count, property })}
              <div>Value: {format_num(value)}</div>
              <div>Count: {count}</div>
              <div>{property}</div>
            {/snippet}
          </Histogram>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="empty-state">
      <h3>{t('structure.trajectory_load_title')}</h3>
      <p>
        {t('structure.trajectory_load_hint')}
      </p>
      <div class="source-buttons">
        <label class="traj-browse-btn">
          {t('structure.browse_local')}
          <input type="file" accept=".xyz,.extxyz,.json,.json.gz,.traj,.h5,.hdf5,XDATCAR*" onchange={async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (file) await handle_dialog_file(file)
          }} hidden />
        </label>
        <button class="traj-browse-btn traj-remote-btn" onclick={() => show_file_dialog = true}>
          {t('structure.browse_remote')}
        </button>
      </div>
      <strong style="display: block; margin-block: 1em 1ex">{t('structure.trajectory_supported_formats')}:</strong>
      <ul>
        <li>{t('structure.trajectory_format_xdatcar')}</li>
        <li>{t('structure.trajectory_format_xyz')}</li>
        <li>{t('structure.trajectory_format_hdf5')}</li>
        <li>{t('structure.trajectory_format_ase')}</li>
        <li>{t('structure.trajectory_format_pymatgen')}</li>
        <li>{t('structure.trajectory_format_compressed')}</li>
      </ul>
    </div>
  {/if}
</div>

<FileSourceDialog
  bind:show={show_file_dialog}
  file_types={['.h5', '.hdf5', '.xyz', '.extxyz', '.traj', 'XDATCAR']}
  title={t('structure.trajectory_load_title')}
  description={t('structure.trajectory_load_description')}
  onfile={handle_dialog_file}
  onclose={() => show_file_dialog = false}
/>

<style>
  .trajectory {
    --border-radius: 4px;
    --min-height: 500px;
    display: flex;
    flex-direction: column;
    height: var(--traj-height, 100%);
    position: relative;
    min-height: var(--traj-min-height, var(--min-height));
    border-radius: var(--border-radius);
    box-sizing: border-box;
    /* NOTE: no `contain: layout` here. With it, on a pane-close relayout the
       slot grows but the Threlte <Canvas> wrapper's ResizeObserver never fires,
       so renderer.setSize + invalidate never run and the on-demand canvas keeps
       a stale/blank buffer (plain .structure panes, which lack `contain: layout`,
       repaint fine). `container-type: size` already supplies the size containment
       the inner panes' cqh units need. */
    z-index: var(--traj-z-index, 1);
    container-type: size; /* enable cqh for panes if explicit height is set */
  }
  .trajectory :global(.plot) {
    background: var(--surface-bg);
  }
  .trajectory.active {
    z-index: 2; /* needed so info/control panes from an active viewer overlay those of the next (if there is one) */
  }
  .trajectory.active .trajectory-controls {
    z-index: 5; /* needed so info/control panes from an active viewer its own plot when active, not sure why needed */
  }
  .trajectory:fullscreen {
    height: 100vh !important;
    width: 100vw !important;
    border-radius: 0 !important;
    background: var(--surface-bg);
  }
  /* Content area - grid container for equal sizing */
  .content-area {
    display: grid;
    flex: 1;
    min-height: 0; /* important for tall structure viewers not to overflow */
  }
  .trajectory.horizontal .content-area {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr;
  }
  .trajectory.vertical .content-area {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  /* When plot is hidden, structure takes full space */
  .content-area.hide-plot {
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr !important;
  }
  /* When structure is hidden, plot takes full space */
  .content-area.hide-structure {
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr !important;
  }
  /* Keep Structure mounted but hidden to preserve WebGL context */
  .structure-container {
    height: 100%;
    min-height: 0;
  }
  .structure-hidden {
    display: none;
  }
  /* Display mode specific layouts */
  .trajectory.horizontal .content-area.show-structure-only,
  .trajectory.vertical .content-area.show-structure-only {
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr !important;
  }
  .trajectory.horizontal .content-area.show-plot-only,
  .trajectory.vertical .content-area.show-plot-only {
    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr !important;
  }
  .trajectory.dragover {
    background-color: var(--traj-dragover-bg, var(--dragover-bg));
    border: var(--traj-dragover-border, var(--dragover-border));
  }

  .traj-supercell-warning {
    padding: 6px 12px;
    background: var(--warning-bg, #fef3c7);
    color: var(--warning-text, #78350f);
    font-size: 12px;
    border-bottom: 1px solid var(--warning-border, #fbbf24);
    z-index: 5;
  }
  .trajectory-controls {
    display: flex;
    align-items: center;
    gap: clamp(2pt, 1cqw, 1ex);
    padding: clamp(2pt, 0.5cqw, 1ex) clamp(4pt, 1cqw, 1.2ex);
    background: var(--surface-bg-hover);
    backdrop-filter: blur(4px);
    position: relative;
    border-radius: var(--border-radius) var(--border-radius) 0 0;
    z-index: 5; /* always above Structure viewer (z-index: 3) to prevent control button overlap */
  }
  .trajectory-controls:focus-within {
    z-index: var(--traj-controls-z-index, 999999999);
  }
  .trajectory-controls button {
    background: var(--btn-bg);
    font-size: clamp(0.8rem, 2cqw, 1rem);
  }
  .trajectory-controls button:hover:not(:disabled) {
    background: var(--btn-bg-hover);
  }
  .nav-section {
    display: flex;
    align-items: center;
    gap: clamp(1pt, 0.5cqw, 5pt);
    flex-shrink: 0;
  }
  .step-section {
    display: flex;
    align-items: center;
    gap: clamp(0.25rem, 1.5cqw, 0.5rem);
    flex: 1;
    min-width: 0;
  }
  .step-input {
    border: 1px solid rgba(99, 179, 237, 0.3);
    text-align: center;
    margin: 0 -5px 0 0;
    padding: 2px;
  }
  .slider-container {
    position: relative;
    flex: 1;
    min-width: var(--trajectory-slider-min-width, 100px);
  }
  .step-slider {
    width: 100%;
    accent-color: var(--accent-color);
  }
  .step-labels {
    position: absolute;
    left: 0;
    right: 0;
  }
  .step-tick {
    position: absolute;
    transform: translateX(-50%);
    width: var(--trajectory-step-tick-width, 1px);
    height: var(--trajectory-step-tick-height, 4px);
    background: var(--text-color-muted);
    top: -9pt;
  }
  .step-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: clamp(0.5em, 1.2cqw, 0.65em);
    color: var(--text-color-muted);
    white-space: nowrap;
    text-align: center;
    top: -1.7ex;
  }
  button.filename {
    align-items: center;
    white-space: nowrap;
    padding: var(--trajectory-filename-padding, 3pt 4pt);
    border-radius: var(--trajectory-filename-border-radius, 2px);
    max-width: clamp(150px, 20cqw, 250px);
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
    position: relative;
    font-family: monospace;
    font-size: 0.9em;
    background: var(--code-bg, rgba(0, 0, 0, 0.1));
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  .fullscreen-button {
    background: transparent !important;
    padding: 0;
  }
  .fullscreen-button:hover:not(:disabled) {
    background: var(--border-color);
  }
  .push-back-btn {
    background: transparent !important;
    padding: 0;
    color: var(--success-color, #51cf66);
    font-size: 1.1em;
    transition: color 0.2s;
  }
  .push-back-btn:hover:not(:disabled) {
    background: var(--border-color) !important;
  }
  .push-back-btn.error {
    color: var(--error-color, #ef4444);
  }
  .cross-frame-toggle {
    background: transparent !important;
    padding: 0;
    opacity: 0.5;
  }
  .cross-frame-toggle.active {
    opacity: 1;
    color: var(--accent-color, #3b82f6);
  }
  .cross-frame-toggle:hover:not(:disabled) {
    background: var(--border-color) !important;
  }
  .info-section {
    display: flex;
    align-items: center;
    gap: clamp(6pt, 1cqw, 1.5ex);
    position: relative;
    flex-shrink: 0;
  }

  .play-button {
    min-width: clamp(32px, 4cqw, 36px);
  }
  .play-button:hover:not(:disabled) {
    background: var(--traj-play-btn-bg-hover, var(--btn-bg-hover, rgba(0, 0, 0, 0.2)));
  }
  .play-button.playing {
    background: var(--traj-pause-btn-bg, var(--btn-bg, rgba(0, 0, 0, 0.1)));
  }
  .play-button.playing:hover:not(:disabled) {
    background: var(--traj-pause-btn-bg-hover, var(--btn-bg-hover, rgba(0, 0, 0, 0.1)));
  }

  .empty-state {
    padding: 2rem;
    border-radius: var(--border-radius);
    background: var(--dropzone-bg);
  }
  .empty-state :where(p, ul) {
    color: var(--text-color-muted);
  }
  .empty-state :where(h3, p, ul, li, strong) {
    max-width: var(--trajectory-empty-state-max-width, 500px);
    margin-inline: auto;
  }
  .source-buttons {
    display: flex; gap: 8px; justify-content: center; margin: 12px 0;
  }
  .traj-browse-btn {
    display: inline-block; padding: 6px 16px;
    background: var(--accent-color, #007acc); color: white;
    border-radius: 4px; cursor: pointer; font-size: 0.9em;
    border: none; font-family: inherit;
  }
  .traj-browse-btn:hover { filter: brightness(1.15); }
  .traj-remote-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--text-color, #fff);
  }
  .traj-remote-btn:hover { background: rgba(255, 255, 255, 0.15); }
  .supported-formats {
    margin-top: 1.5rem;
    text-align: left;
  }
  .supported-formats ul {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }
  .supported-formats li {
    color: var(--text-color-muted);
  }
  button:hover:not(:disabled) {
    background: var(--border-color);
  }
  button:disabled {
    background: var(--btn-disabled-bg);
    color: var(--text-color-muted);
    cursor: not-allowed;
  }
  .trajectory-controls input[type='number']::-webkit-outer-spin-button,
  .trajectory-controls input[type='number']::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  /* Responsive design */
  @media (orientation: portrait) {
    .trajectory .content-area.show-both:not(.hide-plot):not(.hide-structure) {
      grid-template-columns: 1fr !important;
      grid-template-rows: 1fr 1fr !important;
    }
  }
  .view-mode-dropdown-wrapper {
    display: flex;
    position: relative;
  }
  .view-mode-dropdown {
    position: absolute;
    top: 115%;
    right: 0;
    background: var(--surface-bg);
    border-radius: 4px;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
  }
  .view-mode-option {
    display: flex;
    align-items: center;
    gap: 1ex;
    width: 100%;
    padding: var(--trajectory-view-mode-option-padding, 5pt);
    box-sizing: border-box;
    background: transparent;
    border-radius: 0;
    text-align: left;
    transition: background-color 0.15s ease;
  }
  .view-mode-option:first-child {
    border-top-left-radius: 3px;
    border-top-right-radius: 3px;
  }
  .view-mode-option.selected {
    color: var(--accent-color);
  }
  .view-mode-option span {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
</style>
