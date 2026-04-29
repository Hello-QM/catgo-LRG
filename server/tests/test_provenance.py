"""Tests for lightweight provenance tracking."""

import json
import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.provenance import (
    _hash_value,
    find_duplicate,
    record_provenance,
    trace_provenance,
)


@pytest.fixture
def db(tmp_path):
    return WorkflowDB(str(tmp_path / "test.db"))


@pytest.fixture
def wf_with_chain(db):
    """Create a 2-task chain: geo_opt -> freq, with results stored."""
    wf_id = db.create_workflow("test-provenance")

    t1 = db.create_task(wf_id, "geo_opt", params={"ENCUT": 520}, software="vasp")
    t2 = db.create_task(wf_id, "freq", params={"NWRITE": 3}, software="vasp")
    db.create_link(wf_id, t1, t2, "structure", "structure")

    # Store results for t1
    db.store_result(t1, wf_id, energy=-5.123, structure_json='{"atoms": ["O", "H"]}')

    # Store results for t2
    db.store_result(t2, wf_id, real_freqs_json="[100.0, 200.0, 300.0]")

    return {"wf_id": wf_id, "t1": t1, "t2": t2}


class TestHashConsistency:
    def test_same_input_same_hash(self):
        """Same value always produces the same hash."""
        v = {"energy": -5.123, "structure": [1, 2, 3]}
        assert _hash_value(v) == _hash_value(v)

    def test_different_input_different_hash(self):
        h1 = _hash_value({"energy": -5.123})
        h2 = _hash_value({"energy": -5.124})
        assert h1 != h2

    def test_key_order_irrelevant(self):
        """sort_keys=True ensures dict key order doesn't affect hash."""
        h1 = _hash_value({"a": 1, "b": 2})
        h2 = _hash_value({"b": 2, "a": 1})
        assert h1 == h2

    def test_hash_length(self):
        assert len(_hash_value("hello")) == 16


class TestRecordAndTrace:
    def test_record_provenance_creates_rows(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        result = {"energy": -5.123, "structure_json": '{"atoms": ["O", "H"]}'}
        record_provenance(db, wf_id, t1, result, task)

        records = db.get_provenance(t1)
        assert len(records) == 2  # energy + structure_json
        keys = {r["output_key"] for r in records}
        assert keys == {"energy", "structure_json"}

    def test_record_provenance_stores_hashes(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        result = {"energy": -5.123}
        record_provenance(db, wf_id, t1, result, task)

        records = db.get_provenance(t1, "energy")
        assert len(records) == 1
        assert records[0]["value_hash"] == _hash_value(-5.123)

    def test_record_provenance_captures_input_hashes(self, db, wf_with_chain):
        """Task t2 (freq) should record input hashes from t1's structure output."""
        t1 = wf_with_chain["t1"]
        t2 = wf_with_chain["t2"]
        wf_id = wf_with_chain["wf_id"]

        # First record provenance for t1
        task1 = db.get_task(t1)
        record_provenance(db, wf_id, t1,
                          {"energy": -5.123, "structure_json": '{"atoms": ["O", "H"]}'},
                          task1)

        # Now record provenance for t2 — it should pick up t1's structure hash
        task2 = db.get_task(t2)
        record_provenance(db, wf_id, t2,
                          {"real_freqs_json": "[100.0, 200.0, 300.0]"},
                          task2)

        records = db.get_provenance(t2)
        assert len(records) == 1
        input_hashes = json.loads(records[0]["input_hashes"])
        assert "structure" in input_hashes

    def test_trace_provenance(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1, {"energy": -5.123}, task)

        result = trace_provenance(db, t1, "energy")
        assert result is not None
        assert result["task_id"] == t1
        assert result["task_type"] == "geo_opt"
        assert result["output_key"] == "energy"
        assert result["output_hash"] == _hash_value(-5.123)
        assert result["software"] == "vasp"

    def test_trace_provenance_with_lineage(self, db, wf_with_chain):
        """Trace t2's output back through t1."""
        t1 = wf_with_chain["t1"]
        t2 = wf_with_chain["t2"]
        wf_id = wf_with_chain["wf_id"]

        # Record t1 provenance
        task1 = db.get_task(t1)
        record_provenance(db, wf_id, t1,
                          {"structure_json": '{"atoms": ["O", "H"]}'},
                          task1)

        # Record t2 provenance
        task2 = db.get_task(t2)
        record_provenance(db, wf_id, t2,
                          {"real_freqs_json": "[100.0, 200.0, 300.0]"},
                          task2)

        result = trace_provenance(db, t2, "real_freqs_json")
        assert result is not None
        assert "structure" in result["inputs"]
        assert result["inputs"]["structure"]["from_task"] == t1

    def test_trace_provenance_nonexistent(self, db, wf_with_chain):
        result = trace_provenance(db, "nonexistent", "energy")
        assert result is None


class TestFindDuplicate:
    def test_finds_existing_duplicate(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1, {"energy": -5.123}, task)

        # Search for duplicate with same params hash
        params_hash = _hash_value({"ENCUT": 520})
        found = find_duplicate(db, "geo_opt", {}, params_hash)
        assert found == t1

    def test_no_duplicate_different_type(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1, {"energy": -5.123}, task)

        params_hash = _hash_value({"ENCUT": 520})
        found = find_duplicate(db, "freq", {}, params_hash)
        assert found is None

    def test_no_duplicate_different_params(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1, {"energy": -5.123}, task)

        # Different ENCUT
        params_hash = _hash_value({"ENCUT": 600})
        found = find_duplicate(db, "geo_opt", {}, params_hash)
        assert found is None


class TestDBProvenance:
    def test_find_provenance_by_hash(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1, {"energy": -5.123}, task)

        energy_hash = _hash_value(-5.123)
        results = db.find_provenance_by_hash(energy_hash)
        assert len(results) == 1
        assert results[0]["task_id"] == t1

    def test_get_provenance_filtered(self, db, wf_with_chain):
        t1 = wf_with_chain["t1"]
        wf_id = wf_with_chain["wf_id"]
        task = db.get_task(t1)

        record_provenance(db, wf_id, t1,
                          {"energy": -5.123, "structure_json": '{"atoms": []}'},
                          task)

        # Filter by output_key
        energy_only = db.get_provenance(t1, "energy")
        assert len(energy_only) == 1
        assert energy_only[0]["output_key"] == "energy"

        # All records
        all_records = db.get_provenance(t1)
        assert len(all_records) == 2
