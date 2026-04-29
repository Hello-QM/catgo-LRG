# Density Visualization (CUBE Files)

This tutorial covers loading Gaussian CUBE files and visualizing electron density, molecular orbitals, and other volumetric data.

## What Are CUBE Files?

CUBE files (`.cube`) contain 3D volumetric data mapped onto a grid, commonly produced by:

- **Gaussian** — Electron density, molecular orbitals, electrostatic potential
- **VASP** (converted) — Charge density (CHGCAR), local potential (LOCPOT)
- **Quantum ESPRESSO** — Charge density, wavefunctions
- **CP2K** — Electron density, spin density

Each CUBE file contains:
- Atomic positions and elements
- A 3D grid of scalar values (density, potential, orbital amplitude, etc.)

## Loading a CUBE File

Drag and drop a `.cube` file onto the viewer, or use the file picker. CatGO automatically detects the CUBE format and enables the density visualization panel.

## Isosurface Rendering

The primary visualization mode is **isosurface rendering** — a 3D surface connecting all points with the same scalar value.

### Adjusting the Isovalue

Use the **Isovalue** slider in the CUBE panel to set the threshold:

- **Higher values** — Smaller, tighter surfaces (core electron density, bonding regions)
- **Lower values** — Larger, diffuse surfaces (valence electrons, weak interactions)

For molecular orbitals, you typically want to show both positive and negative lobes:
- Positive isovalue shows one phase (e.g., blue)
- Negative isovalue shows the opposite phase (e.g., red)

### Surface Appearance

| Setting | Description |
|---------|-------------|
| Opacity | Transparency of the isosurface (0 = invisible, 1 = solid) |
| Color | Color for positive/negative isovalues |

## 2D Slice Planes

In addition to 3D isosurfaces, you can view **2D cross-sections** through the volumetric data:

- Select a **slice direction** (along a, b, or c lattice vectors)
- Adjust the **slice position** to move through the data
- The slice displays as a colored plane overlaid on the structure

Slice planes are useful for:
- Seeing how density varies through a crystal
- Identifying bonding character between layers
- Comparing charge density at different positions

## Common Workflows

### Viewing Electron Density

1. Load a CUBE file from a DFT calculation (e.g., total charge density)
2. Set a low isovalue (e.g., 0.01-0.05 e/bohr^3) to see the overall electron cloud
3. Increase the isovalue to focus on core/bonding regions
4. Use slice planes to see density variations through the structure

### Viewing Molecular Orbitals

1. Load a CUBE file for a specific orbital (e.g., HOMO, LUMO)
2. Set a moderate isovalue (e.g., 0.02-0.05)
3. Both positive and negative lobes are rendered in different colors
4. Rotate the structure to see orbital symmetry

### Comparing Structures

Load the CUBE file alongside the structure viewer to correlate volumetric features with atomic positions. The atoms from the CUBE file are displayed in the 3D viewer alongside the isosurface.

## Tips

- **Start with a low isovalue** and increase gradually — it's easier to find features by starting broad.
- **Use slice planes** when isosurfaces are too cluttered or when you need quantitative spatial information.
- **Adjust opacity** to see atoms through the isosurface.
- **Large CUBE files** (fine grids, many atoms) may take a moment to parse and render. CatGO processes the grid data in the browser.
