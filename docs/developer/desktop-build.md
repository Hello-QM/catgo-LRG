# Desktop Build Guide

This guide explains how to build CatGO as a desktop application using Tauri 2.0, with or without the bundled Python computation server.

## Prerequisites

### 1. Install Rust

**Windows:**

```powershell
# Download and run rustup-init.exe from https://rustup.rs
# Or use winget:
winget install Rustlang.Rustup
```

**macOS:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Linux:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

After installation, restart your terminal and verify:

```bash
rustc --version
cargo --version
```

### 2. Platform-specific Dependencies

**Windows:**

- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "C++ build tools" workload
- WebView2 is included in Windows 10/11

**macOS:**

- Install Xcode Command Line Tools: `xcode-select --install`

**Linux (Debian/Ubuntu):**

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### 3. Install Node.js Dependencies

```bash
pnpm install
```

## Development

Run the app in development mode with hot reload:

```bash
pnpm tauri:dev
```

This builds the desktop frontend to `build-desktop/` on port 3001, then launches the Tauri window pointing at the dev server.

## Building for Production

### Desktop App Only

Builds the app without the Python computation server. Server-dependent features (optimization, database search, structure builders) require running the server separately.

```bash
pnpm tauri:build
```

Output will be in `src-tauri/target/release/bundle/`:

- **Windows:** `.msi` installer and `.exe`
- **macOS:** `.dmg` and `.app`
- **Linux:** `.deb`, `.rpm`, `.AppImage`

### Platform-specific Builds

```bash
pnpm tauri:build:mac-arm    # macOS Apple Silicon (aarch64)
pnpm tauri:build:mac        # macOS Universal (Intel + ARM)
pnpm tauri:build:windows    # Windows x64
pnpm tauri:build:linux      # Linux x64
```

### Full Bundle (App + Backend Server)

Builds the Python computation server as a standalone executable via PyInstaller, then bundles it as a Tauri sidecar. The server starts automatically when the app launches and shuts down when the window closes.

**Prerequisites for bundling:**

- Python 3.10+
- PyInstaller (`pip install pyinstaller`)
- Server dependencies (`cd server && pip install -r requirements.txt`)

```bash
# Build for current platform
pnpm bundle

# Platform-specific
pnpm bundle:mac-arm     # macOS Apple Silicon
pnpm bundle:windows     # Windows x64
```

The build script (`scripts/build-backend.sh`) compiles the server into a single executable at `src-tauri/binaries/catgo-server-{target}` and the Tauri build picks it up as an external binary.

### Generate App Icons

```bash
pnpm tauri:icons
```

Generates all required icon sizes (32x32, 128x128, ICNS, ICO) from `desktop/logo.png`.

## Architecture

The desktop app has three layers:

```
┌──────────────────────────────────┐
│  Desktop Frontend (Svelte 5)     │  desktop/App.svelte
│  Multi-pane editor, file I/O,    │  Vite build → build-desktop/
│  atom clipboard, settings        │
├──────────────────────────────────┤
│  Tauri Shell (Rust)              │  src-tauri/src/lib.rs
│  Plugins: fs, dialog, shell,     │  Spawns/kills backend sidecar
│  http, log                       │
├──────────────────────────────────┤
│  Python Backend (optional)       │  server/main.py
│  FastAPI on :8000                │  Bundled via PyInstaller
│  Optimization, DB proxy,         │
│  structure builders              │
└──────────────────────────────────┘
```

**Tauri plugins used:**

| Plugin | Purpose |
|--------|---------|
| `tauri-plugin-fs` | Read/write files via native filesystem |
| `tauri-plugin-dialog` | Native open/save dialogs with file type filters |
| `tauri-plugin-shell` | Spawn the bundled backend sidecar |
| `tauri-plugin-http` | HTTP requests to the backend server |
| `tauri-plugin-log` | Structured logging |

The Rust layer is intentionally minimal (~150 lines) — it manages the sidecar lifecycle, file association handling, PTY sessions, and delegates everything else to the Svelte frontend and Tauri plugins.

## File Associations

The app registers OS-level file associations so users can double-click to open:

| Extension | Description |
|-----------|-------------|
| `.cif` | Crystallographic Information Files |
| `.poscar`, `.vasp`, `.contcar` | VASP structure files |
| `.xyz`, `.extxyz` | XYZ molecular structure files |
| `.traj` | ASE trajectory files |
| `.json` | JSON structure data |

These are configured in `src-tauri/tauri.conf.json` under `bundle.fileAssociations`.

### Document Icons (macOS)

On macOS, associated files display a custom CatGO document icon in Finder. This is implemented via:

- `src-tauri/icons/document.icns` — the icon file (generated from `document.svg`)
- `src-tauri/Info.plist` — `CFBundleDocumentTypes` entries referencing the icon
- `src-tauri/tauri.conf.json` — `bundle.resources` copies the `.icns` into the app bundle

### File Open Handling

When a user double-clicks an associated file, macOS sends a `RunEvent::Opened` event to the Tauri backend. The Rust layer buffers the file paths in an `OpenedFiles` state and notifies the frontend, which reads and loads the file into the active tab.

## Mobile Support (Experimental)

Tauri 2.0 supports iOS and Android. To initialize mobile:

### Android Setup

1. Install Android Studio and SDK
2. Set `ANDROID_HOME` environment variable
3. Initialize Android:
   ```bash
   npx tauri android init
   ```
4. Build:
   ```bash
   npx tauri android build
   ```

### iOS Setup (macOS only)

1. Install Xcode
2. Initialize iOS:
   ```bash
   npx tauri ios init
   ```
3. Build:
   ```bash
   npx tauri ios build
   ```

## CI/CD with GitHub Actions

Create `.github/workflows/release.yml` for automated builds:

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        platform: [macos-latest, ubuntu-22.04, windows-latest]
    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Install Rust stable
        uses: dtolnay/rust-action@stable

      - name: Install dependencies (Ubuntu)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
            libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - name: Install frontend dependencies
        run: pnpm install

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: v__VERSION__
          releaseName: 'CatGO v__VERSION__'
          releaseBody: 'See the assets to download and install this version.'
          releaseDraft: true
          prerelease: false
```

## Troubleshooting

### WebView2 Not Found (Windows)

Download and install the WebView2 runtime from:
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### Rust Compilation Errors

Update Rust:

```bash
rustup update stable
```

### Backend Sidecar Not Starting

If the bundled server fails to start:

1. Check the app logs for `[Backend]` messages (Tauri log plugin)
2. Verify the binary exists at `src-tauri/binaries/catgo-server-{target}`
3. Try running it directly: `./src-tauri/binaries/catgo-server-{target}`
4. As a fallback, run the server manually: `cd server && python main.py`

### WASM/WebGL Issues

Ensure your graphics drivers are up to date and hardware acceleration is enabled.

### Port 8000 Already in Use

The backend server runs on port 8000. If another process is using it:

```bash
# Find what's using port 8000
lsof -i :8000        # macOS/Linux
netstat -ano | findstr :8000  # Windows

# Kill the process, then restart the app
```
