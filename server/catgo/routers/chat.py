"""AI Chat assistant proxy — streams LLM responses via SSE."""

import asyncio
import base64
import json
import logging
import os
import shutil
import socket
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: Any


def _split_data_uri(value: str) -> tuple[str, str] | None:
    if not value.startswith("data:") or ";base64," not in value:
        return None
    header, data = value[5:].split(";base64,", 1)
    return header or "application/octet-stream", data


def _anthropic_content(content: Any) -> Any:
    """Translate standard OpenAI multimodal parts to Anthropic blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)
    blocks: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get("type")
        if kind == "text":
            blocks.append({"type": "text", "text": str(part.get("text", ""))})
        elif kind == "image_url":
            image = part.get("image_url", {})
            parsed = _split_data_uri(str(image.get("url", ""))) if isinstance(image, dict) else None
            if parsed:
                mime_type, data = parsed
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": data,
                        },
                    }
                )
        elif kind == "file":
            file_info = part.get("file", {})
            if not isinstance(file_info, dict):
                continue
            parsed = _split_data_uri(str(file_info.get("file_data", "")))
            if not parsed:
                continue
            mime_type, data = parsed
            name = str(file_info.get("filename", "attachment"))
            if mime_type == "application/pdf":
                blocks.append(
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": data,
                        },
                        "title": name,
                    }
                )
            else:
                try:
                    decoded = base64.b64decode(data, validate=True).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    decoded = f"[Attached binary file: {name} ({mime_type})]"
                blocks.append(
                    {
                        "type": "text",
                        "text": f"[Attached file: {name}]\n{decoded}\n[End attached file]",
                    }
                )
    return blocks


def _ollama_message(message: ChatMessage) -> dict[str, Any]:
    """Translate multimodal content parts to Ollama's text + images shape."""
    if isinstance(message.content, str):
        return {"role": message.role, "content": message.content}
    text: list[str] = []
    images: list[str] = []
    for part in message.content if isinstance(message.content, list) else []:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            text.append(str(part.get("text", "")))
        elif part.get("type") == "image_url":
            image = part.get("image_url", {})
            parsed = _split_data_uri(str(image.get("url", ""))) if isinstance(image, dict) else None
            if parsed:
                images.append(parsed[1])
        elif part.get("type") == "file":
            file_info = part.get("file", {})
            if isinstance(file_info, dict):
                text.append(f"[Attached file: {file_info.get('filename', 'attachment')}]")
    result: dict[str, Any] = {"role": message.role, "content": "\n".join(text)}
    if images:
        result["images"] = images
    return result


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
        "messages": [
            {"role": message.role, "content": _anthropic_content(message.content)}
            for message in req.messages
        ],
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
    "anthropic": ("Anthropic", "ANTHROPIC_API_KEY"),
    "custom": ("Custom Provider", ""),
}

_API_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi": "https://api.moonshot.cn/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
}

_API_FORMATS = {
    "anthropic": "anthropic",
}

# Model lists — minimal seed for the dropdown. The Anthropic SDK accepts the
# short aliases ("opus" / "sonnet" / "haiku") and resolves them to the
# latest stable model in that family. The labels carry NO version number so the
# dropdown auto-tracks Anthropic releases (the alias always runs the latest) and
# never displays a stale version — no need to rev these strings on every launch.
# Gemini below keeps versions because its ids are specific models, not aliases.
# Codex is discovered dynamically from `codex app-server` further below.
_SDK_CLAUDE_MODELS = [
    {"id": "sonnet", "label": "Default (Sonnet)"},
    {"id": "opus", "label": "Opus"},
    {"id": "haiku", "label": "Haiku"},
]

# Safe fallback for old/unavailable Codex CLIs. An empty id deliberately means
# "do not pass --model": Codex then selects its own current default. Keeping the
# fallback label versionless prevents the UI from presenting stale metadata.
_SDK_CODEX_MODELS_FALLBACK = [{"id": "", "label": "Default"}]
_CODEX_MODEL_CACHE_TTL_SECONDS = 300.0
_CODEX_MODEL_DISCOVERY_TIMEOUT_SECONDS = 5.0
_codex_models_cache: Optional[tuple[str, float, list[dict]]] = None

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
    "sdk-codex":  _SDK_CODEX_MODELS_FALLBACK,
    "sdk-gemini": _SDK_GEMINI_MODELS,
}

_API_MODELS = {
    "deepseek": [
        {"id": "deepseek-v4-flash", "label": "deepseek-v4-flash"},
        {"id": "deepseek-v4-pro", "label": "deepseek-v4-pro"},
    ],
    "qwen": [
        {"id": "qwen3.6-plus", "label": "qwen3.6-plus"},
        {"id": "qwen3.6-max-preview", "label": "qwen3.6-max-preview"},
        {"id": "qwen3.6-flash", "label": "qwen3.6-flash"},
    ],
    "kimi": [
        {"id": "kimi-k2.6", "label": "kimi-k2.6"},
        {"id": "kimi-k2.5", "label": "kimi-k2.5"},
    ],
    "zhipu": [
        {"id": "glm-5.1", "label": "glm-5.1"},
        {"id": "glm-5v-turbo", "label": "glm-5v-turbo"},
    ],
    "gemini": [{"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"}],
    "anthropic": [
        {"id": "claude-sonnet-4-6", "label": "Claude Sonnet 4.6"},
        {"id": "claude-opus-4-7", "label": "Claude Opus 4.7"},
    ],
    "custom": [],
}


_OLLAMA_BASE_URL = "http://127.0.0.1:11434"


async def _discover_codex_models(binary: str) -> list[dict]:
    """Query Codex App Server's official ``model/list`` capability."""
    proc = await asyncio.create_subprocess_exec(
        binary,
        "app-server",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def send(message: dict) -> None:
        if proc.stdin is None:
            raise RuntimeError("Codex App Server stdin is unavailable")
        line = json.dumps(message, separators=(",", ":")) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def receive(response_id: int) -> dict:
        if proc.stdout is None:
            raise RuntimeError("Codex App Server stdout is unavailable")
        while True:
            line = await asyncio.wait_for(
                proc.stdout.readline(),
                timeout=_CODEX_MODEL_DISCOVERY_TIMEOUT_SECONDS,
            )
            if not line:
                raise RuntimeError("Codex App Server closed before returning models")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == response_id:
                return message

    try:
        await send({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "catgo",
                    "title": "CatGo",
                    "version": "1.0.0",
                }
            },
        })
        initialized = await receive(0)
        if initialized.get("error"):
            raise RuntimeError("Codex App Server rejected initialization")
        await send({"method": "initialized", "params": {}})
        await send({
            "method": "model/list",
            "id": 1,
            "params": {"limit": 100, "includeHidden": False},
        })
        response = await receive(1)
    except TimeoutError as exc:
        raise RuntimeError("Codex model discovery timed out") from exc
    finally:
        if proc.stdin is not None:
            proc.stdin.close()
            try:
                await proc.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=1.0)
        except TimeoutError:
            proc.kill()
            await proc.wait()

    if not response or response.get("error"):
        raise RuntimeError("Codex App Server did not return model/list")

    payload = response.get("result", {})
    raw_models = payload.get("data", []) if isinstance(payload, dict) else []
    discovered: list[tuple[bool, dict]] = []
    seen: set[str] = set()
    for item in raw_models:
        if not isinstance(item, dict) or item.get("hidden") is True:
            continue
        model_id = item.get("id") or item.get("model")
        if not isinstance(model_id, str) or not model_id or model_id in seen:
            continue
        seen.add(model_id)
        display_name = item.get("displayName") or item.get("display_name") or model_id
        is_default = item.get("isDefault") is True or item.get("is_default") is True
        discovered.append((
            is_default,
            {
                # Empty means "follow the CLI default". This keeps both the
                # displayed label and the actual selected model future-proof.
                "id": "" if is_default else model_id,
                "label": f"Default ({display_name})" if is_default else display_name,
            },
        ))

    discovered.sort(key=lambda entry: not entry[0])
    models = [model for _, model in discovered]
    if not models:
        raise RuntimeError("Codex App Server returned no visible models")
    return models


async def _get_codex_models(binary: Optional[str]) -> list[dict]:
    """Return live Codex models with a short cache and versionless fallback."""
    global _codex_models_cache

    if not binary:
        return [dict(model) for model in _SDK_CODEX_MODELS_FALLBACK]

    now = time.monotonic()
    if _codex_models_cache is not None:
        cached_binary, cached_at, cached_models = _codex_models_cache
        if cached_binary == binary and now - cached_at < _CODEX_MODEL_CACHE_TTL_SECONDS:
            return [dict(model) for model in cached_models]

    try:
        models = await _discover_codex_models(binary)
    except Exception as exc:
        logger.warning("Codex model discovery failed; using CLI default: %s", exc)
        return [dict(model) for model in _SDK_CODEX_MODELS_FALLBACK]

    _codex_models_cache = (binary, now, [dict(model) for model in models])
    return models


def _ollama_running(host: str = "127.0.0.1", port: int = 11434, timeout: float = 0.3) -> bool:
    """Cheap TCP probe — connect()=success means a listener is bound."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def _fetch_ollama_tags(base_url: Optional[str] = None) -> tuple[list[dict], float]:
    """Return locally installed Ollama models from the native /api/tags API."""
    base = _normalize_provider_base_url(base_url or _OLLAMA_BASE_URL)
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get(f"{base}/api/tags")
    if r.status_code != 200:
        raise RuntimeError(f"Ollama responded HTTP {r.status_code}.")
    data = r.json()
    models: list[dict] = []
    for item in data.get("models", []):
        if not isinstance(item, dict):
            continue
        model_id = item.get("name") or item.get("model")
        if model_id:
            models.append({"id": model_id, "label": model_id})
    return models, (time.perf_counter() - t0) * 1000


@router.get("/providers")
async def list_providers() -> dict:
    """Return the provider catalogue with live availability flags."""
    providers: list[dict] = []

    resolved_binaries = {
        pid: _resolve_cli(pid)
        for pid in _CLI_BINARIES
    }
    codex_models = await _get_codex_models(resolved_binaries.get("sdk-codex"))

    for pid, (binary, label) in _CLI_BINARIES.items():
        providers.append({
            "id": pid,
            "name": label,
            "type": "cli",
            "available": resolved_binaries[pid] is not None,
            "models": codex_models if pid == "sdk-codex" else _SDK_MODELS.get(pid, []),
            "base_url": None,
        })

    for pid, (label, env_key) in _API_PROVIDERS.items():
        env_key = _API_PROVIDERS[pid][1]
        providers.append({
            "id": pid,
            "name": label,
            "type": "api",
            "available": pid == "custom" or bool(env_key and os.environ.get(env_key)),
            "models": _API_MODELS.get(pid, []),
            "base_url": _API_BASE_URLS.get(pid),
        })

    ollama_models: list[dict] = []
    ollama_available = False
    try:
        ollama_models, _ = await _fetch_ollama_tags(_OLLAMA_BASE_URL)
        ollama_available = True
    except Exception:
        # Fall back to a fast TCP probe so the UI still shows a useful signal
        # while Ollama is starting up or if /api/tags is temporarily busy.
        ollama_available = _ollama_running()

    providers.append({
        "id": "ollama",
        "name": "Ollama (Local)",
        "type": "local",
        "available": ollama_available,
        "models": ollama_models,
        "base_url": _OLLAMA_BASE_URL,
    })

    return {"providers": providers}


# ─── Provider connection test ─────────────────────────────────────────────────
#
# Backs the CatBot settings "Test Connection" button. The frontend
# (`src/lib/chat/ChatPane.svelte:test_provider_connection`) POSTs the current
# config and expects `{success, latency_ms}` on success or
# `{success: False, error}` on failure. Without this route the button hit a
# bare 404 and silently reported "Cannot reach backend server".

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
    api_format: Optional[str] = None


class UniversalStreamRequest(BaseModel):
    provider_id: str = "custom"
    messages: list[ChatMessage]
    model: str
    temperature: float = 0.3
    max_tokens: int = 4096
    system: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    api_format: Optional[str] = None


def _resolve_cli(provider_id: str, home: Optional[Path] = None) -> Optional[str]:
    """Resolve an SDK CLI binary for an honest desktop availability signal.

    Packaged GUI apps frequently start with a reduced PATH.  Search the same
    user package-manager locations as the Tauri sidecar launcher and prefer
    native executables over Windows npm wrappers where the SDK requires one.
    """
    binary, _ = _CLI_BINARIES[provider_id]
    override_key = {
        "sdk-claude": "CATGO_CLAUDE_PATH",
        "sdk-codex": "CATGO_CODEX_PATH",
        "sdk-gemini": "CATGO_GEMINI_PATH",
    }.get(provider_id)
    if override_key:
        override = os.environ.get(override_key)
        if override and os.path.isfile(override):
            return override

    found = shutil.which(binary)
    if found and provider_id not in _CLI_NPM_PKG:
        return found

    def native_from_npm_prefix(prefix: Path) -> Optional[str]:
        pkg = _CLI_NPM_PKG.get(provider_id)
        if not pkg:
            return None
        package_root = prefix / "node_modules" / Path(*pkg.split("/"))
        if provider_id == "sdk-claude":
            candidate = package_root / "bin" / (
                "claude.exe" if os.name == "nt" else "claude"
            )
            if candidate.is_file():
                return str(candidate)
        elif provider_id == "sdk-codex":
            exe = "codex.exe" if os.name == "nt" else "codex"
            scope = package_root / "node_modules" / "@openai"
            for platform_package in sorted(scope.glob("codex-*")):
                for triple in sorted((platform_package / "vendor").glob("*")):
                    for subdir in ("bin", "codex", ""):
                        candidate = triple / subdir / exe
                        if candidate.is_file():
                            return str(candidate)
        return None

    if found:
        native = native_from_npm_prefix(Path(found).parent)
        if native:
            return native
        # On Unix the wrapper/shebang is directly executable.  On Windows a
        # .cmd launcher is still an honest availability signal; the agent
        # adapter performs its own native-binary resolution before spawning.
        return found

    home = home or Path.home()
    candidates = [
        home / ".local" / "bin" / binary,
        home / ".npm-global" / "bin" / binary,
        home / ".bun" / "bin" / binary,
        home / ".volta" / "bin" / binary,
        home / ".asdf" / "shims" / binary,
        Path("/usr/local/bin") / binary,
        Path("/opt/homebrew/bin") / binary,
    ]
    nvm_root = home / ".nvm" / "versions" / "node"
    if nvm_root.is_dir():
        candidates.extend(sorted(nvm_root.glob(f"*/bin/{binary}")))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    appdata = os.environ.get("APPDATA")
    if appdata:
        npm_prefix = Path(appdata) / "npm"
        native = native_from_npm_prefix(npm_prefix)
        if native:
            return native
        for suffix in (".cmd", ".exe", ""):
            candidate = npm_prefix / f"{binary}{suffix}"
            if candidate.is_file():
                return str(candidate)
    return None


def _provider_env_key(provider_id: str) -> str:
    return _API_PROVIDERS.get(provider_id, ("", ""))[1]


def _resolve_api_key(provider_id: str, api_key: Optional[str]) -> Optional[str]:
    env_key = _provider_env_key(provider_id)
    return api_key or (os.environ.get(env_key) if env_key else None)


def _normalize_provider_base_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    for suffix in ("/chat/completions", "/messages", "/models"):
        if base.lower().endswith(suffix):
            return base[: -len(suffix)].rstrip("/")
    return base


def _resolve_base_url(provider_id: str, base_url: Optional[str]) -> str:
    if provider_id == "ollama":
        return _normalize_provider_base_url(base_url or _OLLAMA_BASE_URL)
    return _normalize_provider_base_url(base_url or _API_BASE_URLS.get(provider_id, ""))


def _resolve_api_format(provider_id: str, api_format: Optional[str], base_url: str) -> str:
    if api_format in {"openai", "anthropic"}:
        return api_format
    if _API_FORMATS.get(provider_id) == "anthropic":
        return "anthropic"
    host = base_url.lower()
    if "anthropic.com" in host:
        return "anthropic"
    return "openai"


def _model_probe_candidates(provider_id: str, base_url: str, api_format: Optional[str]) -> list[tuple[str, str]]:
    if api_format in {"openai", "anthropic"}:
        return [(url, api_format) for url in _model_urls(base_url, api_format)]
    hinted = _resolve_api_format(provider_id, api_format, base_url)
    formats = [hinted]
    if provider_id == "custom" and hinted != "openai":
        formats.insert(0, "openai")
    if "openai" not in formats:
        formats.append("openai")
    if "anthropic" not in formats:
        formats.append("anthropic")
    seen: set[tuple[str, str]] = set()
    candidates: list[tuple[str, str]] = []
    for fmt in formats:
        for url in _model_urls(base_url, fmt):
            key = (url, fmt)
            if key not in seen:
                seen.add(key)
                candidates.append(key)
    return candidates


def _openai_base_accepts_direct_path(base_url: str) -> bool:
    lower = base_url.lower().rstrip("/")
    return (
        lower.endswith("/v1")
        or lower.endswith("/v4")
        or "/v1/" in lower
        or lower.endswith("/openai")
        or "compatible-mode/v1" in lower
        or "/api/paas/v4" in lower
    )


def _model_urls(base_url: str, api_format: str) -> list[str]:
    if api_format == "anthropic":
        if base_url.endswith("/models"):
            return [base_url]
        if base_url.endswith("/v1") or "/v1/" in base_url:
            return [f"{base_url}/models"]
        return [f"{base_url}/v1/models", f"{base_url}/models"]
    if base_url.endswith("/models"):
        return [base_url]
    if _openai_base_accepts_direct_path(base_url):
        return [f"{base_url}/models"]
    return [f"{base_url}/v1/models", f"{base_url}/models"]


def _chat_completions_url(base_url: str, api_format: str) -> str:
    if api_format == "anthropic":
        if base_url.endswith("/messages"):
            return base_url
        return f"{base_url}/messages" if base_url.endswith("/v1") or "/v1/" in base_url else f"{base_url}/v1/messages"
    if base_url.endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions" if _openai_base_accepts_direct_path(base_url) else f"{base_url}/v1/chat/completions"


def _auth_headers(api_key: str, api_format: str) -> dict[str, str]:
    if api_format == "anthropic":
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _parse_models_payload(data: dict) -> list[dict]:
    raw_models = data.get("data") if isinstance(data.get("data"), list) else data.get("models", [])
    models = []
    for item in raw_models:
        if isinstance(item, str):
            model_id = item
            label = item
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("name")
            label = item.get("display_name") or item.get("label") or item.get("name") or model_id
        else:
            continue
        if model_id:
            models.append({"id": model_id, "label": label or model_id})
    return models


async def _fetch_provider_models(provider_id: str, api_key: Optional[str], base_url: Optional[str], api_format: Optional[str] = None) -> tuple[list[dict], float, str]:
    if provider_id == "ollama":
        models, latency = await _fetch_ollama_tags(base_url)
        if not models:
            raise RuntimeError("Ollama is running, but no local models were found. Run `ollama pull <model>` first.")
        return models, latency, "ollama"

    key = _resolve_api_key(provider_id, api_key)
    env_key = _provider_env_key(provider_id)
    if not key:
        hint = f" or set ${env_key}" if env_key else ""
        raise ValueError(f"No API key. Enter one in chat settings{hint}.")
    base = _resolve_base_url(provider_id, base_url)
    if not base:
        raise ValueError(f"No base URL configured for '{provider_id}'.")
    errors: list[str] = []
    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=15.0) as client:
        for url, fmt in _model_probe_candidates(provider_id, base, api_format):
            try:
                r = await client.get(url, headers=_auth_headers(key, fmt))
            except Exception as exc:
                errors.append(f"{fmt} {url}: {exc}")
                continue
            if r.status_code == 200:
                data = r.json()
                models = _parse_models_payload(data)
                if models:
                    return models, (time.perf_counter() - t0) * 1000, fmt
                errors.append(f"{fmt} {url}: no models in response")
                continue
            snippet = r.text[:200].replace("\n", " ")
            errors.append(f"{fmt} {url}: HTTP {r.status_code}: {snippet}")
            if api_format in {"openai", "anthropic"} and r.status_code in (401, 403):
                break
    raise RuntimeError("; ".join(errors) or "No model endpoint responded.")


@router.post("/providers/models")
async def fetch_provider_models(req: ProviderTestRequest) -> dict:
    try:
        models, latency, fmt = await _fetch_provider_models(req.provider_id, req.api_key, req.base_url, req.api_format)
        return {"success": True, "models": models, "latency_ms": latency, "api_format": fmt}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


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
        try:
            models, latency = await _fetch_ollama_tags(req.base_url)
        except Exception as exc:
            return {"success": False, "error": f"Cannot reach Ollama: {exc}"}
        return {"success": True, "latency_ms": latency, "models": models}

    # API providers — model discovery proves reachability and key validity.
    if pid in _API_PROVIDERS:
        try:
            _, latency, _ = await _fetch_provider_models(pid, req.api_key, req.base_url, req.api_format)
            return {"success": True, "latency_ms": latency}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    return {"success": False, "error": f"Unknown provider '{pid}'."}


@router.post("/stream-universal")
def chat_stream_universal(req: UniversalStreamRequest):
    """Stream universal providers, supporting OpenAI-compatible and Anthropic APIs."""
    return StreamingResponse(
        _stream_universal(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _stream_universal(req: UniversalStreamRequest):
    key = _resolve_api_key(req.provider_id, req.api_key)
    env_key = _provider_env_key(req.provider_id)
    if req.provider_id != "ollama" and not key:
        hint = f" or set ${env_key}" if env_key else ""
        yield f"data: {json.dumps({'error': f'No API key. Enter one in chat settings{hint}.'})}\n\n"
        yield "data: [DONE]\n\n"
        return
    base = _resolve_base_url(req.provider_id, req.base_url)
    if req.provider_id == "ollama" and not base:
        base = _OLLAMA_BASE_URL
    if not base:
        yield f"data: {json.dumps({'error': f'No base URL configured for {req.provider_id}.'})}\n\n"
        yield "data: [DONE]\n\n"
        return
    if req.provider_id == "ollama":
        async for chunk in _stream_ollama(req, base):
            yield chunk
        return
    fmt = _resolve_api_format(req.provider_id, req.api_format, base)
    if fmt == "anthropic":
        async for chunk in _stream_anthropic_universal(req, key or "", base):
            yield chunk
    else:
        async for chunk in _stream_openai_universal(req, key or "", base, fmt):
            yield chunk


async def _stream_ollama(req: UniversalStreamRequest, base_url: str):
    """Stream from Ollama's native chat endpoint; no API key is required."""
    messages = []
    if req.system:
        messages.append({"role": "system", "content": req.system})
    messages.extend([_ollama_message(m) for m in req.messages])
    body = {
        "model": req.model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": req.temperature,
            "num_predict": req.max_tokens,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{base_url.rstrip('/')}/api/chat",
                json=body,
            ) as response:
                if response.status_code != 200:
                    error_body = await response.aread()
                    message = error_body[:200].decode(errors="ignore")
                    yield f"data: {json.dumps({'error': f'Ollama error {response.status_code}: {message}'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    text = data.get("message", {}).get("content", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
                    if data.get("done"):
                        break
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"
    yield "data: [DONE]\n\n"


async def _stream_openai_universal(req: UniversalStreamRequest, api_key: str, base_url: str, api_format: str):
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
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                _chat_completions_url(base_url, api_format),
                headers=_auth_headers(api_key, api_format),
                json=body,
            ) as response:
                if response.status_code != 200:
                    error_body = await response.aread()
                    message = error_body[:200].decode(errors="ignore")
                    yield f"data: {json.dumps({'error': f'API error {response.status_code}: {message}'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    text = delta.get("content", "")
                    if text:
                        yield f"data: {json.dumps({'text': text})}\n\n"
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"
    yield "data: [DONE]\n\n"


async def _stream_anthropic_universal(req: UniversalStreamRequest, api_key: str, base_url: str):
    body = {
        "model": req.model,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        "messages": [
            {"role": message.role, "content": _anthropic_content(message.content)}
            for message in req.messages
        ],
        "stream": True,
    }
    if req.system:
        body["system"] = req.system
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                _chat_completions_url(base_url, "anthropic"),
                headers=_auth_headers(api_key, "anthropic"),
                json=body,
            ) as response:
                if response.status_code != 200:
                    error_body = await response.aread()
                    message = error_body[:200].decode(errors="ignore")
                    yield f"data: {json.dumps({'error': f'API error {response.status_code}: {message}'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    if data.get("type") == "content_block_delta":
                        text = data.get("delta", {}).get("text", "")
                        if text:
                            yield f"data: {json.dumps({'text': text})}\n\n"
                    elif data.get("type") == "message_stop":
                        break
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"
    yield "data: [DONE]\n\n"
