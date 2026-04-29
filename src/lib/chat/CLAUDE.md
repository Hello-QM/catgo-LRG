# src/lib/chat/ — AI 聊天系统

## 架构概述

```
ChatPane.svelte             UI 层（消息列表、设置面板、输入框、附件、PermissionCard、ToolProgressBlock）
chat-state.svelte.ts        状态中心（消息、会话、SDK agent 调用 + Universal 文本流）
llm-client.ts               Universal (OpenAI 兼容) HTTP 客户端 + SDK system prompt builder
sdk-stream.ts               SDK agent SSE 客户端 (POST /api/agent/stream → AgentEvent stream)
types.ts                    类型定义（LLMProvider/AgentType/ChatConfig/AgentEvent 等）
tools.ts                    简单视图工具类型（保留为类型 only）
workflow-tools.ts           Workflow 工具名注册 + skill 路径映射
workflow-tool-executor.ts   Workflow 动作处理器注册（WorkflowEditor 注册 mutation handler）
permission-store.svelte.ts  Permission Card 状态存储
tool-execution.ts           工具执行结果消息辅助
attachment-utils.ts         附件 base64/类型探测
context.ts                  Structure / Workflow / Paper 上下文构建
rag.ts                      docs RAG 检索
markdown.ts / message-utils.ts  消息渲染辅助
```

## 工具执行流程

### SDK Agent 路径（claude / codex / gemini）
```
用户消息 → send_message() → agent_from_provider(provider) → stream_sdk_agent({agent, prompt, ...})
  → POST /api/agent/stream (SvelteKit route)
  → src/lib/server/agent-bridge/adapters/{claude,codex,gemini}.ts
  → 官方 Agent SDK 的 query() 函数（同进程异步迭代器）
  → SDK 通过 HTTP MCP 直接调 catgo MCP server (mcp_server.py / server_claude_code.py)
  → canUseTool 回调把 PermissionRequest 推回前端 (PermissionCard)
  → 工具结果走 SSE 回到前端 → active_tool_blocks 更新 → ToolProgressBlock 渲染
```

### Universal 路径（Zhipu GLM / DeepSeek / Qwen / Kimi / Ollama / Gemini API）
```
用户消息 → send_message() → stream_chat() → stream_universal()
  → POST /api/chat/stream-universal (FastAPI 后端)
  → 后端转发到对应 OpenAI 兼容 endpoint
  → 文本流通过 SSE 回到前端
```

Universal 模式**无工具**——纯文本对话。所有 tool use 都走 SDK agent 路径。

## Session 管理

- `agent_sessions: Record<AgentType, string>` (chat-state.svelte) — 每个 SDK agent 一个活跃 session id
- SDK 续跑：`stream_sdk_agent({sessionId})` → SDK `query({options.resume: sid})` 原生支持
- 历史持久化：每个 session 的完整聊天 + 元数据存 `localStorage:catgo-chat-session-{session_id}`
- Session 列表：`/api/agent/sessions?agent=claude` 调 SDK 的 listSessions()

## Permission Flow（仅 SDK agents）

```
1. SDK 解析到 tool_use → 调 canUseTool(toolName, input)
2. agent-bridge 的 permission-manager.registerPending(id, ...) 返回 Promise（SDK 阻塞）
3. 对应 adapter 在 SSE 流里 yield {type: 'permission_request', id, toolName, input}
4. chat-state 收到事件 → active_permission_blocks.entries[id] = {status: 'pending', ...}
5. ChatPane 渲染 PermissionCard
6. 用户点 Allow / Allow Session / Deny → POST /api/agent/permission { id, behavior }
7. permission-manager.resolvePending(id, behavior) → Promise resolve → SDK 继续
8. catgo MCP 工具自动放行（adapters/claude.ts:`toolName.startsWith('mcp__catgo__')`）
```

Codex 例外：用静态 `approvalPolicy: 'on-request'`，不弹 PermissionCard。

## Model List

- 后端 `/api/chat/providers` 返回 `[{id, label}]`，前端 `get_models()` 优先后端，`FALLBACK_MODELS`（在 `message-utils.ts`）兜底

## 已知陷阱

- **Svelte 5 `$derived.by()` vs 函数调用**：session 列表等必须用 `$derived.by()` 才能在 `$state` 变化时触发重新渲染，纯函数调用不行
- **`friendly_error()` 掩盖真实错误**：`ChatPane.svelte` 中 `Failed to fetch` 被统一替换为 "Connection failed"，排查时需看浏览器 console
- **附件大小限制**：单文件 20MB，单消息总附件 50MB；图像超 8000px 自动降采样
- **Universal 模式无工具**：仅 SDK agents 走 catgo MCP 工具调用。Zhipu/GLM/DeepSeek 等模型只能聊天，不能直接驱动 catgo 操作。如需让这些模型也用工具，需要重新引入函数调用桥（已在 2026-03-29 SDK bridge 迁移中删除）

时效性说明:

- 此处描述对应 2026-03-29 SDK bridge 迁移之后的现行架构
- workflow / CatBot 当前未修复问题以根目录 `WORKFLOW_BUGS.md` 和 `reports/bug-*.md` 为准
