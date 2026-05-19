import asyncio

import httpx
import pytest

# tests/conftest.py puts server/ on sys.path, so `main` resolves to
# server/main.py — the fully-wired FastAPI app. view_capture_router is
# mounted there with prefix "/api" (server/main.py:401), and the router
# itself has prefix "/view", so catrender bridge routes live under
# /api/view/catrender/...
from main import app


@pytest.mark.asyncio
async def test_pending_then_result_roundtrip():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:

        async def fulfil():
            for _ in range(50):
                r = await c.get("/api/view/catrender/pending")
                pend = r.json()["pending"]
                if pend:
                    rid = pend[0]["request_id"]
                    await c.post(
                        "/api/view/catrender/result",
                        json={
                            "request_id": rid,
                            "svg": "<svg/>",
                            "format": "svg",
                        },
                    )
                    return
                await asyncio.sleep(0.05)

        task = asyncio.create_task(fulfil())
        resp = await c.post(
            "/api/view/catrender/request",
            json={"style": {"preset": "flat"}, "format": "svg"},
        )
        await task
        assert resp.status_code == 200
        assert resp.json()["svg"] == "<svg/>"
