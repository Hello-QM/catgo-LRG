---
title: 论文导入
description: 面向论文上下文对话的 PDF 与 DOI 导入
source: server/catgo/routers/paper.py
---

# 论文导入

**Source:** `server/catgo/routers/paper.py`, `server/catgo/models/paper.py`

论文导入模块会把科研论文纳入 CatGo 的会话存储，使 CatBot 在构建工作流时可以引用论文内容。支持两种导入路径：直接上传 PDF，以及通过 CrossRef 元数据解析 DOI。

本模块是数据导入层。后续“告诉 CatBot 这篇论文内容并让它构建工作流”的流程通过普通 CatBot 聊天轮次完成；这里没有自动的论文到工作流提取器。

## 本模块的作用

- **PDF 上传** — 接收 PDF，提取文本内容，并存入带 TTL 管理的会话
- **DOI 解析** — 通过 CrossRef 解析 DOI，获取标题、作者、摘要和元数据
- **会话存储** — 以 session ID 为键在内存中保存论文文本和元数据，并在 TTL 到期后自动清理
- **文本检索** — 返回提取出的文本，用于增强聊天上下文

## 本模块不做什么

- 不会从论文 PDF 中自动提取参数（泛函、k 点、截断能等）；这是由 CatBot prompt 驱动的任务，不是后端功能
- 不会根据论文方法部分自动生成工作流；用户需要在聊天中描述论文方法，再让 CatBot 构建工作流

## 服务器 API

所有端点都位于 `/paper` 前缀下：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/paper/upload` | `POST` | 上传 PDF；返回 `session_id` 和解析出的元数据 |
| `/paper/{session_id}` | `GET` | 获取会话信息（标题、作者、页数、过期时间） |
| `/paper/{session_id}/text` | `GET` | 获取论文正文的提取文本 |
| `/paper/resolve-doi` | `POST` | 通过 CrossRef 解析 DOI；返回元数据但不存储 |
| `/paper/{session_id}` | `DELETE` | 在 TTL 到期前手动清理会话 |

## 数据模型

### `PaperSessionInfo`

- `session_id` — 内存会话的 UUID
- `title` — 论文标题（来自 PDF 元数据或第一个标题）
- `authors` — 作者列表（可提取时）
- `created_at` — 会话创建时间戳
- `expires_at` — TTL 过期时间戳

### `DOIResolveResponse`

返回 CrossRef 元数据：标题、作者、期刊、发表年份、摘要，以及解析后的 DOI URL。

## 典型流程

1. 用户将 PDF 拖入 CatBot，或粘贴 DOI
2. 前端请求 `/paper/upload` 或 `/paper/resolve-doi`，并接收 `session_id`
3. 后续 LLM 调用的聊天上下文会包含论文文本/元数据（见 [`context.ts`](/zh/modules/ai/chat-system)）
4. 用户要求 CatBot 基于论文方法构建工作流；CatBot 通过[工作流工具](/zh/modules/ai/workflow-tools)起草工作流
5. 会话在 TTL 后过期，或被手动删除

## 相关内容

- [论文导入教程](/zh/tutorials/ai/literature-import) — 分步用户指南
- [聊天系统](/zh/modules/ai/chat-system) — 论文上下文如何进入 LLM 调用
- [工作流工具](/zh/modules/ai/workflow-tools) — CatBot 用于构建工作流的工具
