import yaml from '@rollup/plugin-yaml'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { basename, dirname, extname, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync } from 'node:child_process'
import * as nodePty from 'node-pty'
import { defineConfig, type Plugin } from 'vite'
import { type WebSocket as WsWebSocket, WebSocketServer } from 'ws'
import { agentBridgePlugin } from './vite-plugin-agent-bridge'
import {
  json_gz_plugin,
  server_port,
  shared_define,
  worktree_offset,
} from './vite.shared'
import { Buffer } from 'node:buffer'

const offset = worktree_offset()
const desktop_port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100 + offset
const srv_port = server_port(offset)
// On mobile, the device reaches the dev server over the LAN, not localhost.
// `tauri ios/android dev` sets TAURI_DEV_HOST to the Mac's LAN IP — bind Vite there
// (and point HMR at it) so the phone can load the frontend. Desktop leaves it unset.
const tauri_dev_host = process.env.TAURI_DEV_HOST

// Ensure .svelte-kit/tsconfig.json stub exists so the root tsconfig.json
// "extends" doesn't cause hard errors in Vite 7.x esbuild transforms.
// In web mode, `svelte-kit sync` generates this; desktop mode skips SvelteKit
// entirely, so we create a minimal stub when missing.
const _sk_dir = resolve(`.svelte-kit`)
const _sk_tsconfig = resolve(_sk_dir, `tsconfig.json`)
if (!existsSync(_sk_tsconfig)) {
  mkdirSync(_sk_dir, { recursive: true })
  writeFileSync(
    _sk_tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          module: `esnext`,
          moduleResolution: `bundler`,
          target: `esnext`,
          verbatimModuleSyntax: true,
        },
      },
      null,
      2,
    ) + `\n`,
  )
}

export default defineConfig({
  // Use desktop-specific tsconfig to avoid .svelte-kit dependency
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        strict: true,
        module: `esnext`,
        target: `esnext`,
        moduleResolution: `bundler`,
        esModuleInterop: true,
        skipLibCheck: true,
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
        verbatimModuleSyntax: false,
        lib: [`esnext`, `dom`, `dom.iterable`],
      },
    },
  },

  plugins: [
    json_gz_plugin(true /* skip ?raw — gz-raw plugin handles it */),
    {
      // Decompress .yaml.gz (and other non-json .gz) at build time for ?raw imports.
      // Without this, Vite ?raw reads binary gzip as UTF-8 → corrupted null bytes.
      name: `vite-plugin-gz-raw`,
      enforce: `pre`,
      load(id) {
        // Skip ?url imports — let Vite resolve as URL, load_from_url handles gz decompression
        if (id.includes(`?url`)) return null
        const clean = id.replace(/\?.*$/, ``)
        // Skip non-.gz; skip .json.gz unless it's a ?raw import (json-gz plugin handles non-raw)
        if (!clean.endsWith(`.gz`)) return null
        if (clean.endsWith(`.json.gz`) && !id.includes(`?raw`)) return null
        try {
          const text = gunzipSync(readFileSync(clean)).toString(`utf-8`)
          return { code: `export default ${JSON.stringify(text)}`, map: null }
        } catch (error) {
          this.error(`Failed to decompress ${clean}: ${error}`)
        }
      },
    } satisfies Plugin,
    {
      name: `vite-plugin-ferrox-wasm`,
      enforce: `pre`,
      transform(code, id) {
        if (id.includes(`ferrox-wasm.ts`)) {
          const wasm_path = resolve(__dirname, `extensions/rust-wasm/pkg/ferrox_bg.wasm`)
            .replace(/\\/g, `/`)
          const is_build = process.argv.includes(`build`)
          if (is_build) {
            // Build mode: replace @vite-ignore dynamic import with a static import
            // that Vite can resolve and emit as a hashed asset URL.
            return code.replace(
              /await import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*`@catgo\/ferrox-wasm\/ferrox_bg\.wasm\?url`\s*\)/g,
              `(await import("${wasm_path}?url"))`,
            )
          } else {
            // Dev mode: replace with /@fs/-prefixed path for Vite dev server.
            const fs_url = `/@fs${wasm_path.startsWith(`/`) ? `` : `/`}${wasm_path}`
            return code.replace(
              /await import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*`@catgo\/ferrox-wasm\/ferrox_bg\.wasm\?url`\s*\)/g,
              `({ default: "${fs_url}" })`,
            )
          }
        }
        return null
      },
    } satisfies Plugin,
    // [2025-02] Vite dev middleware: expose local filesystem for sql.js DB read/write.
    // Endpoints: /__db/read (GET), /__db/write (POST), /__db/browse (GET), /__db/copy (POST).
    // Only active in dev server (configureServer), not in production build.
    {
      name: `vite-plugin-db-fs`,
      configureServer(server) {
        const DB_EXTS = new Set([`.db`, `.sqlite`, `.sqlite3`])

        function resolve_path(raw: string): string {
          if (raw.startsWith(`~`)) {
            return resolve(homedir(), raw.slice(1).replace(/^[/\\]/, ``))
          }
          return resolve(raw)
        }

        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url!, `http://localhost`)

          if (url.pathname === `/__db/read`) {
            const p = resolve_path(url.searchParams.get(`path`) || ``)
            if (!existsSync(p)) {
              res.statusCode = 404
              res.end(`not found`)
              return
            }
            res.setHeader(`Content-Type`, `application/octet-stream`)
            res.end(readFileSync(p))
            return
          }

          if (url.pathname === `/__db/write` && req.method === `POST`) {
            const p = resolve_path(url.searchParams.get(`path`) || ``)
            const dir = dirname(p)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            const chunks: Buffer[] = []
            req.on(`data`, (c: Buffer) => chunks.push(c))
            req.on(`end`, () => {
              try {
                writeFileSync(p, Buffer.concat(chunks))
                res.setHeader(`Content-Type`, `application/json`)
                res.end(JSON.stringify({ ok: true }))
              } catch (e) {
                console.error(`[db-fs] Failed to write ${p}:`, e)
                res.statusCode = 500
                res.end(JSON.stringify({ ok: false, error: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__db/browse`) {
            const raw = url.searchParams.get(`dir`) || `~`
            res.setHeader(`Content-Type`, `application/json`)

            // Windows: list available drives when requesting __drives__
            if (raw === `__drives__` && platform() === `win32`) {
              try {
                const out = execSync(`wmic logicaldisk get name`, { encoding: `utf-8` })
                const drives = out.split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => /^[A-Z]:$/i.test(l))
                  .sort()
                const items = drives.map((d) => ({
                  name: d + `\\`,
                  type: `dir` as const,
                  path: d + `\\`,
                }))
                res.end(
                  JSON.stringify({ dir: `__drives__`, parent: `__drives__`, items }),
                )
              } catch {
                // Fallback: common drives
                const items = [`C:\\`, `D:\\`]
                  .filter((d) => existsSync(d))
                  .map((d) => ({ name: d, type: `dir` as const, path: d }))
                res.end(
                  JSON.stringify({ dir: `__drives__`, parent: `__drives__`, items }),
                )
              }
              return
            }

            const target = resolve_path(raw)
            if (!existsSync(target) || !statSync(target).isDirectory()) {
              res.statusCode = 400
              res.end(`not a directory`)
              return
            }
            const entries = readdirSync(target, { withFileTypes: true })
              .filter((e) => !e.name.startsWith(`.`))
              .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
              })
            const items = entries
              .filter((e) =>
                e.isDirectory() || DB_EXTS.has(extname(e.name).toLowerCase())
              )
              .map((e) => ({
                name: e.name,
                type: e.isDirectory() ? `dir` as const : `file` as const,
                path: resolve(target, e.name),
              }))
            // On Windows, when at drive root (e.g. C:\), parent should go to drives list
            const parent = dirname(target)
            const parent_val = (platform() === `win32` && parent === target)
              ? `__drives__`
              : parent
            res.end(JSON.stringify({ dir: target, parent: parent_val, items }))
            return
          }

          // [2026-03] General filesystem browse (all files, not filtered to .db)
          if (url.pathname === `/__files/browse`) {
            const raw = url.searchParams.get(`dir`) || `~`
            res.setHeader(`Content-Type`, `application/json`)

            // Windows drives list
            if (raw === `__drives__` && platform() === `win32`) {
              try {
                const out = execSync(`wmic logicaldisk get name`, { encoding: `utf-8` })
                const drives = out.split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => /^[A-Z]:$/i.test(l))
                  .sort()
                const items = drives.map((d) => ({
                  name: d + `\\`,
                  type: `dir` as const,
                  path: d + `\\`,
                }))
                res.end(
                  JSON.stringify({ dir: `__drives__`, parent: `__drives__`, items }),
                )
              } catch {
                const items = [`C:\\`, `D:\\`]
                  .filter((d) => existsSync(d))
                  .map((d) => ({ name: d, type: `dir` as const, path: d }))
                res.end(
                  JSON.stringify({ dir: `__drives__`, parent: `__drives__`, items }),
                )
              }
              return
            }

            const target = resolve_path(raw)
            if (!existsSync(target) || !statSync(target).isDirectory()) {
              res.statusCode = 400
              res.end(`not a directory`)
              return
            }
            const entries = readdirSync(target, { withFileTypes: true })
              .filter((e) => !e.name.startsWith(`.`))
              .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
              })
            const items = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? `dir` as const : `file` as const,
              path: resolve(target, e.name),
            }))
            const parent = dirname(target)
            const parent_val = (platform() === `win32` && parent === target)
              ? `__drives__`
              : parent
            res.end(JSON.stringify({ dir: target, parent: parent_val, items }))
            return
          }

          // [2026-03] Read any text file
          if (url.pathname === `/__files/read`) {
            const p = resolve_path(url.searchParams.get(`path`) || ``)
            if (!existsSync(p) || statSync(p).isDirectory()) {
              res.statusCode = 404
              res.end(`not found`)
              return
            }
            try {
              const content = readFileSync(p, `utf-8`)
              res.setHeader(`Content-Type`, `application/json`)
              res.end(JSON.stringify({ path: p, name: basename(p), content }))
            } catch {
              res.statusCode = 400
              res.end(`cannot read file`)
            }
            return
          }

          // [2026-05] Serve raw file bytes (images, pdf, binaries) so the
          // browser/web build can load local files natively via <img src> /
          // <embed> instead of Tauri-only fs reads. Parallel + browser-cached,
          // so markdown images load instantly like a native preview.
          if (url.pathname === `/__files/raw`) {
            const p = resolve_path(url.searchParams.get(`path`) || ``)
            if (!existsSync(p) || statSync(p).isDirectory()) {
              res.statusCode = 404
              res.end(`not found`)
              return
            }
            try {
              const ext = (p.split(`.`).pop() || ``).toLowerCase()
              const mime: Record<string, string> = {
                png: `image/png`,
                jpg: `image/jpeg`,
                jpeg: `image/jpeg`,
                gif: `image/gif`,
                webp: `image/webp`,
                bmp: `image/bmp`,
                svg: `image/svg+xml`,
                ico: `image/x-icon`,
                tif: `image/tiff`,
                tiff: `image/tiff`,
                pdf: `application/pdf`,
              }
              res.setHeader(`Content-Type`, mime[ext] || `application/octet-stream`)
              res.setHeader(`Cache-Control`, `no-cache`)
              res.end(readFileSync(p))
            } catch {
              res.statusCode = 400
              res.end(`cannot read file`)
            }
            return
          }

          // [2026-03] Write text content to a file
          if (url.pathname === `/__files/write` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { path: fp, content } = JSON.parse(body)
                const target = resolve_path(fp)
                const dir = dirname(target)
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
                writeFileSync(target, content, `utf-8`)
                res.setHeader(`Content-Type`, `application/json`)
                res.end(JSON.stringify({ path: target, name: basename(target) }))
              } catch (e) {
                res.statusCode = 500
                res.end(`write failed: ${e}`)
              }
            })
            return
          }

          // [2026-03] File operations: mkdir, delete, rename, copy, move
          if (url.pathname === `/__files/mkdir` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { path: fp } = JSON.parse(body)
                const target = resolve_path(fp)
                if (!existsSync(target)) mkdirSync(target, { recursive: true })
                res.setHeader(`Content-Type`, `application/json`)
                res.end(JSON.stringify({ success: true, message: `Created ${target}` }))
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({ success: false, message: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__files/delete` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { path: fp } = JSON.parse(body)
                const target = resolve_path(fp)
                // Safety: refuse to delete paths with depth < 2
                const parts = target.split(/[\\/]/).filter(Boolean)
                if (parts.length < 2) {
                  res.statusCode = 400
                  res.end(JSON.stringify({ success: false, message: `Path too shallow` }))
                  return
                }
                if (!existsSync(target)) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ success: false, message: `Not found` }))
                  return
                }
                rmSync(target, { recursive: true, force: true })
                res.setHeader(`Content-Type`, `application/json`)
                res.end(
                  JSON.stringify({
                    success: true,
                    message: `Deleted ${basename(target)}`,
                  }),
                )
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({ success: false, message: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__files/rename` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { old_path, new_path } = JSON.parse(body)
                const src = resolve_path(old_path)
                const dst = resolve_path(new_path)
                if (!existsSync(src)) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ success: false, message: `Not found` }))
                  return
                }
                renameSync(src, dst)
                res.setHeader(`Content-Type`, `application/json`)
                res.end(
                  JSON.stringify({
                    success: true,
                    message: `Renamed to ${basename(dst)}`,
                  }),
                )
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({ success: false, message: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__files/copy` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { source, destination } = JSON.parse(body)
                const src = resolve_path(source)
                const dst = resolve_path(destination)
                if (!existsSync(src)) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ success: false, message: `Not found` }))
                  return
                }
                cpSync(src, dst, { recursive: true })
                res.setHeader(`Content-Type`, `application/json`)
                res.end(
                  JSON.stringify({
                    success: true,
                    message: `Copied to ${basename(dst)}`,
                  }),
                )
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({ success: false, message: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__files/move` && req.method === `POST`) {
            let body = ``
            req.on(`data`, (c: Buffer) => {
              body += c.toString()
            })
            req.on(`end`, () => {
              try {
                const { source, destination } = JSON.parse(body)
                const src = resolve_path(source)
                const dst = resolve_path(destination)
                if (!existsSync(src)) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ success: false, message: `Not found` }))
                  return
                }
                renameSync(src, dst)
                res.setHeader(`Content-Type`, `application/json`)
                res.end(
                  JSON.stringify({ success: true, message: `Moved to ${basename(dst)}` }),
                )
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({ success: false, message: `${e}` }))
              }
            })
            return
          }

          if (url.pathname === `/__db/copy` && req.method === `POST`) {
            const src = resolve_path(url.searchParams.get(`src`) || ``)
            const dst = resolve_path(url.searchParams.get(`dst`) || ``)
            if (!existsSync(src)) {
              res.statusCode = 404
              res.end(`source not found`)
              return
            }
            const dir = dirname(dst)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            copyFileSync(src, dst)
            res.setHeader(`Content-Type`, `application/json`)
            res.end(JSON.stringify({ ok: true }))
            return
          }

          next()
        })
      },
    } satisfies Plugin,
    // [2025-02] Node.js PTY via WebSocket for desktop:dev mode (no Python backend needed).
    // Uses node-pty (ConPTY on Windows) to create a real terminal session, piped over
    // WebSocket with the same JSON protocol as the Python backend.
    {
      name: `vite-plugin-pty`,
      configureServer(server) {
        // ====== Shell detection ======
        interface ShellInfo {
          id: string
          label: string
          command: string
          args: string[]
        }

        function detect_shells(): ShellInfo[] {
          const shells: ShellInfo[] = []
          if (platform() === `win32`) {
            // PowerShell (always available on Windows)
            shells.push({
              id: `powershell`,
              label: `PowerShell`,
              command: `powershell.exe`,
              args: [`-NoLogo`],
            })
            // PowerShell 7 (pwsh)
            try {
              execFileSync(`pwsh.exe`, [`-Version`], { stdio: `ignore`, timeout: 3000 })
              shells.push({
                id: `pwsh`,
                label: `PowerShell 7`,
                command: `pwsh.exe`,
                args: [`-NoLogo`],
              })
            } catch {}
            // Git Bash
            const git_bash_paths = [
              `C:\\Program Files\\Git\\bin\\bash.exe`,
              `C:\\Program Files (x86)\\Git\\bin\\bash.exe`,
            ]
            for (const p of git_bash_paths) {
              if (existsSync(p)) {
                shells.push({
                  id: `git-bash`,
                  label: `Git Bash`,
                  command: p,
                  args: [`--login`],
                })
                break
              }
            }
            // Also check PATH for bash.exe (Git Bash or MSYS2)
            if (!shells.some((s) => s.id === `git-bash`)) {
              try {
                execFileSync(`bash.exe`, [`--version`], {
                  stdio: `ignore`,
                  timeout: 3000,
                })
                shells.push({
                  id: `git-bash`,
                  label: `Git Bash`,
                  command: `bash.exe`,
                  args: [`--login`],
                })
              } catch {}
            }
            // Command Prompt
            shells.push({
              id: `cmd`,
              label: `Command Prompt`,
              command: `cmd.exe`,
              args: [],
            })
            // WSL
            try {
              execFileSync(`wsl.exe`, [`--status`], { stdio: `ignore`, timeout: 3000 })
              shells.push({ id: `wsl`, label: `WSL`, command: `wsl.exe`, args: [] })
            } catch {}
          } else {
            // Unix: check common shells
            const user_shell = process.env.SHELL || `/bin/bash`
            const user_shell_name = basename(user_shell)
            shells.push({
              id: user_shell_name,
              label: user_shell_name,
              command: user_shell,
              args: [`-l`],
            })
            // Add other known shells if present and not already the user shell
            for (
              const [id, path] of [[`bash`, `/bin/bash`], [`zsh`, `/bin/zsh`], [
                `fish`,
                `/usr/bin/fish`,
              ]] as const
            ) {
              if (existsSync(path) && path !== user_shell) {
                shells.push({ id, label: id, command: path, args: [`-l`] })
              }
            }
          }
          return shells
        }

        // Cache detected shells (no need to re-detect each request)
        const available_shells = detect_shells()

        // ====== HTTP endpoint for shell list ======
        server.middlewares.use((req, res, next) => {
          if (req.url === `/api/pty/shells`) {
            res.setHeader(`Content-Type`, `application/json`)
            res.end(
              JSON.stringify(available_shells.map((s) => ({ id: s.id, label: s.label }))),
            )
            return
          }
          next()
        })

        // ====== WebSocket PTY sessions ======
        // Lazy-init WebSocketServer after httpServer is created
        server.httpServer?.once(`listening`, () => {
          const wss = new WebSocketServer({ noServer: true })

          server.httpServer!.on(`upgrade`, (req, socket, head) => {
            // Only handle /api/pty/session — let Vite HMR handle its own WS
            if (req.url === `/api/pty/session`) {
              wss.handleUpgrade(
                req,
                socket,
                head,
                (ws) => wss.emit(`connection`, ws, req),
              )
            }
          })

          let pty_id_counter = 0

          wss.on(`connection`, (ws: WsWebSocket) => {
            let ptyProcess: nodePty.IPty | null = null
            let session_id = 0

            ws.on(`message`, (raw) => {
              try {
                const msg = JSON.parse(raw.toString())

                if (msg.action === `open`) {
                  session_id = ++pty_id_counter

                  // Resolve shell from client request or use default
                  const requested_shell_id = msg.shell as string | undefined
                  const shell_info = (requested_shell_id
                    ? available_shells.find((s) =>
                      s.id === requested_shell_id
                    )
                    : undefined) || available_shells[0]

                  ptyProcess = nodePty.spawn(shell_info.command, shell_info.args, {
                    name: `xterm-256color`,
                    cols: msg.cols || 80,
                    rows: msg.rows || 24,
                    env: process.env as Record<string, string>,
                  })

                  ws.send(JSON.stringify({ type: `opened`, id: session_id }))

                  ptyProcess.onData((data: string) => {
                    if (ws.readyState === ws.OPEN) {
                      const encoded = Buffer.from(data, `utf-8`).toString(`base64`)
                      ws.send(JSON.stringify({ type: `output`, data: encoded }))
                    }
                  })

                  ptyProcess.onExit(() => {
                    if (ws.readyState === ws.OPEN) {
                      ws.send(JSON.stringify({ type: `closed` }))
                    }
                    ptyProcess = null
                  })
                } else if (msg.action === `input` && ptyProcess) {
                  ptyProcess.write(msg.data)
                } else if (msg.action === `resize` && ptyProcess) {
                  ptyProcess.resize(msg.cols || 80, msg.rows || 24)
                } else if (msg.action === `close`) {
                  ptyProcess?.kill()
                  ptyProcess = null
                }
              } catch (err) {
                console.error(`[vite-pty] Error:`, err)
              }
            })

            ws.on(`close`, () => {
              ptyProcess?.kill()
              ptyProcess = null
            })
          })
        })
      },
    } satisfies Plugin,
    agentBridgePlugin(srv_port),
    // On mobile dev, inject component CSS via JS (emitCss: false) instead of
    // separate `?type=style&lang.css` chunks. Those split-CSS chunks race on
    // cold load over the LAN — the browser can request a component's CSS before
    // its transform has populated the CSS cache, so vite-plugin-svelte hands
    // PostCSS the *script* → "[postcss] Unknown word" overlay (e.g. on the large,
    // lazily-loaded NodeConfigPanel). Desktop + production keep emitCss on.
    svelte(tauri_dev_host ? { emitCss: false } : {}),
    yaml(),
    {
      name: `vite-plugin-cloudflare-redirects`,
      apply: `build`,
      closeBundle() {
        const outDir = resolve(__dirname, `build-desktop`)
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
        writeFileSync(resolve(outDir, `_redirects`), `/* /index.html 200\n`)
      },
    },
  ],

  root: `desktop`,

  // The default publicDir would be desktop/public (relative to root).
  // Point it to the project-level static/ dir so MediaPipe WASM models,
  // hand_landmarker.task, and other shared assets are served correctly.
  publicDir: resolve(__dirname, `static`),

  build: {
    outDir: `../build-desktop`,
    emptyOutDir: true,
    target: `esnext`,
  },

  resolve: {
    alias: {
      '$lib': resolve(__dirname, `src/lib`),
      '$site': resolve(__dirname, `src/site`),
      '$root': resolve(__dirname, `.`),
      // Mock SvelteKit modules for standalone build
      '$app/environment': resolve(__dirname, `desktop/mocks/environment.ts`),
      '$app/navigation': resolve(__dirname, `desktop/mocks/navigation.ts`),
      '$app/stores': resolve(__dirname, `desktop/mocks/stores.ts`),
      // Workspace package alias
      '@catgo/ferrox-wasm/ferrox_bg.wasm': resolve(
        __dirname,
        `extensions/rust-wasm/pkg/ferrox_bg.wasm`,
      ),
      '@catgo/ferrox-wasm': resolve(__dirname, `extensions/rust-wasm`),
    },
  },

  server: {
    // Mobile: bind ALL interfaces (0.0.0.0), not just the LAN IP. The device
    // reaches Vite over the LAN, but Tauri's own dev-server readiness poll hits
    // `devUrl` (http://localhost:3100). Binding to only `tauri_dev_host` leaves
    // localhost unserved → Tauri "Could not connect ... after 180s". 0.0.0.0
    // serves both. HMR still derives from tauri_dev_host (see hmr below).
    host: tauri_dev_host ? `0.0.0.0` : `127.0.0.1`,
    port: desktop_port,
    strictPort: true,
    fs: { strict: false },
    // Point the HMR client at the LAN dev server explicitly — without an
    // explicit clientPort it tries port 80 (ws://<host>/) first, fails, and
    // only then falls back. clientPort pins it to the actual dev-server port.
    ...(tauri_dev_host
      ? { hmr: { protocol: `ws`, host: tauri_dev_host, clientPort: desktop_port } }
      : {}),
  },

  define: {
    ...shared_define(srv_port),
    __CATGO_DESKTOP__: `true`, // [2025-02] detected by project.ts/workflow.ts → import db-wasm.ts
    __CATGO_STATIC_ONLY__: JSON.stringify(!!process.env.VITE_STATIC_ONLY),
  },
})
