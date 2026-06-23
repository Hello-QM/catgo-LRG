"""Unhandled 500s must carry CORS headers, or the browser shows "Load failed".

Regression: a backend 500 (BrokenPipeError in the workflow /run handler) reached
the WebView without an Access-Control-Allow-Origin header, because the
@app.exception_handler response is emitted by ServerErrorMiddleware *outside*
CORSMiddleware. The browser then dropped the body and surfaced only a generic
"Load failed" with no detail. apply_cors_headers re-attaches the headers.
"""

import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from catgo.cors_util import apply_cors_headers

ALLOW_ORIGINS = ["tauri://localhost", "https://tauri.localhost"]
ORIGIN_REGEX = r"(https?://(localhost|127\.0\.0\.1)(:\d+)?|vscode-webview://[A-Za-z0-9\-]+)"


def _req(origin: str | None) -> Request:
    headers = [(b"origin", origin.encode())] if origin is not None else []
    return Request({"type": "http", "headers": headers})


def _resp() -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": "boom"})


def test_exact_allowed_origin_is_echoed():
    out = apply_cors_headers(_req("tauri://localhost"), _resp(), ALLOW_ORIGINS, ORIGIN_REGEX)
    assert out.headers["access-control-allow-origin"] == "tauri://localhost"
    assert out.headers["access-control-allow-credentials"] == "true"
    assert out.headers["vary"] == "Origin"


def test_regex_allowed_origin_is_echoed():
    out = apply_cors_headers(_req("http://localhost:5173"), _resp(), ALLOW_ORIGINS, ORIGIN_REGEX)
    assert out.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_disallowed_origin_gets_no_header():
    out = apply_cors_headers(_req("https://evil.example"), _resp(), ALLOW_ORIGINS, ORIGIN_REGEX)
    assert "access-control-allow-origin" not in out.headers


def test_no_origin_gets_no_header():
    out = apply_cors_headers(_req(None), _resp(), ALLOW_ORIGINS, ORIGIN_REGEX)
    assert "access-control-allow-origin" not in out.headers


def test_accepts_precompiled_pattern():
    pattern = re.compile(ORIGIN_REGEX)
    out = apply_cors_headers(_req("http://127.0.0.1:8000"), _resp(), ALLOW_ORIGINS, pattern)
    assert out.headers["access-control-allow-origin"] == "http://127.0.0.1:8000"


def _app_with_handler() -> FastAPI:
    """Minimal app replicating main.py's middleware order + 500 handler."""
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ORIGIN_REGEX,
        allow_origins=ALLOW_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    _compiled = re.compile(ORIGIN_REGEX)

    @app.exception_handler(Exception)
    async def _handler(request: Request, exc: Exception):
        resp = JSONResponse(status_code=500, content={"detail": str(exc)})
        return apply_cors_headers(request, resp, ALLOW_ORIGINS, _compiled)

    @app.get("/boom")
    def _boom():
        raise RuntimeError("kaboom")

    return app


def test_unhandled_500_carries_cors_header_end_to_end():
    client = TestClient(_app_with_handler(), raise_server_exceptions=False)
    resp = client.get("/boom", headers={"Origin": "tauri://localhost"})
    assert resp.status_code == 500
    # The fix: the browser can now read this response (and its detail).
    assert resp.headers.get("access-control-allow-origin") == "tauri://localhost"
    assert resp.json()["detail"] == "kaboom"
