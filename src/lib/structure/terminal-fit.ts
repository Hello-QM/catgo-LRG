/**
 * xterm's FitAddon reserves a fixed 14px for its vertical scrollbar. Native
 * scrollbar widths vary with the OS, display scaling, and browser zoom, so the
 * final terminal column can still end up underneath the scrollbar. Reserve two
 * additional cells: one complete CJK/full-width glyph can then never occupy the
 * obscured edge.
 */
export const TERMINAL_SCROLLBAR_GUARD_COLS = 2

/** Preserve the active wrapped-line group when font/viewport changes resize it. */
export const TERMINAL_REFLOW_CURSOR_LINE = true

export interface TerminalDimensions {
  cols: number
  rows: number
}

export function guard_terminal_dimensions(
  proposed: TerminalDimensions,
  guard_cols = TERMINAL_SCROLLBAR_GUARD_COLS,
): TerminalDimensions {
  return {
    cols: Math.max(2, proposed.cols - Math.max(0, guard_cols)),
    rows: Math.max(1, proposed.rows),
  }
}
