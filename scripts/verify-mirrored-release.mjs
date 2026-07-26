#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from 'node:crypto'
import {
  createReadStream,
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
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  requiredUpdaterPlatforms,
  verifyRequiredReleaseAssets,
} from './release-asset-policy.mjs'
import { RELEASE_TRUST_POLICY } from './release-trust-policy.mjs'
import { syncLegalBundle } from './sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_VERSION = [1, 4, 6]
const DEFAULT_PUBLIC_BASE_URL = 'https://dl.catgo-ucsd.org'
const TAURI_UPDATER_ASSETS = [
  /^CatGo_\d+\.\d+\.\d+_(?:x64|aarch64)(?:_[A-Za-z0-9-]+)?(?:-setup)?\.(?:exe|msi)$/i,
  /^CatGo_(?:\d+\.\d+\.\d+_)?(?:aarch64|x64)\.app\.tar\.gz$/i,
  /^CatGo_\d+\.\d+\.\d+_(?:amd64|aarch64)\.(?:deb|AppImage(?:\.tar\.gz)?)$/i,
  /^CatGo-\d+\.\d+\.\d+-\d+\.(?:x86_64|aarch64)\.rpm$/i,
]
const SIDECAR_ASSETS = [
  'catgo-server-linux-x64',
  'catgo-server-darwin-arm64',
  'catgo-server-win-x64.exe',
]
const ED25519_SPKI_PREFIX = Buffer.from(
  '302a300506032b6570032100',
  'hex',
)
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function isTauriUpdaterAsset(asset) {
  return TAURI_UPDATER_ASSETS.some((pattern) => pattern.test(asset))
}

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
    base.origin !== DEFAULT_PUBLIC_BASE_URL ||
    base.pathname !== '/'
  ) {
    throw new Error(
      `Cloudflare public base URL must be exactly ${DEFAULT_PUBLIC_BASE_URL}`,
    )
  }
  return base
}

function decodeBase64(value, kind) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${kind} is not a non-empty base64 string`)
  }
  const unpadded = value.replace(/=+$/, '')
  const paddingLength = value.length - unpadded.length
  const expectedPadding = (4 - (unpadded.length % 4)) % 4
  if (
    !/^[A-Za-z0-9+/]+$/.test(unpadded) ||
    unpadded.length % 4 === 1 ||
    paddingLength > 2 ||
    (paddingLength > 0 &&
      (value.length % 4 !== 0 || paddingLength !== expectedPadding))
  ) {
    throw new Error(`${kind} is not valid base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64').replace(/=+$/, '') !== unpadded) {
    throw new Error(`${kind} is not canonical base64`)
  }
  return decoded
}

function decodeBase64Utf8(value, kind) {
  try {
    return UTF8_DECODER.decode(decodeBase64(value, kind))
  } catch (error) {
    throw new Error(`${kind} cannot be decoded: ${error.message}`)
  }
}

function parseMinisignPublicKey(encoded) {
  const text = decodeBase64Utf8(encoded, 'Tauri updater public key')
  const lines = text.split(/\r?\n/)
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment: ')) {
    throw new Error('Tauri updater public key has invalid minisign text')
  }
  const packet = decodeBase64(lines[1], 'minisign public key packet')
  if (packet.length !== 42) {
    throw new Error('minisign public key packet must be 42 bytes')
  }
  const algorithm = packet.subarray(0, 2).toString('ascii')
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`unsupported minisign public key algorithm: ${algorithm}`)
  }
  const rawKey = packet.subarray(10)
  let key
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    })
  } catch (error) {
    throw new Error(`invalid minisign Ed25519 public key: ${error.message}`)
  }
  return {
    key,
    keyId: packet.subarray(2, 10),
  }
}

function updaterPublicKey(sourceRoot, trustPolicy) {
  const configPath = resolve(sourceRoot, 'src-tauri/tauri.conf.json')
  if (!existsSync(configPath)) {
    throw new Error(
      `Target release source is missing Tauri updater config: ${configPath}`,
    )
  }
  const metadata = lstatSync(configPath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `Target release Tauri updater config must be a regular file: ${configPath}`,
    )
  }
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Target release Tauri updater config is invalid: ${error.message}`,
    )
  }
  const encoded = config?.plugins?.updater?.pubkey
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(
      'Target release Tauri updater config has no plugins.updater.pubkey',
    )
  }
  const approved = trustPolicy?.tauriUpdaterPubkey
  if (typeof approved !== 'string' || approved.length === 0) {
    throw new Error(
      'Trusted release policy has no approved Tauri updater public key',
    )
  }
  if (encoded !== approved) {
    throw new Error(
      'Target release Tauri updater public key does not match the approved ' +
        'default-branch trust policy',
    )
  }
  try {
    return parseMinisignPublicKey(approved)
  } catch (error) {
    throw new Error(
      `Target release Tauri updater public key is invalid: ${error.message}`,
    )
  }
}

function parseInlineTauriSignature(encoded, platform) {
  let text
  try {
    text = decodeBase64Utf8(
      encoded,
      `latest.json updater signature for ${platform}`,
    )
  } catch (error) {
    throw new Error(error.message)
  }
  const lines = text.split(/\r?\n/)
  if (
    lines.length < 4 ||
    !lines[0].startsWith('untrusted comment: ') ||
    !lines[2].startsWith('trusted comment: ')
  ) {
    throw new Error(
      `latest.json updater signature for ${platform} has invalid minisign text`,
    )
  }
  let primaryPacket
  let globalSignature
  try {
    primaryPacket = decodeBase64(
      lines[1],
      `minisign primary signature for ${platform}`,
    )
    globalSignature = decodeBase64(
      lines[3],
      `minisign global signature for ${platform}`,
    )
  } catch (error) {
    throw new Error(
      `latest.json updater signature for ${platform} is invalid: ${error.message}`,
    )
  }
  if (primaryPacket.length !== 74 || globalSignature.length !== 64) {
    throw new Error(
      `latest.json updater signature for ${platform} has invalid packet lengths`,
    )
  }
  const algorithm = primaryPacket.subarray(0, 2).toString('ascii')
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(
      `latest.json updater signature for ${platform} uses unsupported ` +
        `minisign algorithm: ${algorithm}`,
    )
  }
  return {
    algorithm,
    keyId: primaryPacket.subarray(2, 10),
    primary: primaryPacket.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    global: globalSignature,
  }
}

async function hashFile(path, algorithm) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest()
}

async function verifyUpdaterSignature({
  assetsDir,
  asset,
  metadata,
  platform,
  publicKey,
}) {
  const signature = parseInlineTauriSignature(metadata.signature, platform)
  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new Error(
      `latest.json updater signature key does not match target source ` +
        `updater key for ${platform}`,
    )
  }
  const artifact = requireRegularReleaseAsset(
    assetsDir,
    asset,
    'Tauri updater artifact',
  )
  const signedMessage =
    signature.algorithm === 'ED'
      ? await hashFile(artifact, 'blake2b512')
      : readFileSync(artifact)
  const primaryValid = verifyEd25519(
    null,
    signedMessage,
    publicKey.key,
    signature.primary,
  )
  const globalValid = verifyEd25519(
    null,
    Buffer.concat([
      signature.primary,
      Buffer.from(signature.trustedComment),
    ]),
    publicKey.key,
    signature.global,
  )
  if (!primaryValid || !globalValid) {
    throw new Error(
      `latest.json updater signature verification failed for ${platform}`,
    )
  }
}

async function verifyUpdaterUrls(
  latest,
  tag,
  baseUrl,
  assets,
  assetsDir,
  publicKey,
) {
  const expectedVersion = tag.slice(1)
  if (latest.version !== expectedVersion) {
    throw new Error(
      `latest.json version ${String(latest.version)} does not match ` +
        `mirrored release version ${expectedVersion}`,
    )
  }

  const base = publicBaseUrl(baseUrl)
  const expectedPath = `${base.pathname}${tag}/`
  const updaterAssets = new Map()
  for (const [platform, metadata] of Object.entries(latest.platforms)) {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      typeof metadata.url !== 'string' ||
      metadata.url.length === 0
    ) {
      throw new Error(`latest.json updater URL is missing for ${platform}`)
    }
    if (
      typeof metadata.signature !== 'string' ||
      metadata.signature.trim().length === 0
    ) {
      throw new Error(`latest.json updater signature is missing for ${platform}`)
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
    if (!isTauriUpdaterAsset(asset)) {
      throw new Error(
        `latest.json updater URL for ${platform} must target a recognized ` +
          `Tauri updater artifact: ${asset}`,
      )
    }
    if (!assets.has(asset)) {
      throw new Error(
        `latest.json updater URL for ${platform} targets missing release asset: ` +
          asset,
      )
    }
    await verifyUpdaterSignature({
      assetsDir,
      asset,
      metadata,
      platform,
      publicKey,
    })
    updaterAssets.set(platform, asset)
  }

  for (const requirement of requiredUpdaterPlatforms(tag)) {
    if (!updaterAssets.has(requirement.platform)) {
      throw new Error(
        `latest.json is missing required updater platform: ` +
          requirement.platform,
      )
    }
    const actualAsset = updaterAssets.get(requirement.platform)
    if (actualAsset !== requirement.asset) {
      throw new Error(
        `latest.json updater platform ${requirement.platform} must target ` +
          `${requirement.asset}; received ${actualAsset}`,
      )
    }
  }
}

async function verifyAppAssets(
  assetsDir,
  tag,
  baseUrl,
  sourceRoot,
  trustPolicy,
) {
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
  const assets = readdirSync(assetsDir)
  const assetNames = new Set(assets)
  const publicKey = updaterPublicKey(sourceRoot, trustPolicy)
  await verifyUpdaterUrls(
    latest,
    tag,
    baseUrl,
    assetNames,
    assetsDir,
    publicKey,
  )
  verifyRequiredReleaseAssets(assetNames, tag)
  if (!assets.some(isTauriUpdaterAsset)) {
    throw new Error('Release has no recognized Tauri updater artifact')
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function requireRegularReleaseAsset(assetsDir, name, kind) {
  const path = resolve(assetsDir, name)
  if (!existsSync(path)) {
    throw new Error(`Release is missing ${kind}: ${name}`)
  }
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Release ${kind} must be a regular file: ${name}`)
  }
  return path
}

export async function verifySidecarAssets(assetsDir) {
  for (const name of SIDECAR_ASSETS) {
    const binary = requireRegularReleaseAsset(
      assetsDir,
      name,
      'sidecar binary',
    )
    const receiptName = `${name}.sha256`
    const receipt = requireRegularReleaseAsset(
      assetsDir,
      receiptName,
      'sidecar checksum',
    )
    const contents = readFileSync(receipt, 'utf8')
    if (Buffer.byteLength(contents) > 4096) {
      throw new Error(`Sidecar checksum metadata is too large: ${receiptName}`)
    }
    const match = /^([0-9a-fA-F]{64}) {2}([^\r\n]+)(?:\r?\n)?$/.exec(contents)
    if (!match || match[2] !== name) {
      throw new Error(`Malformed sidecar checksum metadata: ${receiptName}`)
    }
    const expected = match[1].toLowerCase()
    const actual = await sha256File(binary)
    if (actual !== expected) {
      throw new Error(
        `Sidecar checksum mismatch for ${name}: expected ${expected}, got ${actual}`,
      )
    }
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

export async function verifyMirroredRelease(
  {
    tag,
    assetsDir,
    sourceRoot,
    baseUrl = process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
  },
  trustPolicy = RELEASE_TRUST_POLICY,
) {
  if (!requiresNoncommercialBundle(tag)) {
    throw new Error(
      `Historical release redistribution is disabled for ${tag} until ` +
        `documented redistribution rights clearance is available`,
    )
  }
  await verifyAppAssets(
    assetsDir,
    tag,
    baseUrl,
    sourceRoot,
    trustPolicy,
  )
  await verifySidecarAssets(assetsDir)
  verifyLegalArchive(assetsDir, sourceRoot)
  return {
    tag,
    policy: 'ncl-1.4.6-or-later',
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = await verifyMirroredRelease(options)
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `[release-verify] ${report.tag}: ${report.policy}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[release-verify] ${error.message}\n`)
    process.exitCode = 1
  })
}
