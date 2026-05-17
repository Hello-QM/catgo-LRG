export type AgentType = 'claude' | 'codex' | 'gemini'

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cost_usd?: number
}

export interface Attachment {
  type: 'image' | 'pdf' | 'file'
  name: string
  mimeType: string
  data: string // base64
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsedSeconds: number }
  | { type: 'tool_end'; toolId: string; toolName: string; result: string; isError: boolean }
  | { type: 'permission_request'; id: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; decisionReason?: string }
  | { type: 'permission_resolved'; id: string; behavior: 'allow' | 'deny' }
  | { type: 'status'; sessionId?: string; model?: string }
  | { type: 'result'; usage?: TokenUsage; isError: boolean; errorMessage?: string; costUsd?: number; durationMs?: number }
  | { type: 'done' }

export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  decisionReason?: string
}

export interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedPermissions?: unknown[]
  message?: string
  /**
   * For the SDK `AskUserQuestion` tool: the host injects the user's
   * selected answers here. The Claude adapter forwards this verbatim as
   * the canUseTool `updatedInput` ({ questions, answers }), which the
   * Agent SDK turns into the tool_result automatically. Undefined for
   * ordinary allow/deny tool gating.
   */
  updatedInput?: Record<string, unknown>
}

export interface SessionInfo {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
}

export interface StreamParams {
  prompt: string
  sessionId?: string
  model?: string
  systemPrompt?: string
  cwd?: string
  mcpServerUrl?: string
  attachments?: Attachment[]
  permissionCallback: (req: PermissionRequest) => Promise<PermissionResult>
  abortSignal?: AbortSignal
  /**
   * Per-tab identifier. When set, the Claude adapter attaches an
   * `X-CatGo-Tab-Id` header to MCP HTTP requests so the backend routes
   * structure/workflow pushes back to the originating tab. Codex and Gemini
   * currently ignore this (their CLIs configure MCP elsewhere).
   */
  tabId?: string
  /**
   * Per-chat-thread key for the persistent Gemini ACP process pool. When
   * set, repeat `stream()` calls with the same `chatId` reuse one
   * `gemini --acp` process + ACP session, so the model remembers prior
   * turns. Omit → fresh one-shot process per call (legacy behaviour;
   * keeps non-pooled callers and the Claude/Codex adapters unaffected).
   */
  chatId?: string
}
