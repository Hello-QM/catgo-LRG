import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { legalBundleSources } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LEDGER_PATH =
  'third_party/provenance/pormake-database-provenance.json'
const NOTICE_PATH = 'THIRD_PARTY_NOTICES.md'
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

test('PORMAKE database ledger pins the exact imported tree and official archive', () => {
  assert.equal(existsSync(resolve(ROOT, LEDGER_PATH)), true, LEDGER_PATH)
  const ledger = JSON.parse(read(LEDGER_PATH))

  assert.equal(ledger.schemaVersion, 1)
  assert.equal(
    ledger.pormake.revision,
    '639caad9d315ef6cb4838d0f8e44336d4a41aa7a',
  )
  assert.equal(
    ledger.pormake.officialArchive.sha256,
    '55220dc01fda8df7f1933b53c9ab3c60e7c242f1b442bb86b7f8237b6bb49421',
  )
  assert.equal(ledger.directoryComparison.byteIdentical, true)
  assert.deepEqual(ledger.directoryComparison.paths, {
    catgo: 'server/catgo/vendor/pormake/database',
    upstream: 'src/pormake/database',
  })
  assert.deepEqual(ledger.manifests, {
    algorithm:
      'SHA-256 of sorted sha256sum records with paths relative to the database root',
    bbs: '793516ee8a627990e633633c9d97c39e339d03a26cb09c893dcccaa035801290',
    topologies:
      '45bc4d3b8cabae37f935fb88a1436bfc0db3a695962b992b779fd44e2043ca4d',
    all: '0e9df18d6bfd14f4970375ec40242d131eb245547316014e44049f1353b65548',
  })
  assert.deepEqual(ledger.counts, {
    databaseFiles: 3274,
    buildingBlocks: 867,
    topologiesCgd: 2404,
    toBaCCoBuildingBlocks: 71,
    coREBuildingBlocks: 796,
  })
})

test('PORMAKE source records do not extrapolate dataset redistribution rights', () => {
  const { sources } = JSON.parse(read(LEDGER_PATH))

  assert.equal(sources.toBaCCo.supportingInformationLicense, 'CC BY-NC')
  assert.equal(sources.toBaCCo.appliesToUnderlyingData, false)
  assert.equal(sources.toBaCCo.fileCount, 71)

  assert.equal(sources.coRE.zenodoRecord, 3370144)
  assert.equal(sources.coRE.license, 'CC BY 4.0')
  assert.equal(sources.coRE.perFileMappingEstablished, false)
  assert.equal(sources.coRE.fileCount, 796)

  assert.equal(sources.rcsr.repository, 'https://github.com/odf/RCSR')
  assert.equal(sources.rcsr.currentRepositoryLicense, null)
  assert.equal(sources.rcsr.cgdFileCount, 2404)
  assert.equal(sources.rcsr.bundledZip, true)
  assert.equal(sources.rcsr.dedicatedOpenRedistributionLicenseFound, false)
})

test('database release remains blocked on written permission or exclusion', () => {
  const ledger = JSON.parse(read(LEDGER_PATH))
  assert.equal(ledger.releaseStatus, 'BLOCKED')
  assert.equal(ledger.externalRightsGate, 'written permission or exclusion')
  for (const source of Object.values(ledger.sources)) {
    assert.equal(source.externalRightsGate, 'written permission or exclusion')
  }

  const notice = read(NOTICE_PATH)
  assert.match(notice, /pormake-database-provenance\.json/)
  assert.match(notice, /release remains \*\*BLOCKED\*\*/i)
  assert.ok(legalBundleSources().includes(LEDGER_PATH))
})
