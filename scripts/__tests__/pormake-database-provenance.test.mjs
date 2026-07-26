import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { legalBundleSources } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LEDGER_PATH =
  'third_party/provenance/pormake-database-provenance.json'
const NOTICE_PATH = 'THIRD_PARTY_NOTICES.md'
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const DATABASE_ROOT = 'server/catgo/vendor/pormake/database'

const databaseManifest = (path) => {
  const trackedFiles = execFileSync('git', ['ls-files', '--', path], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean)
  const records = trackedFiles.map((file) => ({
    path: relative(
      resolve(ROOT, DATABASE_ROOT),
      resolve(ROOT, file),
    ).split(sep).join('/'),
    sha256: createHash('sha256')
      .update(readFileSync(resolve(ROOT, file)))
      .digest('hex'),
  }))
  const sortedRecords = records.sort((left, right) =>
    left.path.localeCompare(right.path),
  )
  return {
    fileCount: sortedRecords.length,
    sha256: createHash('sha256')
      .update(
        sortedRecords
          .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
          .join(''),
      )
      .digest('hex'),
  }
}

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
      '6d5c74c7d1647304983a39328c157e2f7701bc7821dbf68a9a97fa7b6260f595',
    all: 'aaf45f145fccd856509542295884a7877f1cf67b36f8ae3d3cd2eda7d4aeb910',
  })
  assert.deepEqual(ledger.counts, {
    databaseFiles: 3274,
    buildingBlocks: 867,
    topologiesCgd: 2404,
    toBaCCoBuildingBlocks: 71,
    coREBuildingBlocks: 796,
  })
})

test('PORMAKE notice-backed ledger records the official PyPI 0.2.2 artifacts', () => {
  const ledger = JSON.parse(read(LEDGER_PATH))

  assert.equal(ledger.releaseStatus, 'NOTICE_BACKED')
  assert.deepEqual(ledger.noticeFiles, [
    'THIRD_PARTY_NOTICES.md',
    'server/catgo/vendor/pormake/LICENSE',
    'third_party/licenses/PORMAKE-MIT.txt',
  ])
  assert.deepEqual(ledger.coveredPaths, [
    'server/catgo/vendor/pormake/database',
  ])
  assert.equal(ledger.officialPyPIRelease.version, '0.2.2')
  assert.deepEqual(ledger.officialPyPIRelease, {
    project: 'pormake',
    version: '0.2.2',
    artifacts: {
      wheel: {
        filename: 'pormake-0.2.2-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/c4/a5/f374f804c02b2be4d31f2f70452d5028f28753ce9a19bc664efdf36e4893/pormake-0.2.2-py3-none-any.whl',
        sha256: 'cdcd945ed9146781cb05154b34cc4fb283c84e0d12cd6e0bb6c31e223c293c20',
        licensePath: 'pormake-0.2.2.dist-info/LICENSE.md',
        databasePath: 'pormake/database',
        databaseFileCount: 3274,
      },
      sdist: {
        filename: 'pormake-0.2.2.tar.gz',
        url: 'https://files.pythonhosted.org/packages/22/c2/0b8ce705072c2c7aa52bcd15c08d1ee96ef1abb5971c6c6195e827e12a25/pormake-0.2.2.tar.gz',
        sha256: 'd5b73897cf4f3b3828073f7ba71ece535172318e709a9a2186b925c40c37a04e',
        licensePath: 'LICENSE.md',
        databasePath: 'pormake/database',
        databaseFileCount: 3274,
      },
    },
    retainedLicense: {
      sha256: '62bf3249aed0b2105bd66c0f99283f68d97e6afac79cd5a2df083821373c1a31',
      bytes: 1064,
      identicalToCatGoCopies: {
        'server/catgo/vendor/pormake/LICENSE': true,
        'third_party/licenses/PORMAKE-MIT.txt': true,
      },
    },
  })
})

test('PORMAKE manifests are independently computed from the live CatGo database tree', () => {
  assert.deepEqual(databaseManifest(DATABASE_ROOT), {
    fileCount: 3274,
    sha256: 'aaf45f145fccd856509542295884a7877f1cf67b36f8ae3d3cd2eda7d4aeb910',
  })
  assert.deepEqual(databaseManifest(`${DATABASE_ROOT}/bbs`), {
    fileCount: 867,
    sha256: '793516ee8a627990e633633c9d97c39e339d03a26cb09c893dcccaa035801290',
  })
  assert.deepEqual(databaseManifest(`${DATABASE_ROOT}/topologies`), {
    fileCount: 2407,
    sha256: '6d5c74c7d1647304983a39328c157e2f7701bc7821dbf68a9a97fa7b6260f595',
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

test('PORMAKE notice-backed evidence does not establish an independent contributor chain of title', () => {
  const ledger = JSON.parse(read(LEDGER_PATH))
  assert.equal(
    ledger.independentChainOfTitle.status,
    'NOT_INDEPENDENTLY_ESTABLISHED',
  )
  for (const source of Object.values(ledger.sources)) {
    assert.equal(source.externalRightsGate, 'written permission or exclusion')
  }

  const notice = read(NOTICE_PATH)
  assert.match(notice, /pormake-database-provenance\.json/)
  assert.ok(legalBundleSources().includes(LEDGER_PATH))
})
