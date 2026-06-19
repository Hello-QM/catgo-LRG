<!--
  MobileChat.svelte — full-screen AI chat overlay for the mobile workspace.

  Mirrors the .mw-files-overlay pattern. Reuses the existing chat lifecycle
  (get_chat_slice / send_message / cancel_generation) under tab id 'mobile', so
  history, the loading indicator, abort, and the pending-send queue all come for
  free (§4). Tool calling: chat-state runs the full CLIENT_TOOLS client-direct
  loop on mobile; this overlay renders the tool status rows and the
  permission card (active_tool_blocks / active_permission_blocks) so mutating
  calls are gated rather than wedging the chat.

  Key handling (§5/§8): the API key is loaded from the native encrypted store
  into a LOCAL $state and pushed into chat_config in-memory via
  set_session_api_key right before each send. It is NEVER written through
  update_config (which would persist it to localStorage). If no key is stored
  for the current provider, the setup card is shown instead of the chat.

  Markdown: a deliberately LIGHTWEIGHT inline renderer (no katex / highlight.js —
  markdown.ts pulls ~250 KB at module load, §6). Renders paragraphs + line
  breaks + **bold** + `inline code`, HTML-escaped. TODO: lazy-load the full
  renderer only when a fenced code block is detected.
-->
<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import Icon from '$lib/Icon.svelte'
  import { get_display_text, SDK_PROVIDERS } from '$lib/chat/types'
  import {
    cancel_generation,
    chat_config,
    get_chat_slice,
    send_message,
    set_session_api_key,
    update_config,
  } from '$lib/chat/chat-state.svelte'
  import type { PermissionEntry } from '$lib/chat/chat-state.svelte'
  import { loadApiKey, mobile_chat_providers, redact } from './ai-keys'
  import MobileChatSetup from './MobileChatSetup.svelte'
  import { build_structure_context } from '$lib/chat/context'
  import type { AnyStructure } from '$lib'
  import {
    add_chat_tab,
    chat_tab_label,
    chat_tabs,
    close_chat_tab,
    ensure_chat_seed,
    MAX_CHAT_TABS,
    set_chat_title,
    switch_chat_tab,
  } from './chat-tabs.svelte'
  import { t } from '$lib/i18n/index.svelte'
  import { isMobile } from '$lib/api/transport'
  import {
    load_voice_locale,
    locale_label,
    locale_short,
    on_transcript,
    request_speech_permission,
    save_voice_locale,
    start_listening,
    stop_listening,
    supported_locales,
  } from './ios-speech'

  interface Props {
    /** Dismiss the overlay back to the workspace. */
    on_close: () => void
    /** The structure currently open in the workspace, so CatBot can answer
     *  about it. The typed mobile chat has no other context source — the
     *  desktop ChatPane / voice paths don't run here. */
    structure?: AnyStructure
  }

  let { on_close, structure }: Props = $props()

  // Seed the first tab once, then drive the visible chat off the active tab id
  // (which IS the chat-state slice id). Multiple chats, each its own slice.
  ensure_chat_seed()
  const active_id = $derived(chat_tabs.active_id ?? `mobile`)
  const slice = $derived(get_chat_slice(active_id))

  // Long-press a tab → close action sheet (mirrors the terminal tab bar).
  let sheet_tab = $state<string | null>(null)
  let lp_timer: ReturnType<typeof setTimeout> | null = null
  let lp_fired = false
  $effect(() => () => {
    if (lp_timer) clearTimeout(lp_timer)
  })
  function tab_pointerdown(id: string): void {
    if (lp_timer) clearTimeout(lp_timer)
    lp_fired = false
    lp_timer = setTimeout(() => {
      lp_fired = true
      sheet_tab = id
    }, 500)
  }
  function tab_pointerup(): void {
    if (lp_timer) clearTimeout(lp_timer)
    lp_timer = null
  }
  function tab_click(id: string): void {
    if (lp_fired) {
      lp_fired = false // long-press already opened the sheet; swallow the click
      return
    }
    setup_open = false // selecting a tab leaves settings → show that chat
    switch_chat_tab(id)
  }
  function sheet_close(): void {
    if (sheet_tab) {
      close_chat_tab(sheet_tab)
      sheet_tab = null
    }
  }

  // A provider persisted from a DESKTOP session may be an SDK agent (sdk-claude/
  // codex/gemini). Those need the backend agent sidecar, which doesn't exist on
  // mobile — selecting one would hang the chat on send (it tries to reach an
  // absent 127.0.0.1 agent port). Reset to the first mobile-eligible provider so
  // the setup card prompts for a real key-direct one. Runs once at mount.
  if (SDK_PROVIDERS.has(chat_config.provider)) {
    update_config({ provider: mobile_chat_providers()[0] ?? `gemini` })
  }

  // The current provider, read reactively off the persisted (non-secret) config.
  const provider = $derived(chat_config.provider)

  // The API key for the current provider, held in memory ONLY (never persisted).
  let local_key = $state(``)
  // Whether we've finished the initial key lookup (so we don't flash the setup
  // card before loadApiKey resolves).
  let key_checked = $state(false)
  // Force the setup card open (gear button / "fix your key" shortcut).
  let setup_open = $state(false)

  let input = $state(``)

  // Tool rows the user has tapped open (entries are replaced wholesale at the
  // start of each client-direct run, so no per-send cleanup is needed).
  const expanded_tools = new SvelteSet<string>()
  function toggle_tool(id: string): void {
    if (expanded_tools.has(id)) expanded_tools.delete(id)
    else expanded_tools.add(id)
  }

  // "Don't ask again this session" checkbox state for the permission card.
  let skip_session = $state(false)

  // The checkbox is per-card UI state; the effective bypass lives per-slice in
  // slice.skip_permission. Reset the checkbox when switching chat tabs.
  $effect(() => {
    void active_id
    skip_session = false
  })

  // Cap the permission-card input preview (structure params can be huge).
  function truncate_input(input: Record<string, unknown>): string {
    const text = JSON.stringify(input, null, 1)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }

  // Short local time (e.g. 4:07 PM) for a message bubble. Bad/zero timestamps
  // (older messages stored before timestamps existed) render nothing.
  function format_time(ts: number): string {
    if (!ts) return ``
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: `numeric`,
        minute: `2-digit`,
      })
    } catch {
      return ``
    }
  }

  function decide_permission(entry: PermissionEntry, ok: boolean): void {
    entry.status = ok ? `approved` : `denied`
    if (ok && skip_session) slice.skip_permission.value = true
    entry.resolve?.(ok)
  }

  // Load the stored key for the current provider whenever it changes. Async-race
  // guard (§5): capture the provider; only apply if it's still selected on
  // resolve. The key goes into local $state AND chat_config (in-memory) so the
  // next send can read it.
  $effect(() => {
    const p = provider
    key_checked = false
    local_key = ``
    loadApiKey(p)
      .then((k) => {
        if (p !== chat_config.provider) return // provider changed mid-flight
        if (k) {
          local_key = k
          set_session_api_key(k)
        }
        key_checked = true
      })
      .catch(() => {
        if (p === chat_config.provider) key_checked = true
      })
  })

  // Scroll container bound in the template — used for auto-scroll below.
  let body_el = $state<HTMLElement | null>(null)

  // Auto-scroll to bottom on new content (messages, tool rows, permission
  // cards) — a pending permission card below the fold would otherwise look
  // like a hang while the tool loop blocks awaiting the decision.
  $effect(() => {
    // Touch the reactive sources so the effect re-runs on any of them.
    void slice.messages.list.length
    void get_display_text(
      slice.messages.list[slice.messages.list.length - 1]?.content ?? ``,
    ).length
    void Object.values(slice.active_tool_blocks.entries)
      .map((tb) => tb.status)
      .join()
    void Object.keys(slice.active_permission_blocks.entries).length
    const el = body_el
    if (!el) return
    tick().then(() => el.scrollTo({ top: el.scrollHeight }))
  })

  // Deliberately NO cancel on unmount OR minimize. The ✕ is "minimize" (hide),
  // not "stop": streams live in the module-level slice (chat-state) and are
  // per-tab background-capable, so they must SURVIVE both a minimize and the
  // transient destroy+recreate that MobileWorkspace's `{#if ai_open}` wrapper
  // does on a parent re-render — the user sees the finished result on reopen.
  // Cancelling from either path aborted a healthy in-flight generation
  // mid-stream ("Request canceled" — traced via WHO=close_chat / effect
  // teardown). The only deliberate cancels are the Stop button (below) and
  // closing the whole tab (remove_chat_slice).

  const has_key = $derived(local_key.trim().length > 0)
  // Ollama is keyless — it authenticates by reachability, not an API key. It's
  // "configured" once a base URL is set. Without treating it as such, the
  // !configured clause below would pin the setup card open forever (no key can
  // ever exist for Ollama), so Save never reveals the chat and every relaunch
  // re-prompts setup even though the provider/base_url ARE persisted.
  const key_optional = $derived(provider === `ollama`)
  const configured = $derived(
    has_key || (key_optional && chat_config.base_url.trim().length > 0),
  )
  // Force the setup card for a first-run, unconfigured chat (onboarding). But do
  // NOT pin it once the chat has history — otherwise a returning user on an
  // unconfigured provider is TRAPPED in settings (the gear toggle can't escape,
  // since !configured keeps this true). With history, the gear controls setup and
  // a failed send's error already points them at the key.
  const show_setup = $derived(
    setup_open || (key_checked && !configured && slice.messages.list.length === 0),
  )

  // 401 / invalid-key detection on the slice error so we can offer a shortcut
  // back to setup without echoing the raw provider body (which might reflect the
  // key — redact before display, §8 M).
  const error_text = $derived(slice.error.value ? redact(slice.error.value) : ``)
  const is_key_error = $derived(
    /401|invalid[_\s-]?api[_\s-]?key|unauthor/i.test(slice.error.value),
  )
  // Rate-limit / quota (429 / RESOURCE_EXHAUSTED) — common on free tiers. Show a
  // plain-language explanation instead of the raw provider JSON.
  const is_rate_limit = $derived(
    /429|resource_exhausted|quota|rate.?limit/i.test(slice.error.value),
  )
  // Transient server overload (503 / UNAVAILABLE / "high demand") — the auto-retry
  // already tried; tell the user it's temporary and to resend.
  const is_overloaded = $derived(
    /503|unavailable|overloaded|high demand|try again later/i.test(slice.error.value),
  )

  function on_setup_done(): void {
    setup_open = false
    // chat_config.provider may have changed — the $effect above reloads the key.
    // Also pull it straight away so has_key flips without waiting a tick.
    const p = chat_config.provider
    loadApiKey(p)
      .then((k) => {
        if (p === chat_config.provider && k) {
          local_key = k
          set_session_api_key(k)
        }
      })
      .catch(() => {/* leave to the $effect */})
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text) return
    // Label this tab by its first message (no-op once a title is set).
    set_chat_title(active_id, text)
    // Refresh the structure context from whatever's open RIGHT NOW, every send.
    // This is the typed mobile chat's only context source, and it must be
    // current across app restarts (structure restored, no load event fires) and
    // mid-conversation structure swaps. Empty string when nothing is open, which
    // correctly tells CatBot there's no structure.
    slice.structure_context.value = build_structure_context({ structure })
    // Push the in-memory key right before sending so stream_client_llm reads it
    // off chat_config.api_key (§5). Never persisted.
    set_session_api_key(local_key)
    input = ``
    await send_message(text, undefined, active_id)
  }

  function on_input_keydown(e: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline (desktop-style). On a soft
    // keyboard the dedicated Send button is the primary path.
    if (e.key === `Enter` && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // ── Voice input (native iOS SFSpeechRecognizer via tauri-plugin-ios-speech) ──
  // WebKit has no Web Speech API, so unlike the desktop ChatPane this does NOT
  // use webkitSpeechRecognition — it bridges to the native plugin (see
  // ios-speech.ts). Mic is offered only on the native shell; in a plain browser
  // the plugin commands don't exist.
  let mic_listening = $state(false)
  // Set true once the user manually edits the box during/after dictation. The
  // recognizer streams the FULL running transcript each event, so apply_transcript
  // reassigns `input` outright — which would clobber a user's deletion/edit (and
  // make Chinese feel un-deletable while the mic is live). Once the user takes
  // over the box we freeze transcript application until the next mic tap.
  let mic_edited = $state(false)
  // Guards toggle_mic against re-entry: a rapid double-tap could otherwise fire a
  // new start_listening before the previous stop_listening IPC resolved, colliding
  // two sessions at the native plugin.
  let mic_busy = $state(false)
  const mic_supported = isMobile()
  // Whatever was already typed when dictation began. The recognizer streams the
  // FULL running transcript each event (not deltas), so we render base + result
  // — preserving text the user typed before tapping the mic.
  let mic_base = ``
  let mic_unlisten: (() => void) | null = null

  // ── Voice language / accent ──
  // Selected BCP-47 locale (`''` = device default). Switching to en-GB/en-IN/
  // zh-CN/zh-TW/… swaps SFSpeechRecognizer's model, which is how accents and
  // Chinese get picked up. `voice_locales` is the device-supported set (fetched
  // once), so the picker never offers a locale that would fail at start.
  let voice_locale = $state(load_voice_locale())
  let voice_locales = $state<string[]>([])
  let lang_sheet_open = $state(false)

  // Fetch the device's supported locales once the mic is available. If the
  // remembered choice isn't supported (different device), fall back to the
  // device language, then en-US, then the first supported locale.
  $effect(() => {
    if (!mic_supported) return
    supported_locales()
      .then((list) => {
        voice_locales = list
        if (voice_locale && list.includes(voice_locale)) return
        const fallback = list.find((c) => c === navigator.language) ??
          list.find((c) => c === `en-US`) ?? list[0] ?? ``
        voice_locale = fallback
      })
      .catch(() => {/* plugin unavailable — pill just shows the default */})
  })

  function pick_locale(code: string): void {
    voice_locale = code
    save_voice_locale(code)
    lang_sheet_open = false
  }

  // On unmount: clear the transcript handler (IPC-free now — on_transcript's
  // cleanup is just a reference swap) and stop the mic IF it's still recording.
  // The listener teardown used to fire `remove_listener` invokes here, which
  // wedged the WKWebView main thread and froze the app on every minimize.
  $effect(() => () => {
    if (mic_listening) void stop_listening().catch(() => {})
    mic_unlisten?.()
    mic_unlisten = null
  })

  // The user typed/deleted in the box. If the mic is live, freeze transcript
  // application (so the recognizer can't overwrite the edit) and end the session.
  // bind:value assignments do NOT fire `input`, so this only catches real edits.
  function on_user_edit(): void {
    if (mic_listening && !mic_edited) {
      mic_edited = true
      mic_listening = false
      void stop_listening().catch(() => {})
    }
  }

  // ── Soft-keyboard inset (B1) ──
  // On iOS WKWebView the keyboard shrinks window.visualViewport but NOT the
  // layout viewport, so the bottom-anchored composer (.ai-overlay is
  // position:absolute inset:0) stays behind the keyboard. Pad the overlay bottom
  // by the keyboard overlap so the composer floats above it. On Android the
  // native MainActivity inset listener already shrinks the WebView and
  // visualViewport does NOT shrink for the IME, so this computes ~0 and we don't
  // double-count. Mirrors MobileTerminal's kb_inset.
  let kb_inset = $state(0)
  $effect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let last = -1
    const update = () => {
      const next = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      if (next === last) return
      last = next
      kb_inset = next
    }
    update()
    vv.addEventListener(`resize`, update)
    vv.addEventListener(`scroll`, update)
    return () => {
      vv.removeEventListener(`resize`, update)
      vv.removeEventListener(`scroll`, update)
    }
  })

  // TODO(you): apply a streamed transcript to the composer.
  //
  // Called for every recognizer event: `text` is the FULL transcript so far,
  // `is_final` is true once speech settles (silence) or stop_mic() is called.
  // `mic_base` holds whatever was in the box before dictation started.
  //
  // Decisions this function encodes (this is the product call, not boilerplate):
  //   1. Merge — replace the whole box, or append the transcript to `mic_base`
  //      so pre-typed text survives? (The recognizer gives the full running
  //      string each time, so set `input` outright — don't concatenate events.)
  //   2. On `is_final` — keep the text in the box for the user to review/edit
  //      and tap Send (safe: no mis-sends from a misheard word), OR auto-send
  //      immediately (fast, hands-free, but a stray noise can fire a message)?
  //      If you auto-send, also flip `mic_listening = false`.
  //
  // Keep it ~6-10 lines. Helpers in scope: `input` ($state, bound to the
  // textarea), `mic_base`, `mic_listening` ($state), `send()`.
  function apply_transcript(text: string, is_final: boolean): void {
    // The user grabbed the box mid-dictation (edited/deleted) — stop overwriting
    // it. Without this, every streamed transcript (incl. the final emitted by
    // stop_listening) reassigns `input` and wipes the user's edit, so deleting
    // Chinese while the mic is live feels impossible.
    if (mic_edited) return
    // Preserve anything typed before the mic started. The recognizer streams the
    // FULL running transcript each event, so set `input` outright — concatenating
    // would duplicate ("show show the…"). Add a space only when joining onto
    // existing text that doesn't already end in whitespace.
    const sep = mic_base && !/\s$/.test(mic_base) ? ` ` : ``
    input = mic_base + sep + text
    // Review-before-send: leave the text in the box for the user to eyeball and
    // tap Send. A misheard word must not auto-fire a message (which could run a
    // viewer tool). `final` also means the session ended, so reset the button.
    if (is_final) mic_listening = false
  }

  function on_mic_error(message: string): void {
    slice.error.value = message
    mic_listening = false
  }

  async function toggle_mic(): Promise<void> {
    if (mic_busy) return // ignore taps while a start/stop IPC is in flight
    mic_busy = true
    try {
      if (mic_listening) {
        mic_listening = false
        await stop_listening() // emits one last `final` → apply_transcript
        return
      }
      const granted = await request_speech_permission()
      if (!granted) {
        slice.error.value = t(`mobile.ai_mic_denied`)
        return
      }
      mic_base = input
      mic_edited = false // fresh session — transcripts may drive the box again
      // Subscribe before starting so no early partial is missed; reuse one set of
      // listeners across sessions (re-tapping mic just re-arms start_listening).
      if (!mic_unlisten) {
        mic_unlisten = await on_transcript({
          on_partial: (txt) => apply_transcript(txt, false),
          on_final: (txt) => apply_transcript(txt, true),
          on_error: on_mic_error,
        })
      }
      mic_listening = true
      await start_listening(voice_locale || undefined)
    } catch (e) {
      // A rejected invoke (e.g. start_listening for an unsupported locale, or a
      // listener-registration failure) must surface as an error, not an unhandled
      // rejection that hijacks the screen. Reset the button if a start failed.
      mic_listening = false
      slice.error.value = e instanceof Error ? e.message : t(`mobile.ai_mic_denied`)
    } finally {
      mic_busy = false
    }
  }

  // ── Lightweight markdown → safe HTML (no katex / hljs) ──
  function escape_html(s: string): string {
    return s
      .replace(/&/g, `&amp;`)
      .replace(/</g, `&lt;`)
      .replace(/>/g, `&gt;`)
      .replace(/"/g, `&quot;`)
  }

  /** Minimal inline markdown: escape first, then **bold** + `code`. Splitting
   *  on backticks keeps code spans verbatim (no bold inside them). */
  function render_inline(escaped: string): string {
    const parts = escaped.split(/(`[^`]*`)/g)
    return parts
      .map((part) => {
        if (part.startsWith(`\``) && part.endsWith(`\``) && part.length >= 2) {
          return `<code>${part.slice(1, -1)}</code>`
        }
        return part.replace(/\*\*([^*]+)\*\*/g, `<strong>$1</strong>`)
      })
      .join(``)
  }

  /** Block markdown → safe HTML: bullet (* - •) and numbered (1. 1)) list runs
   *  become real <ul>/<ol>; everything else is paragraphs (blank-line separated,
   *  single newlines → <br>). Inline bold/code handled per line. Lightweight by
   *  design — no full markdown lib. */
  function render_markdown(text: string): string {
    const bullet_re = /^\s*[*\-•]\s+(.*)$/
    const number_re = /^\s*\d+[.)]\s+(.*)$/
    const lines = text.split(`\n`)
    const html: string[] = []
    let para: string[] = []
    const flush = () => {
      if (para.length) {
        html.push(`<p>${para.map((l) => render_inline(escape_html(l))).join(`<br>`)}</p>`)
        para = []
      }
    }
    let i = 0
    while (i < lines.length) {
      const is_num = number_re.test(lines[i])
      const is_bul = bullet_re.test(lines[i])
      if (is_num || is_bul) {
        flush()
        const re = is_num ? number_re : bullet_re
        const items: string[] = []
        // Same-type consecutive lines form one list; a type switch ends it.
        while (i < lines.length && re.test(lines[i])) {
          items.push(render_inline(escape_html(lines[i].match(re)![1])))
          i++
        }
        const tag = is_num ? `ol` : `ul`
        html.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join(``)}</${tag}>`)
        continue
      }
      if (lines[i].trim() === ``) {
        flush()
        i++
        continue
      }
      para.push(lines[i])
      i++
    }
    flush()
    return html.join(``)
  }
</script>

<div class="ai-overlay" style="padding-bottom: {kb_inset}px">
  <header class="ai-head">
    <!-- Chat tab strip: tap = switch, long-press = close sheet, + = new (capped
         at MAX_CHAT_TABS). Mirrors the terminal tab bar. -->
    <div class="ai-tabbar" role="tablist" aria-label={t(`mobile.ai_title`)}>
      {#each chat_tabs.tabs as tab (tab.id)}
        <div class="ai-tabchip" class:active={tab.id === active_id}>
          <button
            type="button"
            class="ai-tabchip-btn"
            role="tab"
            aria-selected={tab.id === active_id}
            onclick={() => tab_click(tab.id)}
            onpointerdown={() => tab_pointerdown(tab.id)}
            onpointerup={tab_pointerup}
            onpointercancel={tab_pointerup}
            oncontextmenu={(e) => e.preventDefault()}
          ><span class="ai-tabchip-label">{chat_tab_label(tab)}</span></button>
        </div>
      {/each}
      {#if chat_tabs.tabs.length < MAX_CHAT_TABS}
        <button
          type="button"
          class="ai-tab-add"
          aria-label={t(`mobile.ai_new_chat`)}
          title={t(`mobile.ai_new_chat`)}
          onclick={() => add_chat_tab()}
        ><Icon icon="Plus" /></button>
      {/if}
    </div>
    <div class="ai-head-ctrls">
      <button
        type="button"
        class="ai-head-btn"
        class:active={setup_open}
        aria-label={t(`mobile.ai_setup`)}
        title={t(`mobile.ai_setup`)}
        aria-pressed={setup_open}
        onclick={() => (setup_open = !setup_open)}
      ><Icon icon="Settings" /></button>
      <button
        type="button"
        class="ai-head-btn"
        aria-label={t(`mobile.ai_minimize`)}
        title={t(`mobile.ai_minimize`)}
        onclick={on_close}
      ><Icon icon="Collapse" /></button>
    </div>
  </header>

  {#if show_setup}
    <div class="ai-setup-host">
      <MobileChatSetup on_done={on_setup_done} />
    </div>
  {:else}
    <div class="ai-body" bind:this={body_el}>
      {#if slice.messages.list.length === 0}
        <div class="ai-empty">
          <Icon icon="Chat" />
          <p>{t(`mobile.ai_empty`)}</p>
        </div>
      {:else}
        {#each slice.messages.list as msg, i (i)}
          {@const text = get_display_text(msg.content)}
          {@const is_user = msg.role === `user`}
          {@const is_last = i === slice.messages.list.length - 1}
          <!-- Show the assistant bubble even with EMPTY text while a round is in
               flight: a tool-only first turn (round 0 = the tool call, no prose;
               the summary arrives in round 1) would otherwise render nothing, so
               the reply looks like it never came and the user re-sends. -->
          {@const show_working = !is_user && !text && is_last && slice.loading.value}
          {#if text || show_working}
            <!-- Grouped avatar: only the first assistant message of a consecutive
                 run shows the CatBot disc; later bubbles align under it. -->
            {@const group_start = !is_user &&
            (i === 0 || slice.messages.list[i - 1]?.role !== `assistant`)}
            <div class="ai-row" class:user={is_user}>
              {#if !is_user}
                <div class="ai-avatar-slot">
                  {#if group_start}
                    <div class="ai-avatar" aria-hidden="true"><Icon icon="Cat" /></div>
                  {/if}
                </div>
              {/if}
              <div class="ai-msg" class:user={is_user}>
                {#if text}
                  <!-- Safe: render_markdown HTML-escapes its input before applying
                       the tiny inline transform, so no user text reaches the DOM
                       unescaped. -->
                  <div class="ai-msg-body">{@html render_markdown(text)}</div>
                  {#if format_time(msg.timestamp)}
                    <span class="ai-msg-time">{format_time(msg.timestamp)}</span>
                  {/if}
                {:else}
                  <div class="ai-msg-body ai-msg-working" aria-live="polite">
                    <span class="ai-dots" aria-hidden="true"></span>
                    <span>{t(`mobile.ai_thinking`)}</span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
      {/if}

      <!-- Tool calls of the current run: compact status rows, tap to expand -->
      {#each Object.entries(slice.active_tool_blocks.entries) as [id, tb] (id)}
        <div class="ai-tool" class:error={tb.status === `error`}>
          <button type="button" class="ai-tool-row" onclick={() => toggle_tool(id)}>
            {#if tb.status === `running`}
              <span class="ai-dots" aria-hidden="true"></span>
            {:else if tb.status === `error`}
              <span class="ai-tool-mark err">✗</span>
            {:else}
              <span class="ai-tool-mark ok">✓</span>
            {/if}
            <span class="ai-tool-name">{tb.toolName}</span>
            {#if tb.status === `error`}<span class="ai-tool-sub">{t(`mobile.ai_tool_failed`)}</span>{/if}
          </button>
          {#if expanded_tools.has(id)}
            <pre class="ai-tool-out">{tb.output || JSON.stringify(tb.input, null, 1)}</pre>
          {/if}
        </div>
      {/each}

      <!-- Pending mutating-tool permission cards (client-direct loop) -->
      {#each Object.entries(slice.active_permission_blocks.entries) as [id, pb] (id)}
        {#if pb.status === `pending` && pb.resolve}
          <div class="ai-perm" role="alertdialog" aria-label={t(`mobile.ai_tool_permission`)}>
            <div class="ai-perm-title">{t(`mobile.ai_tool_permission`)}</div>
            <div class="ai-perm-tool">{pb.toolName}</div>
            <pre class="ai-perm-input">{truncate_input(pb.input)}</pre>
            <label class="ai-perm-skip">
              <input type="checkbox" bind:checked={skip_session} />
              {t(`mobile.ai_dont_ask_again`)}
            </label>
            <div class="ai-perm-actions">
              <button type="button" class="ai-perm-deny" onclick={() => decide_permission(pb, false)}>{t(`mobile.ai_deny`)}</button>
              <button type="button" class="ai-perm-allow" onclick={() => decide_permission(pb, true)}>{t(`mobile.ai_allow`)}</button>
            </div>
          </div>
        {/if}
      {/each}

      {#if error_text}
        <div class="ai-error" role="alert">
          <span>
            {#if is_key_error}
              {t(`mobile.ai_invalid_key`)}
            {:else if is_rate_limit}
              {t(`mobile.ai_rate_limited`)}
            {:else if is_overloaded}
              {t(`mobile.ai_model_busy`)}
            {:else}
              {error_text}
            {/if}
          </span>
          {#if is_key_error || is_rate_limit || is_overloaded}
            <button type="button" class="ai-error-fix" onclick={() => (setup_open = true)}>
              {t(`mobile.ai_setup`)}
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="ai-composer">
      <textarea
        class="ai-input"
        rows="1"
        placeholder={t(`mobile.ai_message_placeholder`)}
        bind:value={input}
        onkeydown={on_input_keydown}
        oninput={on_user_edit}
      ></textarea>
      {#if mic_supported}
        {#if voice_locale}
          <button
            type="button"
            class="ai-lang-pill"
            aria-label={t(`mobile.ai_voice_language`)}
            onclick={() => (lang_sheet_open = true)}
          >{locale_short(voice_locale)}</button>
        {/if}
        <button
          type="button"
          class="ai-mic"
          class:listening={mic_listening}
          aria-label={t(`mobile.ai_voice_input`)}
          aria-pressed={mic_listening}
          onclick={toggle_mic}
        ><Icon icon="Mic" /></button>
      {/if}
      {#if slice.loading.value}
        <button
          type="button"
          class="ai-send stop"
          aria-label={t(`mobile.ai_stop`)}
          onclick={() => cancel_generation(active_id)}
        ><Icon icon="Close" /></button>
      {:else}
        <button
          type="button"
          class="ai-send"
          aria-label={t(`mobile.ai_send`)}
          disabled={!input.trim()}
          onclick={send}
        ><Icon icon="ArrowUp" /></button>
      {/if}
    </div>
  {/if}

  {#if sheet_tab}
    <!-- Long-press close sheet for a chat tab (mirrors the terminal one). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="ai-sheet-backdrop" role="presentation" onclick={() => (sheet_tab = null)}>
      <div
        class="ai-sheet"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <button type="button" class="ai-sheet-btn danger" onclick={sheet_close}>
          {t(`mobile.ai_close_chat`)}
        </button>
        <button type="button" class="ai-sheet-btn" onclick={() => (sheet_tab = null)}>
          {t(`common.cancel`)}
        </button>
      </div>
    </div>
  {/if}

  {#if lang_sheet_open}
    <!-- Voice-language / accent picker. Only device-supported locales appear. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="ai-sheet-backdrop"
      role="presentation"
      onclick={() => (lang_sheet_open = false)}
    >
      <div
        class="ai-sheet"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="ai-sheet-title">{t(`mobile.ai_voice_language`)}</div>
        <div class="ai-lang-list">
          {#each voice_locales as code (code)}
            <button
              type="button"
              class="ai-sheet-btn ai-lang-row"
              class:selected={code === voice_locale}
              onclick={() => pick_locale(code)}
            >
              <span>{locale_label(code)}</span>
              {#if code === voice_locale}<Icon icon="Check" />{/if}
            </button>
          {/each}
        </div>
        <button
          type="button"
          class="ai-sheet-btn"
          onclick={() => (lang_sheet_open = false)}
        >
          {t(`common.cancel`)}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .ai-overlay {
    position: absolute;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--page-bg, #0e1117);
    /* padding-bottom is set inline to the soft-keyboard inset (B1) so the
       composer floats above the keyboard on iOS; glide it to avoid a jump. */
    transition: padding-bottom 0.18s ease;
  }
  .ai-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
    padding: 8px 10px;
    padding-top: max(8px, env(safe-area-inset-top));
    background: var(--page-bg, #0e1117);
    border-bottom: 1px solid rgba(128, 128, 140, 0.18);
  }
  .ai-head-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
    font-size: 17px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  /* Gear lights up while the settings card is open, so tapping it again to go
     back to the chat reads as a toggle. */
  .ai-head-btn.active {
    color: var(--accent-color, #6366f1);
    background: var(--surface-2, rgba(148, 163, 184, 0.12));
  }
  .ai-head-ctrls {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .ai-tabbar {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .ai-tabbar::-webkit-scrollbar {
    display: none;
  }
  .ai-tabchip {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .ai-tabchip-btn {
    display: inline-flex;
    align-items: center;
    max-width: 120px;
    min-height: 32px;
    padding: 0 10px;
    font-size: 12px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    cursor: pointer;
    /* iOS: long-press (to close) must not text-select the tab label. */
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .ai-tabchip.active .ai-tabchip-btn {
    color: var(--accent-color, #3b82f6);
    border-color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.1);
  }
  .ai-tabchip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-tab-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    font-size: 14px;
    color: var(--text-color-muted, #94a3b8);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  /* Long-press close action sheet (mirrors MobileWorkspace's terminal sheet). */
  .ai-sheet-backdrop {
    position: absolute;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .ai-sheet {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 12px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: var(--page-bg, #0e1117);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ai-sheet-btn {
    min-height: 48px;
    font-size: 15px;
    color: var(--text-color, #e0e0e0);
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .ai-sheet-btn.danger {
    color: #ff6b6b;
    border-color: rgba(255, 107, 107, 0.5);
  }
  .ai-sheet-title {
    padding: 4px 4px 8px;
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-color-muted, #94a3b8);
  }
  /* Scrollable so a device with many supported locales doesn't overflow. */
  .ai-lang-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 48vh;
    overflow-y: auto;
  }
  .ai-lang-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    text-align: left;
  }
  .ai-lang-row.selected {
    color: var(--accent-color, #0a84ff);
    border-color: color-mix(in srgb, var(--accent-color, #0a84ff) 55%, transparent);
  }
  /* Compact accent/language pill in the composer (e.g. "EN-US"). */
  .ai-lang-pill {
    flex-shrink: 0;
    height: 40px;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--text-color-muted, #94a3b8);
    background: var(--surface-2, rgba(148, 163, 184, 0.12));
    border: none;
    border-radius: 20px;
    cursor: pointer;
    transition: transform 0.06s ease, color 0.12s ease;
  }
  .ai-lang-pill:active {
    transform: scale(0.94);
  }
  .ai-setup-host {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .ai-setup-host :global(.cs-wrap) {
    flex: 1;
  }
  .ai-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
  }
  .ai-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 22px;
    color: var(--text-color-muted, #94a3b8);
  }
  .ai-empty p {
    font-size: 0.7em;
    margin: 0;
  }
  .ai-row {
    display: flex;
    align-self: stretch;
    align-items: flex-start;
    gap: 8px;
  }
  .ai-row.user {
    flex-direction: row-reverse; /* bubble hugs the right edge, no avatar slot */
  }
  .ai-avatar-slot {
    flex-shrink: 0;
    width: 28px; /* reserved even when empty so grouped bubbles stay aligned */
  }
  .ai-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    font-size: 17px; /* Icon is height:1em → ~17px cat */
    color: #fff;
    border-radius: 50%;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent-color, #0a84ff) 88%, #fff) 0%,
      var(--accent-color, #0a84ff) 55%,
      color-mix(in srgb, var(--accent-color, #0a84ff) 78%, #000) 100%
    );
    box-shadow: 0 1px 3px
      color-mix(in srgb, var(--accent-color, #0a84ff) 35%, transparent);
  }
  .ai-msg {
    max-width: 84%;
    padding: 9px 13px;
    border-radius: 17px;
    border-bottom-left-radius: 5px; /* subtle tail toward the assistant side */
    font-size: 15px;
    line-height: 1.5;
    color: var(--text-color, #e0e0e0);
    background: var(--surface-bg, #1a1a2e);
    border: 1px solid rgba(128, 128, 140, 0.16);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  }
  .ai-msg.user {
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border-color: transparent;
    border-radius: 17px;
    border-bottom-right-radius: 5px; /* tail toward the user side */
  }
  .ai-msg-time {
    display: block;
    margin-top: 4px;
    font-size: 0.68em;
    line-height: 1;
    text-align: right;
    color: var(--text-color-muted, #94a3b8);
    opacity: 0.7;
  }
  .ai-msg.user .ai-msg-time {
    color: rgba(255, 255, 255, 0.85);
    opacity: 0.85;
  }
  .ai-msg-body :global(p) {
    margin: 0 0 0.5em;
  }
  .ai-msg-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .ai-msg-body :global(ul),
  .ai-msg-body :global(ol) {
    margin: 0.35em 0;
    padding-left: 1.25em;
  }
  .ai-msg-body :global(ul:last-child),
  .ai-msg-body :global(ol:last-child) {
    margin-bottom: 0;
  }
  .ai-msg-body :global(li) {
    margin: 0.2em 0;
    padding-left: 0.15em;
  }
  .ai-msg-body :global(li)::marker {
    color: var(--text-color-muted, #94a3b8);
  }
  .ai-msg-body :global(code) {
    /* Non-monospace: same sans typeface as the body so the message reads as one
       font. A subtle tinted chip (+ medium weight) still marks it as a code /
       tool name without the monospace contrast. */
    font-family: inherit;
    font-size: 0.94em;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(128, 128, 140, 0.16);
    word-break: break-word;
  }
  /* In-bubble "working" indicator for an assistant turn that's mid-tool-loop
     with no text yet (replaces the old detached Thinking strip). */
  .ai-msg-working {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.92em;
    color: var(--text-color-muted, #94a3b8);
  }
  .ai-dots {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: var(--accent-color, #3b82f6);
    border-radius: 50%;
    animation: ai-spin 0.8s linear infinite;
  }
  @keyframes ai-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .ai-error {
    display: flex;
    align-items: center;
    gap: 10px;
    align-self: stretch;
    font-size: 0.85em;
    color: #ff6b6b;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .ai-error span {
    flex: 1;
    min-width: 0;
  }
  .ai-error-fix {
    flex-shrink: 0;
    min-height: 32px;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: var(--accent-color, #0a84ff);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .ai-composer {
    display: flex;
    /* Center so the language pill / mic / send sit level with the text box on a
       single line (flex-end dropped the pill low). The textarea grows upward to
       max-height for multi-line, keeping the controls vertically centered. */
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding: 10px 12px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    /* Solid, theme-aware bar so the safe-area edge blends instead of letting the
       page show through (the old translucent black left a light gap on iOS). */
    background: var(--page-bg, #0e1117);
    border-top: 1px solid rgba(128, 128, 140, 0.18);
  }
  .ai-input {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    max-height: 120px;
    padding: 9px 14px;
    font-size: 16px; /* >=16px stops iOS zoom-on-focus. */
    font-family: inherit;
    line-height: 1.4;
    color: var(--text-color, #e0e0e0);
    /* Neutral fill that reads on light + dark (was muddy on the light theme). */
    background: rgba(128, 128, 140, 0.12);
    border: 1px solid rgba(128, 128, 140, 0.28);
    border-radius: 20px; /* pill */
    outline: none;
    resize: none;
    box-sizing: border-box;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .ai-input::placeholder {
    color: var(--text-color-muted, #94a3b8);
    opacity: 0.7;
  }
  .ai-input:focus {
    border-color: var(--accent-color, #6366f1);
    background: rgba(128, 128, 140, 0.06);
  }
  .ai-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    font-size: 18px;
    color: #fff;
    /* Gradient derived from the theme accent (lighter top-left → deeper
       bottom-right) so it stays on-theme in both light and dark. Fallback to the
       flat accent for any engine without color-mix. */
    background: var(--accent-color, #0a84ff);
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent-color, #0a84ff) 88%, #fff) 0%,
      var(--accent-color, #0a84ff) 55%,
      color-mix(in srgb, var(--accent-color, #0a84ff) 78%, #000) 100%
    );
    border: none;
    border-radius: 50%; /* circular send, sits flush with the pill input */
    cursor: pointer;
    box-shadow: 0 2px 6px
      color-mix(in srgb, var(--accent-color, #0a84ff) 40%, transparent);
    transition: opacity 0.12s ease, transform 0.06s ease;
  }
  .ai-send:active {
    transform: scale(0.92);
  }
  .ai-send:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ai-send.stop {
    background: #ff6b6b;
  }
  /* Mic: a neutral ghost circle that goes solid-red and pulses while listening,
     so the recording state is unmistakable next to the accent Send button. */
  .ai-mic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    font-size: 18px;
    color: var(--text-color-muted, #94a3b8);
    background: var(--surface-2, rgba(148, 163, 184, 0.12));
    border: none;
    border-radius: 50%;
    cursor: pointer;
    transition: transform 0.06s ease, background 0.12s ease, color 0.12s ease;
  }
  .ai-mic:active {
    transform: scale(0.92);
  }
  .ai-mic.listening {
    color: #fff;
    background: #ff3b30;
    animation: ai-mic-pulse 1.4s ease-in-out infinite;
  }
  @keyframes ai-mic-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(255, 59, 48, 0.5);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(255, 59, 48, 0);
    }
  }
  .ai-tool {
    margin: 2px 0;
    border-radius: 8px;
    background: var(--surface-2, rgba(148, 163, 184, 0.08));
    overflow: hidden;
  }
  .ai-tool-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    color: var(--text-color-muted, #94a3b8);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .ai-tool-mark.ok { color: var(--success-color, #4ade80); }
  .ai-tool-mark.err { color: #ff6b6b; }
  .ai-tool-name { font-family: monospace; }
  .ai-tool-sub { margin-left: auto; font-size: 12px; opacity: 0.8; }
  .ai-tool-out,
  .ai-perm-input {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
    font-family: monospace;
    overflow-x: auto;
    white-space: pre;
    color: var(--text-color-muted, #94a3b8);
    background: rgba(0, 0, 0, 0.15);
  }
  .ai-tool-out { max-height: 40vh; overflow-y: auto; }
  .ai-perm-input {
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ai-perm {
    margin: 6px 0;
    padding: 10px;
    border: 1px solid rgba(250, 204, 21, 0.6);
    border-radius: 10px;
    display: grid;
    gap: 8px;
  }
  .ai-perm-title { font-weight: 600; font-size: 14px; color: var(--text-color, #e0e0e0); }
  .ai-perm-tool { font-family: monospace; font-size: 13px; color: var(--text-color-muted, #94a3b8); }
  .ai-perm-skip { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-color-muted, #94a3b8); }
  .ai-perm-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ai-perm-actions button {
    min-height: 40px;
    padding: 0 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 14px;
    cursor: pointer;
  }
  .ai-perm-allow { background: var(--accent-color, #3b82f6); color: white; }
  .ai-perm-deny {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.12) !important;
    color: var(--text-color-muted, #94a3b8);
  }
</style>
