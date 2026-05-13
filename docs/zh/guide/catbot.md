# CatBot — AI 聊天助手

CatBot 是 CatGo 内置的 AI 助手。用自然语言提需求 —— *"从 Materials Project 拿 Cu，切个 (100) 平板"*、*"用 MACE 优化，0.05 eV/Å"* —— CatBot 通过工具调用直接驱动查看器、工作流引擎、分析工具。

## 提供方

CatBot 支持三家模型提供方。在 *Settings → Chat* 切换。

| 提供方 | 后端 SDK | 适用场景 |
|--------|----------|----------|
| **Claude** | [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) via `catgo-agent` sidecar | 长链路推理、密集工具调用、文件编辑 |
| **Gemini** | [`@ketd/gemini-cli-sdk`](https://www.npmjs.com/package/@ketd/gemini-cli-sdk) | 多模态输入（图像）、快速迭代 |
| **Codex** | [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) | 代码生成、脚本编写 |

支持对话过程中切换；每家提供方的会话历史独立保存。

## 架构

打包构建中，CatBot 通过 **`catgo-agent`** sidecar 进程运行。该 sidecar 是个轻量 Node 服务，承载选定 SDK，通过 Server-Sent Events 把响应流回前端。

```
┌─────────────┐    SSE     ┌──────────────────┐    SDK    ┌──────────────────┐
│  CatGo UI   │ ◄────────► │  catgo-agent     │ ◄───────► │  Claude / Gemini │
│  (Tauri)    │            │  Node sidecar    │           │  / Codex API     │
└─────────────┘            └──────────────────┘           └──────────────────┘
                                    │
                                    │ HTTP
                                    ▼
                          ┌──────────────────┐
                          │  catgo-server    │  ← MCP /api/mcp/
                          │  Python sidecar  │  ← 工作流引擎
                          └──────────────────┘
```

从 v1.0.1 起，sidecar 已打包进所有桌面安装包 —— 用户无需另装 Node。

## 工具调用

CatBot 可直接驱动以下 CatGo 子系统：

| 工具 | CatBot 行为 |
|------|-------------|
| `catgo_structure load_file` | 加载结构文件到查看器 |
| `catgo_structure export` | 读出当前结构（返回文本） |
| `catgo_structure merge` | 合并两个结构，重定位吸附质等 |
| `catgo_database fetch` | 从 Materials Project / OPTIMADE / PubChem 拉结构 |
| `catgo_build slab` | 按 Miller 指数切平板 |
| `catgo_build supercell` | 构建超胞 |
| `catgo_workflow submit` | 通过工作流引擎提交 DFT / ML 作业 |
| `catgo_analysis dos` / `band` / `cohp` | 对已完成作业跑相应分析 |

MCP 服务（`/api/mcp/`）向外部 agent 暴露同样的工具集 —— 例如可在笔记本上从 Claude Code 通过反向隧道驱动 CatGo。详见 [MCP Server](/modules/server/mcp-server)。

## 配置

CatBot 工作目录在 `~/.catgo/agents/<provider>/`。Claude 提供方下包含 agent transcript、MCP 配置、SDK 创建的文件等。

自定义系统提示在 *Settings → Chat → System Prompt*。CatGo 内置两个起步提示（standard + enhanced），位于 `docs/claude_prompt_standard.txt` 与 `docs/claude_prompt_enhanced.txt`。

## API 密钥

CatBot 从环境变量或 *Settings* 对话框读 API 密钥。密钥加密存储于操作系统钥匙串（macOS Keychain / Windows Credential Manager / Linux libsecret）：

| 提供方 | 变量名 |
|--------|--------|
| Claude | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Codex | `OPENAI_API_KEY` |

## 故障排查

- **"native binary not found"** — Claude SDK 找不到 `claude` CLI。安装（`npm i -g @anthropic-ai/claude-cli`），或切到 Gemini / Codex。v1.0.1 已修 —— `resolveClaudeExecutable()` 增加 `PATH` 回退查找。
- **流式响应中途停顿** — sidecar 的 SSE 断开。聊天面板重启 CatBot；会话历史保存在 `~/.catgo/agents/<provider>/`。
- **工具调用作用错了面板** — CatBot 默认 `panel_id=default`。工具调用中传 `panel_id=structure-1`（或当前活动面板），或在 prompt 中明确面板。
