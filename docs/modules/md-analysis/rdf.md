---
title: Radial Distribution Function
description: RDF computation and visualization module
source: src/lib/rdf/RdfPlot.svelte
---

# Radial Distribution Function

**Source:** `src/lib/rdf/RdfPlot.svelte`, `src/lib/rdf/calc-rdf.ts`

## Overview

Computes and visualizes radial distribution functions g(r) from structures and MD trajectories. Supports element-pair-specific RDF and multi-frame averaging.

## Components

### RdfPlot

Interactive RDF plot with element pair selection.

## Computation

### Client-Side (calc-rdf.ts)

Fast RDF calculation in the browser using pair counting with periodic boundary conditions.

### Server-Side

`POST /api/md/rdf` — For large trajectories, server-side computation with NumPy acceleration.

## Parameters

- `r_max` — Maximum distance cutoff
- `n_bins` — Number of histogram bins
- `element_pairs` — Which element pairs to compute
- `frame_range` — Which trajectory frames to include

## Features

### Multi-Frame Averaging

Average g(r) across trajectory frames for better statistics.

### Coordination Number

Integration of g(r) to obtain running coordination numbers.

### Peak Analysis

Automatic first-peak detection and nearest-neighbor distance.

## Related

- [RDF Tutorial](/tutorials/md-analysis/rdf-analysis)
- [Dynamics Module](/modules/md-analysis/dynamics)
