import { describe, it, expect } from 'vitest'
import { strip_ansi, next_marker, wrap_command, extract_result, KEY_MAP, resolve_keys } from '../../src/lib/structure/terminal-capture'

describe('strip_ansi', () => {
  it('removes CSI color codes', () => {
    expect(strip_ansi('\x1b[31mred\x1b[0m')).toBe('red')
  })
  it('removes OSC sequences (e.g. OSC 7 cwd)', () => {
    expect(strip_ansi('a\x1b]7;file://h/p\x07b')).toBe('ab')
  })
  it('keeps plain text and newlines', () => {
    expect(strip_ansi('line1\nline2')).toBe('line1\nline2')
  })
})

describe('next_marker', () => {
  it('is unique per call and matches the expected shape', () => {
    const a = next_marker(); const b = next_marker()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^__CATGO_\d+_[a-z0-9]+__$/)
  })
})

describe('wrap_command / extract_result', () => {
  it('round-trips output and exit code (simulating shell echo + run)', () => {
    const marker = '__CATGO_1_abc__'
    const wrapped = wrap_command('echo hi', marker)
    const raw = wrapped + `\r\n` +
      `\n${marker}_BEGIN\n` + `hi\n` + `\n${marker}_END_0\n` + `(base) $ `
    const res = extract_result(strip_ansi(raw), marker)
    expect(res).toEqual({ output: 'hi', exit_code: 0 })
  })
  it('returns null until END marker is present', () => {
    const marker = '__CATGO_2_def__'
    const raw = `\n${marker}_BEGIN\n` + 'partial output'
    expect(extract_result(raw, marker)).toBeNull()
  })
  it('captures a non-zero exit code', () => {
    const marker = '__CATGO_3_ghi__'
    const raw = `\n${marker}_BEGIN\n` + 'nope\n' + `\n${marker}_END_2\n`
    expect(extract_result(raw, marker)).toEqual({ output: 'nope', exit_code: 2 })
  })
  it('is not fooled by the echoed command (literal %s_BEGIN, quoted marker)', () => {
    const marker = '__CATGO_4_jkl__'
    const echo = `{ printf '\\n%s_BEGIN\\n' '${marker}'\necho hi\nprintf '\\n%s_END_%d\\n' '${marker}' "$?"\n}`
    const raw = echo + `\n${marker}_BEGIN\n` + 'hi\n' + `\n${marker}_END_0\n`
    expect(extract_result(raw, marker)).toEqual({ output: 'hi', exit_code: 0 })
  })
  it('ignores an END token that appears mid-line in command output', () => {
    const marker = '__CATGO_5_mno__'
    const raw = `\n${marker}_BEGIN\n` + `prefix ${marker}_END_9 still going\n` + `\n${marker}_END_0\n`
    expect(extract_result(raw, marker)).toEqual({ output: `prefix ${marker}_END_9 still going`, exit_code: 0 })
  })
})

describe('resolve_keys', () => {
  it('maps named keys to control bytes and passes literal text through', () => {
    expect(resolve_keys('y<enter>')).toBe('y\r')
    expect(resolve_keys('<c-c>')).toBe('\x03')
    expect(resolve_keys('<up><tab><esc>')).toBe('\x1b[A\t\x1b')
    expect(resolve_keys('plain')).toBe('plain')
  })
  it('exposes the key table', () => {
    expect(KEY_MAP['<enter>']).toBe('\r')
  })
})
