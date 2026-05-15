import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as vscode from 'vscode'
import * as http from 'http'

let server_process: ChildProcess | null = null
let server_port: number | null = null
let in_flight_start: Promise<number | null> | null = null

function get_binary_name(): string {
  const platform = process.platform
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
  // If a start is already in flight, return the same promise (prevents concurrent spawns)
  if (in_flight_start) return in_flight_start

  if (server_process && server_port) {
    const alive = await health_check(server_port)
    if (alive) return server_port
    stop_server()
  }

  const binary = get_binary_path(context)
  const config = vscode.workspace.getConfiguration('catgo.server')
  const port_setting = config.get<number>('port', 0)

  in_flight_start = new Promise((resolve) => {
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

    // Scan stdout lines for {"port": N} — may not be the first line
    let stdout_buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (resolved) return
      stdout_buffer += chunk.toString()

      // Process all complete lines
      let newline_idx: number
      while ((newline_idx = stdout_buffer.indexOf('\n')) !== -1) {
        const line = stdout_buffer.slice(0, newline_idx).trim()
        stdout_buffer = stdout_buffer.slice(newline_idx + 1)

        // Try to parse as JSON port announcement
        if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line)
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
              return // Stop processing lines
            }
          } catch {
            // Not valid JSON, continue scanning
          }
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      // Drop verbose workflow.engine.scanner INFO records — the bundled
      // sidecar logs full HPC job_defaults (account, paths, env_setup,
      // module_loads) on every config read, which leaks user info into the
      // VS Code extension-host console.  These are useful only with DEBUG
      // logging on the sidecar; from the extension side, scrub them out
      // before they hit `console.log`.
      const filtered = text
        .split(/\r?\n/)
        .filter((line) => !/INFO:catgo\.workflow\.engine\.scanner/.test(line))
        .join('\n')
      if (!filtered.trim()) return
      // Python logging writes INFO/WARNING/ERROR records to stderr. Classify by
      // level so benign backend info logs don't spam VSCode's error channel.
      if (/^\s*(ERROR|CRITICAL):/m.test(filtered) || /Traceback \(most recent call last\)/.test(filtered)) {
        console.error('[catgo-server]', filtered)
      } else if (/^\s*WARNING:/m.test(filtered) || /UserWarning/.test(filtered)) {
        console.warn('[catgo-server]', filtered)
      } else {
        console.log('[catgo-server]', filtered)
      }
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

  // Clear in-flight ref once resolved (success or failure)
  in_flight_start.finally(() => { in_flight_start = null })
  return in_flight_start
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
