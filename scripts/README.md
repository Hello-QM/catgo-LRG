# CatGo Utility Scripts

This directory contains shell and Python scripts for building, setting up, and managing the CatGo project.

## Core Build Scripts

- **`build-backend.sh`**: Compiles the Python backend and its dependencies. Supports platform-specific builds (macOS, Linux, Windows).
- **`build-server.sh`**: Similar to `build-backend.sh`, used for building the standalone computation server.
- **`build-doc-chunks.js`**: A Node.js script that processes documentation and generates chunks for the web app's interactive guides.

## Setup Scripts

- **`setup-claude-code.sh`**: Configures the **Claude Code** CLI for integration with CatGo. Sets up the MCP config (`~/.claude/mcp.json`), global settings, and SessionStart hooks.
- **`catgo-session-start.sh`**: A hook script called by Claude Code to ensure the CatGo backend is running and to provide initial context.

## Maintenance & Generation

- **`generate-icons.js`**: Generates application icons from source SVG files. Used by the Tauri desktop build.
- **`generate-frontend-tools.ts`**: (TypeScript) Generates frontend TypeScript tool definitions from the Python backend's tool registry. Ensures type safety between frontend and backend tools.

## Scientific Processing

- **`cp2k_dos.py`**: Parser and processor for CP2K density of states (DOS) outputs.
- **`parse_gaussian.py`**: Utility for parsing Gaussian output files.

## Testing & CI

- **`test_phase0.py`**: A validation script for testing the initial phase of backend tool integration.
- **`test_vasp.py`** (in `server/`): Tests VASP I/O and result parsing.

## Usage

Most scripts are meant to be called through `pnpm` scripts (defined in `package.json`) rather than directly.

Example:
```bash
pnpm tauri:icons  # Calls node scripts/generate-icons.js
pnpm backend:build # Calls bash scripts/build-backend.sh
```
