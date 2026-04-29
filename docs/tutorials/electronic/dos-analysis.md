---
title: DOS Analysis Tutorial
description: How to visualize and analyze density of states in CatGO
source: src/lib/electronic/DosPlot.svelte
---

# DOS Analysis Tutorial

Learn how to plot total and projected density of states from DFT calculations.

## Prerequisites

- Completed DFT calculation with DOS output
- Files: vasprun.xml, DOSCAR, or HDF5 data

## Step 1: Load DOS Data

Upload density of states data through the Electronic Analysis pane.

### Supported Formats

- VASP: `vasprun.xml`, `DOSCAR`
- HDF5: `.h5` files with DOS arrays
- JSON: Pre-processed DOS JSON

## Step 2: Configure the Plot

### Energy Range

Set the energy window relative to the Fermi level.

### Projection Type

Choose between total DOS, atom-projected DOS, or orbital-projected DOS.

### Spin Polarization

For spin-polarized calculations, spin-up and spin-down channels are shown separately.

## Step 3: Analyze Features

### Peak Identification

Hover over peaks to identify contributing orbitals and atoms.

### Integration

Select energy ranges to compute integrated DOS and electron counts.

## Step 4: Export

Export as SVG, PNG, or JSON data.

## Related

- [Band Structure](/tutorials/electronic/band-structure) — Electronic band structure visualization
- [DOS Module](/modules/electronic/dos) — API reference
