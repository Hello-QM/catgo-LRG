---
title: Density Profile
description: Spatial density distribution analysis module
source: src/lib/md/MdDensityPanel.svelte
---

# Density Profile

**Source:** `src/lib/md/MdDensityPanel.svelte`

## Overview

Computes density profiles along cell axes from MD trajectories. Useful for analyzing interfaces, confinement, and layered structures.

## Components

### MdDensityPanel

Interactive panel for density profile computation and visualization.

## Features

### Axis Selection

Compute density along a, b, or c lattice directions.

### Element Filtering

Compute density profiles for specific element types.

### Multi-Frame Averaging

Average density over trajectory frames.

## Server API

**Endpoint:** `POST /api/md/density`

## Related

- [RDF Module](/modules/md-analysis/rdf)
- [Dynamics Module](/modules/md-analysis/dynamics)
