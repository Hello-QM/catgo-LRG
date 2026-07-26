import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const gitFiles = () =>
  execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)

const confirmedMitNotices = [
  ['third_party/licenses/MatterViz-MIT.txt', 'Copyright (c) 2021 Janosh Riebesell'],
  ['third_party/licenses/xyzrender-MIT.txt', 'Copyright (c) 2026 Alister S. Goodfellow'],
  ['third_party/licenses/xyz2svg-MIT.txt', 'Copyright (c) 2023 Ksenia Briling'],
  ['third_party/licenses/xyzgraph-MIT.txt', 'Copyright (c) 2025 Alister S. Goodfellow'],
  ['third_party/licenses/AtomCanvas-MIT.txt', 'Copyright (c) 2026 Zhang Yichen'],
  ['third_party/licenses/pretty-lattice-MIT.txt', 'Copyright (c) 2026 Feitong Song'],
  ['third_party/licenses/sql.js-MIT.txt', 'Copyright (c) 2017 sql.js authors (see AUTHORS)'],
  ['third_party/licenses/OVITO-MIT.txt', 'Copyright 2026 OVITO GmbH, Germany'],
  ['server/catgo/vendor/pormake/LICENSE', 'Copyright (c) 2022 Sangwon'],
]

test('confirmed upstream MIT notices retain their copyright and permission text', () => {
  for (const [path, copyright] of confirmedMitNotices) {
    assert.equal(existsSync(resolve(ROOT, path)), true, path)
    const text = read(path)
    assert.match(text, /^(?:MIT (?:License|license)|Copyright 2026 OVITO GmbH, Germany)/)
    assert.match(text, new RegExp(copyright.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(text, /Permission is hereby granted, free of charge/)
    assert.match(text, /included in all\s+copies or substantial portions/)
    assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/i)
  }
})

test('the notice index links confirmed sources without assigning blanket path coverage', () => {
  const text = read('THIRD_PARTY_NOTICES.md')
  for (const source of [
    'https://github.com/janosh/matterviz',
    'https://github.com/aligfellow/xyzrender',
    'https://github.com/briling/xyz2svg',
    'https://github.com/aligfellow/xyzgraph',
    'https://github.com/zyc2806/atomcanvas',
    'https://github.com/songfeitong/pretty-lattice',
    'https://github.com/Sangwon91/PORMAKE',
    'https://gitlab.com/stuko/ovito',
  ]) {
    assert.match(text, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), source)
  }
  assert.match(text, /1,306 current path-and-blob pairs/)
  assert.match(text, /does not establish that every current\s+file came from MatterViz/i)
})

test('the PORMAKE notice records official PyPI notice evidence without inferring contributor rights', () => {
  const text = read('THIRD_PARTY_NOTICES.md')

  assert.match(text, /official PyPI project and version:\s*`pormake 0\.2\.2`/i)
  for (const artifact of [
    'cdcd945ed9146781cb05154b34cc4fb283c84e0d12cd6e0bb6c31e223c293c20',
    'd5b73897cf4f3b3828073f7ba71ece535172318e709a9a2186b925c40c37a04e',
  ]) {
    assert.match(text, new RegExp(artifact), artifact)
  }
  assert.match(text, /both artifacts contain the identical 3,274-file database/i)
  assert.match(text, /both artifacts retain the MIT license/i)
  assert.match(text, /immediate-publisher notice basis for \*\*NOTICE_BACKED\*\*/i)
  assert.match(text, /ToBaCCo\/CoRE\/RCSR independent chain of title was not separately established/i)
  assert.match(text, /CC BY-NC only for the supporting information/i)
  assert.match(text, /E\/N per-file mapping to the 796 bundled files has not been established/i)
  assert.match(text, /no dedicated open redistribution license was found/i)
})

test('the bounded pymatgen, ASE, MatterViz, and xterm mappings have notice-backed release evidence', () => {
  const text = read('THIRD_PARTY_NOTICES.md')

  assert.match(text, /bounded pymatgen, ASE, MatterViz, and xterm\.js mappings/i)
  assert.match(text, /\*\*NOTICE_BACKED\*\* release evidence/i)
  for (const path of [
    'extensions/rust/src/algorithms/ewald.rs',
    'extensions/rust/src/integrators.rs',
    'src/lib/structure/TerminalPanel.svelte',
    'src/lib/xrd/atomic-scattering-params.ts',
    'src/lib/xrd/calc-xrd.ts',
  ]) {
    assert.match(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), path)
  }
  assert.match(text, /actual pymatgen revisions[\s\S]*audit snapshot must not be promoted/i)
  assert.match(text, /actual ASE revision used by the original author/i)
})

test('bundled fonts retain copyright notices and the complete OFL text', () => {
  const notices = read('third_party/licenses/BUNDLED-FONTS.txt')
  for (const copyright of [
    'Copyright 2024 The Geist Project Authors',
    'Copyright (c) 2019 - Present, Microsoft Corporation',
    'Copyright 2014-2021 The Fira Code Project Authors',
    'Copyright 2020 The JetBrains Mono Project Authors',
    '© 2023 Adobe',
  ]) {
    assert.match(notices, new RegExp(copyright.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  const ofl = read('third_party/licenses/OFL-1.1.txt')
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/)
  assert.match(ofl, /PERMISSION & CONDITIONS/)
  assert.match(ofl, /This license becomes null and void/)
})

test('the bundled MediaPipe model retains its verified model-card license mapping', () => {
  const modelPath = resolve(ROOT, 'static/models/hand_landmarker.task')
  const digest = createHash('sha256')
    .update(readFileSync(modelPath))
    .digest('hex')
  assert.equal(
    digest,
    'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  )

  const text = read('THIRD_PARTY_NOTICES.md')
  assert.match(
    text,
    /developers\.google\.com\/edge\/mediapipe\/solutions\/vision\/hand_landmarker/,
  )
  assert.match(
    text,
    /storage\.googleapis\.com\/mediapipe-assets\/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021\.pdf/,
  )
  assert.match(text, /License: Apache-2\.0/)
  assert.match(
    text,
    /\[Apache-2\.0 full text\]\(third_party\/licenses\/Apache-2\.0\.txt\)/,
  )

  const apachePath = resolve(ROOT, 'third_party/licenses/Apache-2.0.txt')
  const apacheBytes = readFileSync(apachePath)
  assert.equal(apacheBytes.byteLength, 11_358)
  assert.equal(
    createHash('sha256').update(apacheBytes).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  )
  const apache = apacheBytes.toString('utf8')
  assert.match(apache, /Apache License\s+Version 2\.0, January 2004/)
  assert.match(apache, /END OF TERMS AND CONDITIONS/)
  assert.match(apache, /APPENDIX: How to apply the Apache License to your work/)

  assert.match(
    text,
    /uff-relax:[\s\S]*third_party\/licenses\/uff-relax-Apache-2\.0\.txt/,
    'the component-specific UFF license record remains unchanged',
  )
})

test('the unlicensed KMC source is absent from reproducible source release surfaces', () => {
  const tree = execFileSync(
    'git',
    ['ls-tree', 'HEAD', 'server/ext/KMC'],
    { cwd: ROOT, encoding: 'utf8' },
  )
  assert.equal(tree, '')
  assert.equal(existsSync(resolve(ROOT, 'server/ext/KMC')), false)
  assert.equal(existsSync(resolve(ROOT, '.gitmodules')), false)

  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  })
  const archiveEntries = execFileSync('tar', ['-tf', '-'], {
    input: archive,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  assert.doesNotMatch(archiveEntries, /(?:^|\n)server\/ext\/KMC(?:\/|\n|$)/)

  for (const workflow of gitFiles().filter((path) =>
    path.startsWith('.github/workflows/')
  )) {
    assert.doesNotMatch(
      read(workflow),
      /^\s*submodules:\s*(?:true|recursive)\s*$/m,
      workflow,
    )
  }
  for (const releaseConfig of [
    'server/catgo_server.spec',
    'server/pyproject.toml',
  ]) {
    assert.doesNotMatch(read(releaseConfig), /server\/ext\/KMC/, releaseConfig)
  }
})

test('unresolved code and asset mappings remain explicit review gates', () => {
  const text = read('THIRD_PARTY_NOTICES.md')
  for (const item of [
    'server/ext/KMC',
    'extensions/catrender-wasm/src/perceive.rs',
    'src-tauri/icons/',
    'server/catgo/vendor/pormake/database/',
  ]) {
    assert.match(text, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), item)
  }
  assert.match(text, /No license file or license declaration was found/i)
  assert.match(text, /requires maintainer(?: and|\/)counsel mapping/i)
})
