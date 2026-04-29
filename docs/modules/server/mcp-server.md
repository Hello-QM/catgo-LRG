---
title: MCP Server
description: Model Context Protocol server for AI assistant integration
source: server/mcp_server.py
---

# MCP Server

**Source:** `server/mcp_server.py`

## Overview

CatGO implements the Model Context Protocol (MCP), allowing external AI assistants (e.g., Claude Desktop) to interact with CatGO's tools for structure analysis, manipulation, and visualization.

## Architecture

The MCP server wraps CatGO's Python server endpoints as MCP-compatible tools, exposing them through the standardized MCP protocol.

## Exposed Tools

### Structure Operations

- Parse structure files
- Query structure properties
- Generate slabs and supercells
- Optimize structures

### Analysis

- Electronic structure (bands, DOS, COHP)
- MD analysis (RDF, RMSD, H-bonds)
- Symmetry detection

### Workflow

- Create and run computational workflows

## Setup

```bash
python server/main.py --mcp
```

## Client Configuration

Add CatGO as an MCP server in your AI client's settings.

## Related

- [MCP Server Tutorial](/tutorials/server/mcp-server)
- [REST API](/modules/server/rest-api)
