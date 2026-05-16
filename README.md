# CatGO

An AI-agent-driven workbench for computational materials science and catalysis. CatGO collapses the usual chain of disconnected tools and hand-written input decks into one agent-driven environment: structure building and visualization, DFT/MD workflow setup, HPC job submission, and analysis.

## Quick links

| | |
|---|---|
| **Web app** (try instantly, no install) | <https://app.catgo-ucsd.org> |
| **Tutorial / Docs** | <https://docs.catgo-ucsd.org> |
| **Source** | <https://github.com/Hello-QM/catgo-LRG> |
| **Downloads** | <https://github.com/Hello-QM/catgo-LRG/releases> |

## Web version — frontend only

<https://app.catgo-ucsd.org> is a hosted static single-page app (SvelteKit `adapter-static`). It runs **frontend features only**: structure viewing, editing, and 3D visualization in the browser, with zero install.

It does **not** include the backend: no DFT/MD execution, no HPC job submission, and no AI-agent task execution. Those require the desktop app or the IDE extension, which bundle the backend and an integrated shell. Use the web app to inspect and edit structures; use a full edition to run real work.

## Editions

Prebuilt artifacts are published on [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases):

- **Desktop app** — Tauri build, bundled backend + agent + shell.
- **IDE extension** — a cross-platform `.vsix` (Windows / macOS / Linux). Installs in **VS Code, Cursor, and other VS Code-compatible IDEs**, bringing the full CatGO workbench (including the bundled backend and shell) inside your editor.
- **Linux server binary** — headless backend for remote/HPC hosts.
- **HPC bundle** — for cluster deployment.

## Built-in shell

The desktop app and the IDE extension ship with an **integrated shell**. You can drive jobs, inspect outputs, and move files without leaving CatGO.

In the shell, **Ctrl + click** a structure file path (POSCAR, CIF, XYZ, extxyz, trajectory, …) to open it directly in the 3D viewer — no manual upload step.

## License

AGPL-3.0. See the source repository for details.
