---
title: Density of States
description: Total and projected DOS visualization module
source: src/lib/electronic/DosPlot.svelte
---

# Density of States

**Source:** `src/lib/electronic/DosPlot.svelte`, `src/lib/electronic/DosAnalysisPane.svelte`

## Overview

The DOS module visualizes total and projected density of states from DFT calculations. Supports atom-resolved and orbital-resolved projections.

## Components

### DosPlot

Interactive DOS plotting component.

### DosAnalysisPane

Analysis controls for DOS data.

### DosPlotWindow

Standalone DOS viewer window.

## Data Format

- `energies` — Energy grid relative to Fermi level
- `total_dos` — Total DOS values
- `pdos` — Projected DOS by atom and orbital
- `spin` — Spin channel (up/down for spin-polarized)

## Features

### Projection Types

- Total DOS
- Atom-projected DOS
- Orbital-projected DOS (s, p, d, f)
- Element-projected DOS

### Integration

Interactive integration over energy ranges to compute electron counts.

## Server API

**Endpoint:** `POST /api/dos`

## Related

- [DOS Tutorial](/tutorials/electronic/dos-analysis)
- [Band Structure Module](/modules/electronic/band-structure)
