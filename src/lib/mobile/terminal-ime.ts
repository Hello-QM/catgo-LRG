// WKWebView (Tauri's webview on iOS/macOS) does not fire standard composition
// events reliably for CJK IME. Instead it routes composed text through
// non-standard `beforeinput` inputTypes:
//   - Chinese Pinyin: `insertFromComposition` (committed) + a real compositionend
//   - Korean Hangul:  `insertReplacementText` (the syllable rebuilds as you type)
//   - either:         `insertText` for individual CJK characters
// xterm.js's built-in CompositionHelper only handles the standard events, so CJK
// input is garbled in WKWebView. This guard mirrors the proven desktop fix in
// `src/lib/structure/TerminalPanel.svelte` (based on xterm.js PR #5704): it
// buffers the composed text and writes it to the PTY itself, suppressing xterm's
// own emission during composition plus a short confirmation-key residue window.
//
// It is intentionally split out as a pure factory (no DOM, injectable clock) so
// the suppression/flush logic can be unit-tested without a real WebView, which
// jsdom cannot emulate. The Svelte component owns the DOM wiring.

/** CJK (Chinese / Japanese / Korean) detection on the first code point. */
export function isCJK(text: string): boolean {
  const cp = text.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols & Punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xd7b0 && cp <= 0xd7ff) //    Hangul Jamo Extended-B
  )
}

/** Hangul (Korean) on the first code point. A Hangul jamo/syllable typed as a
 *  standalone insertText may be REBUILT by a following insertReplacementText, so
 *  it must be buffered; non-Hangul CJK (Chinese/Japanese) insertText is final. */
export function isHangul(text: string): boolean {
  const cp = text.codePointAt(0) ?? 0
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xd7b0 && cp <= 0xd7ff) //    Hangul Jamo Extended-B
  )
}

// After a composition commits, xterm's deferred _finalizeComposition (and the
// textarea clear we do) can emit a stray space/enter. Swallow those for a brief
// window. The window is armed ONLY by a composition ending, so pure Latin typing
// never enters it (a deliberately-typed space/Enter is never eaten).
// `\u00a0` (non-breaking space) is included because some IMEs/keyboards emit NBSP
// rather than a plain space as the confirmation key after a composition.
// DEL (`\x7f`, Backspace) is deliberately NOT in this set \u2014 see should_suppress.
const POST_COMPOSE_MS = 80
const IME_CONFIRM_KEYS = new Set([` `, `\n`, `\r`, `\u00a0`])

export interface ImeGuard {
  /** From `beforeinput`. Returns true if this was a CJK-composition event the
   *  guard consumed — the caller must then `preventDefault()` and must NOT note
   *  it for the Latin dedup. Returns false for ordinary Latin input. */
  on_before_input(input_type: string, data: string | null): boolean
  /** From `compositionstart`. */
  on_composition_start(): void
  /** From `compositionend`. Writes the committed text via the guard's `write`. */
  on_composition_end(committed: string | null): void
  /** From `keydown` — flushes a pending WK buffer on a real (non-IME) key. */
  on_keydown(key_code: number): void
  /** Call when the caller clears the textarea after a commit: xterm's
   *  bookkeeping sees the length decrease and emits one synthetic DEL per
   *  vanished char. Arms a debt so should_suppress can eat exactly those. */
  note_textarea_clear(chars: number): void
  /** From the top of `onData`. Returns true if `data` should be SUPPRESSED:
   *  we're mid-composition, it's confirmation-key residue just after one, or
   *  it's a synthetic DEL covered by the textarea-clear debt. */
  should_suppress(data: string): boolean
}

export function createImeGuard(opts: {
  write: (text: string) => void
  /** Injectable clock for tests; defaults to performance.now. */
  now?: () => number
  /** iOS: dictation streams Chinese/Japanese as `insertText` events that REPLACE
   *  the previous partial transcript (same shape as Latin dictation), so the
   *  write-on-arrival below would re-send the full partial on every refinement
   *  ("你"+"你好"+"你好世界") and preventDefault would starve the textarea the
   *  caller diffs against. With this flag the guard flushes any pending buffer
   *  and returns false for non-Hangul CJK insertText, letting the caller run its
   *  dictation reconcile path instead. Hangul insertText is still buffered — a
   *  typed jamo/syllable may be REBUILT by a following insertReplacementText. */
  bypass_cjk_insert_text?: boolean
}): ImeGuard {
  const now = opts.now ?? (() => performance.now())
  let wk_composing = false // true while a WK synthetic composition is buffering
  let wk_pending = `` //       the buffered composed text awaiting flush
  let std_composing = false // true during a standard compositionstart..end
  let post_compose_until = 0 // suppress confirmation-key residue until this time
  let del_debt = 0 //          synthetic DELs still expected from a textarea clear

  const flush = (): void => {
    if (!wk_composing) return
    const text = wk_pending
    wk_composing = false
    wk_pending = ``
    if (text) opts.write(text)
    post_compose_until = now() + POST_COMPOSE_MS
  }

  return {
    on_before_input(input_type, data) {
      // Chinese Pinyin committed text — block xterm's accumulation; the actual
      // commit arrives via the standard compositionend below.
      if (input_type === `insertFromComposition`) return true
      // Korean/CJK composition update — buffer the latest value (it replaces the
      // previous partial, e.g. ㅎ → 하 → 한). Non-CJK insertReplacementText is iOS
      // Latin autocorrect: let it through so we never swallow a corrected word.
      if (input_type === `insertReplacementText` && data && isCJK(data)) {
        wk_composing = true
        wk_pending = data
        return true
      }
      if (input_type === `insertText` && data && isCJK(data)) {
        flush() // emit any prior buffered partial first
        if (isHangul(data)) {
          // A standalone Hangul jamo/syllable may be REBUILT by a following
          // insertReplacementText (ㅎ → 하 → 한, or 가 → 각) — buffer it so the
          // rebuild replaces rather than appends.
          wk_composing = true
          wk_pending = data
        } else if (opts.bypass_cjk_insert_text) {
          // iOS dictation partial — not consumed; the caller reconciles it
          // against the textarea (see MobileTerminal's beforeinput handler).
          return false
        } else {
          // Chinese / Japanese: the committed word arrives as a collapsed
          // insertText with NO composition events on this WebView (observed on
          // Android). It is final and never rebuilt, so write it on arrival.
          // Buffering it would strand the LAST word — it would flush only on the
          // NEXT event, dropping the latest input ("会少最新的输入").
          opts.write(data)
          post_compose_until = now() + POST_COMPOSE_MS
        }
        return true
      }
      return false
    },
    on_composition_start() {
      std_composing = true
      post_compose_until = 0
    },
    on_composition_end(committed) {
      std_composing = false
      post_compose_until = now() + POST_COMPOSE_MS
      // The composition is over: emit the final text and CLEAR the WK buffer so
      // the last CJK word is never stranded waiting for a keydown that won't come
      // ("会少最新的输入" — the latest word dropped). Prefer the event's committed
      // data; fall back to the buffered partial when the platform delivers the
      // text via beforeinput and sends a dataless compositionend.
      const text = committed || wk_pending
      wk_composing = false
      wk_pending = ``
      if (text) opts.write(text)
    },
    on_keydown(key_code) {
      // keyCode 229 = "IME is processing" — don't flush mid-composition.
      if (wk_composing && key_code !== 229) flush()
    },
    note_textarea_clear(chars) {
      del_debt = Math.max(0, chars)
    },
    should_suppress(data) {
      // DELs need source discrimination:
      //  - SYNTHETIC: after the caller clears the textarea post-commit, xterm
      //    emits one DEL per vanished char — eat those against the armed debt
      //    (within the residue window) or they backspace over the freshly
      //    committed text ("吞字": committed Chinese loses its tail).
      //  - REAL user backspace: never swallow (unreliable compositionend can
      //    leave std_composing stuck true, which once ate every backspace).
      if (/^\x7f+$/.test(data)) {
        if (del_debt > 0 && now() < post_compose_until) {
          const eat = Math.min(data.length, del_debt)
          del_debt -= eat
          // Partial chunks beyond the debt are real — let the caller send the
          // remainder itself is not expressible here, so only suppress when
          // the WHOLE chunk is covered; otherwise treat it all as real.
          if (eat === data.length) return true
          del_debt = 0
          return false
        }
        del_debt = 0
        return false
      }
      // Any non-DEL input means the synthetic DELs are no longer coming.
      del_debt = 0
      if (std_composing || wk_composing) return true
      if (post_compose_until > 0) {
        if (now() < post_compose_until && IME_CONFIRM_KEYS.has(data)) return true
        post_compose_until = 0
      }
      return false
    },
  }
}
