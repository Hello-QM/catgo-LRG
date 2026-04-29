import asyncio
import os
import pytest
import catgo.workflow.builtins  # ensure task types registered


class TestMCPWorkflow:
    @pytest.fixture(autouse=True)
    def setup_db(self, tmp_path, monkeypatch):
        db_path = str(tmp_path / "test.db")
        monkeypatch.setenv("CATGO_PATHS_DB_PATH", db_path)

    def test_create_workflow(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        result = asyncio.run(handle_tool_call("create", {"name": "test_wf"}))
        assert "workflow_id" in result
        assert result["name"] == "test_wf"

    def test_add_task(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        r2 = asyncio.run(handle_tool_call("add_task", {
            "workflow_id": r1["workflow_id"],
            "task_type": "structure_input",
            "structure": '{"sites": []}',
        }))
        assert "task_id" in r2
        assert r2["task_type"] == "structure_input"

    def test_add_task_with_reference(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        wf_id = r1["workflow_id"]
        r2 = asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": "{}",
        }))
        r3 = asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "gibbs_energy",
            "energy": {"_ref": r2["task_id"], "_key": "energy"},
        }))
        assert "task_id" in r3

    def test_submit_and_status(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        wf_id = r1["workflow_id"]
        asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": "{}",
        }))
        asyncio.run(handle_tool_call("submit", {"workflow_id": wf_id}))
        status = asyncio.run(handle_tool_call("status", {"workflow_id": wf_id}))
        assert status["workflow"]["status"] == "running"

    def test_list_workflows(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        asyncio.run(handle_tool_call("create", {"name": "wf_a"}))
        asyncio.run(handle_tool_call("create", {"name": "wf_b"}))
        result = asyncio.run(handle_tool_call("list", {}))
        assert len(result["workflows"]) >= 2

    def test_get_dag(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        wf_id = r1["workflow_id"]
        asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": "{}",
        }))
        dag = asyncio.run(handle_tool_call("get_dag", {"workflow_id": wf_id}))
        assert len(dag["tasks"]) == 1

    def test_pause_resume_reset(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        r1 = asyncio.run(handle_tool_call("create", {"name": "test"}))
        wf_id = r1["workflow_id"]
        asyncio.run(handle_tool_call("add_task", {
            "workflow_id": wf_id,
            "task_type": "structure_input",
            "structure": "{}",
        }))
        asyncio.run(handle_tool_call("submit", {"workflow_id": wf_id}))

        r_pause = asyncio.run(handle_tool_call("pause", {"workflow_id": wf_id}))
        assert r_pause["status"] == "paused"

        r_resume = asyncio.run(handle_tool_call("resume", {"workflow_id": wf_id}))
        assert r_resume["status"] == "running"

        r_reset = asyncio.run(handle_tool_call("reset", {"workflow_id": wf_id}))
        assert r_reset["status"] == "draft"

    def test_unknown_action(self):
        from catgo.workflow.mcp_tools import handle_tool_call
        result = asyncio.run(handle_tool_call("nonexistent", {}))
        assert "error" in result
