import { describe, expect, it } from 'vitest'
import {
  guard_terminal_dimensions,
  TERMINAL_SCROLLBAR_GUARD_COLS,
} from '../terminal-fit'

describe('terminal scrollbar guard', () => {
  it('reserves one complete full-width glyph beyond FitAddon geometry', () => {
    expect(TERMINAL_SCROLLBAR_GUARD_COLS).toBe(2)
    expect(guard_terminal_dimensions({ cols: 131, rows: 28 })).toEqual({
      cols: 129,
      rows: 28,
    })
  })

  it('keeps xterm minimum dimensions for very small panels', () => {
    expect(guard_terminal_dimensions({ cols: 2, rows: 0 })).toEqual({
      cols: 2,
      rows: 1,
    })
  })
})
