---
title: COHP
description: Crystal orbital Hamilton population analysis module
source: src/lib/electronic/CohpPlot.svelte
---

# COHP

**Source:** `src/lib/electronic/CohpPlot.svelte`, `src/lib/electronic/CohpAnalysisPane.svelte`

## Overview

The COHP module visualizes Crystal Orbital Hamilton Population data for chemical bonding analysis. COHP decomposes the band structure energy into bonding and antibonding contributions for specific atom pairs.

## Components

### CohpPlot

Interactive COHP plotting component with bonding/antibonding regions.

### CohpAnalysisPane

Controls for selecting atom pairs and analysis options.

## Data Format

- `energies` — Energy grid
- `cohp_data` — COHP values per atom pair
- `icohp` — Integrated COHP values
- `atom_pairs` — List of atom pair indices

## Features

### Bond Pair Selection

Select specific atom pairs for COHP visualization.

### Integrated COHP (ICOHP)

Quantitative bond strength metric from integration of COHP curves.

### Multi-Pair Comparison

Compare bonding interactions across multiple atom pairs.

## Server API

**Endpoint:** `POST /api/cohp`

## Related

- [COHP Tutorial](/tutorials/electronic/cohp-analysis)
- [Band Structure Module](/modules/electronic/band-structure)
