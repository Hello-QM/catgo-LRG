# CatGo Desktop Build Guide

This guide explains how to build CatGo as a desktop application using Tauri 2.0.

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

## Building for Production

### Build for Current Platform

```bash
pnpm tauri:build
```

Output will be in `src-tauri/target/release/bundle/`:

- **Windows:** `.msi` installer and `.exe`
- **macOS:** `.dmg` and `.app`
- **Linux:** `.deb`, `.rpm`, `.AppImage`

### Cross-platform Builds

**Windows (from Windows):**

```bash
pnpm tauri:build:windows
```

**macOS (from macOS):**

```bash
pnpm tauri:build:mac
```

**Linux (from Linux):**

```bash
pnpm tauri:build:linux
```

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
          releaseName: 'CatGo v__VERSION__'
          releaseBody: 'See the assets to download and install this version.'
          releaseDraft: true
          prerelease: false
```

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

## Troubleshooting

### WebView2 Not Found (Windows)

Download and install WebView2 runtime from:
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### Rust Compilation Errors

Update Rust:

```bash
rustup update stable
```

### WASM/WebGL Issues

Ensure your graphics drivers are up to date and hardware acceleration is enabled.
