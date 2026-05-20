/** Provider IDs — SDK agents, API providers, and local (Ollama). */
export type LLMProvider =
  | `sdk-claude`
  | `sdk-codex`
  | `sdk-gemini`
  | `deepseek`
  | `qwen`
  | `kimi`
  | `zhipu`
  | `gemini`
  | `anthropic`
  | `custom`
  | `ollama`

/** Provider mode: SDK agent bridge, or universal OpenAI-compat. */
export type ProviderMode = `sdk` | `universal`
export type ApiFormat = `auto` | `openai` | `anthropic`

export interface TextBlock {
  type: `text`
  text: string
}

export interface ToolUseBlock {
  type: `tool_use`
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: `tool_result`
  tool_use_id: string
  content: string | ToolResultData
}

export interface ToolResultData {
  data: Record<string, unknown>
  output_type: string
  tool_id: string
  error?: string
  traceback?: string
  session_id?: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface ChatMessage {
  role: `user` | `assistant`
  content: string | ContentBlock[]
  timestamp: number
}

export interface ChatConfig {
  provider: LLMProvider
  model: string
  temperature: number
  max_tokens: number
  api_key: string // stored in localStorage, not in settings schema
  base_url: string // for universal OpenAI-compatible providers
  api_format: ApiFormat
  fetched_models: Partial<Record<LLMProvider, { id: string; label: string }[]>>
  mode: ProviderMode // how to connect
}

/** Provider info returned by GET /chat/providers */
export interface ProviderInfoResponse {
  id: string
  name: string
  type: `api` | `cli` | `local`
  available: boolean
  models: { id: string; label: string }[]
  base_url: string | null
}

/** SDK agent providers route through the Agent SDK bridge */
export const SDK_PROVIDERS: Set<LLMProvider> = new Set([`sdk-claude`, `sdk-codex`, `sdk-gemini`])

/** Determine the default mode for a provider */
export function default_mode_for(provider: LLMProvider): ProviderMode {
  if (SDK_PROVIDERS.has(provider)) return `sdk`
  return `universal`
}

export interface DocChunk {
  id: number
  source: string
  heading: string
  content: string
}

/** Extract display text from a ChatMessage's content (string or ContentBlock[]) */
export function get_display_text(content: string | ContentBlock[]): string {
  if (typeof content === `string`) return content
  return content
    .filter((b): b is TextBlock => b.type === `text`)
    .map((b) => b.text)
    .join(``)
}

/** A session summary for display in the Sessions tab */
export interface SessionSummary {
  session_id: string
  agent: string // "claude" | "gemini" | "codex"
  topic: string // First user message, truncated to ~80 chars
  created_at: number // Unix ms
  last_active: number // Unix ms
  message_count: number
  model?: string
}

/** Extract tool_use blocks from a ChatMessage's content */
export function get_tool_uses(content: string | ContentBlock[]): ToolUseBlock[] {
  if (typeof content === `string`) return []
  return content.filter((b): b is ToolUseBlock => b.type === `tool_use`)
}

export type AgentType = `claude` | `codex` | `gemini`

export interface Attachment {
  type: `image` | `pdf` | `file`
  name: string
  mimeType: string
  data: string
}

export function agent_from_provider(provider: LLMProvider): AgentType | null {
  if (provider === `sdk-claude`) return `claude`
  if (provider === `sdk-codex`) return `codex`
  if (provider === `sdk-gemini`) return `gemini`
  return null
}
