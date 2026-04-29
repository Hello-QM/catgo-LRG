# Trajectory Playback

This tutorial covers loading and playing molecular dynamics (MD) trajectories and optimization paths.

## Supported Formats

| Format | Extensions | Description |
|--------|-----------|-------------|
| Extended XYZ | `.extxyz` | Multi-frame XYZ with lattice and per-atom properties |
| XYZ | `.xyz` | Simple multi-frame Cartesian coordinates |
| ASE Trajectory | `.traj` | ASE native binary format |
| HDF5 | `.hdf5`, `.h5` | Hierarchical Data Format (multi-frame) |
| XDATCAR | `XDATCAR` | VASP MD trajectory |
| Compressed | `.gz`, `.zip` | Any of the above, compressed |

## Loading a Trajectory

### Drag and Drop

Drop a trajectory file onto the viewer. CatGO auto-detects the format and switches to trajectory mode.

### File Picker

Use the **Import** button to browse for trajectory files.

### From Optimization

After running a [structure optimization](/tutorials/structures/optimization), you can export the full optimization trajectory as a multi-frame extXYZ file, then reload it for analysis.

## Playback Controls

### Buttons

| Button | Action |
|--------|--------|
| Play / Pause | Start or pause playback |
| Previous | Go back one frame |
| Next | Advance one frame |
| FPS slider | Adjust playback speed |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| A | Previous frame |
| D | Next frame |
| Ctrl+A | Jump to first frame |
| Ctrl+D | Jump to last frame |
| J | Back 10 frames |
| L | Forward 10 frames |
| PageUp | Back 25 frames |
| PageDown | Forward 25 frames |
| 0-9 | Jump to percentage (0 = start, 5 = halfway, 9 = end) |
| + / = | Increase playback speed |
| - | Decrease playback speed |
| F | Toggle fullscreen |

## Display Modes

The trajectory viewer supports multiple visualization layouts:

| Mode | Description |
|------|-------------|
| **Structure + Scatter** | 3D viewer alongside energy/force plots (default) |
| **Structure + Histogram** | 3D viewer with property distribution |
| **Structure only** | Full-size 3D viewer |
| **Scatter only** | Energy/force plots only |
| **Histogram only** | Property distribution analysis |

## Plot Interaction

When the scatter plot is visible:

- **Hover** over a data point to preview that frame in the 3D viewer
- **Click** a data point to jump to that frame
- Plots show per-frame properties like energy, max force, volume, and temperature (when available in the trajectory metadata)

## Information Pane

Press **I** to view trajectory metadata:

- File info (name, size, format)
- Frame count and indexing status
- Current structure info (atom count, formula, volume, density)
- Energy range across frames
- Force range across frames
- Volume change metrics

## Large Trajectory Handling

CatGO uses intelligent loading strategies for large files:

| File Size | Strategy |
|-----------|----------|
| Small (<25 MB text, <50 MB binary) | Load all frames into memory |
| Large (>25 MB text, >50 MB binary) | Indexed loading — frames loaded on demand |

For indexed trajectories:
- Frame byte offsets are pre-computed for fast seeking
- Only the current frame (plus a few prefetched frames) is in memory
- Plot metadata is extracted without loading full structures

### Performance Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `max_frames_in_memory` | 1000 | Max frames kept in memory |
| `prefetch_frames` | 5 | Frames pre-loaded ahead of current |
| `chunk_size` | 1000 | Frames processed at once during parsing |
| `cache_parsed_data` | true | Cache parsed frames for reuse |

## Tips

- **Use extXYZ for rich data** — The extXYZ format supports per-frame and per-atom properties (energy, forces, stress, charges), which CatGO can plot.
- **Loop playback** is enabled by default. Disable it in settings for one-shot viewing.
- **Pause on hover** — Enable this setting to automatically pause when you hover over the controls, making it easier to interact with the UI.
- **Hidden elements persist** — If you hide an element type, it stays hidden across all frames.
