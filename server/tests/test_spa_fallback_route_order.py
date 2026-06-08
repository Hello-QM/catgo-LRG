"""Regression: SPA catch-all must never shadow routers added after import time.

Bug (2026-06-04): in SPA mode (`build-desktop/` present) `main` registers a
module-load catch-all `@app.get("/{full_path:path}")` that 404s unmatched
`/api/*`. Routers included later — the workflow engine in `lifespan()` and the
hpc/heterostructure routers in `_deferred_startup()` — are appended *after* the
catch-all, so Starlette matches the catch-all first and every deferred `/api/*`
route returns 404. `_move_spa_fallback_last()` re-appends the catch-all so it
stays last.
"""

from fastapi import FastAPI
from starlette.responses import Response

from main import _move_spa_fallback_last


def _paths(app):
    return [getattr(r, "path", None) for r in app.router.routes]


def test_catch_all_moved_after_deferred_route():
    app = FastAPI()

    # Module-load order: catch-all registered first ...
    @app.get("/{full_path:path}")
    async def spa(full_path: str):  # pragma: no cover - body irrelevant
        return Response(status_code=404)

    # ... then a deferred router/route added afterwards (the bug condition).
    @app.get("/api/engine/workflows")
    async def workflows():  # pragma: no cover
        return {"ok": True}

    paths = _paths(app)
    assert paths.index("/{full_path:path}") < paths.index("/api/engine/workflows")

    _move_spa_fallback_last(app)

    paths = _paths(app)
    assert paths[-1] == "/{full_path:path}"
    assert paths.index("/api/engine/workflows") < paths.index("/{full_path:path}")


def test_noop_when_no_catch_all():
    """No SPA catch-all (dev mode) → reordering is a harmless no-op."""
    app = FastAPI()

    @app.get("/api/engine/workflows")
    async def workflows():  # pragma: no cover
        return {"ok": True}

    before = _paths(app)
    _move_spa_fallback_last(app)
    assert _paths(app) == before
