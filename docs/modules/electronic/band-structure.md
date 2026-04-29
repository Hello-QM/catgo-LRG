---
title: Band Structure
description: Electronic band structure plotting and analysis module
source: src/lib/electronic/BandPlot.svelte
---

# Band Structure

**Source:** `src/lib/electronic/BandPlot.svelte`, `src/lib/electronic/BandAnalysisPane.svelte`

## Overview

The band structure module provides interactive visualization of electronic band structures from DFT calculations. It supports spin-polarized bands, orbital projections (fat bands), and automatic band gap detection.

## Components

### BandPlot

The main plotting component renders band structure data as an interactive D3 chart.

**Props:**
- `band_data` — Band structure data object
- `fermi_energy` — Fermi level in eV
- `show_projections` — Enable orbital projection overlay

### BandAnalysisPane

Side panel for band structure analysis controls and results.

## Data Format

### Band Data Structure

Band structure data follows the format:
- `kpoints` — Array of k-point coordinates
- `distances` — Cumulative k-path distances
- `bands` — 2D array of eigenvalues [band_index][k_index]
- `labels` — High-symmetry point labels and positions
- `projections` — Optional orbital character data

## Features

### Orbital Projections (Fat Bands)

Overlay orbital character (s, p, d, f) as colored band widths.

### D-Band Analysis

Automatic d-band center and width calculation for transition metals.

### Band Gap Detection

Automatic identification of direct/indirect band gaps.

## Server API

**Endpoint:** `POST /api/bands`

Processes raw DFT output into band structure data format.

## Related

- [Band Structure Tutorial](/tutorials/electronic/band-structure)
- [DOS Module](/modules/electronic/dos)
- [COHP Module](/modules/electronic/cohp)
