# Building Surface Slabs

This tutorial walks through generating surface slabs from bulk crystals using the Miller index slab cutter.

## Prerequisites

Load a bulk crystal structure (e.g., a CIF file for FCC Cu, BCC Fe, or a perovskite). The slab cutter works on periodic structures with a defined lattice.

## Opening the Slab Cutter

Click the **Slab** button in the toolbar (scissors icon) to open the **Miller Slab Cutter Pane**. This panel provides controls for:

- Miller indices (h, k, l)
- Slab thickness
- Vacuum layer thickness

## Step 1: Set Miller Indices

Enter the desired Miller indices to define the surface orientation:

| Surface | Miller Indices | Description |
|---------|---------------|-------------|
| (001) | h=0, k=0, l=1 | Top face of cubic cell |
| (110) | h=1, k=1, l=0 | Diagonal face |
| (111) | h=1, k=1, l=1 | Body diagonal face (close-packed for FCC) |

Miller indices are automatically normalized (divided by GCD). At least one index must be non-zero.

## Step 2: Adjust Thickness and Vacuum

- **Thickness** — Minimum slab thickness in Angstroms. Controls how many atomic layers are included.
- **Vacuum** — Vacuum layer thickness in Angstroms. Separates periodic images of the slab for surface calculations.

Typical values:
- Slab thickness: 8-15 Angstroms (3-6 layers depending on material)
- Vacuum: 10-20 Angstroms (enough to prevent interaction between periodic images)

## Step 3: Preview the Cut

As you adjust the Miller indices, a **cutting plane visualizer** overlays translucent planes on the structure showing where the surface cuts the crystal. Atoms above and below the cutting planes fade in/out to preview which atoms will be included.

The preview runs in JavaScript for fast, real-time feedback.

## Step 4: Apply the Slab

Click **Apply** to generate the final slab. This uses the Rust/WASM backend for accurate slab generation:

1. The bulk lattice is rotated so the surface normal aligns with the z-axis
2. Atoms are replicated to fill the desired thickness
3. A vacuum layer is added along the c-direction
4. The lattice is enforced to be right-handed: (a x b) . z > 0
5. The camera automatically resets to align with the new lattice

## Conventions

- The slab's **a** and **b** vectors lie in the surface plane
- The **c** vector points along the surface normal (perpendicular to the slab)
- Right-handedness is always enforced — if the rotation matrix produces a left-handed lattice, the b-vector is negated and fractional coordinates are adjusted

## After Cutting: Common Next Steps

### Add Vacuum

If you need to adjust the vacuum after cutting, use the **Vacuum Box** modal (available from the toolbar) to add vacuum in any direction.

### Build a Supercell

Use the **Supercell** selector to expand the slab laterally (e.g., 2x2x1 for a larger surface area).

### Find Adsorption Sites

Open the **Adsorption Sites** pane to find high-symmetry sites on the surface:

- **Atop** — directly above a surface atom
- **Bridge** — between two surface atoms
- **Hollow** — above the center of 3+ surface atoms

Sites are placed at covalent radius distance from the surface and can be used as starting positions for adsorbate molecules.

### Freeze Bottom Layers

Select atoms in the bottom layers and mark them as **frozen** for subsequent optimization. This mimics the bulk-like constraint used in surface DFT calculations.

## Two Code Paths

The slab cutter uses two implementations:

| Path | Used For | Speed | Accuracy |
|------|----------|-------|----------|
| **JavaScript** (preview) | Real-time visualization while adjusting parameters | Fast | Approximate |
| **Rust/WASM** (apply) | Final slab generation | Slower | Exact |

The preview path runs `generate_slab_pipeline()` in TypeScript for immediate feedback. The apply path calls `wasm_generate_slab()` for the final result.

## Troubleshooting

**Slab looks flipped or mirrored**
The slab cutter enforces right-handedness. If the initial rotation produces a left-handed lattice, vectors are corrected automatically. If the structure still looks wrong, try resetting the camera with **R**.

**Too few/many layers**
The thickness parameter is a minimum — the actual slab may be slightly thicker to include complete layers. Adjust the thickness value to add or remove layers.

**No cutting planes visible**
Ensure the structure has a defined lattice (periodic boundary conditions). The slab cutter does not work on isolated molecules.
