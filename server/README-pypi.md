# CatGo

**AI-driven workbench for computational materials science** — a 3D
structure/trajectory viewer + workflow engine, installable straight from PyPI.

```bash
pip install catgo      # or:  uv pip install catgo
catgo                  # launches the app and opens it in your browser
```

## Commands

| Command | What it does |
|---|---|
| `catgo` | Start the backend and open the CatGo UI in a browser |
| `catgo app` / `catgo web` | Same as bare `catgo` (`--no-browser` to skip opening one) |
| `catgo view POSCAR CONTCAR …` | Open structure/trajectory file(s) in the viewer (like `ase gui`) |
| `catgo serve` | Run the API/backend only (no browser) |
| `catgo shell` | Interactive REPL |
| `catgo setup` | Register the CatGo MCP server for Claude Code |

The web UI is bundled in the wheel and served same-origin by the local backend
(default `http://localhost:8000`), so it works offline after install.

## Optional extras

```bash
pip install "catgo[analyze]"   # DOS/band/COHP plotting (matplotlib, scienceplots)
pip install "catgo[ml]"        # MACE ML potentials
pip install "catgo[full]"      # mdtraj, h5py, scikit-learn, custodian
```

Prefer the native desktop app (Tauri) for the fastest 3D — see the project
repository. This package is the Python/CLI + web-UI distribution.

License: AGPL-3.0-or-later.
