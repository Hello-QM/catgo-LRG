# Agent SDK Bridge — Unified CLI Agent Integration

**Date:** 2026-03-29
**Status:** Design approved

## Problem

CatBot's CLI agent path spawns Claude/Gemini/Codex as subprocesses (`claude -p "..."`) and parses stdout. This approach has fundamental limitations:

1. **No interactive permission approval** — subprocess mode can't relay permission requests back to the user. Only options are skip permissions (insecure) or block (unusable).
2. **No tool execution visibility** — users can't see what tools are running, their inputs, or real-time output.
3. **Cold start on every message** — each message spawns a new process (15-60s first time).
4. **Fragile output parsing** — banner noise filtering, dedup logic, encoding hacks across three CLI formats.
5. **Two tool definition sets** — frontend `structure-tools.ts` (44+ tools) and backend MCP tools must be kept in sync. This is already a documented pain point.

## Solution

Replace subprocess spawning with official/community Agent SDKs that provide programmatic control:

- `@anthropic-ai/claude-agent-sdk` (official) — Claude Code
- `@openai/codex-sdk` (official) — Codex
- `@ketd/gemini-cli-sdk` (community) — Gemini CLI

All three expose async generator streaming, session management, and (for Claude/Gemini) per-tool permission callbacks.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (Svelte 5)                   │
│                                                         │
│  ChatPane.svelte                                        │
│    ├── Message stream (text, thinking)                  │
│    ├── PermissionCard.svelte     ← inline approval      │
│    ├── ToolProgressBlock.svelte  ← tool detail view     │
│    └── chat-state.svelte.ts     ← sdk provider path    │
│              ↓ POST + SSE                               │
├─────────────────────────────────────────────────────────┤
│              SvelteKit Server Routes                     │
│                                                         │
│  src/routes/api/agent/                                  │
│    ├── stream/+server.ts    ← unified SSE endpoint      │
│    └── permission/+server.ts ← approval resolve         │
│              ↓                                          │
├─────────────────────────────────────────────────────────┤
│           Agent Bridge Layer (Node.js)                   │
│                                                         │
│  src/lib/server/agent-bridge/                           │
│    ├── types.ts             ← AgentEvent union type     │
│    ├── adapter.ts           ← AgentAdapter interface    │
│    ├── adapters/                                        │
│    │   ├── claude.ts        ← claude-agent-sdk          │
│    │   ├── codex.ts         ← @openai/codex-sdk        │
│    │   └── gemini.ts        ← @ketd/gemini-cli-sdk     │
│    ├── permission-manager.ts ← pending approvals        │
│    └── session-store.ts     ← session ID management     │
│              ↓                                          │
├─────────────────────────────────────────────────────────┤
│           Python Backend (unchanged)                     │
│                                                         │
│  MCP Server (http://localhost:{port}/api/mcp)           │
│    └── catgo_* tools (structure, workflow, analysis)     │
└─────────────────────────────────────────────────────────┘
```

## Provider Simplification

### Before (12 providers, 4 modes)

```
anthropic (direct) — browser → Anthropic API
openai (direct) — browser → OpenAI API
deepseek, qwen, kimi, zhipu, gemini, ollama (universal) — browser/backend → OpenAI-compat
cli-claude, cli-gemini, cli-codex (cli) — backend → subprocess
```

### After (up to 9 providers, 2 modes)

```
sdk-claude, sdk-codex, sdk-gemini (sdk) — SvelteKit → Agent SDK → MCP
deepseek, qwen, kimi, zhipu, gemini, ollama (universal) — unchanged
```

**Removed:**
- `anthropic` direct — replaced by `sdk-claude` (superset: permissions, tool progress, sessions, no API key needed)
- `openai` direct — replaced by `sdk-codex`
- `cli-claude`, `cli-gemini`, `cli-codex` — replaced by `sdk-*` equivalents

**Kept:**
- `universal` mode for OpenAI-compatible providers (Deepseek, Qwen, Kimi, Zhipu, Gemini API, Ollama)

This eliminates the two-tool-definition-set sync problem: `structure-tools.ts` frontend tools are no longer needed for the SDK path; all tools go through MCP.

## Unified Event Type

```typescript
// src/lib/server/agent-bridge/types.ts

type AgentType = 'claude' | 'codex' | 'gemini'

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool_progress'; toolId: string; output: string }
  | { type: 'tool_end'; toolId: string; result: string; isError: boolean }
  | { type: 'permission_request'; id: string; toolName: string;
      input: unknown; suggestions?: unknown[] }
  | { type: 'permission_resolved'; id: string; behavior: 'allow' | 'deny' }
  | { type: 'status'; sessionId?: string; model?: string }
  | { type: 'result'; usage?: TokenUsage; isError: boolean;
      errorMessage?: string }
  | { type: 'done' }

interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cost_usd?: number
}
```

Each adapter maps its SDK's native events to this union. The frontend only handles this one set.

## Adapter Interface

```typescript
// src/lib/server/agent-bridge/adapter.ts

interface StreamParams {
  prompt: string
  sessionId?: string
  model?: string
  cwd?: string
  mcpServers?: Record<string, McpServerConfig>
  permissionCallback: (req: PermissionRequest) => Promise<PermissionResult>
  abortSignal?: AbortSignal
}

interface AgentAdapter {
  readonly agent: AgentType
  stream(params: StreamParams): AsyncGenerator<AgentEvent>
  listSessions(): Promise<SessionInfo[]>
  getSessionMessages(sessionId: string): Promise<ChatMessage[]>
}
```

### Adapter Responsibilities

Each adapter (~100-150 lines) does exactly one thing: translate SDK events to `AgentEvent`.

**Claude adapter:**
- `query()` → iterate `SDKMessage` types
- `SDKAssistantMessage` → `text` / `thinking`
- `SDKToolProgressMessage` → `tool_start` / `tool_progress` / `tool_end`
- `canUseTool` callback → `permission_request` event + Promise-based blocking
- `SDKResultMessage` → `result`
- `listSessions()` / `getSessionMessages()` via SDK helpers

**Codex adapter:**
- `startThread()` / `resumeThread()` → `thread.runStreamed()`
- Map streaming events to `AgentEvent`
- No permission callback (uses static `approvalPolicy: 'on-request'`)
- Permission card not rendered for Codex

**Gemini adapter:**
- `query()` / `stream()` → iterate events
- `onPermissionRequest` callback → `permission_request` event + Promise-based blocking
- Map message/tool events to `AgentEvent`

## Permission Manager

```typescript
// src/lib/server/agent-bridge/permission-manager.ts

// In-memory map of pending permission requests
// Key: permissionRequestId
// Value: { resolve callback, metadata }

function registerPending(id, toolName, input): Promise<PermissionResult>
function resolvePending(id, behavior, updatedPermissions?): boolean
function getPending(id): PendingInfo | undefined
```

### Permission Flow

```
1. SDK stream hits tool requiring approval
2. SDK calls canUseTool(toolName, input)
3. Adapter calls permissionManager.registerPending(id, toolName, input)
   → returns a Promise (SDK stream blocks here)
4. Adapter yields { type: 'permission_request', id, toolName, input }
5. SSE pushes event to frontend
6. Frontend renders PermissionCard with Allow / Allow Session / Deny buttons
7. User clicks Allow → POST /api/agent/permission { id, behavior: 'allow' }
8. SvelteKit route calls permissionManager.resolvePending(id, 'allow')
   → Promise resolves → SDK canUseTool returns { behavior: 'allow' }
9. SDK stream resumes, tool executes
10. Adapter yields tool_start → tool_progress → tool_end events
```

**Codex special case:** No `canUseTool` callback. Uses `approvalPolicy: 'on-request'` (static). PermissionCard is never rendered for Codex — tools either auto-approve or auto-deny based on policy.

## SvelteKit Server Routes

### POST /api/agent/stream

```typescript
// src/routes/api/agent/stream/+server.ts

// Request body:
{
  agent: 'claude' | 'codex' | 'gemini',
  prompt: string,
  sessionId?: string,
  model?: string
}

// Response: SSE stream of AgentEvent
// Content-Type: text/event-stream
// Each event: data: {json}\n\n
// Terminal event: data: {"type":"done"}\n\n
```

Internally:
1. Select adapter by `agent` param
2. Determine MCP server URL from environment (`CATGO_API` or default `http://localhost:{port}/api/mcp`)
3. Wire `permissionCallback` to `permissionManager.registerPending()`
4. Call `adapter.stream()`, iterate async generator
5. For each `AgentEvent`, write `data: ${JSON.stringify(event)}\n\n`

### POST /api/agent/permission

```typescript
// src/routes/api/agent/permission/+server.ts

// Request body:
{
  permissionId: string,
  behavior: 'allow' | 'allow_session' | 'deny'
}

// Response: { ok: boolean }
```

## Frontend Components

### PermissionCard.svelte

Inline in the chat message flow. Renders when `chat_messages` contains a permission_request event.

```
┌──────────────────────────────────────────┐
│  Permission Required                     │
│                                          │
│  Tool: Bash                              │
│  ┌────────────────────────────────────┐  │
│  │ git commit -m "add feature"       │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [Allow]  [Allow Session]  [Deny]        │
└──────────────────────────────────────────┘
```

After user clicks:

```
┌──────────────────────────────────────────┐
│  Allowed: Bash(git commit ...)      0.2s │
└──────────────────────────────────────────┘
```

Props: `permissionId, toolName, input, suggestions, status`
- `status: 'pending' | 'allowed' | 'denied'`
- When `pending`: show buttons
- When `allowed/denied`: collapse to one-line summary

### ToolProgressBlock.svelte

Inline in the chat message flow. Shows tool execution details like Claude Code CLI.

```
┌──────────────────────────────────────────┐
│  ▶ Read(src/lib/chat/types.ts)     1.2s  │
│  ┌────────────────────────────────────┐  │
│  │ 1  export type LLMProvider =      │  │
│  │ 2    | 'anthropic'                │  │
│  │ 3    | 'openai'                   │  │
│  │    ... (42 lines)                 │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

States:
- `running`: spinner + tool name + input params, output accumulating
- `complete`: green checkmark + tool name + collapsed output (click to expand)
- `error`: red X + error message

Props: `toolId, toolName, input, output, status, durationMs`

### chat-state.svelte.ts Changes

New `stream_sdk_agent()` function:

```typescript
async function* stream_sdk_agent(
  agent: AgentType,
  prompt: string,
  sessionId?: string,
  model?: string,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent> {
  const response = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, prompt, sessionId, model }),
    signal
  })
  // Parse SSE, yield AgentEvent objects
}
```

In `send_message()`:
```typescript
if (SDK_PROVIDERS.has(config.provider)) {
  const agent = config.provider.replace('sdk-', '') as AgentType
  for await (const event of stream_sdk_agent(agent, content, sessionId, model, signal)) {
    switch (event.type) {
      case 'text':
        // Append to current assistant message
      case 'thinking':
        // Show thinking indicator
      case 'tool_start':
        // Insert ToolProgressBlock (running state)
      case 'tool_progress':
        // Update ToolProgressBlock output
      case 'tool_end':
        // Update ToolProgressBlock to complete/error
      case 'permission_request':
        // Insert PermissionCard (pending state)
      case 'status':
        // Capture sessionId for resume
      case 'result':
        // Finalize message, show usage stats
    }
  }
}
```

### types.ts Changes

```typescript
export type LLMProvider =
  | 'sdk-claude' | 'sdk-codex' | 'sdk-gemini'    // SDK agents
  | 'deepseek' | 'qwen' | 'kimi' | 'zhipu'       // universal
  | 'gemini' | 'ollama'                            // universal

export type ProviderMode = 'sdk' | 'universal'

export const SDK_PROVIDERS: Set<LLMProvider> =
  new Set(['sdk-claude', 'sdk-codex', 'sdk-gemini'])
```

## Session Management

SDK adapters manage sessions natively:

- **Claude:** `resume` option in `query()`, `listSessions()` / `getSessionMessages()` helpers
- **Codex:** `resumeThread(sessionId)`, sessions in `~/.codex/sessions/`
- **Gemini:** SDK session parameter

Frontend `cli_sessions` store repurposed for SDK sessions:
```typescript
export const agent_sessions = $state<Record<AgentType, string>>({})
// { claude: 'sess-abc', codex: 'thread-xyz', gemini: 'conv-123' }
```

Session list UI (existing Sessions tab) calls `/api/agent/sessions?agent=claude` which delegates to `adapter.listSessions()`.

## MCP Server Configuration

Each adapter auto-configures MCP to point at the running Python backend:

```typescript
const mcpServers = {
  catgo: {
    type: 'http',
    url: `http://localhost:${serverPort}/api/mcp`
  }
}
```

The `serverPort` is derived from `CATGO_API` env var or defaults to `8000 + worktree_offset`. Same logic as current `cli_agents.py:_get_catgo_api_url()`.

## Code to Remove

After SDK bridge is stable:

1. **Backend:** `server/catgo/routers/chat_multi/cli_agents.py` — subprocess spawning, banner filtering, output parsing (~650 lines)
2. **Backend:** CLI agent config in `providers.py` — `CLI_AGENTS` dict, `_build_cli_command()`, sandbox setup
3. **Frontend:** `structure-tools.ts` — 44+ frontend tool definitions (780 lines). Tools now go through MCP only.
4. **Frontend:** `structure-tool-executor.ts` — frontend tool dispatch
5. **Frontend:** `workflow-tool-executor.ts` — frontend workflow tool dispatch
6. **Frontend:** `file-tools.ts`, `file-tool-executor.ts` — frontend file tools
7. **Frontend:** `run_tool_loop()` in `chat-state.svelte.ts` — agentic loop (SDK handles this internally)
8. **Frontend:** `stream_chat_with_tools()` / `stream_anthropic_direct()` / `stream_openai_direct()` / `stream_proxy()` in `llm-client.ts`
9. **Frontend:** Tool registration in `Structure.svelte` / `WorkflowEditor.svelte`
10. **Provider types:** `anthropic`, `openai`, `cli-claude`, `cli-gemini`, `cli-codex`, `direct`/`proxy`/`cli` modes

This removes ~2000+ lines of code and eliminates the two-tool-definition-set sync problem.

## New Dependencies

```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.69",
  "@openai/codex-sdk": "^0.117.0",
  "@ketd/gemini-cli-sdk": "^0.4.0"
}
```

All three are Node.js packages, running server-side only in SvelteKit.

## Multimodal Input

### Capability Matrix

| Input Type | Claude SDK | Codex SDK | Gemini SDK | Handling |
|------------|-----------|-----------|------------|----------|
| Text | native | native | native | All adapters pass through |
| Image | `ImageBlockParam` (base64/URL) | CLI `--image` only | Unstable | Claude: native. Others: save to temp file, reference in prompt |
| PDF | `DocumentBlockParam` (Files API) | Not supported | Unstable | Claude: native. Others: extract text server-side, inject into prompt |
| Other files | Via Read tool (agent reads file) | Via Read tool | Via Read tool | Save to cwd, tell agent "file saved at {path}, please read it" |
| Voice | N/A (frontend handles) | N/A | N/A | Existing voice engine (Web Speech API + Whisper) transcribes to text, feeds into `send_message()` unchanged |

### Stream Request with Attachments

```typescript
// POST /api/agent/stream — extended request body
{
  agent: 'claude' | 'codex' | 'gemini',
  prompt: string,
  sessionId?: string,
  model?: string,
  attachments?: Attachment[]
}

interface Attachment {
  type: 'image' | 'pdf' | 'file'
  name: string
  mimeType: string
  data: string  // base64
}
```

### Adapter Attachment Handling

**Claude adapter** (full multimodal):
```typescript
// Convert attachments to MessageParam content blocks
const content: ContentBlockParam[] = []
for (const att of attachments) {
  if (att.type === 'image') {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: att.mimeType, data: att.data }
    })
  } else if (att.type === 'pdf') {
    // Use Anthropic Files API: upload → get file_id → DocumentBlockParam
    content.push({
      type: 'document',
      source: { type: 'file', file_id: uploadedFileId }
    })
  }
}
content.push({ type: 'text', text: prompt })
// Pass as MessageParam to query()
```

**Codex / Gemini adapters** (graceful degradation):
- **Image**: Save base64 to temp file in agent cwd, prepend to prompt: `"[Image attached: {path}] {prompt}"`. Codex can use `--image` flag if available.
- **PDF**: Extract text server-side using a lightweight parser (e.g., `pdf-parse`), prepend extracted text to prompt: `"[PDF content from {name}]:\n{extracted_text}\n\n{prompt}"`
- **Other files**: Save to agent cwd, prepend: `"[File saved at {path}, please read it] {prompt}"`

### Frontend Input UI

**ChatPane.svelte input area extensions:**

1. **Attachment button** (paperclip icon) next to send button:
   - Click opens file picker (accept: `image/*,.pdf,.cif,.xyz,.poscar,.vasp,*`)
   - Materials science file types (.cif, .xyz, .poscar, .vasp) prioritized in picker

2. **Drag-and-drop zone** over the input area:
   - Drop overlay appears on dragenter
   - Accepts multiple files
   - Each file converted to base64, added to pending attachments list

3. **Clipboard paste** (Ctrl+V / Cmd+V):
   - Intercept paste events in input area
   - If clipboard contains image data, capture as base64 attachment
   - If clipboard contains files, add as attachments

4. **Attachment preview strip** between input box and message area:
   ```
   ┌────────────────────────────────────────────────┐
   │ [img] photo.png  [pdf] paper.pdf  [x] [x]     │
   ├────────────────────────────────────────────────┤
   │ Ask about this structure...          [📎] [▶]  │
   └────────────────────────────────────────────────┘
   ```
   - Image attachments: thumbnail preview (64x64)
   - PDF attachments: file icon + name + page count
   - Other files: file type icon + name + size
   - Each with an [x] remove button

5. **Size limits**:
   - Single file: 20MB max (Claude API limit for images is 20MB)
   - Total attachments per message: 50MB
   - Image resolution: auto-downscale if > 8000px on any side
   - Validation before upload with user-friendly error messages

### Voice Input

The existing voice infrastructure in `src/lib/gesture/` is fully compatible:

- `voice-engine.ts` — Web Speech API with continuous recognition
- `whisper-voice-engine.ts` — Local Whisper model for offline/accurate recognition
- `audio-pipeline.ts` — Mic input with RNNoise noise suppression
- `tts-engine.ts` — Text-to-speech output

Voice transcription produces text → feeds into `send_message()` → goes through SDK path like any text input. No changes needed to voice infrastructure.

## What Does NOT Change

- Python backend (FastAPI, MCP server, workflow engine, structure operations)
- `universal` mode for OpenAI-compatible providers
- ChatPane.svelte overall layout (messages, settings panel, input box)
- Structure viewer, workflow editor, analysis panels
- Desktop/Tauri build paths
- Voice input infrastructure (`src/lib/gesture/`)

## Migration Path

1. Build SDK bridge layer + server routes (no frontend changes yet)
2. Add `sdk-claude` adapter first, test end-to-end with MCP
3. Add PermissionCard + ToolProgressBlock components
4. Wire `chat-state.svelte.ts` to new SSE format
5. Add `sdk-codex` and `sdk-gemini` adapters
6. Add multimodal input UI (attachment button, drag-drop, paste, preview strip)
7. Test all three agents with CatGo tools + attachments
8. Remove old providers and dead code
