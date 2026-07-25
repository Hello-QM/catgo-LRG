#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { syncLegalBundle } from './sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_VERSION = [1, 4, 6]
const DEFAULT_PUBLIC_BASE_URL = 'https://dl.catgo-ucsd.org'
const APP_ASSET =
  /\.(?:appimage|deb|dmg|exe|msi|pkg|rpm|apk|aab|ipa|vsix)$/i

function parseVersionTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  if (!match) throw new Error(`Invalid CatGo release tag: ${tag}`)
  return match.slice(1).map(Number)
}

export function requiresNoncommercialBundle(tag) {
  const version = parseVersionTag(tag)
  for (let index = 0; index < MIGRATION_VERSION.length; index += 1) {
    if (version[index] !== MIGRATION_VERSION[index]) {
      return version[index] > MIGRATION_VERSION[index]
    }
  }
  return true
}

function parseArgs(argv) {
  const values = new Map()
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (!['--tag', '--assets-dir', '--source-root'].includes(arg) || !argv[index + 1]) {
      throw new Error(
        'Usage: verify-mirrored-release.mjs --tag <vX.Y.Z> ' +
          '--assets-dir <directory> --source-root <tag checkout> [--json]',
      )
    }
    values.set(arg, argv[index + 1])
    index += 1
  }
  for (const required of ['--tag', '--assets-dir', '--source-root']) {
    if (!values.has(required)) throw new Error(`Missing required argument: ${required}`)
  }
  return {
    tag: values.get('--tag'),
    assetsDir: resolve(values.get('--assets-dir')),
    sourceRoot: resolve(values.get('--source-root')),
    json,
  }
}

function publicBaseUrl(value) {
  let base
  try {
    base = new URL(value)
  } catch (error) {
    throw new Error(`Invalid Cloudflare public base URL: ${error.message}`)
  }
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.hostname === 'github.com' ||
    base.hostname.endsWith('.github.com')
  ) {
    throw new Error(`Invalid Cloudflare public base URL: ${value}`)
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  return base
}

function verifyUpdaterUrls(latest, tag, baseUrl) {
  const expectedVersion = tag.slice(1)
  if (latest.version !== expectedVersion) {
    throw new Error(
      `latest.json version ${String(latest.version)} does not match ` +
        `mirrored release version ${expectedVersion}`,
    )
  }

  const base = publicBaseUrl(baseUrl)
  const expectedPath = `${base.pathname}${tag}/`
  for (const [platform, metadata] of Object.entries(latest.platforms)) {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      typeof metadata.url !== 'string' ||
      metadata.url.length === 0
    ) {
      throw new Error(`latest.json updater URL is missing for ${platform}`)
    }

    let updater
    try {
      updater = new URL(metadata.url)
    } catch (error) {
      throw new Error(
        `latest.json updater URL for ${platform} is invalid: ${error.message}`,
      )
    }
    if (
      updater.protocol !== 'https:' ||
      updater.origin !== base.origin ||
      updater.username ||
      updater.password
    ) {
      throw new Error(
        `latest.json updater URL for ${platform} must use Cloudflare base ` +
          `${base.origin}`,
      )
    }
    if (
      !updater.pathname.startsWith(expectedPath) ||
      updater.search ||
      updater.hash
    ) {
      throw new Error(
        `latest.json updater URL for ${platform} must target exact release ` +
          `path ${base.origin}${expectedPath}`,
      )
    }

    const encodedAsset = updater.pathname.slice(expectedPath.length)
    let asset
    try {
      asset = decodeURIComponent(encodedAsset)
    } catch (error) {
      throw new Error(
        `latest.json updater URL for ${platform} has an invalid asset path: ` +
          error.message,
      )
    }
    if (!asset || asset.includes('/') || asset.includes('\\')) {
      throw new Error(
        `latest.json updater URL for ${platform} must target one release asset`,
      )
    }
  }
}

function verifyAppAssets(assetsDir, tag, baseUrl) {
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    throw new Error(`Release assets directory does not exist: ${assetsDir}`)
  }
  const latestPath = resolve(assetsDir, 'latest.json')
  if (!existsSync(latestPath)) throw new Error('Release is missing latest.json')
  let latest
  try {
    latest = JSON.parse(readFileSync(latestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Release latest.json is invalid: ${error.message}`)
  }
  if (
    !latest.platforms ||
    typeof latest.platforms !== 'object' ||
    Array.isArray(latest.platforms) ||
    Object.keys(latest.platforms).length === 0
  ) {
    throw new Error('Release latest.json has no updater platforms')
  }
  verifyUpdaterUrls(latest, tag, baseUrl)
  const assets = readdirSync(assetsDir)
  if (!assets.some((name) => APP_ASSET.test(name))) {
    throw new Error('Release has no recognized CatGo app asset')
  }
}

function assertSafeTarListing(archive) {
  const result = spawnSync('tar', ['tzf', archive], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Cannot list legal archive: ${result.stderr || result.stdout}`)
  }
  for (const raw of result.stdout.split('\n').filter(Boolean)) {
    const path = raw.replace(/^\.\/+/, '')
    if (
      raw.startsWith('/') ||
      raw.includes('\\') ||
      path.split('/').some((part) => part === '..')
    ) {
      throw new Error(`Unsafe path in legal archive: ${raw}`)
    }
  }
}

function fileInventory(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const rel = relative(root, path)
      if (rel.startsWith(`..${sep}`) || rel === '..') {
        throw new Error(`Inventory escaped legal root: ${path}`)
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in legal bundle: ${rel}`)
      }
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(rel)
      else throw new Error(`Unsupported legal bundle entry: ${rel}`)
    }
  }
  visit(root)
  return files.sort()
}

function verifyLegalArchive(assetsDir, sourceRoot) {
  const archive = resolve(assetsDir, 'catgo-legal-bundle.tar.gz')
  if (!existsSync(archive) || lstatSync(archive).isSymbolicLink()) {
    throw new Error('Release is missing catgo-legal-bundle.tar.gz')
  }
  assertSafeTarListing(archive)

  const temporary = mkdtempSync(resolve(tmpdir(), 'catgo-r2-legal-'))
  const expected = resolve(temporary, 'expected')
  const extracted = resolve(temporary, 'extracted')
  try {
    syncLegalBundle(expected, { sourceRoot })
    mkdirSync(extracted)
    const extraction = spawnSync('tar', ['xzf', archive, '-C', extracted], {
      encoding: 'utf8',
    })
    if (extraction.status !== 0) {
      throw new Error(
        `Cannot extract legal archive: ${extraction.stderr || extraction.stdout}`,
      )
    }

    const expectedFiles = fileInventory(expected)
    const actualFiles = fileInventory(extracted)
    assert.deepEqual(
      actualFiles,
      expectedFiles,
      'release legal archive file manifest does not match target tag',
    )
    for (const file of expectedFiles) {
      assert.deepEqual(
        readFileSync(resolve(extracted, file)),
        readFileSync(resolve(expected, file)),
        `release legal archive content mismatch: ${file}`,
      )
    }
  } catch (error) {
    throw new Error(`Legal archive does not match target tag: ${error.message}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function verifyMirroredRelease({
  tag,
  assetsDir,
  sourceRoot,
  baseUrl = process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
}) {
  const ncl = requiresNoncommercialBundle(tag)
  verifyAppAssets(assetsDir, tag, baseUrl)
  if (ncl) verifyLegalArchive(assetsDir, sourceRoot)
  return {
    tag,
    policy: ncl ? 'ncl-1.4.6-or-later' : 'historical-pre-1.4.6',
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = verifyMirroredRelease(options)
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `[release-verify] ${report.tag}: ${report.policy}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[release-verify] ${error.message}\n`)
    process.exitCode = 1
  }
}
