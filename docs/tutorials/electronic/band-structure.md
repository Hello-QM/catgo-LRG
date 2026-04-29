---
title: Band Structure Tutorial
description: How to plot and analyze electronic band structures in CatGO
source: src/lib/electronic/BandPlot.svelte
---

# Band Structure Tutorial

Learn how to visualize and analyze electronic band structures from DFT calculations.

## Prerequisites

- A completed DFT band structure calculation (VASP, Quantum ESPRESSO, etc.)
- Output files: vasprun.xml, EIGENVAL, or HDF5 band data

## Step 1: Load Band Data

Upload your band structure data through the Electronic Analysis pane.

### Supported Formats

- VASP: `vasprun.xml`, `EIGENVAL`
- HDF5: `.h5` files with band data arrays
- JSON: Pre-processed band structure JSON

## Step 2: Configure the Plot

### Setting the Fermi Level

The Fermi level is automatically detected from the calculation output. You can manually adjust it in the settings panel.

### High-Symmetry Points

CatGO automatically labels high-symmetry points along the k-path. Custom labels can be set via the k-point configuration.

## Step 3: Analyze Features

### Band Gap Detection

The band gap (direct or indirect) is automatically calculated and displayed.

### Orbital Projections

Enable orbital character overlay to see s, p, d contributions as colored fat bands.

### D-Band Analysis

For transition metals, the d-band center and width are computed automatically.

## Step 4: Export

Export the plot as SVG, PNG, or save the processed data as JSON for further analysis.

## Related

- [DOS Analysis](/tutorials/electronic/dos-analysis) — Complement band structure with density of states
- [COHP Analysis](/tutorials/electronic/cohp-analysis) — Bonding analysis from electronic structure
- [Band Structure Module](/modules/electronic/band-structure) — API reference
