import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { legalBundleSources } from '../sync-legal-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LEDGER_PATH =
  'third_party/provenance/pymatgen-ase-xterm-provenance.json'
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const sha256 = (path) =>
  createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')

const mapping = (component, id) => {
  const found = component.mappings.find((entry) => entry.id === id)
  assert.ok(found, `missing provenance mapping ${id}`)
  return found
}

test('machine-readable ledger pins exact MatterViz import evidence', () => {
  assert.equal(existsSync(resolve(ROOT, LEDGER_PATH)), true, LEDGER_PATH)
  const ledger = JSON.parse(read(LEDGER_PATH))

  assert.equal(ledger.schemaVersion, 1)
  assert.deepEqual(ledger.intermediaries, [
    {
      repository: 'https://github.com/janosh/matterviz',
      pullRequest: 274,
      head: '63a222673cd21d6b4542ac8b819714aa3104b625',
      catgoImportCommit: 'b4ce49e30eca8547b57f3f57fa251f8936a1b589',
      evidence: [
        'exact whole-file blobs: cif.rs, element.rs, lattice.rs',
        'exact marker-to-EOF blocks: composition.rs, io.rs',
        'exact first four marked matcher.rs tests',
      ],
    },
    {
      repository: 'https://github.com/janosh/matterviz',
      pullRequest: 290,
      head: '34d031638685869f40ebfc8c5233c29584fb86f5',
      catgoImportCommit: 'ce041a67c21232232de7f096652c1c5eb841b6eb',
      evidence: [
        'exact whole-file blobs: integrators.rs, structure_matcher.rs, algorithms/ewald.rs, xrd.rs, elastic.rs',
      ],
    },
  ])
})

test('pymatgen mappings distinguish data, implementations, tests, and interoperability', () => {
  const { pymatgen } = JSON.parse(read(LEDGER_PATH)).components
  assert.equal(
    pymatgen.auditSnapshot.revision,
    '7b92f9ab4112d538381f4ee4dd6119295c200245',
  )
  assert.equal(pymatgen.auditSnapshot.provesActualAdoptedRevision, false)
  assert.match(pymatgen.externalEvidenceGate, /actual adopted revision/i)

  const table = mapping(pymatgen, 'xrd-scattering-table')
  assert.equal(table.classification, 'copied-data')
  assert.equal(table.catgoBlob, 'd37f99d6abd4a82cc1525c4eb19d47240c336016')
  assert.equal(table.mattervizBlob, table.catgoBlob)
  assert.equal(table.upstreamBlob, '3dfcfb384730b9927286689cf06c38d3460ae840')
  assert.equal(table.valueComparison, '99 keys; 0 mismatches')

  for (const id of [
    'xrd-production-algorithm',
    'crystalnn-and-solid-angle',
    'ewald-production-algorithm',
    'structure-matcher-production-algorithm',
  ]) {
    assert.equal(mapping(pymatgen, id).classification, 'adapted-implementation')
  }
  assert.equal(
    mapping(pymatgen, 'pymatgen-edge-case-tests').classification,
    'adapted-tests',
  )
  assert.equal(
    mapping(pymatgen, 'pymatgen-json-and-structure-api').classification,
    'interoperability-only',
  )
})

test('ASE ledger maps all four adapted tests without claiming the audit snapshot was adopted', () => {
  const { ase } = JSON.parse(read(LEDGER_PATH)).components
  assert.equal(
    ase.auditSnapshot.revision,
    'e311e0ab9a04202b94799229e43357ead6243830',
  )
  assert.equal(ase.auditSnapshot.provesActualAdoptedRevision, false)
  assert.match(ase.externalEvidenceGate, /actual adopted revision/i)

  const expected = new Map([
    [
      'nose-hoover-momentum',
      'ase/test/md/test_nose_hoover_chain.py::test_nose_hoover_chain_nvt',
    ],
    [
      'velocity-verlet-round-trip',
      'ase/test/md/test_nose_hoover_chain.py::test_thermostat_round_trip',
    ],
    [
      'nve-energy-conservation',
      'ase/test/md/test_verlet_thermostats_asap.py::test_verlet_thermostats_asap',
    ],
    [
      'langevin-temperature-distribution',
      'ase/test/md/test_nvt_npt.py::{propagate,test_langevin}',
    ],
  ])
  assert.equal(ase.mappings.length, expected.size + 1)
  for (const [id, upstreamSymbol] of expected) {
    const entry = mapping(ase, id)
    assert.equal(entry.classification, 'adapted-tests')
    assert.equal(entry.upstreamSymbol, upstreamSymbol)
  }
  assert.equal(
    mapping(ase, 'ase-atoms-and-units-api').classification,
    'interoperability-only',
  )
})

test('xterm PR 5704 is recorded as adapted and demonstrably non-patch-identical', () => {
  const { xterm } = JSON.parse(read(LEDGER_PATH)).components
  assert.equal(xterm.classification, 'adapted-implementation')
  assert.equal(xterm.pullRequest, 5704)
  assert.equal(xterm.base, 'fb25eb8f79fd223acef90828dc2990bb7e196a1d')
  assert.equal(xterm.head, '16c7a837be902403383142016936059c90b6706e')
  assert.deepEqual(xterm.logicCommits, [
    'd70c52da926584f6865ab22e1a98a7d83a4c38bc',
    'c02ba2cf07d3f46c594cd1eb37e5785e2b5e8f5a',
  ])
  assert.deepEqual(xterm.patchIds, {
    catgo: '6a61e2bb0cca035bf2500e0afee4e0b2de734b38',
    upstream: [
      '7330ecfab8076b9baad43bfebc9b68aa0e8a1cf7',
      'a2eab2de989c9bd7a224d744244b851cd9310fd2',
    ],
    exactMatch: false,
  })
  assert.deepEqual(xterm.symbolMapping.catgo, [
    'wk_composing',
    'wk_pending',
    'isCJK',
    'wkFlush',
    'beforeinput',
    'keydown',
    'term.onData',
  ])
  assert.deepEqual(xterm.symbolMapping.upstream, [
    '_wkImeComposing',
    '_wkImePending',
    '_isHangul',
    '_wkFlush',
    '_inputEvent',
    '_keyDown',
    'CompositionHelper.wkImeComposing',
  ])
})

test('official license snapshots and the provenance ledger are canonical bundle sources', () => {
  const expected = new Map([
    [
      'third_party/licenses/pymatgen-MIT.txt',
      ['7e8f24f9b40be59291c7d82819edb8e93fb344f1d53997880e7db80bbc4f5d89', 1167],
    ],
    [
      'third_party/licenses/ASE-LGPL-2.1.txt',
      ['dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551', 26530],
    ],
    [
      'third_party/licenses/xterm.js-MIT.txt',
      ['b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd', 1261],
    ],
  ])
  for (const [path, [digest, bytes]] of expected) {
    assert.equal(existsSync(resolve(ROOT, path)), true, path)
    assert.equal(readFileSync(resolve(ROOT, path)).byteLength, bytes, path)
    assert.equal(sha256(path), digest, path)
  }

  const sources = legalBundleSources()
  assert.ok(sources.includes(LEDGER_PATH), LEDGER_PATH)
  for (const path of expected.keys()) assert.ok(sources.includes(path), path)
})
