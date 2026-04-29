---
title: Module Reference
description: API documentation for all CatGO modules
---

# Module Reference

Complete reference documentation for all CatGO modules, organized by category.

## Core

| Module | Description |
|--------|-------------|
| [Structure Viewer](/modules/core/structure-viewer) | 3D interactive visualization of atoms, bonds, and lattices |
| [File I/O](/modules/core/file-io) | Parse and export crystal/molecular structure files |
| [Lattice & Cell](/modules/core/lattice-cell) | Lattice parameters, coordinate transforms, cell operations |
| [Bonding](/modules/core/bonding) | Bond detection, editing, and coordination analysis |
| [Settings](/modules/core/settings) | Configurable properties across platforms |

## Crystallography

| Module | Description |
|--------|-------------|
| [Surfaces & Slabs](/modules/crystallography/surfaces-slabs) | Miller index slab generation, vacuum layers, adsorption sites |
| [Symmetry](/modules/crystallography/symmetry) | Space group detection, Wyckoff positions, Bravais lattices |
| [Supercells](/modules/crystallography/supercells) | Periodic cell expansion and transformation |

## Electronic Structure

| Module | Description |
|--------|-------------|
| [Band Structure](/modules/electronic/band-structure) | Electronic band structure plotting and analysis |
| [Density of States](/modules/electronic/dos) | Total and projected DOS visualization |
| [COHP](/modules/electronic/cohp) | Crystal orbital Hamilton populations |

## MD Analysis

| Module | Description |
|--------|-------------|
| [Radial Distribution](/modules/md-analysis/rdf) | Radial distribution functions |
| [Dynamics (RMSD/RMSF)](/modules/md-analysis/dynamics) | Structural deviation metrics |
| [Density Profile](/modules/md-analysis/density-profile) | Spatial density distributions |
| [Hydrogen Bonds](/modules/md-analysis/hbonds) | H-bond detection and analysis |
| [Clustering & PCA](/modules/md-analysis/clustering) | Trajectory clustering and dimensionality reduction |

## Dynamics & Optimization

| Module | Description |
|--------|-------------|
| [Trajectories](/modules/dynamics/trajectories) | MD trajectory playback and streaming |
| [Optimization](/modules/dynamics/optimization) | Structure relaxation with multiple calculators |

## Analysis & Spectroscopy

| Module | Description |
|--------|-------------|
| [Spectroscopy](/modules/analysis/spectroscopy) | XRD, RDF, band structure, density of states |
| [Phase Diagrams](/modules/analysis/phase-diagrams) | Thermodynamic stability and convex hulls |
| [Composition](/modules/analysis/composition) | Chemical formula handling and composition charts |
| [Periodic Table](/modules/analysis/periodic-table) | Interactive element explorer with property data |

## Workflow

| Module | Description |
|--------|-------------|
| [Workflow Engine](/modules/workflow/workflow-engine) | Visual workflow builder and execution engine |
| [Node Types](/modules/workflow/node-types) | Catalog of 70+ workflow node types |
| [Job Scripts](/modules/workflow/job-scripts) | HPC job script generation (SLURM, PBS) |
| [Project Dashboard](/modules/workflow/project-dashboard) | Project management and results visualization |

## AI & Language

| Module | Description |
|--------|-------------|
| [Chat System](/modules/ai/chat-system) | AI assistant architecture and LLM integration |
| [Workflow Tools](/modules/ai/workflow-tools) | AI-accessible workflow creation tools |
| [Literature Import](/modules/ai/literature-import) | Paper parsing and workflow generation |

## Interaction

| Module | Description |
|--------|-------------|
| [Gesture Tracking](/modules/interaction/gesture-tracking) | MediaPipe hand tracking integration |
| [Voice Control](/modules/interaction/voice-control) | Speech-to-text and voice commands |
| [Atom Art](/modules/interaction/atom-art) | Voice-driven atom placement |

## Integrations

| Module | Description |
|--------|-------------|
| [Density Visualization](/modules/integrations/density-visualization) | CUBE file isosurfaces and slice planes |
| [Database Integration](/modules/integrations/database-integration) | OPTIMADE, Materials Project, PubChem search |

## Server

| Module | Description |
|--------|-------------|
| [MCP Server](/modules/server/mcp-server) | Model Context Protocol server |
| [REST API](/modules/server/rest-api) | HTTP API for programmatic access |
