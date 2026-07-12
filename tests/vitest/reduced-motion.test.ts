import { should_reduce_motion } from '$lib/settings/reduced-motion'
import { describe, expect, test } from 'vitest'

describe(`should_reduce_motion`, () => {
  test.each([
    { setting: false, media: false, expected: false },
    { setting: true, media: false, expected: true },
    { setting: false, media: true, expected: true },
    { setting: true, media: true, expected: true },
  ])(
    `setting=$setting + media=$media → $expected`,
    ({ setting, media, expected }) => {
      expect(should_reduce_motion(setting, media)).toBe(expected)
    },
  )

  test(`default (off setting, no OS pref) does not reduce motion`, () => {
    // Byte-identical viewer behavior when neither source asks to reduce.
    expect(should_reduce_motion(false, false)).toBe(false)
  })

  test(`coerces truthy/falsy inputs to a boolean`, () => {
    // OS media query may pass through undefined when matchMedia is unavailable.
    expect(should_reduce_motion(false, undefined as unknown as boolean)).toBe(false)
    expect(should_reduce_motion(undefined as unknown as boolean, false)).toBe(false)
  })
})
