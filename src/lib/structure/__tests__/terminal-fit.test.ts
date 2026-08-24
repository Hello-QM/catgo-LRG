import { describe, expect, it } from 'vitest'
import {
  apply_terminal_font_options,
  guard_terminal_dimensions,
  TERMINAL_REFLOW_CURSOR_LINE,
  TERMINAL_SCROLLBAR_GUARD_COLS,
} from '../terminal-fit'

describe('terminal scrollbar guard', () => {
  it('keeps the active Codex TUI transcript eligible for resize reflow', () => {
    expect(TERMINAL_REFLOW_CURSOR_LINE).toBe(true)
  })

  it('repairs a pre-HMR terminal when its font changes', () => {
    const options = {
      fontSize: 13,
      fontFamily: 'monospace',
      reflowCursorLine: false,
    }

    apply_terminal_font_options(options, 14, 'JetBrains Mono')

    expect(options).toEqual({
      fontSize: 14,
      fontFamily: 'JetBrains Mono',
      reflowCursorLine: true,
    })
  })

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
