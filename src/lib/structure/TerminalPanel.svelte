<script lang="ts">
  // Note: PTY operations (write, resize, kill) use .catch(() => {}) throughout this file.
  // This is intentional — the PTY session may be dead or disconnected, and these are
  // best-effort fire-and-forget operations where failure is expected and non-critical.
  import { spawnPty, type PtySession } from '$lib/api/pty'
  import { Icon } from '$lib'
  import { theme_state, terminal_font_state, save_terminal_font_state, TERMINAL_FONT_FAMILIES } from '$lib/state.svelte'
  import { register_terminal, unregister_terminal, mark_terminal_active } from './terminal-registry.svelte'
  import { next_marker, wrap_command, extract_result, strip_ansi } from './terminal-capture'

  let {
    layout = `horizontal`,
    session_id,
    host,
    username,
    shell,
    font_size = 13,
    font_family = `'JetBrains Mono', monospace`,
    sync_cwd = $bindable(false),
    show_header = true,
    onclose,
    ondisconnect,
    onlayout_toggle,
    onpopout,
    on_cwd_change,
    on_open_file,
  }: {
    layout?: `horizontal` | `vertical`
    /** HPC session_id for remote SSH terminal. Omit for local shell. */
    session_id?: string
    /** Remote host display name (shown in header). */
    host?: string
    /** Remote username display name (shown in header). */
    username?: string
    /** Shell ID to use for local terminal (e.g. 'powershell', 'git-bash'). */
    shell?: string
    /** Terminal font size (10-24). */
    font_size?: number
    /** Terminal font family CSS string. */
    font_family?: string
    /** Whether to sync CWD changes to the Files panel. Bindable for toggle. */
    sync_cwd?: boolean
    /** Whether to show the built-in header bar. Set false when embedded in TerminalWindow. */
    show_header?: boolean
    onclose?: () => void
    /** Disconnect and kill the PTY session (as opposed to just hiding/minimizing). */
    ondisconnect?: () => void
    onlayout_toggle?: () => void
    onpopout?: () => void
    on_cwd_change?: (path: string) => void
    /** Callback when user Ctrl+clicks a file path in the terminal output. */
    on_open_file?: (file_path: string) => void
  } = $props()

  let container_el: HTMLDivElement | undefined = $state()
  let status = $state<`init` | `connected` | `error` | `exited` | `reconnecting`>(`init`)
  let error_msg = $state(``)
  /** Module-level PTY session ref for reactive sync_cwd injection. */
  let pty_ref = $state<PtySession | null>(null)
  /** Module-level xterm ref for reactive theme updates. */
  let term_ref: any = null
  /** Module-level fit addon ref for reactive font updates. */
  let fit_ref: any = null
  /** Current working directory tracked via OSC 7 — used to resolve relative file paths. */
  let current_cwd = $state(``)
  /** Monotonic sequence counter for CWD broadcasts — receivers discard stale messages. */
  let _cwd_seq = 0
  let show_font_menu = $state(false)

  const title = $derived(
    host ? `${username || ``}@${host}` : `Terminal`
  )

  // Always inject OSC 7 PROMPT_COMMAND once the PTY is up — local OR remote (needed for
  // Ctrl+click path resolution and Directory Sync even when sync_cwd is off). Local shells
  // need it just as much as remote: a plain bash emits no OSC 7 on its own, so without this
  // the local Files panel never follows the terminal's cwd. sync_cwd only controls whether
  // CWD changes are broadcast to the file browser.
  const panel_id = `term-panel-${Math.random().toString(36).slice(2, 10)}`
  let _run_busy = false
  let _registered = false

  async function panel_run_command(
    cmd: string,
    opts?: { timeout_ms?: number },
  ): Promise<{ output: string; exit_code: number | null; running: boolean }> {
    const pty = pty_ref
    if (!pty) return { output: 'Terminal not ready.', exit_code: null, running: false }
    if (_run_busy) return { output: 'Terminal is busy running another command.', exit_code: null, running: false }
    if (panel_is_alt_screen()) {
      return {
        output: 'The terminal is inside tmux or a full-screen app (alternate screen). '
          + 'Command capture is unreliable here — use send_keys to type the command '
          + 'followed by "<enter>", then read the terminal to see the result.',
        exit_code: null,
        running: true,
      }
    }
    _run_busy = true
    const marker = next_marker()
    const decoder = new TextDecoder()
    let acc = ''
    let settle: ((v: { output: string; exit_code: number | null; running: boolean }) => void) | null = null
    let timeout_handle: ReturnType<typeof setTimeout> | null = null
    const done = new Promise<{ output: string; exit_code: number | null; running: boolean }>((resolve) => {
      settle = resolve
    })
    const off = pty.onData((bytes) => {
      acc += decoder.decode(bytes, { stream: true })
      const res = extract_result(strip_ansi(acc), marker)
      if (res) {
        if (timeout_handle) clearTimeout(timeout_handle)
        settle?.({ output: res.output.slice(-8000), exit_code: res.exit_code, running: false })
      }
    })
    timeout_handle = setTimeout(() => {
      settle?.({ output: strip_ansi(acc).slice(-4000), exit_code: null, running: true })
    }, opts?.timeout_ms ?? 15000)
    try {
      await pty.write(wrap_command(cmd, marker))
      return await done
    } finally {
      off()
      if (timeout_handle) clearTimeout(timeout_handle)
      _run_busy = false
    }
  }

  async function panel_send_keys(data: string): Promise<void> {
    if (pty_ref) await pty_ref.write(data)
  }

  async function panel_interrupt(): Promise<void> {
    if (pty_ref) await pty_ref.write('\x03')
  }

  // True when the terminal is showing the alternate screen — i.e. a full-screen
  // app owns the display: tmux, vim, less, htop, etc. Marker-based run_command
  // is unreliable there (constant redraws garble the markers, and if the active
  // pane runs an app the command text is typed INTO it), so run_command refuses
  // and steers the caller to send_keys + read instead.
  function panel_is_alt_screen(): boolean {
    return term_ref?.buffer?.active?.type === 'alternate'
  }

  function panel_read_buffer(lines = 40): string {
    const term = term_ref
    if (!term?.buffer?.active) return ''
    const buf = term.buffer.active
    const end = buf.baseY + buf.cursorY
    const start = Math.max(0, end - lines)
    const out: string[] = []
    for (let y = start; y <= end; y++) {
      const line = buf.getLine(y)
      if (line) out.push(line.translateToString(true))
    }
    return out.join('\n').replace(/\n+$/, '')
  }

  let _osc7_injected = false
  let _osc7_quiescence_timer: ReturnType<typeof setTimeout> | null = null
  let _osc7_data_listener: (() => void) | null = null
  $effect(() => {
    if (!pty_ref) {
      if (_registered) { unregister_terminal(panel_id); _registered = false }
      _osc7_injected = false
      if (_osc7_quiescence_timer) clearTimeout(_osc7_quiescence_timer)
      if (_osc7_data_listener) { _osc7_data_listener(); _osc7_data_listener = null }
      return
    }
    if (!_registered) {
      _registered = true
      register_terminal({
        id: panel_id,
        session_id: session_id ?? '',
        host,
        username,
        is_remote: !!session_id,
        run_command: panel_run_command,
        send_keys: panel_send_keys,
        interrupt: panel_interrupt,
        read_buffer: panel_read_buffer,
      })
    }
    if (!_osc7_injected) {
      _osc7_injected = true
      // Wait for shell to be ready: after SSH login, MOTD, bashrc finish, output goes
      // quiet. We detect "quiescence" — no new data for 800ms after at least some data
      // has arrived. This avoids injecting the OSC 7 command while MOTD is still printing.
      const pty = pty_ref
      let got_data = false
      const inject = () => {
        if (_osc7_data_listener) { _osc7_data_listener(); _osc7_data_listener = null }
        const cmd = ` export __CATGO_OSC7=1; PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "$HOSTNAME" "$PWD"'; clear\r`
        pty.write(cmd).catch(() => {})
      }
      const reset_timer = () => {
        if (_osc7_quiescence_timer) clearTimeout(_osc7_quiescence_timer)
        _osc7_quiescence_timer = setTimeout(inject, 800)
      }
      // Listen for PTY data events to detect output quiescence
      _osc7_data_listener = pty.onData(() => {
        got_data = true
        reset_timer()
      })
      // Fallback: if no data at all after 5s (e.g. silent shell), inject anyway
      _osc7_quiescence_timer = setTimeout(() => {
        if (!got_data) inject()
      }, 5000)
    }
  })

  $effect(() => {
    if (!container_el) return

    let terminal: any = null
    let fit_addon: any = null
    let observer: ResizeObserver | null = null
    let vis_observer: IntersectionObserver | null = null
    let pty_session: PtySession | null = null
    let unlisten_data: (() => void) | null = null
    let unlisten_exit: (() => void) | null = null
    let disposed = false

    async function init() {
      try {
        // Dynamic import for SSR safety
        const [xtermMod, fitMod, webglMod, linksMod] = await Promise.all([
          import(`@xterm/xterm`),
          import(`@xterm/addon-fit`),
          import(`@xterm/addon-webgl`),
          import(`@xterm/addon-web-links`),
        ])

        if (disposed) return

        // Import xterm CSS
        await import(`@xterm/xterm/css/xterm.css`)

        // Terminal always uses a dark theme — ANSI colors are designed for dark backgrounds
        const term_bg = `#0e1117`
        const term_fg = `#e0e0e0`

        const term = new xtermMod.Terminal({
          cursorBlink: true,
          fontSize: terminal_font_state.font_size,
          fontFamily: terminal_font_state.font_family,
          theme: {
            background: term_bg,
            foreground: term_fg,
            cursor: `#3b82f6`,
            cursorAccent: term_bg,
            selectionBackground: `rgba(59, 130, 246, 0.3)`,
            black: term_bg,
            red: `#ff6b6b`,
            green: `#51cf66`,
            yellow: `#ffd43b`,
            blue: `#74c0fc`,
            magenta: `#da77f2`,
            cyan: `#66d9e8`,
            white: `#e0e0e0`,
            brightBlack: `#555`,
            brightRed: `#ff8787`,
            brightGreen: `#69db7c`,
            brightYellow: `#ffe066`,
            brightBlue: `#91d5ff`,
            brightMagenta: `#e599f7`,
            brightCyan: `#99e9f2`,
            brightWhite: `#ffffff`,
          },
          allowProposedApi: true,
        })

        const fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.loadAddon(new linksMod.WebLinksAddon())

        // Ensure the configured webfont is loaded BEFORE xterm measures the cell
        // size in term.open(). If it measures against a fallback first, it bakes
        // in a wrong advance width and renders glyphs wide-spaced until the next
        // resize. Best-effort: the Font Loading API may be absent in some webviews.
        try {
          const fam = terminal_font_state.font_family
          const px = terminal_font_state.font_size
          await Promise.all([
            (document as Document).fonts?.load(`${px}px ${fam}`),
            (document as Document).fonts?.load(`bold ${px}px ${fam}`),
          ])
        } catch {
          // Font Loading API unavailable — DOM renderer still works, just may
          // need a resize to settle metrics on first paint.
        }
        if (disposed) { term.dispose(); return }

        term.open(container_el!)

        // File path link provider — must be registered AFTER term.open() so xterm's
        // link detection infrastructure is initialized (xterm v6 requirement).
        if (on_open_file) {
          term.registerLinkProvider({
            provideLinks(y: number, callback: (links: any[] | undefined) => void) {
              const line = term.buffer.active.getLine(y - 1)
              if (!line) { callback(undefined); return }
              const text = line.translateToString()
              const links: any[] = []
              const re = /(?:~\/[\w._\/-]+|(?:\/[\w._-]+){2,}(?:\.\w+)?|(?:^|(?<=\s))[\w][\w._-]*\.[\w]+(?=\s|$)|(?:^|(?<=\s))(?:POSCAR|CONTCAR|INCAR|OUTCAR|KPOINTS|POTCAR|DOSCAR|EIGENVAL|PROCAR|CHGCAR|WAVECAR|XDATCAR|vasprun\.xml)(?=\s|$))/g
              let match: RegExpExecArray | null
              while ((match = re.exec(text)) !== null) {
                const start_x = match.index + 1  // 1-based
                const end_x = match.index + match[0].length
                links.push({
                  range: {
                    start: { x: start_x, y },
                    end: { x: end_x, y },
                  },
                  text: match[0],
                  decorations: { pointerCursor: true, underline: true },
                  activate(_event: MouseEvent, text: string) {
                    // Only activate on Ctrl+click (or Cmd+click on macOS)
                    if (!_event.ctrlKey && !_event.metaKey) return
                    // Resolve relative paths using tracked CWD
                    const resolved = text.startsWith(`/`) || text.startsWith(`~/`) ? text : (current_cwd ? `${current_cwd}/${text}` : text)
                    on_open_file!(resolved)
                  },
                })
              }
              callback(links.length > 0 ? links : undefined)
            },
          })
        }

        // Delay initial fit until the container is laid out (avoids wrong column count)
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          if (!disposed) fit.fit()
          resolve()
        }))
        if (disposed) { term.dispose(); return }

        // Renderer: default to the DOM renderer (no addon).
        //
        // The WebGL addon's glyph texture atlas corrupts on some browser/GPU
        // combos — glyphs render as black tofu boxes (random letters, not a
        // font-coverage issue). It was already skipped in Tauri (WebKitGTK +
        // NVIDIA perf), and the same corruption hit the browser/desktop:serve
        // path, so it is now opt-in only. The DOM renderer has no atlas and
        // never corrupts; it is plenty fast for terminal text. Set
        // localStorage["catgo_terminal_webgl"] = "1" to re-enable GPU accel.
        const want_webgl = (() => {
          try { return globalThis.localStorage?.getItem(`catgo_terminal_webgl`) === `1` } catch { return false }
        })()
        if (want_webgl && !(`__TAURI_INTERNALS__` in window)) {
          try {
            const webgl = new webglMod.WebglAddon()
            webgl.onContextLoss(() => webgl.dispose())
            term.loadAddon(webgl)
          } catch {
            // WebGL not available, DOM renderer is fine
          }
        }

        // Copy on selection: when user selects text, auto-copy to clipboard
        term.onSelectionChange(() => {
          const selection = term.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {})
          }
        })

        // Right-click paste
        container_el!.addEventListener(`contextmenu`, async (e) => {
          e.preventDefault()
          e.stopPropagation() // Prevent Structure wrapper from showing atom context menu
          try {
            const text = await navigator.clipboard.readText()
            if (text) term.paste(text)
          } catch {
            // Clipboard API not available
          }
        })

        // OSC 7 handler: intercept CWD change notifications from shell
        term.parser.registerOscHandler(7, (data: string) => {
          try {
            let path: string
            if (data.startsWith(`file://`)) {
              const url = new URL(data)
              path = url.pathname
            } else {
              path = data
            }
            // Always track CWD locally for resolving relative file paths on Ctrl+click
            current_cwd = path
            if (sync_cwd) {
              const seq = ++_cwd_seq
              // Local callback (inline terminal in Structure.svelte)
              on_cwd_change?.(path)
              // Window-local sync only — each window's Files panel follows its own
              // terminal. No cross-window BroadcastChannel: a popped-out terminal must
              // NOT move the origin window's file system (windows are independent).
              window.dispatchEvent(new CustomEvent(`catgo-terminal-cwd`, { detail: { path, session_id, seq } }))
            }
          } catch {
            // Malformed URL, ignore
          }
          return true
        })

        terminal = term
        term_ref = term
        term.textarea?.addEventListener('focus', () => mark_terminal_active(panel_id))
        fit_addon = fit
        fit_ref = fit

        // Register resize handler BEFORE spawning PTY to avoid missing resize
        // events that fire during the async spawnPty() call
        let pending_resize: { cols: number; rows: number } | null = null
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (pty_session) {
            pty_session.resize(cols, rows).catch(() => {})
          } else {
            // PTY not ready yet — save for sync after spawn
            pending_resize = { cols, rows }
          }
        })

        // ─── IME composition handling (WebKit / Tauri WKWebView) ───
        //
        // Based on xterm.js PR #5704 (minemos/xterm.js, fix/wkwebview-korean-ime).
        // Remove this block when xterm.js merges that PR and we upgrade.
        //
        // Problem: WKWebView (used by Tauri on macOS/Linux) does not fire
        // standard composition events reliably for CJK IME. Instead:
        //   - Chinese Pinyin: insertFromComposition (committed text)
        //   - Korean Hangul: insertReplacementText (composition updates)
        //   - Both: insertText for individual characters
        // xterm.js's built-in CompositionHelper only handles standard
        // composition events, so CJK input is broken in WKWebView.
        //
        // Solution: intercept beforeinput events at the textarea level,
        // buffer composed text, and flush to PTY at the right moment.
        // This mirrors PR #5704's approach but implemented externally.

        let wk_composing = false       // true while WK synthetic composition is active
        let wk_pending = ``            // buffered composed text waiting to flush
        let std_composing = false      // true during standard compositionstart..end
        let post_compose_until = 0     // suppress confirmation-key residue until this time

        const POST_COMPOSE_MS = 80
        // DEL (`\x7f`, Backspace) is deliberately NOT here \u2014 it is never IME
        // residue, and WebKit's unreliable CJK compositionend can otherwise
        // leave std_composing stuck and eat every backspace (see onData below).
        const IME_CONFIRM_KEYS = new Set([` `, `\n`, `\r`, `\u00a0`])

        // ─── IME event tracing (enable: window.__CATGO_IME_DEBUG = true) ───
        const ime_log = (...args: any[]) => {
          if ((window as any).__CATGO_IME_DEBUG) {
            console.log(`[IME]`, ...args)
          }
        }

        /** Detect CJK characters (Chinese, Japanese, Korean) */
        function isCJK(text: string): boolean {
          const cp = text.codePointAt(0) ?? 0
          return (
            (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
            (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
            (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols
            (cp >= 0x3040 && cp <= 0x30FF) ||   // Hiragana + Katakana
            (cp >= 0x1100 && cp <= 0x11FF) ||   // Hangul Jamo
            (cp >= 0x3130 && cp <= 0x318F) ||   // Hangul Compatibility Jamo
            (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
            (cp >= 0xA960 && cp <= 0xA97F) ||   // Hangul Jamo Extended-A
            (cp >= 0xD7B0 && cp <= 0xD7FF)      // Hangul Jamo Extended-B
          )
        }

        /** Flush buffered WK composition text to PTY */
        function wkFlush(): void {
          if (!wk_composing) return
          const text = wk_pending
          wk_composing = false
          wk_pending = ``
          if (text) {
            ime_log(`wkFlush → PTY write`, { data: text })
            pty_session?.write(text).catch(() => {})
          }
          post_compose_until = performance.now() + POST_COMPOSE_MS
        }

        const xt_textarea = term.textarea
        if (xt_textarea) {
          // ─── Standard composition events (Chinese Pinyin primarily) ───
          xt_textarea.addEventListener(`compositionstart`, () => {
            ime_log(`compositionstart`)
            std_composing = true
            post_compose_until = 0
          })
          xt_textarea.addEventListener(`compositionend`, (e: CompositionEvent) => {
            ime_log(`compositionend`, { data: e.data, textarea: xt_textarea.value })
            std_composing = false
            post_compose_until = performance.now() + POST_COMPOSE_MS
            // Prefer the event's committed data; fall back to the buffered WK
            // partial and CLEAR the buffer so the last CJK word is never stranded
            // waiting for a keydown that won't come ("会少最新的输入").
            const committed = e.data || wk_pending
            wk_composing = false
            wk_pending = ``
            if (committed) {
              ime_log(`compositionend → PTY write`, { data: committed })
              pty_session?.write(committed).catch(() => {})
            }
            // Clear textarea synchronously to prevent xterm's _finalizeComposition
            // (setTimeout(0)) from reading stale content and sending it to PTY.
            // This causes xterm's _handleAnyTextareaChanges to see a length
            // decrease and emit DEL (0x7F), but we suppress that via
            // IME_CONFIRM_KEYS in the post-composition window.
            if (xt_textarea.value) {
              ime_log(`textarea clear`, { was: xt_textarea.value })
              xt_textarea.value = ``
            }
          })

          // ─── beforeinput: intercept WKWebView-specific IME events ───
          xt_textarea.addEventListener(`beforeinput`, (e: InputEvent) => {
            const data = e.data
            // Log ALL beforeinput events for debugging
            ime_log(`beforeinput`, { inputType: e.inputType, data, isComposing: e.isComposing })

            // insertFromComposition: WKWebView Chinese Pinyin committed text.
            // Block xterm's internal processing (prevents textarea accumulation).
            if (e.inputType === `insertFromComposition`) {
              e.preventDefault()
              ime_log(`beforeinput BLOCKED insertFromComposition`, { data })
              return
            }

            // insertReplacementText: WKWebView Korean/CJK composition update.
            // Buffer the latest value (replaces previous partial, e.g. ㅎ→하→한).
            if (e.inputType === `insertReplacementText` && data) {
              wk_composing = true
              wk_pending = data
              ime_log(`beforeinput insertReplacementText → buffer`, { data })
              e.preventDefault()
              e.stopPropagation()
              return
            }

            // insertText with a CJK character. Flush any previous partial first.
            if (e.inputType === `insertText` && data && isCJK(data)) {
              wkFlush()
              const cp0 = data.codePointAt(0) ?? 0
              const isHangul = (cp0 >= 0x1100 && cp0 <= 0x11FF) ||
                (cp0 >= 0x3130 && cp0 <= 0x318F) || (cp0 >= 0xAC00 && cp0 <= 0xD7AF) ||
                (cp0 >= 0xA960 && cp0 <= 0xA97F) || (cp0 >= 0xD7B0 && cp0 <= 0xD7FF)
              if (isHangul) {
                // Korean jamo/syllable may be REBUILT by a following
                // insertReplacementText (ㅎ→하→한, 가→각) — buffer it.
                wk_composing = true
                wk_pending = data
                ime_log(`beforeinput insertText Hangul → buffer`, { data })
              } else {
                // Chinese/Japanese: the committed word arrives as a collapsed
                // insertText with NO composition events. It is final and never
                // rebuilt — write it on arrival. Buffering it would strand the
                // LAST word (flushed only on the NEXT event), dropping the latest
                // input ("会少最新的输入").
                pty_session?.write(data).catch(() => {})
                post_compose_until = performance.now() + POST_COMPOSE_MS
                ime_log(`beforeinput insertText CJK → PTY write`, { data })
              }
              e.preventDefault()
              e.stopPropagation()
              return
            }
          })

          // ─── keydown: flush WK buffer on non-IME keystrokes ───
          xt_textarea.addEventListener(`keydown`, (e: KeyboardEvent) => {
            // keyCode 229 = IME processing, don't flush yet
            if (wk_composing && e.keyCode !== 229) {
              ime_log(`keydown flush`, { key: e.key, keyCode: e.keyCode })
              wkFlush()
            }
          })
        }

        // Terminal input → PTY
        // Suppress onData during any form of IME composition, and suppress
        // confirmation-key residue (space/enter) briefly after composition ends.
        term.onData((data: string) => {
          // A Backspace/DEL is always a real edit intent — never swallow it.
          // WebKit fires compositionend unreliably for CJK, so std_composing can
          // stick `true` and would otherwise eat every backspace, leaving the
          // user unable to delete Chinese they just typed.
          if (data === `\x7f`) {
            pty_session?.write(data).catch(() => {})
            return
          }
          if (std_composing || wk_composing) {
            ime_log(`onData SUPPRESS (composing)`, { data, hex: [...data].map(c => c.codePointAt(0)!.toString(16)) })
            return
          }
          if (post_compose_until > 0) {
            if (performance.now() < post_compose_until && IME_CONFIRM_KEYS.has(data)) {
              ime_log(`onData SUPPRESS (post-composition residue)`, { data })
              return
            }
            post_compose_until = 0
          }
          ime_log(`onData → PTY`, { data, hex: [...data].map(c => c.codePointAt(0)!.toString(16)) })
          pty_session?.write(data).catch(() => {})
        })

        // Auto-resize on container size change
        observer = new ResizeObserver(() => {
          requestAnimationFrame(() => {
            if (!disposed && fit_addon) {
              try { fit_addon.fit() } catch { /* ignore */ }
            }
          })
        })
        observer.observe(container_el!)

        // Visibility-aware fit: when tab transitions from hidden to visible
        // (visibility:hidden → visible), ResizeObserver won't fire because
        // dimensions don't change. Use IntersectionObserver to detect this.
        vis_observer = new IntersectionObserver((entries) => {
          if (disposed) return
          for (const entry of entries) {
            if (entry.isIntersecting && fit_addon) {
              requestAnimationFrame(() => {
                if (!disposed) {
                  try { fit_addon.fit() } catch { /* ignore */ }
                }
              })
            }
          }
        })
        vis_observer.observe(container_el!)

        // Spawn PTY session (local or remote)
        // Guard: if fit() couldn't calculate proper dimensions (container not laid out),
        // term.cols/rows might be 0. ConPTY on Windows produces no output with 0x0.
        const spawn_cols = term.cols > 0 ? term.cols : 80
        const spawn_rows = term.rows > 0 ? term.rows : 24
        const session = await spawnPty(spawn_cols, spawn_rows, {
          session_id,
          shell,
        })
        if (disposed) {
          session.kill().catch(() => {})
          session.dispose()
          return
        }
        pty_session = session
        pty_ref = session
        status = `connected`

        // If a resize happened during spawn, sync the PTY now
        if (pending_resize) {
          session.resize((pending_resize as any).cols, (pending_resize as any).rows).catch(() => {})
          pending_resize = null
        }

        // Final fit to guarantee PTY and terminal are in sync
        try { fit.fit() } catch { /* ignore */ }

        // Robust re-fit: on Windows (especially new Tauri windows), the container
        // may not have valid dimensions yet. Retry fit() with increasing delays.
        // If cols/rows change, resize the PTY to match.
        const ensure_fit = () => {
          if (disposed) return
          try {
            const el = container_el
            if (el && el.clientWidth > 0 && el.clientHeight > 0) {
              fit.fit()
              // Sync PTY if dimensions changed
              if (term.cols > 0 && term.rows > 0) {
                session.resize(term.cols, term.rows).catch(() => {})
              }
            }
          } catch { /* ignore */ }
        }
        setTimeout(ensure_fit, 100)
        setTimeout(ensure_fit, 300)
        setTimeout(ensure_fit, 800)

        // PTY output → terminal
        unlisten_data = session.onData((data) => {
          if (!disposed) term.write(data)
        })

        // PTY exit → status (all reconnection attempts exhausted)
        unlisten_exit = session.onExit(() => {
          if (!disposed) status = `exited`
        })

        // PTY disconnected → reconnecting (write notice to terminal)
        session.onDisconnect?.(() => {
          if (!disposed) {
            status = `reconnecting`
            term.write(`\r\n\x1b[33m[Connection lost, reconnecting...]\x1b[0m\r\n`)
          }
        })

        // PTY reconnected → connected (write notice to terminal)
        session.onReconnect?.(() => {
          if (!disposed) {
            status = `connected`
            term.write(`\r\n\x1b[32m[Reconnected]\x1b[0m\r\n`)
          }
        })

        // Focus the terminal
        term.focus()
      } catch (e: any) {
        if (!disposed) {
          status = `error`
          error_msg = e?.message || String(e)
        }
      }
    }

    init()

    return () => {
      disposed = true
      unregister_terminal(panel_id)
      _registered = false
      observer?.disconnect()
      vis_observer?.disconnect()
      unlisten_data?.()
      unlisten_exit?.()
      pty_ref = null
      term_ref = null
      fit_ref = null
      if (pty_session) {
        pty_session.kill().catch(() => {})
        pty_session.dispose()
      }
      terminal?.dispose()
    }
  })

  // Reactively update terminal theme when app theme changes
  $effect(() => {
    void theme_state.mode // track theme changes
    if (!term_ref) return
    const s = getComputedStyle(document.documentElement)
    const bg = s.getPropertyValue(`--page-bg`).trim() || `#080c14`
    const fg = s.getPropertyValue(`--text-color`).trim() || `#e0e0e0`
    const accent = s.getPropertyValue(`--accent-color`).trim() || `#3b82f6`
    term_ref.options.theme = {
      ...term_ref.options.theme,
      background: bg,
      foreground: fg,
      cursor: accent,
      cursorAccent: bg,
      black: bg,
    }
  })

  // Reactively update terminal font when settings change
  // Read directly from global terminal_font_state (bypasses prop chain for reliable reactivity)
  $effect(() => {
    const size = terminal_font_state.font_size
    const family = terminal_font_state.font_family
    if (!term_ref) return
    term_ref.options.fontSize = size
    term_ref.options.fontFamily = family
    // Re-fit after font change to recalculate column/row count
    requestAnimationFrame(() => {
      try { fit_ref?.fit() } catch { /* ignore */ }
    })
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="terminal-panel" onclick={() => { if (show_font_menu) show_font_menu = false }}>
  {#if show_header}
    <div class="terminal-panel-header">
      <span class="terminal-panel-title">
        {title}
        {#if status === `init`}
          <span class="terminal-status connecting">(connecting...)</span>
        {:else if status === `error`}
          <span class="terminal-status error">(error)</span>
        {:else if status === `reconnecting`}
          <span class="terminal-status connecting">(reconnecting...)</span>
        {:else if status === `exited`}
          <span class="terminal-status exited">(exited)</span>
        {/if}
      </span>
      <div class="terminal-panel-controls">
        <!-- Font settings dropdown -->
        <div class="tp-dropdown-wrap">
          <button
            class="terminal-font-btn"
            title="Font settings"
            onclick={(e) => { e.stopPropagation(); show_font_menu = !show_font_menu }}
          ><Icon icon="Settings" /></button>
          {#if show_font_menu}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="tp-font-dropdown" onclick={(e) => e.stopPropagation()}>
              <div class="tp-font-header">Font Settings</div>
              <div class="tp-font-control">
                <label class="tp-font-label">
                  <span>Size</span>
                  <div class="tp-font-size-row">
                    <input
                      type="range"
                      min="10"
                      max="24"
                      step="1"
                      value={terminal_font_state.font_size}
                      oninput={(e) => {
                        terminal_font_state.font_size = +(e.target as HTMLInputElement).value
                        save_terminal_font_state()
                      }}
                    />
                    <span class="tp-font-size-value">{terminal_font_state.font_size}px</span>
                  </div>
                </label>
              </div>
              <div class="tp-font-divider"></div>
              <div class="tp-font-control">
                <label class="tp-font-label">
                  <span>Font</span>
                  <select
                    value={terminal_font_state.font_family}
                    onchange={(e) => {
                      terminal_font_state.font_family = (e.target as HTMLSelectElement).value
                      save_terminal_font_state()
                    }}
                  >
                    {#each TERMINAL_FONT_FAMILIES as f}
                      <option value={f.value}>{f.label}</option>
                    {/each}
                  </select>
                </label>
              </div>
            </div>
          {/if}
        </div>
        {#if on_cwd_change || session_id}
          <button
            class="terminal-sync-btn"
            class:active={sync_cwd}
            title={sync_cwd ? `Directory sync ON — Files follows terminal CWD` : `Directory sync OFF — click to enable`}
            onclick={() => { sync_cwd = !sync_cwd }}
          >
            <Icon icon="Link" />
          </button>
        {/if}
        {#if onlayout_toggle}
          <button
            class="terminal-layout-btn"
            title="Toggle horizontal/vertical layout"
            onclick={onlayout_toggle}
          >
            {layout === `horizontal` ? `\u2194` : `\u2195`}
          </button>
        {/if}
        {#if onpopout}
          <button
            class="terminal-popout-btn"
            title="Open in new window"
            onclick={onpopout}
          >
            <Icon icon="Fullscreen" />
          </button>
        {/if}
        {#if onclose}
          <button
            class="terminal-minimize-btn"
            title="Minimize terminal"
            onclick={onclose}
          ><Icon icon="ArrowDown" /></button>
        {/if}
        {#if ondisconnect}
          <button
            class="terminal-disconnect-btn"
            title="Disconnect terminal"
            onclick={ondisconnect}
          ><Icon icon="Close" /></button>
        {/if}
      </div>
    </div>
  {/if}
  <div class="terminal-container" bind:this={container_el}>
    {#if error_msg}
      <div class="terminal-error">{error_msg}</div>
    {/if}
  </div>
</div>

<style>
  .terminal-panel {
    /* Fill the pane-tree leaf's .panel-content (position:relative; height:0;
       flex:1). Without absolute fill, this flex column collapses to the xterm's
       initial fitted height, leaving the rest of the pane blank. */
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .terminal-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    min-width: 0;
  }
  .terminal-panel-title {
    font-size: 0.8em;
    font-weight: 600;
    color: var(--text-color, #ccc);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .terminal-status {
    font-weight: 400;
    font-size: 0.9em;
  }
  .terminal-status.connecting { color: #ffd43b; }
  .terminal-status.error { color: #ff6b6b; }
  .terminal-status.exited { color: #868e96; }
  .terminal-panel-controls {
    display: flex;
    gap: 3px;
  }
  .terminal-panel-controls button {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--text-color, #aaa);
    border-radius: 3px;
    cursor: pointer;
    padding: 1px 6px;
    font-size: 0.8em;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 20px;
  }
  .terminal-panel-controls button:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }
  .terminal-sync-btn {
    opacity: 0.5;
  }
  .terminal-sync-btn.active {
    opacity: 1;
    background: rgba(59, 130, 246, 0.15);
    border-color: rgba(59, 130, 246, 0.3);
    color: var(--accent-color, #3b82f6);
  }
  .terminal-minimize-btn {
    color: #ffd43b !important;
    opacity: 0.7;
  }
  .terminal-minimize-btn:hover {
    color: #ffe066 !important;
    background: rgba(255, 212, 59, 0.15) !important;
    opacity: 1;
  }
  .terminal-disconnect-btn {
    color: #ff6b6b !important;
    opacity: 0.7;
  }
  .terminal-disconnect-btn:hover {
    color: #ff8787 !important;
    background: rgba(255, 107, 107, 0.15) !important;
    opacity: 1;
  }
  /* ====== Font settings dropdown ====== */
  .tp-dropdown-wrap {
    position: relative;
    display: flex;
  }
  .tp-font-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 100;
    min-width: 200px;
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    padding: 6px 0;
    margin-top: 2px;
  }
  .tp-font-header {
    padding: 4px 10px 3px;
    font-size: 0.68em;
    color: var(--text-color-muted, #94a3b8);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tp-font-control {
    padding: 4px 10px;
  }
  .tp-font-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75em;
    color: var(--text-color, #e0e0e0);
  }
  .tp-font-size-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tp-font-size-row input[type="range"] {
    flex: 1;
    height: 4px;
    accent-color: var(--accent-color, #3b82f6);
    cursor: pointer;
  }
  .tp-font-size-value {
    font-size: 0.9em;
    color: var(--text-color-muted, #94a3b8);
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tp-font-divider {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin: 4px 0;
  }
  .tp-font-control select {
    width: 100%;
    padding: 4px 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: var(--text-color, #e0e0e0);
    font-size: 0.9em;
    cursor: pointer;
    outline: none;
  }
  .tp-font-control select:focus {
    border-color: var(--accent-color, #3b82f6);
  }

  .terminal-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--page-bg);
  }
  /* Ensure xterm fills the container */
  .terminal-container :global(.xterm),
  .terminal-container :global(.xterm-viewport),
  .terminal-container :global(.xterm-screen) {
    height: 100%;
    width: 100%;
  }
  .terminal-error {
    color: #ff6b6b;
    padding: 12px;
    font-size: 0.85em;
  }
</style>
