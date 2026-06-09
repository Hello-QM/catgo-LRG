import { untrack } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import type { ChatConfig, ChatMessage, ContentBlock, SessionSummary } from './types'
import { agent_from_provider, get_display_text, SDK_PROVIDERS } from './types'
import { build_sdk_system_prompt, stream_chat } from './llm-client'
import { stream_sdk_agent } from './sdk-stream'
import { is_client_direct } from './provider-routing'
import { stream_client_llm } from './client-llm'
import { run_tool_loop } from './tool-loop'
import { CLIENT_TOOLS, execute_tool, tool_kind } from './structure-tools'
import { retrieve } from './rag'
import {
  clear_workflow_events,
  get_workflow_slice,
} from '$lib/workflow/workflow-state.svelte'
import { build_paper_context, build_paper_context_from_doi } from './context'
import { API_BASE } from '$lib/api/config'
import { isMobile } from '$lib/api/transport'

const STORAGE_KEY_CONFIG = `catgo-chat-config`
const STORAGE_KEY_USERNAME = `catgo-chat-username`
const STORAGE_KEY_CHAT_POSITION = `catgo-chat-position`
const CHAT_CONTEXT_CHANNEL = `catgo-chat-context`

// Playful material-science / catalyst themed usernames
const USERNAME_POOL = [
  `CatGo-Researcher`,
  `Lattice-Voyager`,
  `Bond-Breaker`,
  `Crystal-Whisperer`,
  `Phonon-Rider`,
  `Defect-Hunter`,
  `Slab-Surfer`,
  `Orbital-Architect`,
  `Spacegroup-Scout`,
  `Adsorption-Alchemist`,
]

const DEFAULT_CONFIG: ChatConfig = {
  provider: `sdk-claude`,
  model: ``,
  temperature: 0.3,
  max_tokens: 4096,
  api_key: ``,
  base_url: ``,
  api_format: `auto`,
  fetched_models: {},
  mode: `sdk`,
}

function load_from_storage<T>(key: string, fallback: T): T {
  try {
    if (typeof window === `undefined` || typeof localStorage === `undefined`) {
      return fallback
    }
    const stored = localStorage.getItem(key)
    if (!stored) return fallback
    return JSON.parse(stored) as T
  } catch (err) {
    console.warn(
      `[CatGo] Failed to load ${key} from localStorage, using default:`,
      err,
    )
    return fallback
  }
}

function save_to_storage(key: string, value: unknown): void {
  try {
    if (typeof window === `undefined` || typeof localStorage === `undefined`) {
      return
    }
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.warn(`[CatGo] Failed to save ${key} to localStorage:`, err)
  }
}

// ─── Genuinely global state (stays singleton) ───
//
// These don't benefit from per-tab keying:
//   - chat_config: user-level API keys / model selection
//   - chat_username: cosmetic display name, shared across the app
//   - session_list: backend-authoritative (deduped across tabs anyway)
//   - chat_position: UI layout preference (right/bottom/popout)
//   - agent_sessions: resume state per agent; mapping a specific session
//     id into "this tab" is C4+ work — today each new chat clears it
//     anyway, so sharing doesn't actively leak conversations.

export const chat_config = $state<ChatConfig>(
  load_from_storage(STORAGE_KEY_CONFIG, DEFAULT_CONFIG),
)

function init_username(): string {
  const stored = load_from_storage<string>(STORAGE_KEY_USERNAME, ``)
  if (stored) return stored
  const name = USERNAME_POOL[Math.floor(Math.random() * USERNAME_POOL.length)]
  save_to_storage(STORAGE_KEY_USERNAME, name)
  return name
}

export const chat_username = $state<{ value: string }>({
  value: init_username(),
})

function persist_config(): void {
  // SECURITY (§5/§8 H): never write the API key to localStorage on mobile. The
  // key lives only in the native encrypted store + an in-memory $state; redact
  // it here so any update_config caller can't accidentally serialize it cleartext.
  if (isMobile()) {
    save_to_storage(STORAGE_KEY_CONFIG, { ...chat_config, api_key: `` })
    return
  }
  save_to_storage(STORAGE_KEY_CONFIG, chat_config)
}

export function update_config(updates: Partial<ChatConfig>): void {
  Object.assign(chat_config, updates)
  persist_config()
}

/** Set the LLM API key in memory ONLY — never persisted (§5/§8 H).
 *
 * Direct assignment, deliberately NOT via update_config: update_config →
 * persist_config writes chat_config to localStorage on every call, so routing
 * the key through it would risk serializing it cleartext. (persist_config does
 * redact api_key on mobile as belt-and-suspenders, but the key must never
 * depend on that.) The key lives in a local $state in MobileChat/MobileChatSetup
 * and is pushed here right before each send so stream_client_llm can read it
 * off chat_config.api_key. */
export function set_session_api_key(key: string): void {
  chat_config.api_key = key
}

// ─── Chat position (right / bottom / popout) — global UI preference ───

export type ChatPosition = `right` | `bottom` | `popout`

export const chat_position = $state<{ value: ChatPosition }>({
  value: load_from_storage<ChatPosition>(STORAGE_KEY_CHAT_POSITION, `right`),
})

export function set_chat_position(pos: ChatPosition): void {
  chat_position.value = pos
  save_to_storage(STORAGE_KEY_CHAT_POSITION, pos)
}

// Start fresh — no active agent session on app launch. Users can resume via Sessions tab.
export const agent_sessions = $state<Record<string, string>>({})

export function set_agent_session(agent: string, session_id: string): void {
  agent_sessions[agent] = session_id
}

export function clear_agent_session(agent?: string): void {
  if (agent) {
    delete agent_sessions[agent]
  } else {
    for (const key of Object.keys(agent_sessions)) delete agent_sessions[key]
  }
}

// ─── Per-tab state (ChatSlice) ───
//
// Each tab holds its own chat thread, tool-call progress, permission
// prompts, context strings, and in-flight abort controller. Before this
// refactor these were module-level singletons — writes in tab A's chat
// appeared in tab B's UI instantly.

export interface ToolEntry {
  toolName: string
  input: unknown
  output: string
  status: string
  elapsedSeconds: number
}

export interface PermissionEntry {
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
  status: string
  // Client-direct path only: the tool-loop awaits this to learn the user's
  // decision. The SDK path resolves permissions via a backend round-trip
  // (sdk-stream.resolve_permission) and leaves this undefined.
  resolve?: (ok: boolean) => void
}

export interface PaperSession {
  session_id: string
  title: string
  authors: string[]
  doi: string
  page_count: number
}

export interface ChatSlice {
  messages: { list: ChatMessage[] }
  loading: { value: boolean }
  error: { value: string }
  active_tool_blocks: { entries: Record<string, ToolEntry> }
  active_permission_blocks: { entries: Record<string, PermissionEntry> }
  structure_context: { value: string }
  workflow_context: { value: string }
  paper_context: { value: string }
  paper_session: PaperSession
  // A message the user composed while a response was still streaming. It is
  // sent automatically the moment the in-flight round finishes (drained in
  // send_message's finally), so the input box never has to be locked.
  pending_send: {
    value:
      | { content: string; attachments?: import('./types').Attachment[] }
      | null
  }
  // Session-scoped tool-approval bypass (NOT persisted — a fresh session
  // always re-gates). Read at send time, threaded into the Claude adapter.
  skip_permission: { value: boolean }
  // Plain (non-$state) field — abort_controller is a DOM class we cancel
  // via a method call; wrapping it in a $state proxy adds nothing.
  abort_controller: AbortController | null
}

function make_chat_slice(): ChatSlice {
  // Svelte 5 requires each `$state(...)` call to be a variable-declaration
  // initializer (or class field) — not an object-literal property value.
  // So we bind each reactive container to its own `const` first and then
  // assemble the slice object. Each binding is still a deep reactive
  // proxy, and returning it from this factory preserves proxy identity,
  // so downstream `slice.messages.list = ...` writes notify subscribers.
  const messages = $state({ list: [] as ChatMessage[] })
  const loading = $state({ value: false })
  const error = $state({ value: `` })
  const active_tool_blocks = $state({
    entries: {} as Record<string, ToolEntry>,
  })
  const active_permission_blocks = $state({
    entries: {} as Record<string, PermissionEntry>,
  })
  const structure_context = $state({ value: `` })
  const workflow_context = $state({ value: `` })
  const paper_context = $state({ value: `` })
  const paper_session: PaperSession = $state({
    session_id: ``,
    title: ``,
    authors: [],
    doi: ``,
    page_count: 0,
  })
  const pending_send = $state({
    value: null as
      | { content: string; attachments?: import('./types').Attachment[] }
      | null,
  })
  const skip_permission = $state({ value: false })
  return {
    messages,
    loading,
    error,
    active_tool_blocks,
    active_permission_blocks,
    structure_context,
    workflow_context,
    paper_context,
    paper_session,
    pending_send,
    skip_permission,
    abort_controller: null,
  }
}

const chat_slices = new SvelteMap<string, ChatSlice>()

// Pre-register the "default" slice at module load so legacy callers
// (popout chat, standalone page, preview cards) that read the slice
// inside a $derived don't trigger a SvelteMap mutation when no slice
// exists — Svelte 5 forbids $state writes inside $derived.
chat_slices.set(`default`, make_chat_slice())

/**
 * Get the slice for a tab, eagerly creating one on first access.
 *
 * Callers inside `$derived(...)` (e.g. ChatPane's `const slice =
 * $derived(get_chat_slice(tab_slice_id))`) cannot safely mutate reactive
 * state. Mutations during derivation throw `state_unsafe_mutation` in
 * Svelte 5. To keep the lazy-creation path safe for those callers, the
 * SvelteMap.set is wrapped in `untrack` — the map write still happens,
 * but the current derivation/effect does not become a subscriber to
 * this write. In the normal flow, tab-manager.create_tab eagerly calls
 * `ensure_chat_slice(id)` when a tab is opened, so the lazy path is a
 * safety net for edge cases (popout windows, hash-route URL loads).
 */
export function get_chat_slice(tab_id: string): ChatSlice {
  let slice = chat_slices.get(tab_id)
  if (!slice) {
    slice = make_chat_slice()
    const created = slice
    untrack(() => chat_slices.set(tab_id, created))
  }
  return slice
}

/**
 * Eagerly create a slice for a tab. Safe to call from event handlers
 * and lifecycle callbacks (not from $derived). Used by tab-manager.
 */
export function ensure_chat_slice(tab_id: string): ChatSlice {
  let slice = chat_slices.get(tab_id)
  if (!slice) {
    slice = make_chat_slice()
    chat_slices.set(tab_id, slice)
  }
  return slice
}

/** Drop a slice when its tab closes. Called by tab-manager.close_tab. */
export function remove_chat_slice(tab_id: string): void {
  const slice = chat_slices.get(tab_id)
  if (slice?.abort_controller) {
    // Best-effort: cancel the in-flight stream so the SDK stops burning
    // tokens on work no UI will display. The SvelteKit route forwards
    // request.signal to the SDK adapter's AbortController (wired in
    // src/routes/api/agent/stream/+server.ts + adapters/claude.ts:121).
    try {
      slice.abort_controller.abort()
    } catch { /* noop */ }
  }
  chat_slices.delete(tab_id)
}

// ─── Paper import (writes into the slice identified by tab_id) ───

/** Upload a PDF paper and set its text as context for the AI */
export async function import_paper(
  file: File,
  tab_id: string = `default`,
): Promise<string> {
  const slice = get_chat_slice(tab_id)
  const form_data = new FormData()
  form_data.append(`file`, file)

  const resp = await fetch(`${API_BASE}/paper/upload`, {
    method: `POST`,
    body: form_data,
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Paper upload failed: ${err}`)
  }

  const data = await resp.json()

  slice.paper_session.session_id = data.session_id
  slice.paper_session.title = data.title || file.name
  slice.paper_session.authors = data.authors ?? []
  slice.paper_session.doi = data.doi ?? ``
  slice.paper_session.page_count = data.page_count ?? 0

  slice.paper_context.value = build_paper_context(data)

  // Post an assistant message so the user knows import succeeded
  const title = slice.paper_session.title || file.name
  slice.messages.list = [
    ...slice.messages.list,
    {
      role: `assistant`,
      content:
        `**Paper imported:** ${title}\n\nI've read the paper. You can now ask me to:\n- Summarize the computational methodology\n- Create a workflow based on this paper\n- Explain specific calculations mentioned`,
      timestamp: Date.now(),
    } satisfies ChatMessage,
  ]

  return data.session_id
}

/** Resolve a DOI and set metadata as context */
export async function import_doi(
  doi: string,
  tab_id: string = `default`,
): Promise<string> {
  const slice = get_chat_slice(tab_id)
  const resp = await fetch(`${API_BASE}/paper/resolve-doi`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ doi }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`DOI resolution failed: ${err}`)
  }

  const data = await resp.json()

  slice.paper_session.session_id = data.session_id
  slice.paper_session.title = data.title ?? ``
  slice.paper_session.authors = data.authors ?? []
  slice.paper_session.doi = data.doi ?? doi
  slice.paper_session.page_count = 0

  slice.paper_context.value = build_paper_context_from_doi(data)

  return data.session_id
}

/** Clear the current paper context */
export function clear_paper(tab_id: string = `default`): void {
  const slice = get_chat_slice(tab_id)
  slice.paper_context.value = ``
  slice.paper_session.session_id = ``
  slice.paper_session.title = ``
  slice.paper_session.authors = []
  slice.paper_session.doi = ``
  slice.paper_session.page_count = 0
}

// ─── Cross-window context sync via BroadcastChannel ───

/** Per-window identity used to tag outgoing BroadcastChannel messages.
 *  When a tab_id is known (main window), that's passed as the source and
 *  used as the filter key by popouts. When tab_id isn't known (e.g. the
 *  current fallback before all callers are migrated), this per-window
 *  UUID provides a stable source identifier so popouts can still filter
 *  cross-window (just not cross-tab-within-window). */
export const WINDOW_SOURCE_ID: string =
  typeof crypto !== `undefined` && typeof crypto.randomUUID === `function`
    ? crypto.randomUUID()
    : `win-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export function broadcast_chat_context(tab_id: string = `default`): void {
  try {
    const slice = get_chat_slice(tab_id)
    const bc = new BroadcastChannel(CHAT_CONTEXT_CHANNEL)
    bc.postMessage({
      source_id: WINDOW_SOURCE_ID,
      source_tab_id: tab_id,
      structure: slice.structure_context.value,
      workflow: slice.workflow_context.value,
      paper: slice.paper_context.value,
    })
    bc.close()
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn(`[CatBot] BroadcastChannel sync failed:`, err)
    }
  }
}

/** Listen for context updates from main window (used by popout chat).
 *
 *  @param tab_id Target tab slice to populate with received contexts
 *                (the popout's own slice).
 *  @param expected_source_tab_id If provided, only broadcasts originating
 *                from this source tab in the main window are applied.
 *                For popouts this should equal the tab_id they mirror —
 *                so a popout for "structure-1" ignores broadcasts from
 *                tab "structure-2".
 *  @param expected_source_id If provided, adds a per-window UUID filter
 *                on top of the tab filter. Optional; legacy arg.
 */
export function listen_chat_context(
  tab_id: string = `default`,
  expected_source_tab_id?: string,
  expected_source_id?: string,
): () => void {
  const bc = new BroadcastChannel(CHAT_CONTEXT_CHANNEL)
  bc.onmessage = (e) => {
    // Drop messages from a different source tab than the one this popout
    // is mirroring — otherwise every tab's broadcast in the main window
    // overwrites this popout's context in last-writer-wins order.
    if (
      expected_source_tab_id && e.data?.source_tab_id !== expected_source_tab_id
    ) return
    if (expected_source_id && e.data?.source_id !== expected_source_id) return
    const slice = get_chat_slice(tab_id)
    if (e.data.structure != null) {
      slice.structure_context.value = e.data.structure
    }
    if (e.data.workflow != null) slice.workflow_context.value = e.data.workflow
    if (e.data.paper != null) slice.paper_context.value = e.data.paper
  }
  return () => bc.close()
}

/** Update the last assistant message's display content during streaming */
function update_last_message(
  slice: ChatSlice,
  text: string,
  blocks?: ContentBlock[],
): void {
  const updated = [...slice.messages.list]
  const last = updated[updated.length - 1]
  if (blocks) {
    updated[updated.length - 1] = { ...last, content: blocks }
  } else {
    updated[updated.length - 1] = { ...last, content: text }
  }
  slice.messages.list = updated
}

export async function send_message(
  content: string,
  attachments?: import('./types').Attachment[],
  tab_id: string = `default`,
): Promise<void> {
  const slice = get_chat_slice(tab_id)
  if (!content.trim()) return
  // A round is already streaming: don't drop this message — queue it and
  // let the finally block fire it as soon as the current response ends.
  // Last write wins (latest compose replaces an earlier un-sent queue entry).
  if (slice.loading.value) {
    slice.pending_send.value = { content: content.trim(), attachments }
    return
  }

  // Add user message
  const user_msg: ChatMessage = {
    role: `user`,
    content: content.trim(),
    timestamp: Date.now(),
  }
  slice.messages.list = [...slice.messages.list, user_msg]

  // Prepare assistant message placeholder
  const assistant_msg: ChatMessage = {
    role: `assistant`,
    content: ``,
    timestamp: Date.now(),
  }
  slice.messages.list = [...slice.messages.list, assistant_msg]

  slice.loading.value = true
  slice.error.value = ``
  slice.abort_controller = new AbortController()

  try {
    const agent = agent_from_provider(chat_config.provider)

    if (agent) {
      // ── SDK Agent path ──
      slice.active_tool_blocks.entries = {}
      slice.active_permission_blocks.entries = {}

      const sid = agent_sessions[agent] || undefined
      const combined_context = [
        slice.structure_context.value,
        slice.workflow_context.value,
        slice.paper_context.value,
      ].filter(Boolean).join(`\n\n`) || undefined
      const system = build_sdk_system_prompt(
        chat_config.provider,
        combined_context,
        !!sid,
      )

      const gen = stream_sdk_agent({
        agent,
        prompt: content.trim(),
        sessionId: sid,
        model: chat_config.model || undefined,
        systemPrompt: system,
        attachments,
        signal: slice.abort_controller.signal,
        tabId: tab_id,
        skipPermissions: slice.skip_permission.value,
        chatId: tab_id,
      })

      let full_text = ``
      for await (const event of gen) {
        switch (event.type) {
          case `text`:
            full_text += event.text as string
            update_last_message(slice, full_text)
            break
          case `thinking`:
            // Could show in collapsed block — for now append as text
            break
          case `tool_start`:
            slice.active_tool_blocks.entries[event.toolId as string] = {
              toolName: event.toolName as string,
              input: event.input,
              output: ``,
              status: `running`,
              elapsedSeconds: 0,
            }
            break
          case `tool_progress`: {
            const tb = slice.active_tool_blocks.entries[event.toolId as string]
            if (tb) {
              tb.elapsedSeconds = event.elapsedSeconds as number
            }
            break
          }
          case `tool_end`: {
            const te = slice.active_tool_blocks.entries[event.toolId as string]
            if (te) {
              te.output = event.result as string
              te.status = (event.isError as boolean) ? `error` : `complete`
              if (event.toolName) te.toolName = event.toolName as string
            }
            const resolved_tool_name = (event.toolName as string) ||
              te?.toolName ||
              ``
            // If a workflow-related MCP tool completed, trigger editor reload
            // so nodes created server-side via MCP appear on the canvas.
            //
            // Guard: only write pending_navigate_workflow.id when the extracted
            // id is actually DIFFERENT from the currently-open workflow.
            // Writing the same id again would re-fire App.svelte's navigate
            // effect, producing a doubled reload cascade on large workflows.
            const result_str = (event.result as string) ?? ``
            if (
              resolved_tool_name.includes(`workflow`) ||
              result_str.includes(`Created workflow`) ||
              result_str.includes(`graph_json`)
            ) {
              // Route to the sending tab's workflow slice so a CatBot-created
              // workflow opens in the tab the user typed in.
              const wf_slice = get_workflow_slice(tab_id)
              const id_match = result_str.match(
                /(?:id:\s*|workflow_id["\s:]+|"id"\s*:\s*")([a-f0-9-]{8,})/,
              )
              if (id_match && wf_slice.active_workflow.id !== id_match[1]) {
                wf_slice.pending_navigate_workflow.id = id_match[1]
              }
              wf_slice.workflow_reload_seq.seq++
            }
            break
          }
          case `permission_request`:
            slice.active_permission_blocks.entries[event.id as string] = {
              toolName: event.toolName as string,
              input: event.input as Record<string, unknown>,
              suggestions: event.suggestions as unknown[] | undefined,
              decisionReason: event.decisionReason as string | undefined,
              status: `pending`,
            }
            break
          case `permission_resolved`: {
            const pb = slice.active_permission_blocks.entries[event.id as string]
            if (pb) {
              pb.status = (event.behavior as string) === `deny` ? `denied` : `allowed`
            }
            break
          }
          case `status`:
            if (event.sessionId) {
              agent_sessions[agent] = event.sessionId as string
              record_session(agent, event.sessionId as string, content)
            }
            break
          case `result`:
            break
          case `done`:
            // Stream finished cleanly. Normalise any indicator state — see
            // `finalize_stream_indicators` for the contract.
            finalize_stream_indicators(slice)
            break
        }
      }
    } else if (is_client_direct(chat_config)) {
      // ── Client-direct path: in-browser agentic tool-calling loop ──
      // No backend proxy — stream_client_llm hits the provider directly and
      // run_tool_loop executes CLIENT_TOOLS in the browser, gating mutating
      // tools through the same PermissionCard the SDK path uses.
      slice.active_tool_blocks.entries = {}
      slice.active_permission_blocks.entries = {}

      const combined_context = [
        slice.structure_context.value,
        slice.workflow_context.value,
        slice.paper_context.value,
      ].filter(Boolean).join(`\n\n`) || undefined
      const system = build_sdk_system_prompt(
        chat_config.provider,
        combined_context,
        false,
        // Mobile/client-direct runs tool-free (isMobile() ? [] : CLIENT_TOOLS
        // below) — use the tool-free prompt so the model answers from the inline
        // structure context instead of promising tool actions it can't perform.
        isMobile(),
      )

      // Local rolling conversation. Start from the prior turns (drop the empty
      // assistant placeholder we just pushed), append the user's new message,
      // and grow it with assistant tool_use / user tool_result pairs as the
      // loop progresses so each transport() turn sees the full history.
      const history: ChatMessage[] = [
        ...slice.messages.list.slice(0, -1),
      ]

      let full_text = ``
      // LoopEvent.tool_end carries no input, but the real tool arguments are
      // available at tool_start. Stash them by call id so the assistant
      // tool_use block we replay into history carries real `arguments` for
      // subsequent turns (not `{}`, which silently drops them).
      const tool_inputs = new SvelteMap<string, Record<string, unknown>>()
      await run_tool_loop({
        transport: () =>
          stream_client_llm(
            history,
            chat_config,
            system,
            // Text-only on mobile (§4): run the loop with an EMPTY tool list so the
            // model never attempts a tool call. Combined with Phase A's
            // omit-tools-when-empty body fix this makes mobile chat pure text.
            // Desktop keeps the full CLIENT_TOOLS agentic loop.
            isMobile() ? [] : CLIENT_TOOLS,
            slice.abort_controller?.signal,
          ),
        // Mobile is text-only and offers no tools, but a model can still
        // hallucinate a tool_call. There is no PermissionCard on mobile, so a
        // `mutate` call would park request_permission forever and wedge the chat
        // (loading never clears). Route any such call to an immediate error with
        // read-kind (skips the permission gate) so the loop unwinds cleanly.
        execute: isMobile()
          ? () =>
            Promise.resolve(
              `{"error":"tools are not available in mobile chat"}`,
            )
          : execute_tool,
        kind_of: isMobile() ? () => `read` as const : tool_kind,
        request_permission: (call) =>
          new Promise<boolean>((resolve) => {
            // Session-scoped bypass: approve immediately, no card.
            if (slice.skip_permission.value) {
              resolve(true)
              return
            }
            // If the user already aborted (Stop / tab close), don't park a
            // promise no card will ever settle — resolve false immediately so
            // the loop emits a skipped tool_end and unwinds to the finally.
            const signal = slice.abort_controller?.signal
            if (signal?.aborted) {
              resolve(false)
              return
            }
            // Resolve false once when the stream is aborted while a card is
            // pending. Without this the awaited promise never settles → the
            // loop never finishes → finally never clears loading (wedge).
            const on_abort = () => resolve(false)
            signal?.addEventListener(`abort`, on_abort, { once: true })
            slice.active_permission_blocks.entries[call.id] = {
              toolName: call.name,
              input: call.arguments,
              status: `pending`,
              // PermissionCard's approve/deny handler calls this to settle the
              // promise the loop is awaiting (see PermissionCard.svelte). It
              // also detaches the abort listener so abort can't double-settle.
              resolve: (ok: boolean) => {
                signal?.removeEventListener(`abort`, on_abort)
                resolve(ok)
              },
            }
          }),
        on_event: (e) => {
          switch (e.type) {
            case `text`:
              full_text += e.text
              update_last_message(slice, full_text)
              break
            case `tool_start`:
              tool_inputs.set(e.id, e.input)
              slice.active_tool_blocks.entries[e.id] = {
                toolName: e.name,
                input: e.input,
                output: ``,
                status: `running`,
                elapsedSeconds: 0,
              }
              break
            case `tool_end`: {
              const te = slice.active_tool_blocks.entries[e.id]
              if (te) {
                te.output = e.result
                te.status = e.isError ? `error` : `complete`
              }
              // Feed the tool call + result back into history so the next
              // transport() turn includes them (OpenAI requires the
              // assistant tool_calls message to be followed by its result).
              history.push({
                role: `assistant`,
                content: [{
                  type: `tool_use`,
                  id: e.id,
                  name: e.name,
                  input: tool_inputs.get(e.id) ?? {},
                  reasoning_content: e.reasoning_content,
                }],
                timestamp: Date.now(),
              })
              history.push({
                role: `user`,
                content: [{
                  type: `tool_result`,
                  tool_use_id: e.id,
                  content: e.result,
                }],
                timestamp: Date.now(),
              })
              break
            }
            case `error`:
              slice.error.value = e.message
              break
            case `done`:
              finalize_stream_indicators(slice)
              break
          }
        },
        signal: slice.abort_controller?.signal,
      })
    } else {
      // ── Universal (OpenAI-compat) path — unchanged ──
      const rag_chunks = await retrieve(content, 5)
      const combined_context = [
        slice.structure_context.value,
        slice.workflow_context.value,
        slice.paper_context.value,
      ].filter(Boolean).join(`\n\n`) || undefined

      const stream = stream_chat(
        slice.messages.list.slice(0, -1),
        chat_config,
        rag_chunks,
        slice.abort_controller.signal,
        combined_context,
      )

      let full_text = ``
      for await (const chunk of stream) {
        full_text += chunk
        update_last_message(slice, full_text)
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === `AbortError`) {
      // User cancelled — keep partial content
    } else {
      const msg = err instanceof Error ? err.message : `Unknown error`
      const is_network_or_server = err instanceof TypeError ||
        msg.includes(`Failed to fetch`) ||
        msg.includes(`NetworkError`) ||
        msg.includes(`Server error`)
      const is_sdk = SDK_PROVIDERS.has(chat_config.provider)
      slice.error.value = !is_sdk && !chat_config.api_key && is_network_or_server
        ? `Connection failed. For API providers, add your key in settings (\u2699). For SDK agents, ensure the backend is running. For Ollama, ensure the server is running.`
        : msg
      // Remove empty assistant message on error; keep if it has partial content
      const last = slice.messages.list[slice.messages.list.length - 1]
      if (last) {
        const text = get_display_text(last.content)
        if (!text) {
          slice.messages.list = slice.messages.list.slice(0, -1)
        }
      }
    }
  } finally {
    // Defence-in-depth: even if the `done` event was never delivered (network
    // failure, aborted stream, renderer exception inside the for-await loop),
    // the indicator state must be normalised before we drop `loading`. Without
    // this, ThinkingSummary stays stuck on "Thinking…" forever.
    finalize_stream_indicators(slice)
    slice.loading.value = false
    slice.abort_controller = null
    // Persist the finished round so the Sessions tab can restore it later
    // (no backend history endpoint exists). The session_id is assigned during
    // the stream (record_session / event.sessionId); by the finally it lives
    // in agent_sessions for the current provider's agent.
    try {
      const persist_agent = agent_from_provider(chat_config.provider)
      const persist_sid = persist_agent ? agent_sessions[persist_agent] : undefined
      if (persist_sid) {
        persist_session_messages(persist_sid, slice.messages.list)
      }
    } catch { /* persistence is best-effort, never block the UI */ }
    // Drain a message the user composed mid-stream. queueMicrotask so this
    // send_message promise settles (and the UI repaints the finished round)
    // before the queued round flips loading back on.
    const queued = slice.pending_send.value
    if (queued) {
      slice.pending_send.value = null
      queueMicrotask(() => {
        void send_message(queued.content, queued.attachments, tab_id)
      })
    }
  }
}

/**
 * Normalise the in-flight indicator state once a streaming response has
 * ended for any reason (clean `done` event, thrown error, or user abort).
 *
 * `active_tool_blocks` / `active_permission_blocks` are strictly an
 * *in-flight* projection of what the assistant is currently doing — they
 * are reset at the start of every new `send_message` call. While the
 * stream is live we transition entries from `running`/`pending` to
 * `complete`/`allowed` on each matching `tool_end`/`permission_resolved`
 * event. ThinkingSummary's "Thinking…" label is gated on whether any
 * entry is still in the in-flight state.
 *
 * If the stream ends without delivering every matching event (which can
 * happen for a number of reasons that the frontend cannot fully prevent —
 * SSE parse errors, mid-response abort, an exception in the render loop,
 * a backend that simply forgot to emit the event), the corresponding
 * entry will be stranded in the in-flight state and the indicator will
 * never release. The history of what actually happened is independently
 * preserved in `slice.messages.list` as `tool_use` / `tool_result`
 * content blocks on the assistant message, so dropping the stranded
 * in-flight state is safe and lossless.
 *
 * Invariant after this function returns: every entry is in a terminal
 * state (`complete` / `error` / `allowed` / `denied`).
 */
function finalize_stream_indicators(slice: ChatSlice): void {
  for (const id in slice.active_tool_blocks.entries) {
    const tb = slice.active_tool_blocks.entries[id]
    if (tb && tb.status === `running`) tb.status = `complete`
  }
  for (const id in slice.active_permission_blocks.entries) {
    const pb = slice.active_permission_blocks.entries[id]
    if (pb && pb.status === `pending`) pb.status = `allowed`
  }
}

export function cancel_generation(tab_id: string = `default`): void {
  const slice = get_chat_slice(tab_id)
  // Explicit Stop cancels everything, including a message the user queued
  // mid-stream — otherwise it would surprise them by firing after Stop.
  slice.pending_send.value = null
  slice.abort_controller?.abort()
  // Belt-and-suspenders: settle any still-pending client-direct permission
  // promise. The abort listener in request_permission already does this when
  // the signal fires, but resolving here too is idempotent (resolve() removes
  // the listener; a Promise ignores a second settle) and guards teardown paths
  // that may not route through abort(). SDK entries have no `resolve` and are
  // left untouched — they settle via the backend round-trip.
  for (const id in slice.active_permission_blocks.entries) {
    const pb = slice.active_permission_blocks.entries[id]
    if (pb && pb.status === `pending` && pb.resolve) pb.resolve(false)
  }
}

// ─── Session list — tracks all sessions for the Sessions tab ───

const STORAGE_KEY_SESSION_LIST = `catgo-session-list`

/** Persisted session summaries */
export const session_list = $state<{ list: SessionSummary[] }>({
  list: load_from_storage(STORAGE_KEY_SESSION_LIST, []),
})

function persist_session_list(): void {
  save_to_storage(STORAGE_KEY_SESSION_LIST, session_list.list)
}

// ─── Per-session chat transcript persistence ───
//
// No backend endpoint exposes session history (the original assumption that
// every CLI agent surfaces its own transcript proved unreliable — see the
// note in ChatPane.handle_resume_session). So we persist the message list
// client-side, keyed by session_id, exactly like session_list metadata:
// localStorage, agent-agnostic, survives reload/tab-switch. Capped per
// session so a long conversation can't blow the ~5 MB localStorage quota.
const STORAGE_KEY_SESSION_MESSAGES = `catgo-session-messages`
const MAX_PERSISTED_MESSAGES = 400

type SessionMessageMap = Record<string, ChatMessage[]>

export function load_session_messages(session_id: string): ChatMessage[] {
  if (!session_id) return []
  const map = load_from_storage<SessionMessageMap>(
    STORAGE_KEY_SESSION_MESSAGES,
    {},
  )
  return Array.isArray(map[session_id]) ? map[session_id] : []
}

export function persist_session_messages(
  session_id: string,
  messages: ChatMessage[],
): void {
  if (!session_id || messages.length === 0) return
  const map = load_from_storage<SessionMessageMap>(
    STORAGE_KEY_SESSION_MESSAGES,
    {},
  )
  map[session_id] = messages.slice(-MAX_PERSISTED_MESSAGES)
  save_to_storage(STORAGE_KEY_SESSION_MESSAGES, map)
}

function forget_session_messages(session_id: string): void {
  if (!session_id) return
  const map = load_from_storage<SessionMessageMap>(
    STORAGE_KEY_SESSION_MESSAGES,
    {},
  )
  if (session_id in map) {
    delete map[session_id]
    save_to_storage(STORAGE_KEY_SESSION_MESSAGES, map)
  }
}

/** Record a session_id from the agent stream.
 *
 * Maintains the locally-persisted `session_list` (keyed by `session_id`) so
 * the Sessions tab survives even when no backend session-listing endpoint
 * is available. Each call either inserts a new summary or bumps the
 * `last_active` + `message_count` of the existing one, then re-persists.
 */
export function record_session(
  agent: string,
  session_id: string,
  topic: string,
  model?: string,
): void {
  agent_sessions[agent] = session_id

  const now = Date.now()
  const trimmed_topic = (topic ?? ``).trim().slice(0, 80)
  const existing_idx = session_list.list.findIndex((s) => s.session_id === session_id)

  if (existing_idx >= 0) {
    const prev = session_list.list[existing_idx]
    session_list.list[existing_idx] = {
      ...prev,
      last_active: now,
      message_count: prev.message_count + 1,
      // Backfill topic if a later message has more useful text than the first.
      topic: prev.topic || trimmed_topic,
      model: model ?? prev.model,
    }
  } else {
    session_list.list = [
      ...session_list.list,
      {
        session_id,
        agent,
        topic: trimmed_topic,
        created_at: now,
        last_active: now,
        message_count: 1,
        model,
      },
    ]
  }
  persist_session_list()
}

/** Delete a session from the list (also removes its stored chat history) */
export function delete_session(session_id: string): void {
  session_list.list = session_list.list.filter((s) => s.session_id !== session_id)
  persist_session_list()
  forget_session_messages(session_id)
}

/** Resume a previous session in the given tab. */
export function resume_session(
  agent: string,
  session_id: string,
  messages?: ChatMessage[],
  tab_id: string = `default`,
): void {
  const slice = get_chat_slice(tab_id)
  slice.error.value = ``
  slice.skip_permission.value = false
  clear_workflow_events(tab_id)
  agent_sessions[agent] = session_id
  slice.messages.list = messages ?? []
}

/** Start a fresh session — clears the given tab's chat. */
export function new_session(agent?: string, tab_id: string = `default`): void {
  const slice = get_chat_slice(tab_id)
  slice.messages.list = []
  slice.error.value = ``
  slice.skip_permission.value = false

  clear_workflow_events(tab_id)
  if (agent) {
    delete agent_sessions[agent]
  } else {
    for (const key of Object.keys(agent_sessions)) delete agent_sessions[key]
  }
}

export function clear_chat_history(tab_id: string = `default`): void {
  const slice = get_chat_slice(tab_id)
  slice.messages.list = []
  slice.error.value = ``
  slice.skip_permission.value = false

  clear_workflow_events(tab_id)
  clear_agent_session()
}
