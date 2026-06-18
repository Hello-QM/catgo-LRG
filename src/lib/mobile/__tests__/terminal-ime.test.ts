import { describe, expect, it, vi } from 'vitest'

import { createImeGuard, isCJK } from '../terminal-ime'

describe(`isCJK`, () => {
  it(`detects Chinese, Japanese and Korean`, () => {
    expect(isCJK(`你`)).toBe(true) // CJK ideograph
    expect(isCJK(`한`)).toBe(true) // Hangul syllable
    expect(isCJK(`ㅎ`)).toBe(true) // Hangul compatibility jamo
    expect(isCJK(`あ`)).toBe(true) // Hiragana
    expect(isCJK(`カ`)).toBe(true) // Katakana
  })

  it(`rejects Latin, digits and punctuation`, () => {
    expect(isCJK(`h`)).toBe(false)
    expect(isCJK(`Z`)).toBe(false)
    expect(isCJK(`7`)).toBe(false)
    expect(isCJK(`-`)).toBe(false)
    expect(isCJK(``)).toBe(false)
  })
})

describe(`createImeGuard`, () => {
  it(`passes ordinary Latin input through (not consumed, not suppressed)`, () => {
    const write = vi.fn()
    const g = createImeGuard({ write, now: () => 0 })
    expect(g.on_before_input(`insertText`, `h`)).toBe(false)
    expect(g.should_suppress(`h`)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it(`lets non-CJK insertReplacementText (iOS autocorrect) through`, () => {
    const g = createImeGuard({ write: vi.fn(), now: () => 0 })
    // A corrected English word must NOT be captured as a composition.
    expect(g.on_before_input(`insertReplacementText`, `hello`)).toBe(false)
  })

  it(`suppresses onData during a standard composition and writes the commit`, () => {
    const write = vi.fn()
    const g = createImeGuard({ write, now: () => 0 })
    g.on_composition_start()
    // While composing, xterm's own emissions are dropped.
    expect(g.should_suppress(`x`)).toBe(true)
    g.on_composition_end(`你好`)
    expect(write).toHaveBeenCalledWith(`你好`)
  })

  it(`buffers a WK Korean composition and flushes on a real keystroke`, () => {
    const write = vi.fn()
    const g = createImeGuard({ write, now: () => 0 })
    // Syllable rebuilds: ㅎ → 하 → 한, each replacing the last.
    expect(g.on_before_input(`insertReplacementText`, `ㅎ`)).toBe(true)
    expect(g.on_before_input(`insertReplacementText`, `한`)).toBe(true)
    expect(g.should_suppress(`whatever`)).toBe(true) // still composing
    expect(write).not.toHaveBeenCalled()
    g.on_keydown(229) // IME still processing — must NOT flush
    expect(write).not.toHaveBeenCalled()
    g.on_keydown(13) // a real Enter — flush the buffered syllable
    expect(write).toHaveBeenCalledWith(`한`)
  })

  it(`swallows confirmation-key residue only within the post-compose window`, () => {
    const write = vi.fn()
    let t = 1000
    const g = createImeGuard({ write, now: () => t })
    g.on_composition_end(`字`) // arms an 80ms residue window at t=1000
    // A stray space right after the commit is residue — dropped.
    expect(g.should_suppress(` `)).toBe(true)
    // A non-confirm key is always allowed through, even within the window.
    expect(g.should_suppress(`a`)).toBe(false)
    // Past the window, a deliberate space is honored.
    t = 1100
    expect(g.should_suppress(` `)).toBe(false)
  })

  it(`never arms the residue window for pure Latin typing`, () => {
    const g = createImeGuard({ write: vi.fn(), now: () => 0 })
    // No composition has happened, so a typed space is never suppressed.
    expect(g.should_suppress(` `)).toBe(false)
    expect(g.should_suppress(`\r`)).toBe(false)
  })

  it(`consumes Chinese Pinyin insertFromComposition (commit comes via end)`, () => {
    const g = createImeGuard({ write: vi.fn(), now: () => 0 })
    expect(g.on_before_input(`insertFromComposition`, `中`)).toBe(true)
  })

  it(`flushes the prior buffer when a standalone CJK insertText starts a new one`, () => {
    const write = vi.fn()
    const g = createImeGuard({ write, now: () => 0 })
    // First syllable buffered…
    expect(g.on_before_input(`insertText`, `가`)).toBe(true)
    expect(write).not.toHaveBeenCalled()
    // …a second standalone CJK insertText flushes the first, then buffers itself.
    expect(g.on_before_input(`insertText`, `나`)).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith(`가`)
    // The second is still pending until a real key flushes it.
    g.on_keydown(13)
    expect(write).toHaveBeenLastCalledWith(`나`)
  })
})
