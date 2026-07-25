#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

import { requiredReleaseAssets } from './release-asset-policy.mjs'

const HEX_40 = /^[0-9a-f]{40}$/
const HEX_64 = /^[0-9a-f]{64}$/
const PROMOTION_ID = /^[A-Za-z0-9._-]{1,100}$/
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/

function parseArguments(argv) {
  const mode = argv[0]
  if (!['create', 'verify'].includes(mode)) {
    throw new Error('First argument must be create or verify')
  }
  const allowed = new Set([
    '--receipt',
    '--assets-dir',
    '--tag',
    '--source-commit',
    '--asset-snapshot',
    '--promotion-id',
    '--latest',
    '--index',
    '--previous-state',
    '--previous-latest',
    '--previous-index',
  ])
  const values = new Map()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || !value || values.has(key)) {
      throw new Error(`Invalid or duplicate argument: ${String(key)}`)
    }
    values.set(key, value)
  }
  const required = [
    '--receipt',
    '--assets-dir',
    '--tag',
    '--source-commit',
    '--asset-snapshot',
    '--promotion-id',
    '--latest',
    '--index',
  ]
  if (mode === 'create') required.push('--previous-state')
  for (const key of required) {
    if (!values.has(key)) throw new Error(`Missing required argument: ${key}`)
  }
  const identity = {
    tag: values.get('--tag'),
    sourceCommit: values.get('--source-commit'),
    assetSnapshot: values.get('--asset-snapshot'),
    promotionId: values.get('--promotion-id'),
  }
  if (!RELEASE_TAG.test(identity.tag)) {
    throw new Error(`Invalid release tag: ${identity.tag}`)
  }
  if (!HEX_40.test(identity.sourceCommit)) {
    throw new Error('Source commit must be an exact lowercase 40-hex SHA')
  }
  if (!HEX_64.test(identity.assetSnapshot)) {
    throw new Error('Asset snapshot must be an exact lowercase SHA-256')
  }
  if (!PROMOTION_ID.test(identity.promotionId)) {
    throw new Error('Promotion id has an invalid format')
  }
  return {
    mode,
    ...identity,
    receiptPath: resolve(values.get('--receipt')),
    assetsDir: resolve(values.get('--assets-dir')),
    latestPath: resolve(values.get('--latest')),
    indexPath: resolve(values.get('--index')),
    previousStatePath: values.has('--previous-state')
      ? resolve(values.get('--previous-state'))
      : null,
    previousLatestPath: values.has('--previous-latest')
      ? resolve(values.get('--previous-latest'))
      : null,
    previousIndexPath: values.has('--previous-index')
      ? resolve(values.get('--previous-index'))
      : null,
  }
}

function regularFile(path, kind) {
  if (!existsSync(path)) throw new Error(`${kind} does not exist: ${path}`)
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${kind} must be a regular file: ${path}`)
  }
}

function sha256(path, kind) {
  regularFile(path, kind)
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path, kind) {
  regularFile(path, kind)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${kind} is invalid JSON: ${error.message}`)
  }
}

function normalizePreviousEntry(entry, kind) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    Object.keys(entry).sort().join(',') !== 'present,sha256'
  ) {
    throw new Error(`Previous ${kind} state has an invalid shape`)
  }
  if (typeof entry.present !== 'boolean') {
    throw new Error(`Previous ${kind} present flag must be boolean`)
  }
  if (entry.present) {
    if (typeof entry.sha256 !== 'string' || !HEX_64.test(entry.sha256)) {
      throw new Error(`Previous ${kind} SHA-256 is invalid`)
    }
  } else if (entry.sha256 !== null) {
    throw new Error(`Absent previous ${kind} must have a null SHA-256`)
  }
  return { present: entry.present, sha256: entry.sha256 }
}

function normalizePreviousRoot(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'index,latest'
  ) {
    throw new Error('Previous root state has an invalid shape')
  }
  return {
    latest: normalizePreviousEntry(value.latest, 'latest.json'),
    index: normalizePreviousEntry(value.index, 'index.html'),
  }
}

function verifyBackup(path, entry, kind) {
  if (!path) return
  if (!entry.present) {
    throw new Error(`Previous ${kind} is absent but a backup file was supplied`)
  }
  if (sha256(path, `Previous ${kind} backup`) !== entry.sha256) {
    throw new Error(`Previous ${kind} backup does not match receipt SHA-256`)
  }
}

function expectedReceipt(options, previousRoot) {
  return {
    schemaVersion: 2,
    promotionId: options.promotionId,
    releaseTag: options.tag,
    sourceCommit: options.sourceCommit,
    assetSnapshot: options.assetSnapshot,
    latestSha256: sha256(options.latestPath, 'Promoted latest.json'),
    indexSha256: sha256(options.indexPath, 'Promoted index.html'),
    requiredAssets: requiredReleaseAssets(options.tag).map(({ name }) => {
      const path = resolve(options.assetsDir, name)
      regularFile(path, `Required release asset ${name}`)
      return {
        name,
        size: lstatSync(path).size,
        sha256: sha256(path, `Required release asset ${name}`),
      }
    }),
    previousRoot,
  }
}

function readPreviousState(options) {
  if (!options.previousStatePath) return null
  return normalizePreviousRoot(
    readJson(options.previousStatePath, 'Previous root state'),
  )
}

function main(options) {
  const previousState = readPreviousState(options)
  let receipt
  if (options.mode === 'create') {
    receipt = expectedReceipt(options, previousState)
    if (existsSync(options.receiptPath)) {
      const metadata = lstatSync(options.receiptPath)
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Promotion receipt output must be a regular file')
      }
    }
    writeFileSync(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  } else {
    receipt = readJson(options.receiptPath, 'Promotion receipt')
    const receiptPreviousRoot = normalizePreviousRoot(receipt.previousRoot)
    const expected = expectedReceipt(
      options,
      previousState ?? receiptPreviousRoot,
    )
    try {
      assert.deepEqual(receipt, expected)
    } catch {
      throw new Error(
        'Promotion receipt does not match the expected release identity, ' +
          'root hashes, required asset inventory, or previous root state',
      )
    }
  }
  const previousRoot = normalizePreviousRoot(receipt.previousRoot)
  verifyBackup(
    options.previousLatestPath,
    previousRoot.latest,
    'latest.json',
  )
  verifyBackup(
    options.previousIndexPath,
    previousRoot.index,
    'index.html',
  )
  process.stdout.write(
    `[promotion-receipt] verified ${options.promotionId} for ${options.tag}\n`,
  )
}

try {
  main(parseArguments(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`[promotion-receipt] ${error.message}\n`)
  process.exitCode = 1
}
