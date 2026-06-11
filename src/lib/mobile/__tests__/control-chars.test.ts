import { describe, expect, it } from 'vitest'

import { to_control } from '../control-chars'

describe(`to_control`, () => {
  it(`maps letters to Ctrl-A..Ctrl-Z control chars`, () => {
    expect(to_control(`c`)).toBe(`\x03`) // SIGINT
    expect(to_control(`C`)).toBe(`\x03`) // case-insensitive
    expect(to_control(`a`)).toBe(`\x01`)
    expect(to_control(`z`)).toBe(`\x1a`) // SIGTSTP
    expect(to_control(`d`)).toBe(`\x04`) // EOF
  })

  it(`maps standard non-letter control keys`, () => {
    expect(to_control(`@`)).toBe(`\x00`)
    expect(to_control(` `)).toBe(`\x00`)
    expect(to_control(`[`)).toBe(`\x1b`)
    expect(to_control(`\\`)).toBe(`\x1c`)
    expect(to_control(`]`)).toBe(`\x1d`)
    expect(to_control(`^`)).toBe(`\x1e`)
    expect(to_control(`_`)).toBe(`\x1f`)
    expect(to_control(`/`)).toBe(`\x1f`)
  })

  it(`returns null for unmappable or multi-char input`, () => {
    expect(to_control(`1`)).toBe(null)
    expect(to_control(`!`)).toBe(null)
    expect(to_control(``)).toBe(null)
    expect(to_control(`ab`)).toBe(null) // autocorrect-style multi-char insert
  })
})
