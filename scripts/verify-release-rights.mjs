#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

export function verifyReleaseRights(root = ROOT) {
  const provenanceRoot = resolve(root, 'third_party/provenance')
  const ledgers = machineReadableLedgers(provenanceRoot)
  if (ledgers.length === 0) {
    throw new Error('No machine-readable provenance ledger was found')
  }
  const unresolved = []

  for (const ledger of ledgers) {
    const record = JSON.parse(
      readFileSync(resolve(provenanceRoot, ledger), 'utf8'),
    )
    const status =
      typeof record.releaseStatus === 'string' && record.releaseStatus.length > 0
        ? record.releaseStatus
        : 'UNKNOWN'
    if (status !== 'CLEARED') {
      unresolved.push(`${ledger}: releaseStatus=${status}`)
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Release rights are not cleared:\n- ${unresolved.join('\n- ')}`,
    )
  }
  return ledgers
}

function main() {
  const ledgers = verifyReleaseRights(parseRoot(process.argv.slice(2)))
  process.stdout.write(
    `[release-rights] CLEARED: ${ledgers.length} ` +
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
