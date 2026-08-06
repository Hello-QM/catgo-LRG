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

## License and citation

CatGo is licensed under AGPL-3.0-or-later. If CatGo contributes to your work,
please include the acknowledgement and preferred citation below. This request
is not an additional condition of the AGPL license.

```
This work used CatGo (https://app.catgo-ucsd.org).
```

Please cite the CatGo article in *Digital Discovery*:
[10.1039/D6DD00273K](https://doi.org/10.1039/D6DD00273K),
and the canonical
[CITATION.cff](https://github.com/Hello-QM/catgo-LRG/blob/main/CITATION.cff).
Third-party materials retain their own terms and are excluded from this license.
