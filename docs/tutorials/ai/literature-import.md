---
title: Literature Import Tutorial
description: Import papers and generate workflows from scientific literature
source: server/routers/paper.py
---

# Literature Import Tutorial

Learn how to import scientific papers and automatically generate computational workflows from published methods.

## Overview

CatGO's literature import system can parse scientific papers (PDF) and extract computational parameters to create ready-to-run workflows.

## Step 1: Upload a Paper

Upload a PDF of a scientific paper through the import dialog.

## Step 2: AI Extraction

The system uses AI to extract:
- Computational methods and parameters
- Structure information (compositions, space groups)
- Calculation settings (functionals, k-points, cutoffs)

## Step 3: Review Extracted Data

Review and edit the extracted parameters before workflow generation.

## Step 4: Generate Workflow

The system creates a workflow graph with appropriate nodes and settings based on the paper's methodology.

## Step 5: Run or Modify

Execute the generated workflow directly or modify it in the workflow editor.

## Related

- [Literature Import Module](/modules/ai/literature-import) — API reference
- [Workflows Tutorial](/tutorials/workflows/workflows) — Manual workflow creation
