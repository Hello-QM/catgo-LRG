<!--
  MobileTerminal.svelte — interactive SSH terminal for the mobile (tauri-ssh)
  transport.

  Given a live `session_id`, it mounts xterm.js (same @xterm/xterm + addon-fit
  setup the desktop terminal uses), opens a remote PTY via
  `transport.ptyOpen(session, cols, rows, onData)`, and wires:

    - PTY output bytes  -> term.write(...)
    - term.onData       -> transport.ptyWrite (stdin)
    - ResizeObserver/fit -> transport.ptyResize
    - onDestroy         -> transport.ptyClose

  It also mounts the existing {@link MobileTerminalKeyBar} and forwards its
  `on_key(seq)` to `transport.ptyWrite` (encoded to bytes), and focuses the
  hidden xterm textarea so the soft keyboard appears.

  NEW + standalone: this never touches the desktop terminal / pty.ts.
-->
<script lang="ts">
  import { to_control } from '$lib/mobile/control-chars'
  import { createInputDedup, reconcileReplacement } from '$lib/mobile/terminal-input-dedup'
  import { createImeGuard, isCJK } from '$lib/mobile/terminal-ime'
  import { isIOS, transport } from '$lib/api/transport'
  import Icon from '$lib/Icon.svelte'
  import MobileTerminalKeyBar from '$lib/structure/MobileTerminalKeyBar.svelte'
  import { screen_wake, set_keep_awake } from '$lib/mobile/screen-wake.svelte'

  interface Props {
    /** Live HPC session id (from MobileConnect). */
    session_id: string
    /** Called with the shell's cwd whenever it changes (parsed from OSC 7), so
     * the Files tab can follow the terminal. */
    on_cwd?: (path: string) => void
    /** When set, attach-or-create a tmux session of this name on shell start so
     * the remote session (and any running job) survives the SSH connection
     * dropping while iOS suspends the app on lock/background. Must be a
     * tmux-safe name (e.g. `catgo-1`). Omitted -> plain shell. */
    persist_key?: string
    /** Tapped from the "connection lost" overlay — asks the workspace to
     * reconnect this terminal's cluster (re-auth + re-attach tmux). */
    on_reconnect?: () => void
  }

  let { session_id, on_cwd, persist_key, on_reconnect }: Props = $props()

  let container_el: HTMLDivElement | undefined = $state()
  let status = $state<`init` | `connected` | `error`>(`init`)
  let error_msg = $state(``)
  // Set true when a write to the PTY fails mid-session (the SSH socket died —
  // typically an iOS suspend on lock/background). Drives the "connection lost"
  // overlay so the terminal doesn't just silently freeze. Reset on (re)connect.
  let conn_lost = $state(false)

  // Refs the keybar handler needs (set once the PTY is open).
  let channel_id: string | null = null
  let term_ref: { focus: () => void } | null = null
  // Lifted to component scope so refit() (called by the parent on tab-show) can
  // reach the fit addon, which is otherwise local to the $effect.
  let fit_ref: { fit: () => void } | null = null
  const encoder = new TextEncoder()

  /** Track PTY-write health: a failed stdin write means the channel died (iOS
   *  suspended the app) → raise the "connection lost" overlay; a later success
   *  clears it, so a transient blip doesn't pin the overlay until a reconnect. */
  function note_write(ok: boolean): void {
    if (!ok) conn_lost = true
    else if (conn_lost) conn_lost = false
  }

  /** Forward a raw byte string (from the key bar) to the PTY as stdin. */
  function send_keys(seq: string): void {
    if (!channel_id) return
    transport
      .ptyWrite(session_id, channel_id, encoder.encode(seq))
      .then(() => note_write(true), () => note_write(false))
    // Keep focus on the hidden textarea so the soft keyboard stays up.
    term_ref?.focus()
  }

  /** Re-fit the grid to the container. The parent calls this when a kept-warm
   *  tab becomes visible again: visibility:hidden does NOT fire ResizeObserver,
   *  so the fit has to be triggered explicitly on show. */
  export function refit(): void {
    requestAnimationFrame(() => {
      try {
        fit_ref?.fit()
      } catch {
        /* term may be disposing */
      }
    })
  }

  // iOS: the soft keyboard OVERLAYS the WKWebView (the layout viewport doesn't
  // shrink), so the bottom key bar (Esc/Tab/Ctrl/arrows) would hide behind it.
  // Track the keyboard height via visualViewport and pad the terminal up by that
  // much, so the key bar sits right above the keyboard and the grid re-fits to
  // the smaller area. Self-correcting cross-platform: where the webview already
  // resizes for the keyboard (Android native insets), innerHeight shrinks too,
  // so the computed inset is ~0 (no double-pad); on desktop there's no soft
  // keyboard so it stays 0.
  let kb_inset = $state(0)
  // Measured height of the key bar, so we can reserve exactly that much space
  // above the keyboard when the bar floats (see template / styles).
  let keybar_h = $state(48)
  // User toggle: collapse the floating bar to a small pill so the terminal is
  // visible (e.g. in split mode where the pane is short). Re-tap to expand.
  let keybar_open = $state(true)
  // Sticky-Ctrl from the key bar; folds the next soft-keyboard char in onData.
  let kb_ctrl_armed = $state(false)
  $effect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let last = -1
    let refit_timer: ReturnType<typeof setTimeout> | null = null
    const update = () => {
      const next = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      if (next === last) return
      last = next
      kb_inset = next // padding glides via the CSS transition (see styles)
      // Re-fit the grid ONCE after the keyboard settles — running it on every
      // animation frame is what makes the bar look jumpy.
      if (refit_timer) clearTimeout(refit_timer)
      refit_timer = setTimeout(() => refit(), 140)
    }
    update()
    vv.addEventListener(`resize`, update)
    vv.addEventListener(`scroll`, update)
    return () => {
      if (refit_timer) clearTimeout(refit_timer)
      vv.removeEventListener(`resize`, update)
      vv.removeEventListener(`scroll`, update)
    }
  })

  /** Focus the hidden xterm textarea (raises the soft keyboard). The parent
   *  calls this from a tab tap handler — a trusted gesture, which WKWebView
   *  requires for programmatic focus. */
  export function focus(): void {
    term_ref?.focus()
  }

  $effect(() => {
    if (!container_el) return

    // Snapshot the session this PTY belongs to, so the cleanup closes the right
    // channel even if the prop has already flipped to a new/null session by
    // teardown time (e.g. on disconnect, which nulls session_id then unmounts).
    const sid = session_id

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let terminal: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fit_addon: any = null
    let observer: ResizeObserver | null = null
    let touch_ac: AbortController | null = null
    let ime_ac: AbortController | null = null
    let disposed = false
    let opened_channel: string | null = null

    async function init(): Promise<void> {
      try {
        const [xtermMod, fitMod] = await Promise.all([
          import(`@xterm/xterm`),
          import(`@xterm/addon-fit`),
        ])
        if (disposed) return
        await import(`@xterm/xterm/css/xterm.css`)

        const term_bg = `#0e1117`
        const term_fg = `#e0e0e0`
        const term = new xtermMod.Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: `ui-monospace, SFMono-Regular, Menlo, monospace`,
          theme: {
            background: term_bg,
            foreground: term_fg,
            cursor: `#3b82f6`,
            cursorAccent: term_bg,
            selectionBackground: `rgba(59, 130, 246, 0.3)`,
          },
          allowProposedApi: true,
        })

        const fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.open(container_el!)

        // Lay out before the first fit so column count is correct.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            if (!disposed) {
              try {
                fit.fit()
              } catch {
                /* ignore */
              }
            }
            resolve()
          }),
        )
        if (disposed) {
          term.dispose()
          return
        }

        terminal = term
        fit_addon = fit
        fit_ref = fit
        term_ref = term

        const cols = term.cols > 0 ? term.cols : 80
        const rows = term.rows > 0 ? term.rows : 24

        // Hide the OSC 7 setup injection (sent below): a PTY unavoidably echoes
        // the command we "type", so rather than let it paint and then clear it,
        // we DON'T paint the terminal until the setup finishes — signalled by a
        // private OSC 99 sentinel the setup prints. During this window we still
        // scan the raw stream for the initial cwd (OSC 7). Falls open after 1.5s
        // if the sentinel never arrives, so the screen can't get stuck blank.
        const decoder = new TextDecoder()
        let gate_open = false
        let setup_scan = ``
        const open_gate = (flush = false) => {
          if (gate_open || disposed) return
          gate_open = true
          clearTimeout(gate_timer)
          const buffered = setup_scan
          setup_scan = ``
          try {
            term.reset()
            // Sentinel path discards the (hidden) setup echo; the timeout fallback
            // flushes the buffer so a shell that never emits the sentinel (e.g. fish,
            // or a startup error) still shows its output instead of losing it.
            if (flush && buffered) term.write(buffered)
          } catch { /* term may be disposing */ }
        }
        const gate_timer = setTimeout(() => open_gate(true), 1500)

        // Open the remote PTY; stream bytes into xterm once the gate is open.
        const ch = await transport.ptyOpen(session_id, cols, rows, (bytes) => {
          if (disposed) return
          if (gate_open) {
            // Decode through the SAME decoder used during the gate window, so a
            // partial UTF-8 sequence buffered across the gate boundary completes
            // instead of being dropped/corrupted.
            term.write(decoder.decode(bytes, { stream: true }))
            return
          }
          // Setup window: scan (don't render) for the cwd + completion sentinel.
          setup_scan += decoder.decode(bytes, { stream: true })
          const cwd = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/.exec(setup_scan)
          if (cwd) {
            try {
              on_cwd?.(decodeURIComponent(cwd[1]))
            } catch {
              on_cwd?.(cwd[1])
            }
          }
          const sentinel = `\x1b]99;catgo`
          const at = setup_scan.indexOf(sentinel)
          if (at !== -1) {
            // Anything after the sentinel is real session output — render it.
            const rest = setup_scan.slice(at + sentinel.length).replace(/^\x07/, ``)
            open_gate()
            if (rest) term.write(rest)
          }
        })
        if (disposed) {
          transport.ptyClose(session_id, ch).catch(() => {})
          term.dispose()
          return
        }
        channel_id = ch
        opened_channel = ch
        status = `connected`
        conn_lost = false // fresh channel — clear any prior "lost" overlay

        // ─── iOS WKWebView input fixes (two distinct bugs, one set of listeners) ─
        // 1. Latin de-dup: xterm 6.0.0 can emit ONE genuine soft-keyboard
        //    insertion to onData twice (typing "hello" lands as "hhelllo"). WebKit
        //    fires `beforeinput` exactly once per insertion, so we note it and drop
        //    the duplicate onData. See terminal-input-dedup.ts.
        // 2. CJK IME: WKWebView routes Chinese/Korean composition through
        //    non-standard beforeinput inputTypes that xterm mishandles. The guard
        //    buffers the composed text and writes it itself, suppressing xterm's
        //    own emission during composition. See terminal-ime.ts.
        // Order in onData below is load-bearing: IME suppression → dedup → Ctrl
        // fold, so composition residue and duplicates are dropped before they can
        // be mistaken for a real keystroke or fold the sticky Ctrl.
        const ime_log = (...a: unknown[]) => {
          if ((window as { __CATGO_IME_DEBUG?: boolean }).__CATGO_IME_DEBUG) {
            console.log(`[mobile-term]`, ...a)
          }
        }
        const dedup = createInputDedup()
        // Set by a dictation-replacement beforeinput (see below): drop the single
        // xterm onData echo that follows, since we already reconciled the PTY.
        let dict_drop_echo = false
        // The guard writes committed CJK text straight to the PTY (xterm's own
        // emission is suppressed). A composition commit also ends any armed
        // sticky-Ctrl — folding a multi-char CJK string to a control char is
        // meaningless, so just clear it rather than leave it stuck.
        const ime = createImeGuard({
          write: (text) => {
            if (!channel_id) return
            kb_ctrl_armed = false
            transport.ptyWrite(session_id, channel_id, encoder.encode(text))
              .then(() => note_write(true), () => note_write(false))
          },
          // iOS dictation streams Chinese as replacing insertText events (same
          // shape as Latin dictation) — those must reach the reconcile path
          // below, not be written-on-arrival (that path is for Android IME
          // commits, which are final). See terminal-ime.ts.
          bypass_cjk_insert_text: isIOS(),
        })
        ime_ac = new AbortController()
        const xt = term.textarea
        if (xt) {
          const sig = { signal: ime_ac.signal }
          xt.addEventListener(`beforeinput`, (e) => {
            const ie = e as InputEvent
            ime_log(
              `beforeinput`,
              ie.inputType,
              JSON.stringify(ie.data),
              `sel=${xt.selectionStart}..${xt.selectionEnd}`,
            )
            // A fresh event clears any stale drop flag (see onData below).
            dict_drop_echo = false
            // CJK composition events are consumed by the guard (we write the text
            // ourselves); block xterm from also processing them.
            if (ime.on_before_input(ie.inputType, ie.data)) {
              ie.preventDefault()
              return
            }
            // iOS dictation: an insertText over a NON-collapsed selection is a
            // REPLACEMENT of the previous partial (e.g. "hel" -> "hello"), not an
            // append. xterm would emit the whole word again ("helhello"); instead
            // reconcile the PTY to the textarea — keep the common prefix, backspace
            // the diverged tail, send the rest — and drop xterm's echo. Normal
            // typing always has a collapsed caret, so it skips this and stays on
            // the dedup path. We do NOT preventDefault: the textarea must keep the
            // running value so the next dictation event diffs against it.
            // CJK dictation partials take this path even with a collapsed caret
            // (the FIRST partial is a plain insert): the reconcile degenerates to
            // an append, and the textarea keeps the running transcript so the
            // next refinement diffs correctly. (Only reachable on iOS — on
            // Android the guard consumes CJK insertText above.)
            const ss = xt.selectionStart
            const se = xt.selectionEnd
            if (
              ie.inputType === `insertText` && ie.data != null &&
              ss != null && se != null && (ss !== se || isCJK(ie.data))
            ) {
              const { backspaces, send } = reconcileReplacement(xt.value, ss, se, ie.data)
              const out = `\x7f`.repeat(backspaces) + send
              ime_log(`dictation reconcile`, `bs=${backspaces}`, JSON.stringify(send))
              if (out && channel_id) {
                transport.ptyWrite(session_id, channel_id, encoder.encode(out))
                  .then(() => note_write(true), () => note_write(false))
              }
              dict_drop_echo = true // xterm will still echo `data`; drop it in onData
              return
            }
            // Ordinary input — feed it to the Latin dedup as ground truth.
            dedup.note_before_input(ie.data)
          }, sig)
          xt.addEventListener(`compositionstart`, () => {
            ime_log(`compositionstart`)
            ime.on_composition_start()
          }, sig)
          xt.addEventListener(`compositionend`, (e) => {
            const ce = e as CompositionEvent
            ime_log(`compositionend`, JSON.stringify(ce.data))
            ime.on_composition_end(ce.data)
            // Clear the textarea synchronously so xterm's deferred
            // _finalizeComposition can't re-read the composed text and re-send it.
            // The clear makes xterm emit synthetic DELs (length decrease) — arm
            // the guard's debt so exactly those are eaten, not real backspaces.
            if (xt.value) {
              ime.note_textarea_clear(xt.value.length)
              xt.value = ``
            }
          }, sig)
          xt.addEventListener(`keydown`, (e) => {
            ime.on_keydown((e as KeyboardEvent).keyCode)
          }, sig)
        }

        // Stdin: xterm -> PTY. When the key bar's sticky Ctrl is armed, fold
        // the next single soft-keyboard character into its control char
        // (Ctrl then `c` -> 0x03 = SIGINT) — letters only exist on the soft
        // keyboard, so the bar can't produce Ctrl+C by itself.
        term.onData((data: string) => {
          if (disposed || !channel_id) return
          // Drop xterm's echo of a dictation replacement we already reconciled
          // from beforeinput (consume the flag so a later control key is unaffected).
          if (dict_drop_echo) {
            dict_drop_echo = false
            ime_log(`drop dict echo`, JSON.stringify(data))
            return
          }
          // Suppress during CJK composition (the guard writes the commit itself)
          // and briefly after it (confirmation-key residue).
          if (ime.should_suppress(data)) {
            ime_log(`suppress`, JSON.stringify(data))
            return
          }
          // Drop xterm's duplicate Latin emission — before the Ctrl fold so it
          // can't be mistaken for a second keystroke.
          if (!dedup.accept(data)) {
            ime_log(`drop dup`, JSON.stringify(data))
            return
          }
          let out = data
          if (kb_ctrl_armed) {
            // Disarm on ANY input: a predictive-keyboard burst (length > 1)
            // must not leave Ctrl stuck armed for a later keystroke.
            kb_ctrl_armed = false
            const ctl = data.length === 1 ? to_control(data) : null
            if (ctl !== null) out = ctl
          }
          transport
            .ptyWrite(session_id, channel_id, encoder.encode(out))
            .then(() => note_write(true), () => note_write(false))
        })

        // Resize: keep the remote PTY in sync with xterm's grid.
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (!disposed && channel_id) {
            transport.ptyResize(session_id, channel_id, cols, rows).catch(() => {})
          }
        })

        // Container size changes -> re-fit (fit() triggers onResize above).
        observer = new ResizeObserver(() => {
          requestAnimationFrame(() => {
            if (!disposed && fit_addon) {
              try {
                fit_addon.fit()
              } catch {
                /* ignore */
              }
            }
          })
        })
        observer.observe(container_el!)

        // Touch scrollback: in the WebView the xterm canvas swallows pointer
        // events, so dragging never scrolls the viewport. Translate vertical
        // touch-drag into xterm scroll-by-lines ourselves. Drag DOWN -> scroll
        // back into history; drag UP -> toward the prompt.
        touch_ac = new AbortController()
        let touch_y = 0
        container_el!.addEventListener(
          `touchstart`,
          (e: TouchEvent) => {
            if (e.touches.length === 1) touch_y = e.touches[0].clientY
          },
          { passive: true, signal: touch_ac.signal },
        )
        container_el!.addEventListener(
          `touchmove`,
          (e: TouchEvent) => {
            if (e.touches.length !== 1 || disposed) return
            const y = e.touches[0].clientY
            const row_h = container_el!.clientHeight / Math.max(term.rows, 1)
            const lines = Math.trunc((touch_y - y) / Math.max(row_h, 1))
            if (lines !== 0) {
              term.scrollLines(lines)
              touch_y = y
            }
          },
          { passive: true, signal: touch_ac.signal },
        )

        // cwd tracking via OSC 7: parse `ESC ] 7 ; file://host/path BEL` that the
        // shell emits each prompt, and bubble the path up so the Files tab can
        // follow. registerOscHandler returns a disposable tracked by term.dispose.
        term.parser.registerOscHandler(7, (data: string) => {
          const m = /^file:\/\/[^/]*(\/.*)$/.exec(data)
          if (m) {
            try {
              on_cwd?.(decodeURIComponent(m[1]))
            } catch {
              on_cwd?.(m[1])
            }
          }
          return true
        })
        // Ask the shell to emit OSC 7 on every prompt so the Files tab can follow
        // the cwd. Register per shell — zsh uses precmd_functions (it ignores
        // bash's PROMPT_COMMAND), bash uses PROMPT_COMMAND. Emit the cwd once, then
        // print the private OSC 99 sentinel that opens the render gate above — so
        // this whole (echoed) line is never painted. The sentinel uses a real ESC
        // so the echoed source (literal backslashes) can't false-match it.
        const osc7_body =
          `_catgo_osc7(){ printf '\\033]7;file://%s%s\\a' "\${HOSTNAME:-\$HOST}" "\$PWD"; };` +
          ` if [ -n "\$ZSH_VERSION" ]; then typeset -ga precmd_functions; precmd_functions+=(_catgo_osc7);` +
          ` else PROMPT_COMMAND="_catgo_osc7\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi;` +
          ` _catgo_osc7; printf '\\033]99;catgo\\a';`

        // When a persist key is set: attach-or-create a tmux session so the remote
        // shell + any running job survive the SSH connection dropping (iOS freezes
        // the app — and its sockets — within ~30s of lock/background). `exec`
        // replaces the login shell, so leaving tmux ends the channel cleanly. On
        // RE-ATTACH we deliberately send nothing more — injecting the osc7 setup
        // into a shell that may have a job running would type into that job. So
        // cwd-follow + the render gate apply only to the no-tmux else branch (the
        // Files tab won't follow cwd inside tmux — acceptable for persistence). If
        // tmux is absent the `if` falls through to the plain-shell setup. Leading
        // space keeps the whole line out of (bash) history.
        // Print the OSC 99 render-gate sentinel BEFORE exec'ing tmux/screen so the
        // gate closes instantly (discarding the echoed setup line) instead of
        // waiting out its 1.5s fallback and then reset()-flushing on top of tmux's
        // own attach redraw — that double-clear is the "flashes twice" on reconnect.
        const sentinel = `printf '\\033]99;catgo\\a';`
        const setup = persist_key
          ? ` if command -v tmux >/dev/null 2>&1; then ${sentinel} exec tmux new-session -A -s ${persist_key};` +
            ` elif command -v screen >/dev/null 2>&1; then ${sentinel} exec screen -DR ${persist_key};` +
            ` else ${osc7_body} fi\n`
          : ` ${osc7_body}\n`
        transport.ptyWrite(session_id, ch, encoder.encode(setup)).catch(() => {})

        // Selection = copy: in a touch UI there's no right-click/Ctrl-C, so push
        // any non-empty selection straight to the clipboard. navigator.clipboard
        // silently rejects in the Android/iOS WebView (a selection change is not
        // a user gesture there) — use the native Tauri clipboard when available.
        term.onSelectionChange(() => {
          const sel = term.getSelection()
          if (!sel) return
          void (async () => {
            try {
              const { check_tauri } = await import(`$lib/io/tauri`)
              if (check_tauri()) {
                const { writeText } = await import(`@tauri-apps/plugin-clipboard-manager`)
                await writeText(sel)
                return
              }
            } catch {
              /* fall through to the web clipboard */
            }
            navigator.clipboard?.writeText(sel).catch(() => {})
          })()
        })

        // Focus the hidden textarea so the soft keyboard appears.
        term.focus()
      } catch (e: unknown) {
        if (!disposed) {
          status = `error`
          error_msg = e instanceof Error ? e.message : String(e)
        }
      }
    }

    init()

    return () => {
      disposed = true
      observer?.disconnect()
      touch_ac?.abort()
      ime_ac?.abort()
      const ch = opened_channel ?? channel_id
      if (ch) transport.ptyClose(sid, ch).catch(() => {})
      channel_id = null
      term_ref = null
      fit_ref = null
      terminal?.dispose()
    }
  })
</script>

<div
  class="mobile-terminal"
  style="padding-bottom: {kb_inset > 0 ? kb_inset + keybar_h : 0}px"
>
  <div class="mt-body" bind:this={container_el}>
    {#if status === `init`}
      <div class="mt-status">Opening shell…</div>
    {:else if status === `error`}
      <div class="mt-error">{error_msg}</div>
    {/if}
    {#if conn_lost}
      <!-- Mid-session drop (iOS suspended the app on lock/background and killed
           the socket). Show it instead of letting xterm silently freeze. The
           remote tmux session usually survives, so Reconnect re-attaches it. -->
      <div class="mt-lost" role="alert">
        <div class="mt-lost-title">Connection lost</div>
        <div class="mt-lost-sub">
          The phone locking or backgrounding dropped the SSH connection. Your
          remote session is likely still running — reconnect to re-attach it.
        </div>
        <button type="button" class="mt-lost-btn" onclick={() => on_reconnect?.()}>
          Reconnect
        </button>
      </div>
    {/if}
  </div>
  <!-- When the keyboard is up, the bar floats fixed just above it (so it's
       reachable even in split mode where the pane is too short to hold it in
       flow). When the keyboard is down it sits in normal flow at the bottom.
       The toggle collapses it to a small pill so the terminal stays visible. -->
  <div
    class="mt-keybar"
    class:floating={kb_inset > 0}
    class:closed={!keybar_open}
    style:bottom="{kb_inset}px"
    bind:clientHeight={keybar_h}
  >
    {#if keybar_open}
      <MobileTerminalKeyBar on_key={send_keys} bind:ctrl_armed={kb_ctrl_armed} />
      <!-- Keep-screen-awake toggle (default on): while on, the screen won't
           auto-lock in the terminal, so an auto-lock can't drop the connection.
           Sun = awake, Moon = auto-lock allowed. -->
      <button
        type="button"
        class="mt-keybar-toggle"
        class:awake-off={!screen_wake.enabled}
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => {
          set_keep_awake(!screen_wake.enabled)
          term_ref?.focus()
        }}
        aria-label={screen_wake.enabled ? `Screen stays awake — tap to allow auto-lock` : `Auto-lock allowed — tap to keep screen awake`}
        title={screen_wake.enabled ? `Keep awake: on` : `Keep awake: off`}
      ><Icon icon={screen_wake.enabled ? `Sun` : `Moon`} /></button>
    {/if}
    <button
      type="button"
      class="mt-keybar-toggle"
      onpointerdown={(e) => e.preventDefault()}
      onclick={() => {
        keybar_open = !keybar_open
        // Keep the soft keyboard up: tapping a button blurs the hidden xterm
        // textarea (which dismisses the keyboard), so refocus it like the keys do.
        term_ref?.focus()
      }}
      aria-label={keybar_open ? `Hide terminal keys` : `Show terminal keys`}
      title={keybar_open ? `Hide keys` : `Show keys`}
    ><Icon icon={keybar_open ? `Collapse` : `Expand`} /></button>
  </div>
</div>

<style>
  .mobile-terminal {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    /* border-box so the dynamic padding-bottom (soft-keyboard inset) shrinks the
       content within height:100% rather than overflowing it. */
    box-sizing: border-box;
    /* Glide the key bar with the keyboard instead of stepping through the few
       discrete heights visualViewport reports during the open/close animation. */
    transition: padding-bottom 0.18s ease-out;
    background: var(--page-bg, #0e1117);
  }
  .mt-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
    /* Horizontal breathing room so the first/last column isn't clipped at the
       screen edge. FitAddon measures this padded content box, so column count
       stays correct. */
    padding: 2px 8px;
  }
  .mt-body :global(.xterm),
  .mt-body :global(.xterm-viewport),
  .mt-body :global(.xterm-screen) {
    height: 100%;
    width: 100%;
  }
  .mt-keybar {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
    /* Match the key strip so there's no black gap behind the toggle. */
    background: var(--keybar-bg, #1e1e1e);
  }
  .mt-keybar :global(.keybar) {
    flex: 1;
    min-width: 0;
  }
  /* Keyboard up: float the key bar fixed just above it (left/right:0, bottom set
     inline to the keyboard inset) so it's reachable regardless of how short the
     terminal pane is in split mode. No transformed ancestors, so fixed tracks
     the viewport. The transition glides it with the keyboard. */
  .mt-keybar.floating {
    position: fixed;
    left: 0;
    right: 0;
    z-index: 50;
    transition: bottom 0.18s ease-out;
  }
  /* Collapsed while floating: shrink to just the toggle pill, pinned to the
     right, so the terminal underneath stays visible. */
  .mt-keybar.floating.closed {
    left: auto;
    background: var(--keybar-bg, #1e1e1e);
    border-top: 1px solid var(--keybar-border, #333);
    border-left: 1px solid var(--keybar-border, #333);
    border-top-left-radius: 10px;
  }
  .mt-keybar-toggle {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 52px;
    align-self: stretch; /* fill the full strip height — no margin gaps */
    font-size: 14px;
    /* Same surface as the strip so it can't contrast as a "box"; the blue icon
       and a thin left divider are what mark it as the toggle control. */
    color: #0a84ff;
    background: var(--keybar-bg, #1e1e1e);
    border: none;
    border-left: 1px solid var(--keybar-border, #333);
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  /* Keep-awake toggle in the OFF state: muted so the blue "on" reads as active. */
  .mt-keybar-toggle.awake-off {
    color: var(--text-color-muted, #94a3b8);
  }
  .mt-keybar-toggle:active {
    background: var(--key-bg, #2d2d2d);
  }
  .mt-status {
    padding: 12px;
    font-size: 0.85em;
    color: var(--text-color-muted, #94a3b8);
  }
  .mt-error {
    padding: 12px;
    font-size: 0.85em;
    color: #ff6b6b;
  }
  /* "Connection lost" overlay — covers the frozen xterm so the drop is obvious
     and offers a one-tap reconnect (re-attaches the surviving tmux session). */
  .mt-lost {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    background: rgba(14, 17, 23, 0.92);
    backdrop-filter: blur(2px);
  }
  .mt-lost-title {
    font-size: 1.05em;
    font-weight: 600;
    color: #ff6b6b;
  }
  .mt-lost-sub {
    font-size: 0.85em;
    line-height: 1.4;
    color: var(--text-color-muted, #94a3b8);
    max-width: 320px;
  }
  .mt-lost-btn {
    margin-top: 4px;
    min-height: 44px;
    padding: 0 24px;
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    background: #3b82f6;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .mt-lost-btn:active {
    background: #2563eb;
  }
</style>
