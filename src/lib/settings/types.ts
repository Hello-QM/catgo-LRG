// CatGo settings type definitions
// All type/interface definitions and const option arrays for the settings schema

import type { D3SymbolName } from '$lib/labels'
import type { Vec3 } from '$lib/math'
import type { Orientation } from '$lib/plot'
import type { BondingStrategy } from '$lib/structure/bonding'

// SettingType interface with optional context to control where settings apply
// context: 'web' = web browser only, 'editor' = VSCode extension only, 'notebook' = Jupyter/marimo only, 'all' or undefined = all contexts
export interface SettingType<T = unknown> {
  value: T
  description: string
  enum?: Readonly<Record<Extract<T, string>, string>>
  minimum?: number
  maximum?: number
  /** Suggested UI slider/number-input step (advisory; not enforced). */
  step?: number
  minItems?: number
  maxItems?: number
  context?: `web` | `editor` | `notebook` | `all`
}

export const show_bonds_options = [`never`, `always`, `crystals`, `molecules`] as const
export type ShowBonds = (typeof show_bonds_options)[number]

export type CameraProjection = `perspective` | `orthographic`

export const render_style_options = [
  `glossy`,
  `metallic`,
  `matcap`,
  `matte`,
  `soft`,
  `flat`,
  `toon`,
] as const
export type RenderStyle = (typeof render_style_options)[number]

/** The 5 per-render-style lighting parameters (one profile per render_style). */
export interface LightingProfile {
  light_azimuth: number
  light_elevation: number
  directional_light: number
  ambient_light: number
  highlight_strength: number
}

export const ATOM_COLOR_MODE_OPTIONS = [
  `element`,
  `coordination`,
  `wyckoff`,
  `charge`,
  `mof_sbu`,
  `custom`,
] as const
export type AtomColorMode = (typeof ATOM_COLOR_MODE_OPTIONS)[number]

export const polyhedra_opacity_modes = [`uniform`, `depth_gradient`] as const
export type PolyhedraOpacityMode = (typeof polyhedra_opacity_modes)[number]

export const polyhedra_color_modes = [`vertex`, `center`, `uniform`] as const
export type PolyhedraColorMode = (typeof polyhedra_color_modes)[number]

// Reusable type definitions for common setting patterns
type DisplayConfigType = {
  x_grid: SettingType<boolean>
  y_grid: SettingType<boolean>
  y2_grid: SettingType<boolean>
  x_zero_line: SettingType<boolean>
  y_zero_line: SettingType<boolean>
}

type BarStyleType = {
  color: SettingType<string>
  opacity: SettingType<number>
  stroke_width: SettingType<number>
  stroke_color: SettingType<string>
  stroke_opacity: SettingType<number>
}

type PointStyleType = {
  size: SettingType<number>
  color: SettingType<string>
  opacity: SettingType<number>
  stroke_width: SettingType<number>
  stroke_color: SettingType<string>
  stroke_opacity: SettingType<number>
}

type LineStyleType = {
  width: SettingType<number>
  color: SettingType<string>
  opacity: SettingType<number>
  dash: SettingType<string>
}

type SimpleBarStyleType = { color: SettingType<string>; opacity: SettingType<number> }

type SimpleLineStyleType = { width: SettingType<number>; color: SettingType<string> }

type PhaseDiagramCommonType = {
  camera_zoom: SettingType<number>
  camera_center_x: SettingType<number>
  camera_center_y: SettingType<number>
  color_mode: SettingType<`stability` | `energy`>
  color_scale: SettingType<string>
  show_stable: SettingType<boolean>
  show_unstable: SettingType<boolean>
  show_stable_labels: SettingType<boolean>
  show_unstable_labels: SettingType<boolean>
  max_hull_dist_show_phases: SettingType<number>
  max_hull_dist_show_labels: SettingType<number>
  fullscreen: SettingType<boolean>
  info_pane_open: SettingType<boolean>
  legend_pane_open: SettingType<boolean>
}

type PhaseDiagramWith3DType = PhaseDiagramCommonType & {
  show_hull_faces: SettingType<boolean>
  hull_face_color: SettingType<string>
  hull_face_opacity: SettingType<number>
}

export interface SettingsConfig {
  // General display settings
  color_scheme: SettingType<string>
  background_color: SettingType<string>
  background_opacity: SettingType<number>

  symmetry: {
    symprec: SettingType<number>
    algo: SettingType<`Moyo` | `Spglib`>
  }

  structure: { // Structure viewer settings
    // Atoms & Bonds
    atom_radius: SettingType<number>
    same_size_atoms: SettingType<boolean>
    show_atoms: SettingType<boolean>
    show_image_atoms: SettingType<boolean>
    sphere_segments: SettingType<number>
    bond_thickness: SettingType<number>
    show_bonds: SettingType<ShowBonds>
    bond_color: SettingType<string>
    /** When true, periodic (cross-cell) bonds render as a single stub on
     *  atom A's side of the cell boundary, instead of paired stubs on both
     *  sides. Matches VESTA's "Mode 1" cell-edge bond style. */
    incomplete_periodic_edge_mode: SettingType<boolean>
    /** Length multiplier applied to the visible stub when
     *  incomplete_periodic_edge_mode is on. Range [0.05, 1.0]; default 0.5. */
    incomplete_edge_length_scale: SettingType<number>
    /** When true, suppress cross-cell bond stubs whose partner image atom is
     *  not drawn (matches Materials Project / VESTA defaults). Eliminates the
     *  visual artifact of bonds appearing to dangle into vacuum. */
    hide_incomplete_bonds: SettingType<boolean>
    bonding_strategy: SettingType<BondingStrategy>
    bonding_options: SettingType<Record<string, number>>
    /** When true, perceive double/triple/aromatic bond orders on small
     *  organic ADSORBATE fragments and draw them as multi-cylinder bonds
     *  (the metal slab stays single sticks). Default false → byte-identical
     *  to the single-cylinder path. */
    bond_order_perception: SettingType<boolean>
    bond_scale: SettingType<number>
    show_hydrogen_bonds: SettingType<boolean>
    hbond_distance_cutoff: SettingType<number>
    hbond_angle_cutoff: SettingType<number>
    hbond_thickness: SettingType<number>
    atom_color_mode: SettingType<AtomColorMode>
    atom_color_scale: SettingType<string>
    atom_color_scale_type: SettingType<`continuous` | `categorical`>

    // Camera & Controls
    show_gizmo: SettingType<boolean>
    camera_position: SettingType<Vec3>
    camera_projection: SettingType<CameraProjection>
    initial_zoom: SettingType<number>
    fov: SettingType<number>
    rotation_damping: SettingType<number>
    rotate_speed: SettingType<number>
    zoom_speed: SettingType<number>
    pan_speed: SettingType<number>
    zoom_to_cursor: SettingType<boolean>
    max_zoom: SettingType<number | undefined>
    min_zoom: SettingType<number | undefined>
    auto_rotate: SettingType<number>
    // Manual rotation controls [x, y, z] in radians
    rotation: SettingType<Vec3>

    // Labels & Lighting
    show_site_labels: SettingType<boolean>
    show_site_indices: SettingType<boolean>
    site_label_size: SettingType<number>
    site_label_color: SettingType<string>
    site_label_bg_color: SettingType<string>
    site_label_padding: SettingType<number>
    site_label_offset: SettingType<Vec3>
    ambient_light: SettingType<number>
    directional_light: SettingType<number>
    depth_cueing: SettingType<number>
    depth_cue_start: SettingType<number>
    depth_cue_end: SettingType<number>
    atom_outline_strength: SettingType<number>
    bond_outline_strength: SettingType<number>
    /** Material/shading style for atoms (orthogonal to color_scheme palette).
     *  glossy = current default specular look (byte-identical to legacy);
     *  matte = flat diffuse; toon = 3-band cel/cartoon shading. */
    render_style: SettingType<RenderStyle>
    /** MatCap material preset (only used when render_style === 'matcap').
     *  Selects which procedural studio-sphere texture the atom shader samples. */
    matcap_preset: SettingType<string>
    /** Headlamp light direction, azimuth in degrees (view-space, around the
     *  view axis). Drives uLightDir in the atom/bond shaders. */
    light_azimuth: SettingType<number>
    /** Headlamp light direction, elevation in degrees above the horizon
     *  (view-space). Drives uLightDir in the atom/bond shaders. */
    light_elevation: SettingType<number>
    /** Specular highlight intensity — multiplies the glossy spec term in the
     *  atom/bond shaders (uSpecStrength). 1.0 = byte-identical legacy look. */
    highlight_strength: SettingType<number>
    /** Per-render-style lighting profiles — the source of truth for the 5
     *  lighting params fed to the shaders. Switching render_style swaps the
     *  active profile (sliders + render both reflect it); edits are remembered
     *  per style. Persisted inside scene_props. */
    lighting_profiles: SettingType<Record<RenderStyle, LightingProfile>>

    // Forces & Lattice
    show_force_vectors: SettingType<boolean>
    force_scale: SettingType<number>
    force_color: SettingType<string>
    force_shaft_radius: SettingType<number>
    force_arrow_head_radius: SettingType<number>
    force_arrow_head_length: SettingType<number>
    force_display_mode: SettingType<`all` | `max_only` | `range`>
    force_range_min: SettingType<number>
    force_range_max: SettingType<number>
    force_color_mode: SettingType<`element` | `custom`>
    show_magmom_vectors: SettingType<boolean>
    magmom_scale: SettingType<number>
    magmom_up_color: SettingType<string>
    magmom_down_color: SettingType<string>
    show_cell: SettingType<boolean>
    show_cell_vectors: SettingType<boolean>
    show_scale_bar: SettingType<boolean>
    cell_edge_opacity: SettingType<number>
    cell_surface_opacity: SettingType<number>
    cell_edge_color: SettingType<string>
    cell_surface_color: SettingType<string>
    cell_edge_width: SettingType<number>
    fullscreen_toggle: SettingType<boolean>

    // Atom manipulation
    keyboard_movement_step: SettingType<number>
    frozen_atom_indicator: SettingType<`ring` | `crosshatch` | `dimmed`>

    // Polyhedra visualization
    show_polyhedra: SettingType<boolean>
    polyhedra_center_elements: SettingType<string[]>
    polyhedra_min_coordination: SettingType<number>
    polyhedra_max_neighbors: SettingType<number>
    polyhedra_bond_scale: SettingType<number>
    polyhedra_metals_only: SettingType<boolean>
    polyhedra_color_mode: SettingType<PolyhedraColorMode>
    polyhedra_color: SettingType<string>
    polyhedra_show_edges: SettingType<boolean>
    polyhedra_opacity_mode: SettingType<PolyhedraOpacityMode>
    polyhedra_opacity: SettingType<number>
    polyhedra_opacity_near: SettingType<number>
    polyhedra_opacity_far: SettingType<number>
    polyhedra_edge_opacity: SettingType<number>
    polyhedra_edge_color: SettingType<string>
    polyhedra_edge_width: SettingType<number>
    polyhedra_color_overrides: SettingType<Record<string, string>>
    hide_polyhedra_center_atoms: SettingType<boolean>
    hide_polyhedra_internal_bonds: SettingType<boolean>

    // Sphere clipping
    clip_active: SettingType<boolean>
    clip_radius: SettingType<number>
    clip_outside_mode: SettingType<`hide` | `transparent`>
    clip_outside_opacity: SettingType<number>
  }

  trajectory: { // Trajectory viewer settings
    // Core trajectory settings
    auto_play: SettingType<boolean>
    fps: SettingType<number>
    fps_range: SettingType<[number, number]>
    display_mode: SettingType<
      | `structure+scatter`
      | `structure`
      | `scatter`
      | `histogram`
      | `structure+histogram`
    >
    show_controls: SettingType<boolean>
    fullscreen_toggle: SettingType<boolean>
    step_labels: SettingType<number>
    layout: SettingType<`auto` | Orientation>

    // File handling and loading
    allow_file_drop: SettingType<boolean>
    bin_file_threshold: SettingType<number>
    text_file_threshold: SettingType<number>
    use_indexing: SettingType<boolean>
    chunk_size: SettingType<number>

    // Formatting
    step_label_format: SettingType<string>
    property_value_format: SettingType<string>
    tooltip_format: SettingType<string>

    // UI/UX
    enable_keyboard_shortcuts: SettingType<boolean>
    show_parsing_progress: SettingType<boolean>
    compact_controls: SettingType<boolean>
    show_filename_in_controls: SettingType<boolean>

    // Playback behavior
    smooth_playback: SettingType<boolean>
    loop_playback: SettingType<boolean>
    pause_on_hover: SettingType<boolean>
    highlight_current_frame: SettingType<boolean>
    show_frame_info: SettingType<boolean>

    // Performance
    max_frames_in_memory: SettingType<number>
    memory_usage_warning_threshold: SettingType<number>
    enable_performance_monitoring: SettingType<boolean>
    prefetch_frames: SettingType<number>
    cache_parsed_data: SettingType<boolean>
  }

  plot: { // General plot settings
    animation_duration: SettingType<number>
    enable_zoom: SettingType<boolean>
    zoom_factor: SettingType<number>
    auto_fit_range: SettingType<boolean>
    grid_lines: SettingType<boolean>
    axis_labels: SettingType<boolean>
    show_x_zero_line: SettingType<boolean>
    show_y_zero_line: SettingType<boolean>
    show_x_grid: SettingType<boolean>
    show_y_grid: SettingType<boolean>
    show_y2_grid: SettingType<boolean>
    x_format: SettingType<string>
    y_format: SettingType<string>
    y2_format: SettingType<string>
    x_scale_type: SettingType<string>
    y_scale_type: SettingType<string>
    x_ticks: SettingType<number>
    y_ticks: SettingType<number>
  }

  scatter: { // Scatter plot settings
    show_legend: SettingType<boolean>
    show_points: SettingType<boolean>
    show_lines: SettingType<boolean>
    symbol_type: SettingType<D3SymbolName>
    display: DisplayConfigType
    point: PointStyleType
    line: LineStyleType
  }

  histogram: { // Histogram settings
    mode: SettingType<`overlay` | `single`>
    show_legend: SettingType<boolean>
    bin_count: SettingType<number>
    bar: BarStyleType
    display: DisplayConfigType
  }

  bar: { // Bar plot settings
    display: DisplayConfigType
    bar: SimpleBarStyleType
    line: SimpleLineStyleType
  }

  composition: { // Composition specific settings
    display_mode: SettingType<`pie` | `bubble` | `bar`>
    color_scheme: SettingType<string>
  }

  chat: {
    provider: SettingType<`anthropic` | `openai`>
    model: SettingType<string>
    temperature: SettingType<number>
    max_tokens: SettingType<number>
    show_chat: SettingType<boolean>
  }

  phase_diagram: { // Phase diagram defaults (binary/ternary/quaternary)
    binary: PhaseDiagramCommonType
    ternary: PhaseDiagramWith3DType & {
      camera_elevation: SettingType<number>
      camera_azimuth: SettingType<number>
    }
    quaternary: PhaseDiagramWith3DType & {
      camera_rotation_x: SettingType<number>
      camera_rotation_y: SettingType<number>
    }
  }

  gesture: { // Hand gesture & voice control settings
    enabled: SettingType<boolean>
    show_webcam_pip: SettingType<boolean>
    show_skeleton: SettingType<boolean>
    sensitivity: SettingType<number>
    voice_enabled: SettingType<boolean>
    voice_language: SettingType<string>
    voice_method: SettingType<string>
    whisper_api_key: SettingType<string>
    art_trail_spacing: SettingType<number>
    neon_color: SettingType<string>
    tts_enabled: SettingType<boolean>
    tts_volume: SettingType<number>
    tts_rate: SettingType<number>
    tts_voice: SettingType<string>
    voice_ai_enabled: SettingType<boolean>
  }
}

// Extract the value types for runtime use (up to 3 nested levels)
export type DefaultSettings = {
  [K in keyof SettingsConfig]: SettingsConfig[K] extends SettingType<infer T> ? T
    : SettingsConfig[K] extends Record<string, unknown> ? {
        [NK in keyof SettingsConfig[K]]: SettingsConfig[K][NK] extends
          SettingType<infer T> ? T
          : SettingsConfig[K][NK] extends Record<string, unknown> ? {
              [NNK in keyof SettingsConfig[K][NK]]: SettingsConfig[K][NK][NNK] extends
                SettingType<infer T> ? T
                : never
            }
          : never
      }
    : never
}

// Narrowed accessor for phase diagram defaults to ensure strong typing at call sites
export type PhaseDiagramDefaults = DefaultSettings[`phase_diagram`]
