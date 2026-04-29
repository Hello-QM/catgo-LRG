---
title: Hydrogen Bonds
description: Hydrogen bond detection and analysis module
source: src/lib/md/MdHbondsPanel.svelte
---

# Hydrogen Bonds

**Source:** `src/lib/md/MdHbondsPanel.svelte`

## Overview

Detects hydrogen bonds using geometric criteria (distance and angle cutoffs) across MD trajectory frames. Provides time-resolved H-bond counts and donor-acceptor pair statistics.

## Components

### MdHbondsPanel

Interactive panel for H-bond detection configuration and results.

## Detection Criteria

### Geometric Parameters

- `d_cutoff` — Maximum donor-acceptor distance (default: 3.5 A)
- `angle_cutoff` — Minimum D-H-A angle (default: 120 degrees)

### Element Configuration

- Donor elements (typically N, O)
- Acceptor elements (typically N, O, F)

## Features

### Time Series

H-bond count vs. frame number.

### Pair Statistics

Most frequent donor-acceptor pairs.

### Lifetime Analysis

H-bond autocorrelation and lifetime estimation.

## Server API

**Endpoint:** `POST /api/md/hbonds`

## Related

- [H-Bond Tutorial](/tutorials/md-analysis/hbond-detection)
- [Dynamics Module](/modules/md-analysis/dynamics)
