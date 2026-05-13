# CatBot — AI Chat Assistant

CatBot is the built-in AI assistant inside CatGo. Type a request in plain language — *"fetch Cu from Materials Project and cut a (100) slab"*, *"optimize this with MACE at 0.05 eV/Å"* — and CatBot drives the viewer, the workflow engine, and the analysis tools directly via tool calls.

## Providers

CatBot supports three model providers. Switch in *Settings → Chat*.

| Provider | Backend SDK | Best for |
|----------|-------------|----------|
| **Claude** | [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) via `catgo-agent` sidecar | Long-form reasoning, tool-heavy workflows, file editing |
| **Gemini** | [`@ketd/gemini-cli-sdk`](https://www.npmjs.com/package/@ketd/gemini-cli-sdk) | Multi-modal input (images), fast iteration |
| **Codex** | [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) | Code generation, scripting |

You can switch providers mid-conversation; CatBot persists session history per provider.

## Architecture

In packaged builds, CatBot runs through a sidecar process called **`catgo-agent`**. The sidecar is a tiny Node server that hosts the chosen SDK and streams responses back to the frontend over Server-Sent Events.

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

The sidecar is bundled into every desktop installer starting with v1.0.1 — no separate Node install required.

## Tool Calls

CatBot can drive these CatGo subsystems directly:

| Tool | What CatBot does |
|------|------------------|
| `catgo_structure load_file` | Loads a structure file into the viewer |
| `catgo_structure export` | Reads the current structure (returns text) |
| `catgo_structure merge` | Merges two structures, repositions adsorbate, etc. |
| `catgo_database fetch` | Pulls a structure from Materials Project / OPTIMADE / PubChem |
| `catgo_build slab` | Cuts a slab from Miller indices |
| `catgo_build supercell` | Builds a supercell |
| `catgo_workflow submit` | Submits a DFT / ML job through the workflow engine |
| `catgo_analysis dos` / `band` / `cohp` | Runs the corresponding analysis on a finished job |

The MCP server (`/api/mcp/`) exposes the same tool surface to external agents — e.g. you can drive CatGo from Claude Code on your laptop over a reverse tunnel. See [MCP Server](/modules/server/mcp-server) for details.

## Configuration

CatBot writes its working directory under `~/.catgo/agents/<provider>/`. For Claude this contains the agent transcript, MCP config, and any files the SDK creates.

Custom system prompts can be supplied in *Settings → Chat → System Prompt*. CatGo ships two starter prompts (standard + enhanced) at `docs/claude_prompt_standard.txt` and `docs/claude_prompt_enhanced.txt`.

## API Keys

CatBot reads provider API keys from environment variables or the *Settings* dialog. Keys are stored encrypted in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux):

| Provider | Variable |
|----------|----------|
| Claude | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Codex | `OPENAI_API_KEY` |

## Troubleshooting

- **"native binary not found"** — the Claude SDK couldn't find the `claude` CLI. Install it (`npm i -g @anthropic-ai/claude-cli`) or switch to Gemini / Codex. Fixed in v1.0.1 — `resolveClaudeExecutable()` now falls back to `PATH` lookups.
- **Stream stalls mid-response** — the sidecar dropped the SSE connection. Restart CatBot from the chat pane; transcript is preserved on disk under `~/.catgo/agents/<provider>/`.
- **Tool call returns wrong panel** — CatBot defaults to `panel_id=default`. Pass `panel_id=structure-1` (or whichever pane is active) in the tool call, or specify the panel in your prompt.
