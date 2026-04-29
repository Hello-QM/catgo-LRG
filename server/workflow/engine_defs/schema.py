"""Engine spec schema validation and dataclass."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\b", r"\bsudo\b", r"\bcurl\b", r"\bwget\b",
    r"\bchmod\b.*777", r"\b>\s*/dev/", r"\bdd\b\s+if=",
    r"\bmkfs\b",
]

REQUIRED_FIELDS = {"engine", "label", "supported_calc_types", "params",
                   "input_files", "run_commands", "output_files"}

VALID_SAFETY_VALUES = {"safe", "warn", "dangerous"}


@dataclass
class ParamSpec:
    """A single parameter definition."""
    key: str
    label: str
    type: str = "string"
    default: Any = None
    options: list[dict[str, Any]] | None = None
    unit: str | None = None
    range: list[float] | None = None
    help: str | None = None
    group: str | None = None
    show_if: dict[str, Any] | None = None


@dataclass
class InputFileSpec:
    """How to produce one input file."""
    template: str | None = None
    source: str | None = None  # "structure" | "user" | "upstream"
    format: str | None = None


@dataclass
class EngineSpec:
    """Validated, typed representation of a YAML engine definition."""
    engine: str
    label: str
    description: str = ""
    supported_calc_types: list[str] = field(default_factory=list)
    params: list[ParamSpec] = field(default_factory=list)
    input_files: dict[str, InputFileSpec] = field(default_factory=dict)
    run_commands: list[str] = field(default_factory=list)
    output_files: dict[str, str] = field(default_factory=dict)
    environment: dict[str, Any] = field(default_factory=dict)
    parser: str | None = None
    hooks: dict[str, str | None] = field(default_factory=dict)
    safety: str = "safe"
    calc_type_mapping: dict[str, str] = field(default_factory=dict)


def _assess_safety(run_commands: list[str]) -> str:
    """Auto-classify safety level from run_commands content."""
    if not run_commands:
        return "safe"
    combined = " ".join(run_commands)
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, combined):
            return "dangerous"
    return "warn"


def validate_engine_spec(raw: dict[str, Any]) -> EngineSpec:
    """Validate a raw dict (from YAML or API) and return a typed EngineSpec.

    Raises ValueError for missing required fields.
    """
    missing = REQUIRED_FIELDS - set(raw.keys())
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(sorted(missing))}")

    try:
        params = [
            ParamSpec(**p) if isinstance(p, dict) else p
            for p in raw.get("params", [])
        ]
    except TypeError as exc:
        raise ValueError(f"Invalid param definition: {exc}") from exc
    try:
        input_files = {
            name: InputFileSpec(**spec) if isinstance(spec, dict) else spec
            for name, spec in raw.get("input_files", {}).items()
        }
    except TypeError as exc:
        raise ValueError(f"Invalid input_file definition: {exc}") from exc

    spec = EngineSpec(
        engine=raw["engine"],
        label=raw["label"],
        description=raw.get("description", ""),
        supported_calc_types=raw.get("supported_calc_types", []),
        params=params,
        input_files=input_files,
        run_commands=raw.get("run_commands", []),
        output_files=raw.get("output_files", {}),
        environment=raw.get("environment", {}),
        parser=raw.get("parser"),
        hooks=raw.get("hooks", {}),
        safety=raw.get("safety") or _assess_safety(raw.get("run_commands", [])),
        calc_type_mapping=raw.get("calc_type_mapping", {}),
    )
    if spec.safety not in VALID_SAFETY_VALUES:
        raise ValueError(
            f"Invalid safety value {spec.safety!r}; must be one of "
            f"{sorted(VALID_SAFETY_VALUES)}"
        )
    return spec
