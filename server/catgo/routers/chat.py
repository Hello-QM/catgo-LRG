"""AI Chat assistant proxy — streams LLM responses via SSE."""

import json
import logging
import os
import shutil
import socket
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatStreamRequest(BaseModel):
    messages: list[ChatMessage]
    provider: str = "anthropic"  # "anthropic" | "openai"
    model: str = "claude-sonnet-4-20250514"
    temperature: float = 0.3
    max_tokens: int = 2048
    system: Optional[str] = None


async def stream_anthropic(req: ChatStreamRequest):
    """Stream from Anthropic Messages API."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        yield f"data: {json.dumps({'error': 'ANTHROPIC_API_KEY not set on server. Enter your API key in chat settings instead.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    body = {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "messages": [m.model_dump() for m in req.messages],
        "stream": True,
    }
    if req.system:
        body["system"] = req.system

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            "https://api.anthropic.com/v1/messages",
            headers=headers,
            json=body,
        ) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                logger.error("Anthropic API error %d: %s", response.status_code, error_body)
                yield f"data: {json.dumps({'error': f'API error {response.status_code}'})}\n\n"
                return

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if data.get("type") == "content_block_delta":
                        delta = data.get("delta", {})
                        text = delta.get("text", "")
                        if text:
                            yield f"data: {json.dumps({'text': text})}\n\n"
                    elif data.get("type") == "message_stop":
                        break
                except json.JSONDecodeError:
                    continue

    yield "data: [DONE]\n\n"


async def stream_openai(req: ChatStreamRequest):
    """Stream from OpenAI Chat Completions API."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        yield f"data: {json.dumps({'error': 'OPENAI_API_KEY not set on server. Enter your API key in chat settings instead.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    messages = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.extend([m.model_dump() for m in req.messages])

    body = {
        "model": req.model,
        "messages": messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=body,
        ) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                logger.error("OpenAI API error %d: %s", response.status_code, error_body)
                yield f"data: {json.dumps({'error': f'API error {response.status_code}'})}\n\n"
                return

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    text = delta.get("content", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
                except json.JSONDecodeError:
                    continue

    yield "data: [DONE]\n\n"


@router.post("/stream")
def chat_stream(req: ChatStreamRequest):
    """Proxy LLM streaming responses as SSE."""
    if req.provider == "openai":
        generator = stream_openai(req)
    else:
        generator = stream_anthropic(req)

    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ─── Provider discovery ───────────────────────────────────────────────────────
#
# The frontend (`src/lib/chat/llm-client.ts:fetch_providers`) calls
# GET /api/chat/providers on mount to decide which entries show "(not
# installed)" in the CatBot dropdown. Without this endpoint every provider
# defaulted to `available=false` and the user couldn't tell Claude Code from
# DeepSeek even when the CLI was on PATH.
#
# Detection strategy:
#   - SDK CLI agents (sdk-claude / sdk-gemini / sdk-codex): `shutil.which`
#     against the binary name. CLIs installed via npm -g land in PATH.
#   - OpenAI-compatible API providers (deepseek / qwen / kimi / zhipu /
#     gemini): API key env var present (matches `stream-openai-compat`
#     resolution table in `docs-chunks.json`).
#   - Ollama: TCP probe localhost:11434 — running ≠ installed but only the
#     running case is useful from the UI's perspective.
#
# Model lists stay deliberately short. The frontend can override via the
# SDK option override; this only seeds the dropdown.

_CLI_BINARIES = {
    "sdk-claude": ("claude", "Claude Code"),
    "sdk-gemini": ("gemini", "Gemini CLI"),
    "sdk-codex": ("codex", "Codex CLI"),
}

_API_PROVIDERS = {
    "deepseek": ("DeepSeek", "DEEPSEEK_API_KEY"),
    "qwen": ("Qwen (通义千问)", "DASHSCOPE_API_KEY"),
    "kimi": ("Kimi (月之暗面)", "MOONSHOT_API_KEY"),
    "zhipu": ("Zhipu GLM (智谱清言)", "ZHIPUAI_API_KEY"),
    "gemini": ("Gemini", "GEMINI_API_KEY"),
}

# Model lists — minimal seed for the dropdown. The Anthropic SDK accepts the
# short aliases ("opus" / "sonnet" / "haiku") and resolves them to the
# latest stable model in that family, so the dropdown stays valid across
# Anthropic releases without us needing to rev these strings on every model
# launch.
_SDK_CLAUDE_MODELS = [
    {"id": "sonnet", "label": "Default (Sonnet 4.6)"},
    {"id": "opus", "label": "Opus 4.7"},
    {"id": "haiku", "label": "Haiku 4.5"},
]

# Empirically verified against this user's ChatGPT-account Codex on
# @openai/codex 0.132.0-alpha.1 (other gpt-5* variants returned
# "not supported when using Codex with a ChatGPT account").
_SDK_CODEX_MODELS = [
    {"id": "gpt-5.5",       "label": "Default (GPT-5.5)"},
    {"id": "gpt-5.4",       "label": "GPT-5.4"},
    {"id": "gpt-5.4-mini",  "label": "GPT-5.4 mini"},
    {"id": "gpt-5.3-codex", "label": "GPT-5.3 Codex"},
]

# Empirically verified against gemini-cli 0.42.0 + this user's OAuth account.
_SDK_GEMINI_MODELS = [
    {"id": "gemini-2.5-pro",        "label": "Default (Gemini 2.5 Pro)"},
    {"id": "gemini-2.5-flash",      "label": "Gemini 2.5 Flash"},
    {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"},
    {"id": "gemini-3-pro-preview",  "label": "Gemini 3 Pro (preview)"},
]

# Dispatch table — list_providers() looks up the seed by provider id.
_SDK_MODELS = {
    "sdk-claude": _SDK_CLAUDE_MODELS,
    "sdk-codex":  _SDK_CODEX_MODELS,
    "sdk-gemini": _SDK_GEMINI_MODELS,
}

_API_MODELS = {
    "deepseek": [
        {"id": "deepseek-chat", "label": "DeepSeek V3"},
        {"id": "deepseek-reasoner", "label": "DeepSeek R1"},
    ],
    "qwen": [{"id": "qwen-plus", "label": "Qwen Plus"}],
    "kimi": [{"id": "moonshot-v1-8k", "label": "Kimi 8k"}],
    "zhipu": [{"id": "glm-4", "label": "GLM-4"}],
    "gemini": [{"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"}],
}


def _ollama_running(host: str = "127.0.0.1", port: int = 11434, timeout: float = 0.3) -> bool:
    """Cheap TCP probe — connect()=success means a listener is bound."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


@router.get("/providers")
def list_providers() -> dict:
    """Return the provider catalogue with live availability flags."""
    providers: list[dict] = []

    for pid, (binary, label) in _CLI_BINARIES.items():
        providers.append({
            "id": pid,
            "name": label,
            "type": "cli",
            "available": shutil.which(binary) is not None,
            "models": _SDK_MODELS.get(pid, []),
            "base_url": None,
        })

    for pid, (label, env_key) in _API_PROVIDERS.items():
        providers.append({
            "id": pid,
            "name": label,
            "type": "api",
            "available": bool(os.environ.get(env_key)),
            "models": _API_MODELS.get(pid, []),
            "base_url": None,
        })

    providers.append({
        "id": "ollama",
        "name": "Ollama (Local)",
        "type": "local",
        "available": _ollama_running(),
        "models": [],
        "base_url": "http://127.0.0.1:11434",
    })

    return {"providers": providers}


# ─── Provider connection test ─────────────────────────────────────────────────
#
# Backs the CatBot settings "Test Connection" button. The frontend
# (`src/lib/chat/ChatPane.svelte:test_provider_connection`) POSTs the current
# config and expects `{success, latency_ms}` on success or
# `{success: False, error}` on failure. Without this route the button hit a
# bare 404 and silently reported "Cannot reach backend server".

# OpenAI-compatible base URLs for the universal API providers. `GET /models`
# with `Authorization: Bearer <key>` is the cheapest call that proves both
# reachability and that the key is valid (no tokens spent).
_API_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi": "https://api.moonshot.cn/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}

# Maps an SDK CLI provider to its npm package, so on Windows we can probe the
# vendored native binary under %APPDATA%\npm — `shutil.which` only sees the
# sh-shim there, same trap the agent-bridge adapter hit.
_CLI_NPM_PKG = {
    "sdk-claude": "@anthropic-ai/claude-code",
    "sdk-codex": "@openai/codex",
}


class ProviderTestRequest(BaseModel):
    provider_id: str
    api_key: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None


def _resolve_cli(provider_id: str) -> Optional[str]:
    """Resolve an SDK CLI binary for an honest availability signal."""
    binary, _ = _CLI_BINARIES[provider_id]
    found = shutil.which(binary)
    if found:
        return found
    appdata = os.environ.get("APPDATA")
    pkg = _CLI_NPM_PKG.get(provider_id)
    if appdata and pkg:
        cand = os.path.join(
            appdata, "npm", "node_modules", *pkg.split("/"), "bin", binary + ".exe"
        )
        if os.path.exists(cand):
            return cand
    return None


@router.post("/providers/test")
async def test_provider(req: ProviderTestRequest) -> dict:
    """Validate a provider configuration. See ChatPane.test_provider_connection."""
    pid = req.provider_id

    # SDK/CLI agents — "connected" means the CLI binary is resolvable.
    if pid in _CLI_BINARIES:
        path = _resolve_cli(pid)
        if path:
            return {"success": True, "latency_ms": 0, "detail": path}
        _, label = _CLI_BINARIES[pid]
        return {
            "success": False,
            "error": f"{label} CLI not found on PATH or the npm global prefix.",
        }

    # Ollama — TCP probe, then confirm the HTTP API actually answers.
    if pid == "ollama":
        base = (req.base_url or "http://127.0.0.1:11434").rstrip("/")
        if not _ollama_running():
            return {"success": False, "error": "Ollama is not running on 127.0.0.1:11434."}
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{base}/api/tags")
        except Exception as exc:
            return {"success": False, "error": f"Cannot reach Ollama: {exc}"}
        if r.status_code == 200:
            return {"success": True, "latency_ms": (time.perf_counter() - t0) * 1000}
        return {"success": False, "error": f"Ollama responded HTTP {r.status_code}."}

    # OpenAI-compatible API providers — GET /models with the key.
    if pid in _API_PROVIDERS:
        _, env_key = _API_PROVIDERS[pid]
        api_key = req.api_key or os.environ.get(env_key)
        if not api_key:
            return {
                "success": False,
                "error": f"No API key. Enter one in chat settings or set ${env_key}.",
            }
        base = (req.base_url or _API_BASE_URLS.get(pid, "")).rstrip("/")
        if not base:
            return {"success": False, "error": f"No base URL configured for '{pid}'."}
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(
                    f"{base}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
        except Exception as exc:
            return {"success": False, "error": f"Cannot reach {base}: {exc}"}
        latency = (time.perf_counter() - t0) * 1000
        if r.status_code == 200:
            return {"success": True, "latency_ms": latency}
        if r.status_code in (401, 403):
            return {
                "success": False,
                "error": f"Authentication failed (HTTP {r.status_code}). Check the API key.",
            }
        snippet = r.text[:200].replace("\n", " ")
        return {"success": False, "error": f"HTTP {r.status_code}: {snippet}"}

    return {"success": False, "error": f"Unknown provider '{pid}'."}
