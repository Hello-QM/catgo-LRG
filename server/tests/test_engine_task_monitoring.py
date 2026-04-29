"""Tests for engine task monitoring endpoints (files, convergence, file-content, frequencies)."""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from catgo.routers.workflow_engine_tasks import router, set_db


def _make_app():
    app = FastAPI()
    app.include_router(router)
    return app


class FakeDB:
    def __init__(self, tasks=None):
        self._tasks = tasks or {}

    def get_task(self, task_id):
        if task_id not in self._tasks:
            raise KeyError(f"Task {task_id} not found")
        return self._tasks[task_id]

    def get_task_parents(self, task_id):
        return []

    def get_task_children(self, task_id):
        return []


SAMPLE_TASK = {
    "id": "t1",
    "workflow_id": "w1",
    "task_type": "vasp_relax",
    "status": "RUNNING",
    "work_dir": "/scratch/user/calc_001",
    "hpc_session_id": "sess1",
    "params_json": "{}",
}


class TestGetTaskFiles:
    def test_files_listed(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_file = MagicMock()
        mock_file.name = "INCAR"
        mock_file.path = "/scratch/user/calc_001/INCAR"
        mock_file.is_dir = False
        mock_file.size_bytes = 1024
        mock_file.modified_time = "1711700000"

        mock_hpc = AsyncMock()
        mock_hpc.list_remote_dir = AsyncMock(return_value=("/scratch/user/calc_001", [mock_file]))

        with patch("catgo.utils.hpc_client.pool") as mock_pool:
            mock_pool.get_connection.return_value = mock_hpc
            # Need to also patch the import inside _get_task_hpc
            with patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool)}):
                client = TestClient(_make_app())
                resp = client.get("/api/engine/tasks/t1/files")

        assert resp.status_code == 200
        data = resp.json()
        assert data["work_dir"] == "/scratch/user/calc_001"
        assert len(data["files"]) == 1
        assert data["files"][0]["name"] == "INCAR"

    def test_no_work_dir(self):
        task_no_dir = {**SAMPLE_TASK, "work_dir": None}
        db = FakeDB(tasks={"t1": task_no_dir})
        set_db(db)
        client = TestClient(_make_app())
        resp = client.get("/api/engine/tasks/t1/files")
        assert resp.status_code == 404

    def test_task_not_found(self):
        db = FakeDB(tasks={})
        set_db(db)
        client = TestClient(_make_app())
        resp = client.get("/api/engine/tasks/t1/files")
        assert resp.status_code == 404


class TestGetTaskConvergence:
    def test_vasp_convergence(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_conv = MagicMock()
        mock_conv.model_dump.return_value = {
            "success": True,
            "points": [{"step": 1, "energy": -10.5, "energy_sigma0": -10.4,
                         "max_force": 0.05, "rms_force": 0.02}],
            "converged": False,
            "message": "",
        }

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()

        with patch("catgo.utils.hpc_client.pool") as mock_pool, \
             patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool)}), \
             patch("catgo.utils.job_parser.detect_calc_type", new_callable=AsyncMock) as mock_detect, \
             patch("catgo.utils.job_parser.parse_vasp_convergence", new_callable=AsyncMock) as mock_parse:
            mock_pool.get_connection.return_value = mock_hpc
            from catgo.models.hpc import CalcSoftware
            mock_detect.return_value = (CalcSoftware.VASP, None)
            mock_parse.return_value = mock_conv

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/convergence")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["points"]) == 1


class TestGetTaskFileContent:
    def test_read_file(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()
        # Not a LocalFileConnection
        mock_hpc.__class__ = type("HPCConnection", (), {})

        with patch("catgo.utils.hpc_client.pool") as mock_pool, \
             patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool, LocalFileConnection=type("LC", (), {}))}), \
             patch("catgo.utils.job_parser.read_remote_file", new_callable=AsyncMock) as mock_read:
            mock_pool.get_connection.return_value = mock_hpc
            mock_read.return_value = ("SYSTEM = test\nENCUT = 400\n", 2)

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/file-content?path=INCAR")

        assert resp.status_code == 200
        data = resp.json()
        assert "ENCUT" in data["content"]
        assert data["total_lines"] == 2

    def test_path_traversal_blocked(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        with patch("catgo.utils.hpc_client.pool") as mock_pool, \
             patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool)}):
            mock_pool.get_connection.return_value = mock_hpc
            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/file-content?path=../../etc/passwd")
        assert resp.status_code == 400


class TestPutTaskFileContent:
    def test_write_file(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()
        mock_hpc.__class__ = type("HPCConnection", (), {})

        with patch("catgo.utils.hpc_client.pool") as mock_pool, \
             patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool, LocalFileConnection=type("LC", (), {}))}), \
             patch("catgo.utils.job_parser.write_remote_file", new_callable=AsyncMock) as mock_write:
            mock_pool.get_connection.return_value = mock_hpc
            mock_write.return_value = True

            client = TestClient(_make_app())
            resp = client.put(
                "/api/engine/tasks/t1/file-content",
                json={"path": "INCAR", "content": "SYSTEM = new\nENCUT = 500\n"},
            )

        assert resp.status_code == 200
        assert resp.json()["success"] is True


class TestGetTaskFrequencies:
    def test_frequencies(self):
        db = FakeDB(tasks={"t1": SAMPLE_TASK})
        set_db(db)

        mock_hpc = MagicMock()
        mock_hpc.conn = AsyncMock()

        freq_result = {
            "success": True,
            "real_freqs": [100.0, 200.0, 300.0],
            "imag_freqs": [-50.0],
            "num_imaginary": 1,
            "total_atoms": 3,
            "message": "",
        }

        with patch("catgo.utils.hpc_client.pool") as mock_pool, \
             patch.dict("sys.modules", {"catgo.utils.hpc_client": MagicMock(pool=mock_pool)}), \
             patch("catgo.utils.vasp_freq_parser.parse_vasp_frequencies", new_callable=AsyncMock) as mock_parse:
            mock_pool.get_connection.return_value = mock_hpc
            mock_parse.return_value = freq_result

            client = TestClient(_make_app())
            resp = client.get("/api/engine/tasks/t1/frequencies")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["real_freqs"]) == 3
        assert data["num_imaginary"] == 1
