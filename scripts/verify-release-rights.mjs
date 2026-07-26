#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ACCEPTED_STATUSES = new Set(['CLEARED', 'NOTICE_BACKED'])

function parseRoot(args) {
  const rootIndex = args.indexOf('--root')
  return rootIndex === -1 ? ROOT : resolve(args[rootIndex + 1])
}

function machineReadableLedgers(provenanceRoot) {
  const ledgers = []
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix
        ? `${prefix}/${entry.name}`
        : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${relativePath}: symlinked provenance is not permitted`,
        )
      } else if (entry.isDirectory()) {
        visit(resolve(directory, entry.name), relativePath)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        ledgers.push(relativePath)
      }
    }
  }
  visit(provenanceRoot)
  return ledgers.sort()
}

function requiredProvenanceDirectory(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`${label}: provenance directory is missing`)
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label}: symlinked provenance directory is not permitted`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label}: provenance path must be a directory`)
  }
}

function provenanceDirectory(root) {
  const thirdParty = resolve(root, 'third_party')
  requiredProvenanceDirectory(thirdParty, 'third_party')
  const provenance = resolve(thirdParty, 'provenance')
  requiredProvenanceDirectory(provenance, 'third_party/provenance')
  return provenance
}

function safeRelativePath(root, value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}: path must be a non-empty string`)
  }
  if (value.includes('\\')) {
    throw new Error(`${label}: backslash paths are not permitted`)
  }
  if (isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`${label}: absolute paths are not permitted`)
  }

  const segments = value.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${label}: traversal segments are not permitted`)
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`${label}: empty path segments are not permitted`)
  }

  const rootPath = resolve(root)
  const absolutePath = resolve(rootPath, value)
  if (!absolutePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`${label}: path must stay inside the release root`)
  }

  let currentPath = rootPath
  for (const segment of segments) {
    currentPath = resolve(currentPath, segment)
    let stat
    try {
      stat = lstatSync(currentPath)
    } catch {
      throw new Error(`${label}: missing path: ${value}`)
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}: symlinked path segment is not permitted`)
    }
  }
  return absolutePath
}

function verifyNoticeFile(root, value, label) {
  const path = safeRelativePath(root, value, label)
  if (!lstatSync(path).isFile()) {
    throw new Error(`${label} must reference a regular file`)
  }
  return path
}

function verifyCoveredPath(root, value, label) {
  const coveredValue =
    typeof value === 'string' && value.endsWith('/') ? value.slice(0, -1) : value
  const path = safeRelativePath(root, coveredValue, label)
  const stat = lstatSync(path)
  if (stat.isFile()) {
    return [path]
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must reference a regular file or directory`)
  }

  const regularFiles = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name)
      const entryStat = lstatSync(entryPath)
      if (entryStat.isSymbolicLink()) {
        throw new Error(`${label} contains a symlinked entry`)
      }
      if (entryStat.isFile()) {
        regularFiles.push(entryPath)
      } else if (entryStat.isDirectory()) {
        visit(entryPath)
      } else {
        throw new Error(`${label} contains an unsupported entry`)
      }
    }
  }
  visit(path)
  if (regularFiles.length === 0) {
    throw new Error(`${label} must contain at least one regular file`)
  }
  return regularFiles
}

function verifyReleaseEvidence(root, ledger, record, files) {
  const evidence = record.releaseEvidence
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence)
  ) {
    throw new Error(`${ledger}: releaseEvidence must be an object`)
  }
  if (evidence.algorithm !== 'sha256sum-manifest-v1') {
    throw new Error(`${ledger}: release evidence algorithm is unsupported`)
  }
  if (!Number.isSafeInteger(evidence.fileCount) || evidence.fileCount < 1) {
    throw new Error(`${ledger}: release evidence fileCount is invalid`)
  }
  if (
    typeof evidence.manifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(evidence.manifestSha256)
  ) {
    throw new Error(`${ledger}: release evidence manifestSha256 is invalid`)
  }

  const relativeFiles = [...new Set(files.map((path) =>
    relative(root, path).split(sep).join('/')
  ))].sort()
  if (relativeFiles.length !== evidence.fileCount) {
    throw new Error(
      `${ledger}: release evidence fileCount expected ${evidence.fileCount} ` +
      `but found ${relativeFiles.length}`,
    )
  }
  const manifest = relativeFiles.map((path) => {
    const absolutePath = safeRelativePath(
      root,
      path,
      `${ledger}: release evidence`,
    )
    if (!lstatSync(absolutePath).isFile()) {
      throw new Error(
        `${ledger}: release evidence must reference only regular files`,
      )
    }
    const digest = createHash('sha256')
      .update(readFileSync(absolutePath))
      .digest('hex')
    return `${digest}  ${path}\n`
  }).join('')
  const actual = createHash('sha256').update(manifest).digest('hex')
  if (actual !== evidence.manifestSha256) {
    throw new Error(
      `${ledger}: release evidence manifest SHA-256 does not match ` +
      `the covered release bytes`,
    )
  }
}

function verifyNoticeBacked(root, ledger, record) {
  const noticeFiles = record.noticeFiles
  if (!Array.isArray(noticeFiles) || noticeFiles.length === 0) {
    throw new Error(`${ledger}: noticeFiles must be a non-empty array`)
  }
  const files = noticeFiles.map((value) =>
    verifyNoticeFile(root, value, `${ledger}: noticeFiles`)
  )

  const coveredPaths = record.coveredPaths
  if (!Array.isArray(coveredPaths) || coveredPaths.length === 0) {
    throw new Error(`${ledger}: coveredPaths must be a non-empty array`)
  }
  for (const value of coveredPaths) {
    files.push(
      ...verifyCoveredPath(root, value, `${ledger}: coveredPaths`),
    )
  }
  verifyReleaseEvidence(root, ledger, record, files)
}

export function verifyReleaseRights(root = ROOT) {
  const provenanceRoot = provenanceDirectory(root)
  const ledgers = machineReadableLedgers(provenanceRoot)
  if (ledgers.length === 0) {
    throw new Error('No machine-readable provenance ledger was found')
  }
  const unresolved = []
  const verified = []

  for (const ledger of ledgers) {
    const record = JSON.parse(
      readFileSync(resolve(provenanceRoot, ledger), 'utf8'),
    )
    const status =
      typeof record?.releaseStatus === 'string' && record.releaseStatus.length > 0
        ? record.releaseStatus
        : 'UNKNOWN'
    if (record?.schemaVersion !== 1) {
      unresolved.push(
        `${ledger}: schemaVersion must be exactly 1`,
      )
      continue
    }
    if (!ACCEPTED_STATUSES.has(status)) {
      unresolved.push(`${ledger}: releaseStatus=${status}`)
      continue
    }
    if (status === 'NOTICE_BACKED') {
      try {
        verifyNoticeBacked(root, ledger, record)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        unresolved.push(message)
        continue
      }
    }
    verified.push({ ledger, status })
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Release rights are not cleared:\n- ${unresolved.join('\n- ')}`,
    )
  }
  return verified
}

function main() {
  const ledgers = verifyReleaseRights(parseRoot(process.argv.slice(2)))
  process.stdout.write(
    `[release-rights] VERIFIED: ${ledgers.length} ` +
      `ledger${ledgers.length === 1 ? '' : 's'}\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[release-rights] BLOCKED\n${message}\n`)
    process.exitCode = 1
  }
}
