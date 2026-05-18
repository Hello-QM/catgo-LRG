"""AI Chat assistant proxy — streams LLM responses via SSE."""

import json
import logging
import os
import shutil
import socket
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, HttpUrl

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


class UniversalChatMessage(BaseModel):
    role: str
    content: str | list | dict


class UniversalStreamRequest(BaseModel):
    messages: list[UniversalChatMessage]
    model: str
    temperature: float = 0.3
    max_tokens: int = 2048
    system: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None


class ProviderTestRequest(BaseModel):
    provider_id: str = "custom"
    api_key: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None


class ProviderModelsRequest(BaseModel):
    base_url: str
    api_key: Optional[str] = None


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

_API_BASE_URLS = {
    "deepseek": "https://api.deepseek.com/v1",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi": "https://api.moonshot.cn/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ollama": "http://127.0.0.1:11434/v1",
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
            "models": _SDK_CLAUDE_MODELS if pid == "sdk-claude" else [],
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
