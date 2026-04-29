# Density Visualization

Visualize volumetric data from CUBE files with 3D isosurfaces and 2D slice planes.

**Source:** `src/lib/cube/`

## Overview

The density visualization module reads Gaussian/VASP CUBE files containing volumetric data (electron density, molecular orbitals, electrostatic potential) and renders them as interactive 3D isosurfaces or 2D cross-section planes overlaid on the atomic structure.

## Components

| Component | Description |
|-----------|-------------|
| `CubeViewer.svelte` | Main cube data viewer |
| `CubeScene.svelte` | Three.js scene for 3D density rendering |
| `CubeControls.svelte` | Isosurface threshold, opacity, color, and slice controls |
| `IsosurfaceMesh.svelte` | Renders the 3D isosurface mesh |
| `SlicePlane.svelte` | 2D cross-section plane through the data |

## Key Functions

```typescript
// Parse CUBE file format
parse_cube_file(content: string): CubeData

// Generate isosurface mesh at a given threshold
compute_isosurface(cube_data, isovalue): IsosurfaceMesh

// Extract 2D cross-section
create_slice_plane(cube_data, plane_origin, plane_normal): SliceData
```

## CUBE File Format

The CUBE format contains:
- Atomic positions and elements
- 3D grid dimensions (nx, ny, nz)
- Volumetric data on the grid (one value per grid point)
- Origin and axis vectors defining the grid in space

## Features

- **Isosurface rendering** — 3D surface at constant value (e.g., electron density = 0.05)
- **Adjustable threshold** — slider to change isosurface value
- **Dual surfaces** — show both positive and negative lobes (e.g., for orbitals)
- **Opacity control** — transparent to opaque isosurfaces
- **Color control** — customizable surface colors
- **Slice planes** — 2D color-mapped cross-sections through the data
- **Overlay on structure** — isosurfaces rendered alongside atoms and bonds

## Integration

The `CubePanel.svelte` component in the structure viewer integrates density visualization directly into the main structure viewer, allowing simultaneous display of atomic structure and volumetric data.

## Server API

The Python server provides additional CUBE file processing:

```
GET  /api/cube/parse     — Parse CUBE file on server
POST /api/cube/process   — Process volumetric data
```
