/** Map a printable key to its control character (Ctrl+key), or null when the
 * key has no control mapping. Shared by the terminal key bar (folding its own
 * buttons) and MobileTerminal (folding the next soft-keyboard char while the
 * key bar's sticky Ctrl is armed). */
export function to_control(ch: string): string | null {
  if (ch.length !== 1) return null
  const c = ch.toLowerCase()
  const code = c.charCodeAt(0)
  // Ctrl-A..Ctrl-Z -> 0x01..0x1a
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  // A handful of standard non-letter control mappings.
  switch (ch) {
    case `@`:
    case ` `:
      return `\x00`
    case `[`:
      return `\x1b`
    case `\\`:
      return `\x1c`
    case `]`:
      return `\x1d`
    case `^`:
      return `\x1e`
    case `_`:
    case `/`:
      return `\x1f`
    default:
      return null
  }
}
