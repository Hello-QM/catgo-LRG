/**
 * Pure helpers for CatBot terminal control: ANSI stripping, command-output
 * markers (BEGIN..END_<exit>), and named-key resolution. No DOM / no PTY here —
 * keeps the logic unit-testable in isolation.
 */

/** Strip ANSI/VT control sequences (CSI, OSC, and stray C0 controls except \n\t). */
export function strip_ansi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

let _seq = 0
/** Unique per-call marker token. */
export function next_marker(): string {
  _seq += 1
  const rand = Math.random().toString(36).slice(2, 10)
  return `__CATGO_${_seq}_${rand}__`
}

/**
 * Wrap a user command in a brace group that prints BEGIN before and
 * END_<exit-code> after. Newlines (not `;`) separate the parts so multi-word /
 * piped commands pass through verbatim; `$?` is the user command's exit code.
 */
export function wrap_command(cmd: string, marker: string): string {
  return `{ printf '\\n%s_BEGIN\\n' '${marker}'\n${cmd}\nprintf '\\n%s_END_%d\\n' '${marker}' "$?"\n}\r`
}

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the captured output between `MARKER_BEGIN` and `MARKER_END_<code>` in the
 * accumulated (ANSI-stripped) PTY text. Returns null until the END marker lands.
 * The echoed command can't false-match: its literal text is `%s_BEGIN` and the
 * marker there is quote-wrapped, never `MARKER_BEGIN` / `MARKER_END_<digits>`.
 * The END match is newline-anchored (the real marker prints as `\n…_END_…`), so
 * a command whose own output contains the token mid-line can't truncate capture.
 * The per-call random marker makes deliberate collision near-impossible anyway.
 */
export function extract_result(raw: string, marker: string): { output: string; exit_code: number | null } | null {
  const begin = `${marker}_BEGIN`
  const bi = raw.indexOf(begin)
  if (bi < 0) return null
  const after = raw.slice(bi + begin.length)
  const m = after.match(new RegExp(`(?:^|\\n)${escape_re(marker)}_END_(\\d+)`))
  if (!m || m.index === undefined) return null
  const output = after.slice(0, m.index).replace(/^\n+/, '').replace(/\n+$/, '')
  return { output, exit_code: parseInt(m[1], 10) }
}

/** Named-key tokens → control bytes. Literal text passes through unchanged. */
export const KEY_MAP: Record<string, string> = {
  '<enter>': '\r',
  '<tab>': '\t',
  '<esc>': '\x1b',
  '<backspace>': '\x7f',
  '<space>': ' ',
  '<up>': '\x1b[A',
  '<down>': '\x1b[B',
  '<right>': '\x1b[C',
  '<left>': '\x1b[D',
  '<c-c>': '\x03',
  '<c-d>': '\x04',
  '<c-z>': '\x1a',
}

/** Replace `<...>` tokens with their bytes; everything else is literal. */
export function resolve_keys(keys: string): string {
  return keys.replace(/<[a-z-]+>/gi, (tok) => KEY_MAP[tok.toLowerCase()] ?? tok)
}
