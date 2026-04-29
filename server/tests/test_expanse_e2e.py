#!/usr/bin/env python3
"""End-to-end test: v2 workflow engine → Expanse HPC.

Usage:
  python -m tests.test_expanse_e2e

This script:
1. Creates a v2 workflow with structure_input → geo_opt
2. Starts the engine scanner
3. Verifies structure_input completes locally
4. Verifies geo_opt advances to READY
5. (Does NOT submit to HPC — that requires a running HPC session pool)

For full HPC submission, use the MCP tool via Claude Code.
"""
import asyncio
import sys
import os
import json
import tempfile

# Add server/ to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from catgo.workflow.db import WorkflowDB
from catgo.workflow.workflow import Workflow
from catgo.workflow.states import TaskState, WorkflowState
from catgo.workflow.engine.scanner import WorkflowEngine


def test_local_workflow():
    """Test a complete local workflow: structure_input → gibbs_energy chain."""
    print("=" * 60)
    print("V2 Engine E2E Test — Local Tasks")
    print("=" * 60)

    # Use temp DB
    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "test_e2e.db")
        db = WorkflowDB(db_path)
        print(f"✓ DB created at {db_path}")

        # Create workflow: structure_input only (simplest local test)
        wf = Workflow("E2E Test — Local", db=db)
        t1 = wf.add_task("structure_input", structure='{"lattice": {"matrix": [[3,0,0],[0,3,0],[0,0,3]]}, "sites": []}')
        print(f"✓ Workflow created: {wf.workflow_id}")
        print(f"  Task 1 (structure_input): {t1.task_id}")

        # Submit workflow
        wf.submit()
        wf_data = db.get_workflow(wf.workflow_id)
        print(f"✓ Workflow submitted, status={wf_data['status']}")
        assert wf_data["status"] == "running"

        # Run engine
        engine = WorkflowEngine(db=db, config={"engine": {"poll_interval": 1}})
        print("\n--- Running scan cycle 1 ---")
        asyncio.run(engine.scan_cycle())

        # Check results
        tasks = db.get_all_tasks(wf.workflow_id)
        for t in tasks:
            print(f"  Task {t['id'][:8]}… ({t['task_type']}): {t['status']}")

        si = [t for t in tasks if t["task_type"] == "structure_input"][0]
        assert si["status"] == TaskState.COMPLETED.value, f"Expected COMPLETED, got {si['status']}"
        print(f"\n✓ structure_input COMPLETED")

        # Check result was stored
        result = db.get_result(si["id"])
        assert result is not None, "No result stored for structure_input"
        print(f"✓ Result stored: structure_json={'yes' if result.get('structure_json') else 'no'}")

        # Check workflow status
        wf_final = db.get_workflow(wf.workflow_id)
        print(f"✓ Workflow final status: {wf_final['status']}")

    print("\n" + "=" * 60)
    print("ALL LOCAL TESTS PASSED")
    print("=" * 60)


def test_chained_workflow():
    """Test chained workflow: structure_input → geo_opt (stops at READY since no HPC)."""
    print("\n" + "=" * 60)
    print("V2 Engine E2E Test — Chained (structure_input → geo_opt)")
    print("=" * 60)

    with tempfile.TemporaryDirectory() as tmp:
        db_path = os.path.join(tmp, "test_chain.db")
        db = WorkflowDB(db_path)

        wf = Workflow("E2E Chain Test", db=db)
        t1 = wf.add_task("structure_input", structure='{"lattice": {"matrix": [[3,0,0],[0,3,0],[0,0,3]]}}')
        t2 = wf.add_task("geo_opt", structure=t1.output.structure, software="vasp")
        wf.submit()
        print(f"✓ Workflow: {wf.workflow_id}")
        print(f"  t1 (structure_input): {t1.task_id}")
        print(f"  t2 (geo_opt):         {t2.task_id}")

        engine = WorkflowEngine(db=db, config={"engine": {"poll_interval": 1}})

        # Cycle 1: advance waiting → execute structure_input
        print("\n--- Scan cycle 1 ---")
        asyncio.run(engine.scan_cycle())
        for t in db.get_all_tasks(wf.workflow_id):
            print(f"  {t['task_type']:20s} → {t['status']}")

        # Cycle 2: advance geo_opt WAITING→READY
        print("--- Scan cycle 2 ---")
        asyncio.run(engine.scan_cycle())
        for t in db.get_all_tasks(wf.workflow_id):
            print(f"  {t['task_type']:20s} → {t['status']}")

        tasks = db.get_all_tasks(wf.workflow_id)
        si = [t for t in tasks if t["task_type"] == "structure_input"][0]
        geo = [t for t in tasks if t["task_type"] == "geo_opt"][0]

        assert si["status"] == TaskState.COMPLETED.value
        assert geo["status"] == TaskState.READY.value
        print(f"\n✓ structure_input: COMPLETED")
        print(f"✓ geo_opt: READY (waiting for HPC submission)")

        # Check DAG
        dag = db.get_dag(wf.workflow_id)
        print(f"✓ DAG: {len(dag['tasks'])} tasks, {len(dag['links'])} links")
        assert len(dag["links"]) == 1
        link = dag["links"][0]
        print(f"  Link: {link['source_key']} → {link['target_key']}")

    print("\n" + "=" * 60)
    print("ALL CHAIN TESTS PASSED")
    print("=" * 60)


def test_graph_converter():
    """Test converting a GUI graph_json to v2 workflow."""
    print("\n" + "=" * 60)
    print("V2 Engine E2E Test — graph_json Converter")
    print("=" * 60)

    from catgo.workflow.graph_converter import convert_graph_json

    with tempfile.TemporaryDirectory() as tmp:
        db = WorkflowDB(os.path.join(tmp, "test_conv.db"))

        graph = json.dumps({
            "nodes": [
                {"id": "n1", "type": "structure_input", "x": 0, "y": 0, "params": {"label": "TiO2 slab"}},
                {"id": "n2", "type": "geo_opt", "x": 300, "y": 0, "params": {"software": "vasp", "ENCUT": 520, "NSW": 200}},
                {"id": "n3", "type": "freq", "x": 600, "y": 0, "params": {"software": "vasp"}},
                {"id": "n4", "type": "gibbs_energy", "x": 900, "y": 0, "params": {"phase": "adsorbed"}},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
                {"id": "e3", "from": "n2", "to": "n4", "fromH": "out-1", "toH": "in-0"},
                {"id": "e4", "from": "n3", "to": "n4", "fromH": "out-1", "toH": "in-1"},
            ],
        })

        wf_id = convert_graph_json(db, "TiO2 Catalysis", graph)
        tasks = db.get_all_tasks(wf_id)
        dag = db.get_dag(wf_id)

        print(f"✓ Converted: {len(tasks)} tasks, {len(dag['links'])} links")
        for t in tasks:
            params = json.loads(t["params_json"] or "{}")
            print(f"  {t['task_type']:20s} software={str(t.get('software') or '-'):5s} params={list(params.keys())}")

        for lnk in dag["links"]:
            src = [t for t in tasks if t["id"] == lnk["source_task_id"]][0]
            tgt = [t for t in tasks if t["id"] == lnk["target_task_id"]][0]
            print(f"  {src['task_type']:15s}.{lnk['source_key']:12s} → {tgt['task_type']:15s}.{lnk['target_key']}")

        assert len(tasks) == 4
        assert len(dag["links"]) == 4

    print("\n" + "=" * 60)
    print("CONVERTER TEST PASSED")
    print("=" * 60)


if __name__ == "__main__":
    test_local_workflow()
    test_chained_workflow()
    test_graph_converter()
    print("\n\n🎉 ALL E2E TESTS PASSED 🎉")
