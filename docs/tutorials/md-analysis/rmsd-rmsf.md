---
title: RMSD & RMSF Tutorial
description: Compute structural deviation metrics from MD trajectories
source: src/lib/md/MdDynamicsPanel.svelte
---

# RMSD & RMSF Tutorial

Learn how to compute root-mean-square deviation (RMSD) and root-mean-square fluctuation (RMSF) from molecular dynamics trajectories.

## Prerequisites

- An MD trajectory loaded in CatGO

## Step 1: Open MD Analysis

Navigate to the MD Analysis pane from the sidebar.

## Step 2: Compute RMSD

### Reference Frame

Select the reference frame (default: first frame) for RMSD calculation.

### Atom Selection

Choose which atoms to include (all atoms, backbone only, or custom selection).

### Results

The RMSD time series shows structural drift from the reference. Equilibrated systems show a plateau.

## Step 3: Compute RMSF

### Per-Atom Fluctuations

RMSF shows the average displacement of each atom over the trajectory.

### Visualization

RMSF values can be mapped to atom colors or sizes in the 3D viewer.

## Step 4: Export

Export time series data or per-atom RMSF values.

## Related

- [Dynamics Module](/modules/md-analysis/dynamics) — API reference
- [Trajectory Playback](/tutorials/visualization/trajectories) — Loading trajectories
