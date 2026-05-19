"""Call FastAPI route functions in-process — no running server.

Route handlers in catgo.routers are plain functions taking a Pydantic
request model. Some are ``def`` (sync), some ``async def``. This adapter
builds the model, dispatches correctly, and translates HTTPException into
a CLI-level OpError so handlers never leak HTTP concerns.

Returns the route's return value UNCHANGED — for catgo routes that is a
Pydantic model (e.g. StructureResult/SlabResult), so callers use
attribute access (``.structure`` / ``.slabs``), not dict keys.
"""
from __future__ import annotations

import asyncio
import inspect
from typing import Any, Callable, Type

from fastapi import HTTPException
from pydantic import BaseModel


class OpError(Exception):
    """Operation failed (validation, route error). Carries a user message."""


def require_structure(session):
    """Shared op-handler guard: active structure or OpError.

    DRY single source — replaces the per-module _require/_require_structure
    helpers. Raises OpError (op-precondition failure) so every handler and
    the CLI/shell dispatch treat "nothing loaded" uniformly.
    """
    if session.structure is None:
        raise OpError("no active structure -- load one first")
    return session.structure


def call_route(route_fn: Callable, request_model: Type[BaseModel], **params: Any):
    try:
        req = request_model(**params)
    except Exception as exc:  # pydantic ValidationError etc.
        raise OpError(f"invalid parameters: {exc}") from exc
    try:
        if inspect.iscoroutinefunction(route_fn):
            result = asyncio.run(route_fn(req))
        else:
            result = route_fn(req)
    except HTTPException as exc:
        raise OpError(str(exc.detail)) from exc
    return result
