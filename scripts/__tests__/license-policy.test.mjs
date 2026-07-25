import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const DOI = '10.26434/chemrxiv.15002984/v1'

test('root license prohibits unauthorized commercial use', () => {
  const text = read('license')
  assert.match(text, /CatGo Noncommercial Research License 1\.0/)
  assert.match(text, /prior written permission/i)
  assert.match(text, /for-profit entity/i)
  assert.match(text, /terminates automatically/i)
  assert.match(text, /injunctive relief/i)
  assert.match(text, /THIRD_PARTY_NOTICES\.md/)
  assert.match(text, new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
})

test('canonical citation file contains mandatory citation data', () => {
  assert.equal(existsSync(resolve(ROOT, 'citation.cff')), false)
  const text = read('CITATION.cff')
  assert.match(text, /^cff-version: 1\.2\.0$/m)
  assert.match(text, /^version: 1\.4\.6$/m)
  assert.match(text, /CatGo: Bridging CLI Coding Agents/)
  assert.match(text, new RegExp(DOI.replaceAll('.', '\\.')))
  assert.match(text, /If you use CatGo, you must acknowledge and cite it/)
})

test('commercial license page repeats the enforceable entry points', () => {
  const text = read('COMMERCIAL_LICENSE.md')
  assert.match(text, /gul026@ucsd\.edu/)
  assert.match(text, /LicenseRef-CatGo-Noncommercial-1\.0/)
  assert.match(text, /not open source/i)
  assert.match(text, /historical releases/i)
})
