<script lang="ts">
  import { untrack } from 'svelte'
  import { Icon } from '$lib'
  import type { AnyStructure } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import {
    get_chat_slice,
    chat_config,
    chat_username,
    send_message,
    cancel_generation,
    clear_chat_history,
    update_config,
    import_paper,
    import_doi,
    clear_paper,
    agent_sessions,
    resume_session,
    new_session,
    delete_session,
    session_list,
    load_session_messages,
  } from './chat-state.svelte'
  import { build_structure_context, build_workflow_context } from './context'
  import { markdown_to_html } from './markdown'
  import { get_display_text, get_tool_uses } from './types'
  import type { LLMProvider, ChatMessage, SessionSummary, ProviderInfoResponse, ToolResultBlock, Attachment } from './types'
  import ToolResultRenderer from './ToolResultRenderer.svelte'
  import PermissionCard from './PermissionCard.svelte'
  import ToolProgressBlock from './ToolProgressBlock.svelte'
  import ThinkingSummary from './ThinkingSummary.svelte'
  import { SDK_PROVIDERS, default_mode_for } from './types'
  import { fetch_providers } from './llm-client'
  import { TTSEngine } from '$lib/gesture/tts-engine'
  import {
    FALLBACK_MODELS, CLI_INSTALL_INFO, PROVIDER_META, AGENT_LABELS, VOICE_LANGUAGES,
    BASE_CHIPS, WORKFLOW_CHIPS, PAPER_CHIPS,
    get_models, is_available, format_workflow_event, format_time_ago, friendly_error,
    detect_language, is_tool_result_msg, extract_current_action,
  } from './message-utils'
  import { get_tool_results_for, is_streaming } from './tool-execution'
  import { copy_to_clipboard, handle_messages_click } from './attachment-utils'
  import { run_slash, SLASH_COMMANDS } from './slash-commands'
  import { get_current_structure } from '$lib/structure/current-structure.svelte'


  // Dynamic providers from backend
  let providers = $state<ProviderInfoResponse[]>([])
  let providers_loaded = $state(false)

  // Provider connection test state
  let test_status = $state<`idle` | `testing` | `success` | `error`>(`idle`)
  let test_message = $state(``)
  let test_latency = $state(0)

  // Reset test status when provider/key/model changes
  $effect(() => {
    void chat_config.provider
    void chat_config.api_key
    void chat_config.model
    test_status = `idle`
    test_message = ``
  })

  // Fetch providers on mount
  $effect(() => {
    if (!providers_loaded) {
      fetch_providers().then((p) => {
        providers = p
        providers_loaded = true
      })
    }
  })


  /** Test the current provider configuration */
  async function test_provider_connection() {
    test_status = `testing`
    test_message = ``
    try {
      const resp = await fetch(`${API_BASE}/chat/providers/test`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          provider_id: chat_config.provider,
          api_key: chat_config.api_key || undefined,
          model: chat_config.model || undefined,
          base_url: chat_config.base_url || undefined,
        }),
      })
      const data = await resp.json()
      if (data.success) {
        test_status = `success`
        test_latency = Math.round(data.latency_ms ?? 0)
        test_message = `Connected (${test_latency}ms)`
      } else {
        test_status = `error`
        test_message = data.error || `Connection failed`
      }
    } catch {
      test_status = `error`
      test_message = `Cannot reach backend server`
    }
  }
  import type { MoyoDataset } from '@spglib/moyo-wasm'
  import { get_workflow_slice, clear_workflow_events } from '$lib/workflow/workflow-state.svelte'
  import type { WorkflowEvent } from '$lib/workflow/workflow-state.svelte'
  import { chat_position, set_chat_position, broadcast_chat_context, listen_chat_context } from './chat-state.svelte'

  let {
    structure = undefined,
    symmetry_data = null,
    selected_sites = [],
    on_close = () => {},
    on_popout = undefined,
    is_popout = false,
    tab_id,
  }: {
    structure?: AnyStructure
    symmetry_data?: MoyoDataset | null
    selected_sites?: number[]
    on_close?: () => void
    on_popout?: () => void
    is_popout?: boolean
    // Per-tab identifier used to resolve the ChatPane's workflow slice and to
    // route workflow pushes to the originating tab (Phase 2). Falls back to
    // "default" for popouts and standalone contexts — those share a single
    // slice, which preserves pre-Phase-2 behavior.
    tab_id?: string
  } = $props()

  // The tab slice this ChatPane binds to. Memoized via $derived so that
  // switching tab_id (theoretical — `tab_id` is a prop that rarely changes
  // after mount) updates all downstream reads in lockstep.
  const tab_slice_id = $derived(tab_id ?? `default`)
  const wf_slice = $derived(get_workflow_slice(tab_slice_id))
  // Phase 2 C4: every chat-state read/write goes through this per-tab
  // slice. Opening two chat-bearing tabs gives each its own thread,
  // tool-call progress, permission prompts, and loading/error flags.
  const slice = $derived(get_chat_slice(tab_slice_id))

  // Keep structure context in sync with current structure
  $effect(() => {
    slice.structure_context.value = build_structure_context({
      structure,
      symmetry_data,
      selected_sites,
    })
    broadcast_chat_context(tab_slice_id)
  })

  // Keep workflow context in sync with active workflow
  $effect(() => {
    slice.workflow_context.value = build_workflow_context(wf_slice.active_workflow)
    broadcast_chat_context(tab_slice_id)
  })

  // Popout mode: listen for context updates from main window. Pass the
  // popout's tab_id twice:
  //   1. First arg: write incoming broadcasts into this popout's slice.
  //   2. Second arg: filter broadcasts to only those originating from
  //      the mirrored tab in the main window. Without this filter, any
  //      tab's broadcast in the main window overwrites our context, so
  //      switching to a different tab would swap the popout's context.
  $effect(() => {
    if (!is_popout) return
    return listen_chat_context(tab_slice_id, tab_slice_id)
  })

  // Track last seen event count to inject only new events
  let last_event_count = $state(0)

  // Inject copilot notification messages for workflow events
  $effect(() => {
    const queue = wf_slice.workflow_events.queue
    if (queue.length <= last_event_count) return
    const new_events = queue.slice(last_event_count)
    last_event_count = queue.length

    for (const event of new_events) {
      const msg = format_workflow_event(event)
      if (!msg) continue
      const notification: ChatMessage = {
        role: `assistant`,
        content: msg,
        timestamp: event.timestamp,
      }
      slice.messages.list = [...slice.messages.list, notification]
    }
  })

  type Tab = `chat` | `context` | `sessions`
  let active_tab: Tab = $state(`chat`)
  let input_text = $state(``)
  let settings_open = $state(false)
  let messages_div: HTMLDivElement | undefined = $state(undefined)

  // Sessions tab state — fetched from backend (CLI agents store their own history)
  let backend_sessions = $state<SessionSummary[]>([])
  let sessions_loading = $state(false)

  async function fetch_backend_sessions() {
    if (sessions_loading) return
    sessions_loading = true
    try {
      // Fetch sessions for all CLI agents in parallel
      const agents = [`claude`, `gemini`, `codex`]
      const results = await Promise.allSettled(
        agents.map(async (agent) => {
          const resp = await fetch(`${API_BASE}/chat/sessions/${agent}`)
          if (!resp.ok) return []
          const data = await resp.json()
          return (data.sessions ?? []) as SessionSummary[]
        }),
      )
      const all: SessionSummary[] = []
      for (const r of results) {
        if (r.status === `fulfilled`) all.push(...r.value)
      }
      backend_sessions = all
    } catch { /* silently fail if backend unavailable */ }
    finally { sessions_loading = false }
  }

  let all_sessions = $derived.by(() => {
    // Merge backend-listed sessions with the locally-recorded session_list.
    // The local list is the authoritative source while no backend endpoint
    // exposes session history (the original assumption that all CLI agents
    // would surface their own history turned out to be unreliable); the
    // backend list, when available, can override individual entries with
    // fresher metadata. De-duplicate by `session_id` and sort
    // most-recently-active first.
    const merged = new Map<string, SessionSummary>()
    for (const s of session_list.list) merged.set(s.session_id, s)
    for (const s of backend_sessions) merged.set(s.session_id, s)
    return Array.from(merged.values()).sort((a, b) => b.last_active - a.last_active)
  })

  function is_active_session(s: SessionSummary): boolean {
    return agent_sessions[s.agent] === s.session_id
  }

  async function handle_resume_session(s: SessionSummary) {
    const provider_map: Record<string, LLMProvider> = {
      claude: `sdk-claude`,
      gemini: `sdk-gemini`,
      codex: `sdk-codex`,
    }
    const provider = provider_map[s.agent]
    if (provider && provider !== chat_config.provider) {
      update_config({ provider, mode: `sdk` })
    }
    // Restore the transcript from the client-side store. There is no backend
    // session-history endpoint (the old fetch to /chat/sessions/.../history
    // always 404'd and silently fell back to an empty chat); messages are now
    // persisted locally per session_id at the end of every round.
    const msgs = load_session_messages(s.session_id)
    resume_session(s.agent, s.session_id, msgs.length ? msgs : undefined, tab_slice_id)
    active_tab = `chat`
  }

  function handle_new_session() {
    const agent = chat_config.provider.replace(`sdk-`, ``)
    new_session(SDK_PROVIDERS.has(chat_config.provider) ? agent : undefined, tab_slice_id)
    active_tab = `chat`
  }

  function handle_delete_session(s: SessionSummary) {
    delete_session(s.session_id)
    backend_sessions = backend_sessions.filter((bs) => bs.session_id !== s.session_id)
    // Delete backend session file (all agents supported)
    // Fire-and-forget: backend session cleanup is non-critical; local state is already updated
    fetch(`${API_BASE}/chat/sessions/${s.agent}/${s.session_id}`, { method: `DELETE` }).catch(() => {})
  }

  $effect(() => {
    if (active_tab === `sessions`) {
      // Use untrack to avoid re-triggering when sessions_loading changes inside fetch
      untrack(() => fetch_backend_sessions())
    }
  })
  let textarea_el: HTMLTextAreaElement | undefined = $state(undefined)
  let copied_idx: number | null = $state(null)
  let file_input_el: HTMLInputElement | undefined = $state(undefined)
  let attach_input_el: HTMLInputElement | undefined = $state(undefined)

  // ── Attachment state ──
  let pending_attachments = $state<Attachment[]>([])
  const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024 // 20MB

  function get_attachment_type(mime: string): Attachment['type'] {
    if (mime.startsWith(`image/`)) return `image`
    if (mime === `application/pdf`) return `pdf`
    return `file`
  }

  async function add_file(file: File) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      slice.error.value = `File "${file.name}" exceeds 20MB limit`
      return
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // Strip the data:...;base64, prefix
        resolve(result.split(`,`, 2)[1] ?? result)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    pending_attachments = [...pending_attachments, {
      type: get_attachment_type(file.type),
      name: file.name,
      mimeType: file.type || `application/octet-stream`,
      data,
    }]
  }

  function remove_attachment(idx: number) {
    pending_attachments = pending_attachments.filter((_, i) => i !== idx)
  }

  function handle_attach_input(e: Event) {
    const input = e.target as HTMLInputElement
    const files = input.files
    if (!files) return
    for (const file of files) {
      add_file(file)
    }
    input.value = ``
  }

  function handle_attach_drop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (!files) return
    for (const file of files) {
      // PDF files go through the existing paper import path
      if (file.name.toLowerCase().endsWith(`.pdf`) && !slice.paper_session.session_id) {
        do_pdf_import(file)
      } else {
        add_file(file)
      }
    }
  }

  function handle_attach_paste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === `file`) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          add_file(file)
        }
      }
    }
  }

  let voice_language = $state(`en-US`)

  // ── Voice input (STT) ──
  let voice_recording = $state(false)
  let voice_supported = $state(false)
  let recognition: any = null

  $effect(() => {
    voice_supported = typeof window !== `undefined` &&
      (`SpeechRecognition` in window || `webkitSpeechRecognition` in window)
  })

  function toggle_voice() {
    if (voice_recording) {
      stop_voice()
    } else {
      if (!voice_supported) {
        slice.error.value = `Voice input requires Chrome or Edge. Your browser does not support the Web Speech API.`
        return
      }
      start_voice()
    }
  }

  function start_voice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    recognition = new SR()
    recognition.continuous = !voice_chat_mode
    recognition.interimResults = true
    recognition.lang = voice_language

    recognition.onresult = (event: any) => {
      let transcript = ``
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      input_text = transcript
    }
    recognition.onend = () => {
      voice_recording = false
      // In voice chat mode, auto-send when speech stops
      if (voice_chat_mode && input_text.trim()) {
        handle_send()
      }
    }
    recognition.onerror = () => { voice_recording = false }

    voice_recording = true
    recognition.start()
  }

  function stop_voice() {
    recognition?.stop()
    voice_recording = false
  }

  // ── Voice output (TTS) ──
  let tts: TTSEngine | null = $state(null)
  let speaking_idx: number | null = $state(null)
  let speaking_poll: ReturnType<typeof setInterval> | null = null

  $effect(() => {
    tts = new TTSEngine()
    return () => { tts?.stop() }
  })

  function stop_speaking() {
    tts?.stop()
    speaking_idx = null
    if (speaking_poll) { clearInterval(speaking_poll); speaking_poll = null }
  }

  function speak_message(idx: number) {
    if (!tts) return
    const msg = slice.messages.list[idx]
    const text = get_display_text(msg.content)
    if (!text) return

    if (speaking_idx === idx && tts.is_speaking) {
      stop_speaking()
    } else {
      stop_speaking()
      speaking_idx = idx
      const lang = detect_language(text, voice_language)
      tts.update_config({ language: lang })
      tts.speak(text, `normal`)
      speaking_poll = setInterval(() => {
        if (!tts?.is_speaking) {
          speaking_idx = null
          if (speaking_poll) { clearInterval(speaking_poll); speaking_poll = null }
          // In voice chat mode, restart recording after TTS finishes
          if (voice_chat_mode && !voice_recording) {
            start_voice()
          }
        }
      }, 300)
    }
  }

  // ── Voice conversation mode ──
  let voice_chat_mode = $state(false)
  let last_auto_spoken = -1

  function toggle_voice_chat() {
    voice_chat_mode = !voice_chat_mode
    if (voice_chat_mode) {
      last_auto_spoken = slice.messages.list.length - 1
      if (!voice_supported) {
        slice.error.value = `Voice chat requires Chrome or Edge. Your browser does not support the Web Speech API.`
        voice_chat_mode = false
        return
      }
      start_voice()
    } else {
      stop_voice()
      stop_speaking()
    }
  }

  // Auto-speak new AI responses in voice chat mode
  $effect(() => {
    const loading = slice.loading.value
    if (!voice_chat_mode || loading || !tts) return
    const messages = slice.messages.list
    const last_idx = messages.length - 1
    if (last_idx < 0 || last_idx <= last_auto_spoken) return
    const last = messages[last_idx]
    if (last?.role !== `assistant`) return
    const text = get_display_text(last.content)
    if (!text) return
    last_auto_spoken = last_idx
    const lang = detect_language(text, voice_language)
    tts.update_config({ language: lang })
    speaking_idx = last_idx
    tts.speak(text, `normal`)
    if (speaking_poll) clearInterval(speaking_poll)
    speaking_poll = setInterval(() => {
      if (!tts?.is_speaking) {
        speaking_idx = null
        if (speaking_poll) { clearInterval(speaking_poll); speaking_poll = null }
        if (voice_chat_mode && !voice_recording) start_voice()
      }
    }, 300)
  })

  // ── Reply-quote ──
  let quoted_text = $state(``)
  let quoted_role = $state(``)
  let quoted_msg_idx = $state(-1)

  function quote_message(idx: number) {
    const msg = slice.messages.list[idx]
    const text = get_display_text(msg.content)
    if (!text) return

    const selection = window.getSelection()?.toString().trim()
    if (selection && text.includes(selection)) {
      quoted_text = selection
    } else {
      quoted_text = text.length > 200 ? text.slice(0, 200) + `...` : text
    }
    quoted_role = msg.role
    quoted_msg_idx = idx
    textarea_el?.focus()
  }

  function clear_quote() {
    quoted_text = ``
    quoted_role = ``
    quoted_msg_idx = -1
  }

  const suggestion_chips = $derived(
    slice.paper_session.session_id ? PAPER_CHIPS
      : wf_slice.active_workflow.id ? WORKFLOW_CHIPS
      : BASE_CHIPS,
  )

  let user_scrolled_up = $state(false)
  let _last_programmatic_scroll = 0

  function is_near_bottom(threshold = 80): boolean {
    if (!messages_div) return true
    return messages_div.scrollHeight - messages_div.scrollTop - messages_div.clientHeight < threshold
  }

  function scroll_to_bottom() {
    if (messages_div) {
      requestAnimationFrame(() => {
        messages_div!.scrollTop = messages_div!.scrollHeight
        user_scrolled_up = false
        _last_programmatic_scroll = Date.now()
      })
    }
  }

  function handle_messages_scroll() {
    // Ignore scroll events triggered by our own scrollTop changes in scroll_to_bottom().
    // During rapid streaming, content grows between the rAF (which sets scrollTop) and
    // the resulting scroll event, causing is_near_bottom() to falsely return false.
    if (Date.now() - _last_programmatic_scroll < 150) return
    user_scrolled_up = !is_near_bottom()
  }

  // Smart auto-scroll: only if user hasn't scrolled up
  $effect(() => {
    const last = slice.messages.list[slice.messages.list.length - 1]
    if (last) {
      last.content
      if (!user_scrolled_up) scroll_to_bottom()
    }
  })

  // Force scroll to bottom when streaming completes — catches cases where
  // user_scrolled_up got stuck during a rapid content burst
  $effect(() => {
    if (!slice.loading.value && slice.messages.list.length > 0) {
      const last = slice.messages.list[slice.messages.list.length - 1]
      if (last?.role === `assistant` && get_display_text(last.content)) {
        scroll_to_bottom()
      }
    }
  })

  // CLI agent elapsed timer
  let elapsed_seconds = $state(0)
  let elapsed_timer: ReturnType<typeof setInterval> | null = null

  $effect(() => {
    if (slice.loading.value && SDK_PROVIDERS.has(chat_config.provider)) {
      elapsed_seconds = 0
      elapsed_timer = setInterval(() => { elapsed_seconds++ }, 1000)
    } else {
      if (elapsed_timer) { clearInterval(elapsed_timer); elapsed_timer = null }
      elapsed_seconds = 0
    }
  })

  /** Extract the latest action from the last assistant message (e.g. "Calling structure...") */
  let current_action = $derived.by(() => {
    if (!slice.loading.value) return ``
    const last = slice.messages.list[slice.messages.list.length - 1]
    if (!last || last.role !== `assistant`) return ``
    const text = get_display_text(last.content)
    return extract_current_action(text)
  })

  // Auto-resize textarea
  function auto_resize() {
    if (!textarea_el) return
    textarea_el.style.height = `auto`
    textarea_el.style.height = `${Math.min(textarea_el.scrollHeight, 120)}px`
  }

  $effect(() => {
    // Re-run when input_text changes
    input_text
    auto_resize()
  })

  async function handle_send(text?: string) {
    let msg = (text ?? input_text).trim()
    if (!msg) return

    // Prepend quote context if active
    if (quoted_text) {
      msg = `> ${quoted_text.replace(/\n/g, `\n> `)}\n\n${msg}`
      clear_quote()
    }

    last_user_msg = msg
    input_text = ``
    // Reset textarea height after clearing
    if (textarea_el) textarea_el.style.height = `auto`
    active_tab = `chat`

    // Slash commands: intercept before DOI / send_message. A "/"-prefixed
    // line never reaches the LLM. Unknown "/x" is reported locally.
    if (msg.startsWith(`/`)) {
      const emit_note = (text: string) => {
        slice.messages.list = [...slice.messages.list,
          { role: `assistant`, content: text, timestamp: Date.now() }]
      }
      const handled = await run_slash(msg, {
        tab_id: tab_slice_id,
        args: ``,
        new_session: () => new_session(SDK_PROVIDERS.has(chat_config.provider) ? chat_config.provider.replace(`sdk-`, ``) : undefined, tab_slice_id),
        clear_chat_history: () => clear_chat_history(tab_slice_id),
        cancel_generation: () => cancel_generation(tab_slice_id),
        resume_session: (agent, sid, messages, tid) => resume_session(agent, sid, messages, tid ?? tab_slice_id),
        list_sessions: () => session_list.list,
        load_session_messages: (sid) => load_session_messages(sid),
        run_quickbuild: async (recipe, mp_id) => {
          const resp = await fetch(`${API_BASE}/workflow/quickbuild`, {
            method: `POST`, headers: { 'Content-Type': `application/json` },
            body: JSON.stringify(mp_id ? { recipe, material_id: mp_id } : { recipe }),
          })
          if (!resp.ok) throw new Error((await resp.text().catch(() => String(resp.status))).slice(0, 200))
          const data = await resp.json()
          const wf_id = data.workflow_id
          if (wf_id) {
            const wfslice = get_workflow_slice(tab_slice_id)
            wfslice.pending_navigate_workflow.id = wf_id
            wfslice.workflow_reload_seq.seq++
            emit_note(`✅ ${recipe.toUpperCase()} workflow built${mp_id ? ` for ${mp_id}` : ``}.`)
          } else {
            emit_note(`⚠️ ${recipe.toUpperCase()} quick-build did not return a workflow. Try again or check the backend.`)
          }
        },
        inject_structure: async () => {
          const cur = get_current_structure()
          if (!cur) { emit_note(`No structure loaded — open one in a structure viewer first.`); return }
          const wfslice = get_workflow_slice(tab_slice_id)
          wfslice.workflow_reload_seq.seq++
          emit_note(`Structure captured. Open the Workflow editor — an empty Structure Input node will be filled with it (a node that already has a structure is left unchanged).`)
        },
        set_skip_permission: (on) => { slice.skip_permission.value = on },
        get_skip_permission: () => slice.skip_permission.value,
        emit: emit_note,
      })
      if (handled) return
    }

    // Auto-detect DOI input and resolve it. Skip while a round is streaming:
    // send_message will queue this text and the DOI branch would otherwise
    // clobber slice.loading mid-stream.
    const doi_match = msg.match(/^(?:doi[:\s]*)?((10\.\d{4,}\/\S+))\s*$/i)
    if (doi_match && !slice.paper_session.session_id && !slice.loading.value) {
      try {
        slice.loading.value = true
        await import_doi(doi_match[1])
        const note: ChatMessage = {
          role: `assistant`,
          content: `**Paper found via DOI:** ${slice.paper_session.title}\n*${slice.paper_session.authors.join(`, `)}*\n\nOnly metadata and abstract are available from DOI. For full text analysis, upload the PDF. You can still ask me to suggest a workflow based on the abstract.`,
          timestamp: Date.now(),
        }
        slice.messages.list = [...slice.messages.list, note]
        slice.loading.value = false
        return
      } catch {
        slice.loading.value = false
        // If DOI resolution fails, treat as normal message
      }
    }

    const attachments = pending_attachments.length > 0 ? [...pending_attachments] : undefined
    pending_attachments = []
    // Use the resolved tab_slice_id (falls back to "default" when the prop
    // is unset — matches what every other ChatPane call site does).
    await send_message(msg, attachments, tab_slice_id)
  }

  let slash_idx = $state(0)
  let slash_dismissed = $state(false)
  const slash_filtered = $derived.by(() => {
    const s = input_text
    if (!s.startsWith(`/`) || /\s/.test(s)) return []
    const tok = s.slice(1).toLowerCase()
    return SLASH_COMMANDS
      .filter(c => c.name.startsWith(tok) || c.aliases?.some(a => a.startsWith(tok)))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  const slash_open = $derived(!slash_dismissed && slash_filtered.length > 0)
  // Clamp via $derived (not an $effect that writes slash_idx — that is the
  // self-trigger antipattern this codebase was bitten by). slash_idx is the
  // raw nav cursor; slash_sel is the safe index everything else reads.
  const slash_sel = $derived(
    slash_filtered.length === 0 ? 0 : Math.min(slash_idx, slash_filtered.length - 1)
  )
  // Reset dismissal when the user keeps typing (input changes).
  // _slash_last_input is a plain let (not $state) so reading/writing it does
  // not create reactive deps — only input_text is tracked; no infinite loop.
  let _slash_last_input = ''
  $effect(() => {
    if (input_text !== _slash_last_input) {
      _slash_last_input = input_text
      if (slash_dismissed) slash_dismissed = false
    }
  })

  function apply_slash_selection() {
    const c = slash_filtered[slash_sel]
    if (!c) return
    input_text = `/${c.name} `
    slash_idx = 0
    slash_dismissed = false
    textarea_el?.focus()
  }

  function handle_keydown(event: KeyboardEvent) {
    if (slash_open) {
      if (event.key === `ArrowDown`) {
        event.preventDefault()
        slash_idx = (slash_sel + 1) % slash_filtered.length
        return
      }
      if (event.key === `ArrowUp`) {
        event.preventDefault()
        slash_idx = (slash_sel - 1 + slash_filtered.length) % slash_filtered.length
        return
      }
      if (event.key === `Tab` || (event.key === `Enter` && !event.shiftKey)) {
        event.preventDefault()
        apply_slash_selection()
        return
      }
      if (event.key === `Escape`) {
        event.preventDefault()
        slash_dismissed = true
        return
      }
    }
    if (event.key === `Enter` && !event.shiftKey) {
      event.preventDefault()
      handle_send()
    }
  }

  function handle_panel_keydown(event: KeyboardEvent) {
    if (event.key === `Escape`) {
      if (settings_open) { settings_open = false; return }
      if (voice_recording) { stop_voice(); return }
      if (voice_chat_mode) { toggle_voice_chat(); return }
      if (slice.loading.value) { cancel_generation(); return }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === `l`) {
      event.preventDefault()
      if (slice.messages.list.length > 0) clear_chat_history(tab_slice_id)
    }
  }

  let last_user_msg = $state(``)

  function retry_last() {
    if (last_user_msg) handle_send(last_user_msg)
  }

  /** Shared PDF import logic for file-select, browser drop, and Tauri drop paths */
  async function do_pdf_import(file: File) {
    try {
      pdf_uploading = file.name
      slice.loading.value = true
      slice.error.value = ``
      await import_paper(file)
      pdf_uploading = null
      pdf_upload_success = slice.paper_session.title || file.name
      setTimeout(() => { pdf_upload_success = null }, 4000)
    } catch (err) {
      pdf_uploading = null
      slice.error.value = err instanceof Error ? err.message : `Paper import failed`
    } finally {
      slice.loading.value = false
    }
  }

  async function handle_file_select(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    await do_pdf_import(file)
    input.value = `` // reset file input
  }

  function handle_clear_paper() {
    clear_paper()
  }

  let pdf_dragover = $state(false)
  let pdf_uploading = $state<string | null>(null)
  let pdf_upload_success = $state<string | null>(null)

  function handle_pdf_dragover(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = `copy`
    pdf_dragover = true
  }

  function handle_pdf_dragleave(event: DragEvent) {
    // Only clear when actually leaving the chat panel (not entering a child)
    const current = event.currentTarget as HTMLElement
    if (!current || !current.contains(event.relatedTarget as Node)) {
      pdf_dragover = false
    }
  }

  async function handle_pdf_drop(event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    pdf_dragover = false

    const file = event.dataTransfer?.files[0]
    if (!file) return

    if (!file.name.toLowerCase().endsWith(`.pdf`)) {
      slice.error.value = `Only PDF files can be dropped into chat`
      return
    }

    await do_pdf_import(file)
  }

  function copy_message(idx: number) {
    const msg = slice.messages.list[idx]
    if (!msg) return
    const text = get_display_text(msg.content)
    copy_to_clipboard(text).then(() => {
      copied_idx = idx
      setTimeout(() => { copied_idx = null }, 1500)
    })
  }

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="chat-panel"
  class:pdf-dragover={pdf_dragover}
  onkeydown={handle_panel_keydown}
  ondragover={handle_pdf_dragover}
  ondragleave={handle_pdf_dragleave}
  ondrop={handle_pdf_drop}
>
  {#if pdf_dragover}
    <div class="pdf-drop-overlay">
      <div class="pdf-drop-label">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="12" y2="12"/><line x1="15" y1="15" x2="12" y2="12"/></svg>
        Drop PDF to import paper
      </div>
    </div>
  {/if}
  <!-- Header -->
  <div class="chat-header">
    <div class="chat-header-left">
      <Icon icon="Zap" style="width: 1.1em; height: 1.1em; vertical-align: -2px; color: var(--accent-color, #007acc)" />
      <span class="chat-header-title">CatBot</span>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="chat-status-badge" onclick={() => { settings_open = !settings_open }} title="Click to open settings">
        {PROVIDER_META[chat_config.provider]?.label ?? chat_config.provider}
        <span class="badge-model">
          {get_models(chat_config.provider, providers)?.find((m) => m.id === chat_config.model)?.label ?? (chat_config.model || `Default`)}
        </span>
      </div>
    </div>
    <div class="chat-header-actions">
      {#if !is_popout}
        <!-- Position toggle buttons -->
        <button
          type="button"
          class="chat-action-btn"
          class:active={chat_position.value === `right`}
          title="Dock right"
          onclick={() => set_chat_position(`right`)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1" y="2" width="14" height="12" rx="1.5" /><line x1="10" y1="2" x2="10" y2="14" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-action-btn"
          class:active={chat_position.value === `bottom`}
          title="Dock bottom"
          onclick={() => set_chat_position(`bottom`)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="1" y="2" width="14" height="12" rx="1.5" /><line x1="1" y1="10" x2="15" y2="10" />
          </svg>
        </button>
        <button
          type="button"
          class="chat-action-btn"
          title="Open in new window"
          onclick={() => { set_chat_position(`popout`); on_popout?.() }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3" /><path d="M10 2h4v4" /><line x1="14" y1="2" x2="8" y2="8" />
          </svg>
        </button>
        <div class="chat-header-separator"></div>
      {/if}
      {#if slice.messages.list.length > 0}
        <button
          type="button"
          class="chat-action-btn"
          title="New chat"
          onclick={() => clear_chat_history(tab_slice_id)}
        >
          <Icon icon="Reset" style="width: 1em; height: 1em" />
        </button>
      {/if}
      <button
        type="button"
        class="chat-action-btn"
        title="Settings"
        onclick={() => { settings_open = !settings_open }}
      >
        <Icon icon="Settings" style="width: 1em; height: 1em" />
      </button>
      {#if !is_popout}
        <button
          type="button"
          class="chat-action-btn"
          title="Close"
          onclick={on_close}
        >
          <Icon icon="Cross" style="width: 1em; height: 1em" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Settings drawer (collapsible) -->
  {#if settings_open}
    <section class="chat-settings">
      <!-- Provider selector grouped by type -->
      <div class="param-row">
        <span>Provider</span>
        <select
          value={chat_config.provider}
          onchange={(e) => {
            const provider = (e.target as HTMLSelectElement).value as LLMProvider
            const mode = default_mode_for(provider)
            const models = get_models(provider, providers)
            const default_model = models.length > 0 ? models[0].id : ``
            const backend_info = providers.find((p) => p.id === provider)
            update_config({
              provider,
              model: default_model,
              mode,
              base_url: backend_info?.base_url ?? ``,
            })
          }}
        >
          <optgroup label="Local (Free)">
            <option value="ollama">
              Ollama{is_available(`ollama`, providers) ? ` (recommended)` : ` (not running)`}
            </option>
          </optgroup>
          <optgroup label="SDK Agents">
            {#each [`sdk-claude`, `sdk-gemini`, `sdk-codex`] as id}
              {@const meta = PROVIDER_META[id]}
              <option value={id}>
                {meta?.label ?? id}{is_available(id, providers) ? `` : ` (not installed)`}
              </option>
            {/each}
          </optgroup>
          <optgroup label="API Providers (API Key)">
            {#each [`deepseek`, `qwen`, `kimi`, `zhipu`, `gemini`] as id}
              {@const meta = PROVIDER_META[id]}
              <option value={id}>{meta?.label ?? id}</option>
            {/each}
          </optgroup>
        </select>
      </div>

      <!-- SDK agent install guidance -->
      {#if SDK_PROVIDERS.has(chat_config.provider) && !is_available(chat_config.provider, providers)}
        {@const info = CLI_INSTALL_INFO[chat_config.provider]}
        {#if info}
          <div class="install-guidance">
            <p class="install-msg"><strong>{info.name}</strong> is not installed.</p>
            <div class="install-command">
              <code>{info.command}</code>
              <button
                type="button"
                class="copy-install-btn"
                title="Copy command"
                onclick={() => navigator.clipboard.writeText(info.command)}
              >Copy</button>
            </div>
            <p class="install-hint">
              Run this in your terminal, then restart CatGO.
              <a href={info.url} target="_blank" rel="noopener noreferrer">Learn more</a>
            </p>
          </div>
        {/if}
      {/if}

      <!-- Model selector -->
      {#if get_models(chat_config.provider, providers).length > 0}
        <div class="param-row">
          <span>Model</span>
          <select
            value={chat_config.model}
            onchange={(e) => update_config({ model: (e.target as HTMLSelectElement).value })}
          >
            {#each get_models(chat_config.provider, providers) as model}
              <option value={model.id}>{model.label}</option>
            {/each}
          </select>
        </div>
      {:else}
        <div class="param-row">
          <span>Model</span>
          <input
            type="text"
            value={chat_config.model}
            placeholder="model name"
            oninput={(e) => update_config({ model: (e.target as HTMLInputElement).value.trim() })}
          />
        </div>
      {/if}

      <!-- API Key (only for API providers) -->
      {#if !SDK_PROVIDERS.has(chat_config.provider) && chat_config.provider !== `ollama`}
        <div class="param-row">
          <span>API Key</span>
          <input
            type="password"
            value={chat_config.api_key}
            placeholder="sk-... (or use server env)"
            oninput={(e) => update_config({ api_key: (e.target as HTMLInputElement).value.trim() })}
          />
        </div>
        <div class="test-row">
          <button
            type="button"
            class="test-btn"
            disabled={test_status === `testing`}
            onclick={test_provider_connection}
          >
            {test_status === `testing` ? `Testing...` : `Test Connection`}
          </button>
          {#if test_status === `success`}
            <span class="test-result test-ok">{test_message}</span>
          {:else if test_status === `error`}
            <span class="test-result test-fail">{test_message}</span>
          {/if}
        </div>
      {/if}

      <!-- Custom base URL for universal providers -->
      {#if chat_config.mode === `universal`}
        <div class="param-row">
          <span>Base URL</span>
          <input
            type="text"
            value={chat_config.base_url}
            placeholder="https://api.example.com/v1"
            oninput={(e) => update_config({ base_url: (e.target as HTMLInputElement).value.trim() })}
          />
        </div>
      {/if}

      <!-- Temperature (not for CLI) -->
      {#if !SDK_PROVIDERS.has(chat_config.provider)}
        <div class="param-row">
          <label>
            <span class="param-label-with-help">
              Temperature
              <span class="param-help" title="Controls randomness in AI responses. Lower values (0-0.3) give more focused, deterministic answers. Higher values (0.7-1.0) give more creative, varied responses. For scientific tasks, 0.1-0.3 is recommended.">?</span>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={chat_config.temperature}
              oninput={(e) => update_config({ temperature: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <span class="temp-value">{chat_config.temperature}</span>
          </label>
        </div>
        <p class="param-desc">
          {#if chat_config.temperature <= 0.2}
            Precise mode &mdash; best for factual answers and calculations.
          {:else if chat_config.temperature <= 0.5}
            Balanced mode &mdash; good general-purpose setting.
          {:else}
            Creative mode &mdash; more varied and exploratory responses.
          {/if}
        </p>
        <div class="param-row">
          <label>
            <span class="param-label-with-help">
              Max Tokens
              <span class="param-help" title="Maximum number of tokens (words/subwords) in the AI's response. Higher values allow longer, more detailed answers but cost more. 2048 is a good default; increase to 4096+ for code generation or detailed analysis.">?</span>
            </span>
            <input
              type="range"
              min="256"
              max="8192"
              step="256"
              value={chat_config.max_tokens}
              oninput={(e) => update_config({ max_tokens: parseInt((e.target as HTMLInputElement).value) })}
            />
            <span class="temp-value">{chat_config.max_tokens}</span>
          </label>
        </div>
      {/if}

      <!-- Mode hint -->
      <p class="hint">
        {#if chat_config.provider === `ollama`}
          Free local inference &mdash; no API key needed. Install Ollama and pull a model to get started.
        {:else if chat_config.mode === `sdk`}
          SDK agent mode &mdash; tools and streaming via Agent SDK bridge.
        {:else if chat_config.mode === `universal`}
          OpenAI-compatible mode via backend
        {:else}
          Backend proxy mode (requires server with API key)
        {/if}
      </p>
    </section>
  {/if}

  <!-- Tab Bar -->
  <div class="tab-bar">
    <button type="button" class:active={active_tab === `chat`} onclick={() => active_tab = `chat`}>Chat</button>
    <button type="button" class:active={active_tab === `context`} onclick={() => active_tab = `context`}>Context</button>
    <button type="button" class:active={active_tab === `sessions`} onclick={() => active_tab = `sessions`}>Sessions</button>
  </div>

  <!-- Tab content -->
  {#if active_tab === `chat`}
    <!-- Messages area -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="chat-messages" bind:this={messages_div} onclick={handle_messages_click} onscroll={handle_messages_scroll}>
      {#if slice.messages.list.length === 0}
        <div class="chat-welcome">
          <div class="welcome-icon">
            <Icon icon="NeuralNetwork" style="width: 48px; height: 48px; opacity: 0.5" />
          </div>
          <p class="welcome-title">How can I help?</p>
          <p class="welcome-hint">Ask about your structure, visualize data, or run analysis tools.</p>
          <div class="suggestion-chips">
            {#each suggestion_chips as chip}
              <button type="button" class="chip" onclick={() => handle_send(chip)}>{chip}</button>
            {/each}
          </div>
        </div>
      {/if}
      {#each slice.messages.list as msg, idx}
        {#if !is_tool_result_msg(msg)}
          <div class="chat-msg chat-msg-{msg.role}">
            <!-- Avatar -->
            {#if msg.role === `assistant`}
              <div class="avatar avatar-ai" title="CatBot">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
            {/if}
            <div class="bubble-wrapper">
              {#if msg.role === `user`}
                <div class="bubble-sender sender-user">{chat_username.value}</div>
              {:else}
                <div class="bubble-sender sender-ai">CatBot</div>
              {/if}
              <div class="chat-bubble chat-bubble-{msg.role}">
                {#if msg.role === `assistant` && !get_display_text(msg.content) && slice.loading.value}
                  <span class="typing-indicator">
                    <span class="dot"></span>
                    <span class="dot"></span>
                    <span class="dot"></span>
                    {#if SDK_PROVIDERS.has(chat_config.provider) && elapsed_seconds > 0}
                      <span class="elapsed-label">
                        {PROVIDER_META[chat_config.provider]?.label} processing... {elapsed_seconds}s
                      </span>
                    {/if}
                  </span>
                {:else if msg.role === `assistant`}
                  {@const display_text = get_display_text(msg.content)}
                  {@const rendered_html = display_text ? markdown_to_html(display_text) : ``}
                  {@const tool_uses = get_tool_uses(msg.content)}
                  {@const tool_results = tool_uses.length > 0 ? get_tool_results_for(slice.messages.list, idx) : []}
                  {#if tool_uses.length > 0}
                    <div class="tool-badges">
                      {#each tool_uses as tool}
                        <span class="tool-badge" title={JSON.stringify(tool.input)}>
                          &#9889; {tool.name.replace(/_/g, ` `)}
                        </span>
                      {/each}
                    </div>
                  {/if}
                  {#if tool_results.length > 0}
                    {#each tool_results as tr}
                      {#if typeof tr.content === 'object' && tr.content.output_type}
                        <ToolResultRenderer result={tr.content} />
                      {/if}
                    {/each}
                  {/if}
                  {#if rendered_html.trim()}
                    <div class="md-content">
                      {@html rendered_html}{#if is_streaming(idx, slice.messages.list, slice.loading.value)}<span class="streaming-cursor"></span>{/if}
                    </div>
                  {:else if slice.loading.value && is_streaming(idx, slice.messages.list, slice.loading.value)}
                    <!-- Fallback: show typing indicator when markdown renders empty
                         (e.g. during MCP tool calls where only "Calling..." text exists) -->
                    <span class="typing-indicator">
                      <span class="dot"></span>
                      <span class="dot"></span>
                      <span class="dot"></span>
                    </span>
                  {/if}
                {:else}
                  {#if typeof msg.content === `string`}
                    {msg.content}
                  {:else}
                    {get_display_text(msg.content)}
                  {/if}
                {/if}
              </div>
              <!-- Inline PermissionCard / ToolProgressBlock for last assistant msg -->
              {#if msg.role === `assistant` && idx === slice.messages.list.length - 1}
                {#each Object.entries(slice.active_permission_blocks.entries) as [id, pb] (id)}
                  <PermissionCard
                    permissionId={id}
                    toolName={pb.toolName}
                    input={pb.input}
                    suggestions={pb.suggestions}
                    decisionReason={pb.decisionReason}
                  />
                {/each}
                <ThinkingSummary tools={slice.active_tool_blocks.entries}>
                  {#each Object.entries(slice.active_tool_blocks.entries) as [id, tb] (id)}
                    <ToolProgressBlock
                      toolId={id}
                      toolName={tb.toolName}
                      input={tb.input}
                      output={tb.output}
                      status={tb.status as 'running' | 'complete' | 'error'}
                      elapsedSeconds={tb.elapsedSeconds}
                    />
                  {/each}
                </ThinkingSummary>
              {/if}
            </div>
            <!-- Message actions (beside bubble) -->
            <div class="hover-actions">
              {#if msg.role === `assistant` && get_display_text(msg.content)}
                <button
                  type="button"
                  class="hover-btn"
                  class:speaking={speaking_idx === idx}
                  title={speaking_idx === idx ? `Stop` : `Read aloud`}
                  onclick={() => speak_message(idx)}
                >
                  {#if speaking_idx === idx}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                  {/if}
                </button>
              {/if}
              <button
                type="button"
                class="hover-btn"
                title="Quote reply"
                onclick={() => quote_message(idx)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
              </button>
              <button
                type="button"
                class="hover-btn"
                title={copied_idx === idx ? `Copied!` : `Copy`}
                onclick={() => copy_message(idx)}
              >
                {#if copied_idx === idx}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                {:else}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                {/if}
              </button>
            </div>
          </div>
        {/if}
      {/each}
      {#if slice.error.value}
        <div class="chat-msg">
          <div class="error">
            {friendly_error(slice.error.value)}
            {#if last_user_msg}
              <button type="button" class="error-retry-btn" onclick={retry_last}>Retry</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    {#if user_scrolled_up && slice.loading.value}
      <button type="button" class="jump-to-latest" onclick={scroll_to_bottom}>
        ↓ Jump to latest
      </button>
    {/if}

    <!-- Activity bar — shows current action above input when CatBot is working -->
    {#if slice.loading.value && get_display_text(slice.messages.list[slice.messages.list.length - 1]?.content ?? ``)}
      <div class="activity-bar">
        <div class="activity-bar-pulse"></div>
        <span class="activity-bar-text">
          {current_action || `Thinking`}{elapsed_seconds > 0 ? ` · ${elapsed_seconds}s` : ``}
        </span>
        <button type="button" class="activity-bar-stop" title="Stop generation" onclick={() => cancel_generation(tab_slice_id)}>
          Stop
        </button>
      </div>
    {/if}

    <!-- PDF upload status -->
    {#if pdf_uploading}
      <div class="pdf-upload-status uploading">
        <div class="pdf-upload-spinner"></div>
        <span>Uploading <strong>{pdf_uploading}</strong>...</span>
      </div>
    {/if}
    {#if pdf_upload_success}
      <div class="pdf-upload-status success">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        <span><strong>{pdf_upload_success}</strong> imported</span>
      </div>
    {/if}

    <!-- Input area -->
    <div class="chat-input-area">
      {#if slice.paper_session.session_id}
        <div class="paper-badge">
          <Icon icon="Paper" style="width: 0.9em; height: 0.9em" />
          <span class="paper-title">{slice.paper_session.title || `Paper loaded`}</span>
          <button type="button" class="paper-clear" title="Remove paper" onclick={handle_clear_paper}>
            <Icon icon="Cross" style="width: 0.7em; height: 0.7em" />
          </button>
        </div>
      {/if}
      {#if quoted_text}
        <div class="quote-preview">
          <div class="quote-bar"></div>
          <div class="quote-content">
            <span class="quote-sender">{quoted_role === `user` ? chat_username.value : `CatBot`}</span>
            <span class="quote-text">{quoted_text}</span>
          </div>
          <button type="button" class="quote-clear" title="Remove quote" onclick={clear_quote}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      {/if}
      {#if pending_attachments.length > 0}
        <div class="attachment-strip">
          {#each pending_attachments as att, i (att.name + i)}
            <div class="attachment-chip">
              <span class="attachment-icon">
                {#if att.type === `image`}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                {:else if att.type === `pdf`}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                {:else}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                {/if}
              </span>
              <span class="attachment-name">{att.name}</span>
              <button type="button" class="attachment-remove" title="Remove" onclick={() => remove_attachment(i)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if slash_open}
        <div class="slash-menu" role="listbox">
          {#each slash_filtered as c, i (c.name)}
            <button
              type="button"
              class="slash-row"
              class:sel={i === slash_sel}
              role="option"
              aria-selected={i === slash_sel}
              onmousedown={(e) => { e.preventDefault(); slash_idx = i; apply_slash_selection() }}
            >
              <span class="slash-name">/{c.name}{c.hint ? ` ${c.hint}` : ``}</span>
              <span class="slash-summary">{c.summary}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="input-wrapper" class:focused={false}>
        <button
          type="button"
          class="chat-attach-btn"
          title="Import paper (PDF)"
          onclick={() => file_input_el?.click()}
          disabled={slice.loading.value}
        >
          <Icon icon="Upload" style="width: 14px; height: 14px" />
        </button>
        <button
          type="button"
          class="chat-attach-btn"
          title="Attach file"
          onclick={() => attach_input_el?.click()}
          disabled={slice.loading.value}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <button
          type="button"
          class="chat-voice-btn"
          class:recording={voice_recording}
          title={voice_recording ? `Stop recording` : `Voice input`}
          onclick={toggle_voice}
          disabled={slice.loading.value}
        >
          {#if voice_recording}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          {/if}
        </button>
        <button
          type="button"
          class="chat-voice-chat-btn"
          class:active={voice_chat_mode}
          title={voice_chat_mode ? `Stop voice chat` : `Voice conversation mode`}
          onclick={toggle_voice_chat}
          disabled={slice.loading.value}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="8" x2="4" y2="16"/><line x1="8" y1="4" x2="8" y2="20"/><line x1="12" y1="6" x2="12" y2="18"/><line x1="16" y1="4" x2="16" y2="20"/><line x1="20" y1="8" x2="20" y2="16"/></svg>
        </button>
        <textarea
          class="chat-input"
          placeholder={voice_chat_mode ? `Voice chat active — speak to send...` : slice.paper_session.session_id ? `Ask about this paper...` : `Ask about your structure, or paste a DOI...`}
          rows="1"
          bind:value={input_text}
          bind:this={textarea_el}
          onkeydown={handle_keydown}
          oninput={auto_resize}
          onpaste={handle_attach_paste}
          onfocus={(e) => { const w = (e.target as HTMLElement).closest(`.input-wrapper`); w?.classList.add(`focused`) }}
          onblur={(e) => { const w = (e.target as HTMLElement).closest(`.input-wrapper`); w?.classList.remove(`focused`) }}
        ></textarea>
        {#if slice.loading.value}
          {#if input_text.trim()}
            <button type="button" class="chat-send-btn" title="Send after current reply" onclick={() => handle_send()}>
              <Icon icon="ArrowUp" style="width: 14px; height: 14px" />
            </button>
          {/if}
          <button type="button" class="chat-send-btn stop" title="Stop" onclick={() => cancel_generation(tab_slice_id)}>
            <Icon icon="Disabled" style="width: 14px; height: 14px" />
          </button>
        {:else}
          <button type="button" class="chat-send-btn" title="Send" onclick={() => handle_send()} disabled={!input_text.trim()}>
            <Icon icon="ArrowUp" style="width: 14px; height: 14px" />
          </button>
        {/if}
      </div>
      <input
        type="file"
        accept=".pdf"
        bind:this={file_input_el}
        onchange={handle_file_select}
        style="display: none"
      />
      <input
        type="file"
        accept="image/*,.pdf,.txt,.json,.csv,.py,.js,.ts"
        multiple
        bind:this={attach_input_el}
        onchange={handle_attach_input}
        style="display: none"
      />
      <div class="input-hint-row">
        {#if slice.skip_permission.value}
          <span class="input-hint skip-warn">⚠️ skip-permission ON — tools run without asking</span>
        {:else if slice.pending_send?.value}
          <span class="input-hint queued">⏳ Queued — sends when the current reply finishes</span>
        {:else if slice.loading.value}
          <span class="input-hint">Enter to queue · sends after the current reply · Esc stops</span>
        {:else}
          <span class="input-hint">Enter send · Shift+Enter newline · Esc cancel</span>
        {/if}
        <select
          class="voice-lang-select"
          bind:value={voice_language}
          title="Voice language"
        >
          {#each VOICE_LANGUAGES as lang}
            <option value={lang.code}>{lang.label}</option>
          {/each}
        </select>
      </div>
    </div>

  {:else if active_tab === `context`}
    <div class="context-tab">
      {#if slice.paper_context.value}
        <div class="context-divider">Paper Context</div>
        <pre class="context-pre">{slice.paper_context.value.slice(0, 2000)}{slice.paper_context.value.length > 2000 ? `\n... (${slice.paper_context.value.length} chars total)` : ``}</pre>
      {/if}
      {#if slice.structure_context.value}
        <pre class="context-pre">{slice.structure_context.value}</pre>
      {:else if !slice.paper_context.value}
        <div class="context-empty">
          <p>No structure or paper loaded.</p>
          <p class="hint">Load a structure or import a paper to see context information sent to the AI.</p>
        </div>
      {/if}
      {#if slice.workflow_context.value}
        <div class="context-divider">Workflow Context</div>
        <pre class="context-pre">{slice.workflow_context.value}</pre>
      {/if}
    </div>

  {:else if active_tab === `sessions`}
    <div class="sessions-tab">
      <div class="sessions-header">
        <button type="button" class="new-session-btn" onclick={handle_new_session}>
          <Icon icon="Plus" style="width: 0.9em; height: 0.9em" />
          New Session
        </button>
      </div>

      {#if all_sessions.length === 0}
        <div class="context-empty">
          <p>{sessions_loading ? `Loading...` : `No sessions yet.`}</p>
        </div>
      {:else}
        <div class="session-list">
          {#each all_sessions as s (s.session_id)}
            <div class="session-card-wrapper">
              <button
                type="button"
                class="session-card"
                class:active={is_active_session(s)}
                onclick={() => handle_resume_session(s)}
              >
                <div class="session-card-header">
                  <span class="session-agent-badge">{AGENT_LABELS[s.agent] ?? s.agent}</span>
                  {#if is_active_session(s)}
                    <span class="session-active-dot" title="Current session"></span>
                  {/if}
                  <span class="session-time">{format_time_ago(s.last_active)}</span>
                </div>
                <div class="session-topic">{s.topic || `New session`}</div>
                <div class="session-meta">
                  {#if s.model}
                    <span class="session-model">{s.model}</span>
                  {/if}
                  <span class="session-msg-count">{s.message_count} messages</span>
                </div>
              </button>
              <button
                type="button"
                class="session-delete-btn"
                title="Delete session"
                onclick={(e) => { e.stopPropagation(); handle_delete_session(s) }}
              >
                <Icon icon="Cross" style="width: 0.75em; height: 0.75em" />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chat-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
    background: var(--pane-bg, light-dark(rgb(229, 231, 235), rgb(28, 29, 33)));
    border-left: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    font-size: 14px;
  }

  .pdf-upload-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    margin: 0 8px;
    border-radius: 8px;
    font-size: 13px;
    animation: pdf-status-slide-in 0.2s ease-out;
  }

  .pdf-upload-status.uploading {
    background: color-mix(in srgb, var(--accent-color, #007acc) 12%, transparent);
    color: var(--accent-color, #007acc);
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 25%, transparent);
  }

  .pdf-upload-status.success {
    background: color-mix(in srgb, #22c55e 12%, transparent);
    color: #22c55e;
    border: 1px solid color-mix(in srgb, #22c55e 25%, transparent);
  }

  .pdf-upload-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--accent-color, #007acc) 30%, transparent);
    border-top-color: var(--accent-color, #007acc);
    border-radius: 50%;
    animation: pdf-spin 0.8s linear infinite;
  }

  @keyframes pdf-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes pdf-status-slide-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .chat-panel.pdf-dragover {
    outline: 2px dashed var(--accent-color, #007acc);
    outline-offset: -2px;
  }

  .pdf-drop-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: light-dark(rgba(0, 122, 204, 0.08), rgba(0, 122, 204, 0.15));
    pointer-events: none;
  }

  .pdf-drop-label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-radius: 8px;
    background: light-dark(rgba(255, 255, 255, 0.9), rgba(40, 42, 48, 0.95));
    color: var(--accent-color, #007acc);
    font-weight: 600;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  /* Header */
  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
  }
  .chat-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chat-header-title {
    font-weight: 700;
    font-size: 1.05em;
  }
  .chat-version-badge {
    font-size: 0.7em;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    color: var(--text-color-muted, #6b7280);
  }
  .chat-header-actions {
    display: flex;
    gap: 2px;
  }
  .chat-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    opacity: 0.6;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    color: inherit;
  }
  .chat-action-btn:hover {
    opacity: 1;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .chat-action-btn.active {
    opacity: 1;
    color: var(--accent-color, cornflowerblue);
  }
  .chat-header-separator {
    width: 1px;
    height: 16px;
    background: var(--pane-card-border, rgba(0, 0, 0, 0.08));
    margin: 6px 2px;
    flex-shrink: 0;
  }

  /* Settings */
  .chat-settings {
    padding: 8px 12px;
    border-bottom: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
  }
  .chat-settings .param-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .chat-settings .param-row span {
    font-size: 0.85em;
    min-width: 60px;
    color: var(--text-color-muted, #6b7280);
  }
  .chat-settings select,
  .chat-settings input[type="password"],
  .chat-settings input[type="text"] {
    flex: 1;
    min-width: 0;
    font-size: 0.85em;
    padding: 4px 6px;
    border-radius: 4px;
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    color: inherit;
  }
  .temp-value {
    min-width: 2em;
    text-align: center;
    font-size: 0.85em;
    opacity: 0.7;
  }
  .test-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
  }
  .test-btn {
    padding: 3px 10px;
    font-size: 0.78em;
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .test-btn:hover:not(:disabled) {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .test-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .test-result {
    font-size: 0.78em;
  }
  .test-ok {
    color: #16a34a;
  }
  .test-fail {
    color: #dc2626;
  }
  .install-guidance {
    margin-top: 6px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--accent-color, #007acc) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 20%, transparent);
    border-radius: 6px;
  }
  .install-msg {
    margin: 0 0 6px;
    font-size: 0.85em;
  }
  .install-command {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
  }
  .install-command code {
    flex: 1;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.82em;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 4px;
    user-select: all;
  }
  .copy-install-btn {
    padding: 3px 8px;
    font-size: 0.78em;
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .copy-install-btn:hover {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .install-hint {
    margin: 4px 0 0;
    font-size: 0.78em;
    color: var(--text-color-muted, #6b7280);
  }
  .install-hint a {
    color: var(--accent-color, #007acc);
  }
  .param-label-with-help {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .param-help {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    font-size: 0.7em;
    font-weight: 600;
    cursor: help;
    color: var(--text-color-muted, #6b7280);
  }
  .param-help:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
    color: var(--accent-color, #007acc);
  }
  .param-desc {
    font-size: 0.75em;
    color: var(--text-color-muted, #6b7280);
    margin: 2px 0 4px;
    font-style: italic;
  }
  .hint {
    font-size: 0.8em;
    color: var(--text-color-muted, #6b7280);
    margin: 4px 0 0;
  }

  /* Tab bar */
  .tab-bar {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 3px;
    padding: 3px;
    margin: 8px 12px;
    background: var(--pane-tabs-bg, rgba(0, 0, 0, 0.06));
    border-radius: 8px;
    flex-shrink: 0;
  }
  .tab-bar button {
    padding: 5px 4px;
    border: none;
    background: transparent;
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8em;
    transition: background 0.15s;
  }
  .tab-bar button:hover {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
  .tab-bar button.active {
    background: var(--accent-color, #007acc);
    color: white;
  }

  /* Messages area */
  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  /* Welcome state */
  .chat-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    padding: 2em 1em;
    gap: 8px;
  }
  .welcome-icon {
    margin-bottom: 4px;
    opacity: 0.4;
  }
  .welcome-title {
    font-size: 1.15em;
    font-weight: 600;
    margin: 0;
  }
  .welcome-hint {
    font-size: 0.85em;
    color: var(--text-color-muted, #6b7280);
    margin: 0 0 8px;
  }
  .suggestion-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
    max-width: 320px;
  }
  .chip {
    font-size: 0.8em;
    padding: 5px 10px;
    border-radius: 16px;
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.03));
    color: inherit;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .chip:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #007acc) 30%, transparent);
  }

  /* Message row */
  .chat-msg {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .chat-msg-user {
    flex-direction: row-reverse;
  }

  /* Avatars */
  .avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.75em;
    font-weight: 600;
    margin-top: 2px;
  }
  .avatar-ai {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    color: var(--text-color-muted, #6b7280);
  }
  /* Sender label above bubble */
  .bubble-sender {
    font-size: 0.65em;
    font-weight: 600;
    margin-bottom: 1px;
    opacity: 0.6;
  }
  .sender-user {
    text-align: right;
    color: var(--accent-color, #007acc);
  }
  .sender-ai {
    text-align: left;
    color: var(--text-color-muted, #6b7280);
  }

  /* Bubble wrapper for hover actions */
  .bubble-wrapper {
    position: relative;
    max-width: calc(100% - 40px);
    min-width: 0;
  }
  /* Hover actions (beside bubble in message row) */
  .hover-actions {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .chat-msg:hover > .hover-actions {
    opacity: 1;
  }
  .hover-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    border-radius: 4px;
    background: var(--pane-bg, light-dark(rgb(229, 231, 235), rgb(28, 29, 33)));
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  .hover-btn:hover {
    opacity: 1;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }

  /* Chat bubbles */
  .chat-bubble {
    padding: 6px 8px;
    border-radius: 10px;
    font-size: 0.88em;
    line-height: 1.4;
    word-break: break-word;
  }
  .chat-bubble-user {
    background: var(--accent-color, #007acc);
    color: white;
    border-bottom-right-radius: 4px;
    white-space: pre-wrap;
  }
  .chat-bubble-assistant {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    border-bottom-left-radius: 4px;
  }

  /* Tool call badges */
  .tool-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .tool-badge {
    display: inline-block;
    font-size: 0.78em;
    padding: 1px 7px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
    color: var(--accent-color, #007acc);
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 25%, transparent);
    white-space: nowrap;
  }

  /* Markdown content styling */
  .chat-bubble :global(.md-content p) {
    margin: 0.4em 0;
  }
  .chat-bubble :global(.md-content p:first-child) {
    margin-top: 0;
  }
  .chat-bubble :global(.md-content p:last-child) {
    margin-bottom: 0;
  }
  .chat-bubble :global(.md-content hr) {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    margin: 0.5em 0;
  }
  .chat-bubble :global(.md-content .insight-header) {
    font-size: 0.82em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-color, #007acc);
    border-bottom: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 25%, transparent);
    padding-bottom: 3px;
    margin: 0.6em 0 0.4em;
  }
  .chat-bubble :global(.md-content code) {
    background: rgba(0, 0, 0, 0.08);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  .chat-bubble :global(.md-content .code-block-wrapper) {
    position: relative;
    margin: 0.5em 0;
  }
  .chat-bubble :global(.md-content .code-block-wrapper .code-lang) {
    position: absolute;
    top: 4px;
    left: 8px;
    font-size: 0.75em;
    opacity: 0.5;
    font-family: monospace;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .chat-bubble :global(.md-content .code-block-wrapper .copy-code-btn) {
    position: absolute;
    top: 2px;
    right: 2px;
    z-index: 10;
    display: none;
    font-size: 0.72em;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(30, 30, 30, 0.85);
    color: #bbb;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s, background 0.15s;
    pointer-events: auto;
  }
  .chat-bubble :global(.md-content .code-block-wrapper:hover .copy-code-btn) {
    display: block;
    opacity: 0.9;
  }
  .chat-bubble :global(.md-content .code-block-wrapper .copy-code-btn:hover) {
    opacity: 1;
    background: rgba(80, 80, 80, 0.95);
    color: #fff;
  }
  .chat-bubble :global(.md-content pre) {
    background: rgba(0, 0, 0, 0.06);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 6px;
    padding: 8px 10px;
    overflow-x: auto;
    margin: 0;
    font-size: 0.88em;
    line-height: 1.4;
  }
  .chat-bubble :global(.md-content pre code) {
    background: none;
    padding: 0;
    font-size: inherit;
  }
  .chat-bubble :global(.md-content pre.dag-diagram) {
    font-family: 'Sarasa Mono SC', 'Noto Sans Mono CJK SC', 'Source Han Mono SC',
                 'Sarasa Mono TC', 'Noto Sans Mono CJK TC', 'Source Han Mono TC',
                 'SF Mono', 'Fira Code', 'Cascadia Code', 'Menlo', 'Consolas', monospace;
    white-space: pre;
    line-height: 1.4;
    font-feature-settings: 'calt' 0, 'liga' 0;
    letter-spacing: 0;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    tab-size: 4;
  }
  .chat-bubble :global(.md-content ul),
  .chat-bubble :global(.md-content ol) {
    margin: 0.3em 0;
    padding-left: 1.2em;
  }
  .chat-bubble :global(.md-content li) {
    margin: 0.1em 0;
  }
  .chat-bubble :global(.md-content a) {
    color: var(--accent-color, #007acc);
    text-decoration: underline;
  }
  .chat-bubble :global(.md-content strong) {
    font-weight: 600;
  }
  .chat-bubble :global(.md-content h3),
  .chat-bubble :global(.md-content h4),
  .chat-bubble :global(.md-content h5),
  .chat-bubble :global(.md-content h6) {
    margin: 0.5em 0 0.3em;
    font-weight: 600;
    font-size: 0.95em;
  }

  /* Streaming cursor */
  .streaming-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: currentColor;
    margin-left: 1px;
    vertical-align: text-bottom;
    animation: cursor-blink 0.8s step-end infinite;
  }
  @keyframes cursor-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Typing indicator (bouncing dots) */
  .typing-indicator {
    display: flex;
    gap: 4px;
    padding: 4px 0;
    align-items: center;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-color-muted, #6b7280);
    animation: dot-bounce 1.4s ease-in-out infinite;
  }
  .dot:nth-child(2) {
    animation-delay: 0.16s;
  }
  .dot:nth-child(3) {
    animation-delay: 0.32s;
  }
  @keyframes dot-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-4px); opacity: 1; }
  }

  /* Activity bar — fixed above input, always visible when CatBot is working */
  .activity-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-top: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 20%, transparent);
    background: color-mix(in srgb, var(--accent-color, #007acc) 6%, transparent);
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
  }
  .activity-bar-pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-color, #007acc);
    animation: activity-pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes activity-pulse {
    0%, 100% { opacity: 0.4; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  .activity-bar-text {
    font-size: 0.78em;
    color: var(--accent-color, #007acc);
    font-weight: 500;
    flex: 1;
  }
  .activity-bar-stop {
    font-size: 0.72em;
    padding: 2px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 30%, transparent);
    background: transparent;
    color: var(--accent-color, #007acc);
    cursor: pointer;
    font-weight: 500;
    flex-shrink: 0;
  }
  .activity-bar-stop:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 12%, transparent);
  }

  /* Error */
  .error {
    color: #ef4444;
    font-size: 0.85em;
    padding: 6px 10px;
    background: color-mix(in srgb, #ef4444 8%, transparent);
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, #ef4444 20%, transparent);
  }

  /* Input area */
  .chat-input-area {
    padding: 6px 8px 8px;
    border-top: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
  }
  .input-wrapper {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    border: 1px solid var(--pane-input-border, rgba(0, 0, 0, 0.1));
    border-radius: 12px;
    padding: 4px 4px 4px 4px;
    background: var(--pane-input-bg, rgba(0, 0, 0, 0.03));
    transition: border-color 0.15s;
  }
  .input-wrapper.focused {
    border-color: var(--accent-color, #007acc);
  }
  .chat-input {
    flex: 1;
    resize: none;
    border: none;
    padding: 4px 0;
    font-size: 0.9em;
    font-family: inherit;
    background: transparent;
    color: inherit;
    min-height: 1.6em;
    max-height: 7.5em;
    overflow-y: auto;
    outline: none;
  }
  .chat-send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 50%;
    flex-shrink: 0;
    border: none;
    background: var(--accent-color, #007acc);
    color: white;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .chat-send-btn.stop {
    background: #ef4444;
  }
  .chat-send-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .chat-send-btn:not(:disabled):hover {
    opacity: 0.85;
  }
  .input-hint {
    font-size: 0.72em;
    color: var(--text-color-muted, #6b7280);
  }
  .input-hint.skip-warn {
    color: var(--error-color);
    font-weight: 600;
  }
  /* Paper attachment badge */
  .paper-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
    background: color-mix(in srgb, var(--accent-color, #007acc) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 25%, transparent);
    border-radius: 8px;
    font-size: 0.78em;
    color: var(--accent-color, #007acc);
  }
  .paper-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }
  .paper-clear {
    display: flex;
    align-items: center;
    padding: 2px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    border-radius: 4px;
  }
  .paper-clear:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  .chat-attach-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.5;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .chat-attach-btn:hover:not(:disabled) {
    opacity: 0.8;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .chat-attach-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  /* Voice input button */
  .chat-voice-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.5;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .chat-voice-btn:hover:not(:disabled) {
    opacity: 0.8;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .chat-voice-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .chat-voice-btn.recording {
    color: #ef4444;
    opacity: 1;
    animation: pulse-record 1.5s ease-in-out infinite;
  }
  @keyframes pulse-record {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Voice chat mode toggle button */
  .chat-voice-chat-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.5;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .chat-voice-chat-btn:hover:not(:disabled) {
    opacity: 0.8;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
  }
  .chat-voice-chat-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .chat-voice-chat-btn.active {
    color: var(--accent, #22d3ee);
    opacity: 1;
    background: color-mix(in srgb, var(--accent, #22d3ee) 12%, transparent);
  }

  /* TTS speaking state on hover button */
  .hover-btn.speaking {
    color: var(--accent, #22d3ee);
    opacity: 1;
  }

  /* Input hint row with language selector */
  .input-hint-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    padding: 0 2px;
  }
  .voice-lang-select {
    font-size: 0.72em;
    color: var(--text-color-muted, #6b7280);
    background: none;
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    border-radius: 4px;
    padding: 1px 4px;
    cursor: pointer;
    outline: none;
  }
  .voice-lang-select:hover {
    border-color: var(--accent, #22d3ee);
  }

  /* Quote preview above input */
  .quote-preview {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 6px 10px;
    margin-bottom: 4px;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.03));
    border-radius: 8px;
    font-size: 0.82em;
    max-height: 60px;
    overflow: hidden;
  }
  .quote-bar {
    width: 3px;
    flex-shrink: 0;
    border-radius: 2px;
    background: var(--accent, #22d3ee);
  }
  .quote-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .quote-sender {
    font-weight: 600;
    font-size: 0.9em;
    opacity: 0.7;
  }
  .quote-text {
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .quote-clear {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0.5;
    padding: 2px;
    display: flex;
    align-items: center;
    color: inherit;
  }
  .quote-clear:hover {
    opacity: 1;
  }

  /* Context tab */
  .context-tab {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    min-height: 0;
  }
  .context-pre {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.82em;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: 10px;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    border-radius: 8px;
    color: inherit;
  }
  .context-divider {
    font-size: 0.78em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-color-muted, #6b7280);
    margin: 12px 0 6px;
    padding: 0 2px;
  }
  .context-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 100%;
    opacity: 0.5;
    text-align: center;
    padding: 2em;
  }
  .context-empty p {
    margin: 0.3em 0;
  }

  /* Sessions tab */
  .sessions-tab {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sessions-header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
    flex-shrink: 0;
  }
  .new-session-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--accent-color, #007acc) 30%, transparent);
    background: color-mix(in srgb, var(--accent-color, #007acc) 8%, transparent);
    color: var(--accent-color, #007acc);
    font-size: 0.82em;
    cursor: pointer;
  }
  .new-session-btn:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  .session-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    overflow-y: auto;
  }
  .session-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.02));
    cursor: pointer;
    text-align: left;
    width: 100%;
    font: inherit;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
  }
  .session-card:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 5%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #007acc) 30%, transparent);
  }
  .session-card.active {
    border-color: var(--accent-color, #007acc);
    background: color-mix(in srgb, var(--accent-color, #007acc) 6%, transparent);
  }
  .session-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75em;
  }
  .session-agent-badge {
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent-color, #007acc) 12%, transparent);
    color: var(--accent-color, #007acc);
  }
  .session-active-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
  }
  .session-time {
    margin-left: auto;
    color: var(--text-color-muted, #6b7280);
    font-size: 0.9em;
  }
  .session-topic {
    font-size: 0.88em;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-meta {
    display: flex;
    gap: 8px;
    font-size: 0.72em;
    color: var(--text-color-muted, #6b7280);
  }
  .session-model {
    opacity: 0.7;
  }
  .session-card-wrapper {
    position: relative;
  }
  .session-delete-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
  }
  .session-card-wrapper:hover .session-delete-btn {
    opacity: 1;
  }
  .session-delete-btn:hover {
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
  }

  /* Status badge in header */
  .chat-status-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72em;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    color: var(--text-color-muted, #6b7280);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .chat-status-badge:hover {
    background: rgba(0, 0, 0, 0.1);
  }
  .badge-model {
    opacity: 0.7;
  }
  .badge-model::before {
    content: '·';
    margin: 0 2px;
  }

  /* CLI elapsed timer label */
  .elapsed-label {
    font-size: 0.78em;
    opacity: 0.6;
    margin-left: 8px;
    font-style: italic;
  }

  /* Jump to latest button */
  .jump-to-latest {
    position: absolute;
    bottom: 120px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: 16px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    background: var(--pane-bg, light-dark(rgb(229, 231, 235), rgb(28, 29, 33)));
    font-size: 0.78em;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    z-index: 10;
    color: inherit;
    transition: background 0.15s;
  }
  .jump-to-latest:hover {
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.08));
  }

  /* Code expand/collapse button */
  .chat-bubble :global(.md-content .code-expand-btn) {
    display: block;
    width: 100%;
    padding: 4px;
    border: none;
    background: rgba(0, 0, 0, 0.04);
    color: var(--accent-color, #007acc);
    font-size: 0.78em;
    cursor: pointer;
    border-radius: 0 0 6px 6px;
  }
  .chat-bubble :global(.md-content .code-expand-btn:hover) {
    background: rgba(0, 0, 0, 0.08);
  }

  /* Blockquote styling */
  .chat-bubble :global(.md-content blockquote) {
    border-left: 3px solid var(--accent-color, #22d3ee);
    margin: 0.5em 0;
    padding: 4px 12px;
    opacity: 0.85;
    font-style: italic;
  }

  /* Table styling */
  .chat-bubble :global(.md-content table) {
    border-collapse: collapse;
    margin: 0.3em 0;
    font-size: 0.82em;
    width: 100%;
  }
  .chat-bubble :global(.md-content th),
  .chat-bubble :global(.md-content td) {
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 2px 5px;
    text-align: left;
  }
  .chat-bubble :global(.md-content th) {
    background: rgba(255, 255, 255, 0.05);
    font-weight: 600;
  }

  /* Syntax highlighting tokens */
  .chat-bubble :global(.md-content pre code .hljs-keyword) { color: #c678dd; }
  .chat-bubble :global(.md-content pre code .hljs-string) { color: #98c379; }
  .chat-bubble :global(.md-content pre code .hljs-number) { color: #d19a66; }
  .chat-bubble :global(.md-content pre code .hljs-comment) { color: #7f848e; font-style: italic; }
  .chat-bubble :global(.md-content pre code .hljs-function) { color: #61afef; }
  .chat-bubble :global(.md-content pre code .hljs-title) { color: #61afef; }
  .chat-bubble :global(.md-content pre code .hljs-built_in) { color: #e5c07b; }
  .chat-bubble :global(.md-content pre code .hljs-type) { color: #e5c07b; }
  .chat-bubble :global(.md-content pre code .hljs-attr) { color: #d19a66; }
  .chat-bubble :global(.md-content pre code .hljs-variable) { color: #e06c75; }
  .chat-bubble :global(.md-content pre code .hljs-params) { color: #abb2bf; }
  .chat-bubble :global(.md-content pre code .hljs-meta) { color: #61afef; }
  .chat-bubble :global(.md-content pre code .hljs-literal) { color: #56b6c2; }

  /* Error retry button */
  .error-retry-btn {
    margin-left: 8px;
    padding: 2px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
    background: color-mix(in srgb, #ef4444 12%, transparent);
    color: #ef4444;
    font-size: 0.9em;
    cursor: pointer;
  }
  .error-retry-btn:hover {
    background: color-mix(in srgb, #ef4444 20%, transparent);
  }

  /* Attachment preview strip */
  .attachment-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 4px;
  }
  .attachment-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
    border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
    font-size: 0.78em;
    max-width: 180px;
  }
  .attachment-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    opacity: 0.6;
  }
  .attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .attachment-remove {
    display: flex;
    align-items: center;
    padding: 1px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.5;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .attachment-remove:hover {
    opacity: 1;
    background: color-mix(in srgb, #ef4444 15%, transparent);
    color: #ef4444;
  }
  .slash-menu {
    display: flex;
    flex-direction: column;
    max-height: 240px;
    overflow-y: auto;
    margin: 0 0 4px 0;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--surface-bg, var(--pane-card-bg));
  }
  .slash-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 5px 9px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .slash-row:last-child { border-bottom: none; }
  .slash-row.sel,
  .slash-row:hover {
    background: color-mix(in srgb, var(--accent-color) 16%, transparent);
  }
  .slash-name {
    font-family: monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-color);
  }
  .slash-summary {
    font-size: 11px;
    color: var(--text-color-muted);
  }
</style>
