"""AI Chat assistant proxy — streams LLM responses via SSE."""

import json
import logging
import os
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
