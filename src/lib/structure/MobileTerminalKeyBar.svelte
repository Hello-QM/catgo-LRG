<!--
  MobileTerminalKeyBar.svelte — a horizontal, touch-sized key bar for the mobile
  SSH terminal.

  Soft keyboards on phones lack the keys a terminal needs (Esc, Tab, Ctrl,
  arrows, page nav, and a few shell punctuation chars). This standalone bar emits
  the raw escape sequences for them via `on_key(seq)`; the parent forwards `seq`
  to `transport.ptyWrite(...)`.

  STANDALONE: this component is intentionally NOT mounted anywhere yet — wiring it
  into the terminal view is a later, careful step. It owns no transport/session
  state; it is a pure input widget.

  Ctrl is STICKY: tap it to arm, then the next single printable key is folded to
  its control character (e.g. Ctrl then `c` -> 0x03). Arming auto-disarms after
  one key, or toggles off on a second tap. Esc/Tab/arrows/etc. consume the armed
  Ctrl too (they cancel it without emitting a control char of their own beyond
  their normal sequence) to keep behavior predictable.
-->
<script lang="ts">
  interface Props {
    /** Emitted with the raw byte sequence (as a string) for the pressed key. */
    on_key?: (seq: string) => void
  }

  let { on_key }: Props = $props()

  const ESC = `\x1b`

  // Sticky Ctrl modifier state.
  let ctrl_armed = $state(false)

  /** Map a printable key to its control char when Ctrl is armed. */
  function to_control(ch: string): string | null {
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

  function emit(seq: string): void {
    on_key?.(seq)
  }

  /** A normal (printable or fixed-sequence) key. Honors armed Ctrl for 1 char. */
  function press(seq: string): void {
    if (ctrl_armed) {
      ctrl_armed = false
      const ctl = seq.length === 1 ? to_control(seq) : null
      if (ctl !== null) {
        emit(ctl)
        return
      }
      // Non-control-mappable (e.g. Esc/arrow/Tab): just emit its own sequence.
    }
    emit(seq)
  }

  function toggle_ctrl(): void {
    ctrl_armed = !ctrl_armed
  }

  /** Static, fixed-sequence keys (label + the bytes they send). */
  interface KeyDef {
    label: string
    seq: string
  }

  const keys: KeyDef[] = [
    { label: `Esc`, seq: ESC },
    { label: `Tab`, seq: `\t` },
    { label: `↑`, seq: `${ESC}[A` },
    { label: `↓`, seq: `${ESC}[B` },
    { label: `→`, seq: `${ESC}[C` },
    { label: `←`, seq: `${ESC}[D` },
    { label: `Home`, seq: `${ESC}[H` },
    { label: `End`, seq: `${ESC}[F` },
    { label: `PgUp`, seq: `${ESC}[5~` },
    { label: `PgDn`, seq: `${ESC}[6~` },
    { label: `|`, seq: `|` },
    { label: `/`, seq: `/` },
    { label: `~`, seq: `~` },
    { label: `-`, seq: `-` },
  ]
</script>

<div class="keybar" role="toolbar" aria-label="Terminal keys">
  <button
    type="button"
    class="key ctrl"
    class:armed={ctrl_armed}
    aria-pressed={ctrl_armed}
    onclick={toggle_ctrl}
  >
    Ctrl
  </button>

  {#each keys as k (k.label)}
    <button type="button" class="key" onclick={() => press(k.seq)}>
      {k.label}
    </button>
  {/each}
</div>

<style>
  .keybar {
    display: flex;
    flex-direction: row;
    gap: 6px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding: 6px 8px;
    background: var(--keybar-bg, #1e1e1e);
    border-top: 1px solid var(--keybar-border, #333);
    /* Keep the bar above an iOS home indicator / nav bar. */
    padding-bottom: max(6px, env(safe-area-inset-bottom));
    scrollbar-width: none;
  }
  .keybar::-webkit-scrollbar {
    display: none;
  }

  .key {
    flex: 0 0 auto;
    min-width: 44px; /* Apple HIG touch target. */
    min-height: 40px;
    padding: 0 12px;
    font-size: 15px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--keybar-fg, #e0e0e0);
    background: var(--key-bg, #2d2d2d);
    border: 1px solid var(--key-border, #444);
    border-radius: 8px;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .key:active {
    background: var(--key-active-bg, #3d3d3d);
  }

  .key.ctrl.armed {
    color: #fff;
    background: var(--key-armed-bg, #0a84ff);
    border-color: var(--key-armed-bg, #0a84ff);
  }
</style>
