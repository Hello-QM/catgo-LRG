# Installation

## Web App (Development)

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) package manager

### Setup

```bash
# Clone the repository
git clone https://github.com/Hello-QM/CatGO.git
cd CatGO

# Install dependencies
pnpm install

# Start development server (port 3000)
pnpm dev
```

### Build for Production

```bash
pnpm build
```

The static site is output to `build/` and can be deployed to any HTTP server (GitHub Pages, Netlify, Vercel, etc.).

## Desktop App (Tauri)

### Prerequisites

- All web app prerequisites above
- [Rust](https://rustup.rs/) toolchain
- Platform-specific dependencies for [Tauri 2.0](https://tauri.app/start/prerequisites/)

### Development

```bash
pnpm tauri:dev
```

### Build

```bash
# Build for current platform
pnpm tauri:build

# Platform-specific builds
pnpm tauri:build:mac-arm    # macOS Apple Silicon
pnpm tauri:build:windows    # Windows x64
pnpm tauri:build:linux      # Linux x64
```

### With Backend Server (Bundled)

To bundle the Python computation server with the desktop app:

```bash
# Build backend + desktop app together
pnpm bundle

# Platform-specific
pnpm bundle:mac-arm
pnpm bundle:windows
```

### Generate App Icons

```bash
pnpm tauri:icons
```

## Computation Server

The Python server provides optimization calculators (EMT, xTB, MACE, CHGNet, M3GNet) and database access routes.

### Prerequisites

- Python 3.10+
- pip or conda

### Setup

```bash
cd server
pip install -r requirements.txt

# Start the server
python main.py
```

The server runs on `http://localhost:8000` with automatic CORS support for the web and desktop apps.

### Available Calculators

| Calculator | Package | Description |
|-----------|---------|-------------|
| EMT | ASE (built-in) | Effective medium theory for metals |
| xTB | xtb-python | Semi-empirical tight-binding (GFN2/GFN1/GFN0/GFN-FF) |
| MACE | mace-torch | Machine learning potential (small/medium/large) |
| CHGNet | chgnet | Crystal Hamiltonian Graph Network |
| M3GNet | matgl | Materials 3-body Graph Network |

## WASM Module (ferrox-wasm)

The Rust/WASM module provides high-performance bonding analysis, slab generation, and structure operations directly in the browser.

### Building from Source

```bash
cd extensions/rust

# Install wasm-pack
cargo install wasm-pack

# Build WASM package
wasm-pack build --target web --out-dir ../rust-wasm/pkg
```

The pre-built WASM binary is included at `extensions/rust-wasm/pkg/` — building from source is only needed if modifying the Rust code.

## VSCode Extension

```bash
cd extensions/vscode
pnpm install
pnpm build
```

The extension can be loaded in VSCode via "Extensions: Install from VSIX" or by running in the Extension Development Host (F5).

## Type Checking & Testing

```bash
# TypeScript / Svelte type checking
pnpm check

# Unit tests
pnpm test              # Run once
pnpm vitest            # Watch mode

# End-to-end tests
npx playwright test
```
