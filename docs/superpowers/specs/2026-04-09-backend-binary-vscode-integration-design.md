# CatGo Backend Binary + VS Code Extension Integration

**Date:** 2026-04-09
**Status:** Approved

## Overview

Package the CatGo Python backend as a standalone binary via PyInstaller and embed it inside the VS Code extension. The extension auto-starts the binary as a child process, providing server-side features (xTB optimization, input generation, etc.) without users needing Python or source code.

## Part 1: PyInstaller Backend Binary

### Included Features (Slim Build)

- Structure optimization: EMT, xTB (tblite)
- DFT input generation: VASP, QE, ORCA, LAMMPS, CP2K, Gaussian
- OPTIMADE / PubChem structure search proxy
- Frequency analysis, DOS parsing
- Workflow engine + engine_defs YAML configs

### Excluded

- MACE / CHGNet / M3GNet (PyTorch ~2.5 GB; user installs via pip if needed)
- HPC SSH (asyncssh — VS Code plugin doesn't need remote HPC)
- AI Chat (chat_multi.py — depends on external CLI agents)
- Open Babel (optional C library, graceful degradation)
- PTY terminal

### Build Targets

| Platform | Binary Name | Estimated Size |
|----------|-------------|---------------|
| Linux x64 | `catgo-server-linux-x64` | ~200-400 MB |
| macOS ARM64 | `catgo-server-darwin-arm64` | ~200-400 MB |
| Windows x64 | `catgo-server-win-x64.exe` | ~200-400 MB |

### Startup Protocol

1. Extension spawns binary with `--port 0` (OS assigns free port)
2. Binary prints `{"port": <N>}` to stdout on successful startup
3. Extension reads the port, then polls `GET /health` to confirm readiness
4. On extension deactivate: SIGTERM → wait 3s → SIGKILL

### catgo_server.spec Updates

- Update all `hiddenimports` to use `catgo.routers.*` (not `routers.*`)
- Add all 47 routers currently imported in `main.py`
- Add `datas` for `workflow/engine_defs/*.yaml`, `workflow/templates/*.j2`, skill docs
- Expand pymatgen imports (transformations, analysis, io.vasp, core.surface)
- Add mdtraj, h5py, scikit-learn, scipy submodules
- Keep `excludes` for torch, matplotlib, IPython, jupyter, pytest

### Port 0 Support in main.py

Add `--port 0` mode:
- Let OS assign a free port via uvicorn
- After uvicorn starts, print `{"port": <actual_port>}` to stdout as the first line
- This allows the extension to discover the port without conflicts

## Part 2: VS Code Extension Integration

### Architecture

```
VS Code Extension Host (Node.js)
  ├── activate(): spawn catgo-server binary (child_process)
  ├── Parse stdout for {"port": N}
  ├── Health check: GET http://localhost:{port}/health
  ├── Message relay: webview postMessage → fetch(localhost:{port}/api/...)
  ├── WebSocket relay: optimization progress streaming
  └── deactivate(): graceful kill

Webview (existing Svelte renderer)
  ├── Structure viewing/editing (WASM, unchanged)
  ├── NEW: Optimization panel → postMessage({command:'api',...})
  ├── NEW: WebSocket optimization progress relay
  └── NEW: VASP/QE input generation panel
```

### package.json Changes

New settings:
- `catgo.server.auto_start` (boolean, default: true) — auto-start backend on activation
- `catgo.server.port` (number, default: 0) — 0 = auto-assign

Binary location:
- `bin/catgo-server` (platform-specific, included in .vsix)

### Platform-Specific .vsix Packaging

Use `vsce package --target <platform>`:
- `catgo-linux-x64.vsix` — contains `bin/catgo-server-linux-x64`
- `catgo-darwin-arm64.vsix` — contains `bin/catgo-server-darwin-arm64`
- `catgo-win32-x64.vsix` — contains `bin/catgo-server-win-x64.exe`

Each .vsix only includes the binary for its platform.

### extension.ts New Logic (~100 lines)

**Server lifecycle management:**
```typescript
// In activate():
const server = spawn(binaryPath, ['--port', '0'])
server.stdout → parse JSON line for port
await poll GET /health (timeout 30s)
store serverPort for API relay

// In handle_msg():
case 'api_request':
  const resp = await fetch(`http://localhost:${serverPort}/api/${msg.endpoint}`, ...)
  webview.postMessage({type: 'api_response', id: msg.id, data: resp})

case 'api_ws_start':
  const ws = new WebSocket(`ws://localhost:${serverPort}/api/${msg.endpoint}`)
  ws.onmessage → webview.postMessage({type: 'ws_message', ...})

// In deactivate():
server.kill('SIGTERM')
setTimeout(() => server.kill('SIGKILL'), 3000)
```

### Webview Changes

- Reuse existing type definitions from `compute.ts` (CalculatorType, OptimizationProgress, etc.)
- New optimization panel UI (simplified version of OptimizationPane.svelte)
- All API calls go through `vscode.postMessage` → extension host → localhost fetch
- WebSocket optimization progress relayed through the same message channel

### .vscodeignore Updates

Exclude build artifacts and source files, but include `bin/` directory.

## Implementation Order

1. Update `main.py` to support `--port 0` with JSON stdout
2. Update `catgo_server.spec` with correct imports/data files
3. Test PyInstaller build on current platform
4. Add server lifecycle management to `extension.ts`
5. Add API relay message handling to `extension.ts`
6. Add optimization panel to webview
7. Test full flow: extension activate → server start → optimize structure
8. Package platform-specific .vsix files
