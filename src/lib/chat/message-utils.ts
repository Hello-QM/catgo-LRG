/**
 * Message formatting, parsing, and rendering helpers for ChatPane.
 *
 * Pure functions and static data — no reactive Svelte state.
 */

import type { LLMProvider, ChatMessage, ProviderInfoResponse } from './types'
import type { WorkflowEvent } from '$lib/workflow/workflow-state.svelte'

// ── Static data ──

/** Mask bearer tokens / `sk-...` secrets / x-api-key values in a string so it is
 *  safe to display or log (§8 M). Route any error text that might reflect request
 *  headers (some providers echo them in 401 bodies) through this first. */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer)\s+[A-Za-z0-9._\-+/=]+/gi, `$1 ***`)
    .replace(/\bsk-[A-Za-z0-9._\-]+/g, `sk-***`)
    .replace(/\b(x-api-key)\s*[:=]\s*[A-Za-z0-9._\-+/=]+/gi, `$1: ***`)
}

/** Static fallback model lists (used only when backend is unreachable) */
export const FALLBACK_MODELS: Partial<Record<LLMProvider, { id: string; label: string }[]>> = {
  'sdk-claude': [
    { id: `sonnet`, label: `Default (Sonnet 4.6)` },
    { id: `opus`, label: `Opus 4.7` },
    { id: `haiku`, label: `Haiku 4.5` },
  ],
}

/** SDK agent installation info */
export const CLI_INSTALL_INFO: Record<string, { name: string; command: string; url: string }> = {
  'sdk-claude': {
    name: `Claude Code`,
    command: `npm install -g @anthropic-ai/claude-code`,
    url: `https://docs.anthropic.com/en/docs/claude-code`,
  },
  'sdk-gemini': {
    name: `Gemini CLI`,
    command: `npm install -g @google/gemini-cli`,
    url: `https://github.com/google-gemini/gemini-cli`,
  },
  'sdk-codex': {
    name: `Codex CLI`,
    command: `npm install -g @openai/codex`,
    url: `https://github.com/openai/codex`,
  },
}

/** Provider display names and grouping */
export const PROVIDER_META: Record<string, { label: string; group: `sdk` | `api` | `local` }> = {
  'sdk-claude': { label: `Claude Code`, group: `sdk` },
  'sdk-gemini': { label: `Gemini CLI`, group: `sdk` },
  'sdk-codex': { label: `Codex CLI`, group: `sdk` },
  deepseek: { label: `DeepSeek`, group: `api` },
  qwen: { label: `Qwen (通义千问)`, group: `api` },
  kimi: { label: `Kimi (月之暗面)`, group: `api` },
  zhipu: { label: `Zhipu GLM (智谱清言)`, group: `api` },
  gemini: { label: `Gemini`, group: `api` },
  anthropic: { label: `Anthropic`, group: `api` },
  custom: { label: `Custom Provider`, group: `api` },
  ollama: { label: `Ollama (Local)`, group: `local` },
}

export const AGENT_LABELS: Record<string, string> = {
  claude: `Claude`,
  gemini: `Gemini`,
  codex: `Codex`,
}

export const VOICE_LANGUAGES = [
  { code: `en-US`, label: `English` },
  { code: `zh-CN`, label: `中文` },
  { code: `ja-JP`, label: `日本語` },
  { code: `ko-KR`, label: `한국어` },
  { code: `de-DE`, label: `Deutsch` },
  { code: `fr-FR`, label: `Français` },
] as const

/** Suggestion chips for the welcome screen */
export const BASE_CHIPS = [
  `What is this structure?`,
  `Hide the atoms`,
  `Select all oxygen`,
  `Show unit cell`,
]

export const WORKFLOW_CHIPS = [
  `What is this structure?`,
  `Get workflow status`,
  `Select all oxygen`,
  `What went wrong?`,
]

export const PAPER_CHIPS = [
  `Summarize the computational methods`,
  `Create a workflow from this paper`,
  `What parameters did they use?`,
  `What structure types were studied?`,
]

// ── Functions ──

/** Get models for a provider (dynamic from backend, static fallback) */
export function get_models(
  provider: LLMProvider,
  providers: ProviderInfoResponse[],
  fetched_models: Partial<Record<LLMProvider, { id: string; label: string }[]>> = {},
): { id: string; label: string }[] {
  const fetched = fetched_models[provider]
  if (fetched?.length) return fetched
  const backend_info = providers.find((p) => p.id === provider)
  if (backend_info?.models.length) return backend_info.models
  return FALLBACK_MODELS[provider] ?? []
}

/** Check if a provider is available */
export function is_available(provider_id: string, providers: ProviderInfoResponse[]): boolean {
  const info = providers.find((p) => p.id === provider_id)
  return info?.available ?? false
}

/** Format a workflow event into a notification message string */
export function format_workflow_event(event: WorkflowEvent): string {
  switch (event.type) {
    case `step_failed`:
      return `**Step failed:** ${event.step_label ?? event.step_id}${event.error ? ` — ${event.error}` : ``}. Ask me "what went wrong?" for details.`
    case `workflow_completed`:
      return `**Workflow completed successfully.** All steps finished.`
    case `workflow_failed`:
      return `**Workflow failed.** One or more steps encountered errors. Ask me to diagnose the issue.`
    default:
      return ``
  }
}

/** Format a timestamp into a human-readable "time ago" string */
export function format_time_ago(ts: number): string {
  const now = Date.now()
  const ms = ts < 1e12 ? ts * 1000 : ts // handle seconds vs milliseconds
  const diff = now - ms
  if (diff < 60_000) return `just now`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ms).toLocaleDateString()
}

/** Translate raw API errors into user-friendly messages */
export function friendly_error(raw: string): string {
  if (raw.includes(`rate_limit`) || raw.includes(`429`))
    return `Rate limit reached. Please wait a moment and try again.`
  if (raw.includes(`invalid_api_key`) || raw.includes(`401`))
    return `API key is invalid. Check your key in settings.`
  if (raw.includes(`model_not_found`) || raw.includes(`does not exist`))
    return `Model not available. Try selecting a different model in settings.`
  if (raw.includes(`insufficient_quota`) || raw.includes(`402`))
    return `API quota exceeded. Check your billing status.`
  if (raw.includes(`overloaded`) || raw.includes(`503`))
    return `Service temporarily overloaded. Try again in a few seconds.`
  if (raw.includes(`context_length`) || raw.includes(`too many tokens`))
    return `Message too long. Try shortening or start a new conversation.`
  if (raw.includes(`timeout`) || raw.includes(`ETIMEDOUT`))
    return `Request timed out. The server may be slow — try again.`
  if (raw.includes(`Failed to fetch`) || raw.includes(`NetworkError`))
    return `Connection failed. Check your internet or add an API key in settings.`
  if (raw.toLowerCase().includes(`encoding`) && (raw.toLowerCase().includes(`unknown`) || raw.includes(`not supported`)))
    return `Model API returned unsupported encoding. Try a different model or provider.`
  return raw
}

/** Detect text language — CJK -> zh-CN, else follow the provided default */
export function detect_language(text: string, default_lang: string): string {
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)
  if (cjk && cjk.length > text.length * 0.1) return `zh-CN`
  const jp = text.match(/[\u3040-\u309f\u30a0-\u30ff]/g)
  if (jp && jp.length > text.length * 0.05) return `ja-JP`
  const kr = text.match(/[\uac00-\ud7af]/g)
  if (kr && kr.length > text.length * 0.05) return `ko-KR`
  return default_lang
}

/** Check if a message is a tool_result-only message (hidden from display) */
export function is_tool_result_msg(msg: ChatMessage): boolean {
  if (typeof msg.content === `string`) return false
  return msg.content.length > 0 && msg.content.every((b) => b.type === `tool_result`)
}

/** Extract the latest tool-call action name from text (e.g. "Calling structure...") */
export function extract_current_action(text: string): string {
  const matches = text.match(/(?:>\s*)?Calling\s+`?(\w+)`?\s*\.\.\./g)
  if (!matches) return ``
  const last_match = matches[matches.length - 1]
  const name = last_match.match(/Calling\s+`?(\w+)`?/)?.[1] ?? ``
  return name ? `Calling ${name}` : ``
}
