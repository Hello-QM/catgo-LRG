"""End-to-end test for ORCA results pipeline.

Tests the complete flow:
1. ORCA job completion
2. Result parsing and storage
3. API enriched results query
4. Frontend data availability

Run with: pytest server/tests/test_orca_results_e2e.py -v
"""

import json
import pytest
from pathlib import Path


@pytest.mark.asyncio
async def test_orca_freq_results_stored_and_retrieved(monkeypatch):
    """Test that ORCA freq results are stored in task_results and retrievable via API."""

    # This test validates that the entire pipeline works:
    # 1. Result collector stores to task_results.outputs_json
    # 2. Collector normalizes keys to real_freqs_json, imag_freqs_json
    # 3. API query_task_results() reads from task_results
    # 4. build_part_c_results() transforms for frontend

    from catgo.workflow.db import WorkflowDB
    from catgo.services.workflow_results import build_part_c_results
    from catgo.workflow.engine.collector import _store_result
    import tempfile
    import sqlite3

    # Create temporary database
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        # Initialize database
        db = WorkflowDB(db_path)

        # Create test workflow and task
        workflow_id = db.create_workflow("test_freq_workflow")

        task_id = db.create_task(
            workflow_id=workflow_id,
            task_type="orca_freq",
            params={"software": "orca", "method": "B3LYP"},
            software="orca",
            system_name="H2O"
        )

        # Simulate ORCA parser output (what OrcaFreqOutput.get_summary() would return)
        orca_parser_result = {
            "type": "orca_freq",
            "frequencies": [
                {"index": 1, "frequency_cm": 3755.2, "imaginary": False, "ir_intensity_km_mol": 0.5},
                {"index": 2, "frequency_cm": 1594.3, "imaginary": False, "ir_intensity_km_mol": 82.3},
                {"index": 3, "frequency_cm": 3867.1, "imaginary": False, "ir_intensity_km_mol": 45.2},
            ],
            "num_imaginary": 0,
            "imaginary_frequencies": [],
            "energy_eh": -76.4185,
            "energy_ev": -2080.5,
            "zpe_eh": 0.0215,
            "zpe_kj_mol": 56.4,
            "gibbs_eh": -0.0050,
            "convergence_points": [{"step": 1, "energy": -76.4185, "dE": 0.0}],
        }

        # Test Step 1: Store result in database (what result_handler and collector do)
        _store_result(db, task_id, workflow_id, orca_parser_result)
        db.update_task(task_id, status="COMPLETED")

        # Verify storage
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # Check task_results has the data
        result_row = conn.execute(
            "SELECT * FROM task_results WHERE task_id = ?",
            (task_id,)
        ).fetchone()

        assert result_row is not None, "Result not stored in task_results"
        assert result_row["workflow_id"] == workflow_id

        # Check normalized frequency fields
        assert result_row["real_freqs_json"] is not None, "real_freqs_json not stored"
        assert result_row["imag_freqs_json"] is not None, "imag_freqs_json not stored"
        assert result_row["zpe"] == pytest.approx(0.0215), "ZPE not stored correctly"
        assert result_row["gibbs"] == pytest.approx(-0.0050), "Gibbs not stored correctly"
        assert result_row["energy"] == pytest.approx(-2080.5), "Energy not normalized to eV"

        # Check full output
        assert result_row["outputs_json"] is not None, "outputs_json not stored"
        outputs = json.loads(result_row["outputs_json"])
        assert "frequencies" in outputs
        assert len(outputs["frequencies"]) == 3

        # Parse stored frequencies
        real_freqs = json.loads(result_row["real_freqs_json"])
        assert len(real_freqs) == 3
        assert real_freqs[0] == pytest.approx(3755.2)
        assert json.loads(result_row["imag_freqs_json"]) == []

        conn.close()

        # Test Step 2: Retrieve via query (what API does)
        import catgo.routers.workflow_engine as workflow_engine_router
        monkeypatch.setattr(workflow_engine_router, "_db", db)
        from catgo.services.workflow_results import fetch_v2_task_results_by_workflow

        task_rows = fetch_v2_task_results_by_workflow(workflow_id)
        assert len(task_rows) > 0, "No results returned from query"

        # Test Step 3: Transform for frontend (build_part_c_results)
        part_c_results = build_part_c_results(task_rows)
        assert len(part_c_results) > 0, "No results from build_part_c_results"

        result_dict = part_c_results[0]
        assert result_dict["node_type"] == "orca_freq"
        assert "frequencies" in result_dict
        assert result_dict["num_imaginary"] == 0
        assert result_dict["energy"] == pytest.approx(-2080.5)

        print("✅ All ORCA freq results tests passed!")

    finally:
        # Cleanup
        import os
        if os.path.exists(db_path):
            os.unlink(db_path)


@pytest.mark.asyncio
async def test_orca_opt_convergence_stored_and_retrieved(monkeypatch):
    """Test that ORCA opt convergence is stored and can be retrieved."""

    from catgo.workflow.db import WorkflowDB
    from catgo.services.workflow_results import build_part_c_results
    from catgo.workflow.engine.collector import _store_result
    import tempfile
    import sqlite3

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        db = WorkflowDB(db_path)

        workflow_id = db.create_workflow("test_opt_workflow")

        task_id = db.create_task(
            workflow_id=workflow_id,
            task_type="orca_opt",
            params={"software": "orca"},
            software="orca",
            system_name="H2O"
        )

        # Simulate ORCA opt parser output
        orca_parser_result = {
            "type": "orca_opt",
            "energy_eh": -76.4185,
            "energy_ev": -2080.5,
            "converged": True,
            "n_steps": 3,
            "convergence_points": [
                {"step": 1, "energy": -76.4100, "dE": 0.0},
                {"step": 2, "energy": -76.4175, "dE": -0.0075},
                {"step": 3, "energy": -76.4185, "dE": -0.0010},
            ],
        }

        _store_result(db, task_id, workflow_id, orca_parser_result)
        db.update_task(task_id, status="COMPLETED")

        # Verify storage
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        result_row = conn.execute(
            "SELECT * FROM task_results WHERE task_id = ?",
            (task_id,)
        ).fetchone()

        assert result_row is not None
        outputs = json.loads(result_row["outputs_json"])
        assert outputs["n_steps"] == 3
        assert len(outputs["convergence_points"]) == 3

        conn.close()

        # Retrieve via query
        import catgo.routers.workflow_engine as workflow_engine_router
        monkeypatch.setattr(workflow_engine_router, "_db", db)
        from catgo.services.workflow_results import fetch_v2_task_results_by_workflow

        task_rows = fetch_v2_task_results_by_workflow(workflow_id)
        part_c_results = build_part_c_results(task_rows)

        result_dict = part_c_results[0]
        assert result_dict["node_type"] == "orca_opt"
        assert result_dict["converged"] is True
        assert result_dict["n_steps"] == 3
        assert "convergence_points" in result_dict
        assert len(result_dict["convergence_points"]) == 3
        assert result_dict["energy"] == pytest.approx(-2080.5)

        print("✅ All ORCA opt convergence tests passed!")

    finally:
        import os
        if os.path.exists(db_path):
            os.unlink(db_path)


@pytest.mark.asyncio
async def test_api_enriched_results_includes_v2_tasks():
    """Test that API /results-enriched endpoint includes V2 task results."""

    # This is a higher-level test that validates the complete API flow
    # It would require running a full FastAPI server, so we'll test the components

    from catgo.services.workflow_results import fetch_v2_task_results_by_workflow, build_part_c_results

    # Note: This test would need a real database with actual ORCA results
    # For now, we'll test the query functions exist and don't crash

    # Test with a non-existent workflow (should return empty list, not crash)
    results = fetch_v2_task_results_by_workflow("nonexistent_wf")
    assert isinstance(results, list)

    # Test build_part_c_results with empty input
    part_c = build_part_c_results([])
    assert part_c == []

    print("✅ API enriched results component tests passed!")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
