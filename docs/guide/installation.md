# Installation

CatGo is a desktop application. Most users should grab a pre-built installer from GitHub Releases. Developers building from source can use the Quick Start below.

## Download a Pre-Built Installer

Pre-built installers for every release are published on [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases/latest). All installers bundle the Python backend (via PyInstaller) and the agent-bridge sidecar — no separate Python or Node install required.

| Platform | File | Notes |
|----------|------|-------|
| **macOS (Apple Silicon)** | `CatGo_<version>_aarch64.dmg` | Drag to `/Applications`. May require right-click → Open on first launch (unsigned). |
| **macOS (Intel)** | `CatGo_<version>_x64.dmg` | Universal builds also available — file name contains `universal`. |
| **Windows** | `CatGo_<version>_x64-setup.exe` or `.msi` | WebView2 runtime is auto-installed if missing. |
| **Linux (`.AppImage`)** | `CatGo_<version>_amd64.AppImage` | `chmod +x` then run. Works on most distros without root. |
| **Linux (`.deb`)** | `CatGo_<version>_amd64.deb` | `sudo apt install ./CatGo_*.deb` on Ubuntu / Debian. |

After install, launch *CatGo* from your launcher. On Linux from the terminal:

```bash
chmod +x CatGo_*.AppImage
./CatGo_*.AppImage
```

User data (databases, panel state, agent working directories) persists under `~/.catgo/`. Override the location with the `CATGO_HOME` environment variable.

## Prerequisites

- **Node.js** ≥ 20 with [pnpm](https://pnpm.io/)
- **Python** ≥ 3.10 (Conda recommended — gives you a clean environment for the scientific Python stack)
- **Git**

For the full Tauri desktop build (producing `.dmg` / `.msi` / `.AppImage` installers), you'll also need:

- [Rust](https://rustup.rs/) toolchain (stable channel)
- Platform-specific build tooling — see the [Tauri 2.0 prerequisites](https://tauri.app/start/prerequisites/) page for your OS

## Quick Start

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

# 4. Launch (frontend on :3100, backend on :8000)
pnpm desktop:serve
```

Open [http://localhost:3100](http://localhost:3100) in your browser. Drop a CIF / POSCAR / XYZ / extxyz / mol2 / pdb / traj file onto the viewer, or ask CatBot something like *"fetch Cu from Materials Project and cut a (100) slab."*

## Development Commands

| Command | What it does |
|---|---|
| `pnpm desktop:serve` | Frontend on :3100 + Python backend on :8000 (recommended for daily development) |
| `pnpm desktop:dev` | Frontend only — useful when the backend is running separately or unneeded |
| `pnpm tauri:dev` | Full Tauri desktop app with hot-reload (requires Rust toolchain) |
| `pnpm check` | Svelte / TypeScript type-check across the codebase |
| `pnpm test` | Vitest unit tests (one-shot); `pnpm vitest` for watch mode |
| `cd server && pytest` | Python backend tests |
| `pnpm docs:dev` | Serve this documentation site locally on :5173 |

## Production Builds

```bash
# Build the Tauri desktop app for your current platform
pnpm tauri:build

# Or target a specific platform explicitly
pnpm tauri:build:mac-arm     # macOS Apple Silicon (.dmg + .app)
pnpm tauri:build:mac         # macOS universal (Intel + Apple Silicon)
pnpm tauri:build:windows     # Windows x64 (.msi + .exe)
pnpm tauri:build:linux       # Linux x64 (.AppImage + .deb)

# Build with the Python backend bundled via PyInstaller (single-file install)
pnpm bundle                  # Current platform
pnpm bundle:mac-arm          # macOS Apple Silicon
pnpm bundle:windows          # Windows x64
```

Built artifacts land in `src-tauri/target/release/bundle/`. The `bundle:*` variants produce a self-contained installer that includes the Python computation server — users don't need to install Python themselves.

## VSCode Extension

```bash
cd extensions/vscode
pnpm install
pnpm build
```

Load the result via *Extensions → Install from VSIX* in VSCode, or run it in the Extension Development Host (press <kbd>F5</kbd> with the `extensions/vscode/` folder open).

## WASM Module (Optional)

The Rust → WASM module (bonding analysis, slab generation, fast geometry operations) ships pre-built at `extensions/rust-wasm/pkg/`. You only need to rebuild from source if you're modifying the Rust code:

```bash
cd extensions/rust

# One-time: install wasm-pack
cargo install wasm-pack

# Build the WASM package
wasm-pack build --target web --out-dir ../rust-wasm/pkg
```

## Running the Backend Alone

If you need only the Python computation server (e.g. headless scripting, CI, or driving CatGo from a Jupyter notebook), bypass the frontend:

```bash
cd server
python main.py
```

The server listens on `http://localhost:8000` with CORS enabled for the frontend.

### Available Calculators

| Calculator | Package | Description |
|---|---|---|
| EMT | ASE (built-in) | Effective medium theory for metals — fast, no setup |
| xTB | tblite + xtb CLI | Semi-empirical tight-binding (GFN2 / GFN1 / GFN0 / GFN-FF) |
| MACE | mace-torch | Machine learning potential, including `mace_mp` foundation models |
| CHGNet | chgnet | Crystal Hamiltonian Graph Network |
| M3GNet | matgl | Materials 3-body Graph Network |

## Troubleshooting

### General

- **`pnpm desktop:serve` says it can't find `python`** — your shell `python` may point to a broken or unrelated interpreter. Either activate the `catgo` conda environment first (`conda activate catgo`), or set the `PYTHON` environment variable to an absolute path like `/opt/anaconda3/bin/python`.
- **`pnpm tauri:dev` fails to compile** — make sure you have the platform-specific build tools for [Tauri 2.0](https://tauri.app/start/prerequisites/) (Xcode Command Line Tools on macOS, the WebView2 runtime on Windows, the standard build essentials on Linux).
- **Frontend loads but viewer is blank** — the WASM module may be missing. Re-run `pnpm install` (the pre-built WASM ships as a workspace link), or rebuild from source as shown above.

### Windows

- **HPC connect fails with `ImportError` for `pywintypes` or `pythoncom`** — fixed in v1.0.1. If you're on an older build, upgrade. The bundled backend now ships the required `pywin32` DLLs.
- **CatBot chat exits immediately** — the agent-bridge sidecar requires the `claude` CLI for the Claude provider. Install it via `npm i -g @anthropic-ai/claude-cli`, or switch CatBot to the Gemini / Codex provider in *Settings*.

### Linux (`.AppImage`)

- **`./CatGo_*.AppImage: cannot execute`** — set the executable bit: `chmod +x CatGo_*.AppImage`.
- **AppImage exits with `WebKit2GTK` error** — install `libwebkit2gtk-4.1-0` (Ubuntu 24.04+) or `libwebkit2gtk-4.0-37` (older). The AppImage does not bundle WebKit; it relies on the system library.
- **MCP endpoint `/api/mcp/` returns 404** — fixed in v1.0.1. Earlier PyInstaller bundles silently dropped the `rfc3987_syntax` grammar files.
- **User data missing after upgrade** — CatGo stores databases and panel state in `~/.catgo/` (not inside the AppImage mount). Make sure that directory is writable.

### macOS

- **"CatGo can't be opened because it is from an unidentified developer"** — right-click the app and choose *Open*, then confirm. Builds are currently unsigned.
- **Sidecar process fails to start** — fixed in v1.0.1; the sidecar lookup now uses the bundle basename. Upgrade to the latest release if you see "catgo-server not found" in the logs.
