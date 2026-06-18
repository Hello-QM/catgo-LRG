import { describe, it, expect } from 'vitest'
import en from '../../../src/lib/i18n/en/viewer'
import zh from '../../../src/lib/i18n/zh/viewer'

describe('viewer i18n parity', () => {
  it('en and zh have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
  it('has the required keys', () => {
    for (const k of ['empty', 'loading', 'title']) expect(en).toHaveProperty(k)
  })
})
