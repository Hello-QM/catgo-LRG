---
title: Hydrogen Bond Detection Tutorial
description: Detect and analyze hydrogen bonds in MD trajectories
source: src/lib/md/MdHbondsPanel.svelte
---

# Hydrogen Bond Detection Tutorial

Learn how to detect and analyze hydrogen bonds across MD trajectory frames.

## Prerequisites

- An MD trajectory with hydrogen atoms

## Step 1: Configure Detection Criteria

### Geometric Criteria

- **D-A distance cutoff:** Maximum donor-acceptor distance (default: 3.5 A)
- **D-H-A angle cutoff:** Minimum angle (default: 120 degrees)

### Donor/Acceptor Elements

Select which elements act as donors and acceptors.

## Step 2: Run Detection

Hydrogen bonds are detected frame-by-frame across the trajectory.

## Step 3: Analyze Results

### H-Bond Count Time Series

Track how the number of hydrogen bonds evolves over time.

### H-Bond Lifetime

Compute autocorrelation functions to determine H-bond lifetimes.

### Donor-Acceptor Pairs

Identify the most common H-bond pairs.

## Step 4: Visualize

H-bonds can be overlaid on the 3D structure view as dashed lines.

## Related

- [H-Bonds Module](/modules/md-analysis/hbonds) — API reference
