---
title: MCP Server Tutorial
description: Using CatGo as a Model Context Protocol server
source: server/mcp_server.py
---

# MCP Server Tutorial

Learn how to use CatGo's MCP (Model Context Protocol) server to integrate with AI assistants like Claude.

## Overview

CatGo implements the Model Context Protocol, allowing AI assistants to interact with CatGo's tools for structure analysis, manipulation, and visualization.

## Step 1: Start the Server

```bash
# MCP is exposed automatically at /api/mcp/ — no flag needed.
# Run the backend (or just launch the CatGo desktop app, which bundles it):
python server/main.py
```

## Step 2: Configure Your AI Client

Add CatGo as an MCP server in your AI client's configuration (e.g., Claude Desktop).

Point the client at the URL (no `--mcp`, no Python on the client):

```
http://localhost:8000/api/mcp/
```

## Step 3: Available Tools

The MCP server exposes CatGo's capabilities as tools:

### Structure Tools

- Load and parse structure files
- Query structure properties
- Generate slabs and supercells

### Analysis Tools

- Compute RDF, band structure, DOS
- Run structure optimization
- Detect symmetry

### Workflow Tools

- Create and run computational workflows

## Step 4: Example Interactions

Through an MCP-enabled AI assistant:
- "Load the POSCAR file and show the space group"
- "Generate a (111) slab with 3 layers"
- "Set up a VASP relaxation workflow"

## Related

- [MCP Server Module](/modules/server/mcp-server) — Architecture reference
- [REST API](/tutorials/server/server-api) — Direct HTTP API access
