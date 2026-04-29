---
title: Node Types
description: Catalog of workflow node types available in CatGO
source: src/lib/workflow/node-definitions.ts
---

# Workflow Node Types

**Source:** `src/lib/workflow/node-definitions.ts`

## Overview

CatGO's workflow engine provides 70+ node types for building computational materials science workflows. Nodes are categorized by function.

## Structure Nodes

### Structure Input
Load structures from files, databases, or manual input.

### Structure Transform
Supercell generation, slab cutting, coordinate transformation.

### Structure Filter
Filter structures by composition, symmetry, or properties.

## Calculation Nodes

### DFT Setup
Configure DFT calculations (VASP, QE, CP2K).

### ML Potential
Run calculations with machine learning potentials (MACE, CHGNet, M3GNet).

### Optimization
Geometry relaxation with configurable calculators.

### Molecular Dynamics
MD simulation configuration and execution.

## Analysis Nodes

### Electronic Structure
Band structure, DOS, COHP computation.

### Property Calculation
Energy, forces, stress, band gap, magnetic moments.

### Thermodynamics
Phase stability, formation energy, convex hull.

## I/O Nodes

### File Reader
Read various input file formats.

### File Writer
Write output in configurable formats.

### Database Query
Search OPTIMADE, Materials Project, PubChem.

## Control Flow Nodes

### Loop
Iterate over parameter ranges or structure lists.

### Conditional
Branch based on computed properties.

### Aggregator
Collect results from parallel branches.

## Related

- [Workflow Engine](/modules/workflow/workflow-engine)
- [Job Scripts](/modules/workflow/job-scripts)
- [Workflows Tutorial](/tutorials/workflows/workflows)
