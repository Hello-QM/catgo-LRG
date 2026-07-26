import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'
const CITATION_REQUEST =
  'If CatGo contributes to your work, please acknowledge and cite it as ' +
  'described below. This request is not an additional condition of ' +
  'AGPL-3.0-or-later.'

test('active documentation footers request citation without adding AGPL conditions', () => {
  const config = read('docs/.vitepress/config.ts')
  const footerMessages = [
    ...config.matchAll(/footer:\s*\{\s*message:\s*`([^`]*)`/g),
  ].map((match) => match[1])

  assert.equal(footerMessages.length, 2)
  assert.doesNotMatch(footerMessages.join('\n'),
    /CatGo Noncommercial Research License|LicenseRef-CatGo-Noncommercial|COMMERCIAL_LICENSE|prior written commercial permission/i)

  const [chinese, english] = footerMessages
  for (const message of footerMessages) {
    assert.match(message, /AGPL-3\.0-or-later/)
  }
  assert.match(chinese, /不构成.*附加条件/)
  assert.match(english, /not an additional condition/i)
})

test('CITATION.cff carries the exact non-binding citation request', () => {
  const cff = read('CITATION.cff')
  const message = cff.match(/^message:\s*(.+)$/m)?.[1]

  assert.ok(message, 'CITATION.cff must define the CFF 1.2 message field')
  assert.equal(message, CITATION_REQUEST)
  assert.match(cff, /^license: AGPL-3\.0-or-later$/m)
  assert.match(cff, /^license-url: https:\/\/github\.com\/Hello-QM\/catgo-LRG\/blob\/main\/license$/m)
  assert.match(cff, /^\s+doi: 10\.26434\/chemrxiv\.15002984\/v1$/m)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
