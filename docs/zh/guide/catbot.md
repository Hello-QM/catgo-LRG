# CatBot — AI 聊天助手

CatBot 是 CatGo 内置的 AI 助手。你可以用自然语言输入请求，例如 *"fetch Cu from Materials Project and cut a (100) slab"* 或 *"optimize this with MACE at 0.05 eV/Å"*，CatBot 会通过工具调用直接驱动查看器、工作流引擎和分析工具。

## 提供方

CatBot 支持三个模型 provider。可在 *Settings -> Chat* 中切换。

| Provider | Backend SDK | 适合场景 |
|----------|-------------|----------|
| **Claude** | 通过 `catgo-agent` sidecar 使用 [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | 长文本推理、工具密集型工作流、文件编辑 |
| **Gemini** | [`@ketd/gemini-cli-sdk`](https://www.npmjs.com/package/@ketd/gemini-cli-sdk) | 多模态输入（图片）、快速迭代 |
| **Codex** | [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) | 代码生成、脚本编写 |

你可以在会话中途切换 provider；CatBot 会按 provider 持久化会话历史。

## 架构

在打包构建中，CatBot 会通过名为 **`catgo-agent`** 的 sidecar 进程运行。这个 sidecar 是一个很小的 Node server，用来承载所选 SDK，并通过 Server-Sent Events 把响应流式返回给前端。

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
                          │  Python sidecar  │  ← Workflow engine
                          └──────────────────┘
```

从 v1.0.1 开始，每个桌面安装包都会内置 sidecar，不需要用户额外安装 Node。

## 工具调用

CatBot 可以直接驱动这些 CatGo 子系统：

| 工具 | CatBot 的操作 |
|------|------------------|
| `catgo_structure load_file` | 将结构文件加载到查看器中 |
| `catgo_structure export` | 读取当前结构（返回文本） |
| `catgo_structure merge` | 合并两个结构、重新定位吸附物等 |
| `catgo_database fetch` | 从 Materials Project / OPTIMADE / PubChem 拉取结构 |
| `catgo_build slab` | 根据 Miller 指数切 slab |
| `catgo_build supercell` | 构建超胞 |
| `catgo_workflow submit` | 通过工作流引擎提交 DFT / ML 作业 |
| `catgo_analysis dos` / `band` / `cohp` | 对已完成作业运行对应分析 |

MCP 服务器（`/api/mcp/`）会向外部 agent 暴露同一套工具表面。例如，你可以通过反向隧道在笔记本上的 Claude Code 中驱动 CatGo。详情见 [MCP 服务器](/zh/modules/server/mcp-server)。

## 配置

CatBot 会把工作目录写入 `~/.catgo/agents/<provider>/`。对于 Claude，这里包含 agent transcript、MCP 配置，以及 SDK 创建的文件。

可在 *Settings -> Chat -> System Prompt* 中提供自定义 system prompt。CatGo 在 `docs/claude_prompt_standard.txt` 和 `docs/claude_prompt_enhanced.txt` 中提供了两个起始 prompt（standard + enhanced）。

## API 密钥

CatBot 会从环境变量或 *Settings* 对话框读取 provider API key。密钥会加密存储在操作系统 keychain 中（macOS Keychain、Windows Credential Manager、Linux libsecret）：

| Provider | Variable |
|----------|----------|
| Claude | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Codex | `OPENAI_API_KEY` |

## 故障排查

- **"native binary not found"** - Claude SDK 找不到 `claude` CLI。安装它（`npm i -g @anthropic-ai/claude-cli`），或切换到 Gemini / Codex。v1.0.1 已修复该问题，`resolveClaudeExecutable()` 现在会回退到 `PATH` 查找。
- **Stream stalls mid-response** - sidecar 的 SSE 连接中断。可从聊天面板重启 CatBot；transcript 会保留在 `~/.catgo/agents/<provider>/` 下。
- **Tool call returns wrong panel** - CatBot 默认使用 `panel_id=default`。请在工具调用中传入 `panel_id=structure-1`（或当前活动面板），也可以在 prompt 中指定面板。
