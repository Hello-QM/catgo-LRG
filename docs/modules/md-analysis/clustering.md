---
title: Clustering & PCA
description: Trajectory clustering and dimensionality reduction module
source: src/lib/md/MdClusteringPanel.svelte
---

# Clustering & PCA

**Source:** `src/lib/md/MdClusteringPanel.svelte`

## Overview

Clusters MD trajectory frames based on structural similarity and performs PCA for dimensionality reduction. Identifies distinct conformational states.

## Components

### MdClusteringPanel

Interactive panel for clustering and PCA configuration.

## Algorithms

### K-Means

Partition frames into k clusters based on structural descriptors.

### DBSCAN

Density-based clustering that automatically determines the number of clusters.

### Hierarchical

Agglomerative clustering with dendrogram visualization.

## PCA

### Principal Component Analysis

Projects high-dimensional trajectory data onto orthogonal components capturing maximum variance.

### Visualization

2D scatter plot of frames in PC1-PC2 space, colored by cluster assignment.

## Server API

**Endpoint:** `POST /api/md/clustering`

## Related

- [Clustering Tutorial](/tutorials/md-analysis/clustering-pca)
- [Dynamics Module](/modules/md-analysis/dynamics)
