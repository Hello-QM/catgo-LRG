# Backend Binary + VS Code Extension Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the CatGo Python backend as a closed-source binary via PyInstaller and embed it in the VS Code extension with auto-start lifecycle management.

**Architecture:** Extension spawns a platform-specific `catgo-server` binary as a child process on activation. The binary starts a FastAPI server on an auto-assigned port, reports the port via stdout JSON. The extension relays API requests from the webview to the local server. On deactivation, the server process is killed.

**Tech Stack:** PyInstaller (packaging), Node.js child_process (lifecycle), FastAPI/uvicorn (server), VS Code Extension API (integration)

---

### Task 1: Add `--port 0` auto-port support to main.py

**Files:**
- Modify: `server/main.py:524-554` (CLI section)

- [ ] **Step 1: Add `--port` CLI argument and JSON port output**

In `server/main.py`, replace the `if __name__ == "__main__"` block (lines 524-554) with:

```python
if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="CatGo Computation Server")
    parser.add_argument("--daemon", action="store_true",
                        help="Run as a background daemon (Unix only)")
    parser.add_argument("--stop", action="store_true",
                        help="Stop a running daemon")
    parser.add_argument("--status", action="store_true",
                        help="Check if the daemon is running")
    parser.add_argument("--port", type=int, default=None,
                        help="Override server port (0 = auto-assign free port)")
    args = parser.parse_args()

    if args.stop:
        _cmd_stop()
    elif args.status:
        _cmd_status()
    elif args.daemon:
        _cmd_daemon(args.port or SERVER_PORT)
    else:
        run_port = args.port if args.port is not None else SERVER_PORT

        if run_port == 0:
            # Auto-assign: let OS pick a free port, report it via stdout JSON
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("", 0))
            run_port = sock.getsockname()[1]
            sock.close()

        # Print port as first stdout line (extension reads this)
        import json as _json
        print(_json.dumps({"port": run_port}), flush=True)

        print(f"Starting CatGo server on port {run_port}")
        uvicorn.run(
            "main:app",
            host="0.0.0.0",
            port=run_port,
            reload=False,
            log_level="warning",
        )
```

- [ ] **Step 2: Test auto-port mode**

Run:
```bash
cd server && timeout 5 python main.py --port 0 2>&1 | head -1
```
Expected: `{"port": <some_number>}` as first line of output.

- [ ] **Step 3: Commit**

```bash
git add server/main.py
git commit -m "feat: add --port 0 auto-assign mode for embedded server"
```

---

### Task 2: Update PyInstaller spec for current codebase

**Files:**
- Modify: `server/catgo_server.spec`

- [ ] **Step 1: Rewrite the spec with current imports and data files**

Replace the entire contents of `server/catgo_server.spec` with a corrected version that:
- Uses `catgo.routers.*` paths (not bare `routers.*`)
- Includes all 47+ routers from `catgo/routers/__init__.py`
- Adds `datas` for engine_defs YAML, templates, skills, tool_schema
- Expands pymatgen/ase/scipy hidden imports
- Adds mdtraj, h5py, scikit-learn
- Excludes torch, matplotlib, IPython, jupyter, pytest
- Uses `console=False` for release builds (no terminal window on Windows)

Key sections to get right:

```python
datas=[
    ('workflow/engine_defs', 'workflow/engine_defs'),
    ('workflow/templates', 'workflow/templates'),
    ('catgo/workflow/skills', 'catgo/workflow/skills'),
    ('catgo/tool_schema', 'catgo/tool_schema'),
    ('templates', 'templates'),
]
```

Hidden imports must include every module from `catgo/routers/__init__.py` plus their transitive deps that PyInstaller can't auto-detect (pymatgen submodules, ase.io format plugins, etc.).

- [ ] **Step 2: Test PyInstaller build**

```bash
cd server && pyinstaller catgo_server.spec 2>&1 | tail -20
```
Expected: Build completes, `dist/catgo-server` binary exists.

- [ ] **Step 3: Test the binary runs**

```bash
timeout 10 ./dist/catgo-server --port 0 2>&1 | head -3
```
Expected: First line is `{"port": <N>}`, server starts without import errors.

- [ ] **Step 4: Smoke test the /health endpoint**

```bash
# In one terminal:
./dist/catgo-server --port 9999 &
sleep 3
curl -s http://localhost:9999/health
kill %1
```
Expected: `{"status": "healthy", "port": 9999, ...}`

- [ ] **Step 5: Commit**

```bash
git add server/catgo_server.spec
git commit -m "feat: update PyInstaller spec for current codebase"
```

---

### Task 3: Add server lifecycle manager to VS Code extension

**Files:**
- Create: `extensions/vscode/src/server.ts`
- Modify: `extensions/vscode/src/extension.ts:871-939` (activate), `extensions/vscode/src/extension.ts:1086-1093` (deactivate)

- [ ] **Step 1: Create server lifecycle manager**

Create `extensions/vscode/src/server.ts`:

```typescript
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as vscode from 'vscode'
import * as http from 'http'

let server_process: ChildProcess | null = null
let server_port: number | null = null

function get_binary_name(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32') return 'catgo-server-win-x64.exe'
  if (platform === 'darwin') return 'catgo-server-darwin-arm64'
  return 'catgo-server-linux-x64'
}

function get_binary_path(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'bin', get_binary_name())
}

function health_check(port: number, timeout_ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeout_ms }, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

export async function start_server(context: vscode.ExtensionContext): Promise<number | null> {
  if (server_process && server_port) {
    const alive = await health_check(server_port)
    if (alive) return server_port
    // Dead process, clean up
    stop_server()
  }

  const binary = get_binary_path(context)
  const config = vscode.workspace.getConfiguration('catgo.server')
  const port_setting = config.get<number>('port', 0)

  return new Promise((resolve) => {
    const proc = spawn(binary, ['--port', String(port_setting)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        vscode.window.showErrorMessage('CatGo server failed to start within 30s')
        resolve(null)
      }
    }, 30000)

    // Read first line of stdout for {"port": N}
    let stdout_buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (resolved) return
      stdout_buffer += chunk.toString()
      const newline_idx = stdout_buffer.indexOf('\n')
      if (newline_idx === -1) return

      const first_line = stdout_buffer.slice(0, newline_idx).trim()
      try {
        const parsed = JSON.parse(first_line)
        if (typeof parsed.port === 'number') {
          server_port = parsed.port
          server_process = proc

          // Poll health until ready
          const poll = setInterval(async () => {
            if (resolved) { clearInterval(poll); return }
            const ok = await health_check(server_port!)
            if (ok) {
              clearInterval(poll)
              clearTimeout(timeout)
              resolved = true
              resolve(server_port)
            }
          }, 500)
        }
      } catch {
        // Not JSON, ignore
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      // Log server stderr to output channel
      console.error('[catgo-server]', chunk.toString())
    })

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        vscode.window.showErrorMessage(`CatGo server exited with code ${code}`)
        resolve(null)
      }
      server_process = null
      server_port = null
    })
  })
}

export function stop_server(): void {
  if (!server_process) return
  const proc = server_process
  server_process = null
  server_port = null

  proc.kill('SIGTERM')
  setTimeout(() => {
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
  }, 3000)
}

export function get_server_port(): number | null {
  return server_port
}

export function is_server_running(): boolean {
  return server_process !== null && server_port !== null
}
```

- [ ] **Step 2: Wire lifecycle into extension.ts activate/deactivate**

In `extensions/vscode/src/extension.ts`, add import at top:

```typescript
import { start_server, stop_server } from './server'
```

In `activate()` (around line 871), add after existing registrations:

```typescript
// Auto-start backend server if configured
const auto_start = vscode.workspace.getConfiguration('catgo.server').get<boolean>('auto_start', true)
if (auto_start) {
  start_server(context).then((port) => {
    if (port) console.log(`[CatGo] Backend server running on port ${port}`)
  })
}
```

In `deactivate()` (line 1086), add:

```typescript
stop_server()
```

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/src/server.ts extensions/vscode/src/extension.ts
git commit -m "feat(vscode): add backend server lifecycle management"
```

---

### Task 4: Add API relay to extension message handler

**Files:**
- Modify: `extensions/vscode/src/extension.ts:378-599` (handle_msg function)

- [ ] **Step 1: Add api_request and api_ws message handlers**

In the `handle_msg` function (around line 598, before the closing brace), add new cases:

```typescript
    case 'api_request': {
      // Relay REST API request to local backend server
      const { get_server_port } = await import('./server')
      const port = get_server_port()
      if (!port) {
        webview.postMessage({ command: 'api_response', id: msg.request_id, error: 'Server not running' })
        return
      }
      try {
        const url = `http://127.0.0.1:${port}/api/${msg.endpoint}`
        const resp = await fetch(url, {
          method: msg.method || 'GET',
          headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        })
        const data = await resp.json()
        webview.postMessage({ command: 'api_response', id: msg.request_id, status: resp.status, data })
      } catch (err: any) {
        webview.postMessage({ command: 'api_response', id: msg.request_id, error: err.message })
      }
      return
    }

    case 'api_ws': {
      // Relay WebSocket connection for optimization progress
      const { get_server_port } = await import('./server')
      const port = get_server_port()
      if (!port) {
        webview.postMessage({ command: 'ws_error', id: msg.request_id, error: 'Server not running' })
        return
      }
      const WebSocket = (await import('ws')).default
      const ws_url = `ws://127.0.0.1:${port}/api/${msg.endpoint}`
      const ws = new WebSocket(ws_url)

      ws.on('open', () => {
        if (msg.body) ws.send(JSON.stringify(msg.body))
        webview.postMessage({ command: 'ws_open', id: msg.request_id })
      })
      ws.on('message', (data: Buffer) => {
        webview.postMessage({ command: 'ws_message', id: msg.request_id, data: JSON.parse(data.toString()) })
      })
      ws.on('close', () => {
        webview.postMessage({ command: 'ws_close', id: msg.request_id })
      })
      ws.on('error', (err: Error) => {
        webview.postMessage({ command: 'ws_error', id: msg.request_id, error: err.message })
      })
      return
    }
```

Also update the `IncomingCommand` type (around line 69) to add the new commands:

```typescript
export type IncomingCommand =
  | 'info'
  | 'error'
  | 'request_large_file'
  | 'request_frame'
  | 'saveAs'
  | 'startWatching'
  | 'stopWatching'
  | 'optimade_fetch'
  | 'pubchem_fetch'
  | 'mp_fetch'
  | 'optimade_search'
  | 'pubchem_search'
  | 'api_request'
  | 'api_ws'
```

And add to `MessageData` interface (around line 83):

```typescript
  // API relay fields
  endpoint?: string
  method?: string
  body?: unknown
```

- [ ] **Step 2: Add `ws` dependency**

```bash
cd extensions/vscode && pnpm add -D ws @types/ws
```

- [ ] **Step 3: Update vite.config.mjs externals**

In `extensions/vscode/vite.config.mjs`, add `ws` to the extension build's external list (the main extension config, not the webview config). Find the extension build config and ensure `ws` is externalized alongside `vscode`:

```javascript
external: ['vscode', 'ws'],
```

- [ ] **Step 4: Commit**

```bash
git add extensions/vscode/src/extension.ts extensions/vscode/package.json extensions/vscode/pnpm-lock.yaml extensions/vscode/vite.config.mjs
git commit -m "feat(vscode): add REST and WebSocket API relay to backend"
```

---

### Task 5: Add server settings to package.json

**Files:**
- Modify: `extensions/vscode/package.json` (contributes.configuration section)

- [ ] **Step 1: Add catgo.server settings**

In the `contributes.configuration.properties` section of `extensions/vscode/package.json`, add:

```json
"catgo.server.auto_start": {
  "type": "boolean",
  "default": true,
  "description": "Automatically start the CatGo backend server when the extension activates. Provides xTB optimization and DFT input generation."
},
"catgo.server.port": {
  "type": "number",
  "default": 0,
  "description": "Backend server port. 0 = auto-assign a free port.",
  "minimum": 0,
  "maximum": 65535
}
```

- [ ] **Step 2: Update .vscodeignore to include bin/ but exclude source**

Replace `extensions/vscode/.vscodeignore` with:

```
# Source files (closed source backend)
src/**
*.ts
server/**

# Build config
tsconfig.json
vite.config.mjs
vite.webview.config.ts
scripts/**
.vscode/**
tests/**

# Dev files
node_modules/**
*.map
```

Note: `bin/` is NOT listed, so the binary will be included in the .vsix.

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/package.json extensions/vscode/.vscodeignore
git commit -m "feat(vscode): add server settings and update vscodeignore for binary"
```

---

### Task 6: Platform-specific .vsix packaging script

**Files:**
- Create: `extensions/vscode/scripts/package.sh`

- [ ] **Step 1: Create packaging script**

Create `extensions/vscode/scripts/package.sh`:

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$(dirname "$(dirname "$EXT_DIR")")/server"

cd "$EXT_DIR"

# Build extension
pnpm build

# Build backend binary
echo "=== Building catgo-server binary ==="
cd "$SERVER_DIR"
pyinstaller catgo_server.spec --noconfirm 2>&1 | tail -5

# Copy binary to extension bin/
mkdir -p "$EXT_DIR/bin"
PLATFORM="$(uname -s)-$(uname -m)"
case "$PLATFORM" in
  Linux-x86_64)  TARGET="linux-x64";   BIN_NAME="catgo-server-linux-x64" ;;
  Darwin-arm64)  TARGET="darwin-arm64"; BIN_NAME="catgo-server-darwin-arm64" ;;
  Darwin-x86_64) TARGET="darwin-x64";  BIN_NAME="catgo-server-darwin-x64" ;;
  MINGW*|MSYS*)  TARGET="win32-x64";   BIN_NAME="catgo-server-win-x64.exe" ;;
  *)             echo "Unknown platform: $PLATFORM"; exit 1 ;;
esac

cp "$SERVER_DIR/dist/catgo-server" "$EXT_DIR/bin/$BIN_NAME" 2>/dev/null || \
cp "$SERVER_DIR/dist/catgo-server.exe" "$EXT_DIR/bin/$BIN_NAME"
chmod +x "$EXT_DIR/bin/$BIN_NAME"

echo "=== Binary: bin/$BIN_NAME ($(du -h "$EXT_DIR/bin/$BIN_NAME" | cut -f1)) ==="

# Package .vsix for current platform
cd "$EXT_DIR"
npx vsce package --no-dependencies --target "$TARGET" -o "catgo-$TARGET.vsix"

echo "=== Done: catgo-$TARGET.vsix ==="
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x extensions/vscode/scripts/package.sh
```

- [ ] **Step 3: Commit**

```bash
git add extensions/vscode/scripts/package.sh
git commit -m "feat(vscode): add platform-specific packaging script"
```

---

### Task 7: Integration test — full flow

- [ ] **Step 1: Build the binary on current platform**

```bash
cd server && pyinstaller catgo_server.spec --noconfirm 2>&1 | tail -5
```

- [ ] **Step 2: Copy to extension bin/**

```bash
mkdir -p extensions/vscode/bin
cp server/dist/catgo-server extensions/vscode/bin/catgo-server-linux-x64
chmod +x extensions/vscode/bin/catgo-server-linux-x64
```

- [ ] **Step 3: Build the extension**

```bash
cd extensions/vscode && pnpm build
```

- [ ] **Step 4: Test binary standalone**

```bash
timeout 10 extensions/vscode/bin/catgo-server-linux-x64 --port 0 2>&1 | head -3
```
Expected: First line `{"port": <N>}`.

- [ ] **Step 5: Package .vsix**

```bash
cd extensions/vscode && npx vsce package --no-dependencies --target linux-x64
```
Expected: `catgo-linux-x64.vsix` created.

- [ ] **Step 6: Verify .vsix contents**

```bash
unzip -l catgo-linux-x64.vsix | grep -E "bin/|\.py$"
```
Expected: `bin/catgo-server-linux-x64` present, NO `.py` files.

- [ ] **Step 7: Commit**

```bash
git commit --allow-empty -m "test: verify full build pipeline"
```
