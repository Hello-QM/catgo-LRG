/**
 * Lazy sidecar download.
 *
 * The bundled catgo-server binary is 463 MB — too large to ship inside a
 * VS Code Marketplace .vsix (size limit ~100 MB). Instead the extension
 * ships without the binary and pulls the platform-appropriate sidecar
 * from the matching GitHub Release on first activate, stores it under
 * `context.globalStorageUri/bin/<filename>`, and reuses that on every
 * subsequent launch.
 *
 * If a binary is found bundled inside the .vsix at `extensionPath/bin/`
 * (e.g. when packaged via `vsce package` locally for dev / sideload),
 * that one is used unchanged — the download path only kicks in when no
 * bundled binary exists.
 */

import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as path from 'node:path'
import * as vscode from 'vscode'

import pkg_json from '../package.json' with { type: 'json' }

export function get_binary_name(): string {
  const platform = process.platform
  if (platform === 'win32') return 'catgo-server-win-x64.exe'
  if (platform === 'darwin') return 'catgo-server-darwin-arm64'
  return 'catgo-server-linux-x64'
}

/**
 * Sidecar binaries are only built for win-x64, darwin-arm64, and linux-x64
 * (see .github/workflows/build-vscode-sidecars.yml). On anything else —
 * notably Intel Macs, which cannot run the arm64 binary (Rosetta only
 * translates the other direction) — fail with a clear message instead of
 * downloading 463 MB that will never start.
 */
export function unsupported_platform_reason(): string | null {
  const { platform, arch } = process
  if (platform === 'darwin' && arch !== 'arm64') {
    return 'CatGo\'s bundled server is only built for Apple Silicon (arm64) Macs. ' +
      'Intel Macs are not supported by the VS Code extension — use the CatGo ' +
      'desktop app or run the Python server from source instead.'
  }
  if (platform === 'win32' && arch !== 'x64') {
    return `CatGo's bundled server is only built for x64 Windows (this machine is ${arch}).`
  }
  if (platform === 'linux' && arch !== 'x64') {
    return `CatGo's bundled server is only built for x64 Linux (this machine is ${arch}).`
  }
  return null
}

function bundled_binary_path(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'bin', get_binary_name())
}

function downloaded_binary_path(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'bin', get_binary_name())
}

function release_url(version: string): string {
  const repo = `Hello-QM/catgo-LRG`
  return `https://github.com/${repo}/releases/download/v${version}/${get_binary_name()}`
}

async function file_exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function follow_redirect_download(
  url: string,
  dest: string,
  on_progress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  const file = fs.createWriteStream(tmp)

  const issue = (target: string, redirects_remaining: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const lib = target.startsWith(`https:`) ? https : http
      const req = lib.get(
        target,
        { headers: { 'User-Agent': `catgo-vscode/${pkg_json.version}` } },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            if (redirects_remaining <= 0) {
              reject(new Error(`Too many redirects fetching ${url}`))
              return
            }
            res.resume()
            // GitHub Release downloads return relative location headers; resolve.
            const next = new URL(res.headers.location, target).toString()
            issue(next, redirects_remaining - 1).then(resolve, reject)
            return
          }
          if (status !== 200) {
            reject(new Error(`HTTP ${status} fetching ${url}`))
            return
          }
          const total = res.headers[`content-length`]
            ? Number.parseInt(res.headers[`content-length`] as string, 10)
            : null
          let downloaded = 0
          res.on(`data`, (chunk: Buffer) => {
            downloaded += chunk.length
            on_progress(downloaded, total)
          })
          res.pipe(file)
          file.on(`finish`, () => {
            file.close((err) => err ? reject(err) : resolve())
          })
          file.on(`error`, reject)
        },
      )
      req.on(`error`, reject)
    })

  try {
    await issue(url, 5)
    await fsp.rename(tmp, dest)
  } catch (err) {
    try { await fsp.unlink(tmp) } catch { /* best-effort */ }
    throw err
  }
}

/**
 * Resolve a usable sidecar binary path, downloading from GitHub Release if
 * neither the bundled binary nor a previously downloaded copy is present.
 *
 * Returns the absolute path to the binary (with executable bit set on
 * POSIX). Rejects if no binary can be obtained for the current platform.
 */
export async function ensure_sidecar_binary(
  context: vscode.ExtensionContext,
): Promise<string> {
  // User-provided binary takes precedence and skips the ~460MB download — the
  // escape hatch for offline / Remote-SSH hosts (scp the binary in once).
  const override_path = vscode.workspace
    .getConfiguration('catgo.server')
    .get<string>('sidecarPath', '')
    .trim()
  if (override_path) {
    if (!(await file_exists(override_path))) {
      const reason = `catgo.server.sidecarPath is set to "${override_path}" but no file exists there.`
      vscode.window.showErrorMessage(reason)
      throw new Error(reason)
    }
    if (process.platform !== `win32`) {
      try { await fsp.chmod(override_path, 0o755) } catch { /* not owner / already +x */ }
    }
    return override_path
  }

  const bundled = bundled_binary_path(context)
  if (await file_exists(bundled)) return bundled

  const downloaded = downloaded_binary_path(context)
  if (await file_exists(downloaded)) return downloaded

  const unsupported = unsupported_platform_reason()
  if (unsupported) {
    vscode.window.showErrorMessage(unsupported)
    throw new Error(unsupported)
  }

  const url = release_url(pkg_json.version)
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading CatGo server sidecar (${get_binary_name()})`,
      cancellable: false,
    },
    async (progress) => {
      let last_pct = 0
      try {
        await follow_redirect_download(url, downloaded, (got, total) => {
          if (!total) return
          const pct = Math.floor((got / total) * 100)
          if (pct === last_pct) return
          progress.report({
            message: `${pct}% (${Math.floor(got / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MB)`,
            increment: pct - last_pct,
          })
          last_pct = pct
        })
        if (process.platform !== `win32`) {
          await fsp.chmod(downloaded, 0o755)
        }
        return downloaded
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(
          `Failed to download CatGo server sidecar from ${url}: ${msg}. ` +
          `Manually place the binary at ${downloaded} and reload.`,
        )
        throw err
      }
    },
  )
}
