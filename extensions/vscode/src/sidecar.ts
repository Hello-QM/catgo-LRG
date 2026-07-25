/**
 * Lazy sidecar download.
 *
 * The bundled catgo-server binary is 463 MB — too large to ship inside a
 * VS Code Marketplace .vsix (size limit ~100 MB). Instead the extension
 * ships without the binary and pulls the platform-appropriate sidecar
 * and its SHA-256 metadata from the matching Cloudflare download path on
 * first activate. It stores the verified pair under
 * `context.globalStorageUri/bin/` and revalidates them before reuse.
 *
 * If a binary is found bundled inside the .vsix at `extensionPath/bin/`
 * (e.g. when packaged via `vsce package` locally for dev / sideload),
 * that one is used unchanged — the download path only kicks in when no
 * bundled binary exists.
 */

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import * as path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as vscode from 'vscode'

import pkg_json from '../package.json' with { type: 'json' }

const TRUSTED_SIDECAR_ORIGIN = `https://dl.catgo-ucsd.org`

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

export function sidecar_asset_urls(
  version: string,
  asset_name: string,
): { binary: string; checksum: string } {
  const binary = `https://dl.catgo-ucsd.org/v${version}/${asset_name}`
  return {
    binary,
    checksum: `${binary}.sha256`,
  }
}

function assert_trusted_sidecar_url(raw_url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw_url)
  } catch {
    throw new Error(`URL is not on the trusted HTTPS sidecar origin`)
  }
  if (
    parsed.origin !== TRUSTED_SIDECAR_ORIGIN ||
    parsed.protocol !== `https:` ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`URL is not on the trusted HTTPS sidecar origin`)
  }
  return parsed
}

export function assert_trusted_sidecar_urls(
  binary_url: string,
  checksum_url: string,
): void {
  assert_trusted_sidecar_url(binary_url)
  assert_trusted_sidecar_url(checksum_url)
}

export function resolve_trusted_sidecar_redirect(
  current_url: string,
  location: string,
): string {
  assert_trusted_sidecar_url(current_url)
  let redirected: URL
  try {
    redirected = new URL(location, current_url)
  } catch {
    throw new Error(`Malformed redirect Location from ${current_url}`)
  }
  return assert_trusted_sidecar_url(redirected.toString()).toString()
}

export function parse_sidecar_checksum(
  contents: string,
  expected_filename: string,
): string {
  const match = contents.match(
    /^([0-9a-fA-F]{64}) {2}([^\r\n]+)(?:\r?\n)?$/,
  )
  if (!match || match[2] !== expected_filename) {
    throw new Error(
      `Malformed checksum metadata for ${expected_filename}`,
    )
  }
  return match[1].toLowerCase()
}

async function file_exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

function assert_same_origin_url(
  raw_url: string,
  expected_origin: string,
): URL {
  let expected: URL
  let parsed: URL
  try {
    expected = new URL(expected_origin)
    parsed = new URL(raw_url)
  } catch {
    throw new Error(`Malformed request URL`)
  }
  if (
    ![`http:`, `https:`].includes(expected.protocol) ||
    parsed.origin !== expected.origin ||
    parsed.protocol !== expected.protocol ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`Redirect escaped the expected origin`)
  }
  return parsed
}

export async function request_same_origin_response(
  url: string,
  expected_origin: string,
  redirects_remaining = 5,
): Promise<http.IncomingMessage> {
  const parsed = assert_same_origin_url(url, expected_origin)
  return await new Promise((resolve, reject) => {
    const lib = parsed.protocol === `https:` ? https : http
    const request = lib.get(
      parsed,
      { headers: { 'User-Agent': `catgo-vscode/${pkg_json.version}` } },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirects_remaining <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`))
            return
          }
          let next: URL
          try {
            if (expected_origin === TRUSTED_SIDECAR_ORIGIN) {
              next = new URL(resolve_trusted_sidecar_redirect(
                parsed.toString(),
                response.headers.location,
              ))
            } else {
              next = new URL(response.headers.location, parsed)
              assert_same_origin_url(next.toString(), expected_origin)
            }
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : String(error)
            reject(new Error(`Malformed redirect Location: ${message}`))
            return
          }
          request_same_origin_response(
            next.toString(),
            expected_origin,
            redirects_remaining - 1,
          ).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`HTTP ${status} fetching ${url}`))
          return
        }
        resolve(response)
      },
    )
    request.on(`error`, reject)
  })
}

async function fetch_checksum_metadata(
  url: string,
  expected_origin: string,
): Promise<string> {
  const response = await request_same_origin_response(url, expected_origin)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.length
    if (received > 4096) {
      response.destroy()
      throw new Error(`Checksum metadata is unexpectedly large`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString(`utf8`)
}

async function remove_files(paths: string[]): Promise<void> {
  await Promise.all(paths.map(async (file_path) => {
    try {
      await fsp.unlink(file_path)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !(`code` in error) ||
        error.code !== `ENOENT`
      ) {
        throw error
      }
    }
  }))
}

async function sha256_file(file_path: string): Promise<string> {
  const hash = createHash(`sha256`)
  for await (const chunk of fs.createReadStream(file_path)) {
    hash.update(chunk)
  }
  return hash.digest(`hex`)
}

export async function stored_sidecar_is_verified(
  destination: string,
  asset_name: string,
): Promise<boolean> {
  return await with_target_lock(destination, async () => {
    return await stored_sidecar_is_verified_impl(destination, asset_name)
  })
}

async function stored_sidecar_is_verified_impl(
  destination: string,
  asset_name: string,
): Promise<boolean> {
  const receipt = `${destination}.sha256`
  const partials = [
    `${destination}.partial`,
    `${receipt}.partial`,
  ]
  try {
    const checksum_contents = await fsp.readFile(receipt, `utf8`)
    if (Buffer.byteLength(checksum_contents) > 4096) {
      throw new Error(`Checksum metadata is unexpectedly large`)
    }
    const expected_digest = parse_sidecar_checksum(
      checksum_contents,
      asset_name,
    )
    const actual_digest = await sha256_file(destination)
    if (actual_digest !== expected_digest) {
      throw new Error(`Cached sidecar checksum mismatch`)
    }
    await remove_files(partials)
    return true
  } catch {
    await remove_files([destination, receipt, ...partials])
    return false
  }
}

type DownloadVerifiedSidecarOptions = {
  binary_url: string
  checksum_url: string
  destination: string
  asset_name: string
  on_progress?: (downloaded: number, total: number | null) => void
}

const active_downloads = new Map<string, Promise<void>>()
const target_operations = new Map<string, Promise<void>>()

function with_target_lock<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const target = path.resolve(destination)
  const previous = target_operations.get(target) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  target_operations.set(target, tail)
  void tail.then(() => {
    if (target_operations.get(target) === tail) {
      target_operations.delete(target)
    }
  })
  return result
}

async function download_verified_sidecar_impl(
  options: DownloadVerifiedSidecarOptions,
  expected_origin: string,
): Promise<void> {
  const {
    binary_url,
    checksum_url,
    destination,
    asset_name,
    on_progress = () => {},
  } = options
  const receipt = `${destination}.sha256`
  const attempt_id = randomUUID()
  const partial = `${destination}.${attempt_id}.partial`
  const receipt_partial = `${receipt}.${attempt_id}.partial`
  const outputs = [destination, partial, receipt, receipt_partial]
  const legacy_partials = [
    `${destination}.partial`,
    `${receipt}.partial`,
  ]

  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await remove_files([...outputs, ...legacy_partials])

  try {
    const checksum_contents = await fetch_checksum_metadata(
      checksum_url,
      expected_origin,
    )
    const expected_digest = parse_sidecar_checksum(
      checksum_contents,
      asset_name,
    )
    const response = await request_same_origin_response(
      binary_url,
      expected_origin,
    )
    const content_length = response.headers[`content-length`]
    const parsed_length = typeof content_length === `string`
      ? Number.parseInt(content_length, 10)
      : Number.NaN
    const total = Number.isFinite(parsed_length) ? parsed_length : null
    const hash = createHash(`sha256`)
    let downloaded = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloaded += chunk.length
        hash.update(chunk)
        on_progress(downloaded, total)
        callback(null, chunk)
      },
    })

    await pipeline(
      response,
      meter,
      fs.createWriteStream(partial, { flags: `wx` }),
    )
    const actual_digest = hash.digest(`hex`)
    if (actual_digest !== expected_digest) {
      throw new Error(
        `SHA-256 mismatch for ${asset_name}: expected ${expected_digest}, got ${actual_digest}`,
      )
    }

    await fsp.writeFile(
      receipt_partial,
      `${expected_digest}  ${asset_name}\n`,
      { flag: `wx` },
    )
    await fsp.rename(partial, destination)
    await fsp.rename(receipt_partial, receipt)
  } catch (error) {
    await remove_files(outputs)
    throw error
  }
}

function coalesced_download(
  options: DownloadVerifiedSidecarOptions,
  expected_origin: string,
): Promise<void> {
  const target = path.resolve(options.destination)
  const active = active_downloads.get(target)
  if (active) return active

  const operation = with_target_lock(options.destination, async () => {
    await download_verified_sidecar_impl(options, expected_origin)
  })
  active_downloads.set(target, operation)
  const clear = () => {
    if (active_downloads.get(target) === operation) {
      active_downloads.delete(target)
    }
  }
  operation.then(clear, clear)
  return operation
}

export async function download_verified_sidecar(
  options: DownloadVerifiedSidecarOptions,
): Promise<void> {
  assert_trusted_sidecar_urls(options.binary_url, options.checksum_url)
  await coalesced_download(options, TRUSTED_SIDECAR_ORIGIN)
}

/** @internal Test seam for exercising the real downloader with a local origin. */
export async function download_verified_sidecar_from_origin(
  options: DownloadVerifiedSidecarOptions,
  expected_origin: string,
): Promise<void> {
  await coalesced_download(options, expected_origin)
}

/**
 * Resolve a usable sidecar binary path, downloading from Cloudflare if
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
  const asset_name = get_binary_name()
  if (await stored_sidecar_is_verified(downloaded, asset_name)) {
    return downloaded
  }

  const unsupported = unsupported_platform_reason()
  if (unsupported) {
    vscode.window.showErrorMessage(unsupported)
    throw new Error(unsupported)
  }

  const urls = sidecar_asset_urls(pkg_json.version, asset_name)
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading CatGo server sidecar (${asset_name})`,
      cancellable: false,
    },
    async (progress) => {
      let last_pct = 0
      try {
        await download_verified_sidecar({
          binary_url: urls.binary,
          checksum_url: urls.checksum,
          destination: downloaded,
          asset_name,
          on_progress: (got, total) => {
            if (!total) return
            const pct = Math.floor((got / total) * 100)
            if (pct === last_pct) return
            progress.report({
              message: `${pct}% (${Math.floor(got / 1024 / 1024)} / ${Math.floor(total / 1024 / 1024)} MB)`,
              increment: pct - last_pct,
            })
            last_pct = pct
          },
        })
        if (process.platform !== `win32`) {
          await fsp.chmod(downloaded, 0o755)
        }
        return downloaded
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(
          `Failed to download and verify CatGo server sidecar from ${urls.binary}: ${msg}. ` +
          `For an offline install, set catgo.server.sidecarPath to a trusted local binary.`,
        )
        throw err
      }
    },
  )
}
