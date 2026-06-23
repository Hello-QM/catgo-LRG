"""CORS header helper for responses that bypass ``CORSMiddleware``.

Starlette runs ``ServerErrorMiddleware`` as the *outermost* layer — above the
user-installed ``CORSMiddleware``. When an unhandled exception bubbles up, the
``@app.exception_handler(Exception)`` response is emitted by that outer layer
and never travels back down through ``CORSMiddleware``, so it ships **without**
``Access-Control-Allow-Origin``. A browser then discards the body and the
frontend only sees a generic "Load failed" instead of the real 500 detail.

``apply_cors_headers`` re-attaches the same headers ``CORSMiddleware`` would
have set, using the identical allow-list + regex, so error responses reach the
browser intact.
"""

from __future__ import annotations

import re
from typing import Pattern, Sequence

from starlette.requests import Request
from starlette.responses import Response


def apply_cors_headers(
    request: Request,
    response: Response,
    allow_origins: Sequence[str],
    allow_origin_regex: str | Pattern[str] | None,
) -> Response:
    """Echo the request ``Origin`` into the response if it is allowed.

    Mirrors Starlette ``CORSMiddleware`` matching: an exact match against
    ``allow_origins`` or a full match against ``allow_origin_regex``. No-op when
    the request carries no ``Origin`` (same-origin / non-browser) or the origin
    is not allowed — never emits a wildcard.
    """
    origin = request.headers.get("origin")
    if not origin:
        return response

    allowed = origin in allow_origins
    if not allowed and allow_origin_regex is not None:
        pattern = (
            allow_origin_regex
            if isinstance(allow_origin_regex, re.Pattern)
            else re.compile(allow_origin_regex)
        )
        allowed = pattern.fullmatch(origin) is not None

    if allowed:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        # Cache key must vary by Origin since the value is request-dependent.
        existing_vary = response.headers.get("Vary")
        if existing_vary:
            if "origin" not in existing_vary.lower():
                response.headers["Vary"] = f"{existing_vary}, Origin"
        else:
            response.headers["Vary"] = "Origin"
    return response
