import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { requiredReleaseAssets } from '../release-asset-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VERIFIER = resolve(ROOT, 'scripts/verify-release-promotion-receipt.mjs')
const SOURCE_COMMIT = 'a'.repeat(40)
const ASSET_SNAPSHOT = 'b'.repeat(64)
const PROMOTION_ID = '1234-2'

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'catgo-promotion-receipt-'))
  const paths = {
    root,
    latest: resolve(root, 'latest.json'),
    index: resolve(root, 'index.html'),
    previousLatest: resolve(root, 'previous-latest.json'),
    previousIndex: resolve(root, 'previous-index.html'),
    previousState: resolve(root, 'previous-root.json'),
    receipt: resolve(root, 'receipt.json'),
  }
  writeFileSync(
    paths.latest,
    `${JSON.stringify({
      version: '1.4.6',
      platforms: {
        'windows-x86_64': {
          url: 'https://dl.catgo-ucsd.org/v1.4.6/CatGo_1.4.6_x64-setup.exe',
        },
      },
    })}\n`,
  )
  writeFileSync(paths.index, '<!doctype html><title>CatGo v1.4.6</title>\n')
  writeFileSync(paths.previousLatest, '{"version":"1.4.5"}\n')
  writeFileSync(paths.previousIndex, '<title>CatGo v1.4.5</title>\n')
  const digest = (path) =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(
    paths.previousState,
    `${JSON.stringify({
      latest: {
        present: true,
        sha256: digest(paths.previousLatest),
      },
      index: {
        present: true,
        sha256: digest(paths.previousIndex),
      },
    })}\n`,
  )
  return paths
}

function run(mode, paths, extra = []) {
  return spawnSync(
    process.execPath,
    [
      VERIFIER,
      mode,
      '--receipt',
      paths.receipt,
      '--tag',
      'v1.4.6',
      '--source-commit',
      SOURCE_COMMIT,
      '--asset-snapshot',
      ASSET_SNAPSHOT,
      '--promotion-id',
      PROMOTION_ID,
      '--latest',
      paths.latest,
      '--index',
      paths.index,
      '--previous-state',
      paths.previousState,
      '--previous-latest',
      paths.previousLatest,
      '--previous-index',
      paths.previousIndex,
      ...extra,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

test('creates and verifies an exact release-promotion receipt', () => {
  const paths = fixture()
  try {
    const created = run('create', paths)
    assert.equal(created.status, 0, created.stderr || created.stdout)
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'))
    assert.deepEqual(
      receipt.requiredAssets,
      requiredReleaseAssets('v1.4.6').map(({ name }) => name),
    )
    assert.equal(receipt.promotionId, PROMOTION_ID)
    assert.equal(receipt.releaseTag, 'v1.4.6')
    assert.equal(receipt.sourceCommit, SOURCE_COMMIT)
    assert.equal(receipt.assetSnapshot, ASSET_SNAPSHOT)
    assert.match(receipt.latestSha256, /^[0-9a-f]{64}$/)
    assert.match(receipt.indexSha256, /^[0-9a-f]{64}$/)

    const verified = run('verify', paths)
    assert.equal(verified.status, 0, verified.stderr || verified.stdout)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('rejects receipt identity, root bytes, inventory, or backup-state drift', async (t) => {
  for (const scenario of [
    {
      name: 'source commit',
      mutate(receipt) {
        receipt.sourceCommit = 'c'.repeat(40)
      },
      expected: /source|receipt/i,
    },
    {
      name: 'required asset inventory',
      mutate(receipt) {
        receipt.requiredAssets.pop()
      },
      expected: /asset|receipt/i,
    },
    {
      name: 'previous root state',
      mutate(receipt) {
        receipt.previousRoot.latest.present = false
        receipt.previousRoot.latest.sha256 = null
      },
      expected: /previous|receipt/i,
    },
  ]) {
    await t.test(scenario.name, () => {
      const paths = fixture()
      try {
        assert.equal(run('create', paths).status, 0)
        const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'))
        scenario.mutate(receipt)
        writeFileSync(paths.receipt, `${JSON.stringify(receipt)}\n`)
        const result = run('verify', paths)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, scenario.expected)
      } finally {
        rmSync(paths.root, { recursive: true, force: true })
      }
    })
  }

  await t.test('latest.json bytes', () => {
    const paths = fixture()
    try {
      assert.equal(run('create', paths).status, 0)
      writeFileSync(paths.latest, '{"version":"forged"}\n')
      const result = run('verify', paths)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /latest|receipt/i)
    } finally {
      rmSync(paths.root, { recursive: true, force: true })
    }
  })
})
