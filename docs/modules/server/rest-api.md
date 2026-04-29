---
title: REST API
description: HTTP API reference for programmatic access to CatGO
source: server/main.py
---

# REST API

**Source:** `server/main.py`

## Overview

CatGO's Python server provides a REST API built with FastAPI for programmatic access to all computation and analysis features.

## Base URL

`http://localhost:8000/api`

## Endpoints

### Structure

| Method | Path | Description |
|--------|------|-------------|
| POST | `/structure/parse` | Parse a structure file |
| POST | `/structure/optimize` | Run geometry optimization |
| POST | `/structure/slab` | Generate a slab |

### Electronic

| Method | Path | Description |
|--------|------|-------------|
| POST | `/bands` | Band structure computation |
| POST | `/dos` | Density of states |
| POST | `/cohp` | COHP analysis |

### MD Analysis

| Method | Path | Description |
|--------|------|-------------|
| POST | `/md/rdf` | Radial distribution function |
| POST | `/md/rmsd` | RMSD computation |
| POST | `/md/density` | Density profile |
| POST | `/md/hbonds` | H-bond detection |
| POST | `/md/clustering` | Clustering & PCA |

### Workflow

| Method | Path | Description |
|--------|------|-------------|
| POST | `/workflow/create` | Create workflow |
| POST | `/workflow/run` | Execute workflow |
| GET | `/workflow/{id}` | Get workflow status |

### HPC

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hpc/submit` | Submit HPC job |
| GET | `/hpc/status` | Check job status |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | Single-turn chat |
| POST | `/chat/multi` | Multi-turn conversation |

### Paper

| Method | Path | Description |
|--------|------|-------------|
| POST | `/paper/upload` | Upload PDF |
| POST | `/paper/extract` | Extract parameters |
| POST | `/paper/workflow` | Generate workflow |

## Authentication

Currently no authentication required for local server. Configure CORS in `server/main.py`.

## Related

- [Server API Tutorial](/tutorials/server/server-api)
- [MCP Server](/modules/server/mcp-server)
