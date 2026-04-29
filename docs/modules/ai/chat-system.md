---
title: Chat System
description: AI assistant architecture and LLM integration
source: src/lib/chat/ChatPane.svelte
---

# Chat System

**Source:** `src/lib/chat/ChatPane.svelte`, `src/lib/chat/llm-client.ts`, `src/lib/chat/chat-state.svelte.ts`

## Overview

The chat system provides a conversational AI interface integrated with CatGO's tools. It uses large language models with tool-calling capabilities to assist with materials science tasks.

## Architecture

### ChatPane

The UI component for the chat interface with message history, input, and tool execution feedback.

### LLM Client

Manages communication with LLM backends (OpenAI-compatible APIs).

### Chat State

Svelte 5 reactive state management for conversation history and active sessions.

### Context System

Provides relevant context (current structure, analysis results) to the LLM for informed responses.

### RAG (Retrieval-Augmented Generation)

Optional retrieval from documentation and past conversations for improved accuracy.

## Tool Integration

SDK agents (claude / codex / gemini) invoke catgo tools through the HTTP MCP server (`server/mcp_tools/server.py`). All structure manipulation and workflow operations are exposed as `mcp__catgo__*` tools and approved per-call via the in-conversation PermissionCard. See:
- [Workflow Tools](/modules/ai/workflow-tools) — Create workflows

## Server API

**Endpoints:**
- `POST /api/chat` — Single-turn chat
- `POST /api/chat/multi` — Multi-turn conversation

## Related

- [AI Chat Tutorial](/tutorials/ai/ai-chat)
- [Workflow Tools](/modules/ai/workflow-tools)
