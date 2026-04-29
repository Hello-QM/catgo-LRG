---
title: Clustering & PCA Tutorial
description: Cluster trajectory frames and perform dimensionality reduction
source: src/lib/md/MdClusteringPanel.svelte
---

# Clustering & PCA Tutorial

Learn how to use clustering and principal component analysis to identify conformational states in MD trajectories.

## Prerequisites

- An MD trajectory loaded in CatGO

## Step 1: Select Features

Choose the structural descriptor for clustering:
- Atomic positions (after alignment)
- Pairwise distances
- Dihedral angles

## Step 2: Run PCA

### Dimensionality Reduction

PCA projects the high-dimensional trajectory data onto principal components.

### Scree Plot

Examine the explained variance to choose the number of components.

## Step 3: Cluster Frames

### Algorithm Selection

Choose clustering method: K-means, DBSCAN, or hierarchical.

### Number of Clusters

For K-means, select the number of clusters (use elbow method for guidance).

## Step 4: Visualize Results

### PCA Scatter Plot

Frames are projected onto PC1 vs PC2, colored by cluster assignment.

### Representative Structures

View the centroid structure of each cluster in the 3D viewer.

## Step 5: Export

Export cluster assignments, PCA coordinates, and representative frames.

## Related

- [Clustering Module](/modules/md-analysis/clustering) — API reference
