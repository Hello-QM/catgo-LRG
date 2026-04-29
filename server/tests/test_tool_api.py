# server/tests/test_tool_api.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from starlette.testclient import TestClient


@pytest.fixture(scope="module")
def tool_client():
    """Create test client with tools router only."""
    from fastapi import FastAPI
    from catgo.routers.tools import router
    from catgo.tools import registry
    from tools.models import ToolEntry

    app = FastAPI()
    app.include_router(router, prefix="/api")

    # Register a test tool
    async def fake_execute(context):
        return {"content": "result"}

    registry.register(ToolEntry(
        id="test_tool", name="Test Tool", description="A test",
        trust="builtin", output_type="text",
        execute_fn=fake_execute,
    ))

    return TestClient(app)


class TestToolsAPI:
    """Test REST API endpoints for tools."""

    def test_list_tools(self, tool_client):
        resp = tool_client.get("/api/tools")
        assert resp.status_code == 200
        data = resp.json()
        assert any(t["id"] == "test_tool" for t in data)

    def test_get_tool(self, tool_client):
        resp = tool_client.get("/api/tools/test_tool")
        assert resp.status_code == 200
        assert resp.json()["id"] == "test_tool"

    def test_get_tool_not_found(self, tool_client):
        resp = tool_client.get("/api/tools/nonexistent")
        assert resp.status_code == 404

    def test_run_tool(self, tool_client):
        resp = tool_client.post("/api/tools/test_tool/run", json={"x": 1})
        assert resp.status_code == 200
        assert resp.json()["data"]["content"] == "result"

    def test_enable_disable(self, tool_client):
        resp = tool_client.post("/api/tools/test_tool/disable")
        assert resp.status_code == 200
        resp = tool_client.post("/api/tools/test_tool/enable")
        assert resp.status_code == 200
