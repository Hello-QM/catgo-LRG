# Tips and Tricks

Practical advice for getting the most out of CatGO.

## Keyboard Shortcuts Reference

### Camera

| Key | Action |
|-----|--------|
| Arrow keys | Rotate structure (pitch and yaw) |
| W / S | Roll structure (counterclockwise / clockwise) |
| R | Reset camera to lattice-aligned view |
| F | Toggle fullscreen |

### Selection & Editing

| Key | Action |
|-----|--------|
| Click | Select atom |
| Shift+Click | Add/remove atom from selection |
| Double-click | Clear selection |
| Delete / Backspace | Delete selected atoms, bonds, or measurements |
| Ctrl+Z / Cmd+Z | Undo |
| Ctrl+Shift+Z / Cmd+Shift+Z | Redo |
| Drag atom-to-atom (bond mode) | Create bond between two atoms with ghost preview |
| Escape (bond mode) | Cancel in-progress bond drag or clear bond selection |

### Atom Manipulation

| Key | Action |
|-----|--------|
| Arrow keys (with selection) | Move selected atoms by step size (default 0.1 A) |
| Shift+Arrow keys | Move selected atoms by 10x step size |
| Shift+Alt+Drag | Drag selected atoms without clicking first |
| Shift+Drag (left button) | Rotate selected atoms (pitch/yaw) |
| Shift+Drag (right button) | Roll selected atoms |
| X / Y / Z | Lock rotation to that axis (hold key) |

### Interface

| Key | Action |
|-----|--------|
| I | Toggle info pane |
| Escape | Close panes / exit modes (in priority order) |
| Ctrl+Enter / Cmd+Enter | Import from paste modal |

### Trajectory Playback

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| A / D | Previous / Next frame |
| Ctrl+A / Ctrl+D | Jump to first / last frame |
| J / L | Back / Forward 10 frames |
| PageUp / PageDown | Back / Forward 25 frames |
| 0-9 | Jump to percentage of trajectory |
| + / - | Increase / Decrease playback speed |

## Mouse Controls

| Action | Mouse |
|--------|-------|
| Rotate | Left-click drag |
| Roll | Right-click drag |
| Zoom | Scroll wheel |
| Pan | Shift+drag or Ctrl/Cmd+drag |
| Select atom | Click |
| Multi-select | Shift+click |
| Clear selection | Double-click background |

## Performance Tips

### Large Structures (>1000 atoms)

- **Reduce sphere segments** — Lower `sphere_segments` in settings (default: 20, try 12-16 for large systems)
- **Disable bonds** — Set `show_bonds` to "never" for very large structures where bond detection is slow
- **Disable image atoms** — Turn off `show_image_atoms` if you don't need PBC visualization
- **Use same-size atoms** — Enable `same_size_atoms` to simplify rendering

### Large Trajectories

- **Indexed loading** kicks in automatically for files >25 MB (text) or >50 MB (binary)
- **Reduce FPS** — Lower the playback speed if frames are dropping
- **Increase chunk size** — Higher `chunk_size` values speed up parsing but use more memory
- **Limit frames in memory** — Adjust `max_frames_in_memory` based on your available RAM

### Rendering Quality vs. Speed

| Setting | Performance | Quality |
|---------|-------------|---------|
| `sphere_segments` 12 | Fast | Angular spheres |
| `sphere_segments` 20 | Default | Good quality |
| `sphere_segments` 48 | Slow | Smooth spheres |
| `depth_cueing` 0 | No overhead | No fog |
| `depth_cueing` 0.5 | Slight overhead | Subtle depth |

## Customization

### Atom Colors

CatGO provides six built-in color schemes:

| Scheme | Style |
|--------|-------|
| **Vesta** | Industry standard (default) |
| **Jmol** | Jmol molecular viewer colors |
| **Alloy** | Metallic palette |
| **Pastel** | Soft, muted colors |
| **Muted** | Desaturated tones |
| **Dark Mode** | Optimized for dark backgrounds |

To use custom colors per element, set `atom_color_mode` to "custom" and assign colors in the legend panel.

### Color by Property

Switch `atom_color_mode` to color atoms by:

- **Element** — Standard periodic table colors
- **Coordination number** — Number of bonded neighbors
- **Wyckoff position** — Symmetry-equivalent sites

The color scale (`atom_color_scale`) can be set to any D3 interpolation function (viridis, plasma, inferno, magma, etc.).

### Background

- Set `background_color` to any hex color
- Set `background_opacity` to 0 for a transparent background (useful for overlaying on slides)

### Labels

- Enable `show_site_labels` for element symbols on atoms
- Enable `show_site_indices` for index numbers
- Adjust `site_label_size`, `site_label_color`, and `site_label_offset` for positioning

## Export Tips

### Publication-Quality Images

1. Set `background_opacity` to 0 (transparent) or 1 (solid white/black)
2. Increase `sphere_segments` to 48 for smooth spheres
3. Adjust `atom_radius` for the desired visual weight
4. Export as **GLB** or **OBJ** for use in Blender, PowerPoint, or other rendering software
5. Or take a screenshot directly from the fullscreen viewer

### VASP Workflow

1. Import a CIF from OPTIMADE or load from file
2. Use the slab cutter to create a surface
3. Add adsorbates using the pencil mode or adsorption site finder
4. Export as POSCAR for direct use with VASP

### Batch Processing

For many structures, use CatGO's pymatgen-compatible JSON format:
1. Export structures as JSON
2. Process with Python/pymatgen scripts
3. Re-import the results

## Common Workflows

### Surface Catalysis Setup

1. Import a bulk catalyst (e.g., Pt from OPTIMADE)
2. Cut a (111) slab with the Miller slab cutter
3. Build a 2x2x1 supercell for adequate surface area
4. Find adsorption sites (atop, bridge, hollow)
5. Add adsorbate molecule using pencil mode
6. Freeze bottom 2 layers
7. Optimize with MACE or CHGNet
8. Export as POSCAR for production DFT

### Quick Structure Check

1. Drag and drop a CIF/POSCAR file
2. Press **I** to view formula, space group, lattice parameters
3. Toggle bonds and cell display to verify the structure
4. Export in a different format if needed

## Bonding Strategies

CatGO offers three bond detection methods:

| Strategy | Description | Best For |
|----------|-------------|----------|
| **Solid angle** | Geometric solid angle criterion (default) | General use |
| **Electronegativity ratio** | Based on Pauling electronegativity differences | Ionic/covalent materials |
| **Atomic radii** | Sum of covalent radii with tolerance | Simple molecules |

If bonds look wrong, try switching the bonding strategy in settings.

## Symmetry Algorithms

Two algorithms are available for space group detection:

| Algorithm | Description |
|-----------|-------------|
| **Moyo** (default) | Modern symmetry finder, accurate for most structures |
| **Spglib** | Classic algorithm, wider compatibility |

Adjust `symmetry.symprec` (default: 1e-4) if the detected space group seems wrong — looser tolerance finds higher symmetry.
