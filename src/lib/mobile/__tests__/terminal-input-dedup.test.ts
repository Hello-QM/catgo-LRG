import { describe, expect, it } from 'vitest'

import { createInputDedup, reconcileReplacement } from '../terminal-input-dedup'

describe(`reconcileReplacement (iOS dictation)`, () => {
  it(`sends only the new tail when a partial is refined ("hel" -> "hello")`, () => {
    // beforeinput insertText "hello" replacing val="hel" range 0..3.
    expect(reconcileReplacement(`hel`, 0, 3, `hello`)).toEqual({
      backspaces: 0,
      send: `lo`,
    })
  })

  it(`is a no-op when the refinement is unchanged ("hello" -> "hello")`, () => {
    expect(reconcileReplacement(`hello`, 0, 5, `hello`)).toEqual({
      backspaces: 0,
      send: ``,
    })
  })

  it(`backspaces the diverging tail and retypes ("hello" -> "help")`, () => {
    // common prefix "hel"; erase "lo", send "p".
    expect(reconcileReplacement(`hello`, 0, 5, `help`)).toEqual({
      backspaces: 2,
      send: `p`,
    })
  })

  it(`preserves a leading space partial (" he" -> " hello")`, () => {
    expect(reconcileReplacement(` he`, 0, 3, ` hello`)).toEqual({
      backspaces: 0,
      send: `llo`,
    })
  })

  it(`appends a Chinese first partial (collapsed caret, empty textarea)`, () => {
    // iOS Chinese dictation: the FIRST partial is a plain insert at a collapsed
    // caret — the reconcile must degenerate to a pure append.
    expect(reconcileReplacement(``, 0, 0, `你好`)).toEqual({
      backspaces: 0,
      send: `你好`,
    })
  })

  it(`sends only the new tail when a Chinese partial is refined ("你好" -> "你好世界")`, () => {
    expect(reconcileReplacement(`你好`, 0, 2, `你好世界`)).toEqual({
      backspaces: 0,
      send: `世界`,
    })
  })

  it(`backspaces a corrected Chinese partial ("你号" -> "你好世界")`, () => {
    // The recognizer revises a mis-heard character: erase the diverged tail, retype.
    expect(reconcileReplacement(`你号`, 0, 2, `你好世界`)).toEqual({
      backspaces: 1,
      send: `好世界`,
    })
  })

  it(`handles text after the replaced range`, () => {
    // val "helloX", replace 0..5 ("hello") with "help"; X stays put.
    expect(reconcileReplacement(`helloX`, 0, 5, `help`)).toEqual({
      backspaces: 3, // erase "loX"
      send: `pX`,
    })
  })

  it(`reconstructs "hello" from the real device trace`, () => {
    // The captured sequence: collapsed insert "hel", then two replacements.
    let pty = `hel` // step 1 forwarded normally (collapsed caret)
    for (
      const [val, s, e, data] of [[`hel`, 0, 3, `hello`], [
        `hello`,
        0,
        5,
        `hello`,
      ]] as const
    ) {
      const { backspaces, send } = reconcileReplacement(val, s, e, data)
      pty = pty.slice(0, pty.length - backspaces) + send
    }
    expect(pty).toBe(`hello`)
  })
})

describe(`createInputDedup`, () => {
  it(`forwards a single insertion with a single onData`, () => {
    const d = createInputDedup()
    d.note_before_input(`h`)
    expect(d.accept(`h`)).toBe(true)
  })

  it(`drops the duplicate when one beforeinput yields two identical onData`, () => {
    // The bug: xterm double-emits, so "h" arrives twice after one beforeinput.
    const d = createInputDedup()
    d.note_before_input(`h`)
    expect(d.accept(`h`)).toBe(true) // first: the legit char
    expect(d.accept(`h`)).toBe(false) // second: the duplicate to drop
  })

  it(`keeps a genuinely repeated character (two beforeinputs)`, () => {
    // Typing "ll": each press fires its own beforeinput, so BOTH must forward.
    const d = createInputDedup()
    d.note_before_input(`l`)
    expect(d.accept(`l`)).toBe(true)
    d.note_before_input(`l`)
    expect(d.accept(`l`)).toBe(true)
  })

  it(`forwards onData that never had a matching beforeinput`, () => {
    // Arrow-key escape sequence: no beforeinput carries insertion text for it.
    const d = createInputDedup()
    expect(d.accept(`\x1b[A`)).toBe(true)
  })

  it(`drops a duplicated multi-char paste`, () => {
    // A paste arrives as one beforeinput carrying the whole string; if xterm
    // double-emits the chunk, the second copy must drop (not paste twice).
    const d = createInputDedup()
    d.note_before_input(`abc`)
    expect(d.accept(`abc`)).toBe(true)
    expect(d.accept(`abc`)).toBe(false)
  })

  it(`leaves pending intact when a null-data beforeinput interleaves`, () => {
    // Backspace/Enter fire beforeinput with null data — a no-op that must not
    // reset the gate, and the unrelated DEL/CR onData must still forward.
    const d = createInputDedup()
    d.note_before_input(`a`)
    expect(d.accept(`a`)).toBe(true)
    d.note_before_input(null) // backspace: carries no insertion text
    expect(d.accept(`\x7f`)).toBe(true) // DEL forwards (doesn't match pending)
  })

  it(`reconstructs "hello" from a doubled "hhelllo" sequence`, () => {
    // Scripted iOS sequence: beforeinput fires once per real key, but xterm
    // double-emits onData for some of them (h, l, l). The forwarded stream must
    // come back out as "hello".
    const d = createInputDedup()
    type Step = { before: string; data: string[] }
    const script: Step[] = [
      { before: `h`, data: [`h`, `h`] }, // doubled
      { before: `e`, data: [`e`] }, // clean
      { before: `l`, data: [`l`, `l`] }, // doubled
      { before: `l`, data: [`l`, `l`] }, // doubled (real second l)
      { before: `o`, data: [`o`] }, // clean
    ]
    let out = ``
    for (const step of script) {
      d.note_before_input(step.before)
      for (const chunk of step.data) {
        if (d.accept(chunk)) out += chunk
      }
    }
    expect(out).toBe(`hello`)
  })
})
