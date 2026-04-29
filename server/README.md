# CatGo Compute Server

FastAPI Python backend providing materials science computation, structure manipulation, and AI agent integration (MCP).

## Core Architecture

### 1. Tool-First System
The backend implements a unified **Tool-First** architecture. Every capability (readers, calculators, optimizers, analysis) is registered as a `TOOL`.
- **Registry**: `server/tools/registry.py` manages all available tools.
- **Discovery**: `server/tools/discovery.py` automatically loads tools from `server/tools/builtin/`, `plugins/`, and `~/.catgo/tools/`.
- **Execution**: Tools can be executed via REST API or through AI agents using the Model Context Protocol (MCP).

### 2. Dual MCP Servers
- **Main MCP Server (`server/mcp_tools/server.py`)**: Provides 50+ granular tools for the built-in AI chat interface.
- **Claude Code MCP (`server/mcp_tools/server_claude_code.py`)**: A lightweight version with 5 "merged" tools (catgo_structure, catgo_fetch, etc.) optimized for the Claude Code CLI.

### 3. Key Routers & Capabilities
The backend is modularized into several routers (see `server/routers/`):
- **Structure Ops**: Atomic manipulation (add, delete, move, replace).
- **Optimization**: MACE, CHGNet, M3GNet, and EMT calculators.
- **Symmetry**: Integration with `moyo` (spglib) for space group analysis.
- **Simulation**: Input generation for VASP, QE, LAMMPS, CP2K, ORCA.
- **Analysis**: DOS, Bands, COHP, RDF, RMSD, Clustering, etc.
- **External Data**: Fetching from Materials Project, OPTIMADE, and PubChem.
- **HPC**: SSH management and job submission to clusters.

## Quick Start

### 1. Environment Setup (Conda)
```bash
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt
```

### 2. Start Backend
```bash
# Standard start
python server/main.py

# Or via pnpm from project root
pnpm desktop:serve
```
The server runs at `http://localhost:8000` (or 8001+ if in a worktree).

## Development

### Adding a New Tool
1. Create a directory in `plugins/` or `server/tools/builtin/`.
2. Add a `tool.py` defining a `TOOL` dictionary and an `async def execute(context)` function.
3. The server will automatically discover and register it on startup.

### API Documentation
Once running, visit `http://localhost:8000/docs` for the interactive Swagger UI.

## Implementation Details & Pitfalls

See `server/CLAUDE.md` for a detailed log of architectural decisions, bug fixes, and platform-specific (Windows/Linux) "lessons learned".
