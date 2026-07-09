// CatGo settings configuration - complete settings with values, descriptions, and constraints

import { symbol_names } from '$lib/labels'
import type { D3SymbolName } from '$lib/labels'
import type { LightingProfile, RenderStyle, SettingsConfig, ShowBonds } from './types'

/**
 * Per-render-style default lighting profiles. Each of glossy/matte/toon owns
 * its own profile of the 5 lighting params. Switching render_style swaps the
 * active values (sliders + shaders both reflect the new style's profile); user
 * edits are remembered per style and persisted inside scene_props.
 *
 * All three share az35/el45 (the agreed upper-right headlamp direction). Matte
 * and toon kill specular (highlight_strength 0). dir/amb are inert for toon
 * (self-lit 3-band) but kept for slider consistency (option A — no hidden
 * sliders).
 */
export const LIGHTING_PROFILE_DEFAULTS: Readonly<Record<RenderStyle, LightingProfile>> = {
  glossy: {
    // Physically-based key: ambient fill + a near-head-on camera-relative key at
    // HDR intensity 2.2 (offset ≈ az0/el5), fed through the GGX shader + ACES.
    // Muted colours, a small centred specular hot spot.
    light_azimuth: 0,
    light_elevation: 5,
    directional_light: 2.2,
    ambient_light: 0.6,
    highlight_strength: 1.0,
  },
  // Metallic reuses the glossy (specular) shader branch but at higher roughness
  // + metalness, for a bigger, softer, element-tinted highlight (not a compact
  // hot spot). The shader reads roughness/metalness per style; these are lights.
  metallic: {
    // pretty-lattice "metallic": shader roughness 0.4 / metalness 0.4 gives a
    // bigger, softer, element-tinted highlight than glossy; pair it with a bright
    // near-head-on key (2.5) and a high ambient fill (1.0) so the metal-dimmed
    // diffuse stays legible.
    light_azimuth: 0,
    light_elevation: 5,
    directional_light: 2.5,
    ambient_light: 1.0,
    highlight_strength: 1.0,
  },
  // MatCap samples a baked studio-sphere texture instead of the scene lights, so
  // the light params are inert here — kept for slider consistency.
  matcap: {
    light_azimuth: 35,
    light_elevation: 45,
    directional_light: 0.3,
    ambient_light: 0.7,
    highlight_strength: 0.0,
  },
  matte: {
    light_azimuth: 35,
    light_elevation: 45,
    directional_light: 0.4,
    ambient_light: 0.85,
    highlight_strength: 0.0,
  },
  // 2.5D: softly shaded diagram between flat color and matte 3D (matte branch,
  // gentle key light, no specular).
  soft: {
    light_azimuth: 35,
    light_elevation: 55,
    directional_light: 0.35,
    ambient_light: 0.8,
    highlight_strength: 0.0,
  },
  // 2D flat: pure diffuse fill, no directional shading or specular — clean
  // schematic look for figures/legends.
  flat: {
    light_azimuth: 35,
    light_elevation: 45,
    directional_light: 0.0,
    ambient_light: 1.0,
    highlight_strength: 0.0,
  },
  toon: {
    light_azimuth: 25,
    light_elevation: 20,
    directional_light: 0.3,
    ambient_light: 0.7,
    highlight_strength: 0.0,
  },
}

const DISPLAY_CONFIG = {
  x_grid: {
    value: true,
    description: `Show X-axis grid lines`,
  },
  y_grid: {
    value: true,
    description: `Show Y-axis grid lines`,
  },
  y2_grid: {
    value: false,
    description: `Show Y2-axis grid lines`,
  },
  x_zero_line: {
    value: true,
    description: `Show X-axis zero reference line`,
  },
  y_zero_line: {
    value: true,
    description: `Show Y-axis zero reference line`,
  },
} as const

// Complete settings configuration with values, descriptions, and constraints
export const SETTINGS_CONFIG: SettingsConfig = {
  // General display settings
  color_scheme: {
    value: `Vesta Soft`,
    description: `Color scheme for atoms and bonds`,
    enum: {
      Vesta: `Vesta`,
      'Vesta Soft': `Vesta Soft`,
      Jmol: `Jmol`,
      'Jmol Soft': `Jmol Soft`,
      Alloy: `Alloy`,
      Pastel: `Pastel`,
      Muted: `Muted`,
      'Dark Mode': `Dark Mode`,
    },
  },
  background_color: {
    // Transparent by default (opacity 0 below) so the viewport follows the app
    // theme instead of being locked to one colour. An off-white like #f5f6f8 at
    // opacity 1 gives the light publication-figure look, but that is opt-in via
    // the Background controls — not forced.
    value: `#000000`,
    description: `Background color of the 3D viewport`,
  },
  background_opacity: {
    value: 0,
    description: `Opacity of the background (0.0 = transparent, 1.0 = opaque)`,
    minimum: 0,
    maximum: 1,
  },

  symmetry: {
    symprec: {
      value: 1e-4,
      description: `Symmetry precision tolerance for spacegroup detection`,
      minimum: 1e-8,
      maximum: 1,
    },
    algo: {
      value: `Moyo` as const,
      description: `Algorithm for symmetry analysis`,
      enum: { Moyo: `Moyo`, Spglib: `Spglib` },
    },
  },

  // Structure viewer settings
  structure: {
    // Atoms & Bonds
    atom_radius: {
      value: 1.5,
      description:
        `Radius multiplier for atoms (1.5 = default, 0.5 = VESTA ball-and-stick, 1.0 = standard atomic radii)`,
      minimum: 0.1,
      maximum: 3.0,
    },
    same_size_atoms: {
      value: false,
      description: `Render all atoms with the same size regardless of element`,
    },
    show_atoms: {
      value: true,
      description: `Display atoms in the structure`,
    },
    show_image_atoms: {
      value: true,
      description:
        `Show atoms on the edge of the cell that are not part of the primitive basis`,
    },
    sphere_segments: {
      value: 20,
      description: `Number of segments for sphere rendering (higher = smoother)`,
      minimum: 8,
      maximum: 64,
    },
    bond_thickness: {
      value: 0.07,
      description: `Thickness of bonds relative to atom radius`,
      minimum: 0.01,
      maximum: 1.0,
    },
    show_bonds: {
      value: `always`,
      description: `When to display bonds between atoms`,
      enum: Object.fromEntries(
        [`never`, `always`, `crystals`, `molecules`].map((
          key,
        ) => [key, key[0].toUpperCase() + key.slice(1)]),
      ) as Readonly<Record<ShowBonds, string>>,
    },
    bond_color: {
      value: `#666666`,
      description: `Color for bonds (hex color code)`,
    },
    incomplete_periodic_edge_mode: {
      value: true,
      description:
        `Render cross-cell bonds as a single stub on atom A's side instead of paired stubs (VESTA Mode 1)`,
    },
    incomplete_edge_length_scale: {
      value: 0.15,
      description:
        `Length of the visible stub for cross-cell bonds in incomplete-edge mode (fraction of half-bond length)`,
      minimum: 0.05,
      maximum: 1.0,
    },
    hide_incomplete_bonds: {
      value: false,
      description:
        `Suppress cross-cell bond stubs whose partner image atom is not drawn (matches Materials Project / VESTA defaults)`,
    },
    bonding_strategy: {
      value: `atom_radii`,
      description: `Method for determining bonds between atoms`,
      enum: {
        electroneg_ratio: `Electronegativity Ratio`,
        solid_angle: `Solid Angle`,
        atom_radii: `Atom Radii`,
      },
    },
    bonding_options: {
      value: {},
      description: `Additional parameters for the bonding strategy`,
    },
    bond_order_perception: {
      value: false,
      description:
        `Perceive double/triple/aromatic bond orders across the whole structure ` +
        `— adsorbates and carbon-based frameworks (graphene/C3N4/h-BN/COF) alike ` +
        `(metals stay single sticks)`,
    },
    bond_scale: {
      value: 1.15,
      description:
        `Atom Radii strategy: bond when distance ≤ scale × (sum of covalent radii). ` +
        `Lower = fewer, tighter bonds; higher = catches longer/stretched contacts.`,
      minimum: 1.0,
      maximum: 1.4,
    },
    show_hydrogen_bonds: {
      value: false,
      description: `Show hydrogen bonds as dashed lines`,
    },
    hbond_distance_cutoff: {
      value: 2.5,
      description: `Maximum H···A distance for hydrogen bond detection (Å)`,
      minimum: 1.5,
      maximum: 4.0,
    },
    hbond_angle_cutoff: {
      value: 120,
      description: `Minimum D-H···A angle for hydrogen bond detection (degrees)`,
      minimum: 90,
      maximum: 180,
    },
    hbond_thickness: {
      value: 0.04,
      description: `Thickness of hydrogen bond dashed lines`,
      minimum: 0.01,
      maximum: 0.5,
    },
    atom_color_mode: {
      value: `element`,
      description: `Property to use for atom coloring`,
      enum: {
        element: `Element`,
        coordination: `Coordination Number`,
        wyckoff: `Wyckoff Position`,
        charge: `Charge`,
        mof_sbu: `MOF SBU`,
        custom: `Custom`,
      },
    },
    atom_color_scale: {
      value: `interpolateViridis`,
      description:
        `D3 color scale for property-based coloring (e.g. interpolateViridis, interpolatePlasma)`,
    },
    atom_color_scale_type: {
      value: `continuous`,
      description: `Color scale type for property-based coloring`,
      enum: {
        continuous: `Continuous`,
        categorical: `Categorical`,
      },
    },

    // Camera & Controls
    show_gizmo: {
      value: true,
      description: `Show orientation gizmo in the corner of structure viewer`,
    },
    camera_position: {
      value: [0, 0, 0] as const,
      description: `Initial camera position [x, y, z]`,
      minItems: 3,
      maxItems: 3,
    },
    camera_projection: {
      value: `orthographic` as const,
      description: `Camera projection type`,
      enum: {
        perspective: `Perspective`,
        orthographic: `Orthographic`,
      },
    },
    initial_zoom: {
      value: 35,
      description:
        `Initial zoom level for orthographic projection (ignored for perspective)`,
      minimum: 0.1,
      maximum: 200,
    },
    fov: {
      value: 10,
      description: `Field of view in degrees for perspective projection`,
      minimum: 10,
      maximum: 150,
    },
    rotation_damping: {
      value: 0.3,
      description: `Camera rotation damping factor (0 = no damping, 1 = heavy damping)`,
      minimum: 0,
      maximum: 1,
    },
    rotate_speed: {
      value: 1.0,
      description: `Mouse rotation sensitivity (set to 0 to disable rotation)`,
      minimum: 0,
      maximum: 2.0,
    },
    zoom_speed: {
      value: 0.5,
      description: `Mouse wheel zoom sensitivity`,
      minimum: 0.1,
      maximum: 2.0,
    },
    pan_speed: {
      value: 4,
      description: `Mouse pan sensitivity`,
      minimum: 0.1,
      maximum: 10,
    },
    zoom_to_cursor: {
      value: false,
      description:
        `Zoom toward cursor position instead of scene center (double click canvas to reset camera)`,
    },
    max_zoom: {
      value: 500,
      description:
        `Maximum zoom level (orthographic: larger = more zoomed out, perspective: larger = further away)`,
    },
    min_zoom: {
      value: 10,
      description:
        `Minimum zoom level (orthographic: smaller = more zoomed in, perspective: smaller = closer)`,
    },
    auto_rotate: {
      value: 0,
      description: `Automatic rotation speed (0 = disabled, positive = clockwise)`,
      minimum: 0,
      maximum: 10,
    },
    rotation: {
      value: [0, 0, 0] as const,
      description:
        `Manual rotation around X, Y, Z axes, displayed in degrees [0, 360] but normalized as radians to [-π, π] for each of [x, y, z]. Combines additively with auto-rotation when both are active.`,
      minItems: 3,
      maxItems: 3,
    },

    // Labels & Lighting
    show_site_labels: {
      value: false,
      description: `Show element labels on atoms`,
    },
    show_site_indices: {
      value: false,
      description: `Show site index numbers on atoms`,
    },
    site_label_size: {
      value: 1,
      description: `Font size for atom labels`,
      minimum: 0.5,
      maximum: 5,
    },
    site_label_color: {
      value: `var(--struct-label-color, #1a1a1a)`,
      description: `Text color for atom labels`,
    },
    site_label_bg_color: {
      value: `var(--struct-label-bg, rgba(255, 255, 255, 0.85))`,
      description: `Background color for atom labels`,
    },
    site_label_padding: {
      value: 2,
      description: `Padding around atom labels in pixels`,
      minimum: 0,
      maximum: 20,
    },
    site_label_offset: {
      value: [0, 0.25, 0] as const,
      description: `3D offset for atom labels [x, y, z]`,
      minItems: 3,
      maxItems: 3,
    },
    ambient_light: {
      value: 0.15,
      description: `Ambient light intensity (0 = dark, higher = brighter)`,
      minimum: 0,
      maximum: 4,
    },
    directional_light: {
      value: 1.8,
      description:
        `Directional light intensity (0 = no shadows, higher = stronger shadows)`,
      minimum: 0,
      maximum: 4,
    },
    depth_cueing: {
      value: 0.4,
      description:
        `Depth cueing (3Dmol-style fog) intensity (0 = off, 1 = maximum). Fades distant atoms toward the background color. Near/far auto-tracked from camera distance.`,
      minimum: 0,
      maximum: 1,
    },
    depth_cue_start: {
      value: 0.4,
      description:
        `Where fog begins, as fraction of structure depth (0 = front face, 1 = back face). 3Dmol default is 0.4 — front 40% of atoms remain crisp, only the back fades.`,
      minimum: 0,
      maximum: 1,
    },
    depth_cue_end: {
      value: 1,
      description:
        `Ending depth for depth cueing as fraction of structure extent (0 = front face, 1 = back face). Atoms beyond this are fully faded.`,
      minimum: 0,
      maximum: 1,
    },
    atom_outline_strength: {
      value: 0,
      description:
        `Silhouette outline strength on atoms (0 = off, 1 = full). Darkens the rim of each atom for a 3Dmol/PyMOL cartoon look. Implemented as a fragment-shader effect — no postprocessing pass.`,
      minimum: 0,
      maximum: 1,
    },
    bond_outline_strength: {
      value: 0,
      description:
        `Silhouette outline strength on bonds (0 = off, 1 = full). Independent of atom outline; bonds are typically thinner so a separate dial is useful.`,
      minimum: 0,
      maximum: 1,
    },
    render_style: {
      value: `toon` as const,
      description:
        `Material/shading style for atoms. Glossy = default specular look; Metallic = harder compact highlight; Matte = flat diffuse (no highlight); 2.5D = softly shaded diagram; 2D Flat = pure diffuse fill; Toon = 3-band cel/cartoon shading. Orthogonal to color_scheme (palette).`,
      enum: {
        glossy: `Glossy`,
        metallic: `Metallic`,
        matcap: `MatCap`,
        matte: `Matte`,
        soft: `2.5D`,
        flat: `2D Flat`,
        toon: `Toon`,
      },
    },
    matcap_preset: {
      value: `ceramic`,
      description:
        `MatCap material preset (only applies when Material = MatCap). Ceramic = soft glazed; Clay = flat matte; Glossy = tighter shine; Pearl = luminous soft.`,
      enum: {
        ceramic: `Ceramic`,
        clay: `Clay`,
        glossy: `Glossy`,
        pearl: `Pearl`,
      },
    },
    light_azimuth: {
      value: 35,
      description:
        `Headlamp light direction — azimuth in degrees around the view axis (0° = behind/back, 90° = right, 180° = front, 270° = left). View-space: x=right, y=up, z=toward camera. Default 35° reproduces the legacy fixed headlamp.`,
      minimum: 0,
      maximum: 360,
      step: 5,
    },
    light_elevation: {
      value: 45,
      description:
        `Headlamp light direction — elevation in degrees above the horizon (−90° = lit from below, 0° = level, +90° = lit from straight above). Default 45° reproduces the legacy fixed headlamp.`,
      minimum: -90,
      maximum: 90,
      step: 5,
    },
    highlight_strength: {
      value: 1.0,
      description:
        `Specular highlight intensity — multiplies the bright white spec dot on atoms and bonds. 1.0 = default look; 0 = no highlight; 2 = doubled glossiness.`,
      minimum: 0,
      maximum: 2,
      step: 0.05,
    },
    lighting_profiles: {
      // Per-render-style lighting profiles — the SOURCE OF TRUTH for the 5
      // lighting params fed to the shaders. Switching render_style swaps which
      // profile is active (sliders + render both reflect it); edits are
      // remembered per style. Persisted as part of scene_props (catgo-viewer-
      // settings). The flat directional_light/ambient_light/light_azimuth/
      // light_elevation/highlight_strength settings above are kept only as a
      // legacy seed / fallback — the viewer lighting path reads this map.
      value: structuredClone(LIGHTING_PROFILE_DEFAULTS) as Record<RenderStyle, LightingProfile>,
      description:
        `Per-render-style lighting profiles (glossy/matte/toon each own light_azimuth, light_elevation, directional_light, ambient_light, highlight_strength).`,
    },

    // Forces & Lattice
    show_force_vectors: {
      value: false,
      description: `Display force vectors on atoms`,
    },
    force_scale: {
      value: 20,
      description: `Scale factor for force vector arrows (Å per eV/Å)`,
      minimum: 0.1,
      maximum: 50.0,
    },
    force_color: {
      value: `#ff0000`,
      description: `Color for force vectors`,
    },
    force_shaft_radius: {
      value: 0.06,
      description:
        `Radius of force vector shaft in Å (negative = relative to length, positive = absolute)`,
      minimum: -0.1,
      maximum: 0.5,
    },
    force_arrow_head_radius: {
      value: 0.15,
      description:
        `Radius of force vector arrow head in Å (negative = relative to length, positive = absolute)`,
      minimum: -0.2,
      maximum: 0.5,
    },
    force_arrow_head_length: {
      value: 0.25,
      description:
        `Length of force vector arrow head in Å (negative = relative to length, positive = absolute)`,
      minimum: -0.5,
      maximum: 1.0,
    },
    force_display_mode: {
      value: `all` as `all` | `max_only` | `range`,
      description: `Show all force vectors, max only, or filter by magnitude range`,
    },
    force_range_min: {
      value: 0,
      description: `Minimum force magnitude for range filter (eV/A)`,
      minimum: 0,
    },
    force_range_max: {
      value: 10,
      description: `Maximum force magnitude for range filter (eV/A)`,
      minimum: 0,
    },
    force_color_mode: {
      value: `custom` as `element` | `custom`,
      description:
        `Force color mode: element (match atom color) or custom (use force_color setting)`,
    },
    // Magnetic moments
    show_magmom_vectors: {
      value: false,
      description:
        `Display per-atom magnetic moment vectors as arrows (from site magmom — ` +
        `scalar collinear moments point along z, non-collinear use their 3-vector; ` +
        `red = spin up, blue = spin down)`,
    },
    magmom_scale: {
      value: 1.0,
      description: `Scale factor for magnetic moment arrows (Å per µB)`,
      minimum: 0.05,
      maximum: 10,
    },
    magmom_up_color: {
      value: `#e0524a`,
      description: `Colour for spin-up magnetic moment arrows`,
    },
    magmom_down_color: {
      value: `#4a6fe0`,
      description: `Colour for spin-down magnetic moment arrows`,
    },
    show_cell: {
      value: true,
      description: `Display system cell`,
    },
    show_cell_vectors: {
      value: true,
      description: `Display cell vectors`,
    },
    show_scale_bar: {
      value: false,
      description: `Display a scale bar with distance reference in Angstroms`,
    },
    cell_edge_opacity: {
      value: 0.3,
      description: `Opacity of cell edge lines`,
      minimum: 0,
      maximum: 1,
    },
    cell_surface_opacity: {
      value: 0.03,
      description: `Opacity of cell surfaces`,
      minimum: 0,
      maximum: 1,
    },
    cell_edge_color: {
      value: `#808080`,
      description: `Color of cell edges`,
    },
    cell_surface_color: {
      value: `#ffffff`,
      description: `Color of cell surfaces`,
    },
    cell_edge_width: {
      value: 1.5,
      description: `Width of cell edge lines`,
      minimum: 0.5,
      maximum: 5.0,
    },
    fullscreen_toggle: {
      value: true,
      description:
        `Show fullscreen toggle button (web-only, always false in other contexts)`,
      context: `web`,
    },

    // Atom manipulation
    keyboard_movement_step: {
      value: 0.1,
      description:
        `Base step size in Angstroms for keyboard arrow key movement (Shift: 10x, Ctrl: 0.1x)`,
      minimum: 0.01,
      maximum: 1.0,
    },
    frozen_atom_indicator: {
      value: `ring` as const,
      description: `Visual style for indicating frozen atoms`,
      enum: {
        ring: `Ring`,
        crosshatch: `Crosshatch`,
        dimmed: `Dimmed`,
      },
    },

    // Polyhedra visualization
    show_polyhedra: {
      value: false,
      description: `Display coordination polyhedra around metal centers`,
    },
    polyhedra_center_elements: {
      value: [] as string[],
      description:
        `Elements to draw polyhedra around (empty = auto-detect metals in structure)`,
    },
    polyhedra_min_coordination: {
      value: 3,
      description: `Minimum coordination number to draw a polyhedron`,
      minimum: 3,
      maximum: 12,
    },
    polyhedra_max_neighbors: {
      value: 8,
      description:
        `Maximum coordination number for a polyhedron (skips e.g. CN-12 cuboctahedra around large A-site cations)`,
      minimum: 4,
      maximum: 16,
    },
    polyhedra_bond_scale: {
      value: 1.15,
      description:
        `Bond cutoff for the atom_radii bonds that build polyhedra: connect when ` +
        `distance ≤ scale × (sum of covalent radii). Tune independently of the ` +
        `displayed bonds — lower for tighter coordination shells, higher to close ` +
        `polyhedra with longer metal-ligand bonds.`,
      minimum: 1.0,
      maximum: 1.4,
    },
    polyhedra_metals_only: {
      value: true,
      description:
        `Only show polyhedra around metal atoms (uncheck to include non-metals)`,
    },
    polyhedra_style: {
      value: `flat` as const,
      description:
        `Polyhedra face rendering: classic flat facets, smooth matte, or frosted glass`,
      enum: {
        flat: `Flat`,
        matte: `Smooth Matte`,
        glass: `Glass`,
      },
    },
    polyhedra_color_mode: {
      value: `vertex` as const,
      description:
        `Color polyhedra by the atoms at their corners, the center atom, or a single custom color`,
      enum: {
        vertex: `Vertex Atoms`,
        center: `Center Atom`,
        uniform: `Custom Color`,
      },
    },
    polyhedra_color: {
      value: `#4a90d9`,
      description: `Custom polyhedra face color (used when color mode is Custom Color)`,
    },
    polyhedra_show_edges: {
      value: true,
      description: `Draw outlines along polyhedra edges`,
    },
    polyhedra_opacity_mode: {
      value: `uniform` as const,
      description: `Opacity mode for polyhedra faces`,
      enum: {
        uniform: `Uniform`,
        depth_gradient: `Depth Gradient`,
      },
    },
    polyhedra_opacity: {
      value: 0.4,
      description: `Opacity of polyhedra faces (uniform mode)`,
      minimum: 0.05,
      maximum: 1,
    },
    polyhedra_opacity_near: {
      value: 0.6,
      description: `Opacity of nearest polyhedra faces (depth gradient mode)`,
      minimum: 0.05,
      maximum: 1,
    },
    polyhedra_opacity_far: {
      value: 0.1,
      description: `Opacity of farthest polyhedra faces (depth gradient mode)`,
      minimum: 0,
      maximum: 1,
    },
    polyhedra_edge_opacity: {
      value: 0.8,
      description: `Opacity of polyhedra edges`,
      minimum: 0,
      maximum: 1,
    },
    polyhedra_edge_color: {
      value: `#333333`,
      description: `Color of polyhedra edges`,
    },
    polyhedra_edge_width: {
      value: 1.5,
      description: `Width of polyhedra edge lines in screen pixels`,
      minimum: 0.5,
      maximum: 5,
    },
    polyhedra_color_overrides: {
      value: {} as Record<string, string>,
      description: `Per-element color overrides for polyhedra (e.g. {"Zr": "#00aaff"})`,
    },
    hide_polyhedra_center_atoms: {
      value: true,
      description: `Hide the central atom inside each polyhedron`,
    },
    hide_polyhedra_internal_bonds: {
      value: true,
      description: `Hide bonds inside polyhedra (center-to-ligand and ligand-to-ligand)`,
    },

    // Sphere clipping
    clip_active: {
      value: false,
      description:
        `Enable sphere clipping to show only atoms within a radius of a selected atom`,
    },
    clip_radius: {
      value: 8,
      description: `Radius of the clipping sphere in Angstroms`,
      minimum: 2,
      maximum: 30,
    },
    clip_outside_mode: {
      value: `transparent` as const,
      description: `How to display atoms outside the clipping sphere`,
      enum: {
        hide: `Hide`,
        transparent: `Semi-transparent`,
      },
    },
    clip_outside_opacity: {
      value: 0.1,
      description: `Opacity of atoms outside the clipping sphere (semi-transparent mode)`,
      minimum: 0,
      maximum: 0.5,
    },
  },

  // Trajectory viewer settings
  trajectory: {
    // Core trajectory settings
    auto_play: {
      value: false,
      description: `Automatically start playing trajectory when opened`,
    },
    fps: {
      value: 10,
      description: `Frames per second for trajectory playback`,
      minimum: 0.1,
      maximum: 60,
    },
    fps_range: {
      value: [0.2, 60] as const,
      description: `Allowed range for playback speed [min, max]`,
      minItems: 2,
      maxItems: 2,
    },
    display_mode: {
      value: `structure+scatter` as const,
      description: `Visualization mode for trajectory data`,
      enum: {
        'structure+scatter': `Structure + Scatter`,
        structure: `Structure`,
        scatter: `Scatter`,
        histogram: `Histogram`,
        'structure+histogram': `Structure + Histogram`,
      },
    },
    show_controls: {
      value: true,
      description: `Show playback controls`,
    },
    fullscreen_toggle: {
      value: true,
      description:
        `Show fullscreen toggle button (web-only, always false in other contexts)`,
      context: `web`,
    },
    step_labels: {
      value: 5,
      description: `Number of frame labels to display`,
      minimum: 0,
      maximum: 20,
    },
    layout: {
      value: `auto` as const,
      description: `Layout arrangement for trajectory viewer`,
      enum: {
        auto: `Auto`,
        horizontal: `Horizontal`,
        vertical: `Vertical`,
      },
    },

    // File handling and loading
    allow_file_drop: {
      value: true,
      description: `Allow drag-and-drop of trajectory files`,
    },
    bin_file_threshold: {
      value: 50000000,
      description: `File size threshold for binary loading (bytes)`,
      minimum: 1000000,
      maximum: 500000000,
    },
    text_file_threshold: {
      value: 25000000,
      description: `File size threshold for text loading (bytes)`,
      minimum: 500000,
      maximum: 250000000,
    },
    use_indexing: {
      value: false,
      description: `Use frame indexing for large trajectories`,
    },
    chunk_size: {
      value: 1000,
      description: `Number of frames to process at once`,
      minimum: 10,
      maximum: 10000,
    },

    // Formatting
    step_label_format: {
      value: `.3~s`,
      description: `Number format for step labels (D3 format specifier)`,
    },
    property_value_format: {
      value: `.2~s`,
      description: `Number format for property values (D3 format specifier)`,
    },
    tooltip_format: {
      value: `.3~s`,
      description: `Number format for tooltips (D3 format specifier)`,
    },

    // UI/UX
    enable_keyboard_shortcuts: {
      value: true,
      description: `Enable keyboard shortcuts for playback`,
    },
    show_parsing_progress: {
      value: true,
      description: `Show progress indicator while parsing files`,
    },
    compact_controls: {
      value: false,
      description: `Use compact layout for playback controls`,
    },
    show_filename_in_controls: {
      value: true,
      description: `Display filename in control pane`,
    },

    // Playback behavior
    smooth_playback: {
      value: false,
      description: `Use smooth interpolation between frames`,
    },
    loop_playback: {
      value: true,
      description: `Loop trajectory playback`,
    },
    pause_on_hover: {
      value: false,
      description: `Pause playback when hovering over controls`,
    },
    highlight_current_frame: {
      value: true,
      description: `Highlight current frame in timeline`,
    },
    show_frame_info: {
      value: true,
      description: `Show frame information overlay`,
    },

    // Performance
    max_frames_in_memory: {
      value: 1000,
      description: `Maximum frames to keep in memory`,
      minimum: 10,
      maximum: 10000,
    },
    memory_usage_warning_threshold: {
      value: 500,
      description: `Frame count threshold for memory warnings`,
      minimum: 10,
      maximum: 5000,
    },
    enable_performance_monitoring: {
      value: false,
      description: `Enable performance monitoring`,
    },
    prefetch_frames: {
      value: 5,
      description: `Number of frames to prefetch ahead`,
      minimum: 0,
      maximum: 100,
    },
    cache_parsed_data: {
      value: true,
      description: `Cache parsed trajectory data`,
    },
  },

  // Histogram specific
  histogram: {
    mode: {
      value: `overlay` as const,
      description:
        `Histogram display mode. 'overlay' shows multiple histograms in the same plot, 'single' shows a single histogram`,
      enum: {
        overlay: `Overlay`,
        single: `Single`,
      },
    },
    show_legend: {
      value: true,
      description: `Show legend in histogram plots`,
    },
    bin_count: {
      value: 100,
      description: `Number of bins for histogram plots`,
      minimum: 1,
      maximum: 1000,
    },
    bar: {
      color: {
        value: `#4A9EFF`,
        description: `Histogram bar fill color`,
      },
      opacity: {
        value: 0.7,
        description: `Histogram bar opacity`,
        minimum: 0,
        maximum: 1,
      },
      stroke_width: {
        value: 1,
        description: `Histogram bar stroke width`,
        minimum: 0,
        maximum: 5,
      },
      stroke_color: {
        value: `#000000`,
        description: `Histogram bar stroke color`,
      },
      stroke_opacity: {
        value: 0.5,
        description: `Histogram bar stroke opacity`,
        minimum: 0,
        maximum: 1,
      },
    },
    display: DISPLAY_CONFIG,
  },

  // Bar plot specific
  bar: {
    bar: {
      color: {
        value: `#4A9EFF`,
        description: `Bar plot fill color`,
      },
      opacity: {
        value: 0.6,
        description: `Bar plot opacity (overlay mode)`,
        minimum: 0,
        maximum: 1,
      },
    },
    line: {
      width: {
        value: 2,
        description: `Bar plot line width`,
        minimum: 0.5,
        maximum: 10,
      },
      color: {
        value: `#4A9EFF`,
        description: `Bar plot line color`,
      },
    },
    display: DISPLAY_CONFIG,
  },

  // Composition specific
  composition: {
    display_mode: {
      value: `pie` as const,
      description: `Display mode for composition data`,
      enum: {
        pie: `Pie`,
        bubble: `Bubble`,
        bar: `Bar`,
      },
    },
    color_scheme: {
      value: `Vesta`,
      description: `Color scheme for composition visualization`,
      enum: {
        Vesta: `Vesta`,
        Jmol: `Jmol`,
        Alloy: `Alloy`,
        Pastel: `Pastel`,
        Muted: `Muted`,
        'Dark Mode': `Dark Mode`,
      },
    },
  },

  // Scatter plot specific
  scatter: {
    symbol_type: {
      value: `Circle`,
      description: `Default symbol type for scatter plots`,
      enum: Object.fromEntries(symbol_names.map((name) => [name, name])) as Readonly<
        Record<D3SymbolName, string>
      >,
    },
    show_legend: {
      value: true,
      description: `Show legend in scatter plots`,
    },
    show_points: {
      value: true,
      description: `Show points in scatter plots`,
    },
    show_lines: {
      value: true,
      description: `Show connecting lines in scatter plots`,
    },
    display: DISPLAY_CONFIG,
    point: {
      size: {
        value: 4,
        description: `Point size for scatter plots`,
        minimum: 1,
        maximum: 20,
      },
      color: {
        value: `#4A9EFF`,
        description: `Default color for scatter plot points`,
      },
      opacity: {
        value: 1,
        description: `Opacity of scatter plot points`,
        minimum: 0,
        maximum: 1,
      },
      stroke_width: {
        value: 1,
        description: `Stroke width for scatter plot points`,
        minimum: 0,
        maximum: 5,
      },
      stroke_color: {
        value: `#000000`,
        description: `Stroke color for scatter plot points`,
      },
      stroke_opacity: {
        value: 1,
        description: `Stroke opacity for scatter plot points`,
        minimum: 0,
        maximum: 1,
      },
    },
    line: {
      width: {
        value: 2,
        description: `Line width for scatter plot connections`,
        minimum: 0.5,
        maximum: 10,
      },
      color: {
        value: `#4A9EFF`,
        description: `Default color for scatter plot lines`,
      },
      opacity: {
        value: 1,
        description: `Opacity of scatter plot lines`,
        minimum: 0,
        maximum: 1,
      },
      dash: {
        value: `solid`,
        description: `Line dash pattern for scatter plots (e.g., "4,4" for dashed)`,
      },
    },
  },

  // Plot general
  plot: {
    animation_duration: {
      value: 200,
      description: `Duration of plot animations in milliseconds`,
      minimum: 0,
      maximum: 2000,
    },
    enable_zoom: {
      value: true,
      description: `Enable zooming in plots`,
    },
    zoom_factor: {
      value: 1.5,
      description: `Zoom factor for plot interactions`,
      minimum: 1.1,
      maximum: 5.0,
    },
    auto_fit_range: {
      value: true,
      description: `Automatically fit plot range to data`,
    },
    grid_lines: {
      value: true,
      description: `Show grid lines in plots`,
    },
    axis_labels: {
      value: true,
      description: `Show axis labels in plots`,
    },
    show_x_zero_line: {
      value: true,
      description: `Show X-axis zero reference line`,
    },
    show_y_zero_line: {
      value: true,
      description: `Show Y-axis zero reference line`,
    },
    show_x_grid: {
      value: true,
      description: `Show X-axis grid lines`,
    },
    show_y_grid: {
      value: true,
      description: `Show Y-axis grid lines`,
    },
    show_y2_grid: {
      value: true,
      description: `Show secondary Y-axis grid lines`,
    },
    x_format: {
      value: `.2~s`,
      description: `Number format for X-axis ticks (D3 format specifier)`,
    },
    y_format: {
      value: `d`,
      description: `Number format for Y-axis ticks (D3 format specifier)`,
    },
    y2_format: {
      value: ``,
      description: `Number format for secondary Y-axis ticks (D3 format specifier)`,
    },
    x_scale_type: {
      value: `linear`,
      description: `Scale type for X-axis`,
      enum: {
        linear: `Linear`,
        log: `Log`,
      },
    },
    y_scale_type: {
      value: `linear`,
      description: `Scale type for Y-axis`,
      enum: {
        linear: `Linear`,
        log: `Log`,
      },
    },
    x_ticks: {
      value: 8,
      description: `Number of ticks on X-axis`,
      minimum: 2,
      maximum: 20,
    },
    y_ticks: {
      value: 6,
      description: `Number of ticks on Y-axis`,
      minimum: 2,
      maximum: 20,
    },
  },

  chat: {
    provider: {
      value: `anthropic` as const,
      description: `LLM provider for AI chat assistant`,
      enum: { anthropic: `Anthropic`, openai: `OpenAI` },
    },
    model: {
      value: `claude-sonnet-4-20250514`,
      description: `Model name for AI chat assistant`,
    },
    temperature: {
      value: 0.3,
      description: `Temperature for AI chat responses (0 = deterministic, 1 = creative)`,
      minimum: 0,
      maximum: 1,
    },
    max_tokens: {
      value: 2048,
      description: `Maximum tokens in AI chat response`,
      minimum: 256,
      maximum: 8192,
    },
    show_chat: {
      value: true,
      description: `Show AI chat assistant button in toolbar`,
    },
  },

  phase_diagram: { // Phase diagram defaults (binary/ternary/quaternary)
    binary: {
      camera_zoom: {
        value: 1.0,
        description: `Initial zoom for binary (2D) phase diagram`,
        minimum: 0.1,
        maximum: 10,
      },
      camera_center_x: {
        value: 0,
        description: `Initial X center for binary (2D) phase diagram`,
      },
      camera_center_y: {
        value: 0,
        description: `Initial Y center for binary (2D) phase diagram`,
      },
      color_mode: {
        value: `energy`,
        description: `Color mode for 2D PD points`,
        enum: {
          stability: `Stability`,
          energy: `Energy`,
        },
      },
      color_scale: {
        value: `interpolateViridis`,
        description: `D3 interpolate color scale for 2D PD energy mode`,
      },
      show_stable: {
        value: true,
        description: `Show stable phases in 2D PD`,
      },
      show_unstable: {
        value: true,
        description: `Show unstable phases in 2D PD`,
      },
      show_stable_labels: {
        value: true,
        description: `Show labels for stable phases in 2D PD`,
      },
      show_unstable_labels: {
        value: false,
        description: `Show labels for unstable phases in 2D PD`,
      },
      max_hull_dist_show_phases: {
        value: 0.1,
        description: `Max eV/atom above hull for showing unstable entries in 2D PD`,
        minimum: 0,
        maximum: 2,
      },
      max_hull_dist_show_labels: {
        value: 0.1,
        description: `Max eV/atom above hull for labeling unstable entries in 2D PD`,
        minimum: 0,
        maximum: 2,
      },
      fullscreen: {
        value: false,
        description: `Start in fullscreen for 2D PD`,
      },
      info_pane_open: {
        value: false,
        description: `Info pane open by default for 2D PD`,
      },
      legend_pane_open: {
        value: false,
        description: `Legend pane open by default for 2D PD`,
      },
    },
    ternary: {
      camera_elevation: {
        value: 45,
        description: `Initial camera elevation (deg) for ternary (3D) PD`,
        minimum: -180,
        maximum: 180,
      },
      camera_azimuth: {
        value: 60,
        description: `Initial camera azimuth (deg) for ternary (3D) PD`,
        minimum: -360,
        maximum: 360,
      },
      camera_zoom: {
        value: 1.5,
        description: `Initial camera zoom for ternary (3D) PD`,
        minimum: 0.1,
        maximum: 10,
      },
      camera_center_x: {
        value: 0,
        description: `Initial X center for ternary (3D) PD`,
      },
      camera_center_y: {
        value: -50,
        description: `Initial Y center for ternary (3D) PD`,
      },
      color_mode: {
        value: `energy`,
        description: `Color mode for 3D PD points`,
        enum: {
          stability: `Stability`,
          energy: `Energy`,
        },
      },
      color_scale: {
        value: `interpolateViridis`,
        description: `D3 interpolate color scale for 3D PD energy mode`,
      },
      show_stable: {
        value: true,
        description: `Show stable phases in 3D PD`,
      },
      show_unstable: {
        value: true,
        description: `Show unstable phases in 3D PD`,
      },
      show_stable_labels: {
        value: true,
        description: `Show labels for stable phases in 3D PD`,
      },
      show_unstable_labels: {
        value: false,
        description: `Show labels for unstable phases in 3D PD`,
      },
      max_hull_dist_show_phases: {
        value: 0.5,
        description: `Max eV/atom above hull for showing unstable entries in 3D PD`,
        minimum: 0,
        maximum: 2,
      },
      max_hull_dist_show_labels: {
        value: 0.1,
        description: `Max eV/atom above hull for labeling unstable entries in 3D PD`,
        minimum: 0,
        maximum: 2,
      },
      show_hull_faces: {
        value: true,
        description: `Render lower hull faces in 3D PD`,
      },
      hull_face_color: {
        value: `#4caf50`,
        description: `Color for lower hull faces in 3D PD`,
      },
      hull_face_opacity: {
        value: 0.3,
        description: `Opacity for hull faces in 3D PD (0-1)`,
        minimum: 0,
        maximum: 1,
      },
      fullscreen: {
        value: false,
        description: `Start in fullscreen for 3D PD`,
      },
      info_pane_open: {
        value: false,
        description: `Info pane open by default for 3D PD`,
      },
      legend_pane_open: {
        value: false,
        description: `Legend pane open by default for 3D PD`,
      },
    },
    quaternary: {
      camera_rotation_x: {
        value: -0.6,
        description: `Initial camera X rotation (rad) for quaternary (4D) PD`,
        minimum: -6.283,
        maximum: 6.283,
      },
      camera_rotation_y: {
        value: 0.8,
        description: `Initial camera Y rotation (rad) for quaternary (4D) PD`,
        minimum: -6.283,
        maximum: 6.283,
      },
      camera_zoom: {
        value: 1.4,
        description: `Initial camera zoom for quaternary (4D) PD`,
        minimum: 0.1,
        maximum: 20,
      },
      camera_center_x: {
        value: 0,
        description: `Initial X center for quaternary (4D) PD`,
      },
      camera_center_y: {
        value: 20,
        description: `Initial Y center for quaternary (4D) PD`,
      },
      color_mode: {
        value: `energy`,
        description: `Color mode for 4D PD points`,
        enum: {
          stability: `Stability`,
          energy: `Energy`,
        },
      },
      color_scale: {
        value: `interpolateViridis`,
        description: `D3 interpolate color scale for 4D PD energy mode`,
      },
      show_stable: {
        value: true,
        description: `Show stable phases in 4D PD`,
      },
      show_unstable: {
        value: true,
        description: `Show unstable phases in 4D PD`,
      },
      show_stable_labels: {
        value: true,
        description: `Show labels for stable phases in 4D PD`,
      },
      show_unstable_labels: {
        value: false,
        description: `Show labels for unstable phases in 4D PD`,
      },
      show_hull_faces: {
        value: true,
        description: `Show convex hull faces in 4D PD`,
      },
      hull_face_color: {
        value: `#4caf50`,
        description: `Color for hull faces in 4D PD`,
      },
      hull_face_opacity: {
        value: 0.06,
        description: `Opacity for hull faces in 4D PD (0-1)`,
        minimum: 0,
        maximum: 1,
      },
      max_hull_dist_show_phases: {
        value: 0.1,
        description: `Max eV/atom above hull for showing unstable entries in 4D PD`,
        minimum: 0,
        maximum: 2,
      },
      max_hull_dist_show_labels: {
        value: 0.1,
        description: `Max eV/atom above hull for labeling unstable entries in 4D PD`,
        minimum: 0,
        maximum: 2,
      },
      fullscreen: {
        value: false,
        description: `Start in fullscreen for 4D PD`,
      },
      info_pane_open: {
        value: false,
        description: `Info pane open by default for 4D PD`,
      },
      legend_pane_open: {
        value: false,
        description: `Legend pane open by default for 4D PD`,
      },
    },
  },

  // Hand gesture & voice control
  gesture: {
    enabled: {
      value: false,
      description: `Enable hand gesture and voice control`,
      context: `web`,
    },
    show_webcam_pip: {
      value: true,
      description: `Show webcam picture-in-picture preview when gesture mode is active`,
      context: `web`,
    },
    show_skeleton: {
      value: true,
      description: `Show hand skeleton overlay with neon visualization`,
      context: `web`,
    },
    sensitivity: {
      value: 1.0,
      description: `Gesture sensitivity multiplier (higher = more responsive)`,
      minimum: 0.1,
      maximum: 3.0,
    },
    voice_enabled: {
      value: true,
      description: `Enable voice commands (requires microphone)`,
      context: `web`,
    },
    voice_language: {
      value: `en-US`,
      description: `Voice recognition language`,
      enum: {
        'en-US': `English (US)`,
        'en-GB': `English (UK)`,
        'zh-CN': `中文（简体）`,
        'zh-TW': `中文（繁體）`,
        'ja-JP': `日本語`,
        'ko-KR': `한국어`,
        'de-DE': `Deutsch`,
        'fr-FR': `Français`,
        'es-ES': `Español`,
      },
    },
    voice_method: {
      value: `auto`,
      description:
        `Voice recognition engine: auto tries Web Speech API first then Whisper`,
      enum: {
        'auto': `Auto (Web Speech → Whisper)`,
        'web_speech': `Web Speech API (free, Chrome/Edge)`,
        'whisper': `Whisper API (OpenAI, works everywhere)`,
      },
      context: `web`,
    },
    whisper_api_key: {
      value: ``,
      description:
        `OpenAI API key for Whisper voice recognition (only used when Whisper method is active)`,
      context: `web`,
    },
    art_trail_spacing: {
      value: 2.0,
      description: `Minimum distance between trail atoms in art mode (Angstroms)`,
      minimum: 0.5,
      maximum: 10.0,
    },
    neon_color: {
      value: `#00fff7`,
      description: `Primary neon color for gesture overlay`,
    },
    tts_enabled: {
      value: true,
      description:
        `Enable voice response (text-to-speech) for gesture commands and AI answers`,
      context: `web`,
    },
    tts_volume: {
      value: 0.8,
      description: `Voice response volume`,
      minimum: 0,
      maximum: 1,
    },
    tts_rate: {
      value: 1.0,
      description: `Voice response speaking rate`,
      minimum: 0.5,
      maximum: 2.0,
    },
    tts_voice: {
      value: ``,
      description: `Preferred TTS voice name (empty = auto-select by language)`,
      context: `web`,
    },
    voice_ai_enabled: {
      value: true,
      description:
        `Route unrecognized voice commands to AI chat for complex operations (requires API key)`,
      context: `web`,
    },
  },
}
