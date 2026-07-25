#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ACKNOWLEDGEMENT =
  'This work used CatGo (https://catgo-ucsd.org).'

export const DEFAULT_TARGETS = [
  'build/legal-bundle',
  'static/legal',
  'docs/public/legal',
  'src-tauri/resources/legal',
]
export const OWNERSHIP_MARKER = '.catgo-legal-bundle-owned'

const CORE_SOURCES = [
  'license',
  'CITATION.cff',
  'THIRD_PARTY_NOTICES.md',
]
const MARKER_CONTENT = 'catgo-legal-bundle:v1\n'
const SYSTEM_TREES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
].map((path) => resolve(path))
const BROAD_EXACT_TARGETS = new Set([
  resolve(tmpdir()),
  resolve('/media'),
  resolve('/mnt'),
  resolve('/srv'),
])

function isInside(parent, candidate) {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function existingCanonicalPath(path) {
  let cursor = resolve(path)
  const missing = []
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return resolve(realpathSync(cursor), ...missing)
}

function ancestors(path) {
  const result = []
  let cursor = resolve(path)
  while (true) {
    result.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) return result
    cursor = parent
  }
}

function validateSource(sourceRoot, source) {
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    source.includes('\\') ||
    isAbsolute(source) ||
    source.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(`Refusing legal source traversal: ${source}`)
  }

  const canonicalRoot = realpathSync(resolve(sourceRoot))
  const sourcePath = resolve(canonicalRoot, source)
  if (!isInside(canonicalRoot, sourcePath)) {
    throw new Error(`Legal source resolves outside source root: ${source}`)
  }
  const sourceInfo = lstatSync(sourcePath)
  if (sourceInfo.isSymbolicLink()) {
    throw new Error(`Refusing symlinked legal source: ${source}`)
  }
  const canonicalSource = realpathSync(sourcePath)
  if (!isInside(canonicalRoot, canonicalSource) || !statSync(canonicalSource).isFile()) {
    throw new Error(`Legal source is outside source root or not a file: ${source}`)
  }
  return canonicalSource
}

function noticeLicenseSources(sourceRoot) {
  const noticesPath = validateSource(sourceRoot, 'THIRD_PARTY_NOTICES.md')
  const notices = readFileSync(noticesPath, 'utf8')
  const links = [...notices.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter(
      (path) =>
        path.startsWith('third_party/licenses/') ||
        path.endsWith('/LICENSE'),
    )
  return [...new Set(links)].sort()
}

export function legalBundleSources(sourceRoot = ROOT) {
  const canonicalRoot = realpathSync(resolve(sourceRoot))
  const sources = [...CORE_SOURCES, ...noticeLicenseSources(canonicalRoot)]
  for (const source of sources) validateSource(canonicalRoot, source)
  return sources
}

export function validateLegalBundleTarget(target) {
  const absolute = resolve(target)
  const canonical = existingCanonicalPath(absolute)
  const defaultPaths = DEFAULT_TARGETS.map((path) => resolve(ROOT, path))
  const isDefault = defaultPaths.includes(absolute)

  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Refusing symlinked legal-bundle target: ${absolute}`)
  }
  if (isDefault) {
    const canonicalRoot = realpathSync(ROOT)
    let cursor = ROOT
    for (const part of relative(ROOT, absolute).split(sep).filter(Boolean)) {
      cursor = resolve(cursor, part)
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Refusing symlinked default target path: ${cursor}`)
      }
    }
    if (!isInside(canonicalRoot, canonical)) {
      throw new Error(`Default legal-bundle target escaped repository: ${canonical}`)
    }
    return { destination: canonical, isDefault: true }
  }

  const protectedExact = new Set([
    ...ancestors(ROOT),
    ...ancestors(homedir()),
  ])
  if (
    protectedExact.has(canonical) ||
    BROAD_EXACT_TARGETS.has(canonical) ||
    canonical === parse(canonical).root ||
    SYSTEM_TREES.some((path) => isInside(path, canonical)) ||
    isInside(ROOT, absolute) ||
    isInside(ROOT, canonical)
  ) {
    throw new Error(`Refusing unsafe or protected legal-bundle target: ${canonical}`)
  }
  return { destination: canonical, isDefault: false }
}

function prepareDestination(target) {
  const { destination, isDefault } = validateLegalBundleTarget(target)
  if (existsSync(destination)) {
    if (!statSync(destination).isDirectory()) {
      throw new Error(`Legal-bundle target is not a directory: ${destination}`)
    }
    const entries = readdirSync(destination)
    const marker = resolve(destination, OWNERSHIP_MARKER)
    const owned =
      existsSync(marker) &&
      !lstatSync(marker).isSymbolicLink() &&
      statSync(marker).isFile() &&
      readFileSync(marker, 'utf8') === MARKER_CONTENT
    if (!isDefault && entries.length > 0 && !owned) {
      throw new Error(
        `Refusing non-owned non-empty legal-bundle target: ${destination}`,
      )
    }
    for (const entry of entries) {
      const child = resolve(destination, entry)
      if (!isInside(destination, child) || child === destination) {
        throw new Error(`Refusing unsafe generated child: ${child}`)
      }
      rmSync(child, { recursive: true, force: false })
    }
  } else {
    mkdirSync(destination, { recursive: true })
  }
  writeFileSync(resolve(destination, OWNERSHIP_MARKER), MARKER_CONTENT)
  return destination
}

export function syncLegalBundle(target, { sourceRoot = ROOT } = {}) {
  const canonicalSourceRoot = realpathSync(resolve(sourceRoot))
  const sources = legalBundleSources(canonicalSourceRoot)
  const destination = prepareDestination(target)

  for (const source of sources) {
    const sourcePath = validateSource(canonicalSourceRoot, source)
    const destinationPath = resolve(destination, source)
    if (!isInside(destination, destinationPath) || destinationPath === destination) {
      throw new Error(`Legal destination resolves outside target: ${source}`)
    }
    mkdirSync(dirname(destinationPath), { recursive: true })
    const canonicalParent = realpathSync(dirname(destinationPath))
    if (!isInside(destination, canonicalParent)) {
      throw new Error(`Legal destination parent escaped target: ${source}`)
    }
    copyFileSync(sourcePath, destinationPath)
  }

  writeFileSync(
    resolve(destination, 'ACKNOWLEDGEMENT.txt'),
    `${ACKNOWLEDGEMENT}\n`,
  )
  return destination
}

function parseOutputs(argv) {
  const outputs = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--output' || !argv[index + 1]) {
      throw new Error(`Usage: sync-legal-bundle.mjs [--output <directory>]`)
    }
    outputs.push(argv[index + 1])
    index += 1
  }
  return outputs
}

function main() {
  const requested = parseOutputs(process.argv.slice(2))
  const targets = requested.length
    ? requested.map((target) =>
        isAbsolute(target) ? target : resolve(ROOT, target),
      )
    : DEFAULT_TARGETS.map((target) => resolve(ROOT, target))

  for (const target of targets) {
    const staged = syncLegalBundle(target)
    process.stdout.write(
      `[legal-sync] ${relative(ROOT, staged) || staged}\n`,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
