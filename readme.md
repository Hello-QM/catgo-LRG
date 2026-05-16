<h1 align="center">
  <img src="desktop/logo.png" alt="CatGo Logo" width="120"><br>
  CatGo
</h1>

<p align="center">
  <strong>AI-driven workbench for computational materials science.</strong>
</p>

<p align="center">
  <a href="readme.zh.md">简体中文</a>
</p>

<p align="center">

[![Tests](https://github.com/Hello-QM/catgo-LRG/actions/workflows/test.yml/badge.svg)](https://github.com/Hello-QM/catgo-LRG/actions/workflows/test.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](license)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.19709425-blue)](https://doi.org/10.5281/zenodo.19709425)

</p>

CatGo is a desktop application that combines an interactive 3D structure viewer, a natural-language AI assistant (**CatBot**), a visual DAG **workflow engine**, and **HPC integration** into a single tool. It is designed for catalysis and surface-science research — building slabs and adsorbates, generating DFT/MD/ML inputs, submitting and monitoring jobs on remote clusters, and post-processing the results — all from one window.

> CatGo draws on **[MatterViz](https://github.com/janosh/matterviz)** by [Janosh Riebesell](https://github.com/janosh) for inspiration: the 3D structure viewer, periodic table, and several core UI components originate from MatterViz, though they have been substantially modified in CatGo. On top of that foundation, CatGo adds the catalysis pipeline, workflow engine, HPC integration, CatBot, and plugin system. We are deeply grateful for the original work.

<p align="center">
  <img src="static/catgo-viewer.png" alt="CatGo 3D structure viewer — Si40Bi4Te8H292C100 with bonds, lattice axes, and composition badges" width="780">
</p>

---

## 🔗 Links

| | |
|---|---|
| **Web app** — try instantly, no install | <https://app.catgo-ucsd.org> |
| **Tutorial / Docs** | <https://docs.catgo-ucsd.org> |
| **Downloads** — prebuilt editions | <https://github.com/Hello-QM/catgo-LRG/releases> |
| **Source** | <https://github.com/Hello-QM/catgo-LRG> |

---

## ✨ Features

| Area | Capability |
|---|---|
| **3D Viewer** | Crystals · molecules · surfaces · trajectories · PBC image atoms · bond rendering across cell boundaries · selectable polyhedra · per-element / per-site colour overrides · light, dark, white, black themes |
| **CatBot** | Natural-language structure operations and workflow authoring via Claude, Codex, Gemini, or OpenAI |
| **Workflow** | DAG editor for chained calculations (opt → SP → DOS / NEB / MD / slow-growth …) with one-click stock-recipe Quick-Build (HER, OER, ORR, NRR, CO₂RR, NEB, slow-growth, DOS) |
| **HPC** | SSH terminal, file browser, job submit and monitor, OTP + jump-host + SOCKS5 |
| **DFT inputs** | Native: VASP, Quantum ESPRESSO, LAMMPS, CP2K, ORCA. CatBot-drafted only (skill text, no workflow node executor): GPAW, ABINIT, SIESTA, DFTB+, Gaussian |
| **ML potentials** | MACE (incl. mace_mp foundation), CHGNet, M3GNet (via matgl) |
| **Other fast calculators** | EMT (effective-medium theory), xTB / GFN-xTB (semi-empirical tight-binding via tblite + xtb-CLI) |
| **Analysis** | DOS / PDOS, band structure, COHP / ICOHP, d-band centre, charge-density cube isosurface, volcano plots, Gibbs free-energy corrections, Bader-charge label overlay (reads pre-computed values from site properties) |
| **Catalysis** | OER / HER / ORR / CO₂RR / NRR pathways, ICONST templates for slow-growth, C–N coupling reaction network |

---

## 🔧 Capabilities in detail

### Build & manipulate structures

- **Interactive editing** — pencil-mode atom drawing (drag from one atom to plant a new one), single-atom add / delete / replace / move via right-click menu, arrow-key / W-S rotation of selected atoms, box selection for multi-atom selection, atom-cluster generation (`add_cluster`) using ASE icosahedral / octahedral / cuboctahedral / FCC / HCP / decahedral geometries plus a small library of metal-oxide clusters (Pt₂O₂, CeO₂ trimer, TiO₂ anatase 8-atom, Al₂O₃ 5-atom)
- **Slab cutting** — Miller-index slab cutter with primitive-cell reduction, layer count + vacuum control, supercell expansion, frozen-layer presets for adsorbate work
- **Adsorbates** — alpha-shape adsorption-site finder (top/bridge/hollow/FCC/HCP), single-molecule placement with bond-length-aware offsets, dual-adsorbate placement for C–N / C–C / N–N coupling at a controlled separation, full water-layer addition via Packmol packing
- **Build tools** (dedicated panes) — lattice transformations (matrix supercell), moiré builder for twisted bilayers, nanotube roller (CNT / BNNT / chiral indices), heterostructure stacker with lattice-matching, substitutional doping (one-off or enumerate-all-configurations), pseudo-hydrogen passivation for dangling bonds, water-layer addition, adsorbate placement
- **Additional builders via CatBot skills** (text-driven, no dedicated UI pane yet) — point defects, intercalation, systematic element substitution, strain

### Inspect & analyse

- **Symmetry** — moyo-driven space-group + Wyckoff-position detection, primitive / conventional cell conversion, symmetry-equivalent site coloring
- **Measurement** — point-to-point distance, three-atom angle, persistent measurement overlay
- **Charge density** — cube-file isosurface rendering (web worker), positive / negative isosurfaces, sliceable orthogonal planes, Bader-charge labels overlaid on atoms
- **Property colouring** — coordination number, Wyckoff orbit, Bader charge, custom user expression; supports element hiding, prop-value filtering, individual site hiding
- **Trajectory playback** — MD / NEB / IRC trajectory frames with timeline scrubbing, per-frame bond connectivity, energy / force / per-atom property overlays, frame export

### Calculations & ML potentials

<p align="center">
  <img src="static/catgo-workflow.png" alt="CatGo visual workflow editor — INPUT / CALCULATION / TOOLS / LOGIC / ANALYSIS palette with a free-energy node on the canvas" width="780">
</p>

- **DFT engines** — natively driven by the workflow executor: VASP, Quantum ESPRESSO, LAMMPS, CP2K, ORCA. CatBot-drafted only via skill text (no workflow node executor yet): GPAW, ABINIT, SIESTA, DFTB+, Gaussian. Native engines support geo_opt / single_point / cell_opt / freq / NEB / TS-search / MD / slow-growth nodes with parameter presets
- **ML potentials** — MACE (incl. mace_mp foundation models), CHGNet, M3GNet (via matgl); geometry optimisation, single-point energy, force evaluation, NEB endpoint refinement, fast pre-screening before DFT
- **Other fast calculators** — EMT (effective-medium theory, ASE built-in), xTB / GFN-xTB (semi-empirical tight-binding DFT via tblite for GFN2/GFN1/IPEA1, via xtb-CLI for GFN0/GFN-FF). Not machine-learning potentials, but used for the same role: cheap pre-screening before DFT
- **Workflow engine** — DAG executor with HPC submission, automatic dependency resolution, per-task convergence monitoring, real-time job status, AI-powered error diagnosis on failed tasks

### Post-processing

- **Electronic structure** — DOS / PDOS, d-band centre, projected orbital character, band structure with high-symmetry k-paths, COHP / ICOHP bonding analysis via LOBSTER. Bader-charge values written into site properties (e.g. by an external `bader` run) render as labels on atoms in the viewer; CatGo does not run Bader integration itself
- **Catalysis** — Gibbs free-energy diagrams with ZPE + thermal corrections, OER / NRR / CO₂RR catalysis modules (`server/workflow/catalysis/`), HER / ORR achievable via the `free_energy` workflow node with target= keyword, volcano plots across descriptor space
- **Vibrations & thermodynamics** — frequency parsing from VASP / ORCA outputs, ZPE, entropy at user-specified T/P, IR intensities. Phonopy output parsing exists (`src/lib/structure/parsers/phonopy.ts`) but Phonopy itself runs externally — CatBot has a `phonopy` skill that drafts the run, no in-app executor

### HPC integration

- **Connect** — SSH key, password, OTP (KAUST Shaheen-style key+OTP), password+OTP, SOCKS5 proxy, jump host
- **Browse** — remote file tree, in-place Monaco editor for INCAR / KPOINTS / job-script editing, Threlte-powered viewer preview of CIF / POSCAR / TRAJ / HDF5 directly from the remote tree, scp upload/download without size limits
- **Submit & monitor** — SLURM / PBS / LSF / SGE adapters, job templates per partition, queue-state polling, log tail, convergence point streaming, AI diagnosis on FAILED / REMOTE_ERROR tasks
- **Terminal** — full xterm.js PTY session per host, CWD broadcast to the file browser, multi-tab + split panes

### AI agent (CatBot)

<p align="center">
  <img src="static/catgo-catbot.png" alt="CatGo CatBot chat pane — Claude Code provider with workflow / structure / analysis quick prompts" width="780">
</p>

- **Providers** — local Ollama, SDK agents (Claude Code, Gemini CLI, Codex CLI), and API providers (DeepSeek, Qwen, Kimi, Zhipu GLM, Gemini) via OpenAI-compatible streaming
- **MCP tools** — `catgo_structure`, `catgo_fetch`, `catgo_workflow`, `catgo_quickbuild`, `catgo_analyze`, `catgo_view`, `catgo_catalysis`, `catgo_skills`, `catgo_workflow_engine`, `catgo_diagnose`, `catgo_file`, `catgo_system`
- **Skills** — server-side reference docs CatBot reads on demand (workflow_builder, atom_ops, cluster_ops, plus ~40 DFT-code skill guides)
- **Quick-build hook** — UI button strip + HTTP endpoint that builds a complete workflow with zero LLM round-trips (~200 ms)
- **Session resume** — `record_session` writes a local history index that survives reloads; clicking an entry continues the conversation with the same Claude/Codex/Gemini session id

### Plugin system

- **Plugin Hub** — install / enable / disable plugins from a registry; built-in readers for VASP `vaspout.h5`, `PROCAR`, `vasprun.xml` bands, COHPCAR
- **Plugin API** — Python `catgo-plugin.json` manifest with backend calculators, structure readers, analyzers, workflow nodes; sample plugins shipped (Lennard-Jones calculator, charge-coloring)
- **VS Code extension** — preview CIF / POSCAR / XYZ / TRAJ / HDF5 files inside the editor (right-click → *Render with CatGo*, or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>)

### Structure I/O

- **Import** — drag-drop, paste, OPTIMADE search (Materials Project, MC3D, Alexandria, MaterialsCloud, OMDB, 2DMatPedia), PubChem molecule search, file browser, HPC remote file read
- **Export** — POSCAR, CIF, XYZ, extxyz, mol2, PDB, NEB-image set, full workflow JSON

---

## 📦 Get CatGo

Prebuilt artifacts are published on [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases):

- **Desktop app** — Tauri build, bundled backend + agent + shell.
- **IDE extension** — a cross-platform `.vsix` (Windows / macOS / Linux). Installs in **VS Code, Cursor, and other VS Code-compatible IDEs**, bringing the full CatGo workbench (including the bundled backend and shell) inside your editor.
- **Linux server binary** — headless backend for remote / HPC hosts.
- **HPC bundle** — for cluster deployment.

### Web version — frontend only

<https://app.catgo-ucsd.org> is a hosted static single-page app (SvelteKit `adapter-static`). It runs **frontend features only**: structure viewing, editing, and 3D visualization in the browser, with zero install.

It does **not** include the backend: no DFT/MD execution, no HPC job submission, and no AI-agent task execution. Those require the desktop app or the IDE extension, which bundle the backend and an integrated shell. Use the web app to inspect and edit structures; use a full edition to run real work.

### Built-in shell

The desktop app and the IDE extension ship with an **integrated shell** — drive jobs, inspect outputs, and move files without leaving CatGo. In the shell, **Ctrl + click** a structure file path (POSCAR, CIF, XYZ, extxyz, trajectory, …) opens it directly in the 3D viewer — no manual upload step.

The rest of this README covers running CatGo **from source** for development.

---

## 🚀 Quick Start

### Requirements

- **Node.js** ≥ 20 with **pnpm**
- **Python** ≥ 3.10 (Conda recommended)
- **Git**

### Install & Run

```bash
# 1. Clone
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. Frontend dependencies
pnpm install

# 3. Python environment
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt
```

Then pick one of three ways to run:

**Option A — Browser dev (fastest iteration)**

```bash
pnpm desktop:serve            # vite on :3100, FastAPI on :8000
```

Open <http://localhost:3100> in any browser. Hot-reload on every save.

**Option B — Tauri native shell (recommended for daily use)**

```bash
# One-time: install Rust toolchain + Tauri prerequisites
# (https://tauri.app/start/prerequisites/)
pnpm tauri:dev                # builds vite then opens a native window
```

`tauri:dev` runs the same backend on :8000 but renders the frontend in
a native WebKit / WebView2 window. ~40 % smoother than the browser
build because the production frontend skips Svelte 5's dev-mode
reactivity tracking + HMR client overhead. The Tauri shell also keeps
the Python backend alive as a sidecar so closing the window stops
everything cleanly.

**Option C — Build an installer (.dmg / .msi / .deb / .AppImage)**

```bash
pnpm tauri:build              # desktop app only — server runs separately
pnpm bundle                   # app + Python backend (PyInstaller sidecar)
pnpm bundle:windows           # cross-platform variants
pnpm bundle:mac-arm
```

The bundled artefact lands under `src-tauri/target/release/bundle/` —
double-click to run; the backend auto-starts as a packaged sidecar.

Once running (any of the three), drop a CIF / POSCAR / XYZ / extxyz / mol2 / pdb / traj file onto the viewer, or ask CatBot: *"fetch Cu from Materials Project and cut a (100) slab."*

---

## 🤖 CatBot Examples

```text
"Fetch TiO2 anatase from Materials Project, make a 2×2×2 supercell,
 cut a (101) slab with 3 layers and 15 Å vacuum."

"Find adsorption sites and place CO on the most stable hollow site."

"Generate VASP input for relaxation with PBE+D3, ENCUT=520, ISMEAR=0."

"Create a workflow: geo_opt → single_point → DOS analysis,
 then submit it to Shaheen partition workq with 64 cores."

"Place CO and NH2 on Cu(111) at 3.5 Å for a C-N coupling slow-growth
 run, set up the ICONST and propose ENCUT/k-mesh."
```

### How chat-driven workflow generation works

CatGo has two workflow-authoring paths:

1. **Visual editor** — drag nodes from the left palette (Input /
   Calculation / Tools / Logic / Analysis), wire them on the canvas,
   then run the graph.
2. **CatBot pane** — type a request such as "set up a HER free-energy
   workflow on Pt(111) with three intermediates"; CatBot builds the DAG
   through CatGo's MCP-backed workflow APIs.

The in-app CatBot path uses the running backend's HTTP MCP endpoint. It
does not register the same stdio MCP server used by the standalone
terminal plugin.

```text
You ─ chat ─▶ CatBot pane                         (src/lib/chat/*)
              │
              ▼
        agent bridge                              (vite-plugin-agent-bridge.ts in dev;
              │                                   desktop bridge in packaged builds)
              │
              ▼
        provider adapter                          (for Claude: @anthropic-ai/claude-agent-sdk query())
              │
              │  MCP server URL: http://localhost:<port>/api/mcp
              │  plus X-CatGo-Tab-Id so tool results return to the active viewer tab
              ▼
        server/catgo/routers/mcp_http.py
              │
              │  imports the consolidated tool schema/handlers from
              ▼
        server/catgo/mcp_tools/server_claude_code.py
              │
              ├── catgo_structure   — build/edit/inspect the viewer structure
              ├── catgo_fetch       — Materials Project / OPTIMADE / PubChem
              ├── catgo_workflow    — create / batch-edit DAG nodes + edges
              ├── catgo_quickbuild  — one-call recipe builders
              ├── catgo_analyze     — DOS / band / COHP / adsorption-site analysis
              ├── catgo_view        — viewer state and screenshots
              ├── catgo_catalysis   — free-energy diagrams and volcano plots
              ├── catgo_file        — local + remote file I/O
              └── catgo_system      — environment, sessions, settings
```

The MCP tool mutates backend state (workflow DAGs, viewer-panel state,
or HPC job records). The frontend then sees those backend updates through
the normal app state and streaming response path, so from the user's
perspective a sentence in CatBot turns into a visible workflow graph.

There is also a separate **terminal plugin** path:

```text
Claude Code terminal
  └── catbot-plugin/.mcp.json
        └── ${CLAUDE_PLUGIN_ROOT}/server/mcp_server.py
              └── symlink to server/mcp_server.py
                    └── catgo.mcp_tools.server
```

That standalone stdio server exposes the broader fine-grained MCP tool
set plus dynamic tool lifecycle commands such as `catgo_create_tool` and
`catgo_save_tool`. It is useful for terminal agents, but it is not the
same MCP surface as the in-app CatBot pane.

The browser UI does not call model APIs directly. Model traffic is owned
by the local agent bridge/provider adapter, while CatGo operations flow
through the backend MCP endpoint.

### AI Provider Setup

Pick any available provider in CatBot settings:

| Provider group | Options | Notes |
|---|---|---|
| **Local** | Ollama | Runs against `http://127.0.0.1:11434`; no API key required. |
| **SDK agents** | Claude Code, Gemini CLI, Codex CLI | Install the matching CLI. Claude can also use `ANTHROPIC_API_KEY`; Gemini can use CLI OAuth or `GEMINI_API_KEY`; Codex uses the Codex SDK/CLI auth flow. |
| **API providers** | DeepSeek, Qwen, Kimi, Zhipu GLM, Gemini | Use an API key from settings or server env (`DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPUAI_API_KEY`, `GEMINI_API_KEY`). These go through CatGo's OpenAI-compatible streaming path. |

For API providers, the Base URL field is editable, so the same path can be
pointed at another OpenAI-compatible endpoint when needed.

---

## 🗂️ Project Layout

```
catgo-LRG/
├── src/                      # SvelteKit + Svelte 5 frontend
│   └── lib/
│       ├── structure/        # 3D viewer (Threlte / Three.js)
│       ├── workflow/         # DAG editor and node definitions
│       ├── chat/             # CatBot (in-app AI loop)
│       └── api/              # Tauri / desktop / browser routing
├── server/                   # FastAPI Python backend
│   ├── routers/              # REST endpoints
│   ├── workflow/engines/     # VASP / QE / LAMMPS / CP2K / ORCA …
│   ├── mcp_tools/            # MCP definitions for AI agents
│   └── catgo/                # Workflow engine and HPC submitter
├── src-tauri/                # Rust + Tauri desktop shell
├── desktop/                  # Standalone Vite dev frontend
├── extensions/
│   ├── rust/                 # Rust → WASM (bonding, supercell, slab)
│   └── vscode/               # VS Code extension
├── catbot-plugin/            # CatBot agent prompts and tools
└── plugins/                  # User plugins (analysis, viewers, …)
```

---

## 🛠️ Development

| Command | Description |
|---|---|
| `pnpm desktop:serve` | Frontend on port 3100 plus Python backend on port 8000 (recommended) |
| `pnpm desktop:dev` | Frontend only |
| `pnpm tauri:dev` | Full Tauri desktop app |
| `pnpm check` | Svelte / TypeScript check |
| `pnpm test` | Vitest unit tests |
| `cd server && pytest` | Python backend tests |

---

## 🧩 VS Code Extension

A separate VS Code extension under [`extensions/vscode/`](extensions/vscode/) previews CIF / POSCAR / XYZ / TRAJ / HDF5 files directly inside the editor (right-click → *Render with CatGo*, or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>).

---

## 🙏 Acknowledgements

CatGo would not exist without a tremendous amount of open-source work. We are particularly indebted to:

### Foundation

- [**MatterViz**](https://github.com/janosh/matterviz) by [Janosh Riebesell](https://github.com/janosh) — the 3D structure viewer, periodic-table widgets, element data, color schemes, and several UI patterns originate from MatterViz. CatGo has reworked many of them significantly, but the foundation remains MatterViz.

### Frontend stack

[Svelte 5](https://svelte.dev) · [SvelteKit](https://kit.svelte.dev) · [Tauri](https://tauri.app) · [Vite](https://vitejs.dev) · [pnpm](https://pnpm.io) · [three.js](https://threejs.org) · [threlte](https://threlte.xyz) · [d3](https://d3js.org) · [Monaco Editor](https://microsoft.github.io/monaco-editor/) · [xterm.js](https://xtermjs.org) · [moyo](https://github.com/spglib/moyo) (symmetry).

### Python backend

[FastAPI](https://fastapi.tiangolo.com) · [pymatgen](https://pymatgen.org) · [ASE](https://wiki.fysik.dtu.dk/ase/) · [Open Babel](https://openbabel.org) · [Packmol](https://m3g.github.io/packmol/) · [Phonopy](https://phonopy.github.io/phonopy/) · [Phonopy + Spglib](https://spglib.readthedocs.io) · [RDKit](https://www.rdkit.org).

### Machine-learning potentials

[MACE](https://github.com/ACEsuit/mace) · [CHGNet](https://github.com/CederGroupHub/chgnet) · [M3GNet / MatGL](https://github.com/materialsvirtuallab/matgl) · [ORB](https://github.com/orbital-materials/orb-models) · [FAIR-Chem / UMA](https://github.com/facebookresearch/fairchem) · [DeePMD-kit](https://github.com/deepmodeling/deepmd-kit) · [xTB](https://xtb-docs.readthedocs.io).

### DFT / MD engines (input + post-processing)

[VASP](https://www.vasp.at) · [Quantum ESPRESSO](https://www.quantum-espresso.org) · [LAMMPS](https://lammps.org) · [CP2K](https://www.cp2k.org) · [ORCA](https://www.faccts.de/orca/) · [GPAW](https://wiki.fysik.dtu.dk/gpaw/) · [ABINIT](https://www.abinit.org) · [SIESTA](https://siesta-project.org) · [DFTB+](https://dftbplus.org) · [Gaussian](https://gaussian.com).

### AI agents

[Anthropic Claude](https://www.anthropic.com) / [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · [OpenAI Codex CLI](https://github.com/openai/codex) · [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) · [Ollama](https://ollama.com) · [DeepSeek](https://www.deepseek.com) · [Qwen](https://help.aliyun.com/zh/model-studio/) · [Kimi](https://platform.moonshot.ai) · [Zhipu GLM](https://open.bigmodel.cn) · [Gemini API](https://ai.google.dev).

### Testing & tooling

[Vitest](https://vitest.dev) · [Playwright](https://playwright.dev) · [pytest](https://pytest.org) · [Deno](https://deno.land) (lint/format).

Thank you to every maintainer of these projects — the science work CatGo enables stands entirely on your shoulders.

---

## 📚 Citation

If you use CatGo in a publication, please cite the ChemRxiv preprint:

```bibtex
@misc{liu2026catgo,
  author    = {Liu, Guangsheng and Ma, Xiao and Zhang, Leshen and Pascasio, Jenedith and Yang, Jonathan and Chen, Yuxiang and Li, Wan-Lu},
  title     = {CatGo: Bridging CLI Coding Agents with Interactive Structure and Workflow Management for Computational Chemistry},
  year      = {2026},
  doi       = {10.26434/chemrxiv.15002984/v1},
  url       = {https://doi.org/10.26434/chemrxiv.15002984/v1},
  publisher = {ChemRxiv},
  note      = {Preprint},
}
```

---

## 📄 License

CatGo is distributed under the [**GNU Affero General Public License v3.0 or later**](license) (AGPL-3.0-or-later). You are free to use, modify, and redistribute the software under the terms of that license. If you run a modified version of CatGo as a network service, you must make the corresponding source code available to your users under the same license.

---

<p align="center">
  Developed at <a href="https://wanlulilab.ucsd.edu/">Dr. Wanlu Li Lab @ UCSD</a>.
</p>
