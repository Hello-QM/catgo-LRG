---
title: Literature Import
description: Paper parsing and workflow generation from scientific literature
source: server/routers/paper.py
---

# Literature Import

**Source:** `server/routers/paper.py`, `server/models/paper.py`

## Overview

The literature import module uses AI to parse scientific papers (PDFs) and extract computational parameters, structures, and methodology to generate ready-to-run workflows.

## Pipeline

### 1. PDF Parsing

Extract text and figures from uploaded PDFs.

### 2. Parameter Extraction

AI-driven extraction of:
- DFT parameters (functional, basis set, k-points, cutoff)
- Structure information (compositions, space groups, lattice parameters)
- Calculation workflow (relaxation, single-point, MD, etc.)

### 3. Workflow Generation

Convert extracted parameters into a CatGO workflow graph.

## Server API

**Endpoints:**
- `POST /api/paper/upload` — Upload a PDF
- `POST /api/paper/extract` — Extract parameters
- `POST /api/paper/workflow` — Generate workflow

## Data Model

### Paper

- `title` — Paper title
- `authors` — Author list
- `parameters` — Extracted computational parameters
- `structures` — Extracted structure information

## Related

- [Literature Import Tutorial](/tutorials/ai/literature-import)
- [Workflow Engine](/modules/workflow/workflow-engine)
