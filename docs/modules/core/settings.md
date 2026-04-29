# Settings

Unified settings schema with 40+ configurable properties that apply across all deployment targets.

**Source:** `src/lib/settings.ts`

## Overview

All configurable options are defined in a central `settings.ts` file with types, descriptions, min/max values, and defaults. The same schema is used by the web app, VSCode extension, desktop app, and Jupyter widget.

## Settings by Category

### Atom Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `atom_radius` | number | 0.4 | Atom sphere radius (A) |
| `sphere_segments` | number | 16 | Sphere quality (more = smoother) |
| `color_mode` | string | "element" | Coloring: element, coordination, wyckoff, custom |
| `color_scale` | string | "Jmol" | Color scale for element coloring |
| `show_image_atoms` | boolean | true | Display PBC image atoms |

### Bond Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `show_bonds` | boolean | true | Display bonds |
| `bond_thickness` | number | 0.15 | Bond cylinder radius |
| `bonding_strategy` | string | "distance" | Strategy: distance, electronegativity, VESTA |

### Labels

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `show_site_labels` | boolean | false | Display atom labels |
| `show_indices` | boolean | false | Show atom index numbers |
| `label_color` | string | "white" | Label text color |
| `label_size` | number | 14 | Label font size (px) |
| `label_offset` | number[] | [0, 0] | Label position offset |

### Camera

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `camera_projection` | string | "perspective" | Projection: perspective, orthographic |
| `camera_fov` | number | 50 | Field of view (degrees) |
| `zoom_min` | number | 1 | Minimum zoom distance |
| `zoom_max` | number | 1000 | Maximum zoom distance |
| `rotation_damping` | number | 0.2 | Rotation smoothing factor |
| `auto_rotate` | boolean | false | Auto-rotation mode |

### Lattice / Cell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `show_cell` | boolean | true | Display unit cell wireframe |
| `show_cell_vectors` | boolean | true | Display lattice vector arrows |
| `cell_opacity` | number | 1.0 | Cell edge opacity |

### Lighting

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ambient_light` | number | 0.5 | Ambient light intensity |
| `directional_light` | number | 0.8 | Directional light intensity |
| `depth_cueing` | number | 0 | Fog effect strength (0 = off) |

### Controls

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `rotation_speed` | number | 1.0 | Mouse rotation sensitivity |
| `zoom_speed` | number | 1.0 | Scroll zoom sensitivity |
| `pan_speed` | number | 1.0 | Middle-click pan sensitivity |

### Trajectory

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `trajectory_fps` | number | 10 | Playback speed (frames/second) |
| `trajectory_auto_play` | boolean | false | Auto-play on load |
| `trajectory_display_mode` | string | "structure" | Layout mode |

### Symmetry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `symprec` | number | 0.01 | Symmetry tolerance (A) |
| `symmetry_algorithm` | string | "moyo" | Backend: moyo, spglib |

### Atom Manipulation

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `keyboard_step_size` | number | 0.1 | Arrow key move distance (A) |
| `frozen_atom_indicator` | string | "ring" | Visual: ring, crosshatch, dimmed |

## Platform Contexts

Settings can be scoped to specific deployment contexts:

| Context | Description |
|---------|-------------|
| `web` | Browser-based web app |
| `editor` | VSCode extension |
| `notebook` | Jupyter / Marimo widget |
| `all` | Applies everywhere (default) |

## Settings Schema

Each setting is defined with:

```typescript
{
  key: string           // Setting identifier
  type: "number" | "string" | "boolean"
  default: any          // Default value
  description: string   // Human-readable description
  min?: number          // Minimum (for numbers)
  max?: number          // Maximum (for numbers)
  options?: string[]    // Valid values (for enums)
  context?: string[]    // Platform contexts
}
```

## Persistence

- **Web app** — settings stored in `localStorage`
- **Desktop app** — settings persisted via Tauri IPC (survives restarts)
- **VSCode** — settings in VSCode workspace/user config
- **Jupyter** — settings passed as widget props
