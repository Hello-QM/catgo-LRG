/**
 * Chat-tabs registry — module-level reactive state for the mobile AI chat
 * overlay (MobileChat). Mirrors `terminal-tabs.svelte.ts`.
 *
 * Each tab's `id` IS its chat-state slice id (`get_chat_slice(id)`), so the
 * conversation, loading indicator, abort controller, and pending-send queue all
 * live in the existing per-tab slice — this registry holds ONLY display metadata
 * (label + creation ordinal) and the active selection.
 *
 * Lives at module scope so chats survive the overlay closing ("minimize") and
 * MobileChat remounts within the app process — closing the overlay keeps every
 * conversation alive; reopening restores them.
 */

export type ChatTab = {
  /** Stable id — also the `{#each}` key AND the chat-state slice id. */
  id: string
  /** 1-based creation ordinal for the `Chat N` fallback label. */
  seq: number
  /** Derived from the first user message; falls back to `Chat N` when empty. */
  title: string
}

/** Hard cap on simultaneous chats. Matches the terminal tab cap. */
export const MAX_CHAT_TABS = 5

export const chat_tabs = $state({
  tabs: [] as ChatTab[],
  active_id: null as string | null,
  /** Edit mode reveals a ✕ on each tab for closing several quickly. */
  edit_mode: false,
})

let id_counter = 0
let seq_counter = 0

function next_id(): string {
  id_counter += 1
  // Keep the FIRST tab's id as `mobile` so an existing single-chat session (the
  // pre-tabs world) and its history carry over seamlessly the first time tabs
  // appear. Later tabs get unique suffixed ids.
  return id_counter === 1 ? `mobile` : `mobile-${id_counter}`
}

/** Seed the first tab once (idempotent) — call on overlay mount. */
export function ensure_chat_seed(): void {
  if (chat_tabs.tabs.length === 0) add_chat_tab()
}

/** Add a chat and make it active. No-op (returns null) past MAX_CHAT_TABS. */
export function add_chat_tab(): string | null {
  if (chat_tabs.tabs.length >= MAX_CHAT_TABS) return null
  seq_counter += 1
  const tab: ChatTab = { id: next_id(), seq: seq_counter, title: `` }
  chat_tabs.tabs.push(tab)
  chat_tabs.active_id = tab.id
  return tab.id
}

/** Make `id` the active chat (ignored if `id` isn't a known tab). */
export function switch_chat_tab(id: string): void {
  if (chat_tabs.tabs.some((t) => t.id === id)) chat_tabs.active_id = id
}

/** Close a chat. Closing the last one respawns a fresh empty chat so the
 *  overlay is never tab-less; otherwise the active selection moves to a
 *  neighbour. (The closed slice's history is left in chat-state — harmless at
 *  this cap; ids never alias since the counter is monotonic.) */
export function close_chat_tab(id: string): void {
  const idx = chat_tabs.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  chat_tabs.tabs.splice(idx, 1)
  if (chat_tabs.tabs.length <= 1) chat_tabs.edit_mode = false
  if (chat_tabs.tabs.length === 0) {
    add_chat_tab()
    return
  }
  if (chat_tabs.active_id === id) {
    const next = chat_tabs.tabs[Math.min(idx, chat_tabs.tabs.length - 1)]
    chat_tabs.active_id = next.id
  }
}

/** Display label: the (truncated) first user message, else `Chat N`. */
export function chat_tab_label(tab: ChatTab): string {
  return tab.title.trim() || `Chat ${tab.seq}`
}

/** Set a tab's title from the first user message (only if not already set). */
export function set_chat_title(id: string, text: string): void {
  const tab = chat_tabs.tabs.find((t) => t.id === id)
  if (tab && !tab.title) tab.title = text.trim().slice(0, 24)
}

export function toggle_chat_edit_mode(): void {
  chat_tabs.edit_mode = !chat_tabs.edit_mode
}
