// xterm 6.0.0 sometimes emits ONE genuine soft-keyboard insertion to `onData`
// twice (the iOS bug: typing "hello" -> "hhelllo"), because the async ordering
// of WKWebView IME events makes its internal compositionend/input bookkeeping
// double-fire. WebKit, however, fires `beforeinput` exactly ONCE per genuine
// insertion. So we gate `onData` on `beforeinput`: at most one onData chunk is
// forwarded per beforeinput whose `data` it matches; a second identical chunk is
// the duplicate and gets dropped. Non-matching chunks (control keys, arrows,
// split/multi-char bursts) are always forwarded — they never had (or don't match)
// the latest insertion, so the gate leaves them alone. This relies on the
// single-`beforeinput`-per-insertion invariant; worst case, if `beforeinput`
// never fires, `pending` stays null and BOTH emissions are forwarded — i.e. it
// degrades to today's behavior, no regression.
// iOS dictation streams `insertText` beforeinput events that REPLACE a range of
// the textarea (selStart..selEnd) with `data`, rather than appending — e.g. the
// partial "hel" is replaced by "hello". xterm emits only `data` and ignores the
// replaced range, so the PTY appends ("hel" + "hello" -> "helhello"). The PTY
// can't un-receive bytes, but it CAN backspace (DEL, 0x7f) at an interactive
// prompt. Given the pre-change textarea value, the replaced range, and the new
// data, compute how to reconcile the PTY (which mirrors `val`): how many DELs to
// erase the diverging tail, and the bytes to send. A common-prefix check avoids
// erasing/retyping the unchanged head, so an unchanged refinement ("hello" ->
// "hello") is a no-op — no flicker, no duplicate.
//
// ASSUMES the PTY is at an interactive shell prompt, where the visible line IS
// the line-editor buffer and a DEL erases one char. Inside a full-screen TUI
// (vim/less/a curses app) the DELs would not map to the buffer — dictation into
// a TUI is the known unsupported corner case. (Prefix compare is by UTF-16 code
// unit; a divergence mid-surrogate-pair could split an emoji — negligible for
// terminal input.)
export function reconcileReplacement(
  val: string,
  selStart: number,
  selEnd: number,
  data: string,
): { backspaces: number; send: string } {
  const old_trail = val.slice(selStart) // currently on the PTY line after selStart
  const new_trail = data + val.slice(selEnd) // what should be there after selStart
  const max = Math.min(old_trail.length, new_trail.length)
  let c = 0
  while (c < max && old_trail[c] === new_trail[c]) c++
  return { backspaces: old_trail.length - c, send: new_trail.slice(c) }
}

export function createInputDedup() {
  let pending: string | null = null
  let consumed = false
  return {
    note_before_input(data: string | null): void {
      if (data) {
        pending = data
        consumed = false
      }
    },
    accept(data: string): boolean {
      if (pending !== null && data === pending) {
        if (consumed) return false
        consumed = true
        return true
      }
      return true
    },
  }
}
