---
title: COHP Analysis Tutorial
description: How to analyze crystal orbital Hamilton populations in CatGO
source: src/lib/electronic/CohpPlot.svelte
---

# COHP Analysis Tutorial

Learn how to visualize and interpret COHP (Crystal Orbital Hamilton Population) data for chemical bonding analysis.

## Prerequisites

- LOBSTER calculation output files
- COHPCAR.lobster or equivalent data

## Step 1: Load COHP Data

Upload COHP data files through the Electronic Analysis pane.

### Supported Formats

- LOBSTER: `COHPCAR.lobster`
- JSON: Pre-processed COHP data

## Step 2: Select Bond Pairs

Choose atom pairs to analyze their bonding/antibonding interactions.

### Pair Selection

Select specific atom pairs from the structure viewer or from the dropdown list.

## Step 3: Interpret the Plot

### Bonding vs Antibonding

- Negative COHP (right side): bonding interactions
- Positive COHP (left side): antibonding interactions

### Integrated COHP (ICOHP)

The integrated COHP values quantify bond strength. More negative = stronger bonding.

## Step 4: Export

Export plots and data for publication or further analysis.

## Related

- [Band Structure](/tutorials/electronic/band-structure) — Electronic structure visualization
- [COHP Module](/modules/electronic/cohp) — API reference
