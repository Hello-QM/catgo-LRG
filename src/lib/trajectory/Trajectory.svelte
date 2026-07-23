<script lang="ts">
  import {
    type ElementSymbol,
    type Vec3,
    Icon,
    Spinner,
    Structure,
    toggle_fullscreen,
  } from '$lib'
  import type { AtomManipulationEvent } from '$lib/structure'
  import type { AnyStructure, PymatgenStructure } from '$lib/structure'
  import type { TrajectoryFrameSource } from '$lib/structure/trajectory-frame-preparer'
  import { writeRemoteFile } from '$lib/api/hpc'
  import { structure_to_poscar_str } from '$lib/structure/export'
  import { handle_url_drop, load_from_url } from '$lib/io'
  import FileSourceDialog from '$lib/electronic/FileSourceDialog.svelte'
  import { format_num, trajectory_property_config } from '$lib/labels'
  import { calc_lattice_params, type Matrix3x3 } from '$lib/math'
  import type { ControlsConfig, DataSeries, Orientation, Point } from '$lib/plot'
  import { Histogram, ScatterPlot } from '$lib/plot'
  import { DEFAULTS, should_reduce_motion } from '$lib/settings'
  import { scaleLinear } from 'd3-scale'
  import type { ComponentProps, Snippet } from 'svelte'
  import { untrack } from 'svelte'
  import { tooltip } from 'svelte-multiselect/attachments'
  import type { HTMLAttributes } from 'svelte/elements'
  import { full_data_extractor } from './extract'
  import {
    create_frame_request_loader,
    select_displayed_frame_owner,
    select_displayed_frame_remote_origin,
    select_displayed_frame_idx,
    select_in_memory_frame,
    select_pending_frame_publication,
    type DisplayedFrameOwner,
    type FrameRequestOutcome,
  } from './frame-loading'
  import { create_frame_position_cache, FRAME_POS_CACHE_MAX } from './frame-positions'
  import type {
    ParseProgress,
    FramePositionData,
    TrajectoryDataExtractor,
    TrajectoryFrame,
    TrajectoryType,
    TrajHandlerData,
  } from './index'
  import { TrajectoryError, TrajectoryExportPane, TrajectoryInfoPane } from './index'
  import type { LoadingOptions } from './parse'
  import {
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
    mark_raw_trajectory,
    read_file_content,
    stable_frame_lattice,
  } from './trajectory-utils'
  import {
    clamp_fps,
    get_keyboard_action,
  } from './trajectory-controls'
  import {
    acknowledge_playback_frame,
    may_advance_playback,
    may_start_prepared_playback,
    request_playback_frame,
  } from './prepared-playback-state'
  import { sites_to_float32, write_sites_to_cache_slice } from './edit-apply'
  import { build_atom_graph } from '$lib/structure/atom-graph'
  import {
    register_viewer,
    refresh_viewer_manifest,
    set_active_viewer,
    type ViewerPosition,
  } from '$lib/structure/viewer-registry.svelte'
  import {
    apply_trajectory_edit_op_to_frame,
    type TrajectoryEditOp,
    validate_uniform_topology,
  } from './operations'
  import type { PaneTrajectory } from './clone'
  import { clone_structure } from '$lib/structure/clone'
  import { create_effective_frame_resolver } from './effective-frame-resolver'
  import {
    type LedgerEntry,
    OperationLedger,
    type OpScope,
    scope_matches_frame,
  } from './operation-ledger'
  import {
    commit_supercell_transaction,
    create_trajectory_supercell_request_handler,
    type SupercellTransactionCommitHooks,
    toggle_supercell_history_entry,
  } from './supercell-transactions'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')
  // Viewer manifests are bridge metadata, not render data. Publishing every
  // playback frame adds avoidable fetch/JSON/console work to the hot path.
  // Ten-frame buckets keep remote consumers within 0.5s at 20 FPS, while
  // pausing changes the bucket to the exact current frame immediately.
  const MANIFEST_PLAYBACK_FRAME_BUCKET = 10

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
    reduced_motion = false,
    display_mode = $bindable(`structure`),
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
    // When true (or when the OS prefers-reduced-motion matches), don't
    // auto-start playback. Manual play (▶) still works.
    reduced_motion?: boolean
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
  let presented_step_idx = $state(0)
  let presented_positions_version = $state(0)
  let playback_generation = $state(0)
  let prepared_ready_ahead = $state(0)
  let waiting_for_prepared_warmup = $state(false)
  let presentation_pending = $derived(current_step_idx !== presented_step_idx)

  // Ensure fps is within the allowed range
  $effect(() => {
    fps = clamp_fps(fps, fps_range)
  })
  let current_filename = $state<string | undefined>(undefined)
  let current_file_path = $state<string | null>(null)
  let file_size = $state<number | undefined>(undefined)
  let file_object = $state<File | null>(null)
  let wrapper = $state<HTMLDivElement | undefined>(undefined)
  // __CATGO_VSCODE_EXTENSION__ is a vite `define` token (unset in the main app
  // build → `typeof` is `undefined` → flag false); its type lives in src/app.d.ts.
  // VS Code's sandboxed webview blocks requestFullscreen(), so the Full Screen
  // button + `f` shortcut are dead there — gate them off (matches Structure.svelte C2).
  const is_vscode_extension = typeof __CATGO_VSCODE_EXTENSION__ !== `undefined` &&
    __CATGO_VSCODE_EXTENSION__
  const fullscreen_toggle_gated = $derived(is_vscode_extension ? false : fullscreen_toggle)
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
  let displayed_frame_owner = $state.raw<DisplayedFrameOwner | null>(null)

  // A retained frame from an earlier trajectory must never inherit the active
  // trajectory's remote destination after a replacement load fails.
  let remote_origin = $derived(
    select_displayed_frame_remote_origin(trajectory, displayed_frame_owner),
  )
  async function push_back_current_frame() {
    // Plan v3 Phase 4 fix: serialize current_frame.structure rather than
    // current_structure. Under Architecture P, current_structure freezes
    // at the first frame's topology; the actual frame to push back is
    // current_frame.structure (which holds the per-frame positions).
    const frame_structure = trajectory?.frames?.[presented_step_idx]?.structure
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
      console.log(`Push-back: writing frame ${presented_step_idx} to ${full_path} (session: ${remote_origin.session_id})`)
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
  // Streamed 20k-atom frames are immutable API responses and are always
  // replaced as a whole. Deep $state would proxy every site/xyz read when
  // flattening positions, adding hundreds of milliseconds and large transient
  // heap churn per frame. Raw state still reacts to the assignments below
  // without recursively wrapping the frame tree.
  let current_frame = $state.raw<TrajectoryFrame | null>(null)
  let displayed_frame_idx = $state<number | null>(null)
  const frame_requests = create_frame_request_loader()

  // A completion from an earlier trajectory must never replace the current
  // trajectory's frame, even when no newer frame request has started yet.
  $effect(() => {
    const active_trajectory = trajectory
    frame_requests.invalidate()
    if (!active_trajectory) {
      current_frame = null
      displayed_frame_idx = null
      displayed_frame_owner = null
    }
  })

  // Current frame structure for display — controlled $state instead of $derived
  // so we can freeze it during fast-path playback (moved up to avoid use-before-declaration)
  let current_structure = $state<AnyStructure | undefined>(undefined)

  // Remote push-back derived values (depend on current_frame)
  let current_frame_source = $derived(
    trajectory?.frames?.[presented_step_idx]?.metadata?.source_file as
      | string
      | undefined,
  )
  let can_push_back = $derived(
    // Plan v3 Phase 4 fix: read current_frame.structure rather than
    // current_structure. Under Architecture P, current_structure is frozen
    // at first-frame topology; current_frame.structure tracks the actual
    // displayed frame. Without this, can_push_back stays true after
    // navigating to any frame even when the user can't actually push the
    // current frame's positions.
    !!remote_origin && !!current_frame_source &&
      !!trajectory?.frames?.[presented_step_idx]?.structure,
  )

  // Auto-play when trajectory changes (handles both props and file loading).
  // Reduced motion (explicit setting or OS prefers-reduced-motion) suppresses
  // the auto-start; the user can still press ▶ manually.
  $effect(() => {
    const reduce = should_reduce_motion(
      reduced_motion,
      typeof matchMedia !== `undefined` &&
        matchMedia(`(prefers-reduced-motion: reduce)`).matches,
    )
    if (
      !reduce && auto_play && trajectory && !untrack(() => is_playing) &&
      total_frames > 1
    ) {
      start_playback()
    }
  })

  // Update current frame when step changes
  $effect(() => {
    if (trajectory && current_step_idx >= 0 && current_step_idx < total_frames) {
      if (trajectory.frame_loader) {
        // Load frame on demand (works for both indexed files and external streaming)
        load_frame_on_demand(current_step_idx)
      } else {
        // In-memory frames: apply any pending ops before showing. The mutation
        // inside `materialize_frame` replaces `trajectory.frames[idx]` with a
        // fresh object, so we re-read after to pick up the new reference.
        materialize_frame(current_step_idx)
        apply_frame_request_outcome(
          select_in_memory_frame(
            trajectory.frames[current_step_idx],
            untrack(() => current_frame),
            current_step_idx,
          ),
          current_step_idx,
          trajectory,
        )
      }
    } else if (trajectory) {
      apply_frame_request_outcome(
        frame_requests.reject_out_of_bounds(
          current_step_idx,
          total_frames,
          untrack(() => current_frame),
        ),
        current_step_idx,
        trajectory,
      )
    } else {
      frame_requests.invalidate()
      current_frame = null
      displayed_frame_idx = null
      displayed_frame_owner = null
    }
  })

  // Load frame on demand - works for both indexed files and external streaming
  async function load_frame_on_demand(frame_idx: number) {
    const requested_trajectory = trajectory
    if (!requested_trajectory?.frame_loader) return
    const result = await frame_requests.load(
      requested_trajectory,
      frame_idx,
      untrack(() => current_frame),
      untrack(() => orig_data),
    )
    if (!frame_requests.is_current(result, trajectory)) return
    apply_frame_request_outcome(result, frame_idx, requested_trajectory)
  }

  function apply_frame_request_outcome(
    result: FrameRequestOutcome,
    frame_idx: number,
    requested_trajectory: TrajectoryType,
  ) {
    if (result.status === `stale`) return
    displayed_frame_idx = select_displayed_frame_idx(
      result,
      frame_idx,
      untrack(() => displayed_frame_idx),
    )
    displayed_frame_owner = select_displayed_frame_owner(
      result,
      requested_trajectory,
      frame_idx,
      untrack(() => displayed_frame_owner),
    )
    if (result.status === `loaded`) {
      current_frame = result.frame
      return
    }

    current_frame = result.frame
    if (is_playing) pause_playback()
    on_error?.({
      error_msg: result.error.message,
      filename: current_filename,
      file_size,
      step_idx: frame_idx,
      frame_count: total_frames,
    })
  }

  // --- Trajectory fast-path: position-only GPU updates during playback/scrubbing ---
  // Pre-cache flat position arrays so we can skip the full reactive pipeline
  // (atom_data re-derive → AtomImpostors full buffer rebuild) during playback.
  let position_cache: Float32Array[] | null = null
  // Force cache: flat Float32Array of [fx,fy,fz] per atom per frame (null if no forces)
  let force_cache: Float32Array[] | null = null
  // Indexed/streaming trajectories get no position_cache; this memoizes a
  // transient positions array per frame index instead (stable Float32Array
  // reference = bond frame-connectivity cache key stays valid on revisit).
  const frame_pos_cache = create_frame_position_cache()

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
      // A replacement trajectory must not inherit the previous file's visual
      // supercell label (Gate A follow-up). First adoption (prev null) keeps
      // any parent-preset label.
      if (prev_frames_ref !== null && supercell_scaling !== `1x1x1`) {
        supercell_scaling = `1x1x1`
      }
      prev_frames_ref = frames_ref
    }
  })

  $effect(() => {
    if (!trajectory?.frames?.length) { position_cache = null; return }
    // Only cache for in-memory trajectories with constant atom count
    if (trajectory.frame_loader) { position_cache = null; return }
    // Never rebuild fixed-width caches while any in-memory frame still has
    // unapplied ledger entries; those entries may change positions or topology.
    if (trajectory.frames.some((_, idx) => frame_has_unmaterialized_ops(trajectory!, idx))) {
      position_cache = null
      force_cache = null
      return
    }

    const frames = trajectory.frames
    const has_frame_topology_edit = trajectory.operation_ledger?.entries.some(
      (entry) => entry.active && entry.scope.kind === `frame` &&
        [`add`, `delete`, `replace`, `supercell`].includes(entry.op.kind),
    )
    if (has_frame_topology_edit) {
      position_cache = null
      force_cache = null
      return
    }
    const first_count = frames[0].structure.sites.length
    // A topology ledger can make one arbitrary frame differ, so verify every
    // count in that case. The historical sample check remains for untouched
    // trajectories where this avoids walking a very long frames array.
    const has_topology_ledger = trajectory.operation_ledger?.entries.some(
      (entry) => entry.active &&
        [`add`, `delete`, `supercell`].includes(entry.op.kind),
    )
    const count_check_indices = has_topology_ledger
      ? frames.map((_, idx) => idx)
      : [
        0,
        Math.floor(frames.length / 4),
        Math.floor(frames.length / 2),
        Math.floor(frames.length * 3 / 4),
        frames.length - 1,
      ]
    const constant = count_check_indices.every(
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
  // Variable-cell fast path: displayed frame's lattice matrix (rows = a,b,c).
  // $state.raw + the plain shadow below keep this identity-stable for fixed
  // cells — the shadow is compared/updated without reading the signal, so the
  // publishing effect never subscribes to its own output.
  let trajectory_frame_lattice = $state.raw<number[][] | null>(null)
  let last_frame_lattice: number[][] | null = null

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
    // New trajectory identity (load, swap, or flush_pending_ops spread):
    // memoized per-frame position arrays are stale — drop them.
    frame_pos_cache.clear()
  })

  $effect(() => {
    const frame = current_frame
    if (!frame?.structure) {
      current_structure = undefined
      trajectory_frame_positions = null
      trajectory_frame_forces = null
      last_frame_lattice = null
      trajectory_frame_lattice = null
      topology_initialized = false
      return
    }
    const active_displayed_frame_idx =
      displayed_frame_owner?.trajectory === trajectory
        ? displayed_frame_idx
        : null
    if (active_displayed_frame_idx === null) {
      const publication = select_pending_frame_publication(
        active_displayed_frame_idx,
        untrack(() => trajectory_frame_positions),
        untrack(() => trajectory_frame_forces),
      )
      if (publication) {
        trajectory_frame_positions = publication.positions
        trajectory_frame_forces = publication.forces
      }
      return
    }
    // Variable-cell trajectories (NPT / cell relaxation): publish the frame's
    // lattice so bond detection, cross-cell rendering (CPU + GPU uLattice) and
    // the cell wireframe track the displayed cell. Identity-stable when the
    // nine numbers don't change, so fixed-cell playback costs 9 compares/frame
    // and fires no downstream effects.
    const frame_lat = stable_frame_lattice(
      last_frame_lattice,
      frame.position_data?.lattice ??
        (frame.structure as { lattice?: { matrix?: number[][] } }).lattice?.matrix,
    )
    if (frame_lat !== last_frame_lattice) {
      last_frame_lattice = frame_lat
      trajectory_frame_lattice = frame_lat
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
    const compact = frame.position_data
    if (compact && !force_slow_path) {
      // Remote constant-topology frames arrive as flat coordinates. Keep the
      // first frame's structure as topology and publish the packet directly;
      // this avoids allocating a 20k-object site graph on every timer tick.
      if (!topology_initialized) {
        current_structure = (trajectory as PaneTrajectory | undefined)?.frame_loader
          ? clone_structure(frame.structure)
          : frame.structure
        topology_initialized = true
      }
      trajectory_frame_positions = compact.positions
      trajectory_frame_forces = compact.forces
      return
    }
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
      trajectory_frame_positions = position_cache[active_displayed_frame_idx] ?? null
      trajectory_frame_forces = force_cache?.[active_displayed_frame_idx] ?? null
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
      // Constant-topology frames still get Architecture-P-style playback:
      // materialize a memoized per-frame positions array and keep
      // current_structure static, so the scene's trajectory bond fast-path
      // (frame-connectivity cache + latest-wins async + stale-render) keeps
      // bonds visible every frame. Before this, each frame re-wrote
      // current_structure and re-entered the static bond pipeline, whose
      // generation counter dropped almost every in-flight worker result
      // during playback — bonds flashed only on the few frames where the
      // worker beat the next frame advance (>1000-atom indexed files).
      // Topology changes (variable atom count), force_slow_path sources
      // (element-swap frames), and pending edit ops keep the true
      // per-frame structure-write path.
      const frame_sites = frame.structure.sites
      const supercell_ledger_active = trajectory?.operation_ledger?.entries.some(
        (entry) => entry.active && entry.op.kind === `supercell`,
      )
      const frame_scoped_structure_ops = trajectory
        ? has_frame_scoped_structure_ops(trajectory)
        : false
      if (
        supercell_ledger_active && topology_initialized && current_structure &&
        current_structure.sites.length !== frame_sites.length
      ) {
        // An all-scope transform preserves each frame's own N. If the source
        // trajectory is variable-N, continuous interpolation is invalid: stop
        // at the first differing frame and keep discrete scrub available.
        if (is_playing) pause_playback()
        resume_disabled = true
      }
      if (
        !force_slow_path && !frame_scoped_structure_ops && topology_initialized &&
        current_structure?.sites.length === frame_sites.length &&
        (!trajectory || !frame_has_unmaterialized_ops(trajectory, active_displayed_frame_idx))
      ) {
        const entry = frame_pos_cache.get(active_displayed_frame_idx, frame_sites)
        trajectory_frame_positions = entry.positions
        trajectory_frame_forces = entry.forces
      } else {
        // Forked streamed loaders serve immutable base frames (see clone.ts),
        // so the loader-cached frame object must
        // not become `current_structure` directly — the T5 pause writeback
        // mutates current_structure.sites in place and would corrupt the
        // cached frame for later revisits. Clone once per topology init
        // (NOT per frame; the fast path above never re-enters here).
        current_structure = (trajectory as PaneTrajectory | undefined)?.frame_loader
          ? clone_structure(frame.structure)
          : frame.structure
        topology_initialized = !force_slow_path && !frame_scoped_structure_ops &&
          (!trajectory || !frame_has_unmaterialized_ops(trajectory, active_displayed_frame_idx))
        trajectory_frame_positions = null
        trajectory_frame_forces = null
      }
    }
  })

  // ═══ Round-3 warmup: pre-convert frame positions during idle time ═══
  // First visit of a frame pays chunk fetch/parse (loader paths) plus the
  // 20k-site proxy walk that fills frame_pos_cache (~380 ms/frame at 20k
  // atoms) — the first playback pass crawled at ~6 fps while later passes
  // hit 20 fps. Warm the caches in requestIdleCallback slices so the first
  // pass is as fast as a revisit. Generation-guarded: any new load or
  // unload invalidates in-flight warmup; active playback naturally starves
  // idle callbacks, so this never competes for frame budget.
  let warmup_gen = 0
  $effect(() => {
    const traj = trajectory
    void traj_load_seq
    if (!traj || !topology_initialized) return
    // Only the typed-positions playback path consumes frame_pos_cache.
    if (untrack(() => trajectory_frame_positions) == null) return
    const loader = (traj as PaneTrajectory).frame_loader
    // Remote compact packets are already Float32Array-backed. Warming those
    // through effective_frames would defeat the packet path by materializing
    // every frame's full 20k-site object graph in the background.
    if (loader?.load_frame_positions) return
    const total = Math.min(
      traj.total_frames ?? traj.frames.length,
      FRAME_POS_CACHE_MAX,
    )
    if (total <= 1) return
    const gen = ++warmup_gen
    let idx = 0
    const step = async (deadline?: IdleDeadline) => {
      while (idx < total && gen === warmup_gen) {
        if (deadline && deadline.timeRemaining() < 8) break
        const i = idx++
        try {
          let frame: TrajectoryFrame | undefined
          if (loader) {
            const source = traj.frame_source_data ?? untrack(() => orig_data) ?? ``
            frame = (await traj.effective_frames?.resolve(
              i,
              (frame_idx) => loader.load_frame(source, frame_idx),
            )) ?? undefined
          } else {
            frame = untrack(() => traj.frames[i])
          }
          const sites = frame?.structure?.sites
          if (gen !== warmup_gen) return
          if (sites?.length) frame_pos_cache.get(i, sites)
        } catch {
          // Unfetchable frame — playback's own path will surface errors.
        }
        if (!deadline) break // setTimeout fallback: one frame per tick
      }
      if (idx < total && gen === warmup_gen) schedule()
    }
    const schedule = () => {
      if (typeof requestIdleCallback === `function`) {
        requestIdleCallback((d) => void step(d), { timeout: 1000 })
      } else {
        setTimeout(() => void step(), 50)
      }
    }
    schedule()
    return () => {
      warmup_gen++
    }
  })

  // Track hidden elements (persists across frame changes)
  let hidden_elements = $state(new Set<ElementSymbol>())

  let step_label_positions = $derived(
    compute_step_label_positions(step_labels, total_frames, scaleLinear as any),
  )

  // Streamed loads defer the whole-file plot-metadata scan so first render
  // isn't blocked on it (see load_remote_trajectory) — adopt the result when
  // it lands. Top-level reassignment (NOT a deep `traj.plot_metadata =`
  // write): the trajectory container is exempt from the deep $state proxy
  // (mark_raw_trajectory), so a nested write would never wake plot_series.
  // `frames` keeps its identity through the spread, so the position caches
  // survive (B3 effect) — the cost is one topology re-init cascade, once
  // per streamed load.
  $effect(() => {
    const traj = trajectory
    // A hidden plot must not kick off an ASE whole-file scan that starves the
    // position packet endpoint during playback.
    if (display_mode === `structure`) return
    const pending = traj?.plot_metadata_promise ?? traj?.plot_metadata_loader?.()
    if (!traj || !pending || traj.plot_metadata) return
    let cancelled = false
    void pending.then((md) => {
      if (cancelled || !md?.length) return
      if (trajectory === traj) {
        trajectory = mark_raw_trajectory({ ...traj, plot_metadata: md })
      }
    })
    return () => {
      cancelled = true
    }
  })

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
  // Plain decimal (not SI-prefix `~s`): scientific quantities read as "0.8" /
  // "-213.5", not "800m" / "-210". `~` trims trailing zeros.
  let y_axis = $derived({
    label: y_axis_labels.y1,
    format: `.3~f`,
    label_shift: { y: 20 },
  })
  let y2_axis = $derived({
    label: y_axis_labels.y2,
    format: `.3~f`,
    label_shift: { y: 80 },
  })

  // Helper function to get current frame data for callbacks
  function get_current_frame_data() {
    return {
      frame: current_frame || undefined,
      frame_count: total_frames,
    }
  }

  function get_presented_frame_data() {
    return {
      frame: trajectory?.frames?.[presented_step_idx],
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
      request_step(current_step_idx + 1)
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
      request_step(current_step_idx - 1)
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
      request_step(idx)
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
    const positions = get_trajectory_frame_source(presented_step_idx)?.positions ??
      null
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
    // Variable-cell: the paused frame's lattice must land in current_structure
    // too — exports, the info pane and post-pause edits read structure.lattice.
    // Take the frame's FULL lattice object (params a/b/c/angles included, from
    // parse time) rather than patching only the matrix. Fixed-cell trajectories
    // short-circuit on the identity-stable trajectory_frame_lattice being in
    // sync with the current matrix already.
    const cur_lattice = (cur as { lattice?: { matrix?: number[][] } }).lattice
    const presented_frame = trajectory?.frames?.[presented_step_idx]
    const materialized_frame_lattice =
      (presented_frame?.structure as { lattice?: { matrix?: number[][] } } | undefined)
        ?.lattice
    const compact_lattice = presented_frame?.position_data?.lattice
    const frame_lattice_obj = compact_lattice
      ? {
          ...(materialized_frame_lattice ?? cur_lattice),
          matrix: compact_lattice,
          ...calc_lattice_params(compact_lattice as Matrix3x3),
        }
      : materialized_frame_lattice
    const lattice_changed = cur_lattice && frame_lattice_obj &&
      stable_frame_lattice(cur_lattice.matrix ?? null, frame_lattice_obj.matrix) !==
        (cur_lattice.matrix ?? null)
    // Bail if every site was passthrough and the cell is unchanged
    if (!lattice_changed && new_sites.every((s, i) => s === sites[i])) return
    current_structure = lattice_changed
      ? { ...cur, sites: new_sites, lattice: frame_lattice_obj } as typeof cur
      : { ...cur, sites: new_sites }
  }

  // Play/pause functionality
  function toggle_play() {
    if (is_playing) pause_playback()
    else start_playback()
  }
  function start_playback() {
    if (total_frames <= 1) return
    const show_bonds = trajectory_scene_props?.show_bonds
    waiting_for_prepared_warmup = show_bonds !== `never`
    is_playing = true
    if (trajectory) {
      on_play?.({ trajectory, step_idx: presented_step_idx, frame_count: total_frames })
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
        step_idx: presented_step_idx,
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
        if (waiting_for_prepared_warmup) {
          if (!may_start_prepared_playback(prepared_ready_ahead, total_frames)) {
            return
          }
          waiting_for_prepared_warmup = false
        }
        if (!may_advance_playback({
          requested_idx: current_step_idx,
          presented_idx: presented_step_idx,
          generation: playback_generation,
        })) return
        if (current_step_idx >= total_frames - 1) {
          const { frame } = get_presented_frame_data()
          if (trajectory) {
            on_end?.({
              trajectory,
              step_idx: presented_step_idx,
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
        trajectory = mark_raw_trajectory(
          await parse_trajectory_async(data, filename, (progress) => {
            parsing_progress = progress
          }),
        )
      }

      // New trajectory loaded — synchronously reset pane-local ledger cursors.
      // The owner-change effect also resets, but later synchronous reads must
      // not inherit cursor state from the previous trajectory.
      if (trajectory) ensure_operation_ledger(trajectory)
      ledger_cursor_ledger = trajectory?.operation_ledger ?? null
      frame_ledger_cursor = new Array(trajectory?.frames?.length ?? 0).fill(0)
      if (trajectory) trajectory.materialized_ledger_cursors = frame_ledger_cursor
      position_cache = null
      force_cache = null
      traj_load_seq += 1

      current_step_idx = 0
      presented_step_idx = 0
      presented_positions_version = trajectory_positions_version.v
      playback_generation++
      prepared_ready_ahead = 0
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
      const parsed = await parse_trajectory_async(data, filename, (progress) => {
        parsing_progress = progress
      }, { use_indexing: true, ...loading_options })
      // Compatibility fallback for older external trajectory objects that
      // provide a loader without the typed frame_source_data contract.
      orig_data = data
      trajectory = mark_raw_trajectory(parsed)

      // New trajectory — synchronously reset pane-local ledger cursors.
      if (trajectory) ensure_operation_ledger(trajectory)
      ledger_cursor_ledger = trajectory?.operation_ledger ?? null
      frame_ledger_cursor = new Array(trajectory?.frames?.length ?? 0).fill(0)
      if (trajectory) trajectory.materialized_ledger_cursors = frame_ledger_cursor
      position_cache = null
      force_cache = null
      traj_load_seq += 1
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
      has_fullscreen_toggle: !!fullscreen_toggle_gated,
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

  // Cross-frame editing: one ordered ledger covers physical-site edits,
  // geometry transforms, and true supercells. In-memory frames keep a cursor
  // into that ledger; streamed frames resolve from their immutable loader base
  // through effective_frames.
  type EditMode = 'view' | 'edit-current' | 'edit-all'
  let edit_mode = $state<EditMode>('edit-current')
  let cross_frame_busy = $state(false)
  let frame_ledger_cursor = $state.raw<number[]>([])
  let ledger_cursor_ledger: OperationLedger | null = null

  // Bumped whenever trajectory positions/topology change. `all` selects whole
  // trajectory versus captured-frame bond-cache invalidation.
  let trajectory_positions_version = $state<{ v: number; all: boolean }>({ v: 0, all: false })
  let trajectory_topology_version = $state(0)

  function ensure_operation_ledger(owner: TrajectoryType): OperationLedger {
    owner.operation_ledger ??= new OperationLedger()
    owner.effective_frames ??= create_effective_frame_resolver(
      owner.operation_ledger,
    )
    return owner.operation_ledger
  }

  function materialized_cursors(owner: TrajectoryType): number[] {
    const n = owner.frames.length
    let cursors = owner.materialized_ledger_cursors
    if (!cursors || cursors.length !== n) {
      cursors = new Array(n).fill(0)
      owner.materialized_ledger_cursors = cursors
    }
    if (trajectory === owner && frame_ledger_cursor !== cursors) {
      frame_ledger_cursor = cursors
    }
    return cursors
  }

  $effect(() => {
    const owner = trajectory
    const ledger = owner ? ensure_operation_ledger(owner) : null
    const n = owner?.frames?.length ?? 0
    if (ledger !== ledger_cursor_ledger || frame_ledger_cursor.length !== n) {
      ledger_cursor_ledger = ledger
      frame_ledger_cursor = owner ? materialized_cursors(owner) : []
    }
  })

  function frame_has_unmaterialized_ops(owner: TrajectoryType, idx: number): boolean {
    if (owner.frame_loader) return false
    const ledger = owner.operation_ledger
    if (!ledger) return false
    const cursor = materialized_cursors(owner)[idx] ?? 0
    for (let i = cursor; i < ledger.entries.length; i++) {
      const entry = ledger.entries[i]
      if (entry.active && scope_matches_frame(entry.scope, idx)) return true
    }
    return false
  }

  function get_trajectory_frame_source(
    frame_idx: number,
  ): TrajectoryFrameSource | null {
    const frame = trajectory?.frames?.[frame_idx]
    const sites = frame?.structure?.sites
    const cached_frame = sites?.length
      ? frame_pos_cache.get(frame_idx, sites)
      : null
    const positions = position_cache?.[frame_idx] ??
      frame?.position_data?.positions ??
      cached_frame?.positions ??
      null
    if (!positions) return null
    const first_frame = trajectory?.frames?.[0]
    const base_lattice = first_frame?.position_data?.lattice ??
      (first_frame?.structure as
        | { lattice?: { matrix?: number[][] } }
        | undefined)?.lattice?.matrix ??
      null
    const lattice = frame?.position_data?.lattice ??
      (frame?.structure as
        | { lattice?: { matrix?: number[][] } }
        | undefined)?.lattice?.matrix ??
      base_lattice
    const metadata = trajectory?.metadata as
      | { source_format?: string; type?: string }
      | undefined
    const trajectory_source = metadata?.source_format ?? metadata?.type
    return {
      frame_idx,
      positions,
      forces: force_cache?.[frame_idx] ??
        frame?.position_data?.forces ??
        cached_frame?.forces ??
        null,
      lattice: lattice ?? null,
      positions_version: trajectory_positions_version.v,
      topology_stable: !frame?.position_data?.topology_changed &&
        trajectory_source !== `doping_substitution` &&
        trajectory_source !== `reaction_pathway`,
    }
  }

  async function request_trajectory_frame_source(
    frame_idx: number,
  ): Promise<TrajectoryFrameSource | null> {
    const cached = get_trajectory_frame_source(frame_idx)
    if (cached) return cached
    const owner = trajectory
    const loader = (owner as PaneTrajectory | undefined)?.frame_loader
    if (!owner || !loader || frame_has_unmaterialized_ops(owner, frame_idx)) {
      return null
    }
    const source_data = owner.frame_source_data ?? untrack(() => orig_data) ?? ``
    const first_frame = owner.frames?.[0]
    const base_lattice = first_frame?.position_data?.lattice ??
      (first_frame?.structure as
        | { lattice?: { matrix?: number[][] } }
        | undefined)?.lattice?.matrix ??
      null
    if (loader.load_frame_positions) {
      const data: FramePositionData | null =
        await loader.load_frame_positions(source_data, frame_idx)
      if (trajectory !== owner || !data?.positions) return null
      return {
        frame_idx,
        positions: data.positions,
        forces: data.forces ?? null,
        lattice: data.lattice ?? base_lattice,
        positions_version: trajectory_positions_version.v,
        topology_stable: !data.topology_changed,
      }
    }
    const frame = await owner.effective_frames?.resolve(
      frame_idx,
      (idx) => loader.load_frame(source_data, idx),
    )
    if (trajectory !== owner || !frame?.structure?.sites?.length) return null
    const cached_frame = frame_pos_cache.get(frame_idx, frame.structure.sites)
    return {
      frame_idx,
      positions: cached_frame.positions,
      forces: frame.position_data?.forces ?? cached_frame.forces ?? null,
      lattice: frame.position_data?.lattice ??
        (frame.structure as
          | { lattice?: { matrix?: number[][] } }
          | undefined)?.lattice?.matrix ??
        base_lattice,
      positions_version: trajectory_positions_version.v,
      topology_stable: false,
    }
  }

  function handle_trajectory_frame_presented(
    frame_idx: number,
    positions_version: number,
  ): void {
    if (
      frame_idx !== current_step_idx ||
      positions_version !== trajectory_positions_version.v
    ) return
    const next = acknowledge_playback_frame({
      requested_idx: current_step_idx,
      presented_idx: presented_step_idx,
      generation: playback_generation,
    }, frame_idx)
    presented_step_idx = next.presented_idx
    presented_positions_version = positions_version
  }

  function handle_trajectory_buffer_state(state: {
    frame_idx: number
    ready_ahead: number
    preparing: boolean
    error: string | null
  }): void {
    if (state.frame_idx !== current_step_idx) return
    prepared_ready_ahead = state.ready_ahead
    if (state.error) {
      error_msg = state.error
      pause_playback()
    }
  }

  function request_step(frame_idx: number): void {
    const next = request_playback_frame({
      requested_idx: current_step_idx,
      presented_idx: presented_step_idx,
      generation: playback_generation,
    }, frame_idx)
    current_step_idx = next.requested_idx
    playback_generation = next.generation
  }

  $effect(() => {
    const positions = trajectory_frame_positions
    const show_bonds = trajectory_scene_props?.show_bonds
    if (positions && show_bonds === `never`) {
      handle_trajectory_frame_presented(
        current_step_idx,
        trajectory_positions_version.v,
      )
    }
  })

  function has_frame_scoped_structure_ops(owner: TrajectoryType): boolean {
    return owner.operation_ledger?.entries.some(
      (entry) => entry.active && entry.scope.kind === `frame` &&
        [`add`, `delete`, `replace`, `supercell`].includes(entry.op.kind),
    ) ?? false
  }

  /** Apply active ledger entries not yet materialized into an in-memory frame. */
  function materialize_frame(idx: number): AnyStructure | undefined {
    const owner = trajectory
    if (!owner) return undefined
    const frames = owner.frames
    if (idx < 0 || idx >= frames.length) return undefined
    let frame = frames[idx]
    if (!frame) return undefined
    const ledger = ensure_operation_ledger(owner)
    const cursors = materialized_cursors(owner)
    const cursor = cursors[idx] ?? 0
    if (cursor >= ledger.entries.length) return frame.structure
    for (let i = cursor; i < ledger.entries.length; i++) {
      const entry = ledger.entries[i]
      if (entry.active && scope_matches_frame(entry.scope, idx)) {
        frame = apply_trajectory_edit_op_to_frame(frame, entry.op)
      }
    }
    frames[idx] = frame
    cursors[idx] = ledger.entries.length
    return frame.structure
  }

  /** Materialize the pane ledger into every in-memory frame before a bulk
   * consumer reads `trajectory.frames` directly. Streamed consumers already
   * resolve through effective_frames and remain lazy. */
  function flush_pending_ops(): void {
    const owner = trajectory
    if (!owner || owner.frame_loader) return
    const ledger = ensure_operation_ledger(owner)
    if (!ledger.entries.length) return
    for (let i = 0; i < owner.frames.length; i++) materialize_frame(i)
    trajectory = mark_raw_trajectory({ ...owner })
  }

  function append_edit_op(
    owner: TrajectoryType,
    scope: { kind: `all` } | { kind: `frame`; frame_idx: number },
    op: TrajectoryEditOp,
    materialized_frame_idx?: number,
  ): void {
    const ledger = ensure_operation_ledger(owner)
    ledger.append(scope, op)
    if (materialized_frame_idx !== undefined) {
      materialized_cursors(owner)[materialized_frame_idx] = ledger.entries.length
    }
    if (scope.kind === `all`) owner.effective_frames?.clear()
    else owner.effective_frames?.invalidate(scope.frame_idx)
    frame_pos_cache.clear()
    warmup_gen += 1
  }

  // ── External history (Build T5) ──
  // Structure's undo/redo routes `{kind:'external'}` entries back here by
  // token. A record is captured at commit time: indexed owners need only the
  // ledger entry id (undo/redo toggles its active flag and the effective-frame
  // resolver re-resolves), in-memory owners also keep the pre-op immutable
  // frame REFERENCES plus materialization cursors so undo restores them
  // without cloning and redo replays the toggled ledger over the same base.
  type ExternalHistoryRecord = {
    owner: TrajectoryType
    entry_id: string
    scope: OpScope
    frames_before?: TrajectoryFrame[]
    cursors_before?: number[]
  }
  const external_history = new Map<string, ExternalHistoryRecord>()
  // Structure trims its undo stack at 50; keep a little headroom, evict oldest.
  const EXTERNAL_HISTORY_LIMIT = 64

  function record_external_history(token: string, record: ExternalHistoryRecord) {
    external_history.set(token, record)
    if (external_history.size > EXTERNAL_HISTORY_LIMIT) {
      const oldest = external_history.keys().next().value
      if (oldest !== undefined) external_history.delete(oldest)
    }
  }

  /** The one hooks builder both the supercell commit and external undo/redo
   * toggles share — cache invalidation, republish, and version-bump behavior
   * must stay identical between the two paths. */
  function trajectory_supercell_txn_hooks(
    owner: TrajectoryType,
    ledger: OperationLedger,
    opts: {
      disable_resume?: boolean
      on_history?: (entry: LedgerEntry) => void
    } = {},
  ): SupercellTransactionCommitHooks {
    return {
      ledger,
      replace_frame: (frame_idx, frame) => {
        if (owner.frame_loader) return
        owner.frames[frame_idx] = frame
        materialized_cursors(owner)[frame_idx] = ledger.entries.length
      },
      publish_captured_frame: (frame_idx, frame) => {
        if (
          trajectory === owner &&
          displayed_frame_owner?.trajectory === owner &&
          displayed_frame_idx === frame_idx
        ) {
          current_frame = frame
          current_structure = frame.structure
        }
      },
      clear_position_cache: () => { position_cache = null },
      clear_force_cache: () => { force_cache = null },
      invalidate_effective_frames: (scope) => {
        if (scope.kind === `all`) owner.effective_frames?.clear()
        else owner.effective_frames?.invalidate(scope.frame_idx)
      },
      clear_typed_frame_buffers: () => {
        frame_pos_cache.clear()
        trajectory_frame_positions = null
        trajectory_frame_forces = null
        last_frame_lattice = null
        trajectory_frame_lattice = null
      },
      reset_topology: () => {
        topology_initialized = false
        supercell_scaling = `1x1x1`
        if (opts.disable_resume) resume_disabled = true
      },
      // Structure's bond cache consumes the version bump below; keeping the
      // invalidation hook explicit documents that this transaction covers it.
      invalidate_bond_caches: () => {},
      invalidate_warmup: () => { warmup_gen += 1 },
      bump_position_version: (scope) => {
        trajectory_positions_version = {
          v: trajectory_positions_version.v + 1,
          all: scope.kind === `all`,
        }
      },
      bump_topology_version: () => {
        trajectory_topology_version += 1
        if (trajectory === owner) {
          trajectory = mark_raw_trajectory({ ...owner })
        }
      },
      history_token: (entry) => {
        opts.on_history?.(entry)
        return `trajectory-supercell-${entry.id}`
      },
    }
  }

  /** Undo (`active=false`) / redo (`active=true`) one external history token.
   * Returns false when the token is unknown or its owner is no longer the
   * pane's live trajectory (a replacement load orphans old tokens). */
  function handle_external_history_toggle(
    history_token: string,
    active: boolean,
  ): boolean {
    const record = external_history.get(history_token)
    if (!record) return false
    const { owner, entry_id, scope } = record
    if (trajectory !== owner) return false
    const ledger = ensure_operation_ledger(owner)
    const restore = record.frames_before
      ? () => {
        const frames_before = record.frames_before!
        const cursors_before = record.cursors_before ?? []
        // Index-assign so the frames ARRAY identity is preserved — the B3
        // frames-identity effect must not read this restoration as a new
        // trajectory (that would wrongly reset the supercell label).
        for (let idx = 0; idx < frames_before.length; idx++) {
          owner.frames[idx] = frames_before[idx]
        }
        const cursors = materialized_cursors(owner)
        for (let idx = 0; idx < cursors.length; idx++) {
          cursors[idx] = cursors_before[idx] ?? 0
        }
        const idx = current_step_idx
        if (idx < 0 || idx >= owner.frames.length) return undefined
        // Re-materialize the displayed frame against the toggled active set
        // so the republished frame reflects the undone/redone ledger state.
        materialize_frame(idx)
        const frame = owner.frames[idx]
        return frame ? { frame_idx: idx, frame } : undefined
      }
      : undefined
    return toggle_supercell_history_entry(
      { entry_id, active, scope, restore },
      trajectory_supercell_txn_hooks(owner, ledger),
    )
  }

  const request_trajectory_supercell = create_trajectory_supercell_request_handler({
    capture: () => {
      const owner = trajectory
      const frame_idx = displayed_frame_idx
      const owner_token = displayed_frame_owner
      const frame = current_frame
      if (
        !owner || frame_idx === null || !frame ||
        owner_token?.trajectory !== owner || owner_token.frame_idx !== frame_idx
      ) return null
      return {
        owner,
        frame_idx,
        frame,
        mode: edit_mode,
        ledger: ensure_operation_ledger(owner),
      }
    },
    get_active_owner: () => trajectory,
    get_mode: () => edit_mode,
    is_captured_frame_current: (token) =>
      !!token.owner.frame_loader || token.owner.frames[token.frame_idx] === token.frame,
    snapshot: (structure) => $state.snapshot(structure),
    prepare_current_topology_edit: () => {
      if (is_playing) pause_playback()
    },
    commit: (publication) => {
      const { owner, ledger, mode } = publication.token
      // Capture pre-op immutable frame references + cursors BEFORE the commit
      // mutates them; undo restores these exact references (in-memory only —
      // indexed owners resolve through the ledger, nothing to capture).
      const in_memory = !owner.frame_loader
      const frames_before = in_memory ? [...owner.frames] : undefined
      const cursors_before = in_memory ? [...materialized_cursors(owner)] : undefined
      return commit_supercell_transaction(
        publication,
        trajectory_supercell_txn_hooks(owner, ledger, {
          disable_resume: mode === `edit-current`,
          on_history: (entry) =>
            record_external_history(`trajectory-supercell-${entry.id}`, {
              owner,
              entry_id: entry.id,
              scope: entry.scope,
              frames_before,
              cursors_before,
            }),
        }),
      )
    },
  })
  let supercell_busy_request = 0
  async function handle_trajectory_supercell_request(
    op: Parameters<typeof request_trajectory_supercell>[0],
  ) {
    if (presentation_pending) {
      throw new Error(`Wait for the requested trajectory frame to be presented.`)
    }
    const request = ++supercell_busy_request
    cross_frame_busy = true
    try {
      return await request_trajectory_supercell(op)
    } finally {
      if (request === supercell_busy_request) cross_frame_busy = false
    }
  }

  function current_edit_frame(owner: TrajectoryType, idx: number): TrajectoryFrame | null {
    if (!owner.frame_loader) {
      materialize_frame(idx)
      return owner.frames[idx] ?? null
    }
    if (
      displayed_frame_owner?.trajectory === owner &&
      displayed_frame_idx === idx
    ) return current_frame
    return null
  }

  function commit_physical_edit(op: TrajectoryEditOp, topology_change: boolean): void {
    const owner = trajectory
    if (!owner || edit_mode === `view` || presentation_pending) return
    const idx = presented_step_idx
    const source = current_edit_frame(owner, idx)
    if (!source?.structure) return

    // apply_trajectory_edit_op_to_frame clears supercell provenance BEFORE an
    // individual physical-site mutation, then returns the complete new frame.
    const edited = apply_trajectory_edit_op_to_frame(source, op)
    const scope = edit_mode === `edit-all`
      ? { kind: `all` as const }
      : { kind: `frame` as const, frame_idx: idx }
    if (!owner.frame_loader) owner.frames[idx] = edited
    append_edit_op(owner, scope, op, owner.frame_loader ? undefined : idx)

    if (
      displayed_frame_owner?.trajectory === owner &&
      displayed_frame_idx === idx
    ) {
      current_frame = edited
      current_structure = edited.structure
    }

    if (topology_change || edit_mode === `edit-all`) {
      position_cache = null
      force_cache = null
      frame_pos_cache.clear()
    } else {
      const slice = position_cache?.[idx]
      if (slice) write_sites_to_cache_slice(slice, edited.structure.sites)
    }
    if (topology_change) {
      topology_initialized = false
      trajectory_topology_version += 1
    }
    trajectory_positions_version = {
      v: trajectory_positions_version.v + 1,
      all: scope.kind === `all`,
    }
    trajectory = mark_raw_trajectory({ ...owner })
  }

  function handle_atoms_manipulated(event: AtomManipulationEvent) {
    if (event.displacements.size === 0) return
    commit_physical_edit({
      kind: `manipulate`,
      displacements: new Map(event.displacements),
    }, false)
  }

  function _apply_topology_op(op: TrajectoryEditOp) {
    if (!is_playing) resume_disabled = true
    commit_physical_edit(op, true)
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

  // Memoized on structure identity: the manifest refresh effect re-runs per
  // frame (it reads current_frame), and this used to walk all sites through
  // the $state proxy twice per refresh. During fixed-topology playback
  // current_structure is frozen → O(1) per frame; slow-path trajectories
  // (doping element swaps) replace current_structure per frame and correctly
  // recompute.
  const manifest_formula_cache = new WeakMap<object, string>()
  function manifest_formula(): string {
    const structure = trajectory?.frames?.[presented_step_idx]?.structure ??
      current_structure
    if (!structure) return ``
    const cached = manifest_formula_cache.get(structure as object)
    if (cached !== undefined) return cached
    const counts = new Map<string, number>()
    for (const site of structure.sites ?? []) {
      const el = site.species?.[0]?.element ?? site.label ?? `?`
      counts.set(el, (counts.get(el) ?? 0) + 1)
    }
    const formula = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([el, n]) => n === 1 ? el : `${el}${n}`)
      .join(``)
    manifest_formula_cache.set(structure as object, formula)
    return formula
  }

  function inspect_trajectory_atoms() {
    const structure = trajectory?.frames?.[presented_step_idx]?.structure
    return build_atom_graph(structure)
  }

  function require_editable_memory_trajectory(): TrajectoryType {
    if (!trajectory) throw new Error(`No trajectory loaded.`)
    if (trajectory.frame_loader) {
      throw new Error(`All-frame edits on streamed trajectories are not available until every frame is materialized.`)
    }
    const topology_error = validate_uniform_topology(trajectory)
    if (topology_error) throw new Error(topology_error)
    flush_pending_ops()
    return trajectory
  }

  function scale_all_frames(factor: number): TrajectoryType {
    const owner = trajectory
    if (!owner) throw new Error(`No trajectory loaded.`)
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`Scale factor must be positive.`)
    }
    const current = owner.frame_loader
      ? current_edit_frame(owner, current_step_idx)
      : null
    const op: TrajectoryEditOp = { kind: `scale_geometry`, factor }
    append_edit_op(owner, { kind: `all` }, op)
    if (owner.frame_loader) {
      if (current) {
        const edited = apply_trajectory_edit_op_to_frame(current, op)
        current_frame = edited
        current_structure = edited.structure
      }
    } else flush_pending_ops()
    return owner
  }

  function refresh_after_external_edit(): void {
    position_cache = null
    force_cache = null
    topology_initialized = false
    current_frame = trajectory?.frames?.[current_step_idx] ?? null
    trajectory_positions_version = { v: trajectory_positions_version.v + 1, all: true }
    trajectory = trajectory ? mark_raw_trajectory({ ...trajectory }) : trajectory
  }

  function handle_trajectory_command(action: string, args: Record<string, unknown>) {
    if (action === `inspect`) {
      return {
        atoms: inspect_trajectory_atoms(),
        current_frame: presented_step_idx,
        total_frames,
      }
    }
    if (presentation_pending) {
      throw new Error(`Wait for the requested trajectory frame to be presented.`)
    }
    if (action === `add_atom`) {
      const target = require_editable_memory_trajectory()
      const element = String(args.element ?? ``) as ElementSymbol
      const position = Array.isArray(args.position) ? args.position.map(Number) : []
      if (!element || position.length !== 3 || !position.every(Number.isFinite)) {
        throw new Error(`element and a 3D Cartesian position are required.`)
      }
      append_edit_op(target, { kind: `all` }, {
        kind: `add`,
        element,
        position: [position[0], position[1], position[2]],
      })
      flush_pending_ops()
      refresh_after_external_edit()
      return { scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
    }
    if (action === `delete_atoms`) {
      const target = require_editable_memory_trajectory()
      const atom_count = target.frames[0]?.structure.sites.length ?? 0
      const indices = [...new Set((Array.isArray(args.indices) ? args.indices : []).map(Number))]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < atom_count)
      if (!indices.length) throw new Error(`At least one valid atom index is required.`)
      append_edit_op(target, { kind: `all` }, {
        kind: `delete`,
        site_indices: indices,
      })
      flush_pending_ops()
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
      append_edit_op(target, { kind: `all` }, {
        kind: `manipulate`,
        displacements: moves,
      })
      flush_pending_ops()
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
      append_edit_op(target, { kind: `all` }, {
        kind: `replace`,
        site_indices: indices,
        new_element: element,
      })
      flush_pending_ops()
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
        current_frame: presented_step_idx,
        total_frames,
        atom_count: trajectory?.frames?.[presented_step_idx]?.structure?.sites
          ?.length ?? 0,
        streaming: !!trajectory?.frame_loader,
        editable: !!trajectory && !trajectory.frame_loader,
      }),
      get_structure: () => trajectory?.frames?.[presented_step_idx]?.structure,
      set_structure: (next) => {
        if (presentation_pending || !trajectory?.frames?.[presented_step_idx]) return
        trajectory.frames[presented_step_idx] = {
          ...trajectory.frames[presented_step_idx],
          structure: next,
        }
        refresh_after_external_edit()
      },
      set_scene_prop: (key, value) => {
        if (trajectory_scene_props) (trajectory_scene_props as Record<string, unknown>)[key] = value
      },
      set_selection: (indices) => { selected_sites = indices },
      select_by_element: (element) => {
        const structure = trajectory?.frames?.[presented_step_idx]?.structure
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
        append_edit_op(target, { kind: `all` }, {
          kind: `add`,
          element: element as ElementSymbol,
          position,
        })
        flush_pending_ops()
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      delete_atoms: (indices) => {
        const target = require_editable_memory_trajectory()
        append_edit_op(target, { kind: `all` }, { kind: `delete`, site_indices: indices })
        flush_pending_ops()
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      replace_atoms: (indices, element) => {
        const target = require_editable_memory_trajectory()
        append_edit_op(target, { kind: `all` }, {
          kind: `replace`,
          site_indices: indices,
          new_element: element as ElementSymbol,
        })
        flush_pending_ops()
        refresh_after_external_edit()
        return { viewer_id, scope: `all_frames`, atom_count: target.frames[0]?.structure.sites.length ?? 0, total_frames }
      },
      move_atoms: (displacements) => {
        const target = require_editable_memory_trajectory()
        append_edit_op(target, { kind: `all` }, {
          kind: `manipulate`,
          displacements,
        })
        flush_pending_ops()
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

  const manifest_frame_bucket = $derived(
    is_playing
      ? Math.floor(presented_step_idx / MANIFEST_PLAYBACK_FRAME_BUCKET)
      : presented_step_idx,
  )
  $effect(() => {
    if (!viewer_id) return
    trajectory
    manifest_frame_bucket
    pane_position
    is_active
    filename
    // get_manifest reads the exact current frame. Keep that read outside this
    // effect's dependency collection or it defeats the playback bucket above.
    untrack(() => refresh_viewer_manifest(viewer_id))
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
      <div class="traj-supercell-warning" data-testid="traj-supercell-warning" role="status">
        Supercell + trajectory: replicas render the current base frame and
        share its atom and bond topology.
      </div>
    {/if}
    {#if show_controls}
      <div class="trajectory-controls">
        {#if trajectory_controls}
      {@render trajectory_controls({
        trajectory,
        current_step_idx: presented_step_idx,
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
              value={presented_step_idx}
              onchange={(event) =>
                go_to_step(Number((event.currentTarget as HTMLInputElement).value))}
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
                value={current_step_idx}
                oninput={(event) =>
                  go_to_step(Number((event.currentTarget as HTMLInputElement).value))}
                aria-busy={presentation_pending}
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
                    : `Push frame ${presented_step_idx} back to ${remote_origin?.dir_path}/${current_frame_source}`}
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
              disabled={cross_frame_busy || presentation_pending}
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
                current_step_idx={presented_step_idx}
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
            {#if fullscreen_toggle_gated}
              <button
                type="button"
                onclick={() => fullscreen_toggle_gated && toggle_fullscreen(wrapper)}
                title="{fullscreen ? `Exit` : `Enter`} fullscreen"
                aria-label="{fullscreen ? `Exit` : `Enter`} fullscreen"
                aria-pressed={fullscreen}
                class="fullscreen-button"
              >
                {#if typeof fullscreen_toggle_gated === `function`}
                  {@render fullscreen_toggle_gated()}
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
          bridge_structure={trajectory?.frames?.[presented_step_idx]?.structure}
          handle_viewer_command={handle_trajectory_command}
          {trajectory_frame_positions}
          {trajectory_frame_forces}
          {trajectory_frame_lattice}
          trajectory_step_idx={current_step_idx}
          trajectory_positions_version={trajectory_positions_version}
          trajectory_frame_count={total_frames}
          {get_trajectory_frame_source}
          {request_trajectory_frame_source}
          on_trajectory_frame_presented={handle_trajectory_frame_presented}
          on_trajectory_buffer_state={handle_trajectory_buffer_state}
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
          on_supercell_request={handle_trajectory_supercell_request}
          on_external_history_toggle={handle_external_history_toggle}
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
            current_x_value={presented_step_idx}
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
