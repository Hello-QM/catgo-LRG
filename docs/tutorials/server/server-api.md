---
title: Server API Tutorial
description: Using CatGO's REST API for programmatic access
source: server/main.py
---

# Server API Tutorial

Learn how to use CatGO's REST API for programmatic access to computation and analysis tools.

## Overview

CatGO's Python server exposes a REST API for running calculations, managing workflows, and accessing analysis tools from external scripts and applications.

## Step 1: Start the Server

```bash
python server/main.py
```

The API is available at `http://localhost:8000` by default.

## Step 2: API Endpoints

### Structure Operations

- `POST /api/structure/parse` — Parse a structure file
- `POST /api/structure/optimize` — Run geometry optimization
- `POST /api/structure/slab` — Generate a slab

### Electronic Analysis

- `POST /api/bands` — Compute/retrieve band structure
- `POST /api/dos` — Compute/retrieve density of states
- `POST /api/cohp` — Compute COHP

### MD Analysis

- `POST /api/md/rdf` — Compute radial distribution function
- `POST /api/md/rmsd` — Compute RMSD
- `POST /api/md/hbonds` — Detect hydrogen bonds
- `POST /api/md/clustering` — Cluster trajectory frames

### Workflow

- `POST /api/workflow/create` — Create a new workflow
- `POST /api/workflow/run` — Execute a workflow
- `GET /api/workflow/{id}` — Get workflow status

## Step 3: Authentication

API authentication details (if applicable) and CORS configuration.

## Related

- [REST API Module](/modules/server/rest-api) — Full API reference
- [MCP Server](/tutorials/server/mcp-server) — MCP protocol integration
