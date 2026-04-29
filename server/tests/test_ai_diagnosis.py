"""Tests for AI-assisted error diagnosis."""

import asyncio
import json

import pytest

from catgo.workflow.db import WorkflowDB
from catgo.workflow.engine.ai_diagnosis import (
    format_diagnosis_prompt,
    get_diagnosis_for_mcp,
    parse_diagnosis_response,
)


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestFormatDiagnosisPrompt:
    """Tests for format_diagnosis_prompt()."""

    def test_format_diagnosis_prompt(self):
        """Prompt includes task metadata and error log."""
        task = {
            "software": "vasp",
            "task_type": "geo_opt",
            "params_json": json.dumps({"ENCUT": 520, "KPOINTS": [3, 3, 1]}),
            "error_message": "ZBRENT: fatal error",
        }
        error_log = "Error line 1\nError line 2"
        prompt = format_diagnosis_prompt(task, error_log)

        assert "vasp" in prompt
        assert "geo_opt" in prompt
        assert "ZBRENT" in prompt
        assert "ENCUT" in prompt
        assert "Error line 1" in prompt

    def test_format_diagnosis_prompt_empty_params(self):
        """Handles missing/empty params_json gracefully."""
        task = {
            "software": "orca",
            "task_type": "single_point",
            "params_json": "",
            "error_message": "SCF not converged",
        }
        prompt = format_diagnosis_prompt(task, "")
        assert "orca" in prompt
        assert "SCF not converged" in prompt

    def test_format_diagnosis_prompt_truncates_long_log(self):
        """Error log is truncated to last 3000 chars."""
        task = {
            "software": "vasp",
            "task_type": "geo_opt",
            "params_json": "{}",
            "error_message": "error",
        }
        long_log = "x" * 5000
        prompt = format_diagnosis_prompt(task, long_log)
        # The log portion should be at most 3000 chars (the [-3000:] slice)
        assert "x" * 3000 in prompt
        assert "x" * 5000 not in prompt


class TestParseDiagnosisResponse:
    """Tests for parse_diagnosis_response()."""

    def test_parse_diagnosis_with_json(self):
        """Extracts JSON fixes and confidence from AI response."""
        response = (
            '1. Root cause: ENCUT too low for accurate forces.\n'
            '2. {"ENCUT": 600, "EDIFF": 1e-6}\n'
            '3. Confidence: high'
        )
        result = parse_diagnosis_response(response)
        assert result is not None
        assert result["fixes"]["ENCUT"] == 600
        assert result["confidence"] == "high"
        assert result["tier"] == 2.5

    def test_parse_diagnosis_medium_confidence(self):
        """Default confidence is medium when neither high nor low."""
        response = '{"ALGO": "All"}\nThis might help.'
        result = parse_diagnosis_response(response)
        assert result is not None
        assert result["confidence"] == "medium"
        assert result["fixes"]["ALGO"] == "All"

    def test_parse_diagnosis_low_confidence(self):
        """Low confidence detected."""
        response = 'The error is unclear. {"SIGMA": 0.05}\nConfidence: low'
        result = parse_diagnosis_response(response)
        assert result is not None
        assert result["confidence"] == "low"

    def test_parse_diagnosis_no_json(self):
        """Returns None when no JSON object found."""
        response = "I cannot determine the error cause from this log."
        result = parse_diagnosis_response(response)
        assert result is None

    def test_parse_diagnosis_invalid_json(self):
        """Returns None for malformed JSON."""
        response = "{this is not valid json} but looks like it"
        result = parse_diagnosis_response(response)
        assert result is None


class TestGetDiagnosisForMcp:
    """Tests for get_diagnosis_for_mcp()."""

    @pytest.fixture
    def db(self, tmp_path):
        return WorkflowDB(str(tmp_path / "test.db"))

    @pytest.fixture
    def failed_task(self, db):
        """Create a failed task in the DB and return its ID."""
        wf_id = db.create_workflow("test-wf")
        task_id = db.create_task(
            workflow_id=wf_id,
            task_type="geo_opt",
            params={"software": "vasp", "ENCUT": 400},
            software="vasp",
        )
        db.update_task(
            task_id,
            status="FAILED",
            error_message="ZBRENT: fatal error in bracketing",
        )
        return task_id

    def test_get_diagnosis_for_mcp(self, db, failed_task):
        """Returns structured diagnosis with rule-based fix."""
        result = _run(get_diagnosis_for_mcp(db, failed_task))

        assert result["task_id"] == failed_task
        assert result["task_type"] == "geo_opt"
        assert result["status"] == "FAILED"
        assert "ZBRENT" in result["error_message"]
        assert result["current_params"] is not None
        # Rule-based diagnosis should find ZBRENT fix
        assert result["rule_based_diagnosis"] is not None
        assert "hint" in result

    def test_get_diagnosis_not_found(self, db):
        """Raises KeyError for unknown task_id."""
        with pytest.raises(KeyError):
            _run(get_diagnosis_for_mcp(db, "nonexistent_task_id"))
