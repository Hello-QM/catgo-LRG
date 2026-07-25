import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
const ACK = 'This work used CatGo (https://catgo-ucsd.org).'

test('active documentation footers state the CatGo noncommercial terms', () => {
  const config = read('docs/.vitepress/config.ts')
  const footerMessages = [
    ...config.matchAll(/footer:\s*\{\s*message:\s*`([^`]*)`/g),
  ].map((match) => match[1])

  assert.equal(footerMessages.length, 2)
  assert.doesNotMatch(footerMessages.join('\n'), /AGPL|MIT License/i)

  const [chinese, english] = footerMessages
  for (const message of footerMessages) {
    assert.match(message, /CatGo Noncommercial Research License 1\.0/)
    assert.match(message, /gul026@ucsd\.edu/)
  }
  assert.match(chinese, /必须.*致谢.*引用/)
  assert.match(chinese, /事先取得书面许可/)
  assert.match(english, /requires? acknowledgment and citation/i)
  assert.match(english, /prior written commercial permission/i)
})

test('CITATION.cff carries the exact required acknowledgment', () => {
  const cff = read('CITATION.cff')
  const message = cff.match(/^message:\s*(.+)$/m)?.[1]

  assert.ok(message, 'CITATION.cff must define the CFF 1.2 message field')
  assert.match(message, new RegExp(`^${escapeRegExp(ACK)}(?:\\s|$)`))
  assert.match(cff, /^license-url: https:\/\/github\.com\/Hello-QM\/catgo-LRG\/blob\/main\/license$/m)
  assert.match(cff, /^\s+doi: 10\.26434\/chemrxiv\.15002984\/v1$/m)
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
