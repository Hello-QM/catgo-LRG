# Trajectories & Molecular Dynamics

Playback, analysis, and export of molecular dynamics trajectories from multiple file formats.

**Source:** `src/lib/trajectory/`

## Supported Formats

| Format | Extensions | Description |
|--------|-----------|-------------|
| XYZ | `.xyz` | Multi-frame XYZ (frames separated by headers) |
| Extended XYZ | `.extxyz` | Multi-frame with lattice and properties |
| ASE Trajectory | `.traj` | ASE native binary format |
| XDATCAR | `XDATCAR` | VASP molecular dynamics output |
| HDF5 | `.hdf5`, `.h5` | Hierarchical Data Format (multi-frame) |

## Key Functions

### Loading

```typescript
// Load trajectory from file
load_trajectory_file(content, filename): Trajectory

// Validate trajectory data
validate_trajectory(trajectory): ValidationResult

// Get trajectory metadata
get_trajectory_stats(trajectory): TrajectoryStats
```

### Streaming & Indexing

For large trajectory files (>100 MB), the module supports indexed access:

```typescript
// Build index for random frame access (avoids reading entire file)
build_frame_index(content, format): FrameIndex[]

// FrameIndex contains byte offsets for fast seeking
interface FrameIndex {
  byte_offset: number
  estimated_size: number
}
```

## Components

| Component | Description |
|-----------|-------------|
| `Trajectory.svelte` | Main trajectory player with animation controls |
| `TrajectoryInfoPane.svelte` | Frame count, duration, and property metadata |
| `TrajectoryExportPane.svelte` | Export individual frames or sub-ranges |
| `TrajectoryError.svelte` | Error display for invalid trajectories |

## Playback Controls

- **Play/Pause** — animate through frames
- **Frame slider** — scrub to any frame
- **FPS control** — adjustable playback speed
- **Step forward/backward** — single frame advance
- **Loop mode** — continuous playback

## Visualization Modes

The trajectory viewer can display alongside analysis plots:

- **Structure + Scatter** — 3D structure with per-frame property scatter plot
- **Structure + Histogram** — 3D structure with property distribution histogram

Properties that can be plotted:
- Energy per frame
- Forces (max, mean)
- Temperature
- Stress/pressure
- Custom per-frame properties (from EXTXYZ)

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `trajectory_fps` | number | 10 | Playback speed (frames per second) |
| `trajectory_auto_play` | boolean | false | Start playing on load |
| `trajectory_display_mode` | string | "structure" | Display layout mode |

## Performance

- **Frame indexing** enables random access into GB-scale trajectory files
- Binary formats (`.traj`, `.h5`) are more memory-efficient than text (`.xyz`)
- Lazy decompression for gzip-compressed trajectories
- Only the current frame's atom positions are sent to the GPU
