import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

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

test('unresolved code and asset mappings remain explicit review gates', () => {
  const text = read('THIRD_PARTY_NOTICES.md')
  for (const item of [
    'server/ext/KMC',
    'static/models/hand_landmarker.task',
    'extensions/catrender-wasm/src/perceive.rs',
    'src-tauri/icons/',
    'server/catgo/vendor/pormake/database/',
  ]) {
    assert.match(text, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), item)
  }
  assert.match(text, /No license file or license declaration was found/i)
  assert.match(text, /requires maintainer(?: and|\/)counsel mapping/i)
})
