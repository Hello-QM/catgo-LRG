#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const VSCODE_SIDECAR_ASSETS = Object.freeze([
  'catgo-server-linux-x64',
  'catgo-server-darwin-arm64',
  'catgo-server-win-x64.exe',
])

export function parseSidecarChecksum(contents, expectedAsset) {
  const match = /^([0-9a-f]{64}) {2}([^\r\n]+)(?:\r?\n)?$/i.exec(contents)
  if (!match || match[2] !== expectedAsset) {
    throw new Error(`malformed checksum metadata for ${expectedAsset}`)
  }
  return match[1].toLowerCase()
}

function normalizedBaseUrl(raw) {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('sidecar public base URL must be credential-free HTTPS')
  }
  return parsed.toString().replace(/\/$/, '')
}

async function checkedFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    redirect: 'error',
    ...options,
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`)
  }
  return response
}

export async function verifyVscodeSidecars({
  version,
  baseUrl = 'https://dl.catgo-ucsd.org',
  fetchImpl = fetch,
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`invalid extension version: ${version ?? '<missing>'}`)
  }

  const base = normalizedBaseUrl(baseUrl)
  const prefix = `${base}/v${version}`
  const verified = []

  for (const asset of VSCODE_SIDECAR_ASSETS) {
    const binaryUrl = `${prefix}/${asset}`
    const checksumUrl = `${binaryUrl}.sha256`
    const checksumResponse = await checkedFetch(fetchImpl, checksumUrl, {
      headers: { accept: 'text/plain' },
    })
    const digest = parseSidecarChecksum(await checksumResponse.text(), asset)

    const binaryResponse = await checkedFetch(fetchImpl, binaryUrl, {
      method: 'HEAD',
    })
    const contentLength = Number(binaryResponse.headers.get('content-length'))
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new Error(`missing or invalid Content-Length for ${binaryUrl}`)
    }

    verified.push({ asset, digest, contentLength })
  }

  return verified
}

async function extensionVersion() {
  const packageJson = JSON.parse(
    await readFile(resolve(ROOT, 'extensions/vscode/package.json'), 'utf8'),
  )
  return packageJson.version
}

async function main() {
  const version = process.env.CATGO_VSCODE_SIDECAR_VERSION || await extensionVersion()
  const baseUrl = process.env.CATGO_RELEASE_PUBLIC_BASE_URL || 'https://dl.catgo-ucsd.org'
  const verified = await verifyVscodeSidecars({ version, baseUrl })
  for (const item of verified) {
    console.log(
      `verified v${version}/${item.asset} (${item.contentLength} bytes, sha256 ${item.digest})`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`VS Code sidecar availability check failed: ${error.message}`)
    process.exitCode = 1
  })
}
