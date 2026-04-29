"""Tests for engine_defs/schema.py — validate_engine_spec error handling."""
import sys
from pathlib import Path

import pytest

_server_dir = str(Path(__file__).resolve().parent.parent)
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from workflow.engine_defs.schema import validate_engine_spec, VALID_SAFETY_VALUES


def _minimal_raw(**overrides):
    """Return a minimal valid raw engine spec dict, with optional overrides."""
    base = {
        "engine": "test_engine",
        "label": "Test Engine",
        "supported_calc_types": ["geo_opt"],
        "params": [],
        "input_files": {},
        "run_commands": ["test_engine run"],
        "output_files": {},
    }
    base.update(overrides)
    return base


class TestValidateEngineSpecHappyPath:
    def test_minimal_valid_spec_returns_engine_spec(self):
        spec = validate_engine_spec(_minimal_raw())
        assert spec.engine == "test_engine"
        assert spec.label == "Test Engine"

    def test_explicit_valid_safety_values_accepted(self):
        for val in VALID_SAFETY_VALUES:
            spec = validate_engine_spec(_minimal_raw(safety=val))
            assert spec.safety == val

    def test_safety_auto_assessed_when_absent(self):
        raw = _minimal_raw()
        raw.pop("safety", None)
        spec = validate_engine_spec(raw)
        # run_commands contains no dangerous patterns → "warn"
        assert spec.safety == "warn"

    def test_safety_auto_assessed_to_safe_when_no_commands(self):
        raw = _minimal_raw(run_commands=[])
        raw.pop("safety", None)
        spec = validate_engine_spec(raw)
        assert spec.safety == "safe"


class TestMissingRequiredFields:
    def test_missing_engine_raises_value_error(self):
        raw = _minimal_raw()
        del raw["engine"]
        with pytest.raises(ValueError, match="Missing required fields"):
            validate_engine_spec(raw)

    def test_missing_multiple_fields_listed_in_message(self):
        raw = _minimal_raw()
        del raw["label"]
        del raw["params"]
        with pytest.raises(ValueError, match="Missing required fields"):
            validate_engine_spec(raw)


class TestTypeErrorConvertedToValueError:
    """TypeError from bad keyword args must surface as ValueError (Issue 1)."""

    def test_typo_in_param_key_raises_value_error(self):
        raw = _minimal_raw(
            params=[{"key": "cutoff", "label": "Cutoff", "defalut": 500}]
        )
        with pytest.raises(ValueError, match="Invalid param definition"):
            validate_engine_spec(raw)

    def test_typo_is_not_type_error(self):
        raw = _minimal_raw(
            params=[{"key": "cutoff", "label": "Cutoff", "defalut": 500}]
        )
        with pytest.raises(ValueError):
            validate_engine_spec(raw)
        # Confirm TypeError does not escape
        try:
            validate_engine_spec(raw)
        except TypeError:
            pytest.fail("TypeError escaped; should have been converted to ValueError")
        except ValueError:
            pass  # expected

    def test_typo_in_input_file_spec_raises_value_error(self):
        raw = _minimal_raw(
            input_files={"INCAR": {"templte": "incar.j2"}}  # typo: 'templte'
        )
        with pytest.raises(ValueError, match="Invalid input_file definition"):
            validate_engine_spec(raw)

    def test_valid_param_passes_through(self):
        raw = _minimal_raw(
            params=[{"key": "cutoff", "label": "Cutoff", "default": 500}]
        )
        spec = validate_engine_spec(raw)
        assert spec.params[0].key == "cutoff"
        assert spec.params[0].default == 500

    def test_valid_input_file_passes_through(self):
        raw = _minimal_raw(
            input_files={"INCAR": {"template": "incar.j2", "source": "user"}}
        )
        spec = validate_engine_spec(raw)
        assert spec.input_files["INCAR"].template == "incar.j2"


class TestInvalidSafetyValue:
    """Invalid safety strings must be rejected (Issue 2)."""

    def test_typo_safety_value_raises_value_error(self):
        raw = _minimal_raw(safety="saf")
        with pytest.raises(ValueError, match="Invalid safety value"):
            validate_engine_spec(raw)

    def test_error_message_names_the_bad_value(self):
        raw = _minimal_raw(safety="saf")
        with pytest.raises(ValueError, match="'saf'"):
            validate_engine_spec(raw)

    def test_error_message_lists_valid_options(self):
        raw = _minimal_raw(safety="saf")
        with pytest.raises(ValueError, match="dangerous"):
            validate_engine_spec(raw)

    def test_empty_string_safety_falls_back_to_auto_assess(self):
        # safety="" is falsy → falls back to _assess_safety → "warn" (has commands)
        raw = _minimal_raw(safety="")
        spec = validate_engine_spec(raw)
        assert spec.safety == "warn"

    def test_none_safety_falls_back_to_auto_assess(self):
        raw = _minimal_raw()
        raw["safety"] = None
        spec = validate_engine_spec(raw)
        assert spec.safety == "warn"
