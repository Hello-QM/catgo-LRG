---
title: 聊天系统
description: CatBot，面向结构和工作流操作的应用内 AI 助手
source: src/lib/chat/ChatPane.svelte
---

# 聊天系统（CatBot）

**源码：** `src/lib/chat/`、`server/catgo/routers/chat.py`

CatBot 是应用内 AI 助手。它通过支持工具调用的 LLM，根据自然语言指令驱动结构操作、工作流构建和分析。每一次工具调用都会在运行前显示给用户，并要求用户在界面中逐项确认。

## 架构

```
┌────────────────────────────────────────┐
│ ChatPane.svelte                        │  UI: message list, input, permission cards
├────────────────────────────────────────┤
│ chat-state.svelte.ts                   │  Per-tab message history (persisted to localStorage)
├────────────────────────────────────────┤
│ sdk-stream.ts  +  llm-client.ts        │  SDK + HTTP transport to Claude / Codex / Gemini
├────────────────────────────────────────┤
│ tools.ts  +  workflow-tools.ts         │  Tool schemas exposed to the model
├────────────────────────────────────────┤
│ context.ts  +  rag.ts                  │  Structure-aware context and doc retrieval
└────────────────────────────────────────┘
```

### 组件

- **`ChatPane.svelte`** - 聊天 UI，包括消息列表、输入框、用于工具审批的 `PermissionCard`，以及显示工具执行状态的 `ToolProgressBlock`。
- **`chat-state.svelte.ts`** - 基于 Svelte 5 runes 的响应式会话历史状态。消息按聊天标签页持久化到 `localStorage`（key: `catgo-chat-messages-{tab_id}`），应用启动时会重新加载。
- **`sdk-stream.ts`** - SDK 模式 agent 的流式适配层（Claude Agent SDK、Codex SDK、Gemini CLI SDK）。它把 `user/tool_result` 事件转换为应用内的 `tool_end` 生命周期。
- **`llm-client.ts`** - 直接 API 模式的 HTTP 传输层，适用于没有 SDK 或用户直接配置 API key 的情况。
- **`tools.ts` / `workflow-tools.ts`** - 暴露给模型的工具 schema，包括查看器控制、结构操作、工作流 CRUD 和文件 proposal。
- **`context.ts`** - 为每次 LLM 调用补充当前查看器状态（活动结构、化学式、选中原子），让回答基于用户当前看到的内容。
- **`rag.ts`** - 可选的文档检索层，基于 `pnpm build:doc-chunks` 生成的 `docs-chunks.json`，用于提供有文档依据的回答。

## Provider 后端

CatBot 支持三种 SDK 模式 provider，并提供直接 API 兜底：

| Provider | 连接方式 | 设置 |
|---|---|---|
| **Claude**（推荐） | Claude Agent SDK | 安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)，或设置 `ANTHROPIC_API_KEY` |
| **OpenAI Codex** | Codex SDK | 安装 [Codex CLI](https://github.com/openai/codex)，或设置 `OPENAI_API_KEY` |
| **Gemini** | Gemini CLI SDK | 安装 [Gemini CLI](https://github.com/google-gemini/gemini-cli)，或设置 `GEMINI_API_KEY` |

Provider 会在 CatBot 设置面板中按聊天标签页选择。

## 工具执行与权限

模型发出的每次工具调用都会被拦截，并以 `PermissionCard` 的形式显示在聊天中。用户需要逐项批准后才会执行，不会对破坏性操作自动放行。被批准的调用会执行，并把结果以 `tool_end` 事件流式返回到会话中。

结构和工作流操作会通过 MCP 服务器（`server/catgo/mcp_tools/`）流转，并暴露为 `mcp__catgo__*` 工具。完整工具列表见[工作流工具模块](/zh/modules/ai/workflow-tools)。

## 服务器 API

聊天后端位于 `server/catgo/routers/chat.py`。端点如下：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/chat/stream` | `POST` | 以 Server-Sent Events 流式返回一次聊天轮次 |
| `/chat/providers` | `GET` | 列出可用 LLM provider 及其认证状态 |

## 相关

- [工作流工具](/zh/modules/ai/workflow-tools) - 模型可调用的、用于构建工作流的 MCP 工具
- [AI 聊天教程](/zh/tutorials/ai/ai-chat) - 如何开始和 CatBot 对话
