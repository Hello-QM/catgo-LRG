---
title: RDF Analysis Tutorial
description: How to compute and visualize radial distribution functions from MD trajectories
source: src/lib/rdf/RdfPlot.svelte
---

# RDF Analysis Tutorial

Learn how to compute radial distribution functions (RDF) from molecular dynamics trajectories.

## Prerequisites

- An MD trajectory file (.extxyz, .traj, .hdf5)
- Loaded trajectory in the CatGO viewer

## Step 1: Load a Trajectory

Load your MD trajectory using the file import dialog or drag-and-drop.

## Step 2: Configure RDF Parameters

### Element Pairs

Select which element pairs to compute RDF for (e.g., O-H, Si-O).

### Cutoff Distance

Set the maximum distance for pair counting (typically 8-12 Angstroms).

### Number of Bins

Adjust histogram resolution (default: 200 bins).

## Step 3: Compute and Visualize

Click "Compute RDF" to generate the plot. The calculation runs across all trajectory frames.

### Multi-Frame Averaging

RDF is averaged over selected frames for better statistics.

## Step 4: Interpret Results

### Peak Positions

First peak = nearest neighbor distance. Subsequent peaks reveal coordination shell structure.

### Coordination Numbers

Integrate g(r) to obtain coordination numbers.

## Step 5: Export

Save the plot as SVG/PNG or export raw data as CSV.

## Related

- [RDF Module](/modules/md-analysis/rdf) — API reference
- [Trajectories](/tutorials/visualization/trajectories) — Loading MD trajectories
