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
  import { transport } from '$lib/api/transport'
  import MobileTerminalKeyBar from '$lib/structure/MobileTerminalKeyBar.svelte'

  interface Props {
    /** Live HPC session id (from MobileConnect). */
    session_id: string
    /** Called with the shell's cwd whenever it changes (parsed from OSC 7), so
     * the Files tab can follow the terminal. */
    on_cwd?: (path: string) => void
  }

  let { session_id, on_cwd }: Props = $props()

  let container_el: HTMLDivElement | undefined = $state()
  let status = $state<`init` | `connected` | `error`>(`init`)
  let error_msg = $state(``)

  // Refs the keybar handler needs (set once the PTY is open).
  let channel_id: string | null = null
  let term_ref: { focus: () => void } | null = null
  // Lifted to component scope so refit() (called by the parent on tab-show) can
  // reach the fit addon, which is otherwise local to the $effect.
  let fit_ref: { fit: () => void } | null = null
  const encoder = new TextEncoder()

  /** Forward a raw byte string (from the key bar) to the PTY as stdin. */
  function send_keys(seq: string): void {
    if (!channel_id) return
    transport.ptyWrite(session_id, channel_id, encoder.encode(seq)).catch(() => {})
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

        // Stdin: xterm -> PTY.
        term.onData((data: string) => {
          if (!disposed && channel_id) {
            transport
              .ptyWrite(session_id, channel_id, encoder.encode(data))
              .catch(() => {})
          }
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
        // this whole (echoed) line is never painted. Leading space keeps it out of
        // bash history; the sentinel uses a real ESC so the echoed source (literal
        // backslashes) can't false-match it.
        const osc7_setup =
          ` _catgo_osc7(){ printf '\\033]7;file://%s%s\\a' "\${HOSTNAME:-\$HOST}" "\$PWD"; };` +
          ` if [ -n "\$ZSH_VERSION" ]; then typeset -ga precmd_functions; precmd_functions+=(_catgo_osc7);` +
          ` else PROMPT_COMMAND="_catgo_osc7\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi;` +
          ` _catgo_osc7; printf '\\033]99;catgo\\a'\n`
        transport.ptyWrite(session_id, ch, encoder.encode(osc7_setup)).catch(() => {})

        // Selection = copy: in a touch UI there's no right-click/Ctrl-C, so push
        // any non-empty selection straight to the clipboard.
        term.onSelectionChange(() => {
          const sel = term.getSelection()
          if (sel) navigator.clipboard?.writeText(sel).catch(() => {})
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
      const ch = opened_channel ?? channel_id
      if (ch) transport.ptyClose(sid, ch).catch(() => {})
      channel_id = null
      term_ref = null
      fit_ref = null
      terminal?.dispose()
    }
  })
</script>

<div class="mobile-terminal">
  <div class="mt-body" bind:this={container_el}>
    {#if status === `init`}
      <div class="mt-status">Opening shell…</div>
    {:else if status === `error`}
      <div class="mt-error">{error_msg}</div>
    {/if}
  </div>
  <MobileTerminalKeyBar on_key={send_keys} />
</div>

<style>
  .mobile-terminal {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
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
</style>
